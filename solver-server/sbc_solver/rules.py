"""Game rules in plain Python: team rating, chemistry, requirement checks.

The CP-SAT model in solver.py encodes the same rules; tests use these functions as an
independent check of every solution the model returns.
"""
from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass

from .data import (
    ALL_PLAYERS_CHEMISTRY_POINTS, CHEMISTRY_POINTS, CLUB_COUNT, CLUB_ID, EXACT,
    FIRST_OWNER_PLAYERS_COUNT, GREATER, LEAGUE_COUNT, LEAGUE_ID, LEGEND_COUNT, LOWER, NATION_COUNT,
    NATION_ID, PLAYER_COUNT, PLAYER_EXACT_OVR, PLAYER_MAX_OVR, PLAYER_MIN_OVR, PLAYER_QUALITY,
    PLAYER_LEVEL, PLAYER_RARITY, PLAYER_RARITY_GROUP, SAME_CLUB_COUNT, SAME_LEAGUE_COUNT, SAME_NATION_COUNT,
    TEAM_RATING, Challenge, Player, Requirement, Slot,
)

SQUAD_SIZE = 11

# Chemistry thresholds (CONFIRMED from app's chemistryVO.contributionThresholds).
NATION_THRESHOLDS = (2, 5, 8)
LEAGUE_THRESHOLDS = (3, 5, 8)
CLUB_THRESHOLDS = (2, 4, 7)
MAX_PLAYER_CHEM = 3

# HYPOTHESIS: players out of position get 0 chem and don't count toward link thresholds.
OUT_OF_POSITION_CONTRIBUTES = False

# Requirement keys the solver understands. Anything else makes the solve "unsupported".
PER_PLAYER_KEYS = {
    NATION_ID, LEAGUE_ID, CLUB_ID, PLAYER_RARITY, PLAYER_RARITY_GROUP, PLAYER_QUALITY,
    PLAYER_LEVEL, PLAYER_MIN_OVR, PLAYER_EXACT_OVR, PLAYER_MAX_OVR,
}
SQUAD_KEYS = {
    TEAM_RATING, CHEMISTRY_POINTS, ALL_PLAYERS_CHEMISTRY_POINTS, SAME_NATION_COUNT,
    SAME_LEAGUE_COUNT, SAME_CLUB_COUNT, NATION_COUNT, LEAGUE_COUNT, CLUB_COUNT,
    FIRST_OWNER_PLAYERS_COUNT, LEGEND_COUNT, PLAYER_COUNT,
}
SUPPORTED_KEYS = PER_PLAYER_KEYS | SQUAD_KEYS


def team_rating_raw(ratings: list[int]) -> float:
    """(S + E) / 11 as a float, for display. Empty slots count as rating 0; n is always 11."""
    return rating_scaled(ratings) / SQUAD_SIZE**2


def rating_scaled(ratings: list[int]) -> int:
    """11 * (S + E) as an exact integer: 11*S + sum(max(0, 11*r - S))."""
    total = sum(ratings)
    return SQUAD_SIZE * total + sum(max(0, SQUAD_SIZE * r - total) for r in ratings)


def team_rating(ratings: list[int]) -> int:
    """The app's float mode (UTSquadEntity._calculateRating, CONFIRMED from its source):
    avg = S/11; total = S + sum(r - avg for r > avg); rating = floor(Math.round(total) / 11).

    The Math.round step makes raw ratings from X.9545 up display as X+1.
    """
    scaled = rating_scaled(ratings)  # 11 * total
    rounded_total = (2 * scaled + SQUAD_SIZE) // (2 * SQUAD_SIZE)  # Math.round(total), .5 rounds up
    return min(99, rounded_total // SQUAD_SIZE)


def team_rating_bounds(target: int) -> tuple[int, int]:
    """Range of rating_scaled() values that display exactly `target`:
    round(total) in [11*target, 11*target + 10]  <=>  11*total in [121*target - 5, 121*target + 115]."""
    n = SQUAD_SIZE
    return n * n * target - 5, n * n * target + n * n - 6


def threshold_points(count: int, thresholds: tuple[int, int, int]) -> int:
    return sum(count >= t for t in thresholds)


def canonical_club(team_id: int, links: dict[int, int]) -> int:
    return links.get(team_id, team_id)


def in_position(player: Player, slot: Slot) -> bool:
    return slot.general_position in player.positions


@dataclass
class ChemResult:
    per_slot: dict[int, int]  # slot index -> chem
    total: int


def bricks(slots: list[Slot]) -> list[Player]:
    """Custom-brick placeholders: not players, but they add league/club/nation links."""
    return [s.brick for s in slots if s.brick is not None]


def chemistry(assignment: dict[int, Player], slots: list[Slot], links: dict[int, int]) -> ChemResult:
    """assignment: slot index -> player (open slots only; brick slots stay empty).

    Custom bricks add to the link counts and earn chem themselves from the others' links
    (CONFIRMED live: Madrid Dreams showed 17 where players alone gave 16)."""
    slot_by_index = {s.index: s for s in slots}
    contributing = [
        p for i, p in assignment.items() if OUT_OF_POSITION_CONTRIBUTES or in_position(p, slot_by_index[i])
    ] + bricks(slots)
    nations = Counter(p.nation_id for p in contributing)
    leagues = Counter(p.league_id for p in contributing)
    clubs = Counter(canonical_club(p.team_id, links) for p in contributing)
    per_slot = {}
    for i, p in assignment.items():
        if not in_position(p, slot_by_index[i]):
            per_slot[i] = 0
            continue
        pts = (
            threshold_points(nations[p.nation_id], NATION_THRESHOLDS)
            + threshold_points(leagues[p.league_id], LEAGUE_THRESHOLDS)
            + threshold_points(clubs[canonical_club(p.team_id, links)], CLUB_THRESHOLDS)
        )
        per_slot[i] = min(MAX_PLAYER_CHEM, pts)
    for s in slots:
        b = s.brick
        if b is None:
            continue
        per_slot[s.index] = min(MAX_PLAYER_CHEM, (
            threshold_points(nations[b.nation_id], NATION_THRESHOLDS)
            + threshold_points(leagues[b.league_id], LEAGUE_THRESHOLDS)
            + threshold_points(clubs[canonical_club(b.team_id, links)], CLUB_THRESHOLDS)
        ))
    return ChemResult(per_slot, sum(per_slot.values()))


# ---------- requirements ----------


def compare(value: int, scope: int, target: int) -> bool:
    if scope == GREATER:
        return value >= target
    if scope == LOWER:
        return value <= target
    return value == target


def player_matches(req: Requirement, p: Player, links: dict[int, int]) -> bool:
    """Per-player test for a filter requirement.

    With count >= 0 the test is fixed by the key and `scope` applies to the number of matching
    players ("Liga Portugal: Min. 2 Players", "PSG OR OM: Min. 1 Player", "Gold: Min. 1 Players").
    With count == -1 every player must pass, and for PLAYER_QUALITY the scope compares the tier
    ("Player Quality: Min. Silver"). CONFIRMED against on-screen text (fixtures/sbc-all-11.json)
    for NATION_ID, LEAGUE_ID, CLUB_ID, PLAYER_LEVEL, PLAYER_QUALITY; other keys still HYPOTHESIS.
    """
    v = req.values
    k = req.key
    if k == NATION_ID:
        return p.nation_id in v
    if k == LEAGUE_ID:
        return p.league_id in v
    if k == CLUB_ID:
        linked = {canonical_club(t, links) for t in v}
        return canonical_club(p.team_id, links) in linked
    if k == PLAYER_RARITY:
        return p.rareflag in v
    if k == PLAYER_RARITY_GROUP:
        return any(g in p.groups for g in v)
    if k == PLAYER_LEVEL:
        return p.tier == v[0]
    if k == PLAYER_QUALITY:
        return compare(p.tier, req.scope, v[0]) if req.count < 0 else p.tier == v[0]
    if k == PLAYER_MIN_OVR:
        return p.rating >= v[0]
    if k == PLAYER_EXACT_OVR:
        return p.rating == v[0]
    if k == PLAYER_MAX_OVR:
        return p.rating <= v[0]
    raise ValueError(f"not a per-player key: {req.key_name}")


def unsupported(challenge: Challenge) -> list[str]:
    out = [r.describe() for r in challenge.requirements if r.key not in SUPPORTED_KEYS]
    if challenge.operation != "AND" and len(challenge.requirements) > 1:
        out.append(f"eligibilityOperation {challenge.operation}")
    out += [
        f"slot {s.index} type {s.player_type}"
        for s in challenge.slots
        if s.player_type not in ("DEFAULT", "BRICK") and not (s.player_type == "CUSTOM_BRICK" and s.brick)
    ]
    if challenge.layout_unknown:
        out.append("brick layout unknown: open this challenge once so its bricks are learned")
    chem_keys = {CHEMISTRY_POINTS, ALL_PLAYERS_CHEMISTRY_POINTS}
    if any(s.general_position < 0 for s in challenge.slots) and any(r.key in chem_keys for r in challenge.requirements):
        out.append("formation positions unknown (open this SBC's squad screen, then dump again)")
    return out


def compare_with_bricks(only_players: int, with_bricks: int, scope: int, target: int) -> bool:
    """Whether custom bricks count toward a requirement is unconfirmed, so take the safe side:
    a minimum must hold from players alone, a maximum must hold with the bricks included."""
    if scope == GREATER:
        return only_players >= target
    if scope == LOWER:
        return with_bricks <= target
    return only_players >= target and with_bricks <= target


def check_requirement(req: Requirement, assignment: dict[int, Player], slots: list[Slot], links: dict[int, int]) -> bool:
    players = list(assignment.values())
    extra = bricks(slots)
    k, t = req.key, (req.values[0] if req.values else 0)
    if k in PER_PLAYER_KEYS:
        if req.count < 0:
            return all(player_matches(req, p, links) for p in players)
        n = sum(player_matches(req, p, links) for p in players)
        return compare_with_bricks(n, n + sum(player_matches(req, b, links) for b in extra), req.scope, req.count)
    if k == TEAM_RATING:
        return compare(team_rating([p.rating for p in players]), req.scope, t)
    if k == CHEMISTRY_POINTS:
        return compare(chemistry(assignment, slots, links).total, req.scope, t)
    if k == ALL_PLAYERS_CHEMISTRY_POINTS:
        return all(compare(c, req.scope, t) for c in chemistry(assignment, slots, links).per_slot.values())
    group_of = {
        SAME_NATION_COUNT: lambda p: p.nation_id, NATION_COUNT: lambda p: p.nation_id,
        SAME_LEAGUE_COUNT: lambda p: p.league_id, LEAGUE_COUNT: lambda p: p.league_id,
        SAME_CLUB_COUNT: lambda p: canonical_club(p.team_id, links),
        CLUB_COUNT: lambda p: canonical_club(p.team_id, links),
    }
    if k in (SAME_NATION_COUNT, SAME_LEAGUE_COUNT, SAME_CLUB_COUNT):
        # "Players from the same League: Max 6" / "...same Countries/Regions: Min. 4": largest group
        # compared with t (CONFIRMED text for max and min).
        largest = max(Counter(group_of[k](p) for p in players).values(), default=0)
        largest_all = max(Counter(group_of[k](p) for p in players + extra).values(), default=0)
        return compare_with_bricks(largest, largest_all, req.scope, t)
    if k in (NATION_COUNT, LEAGUE_COUNT, CLUB_COUNT):
        return compare_with_bricks(
            len({group_of[k](p) for p in players}), len({group_of[k](p) for p in players + extra}), req.scope, t
        )
    if k == FIRST_OWNER_PLAYERS_COUNT:
        return compare(sum(p.owners == 1 for p in players), req.scope, t)
    if k == LEGEND_COUNT:
        return compare(sum(p.legend for p in players), req.scope, t)
    if k == PLAYER_COUNT:
        return compare(len(players), req.scope, t)
    raise ValueError(f"unsupported requirement {req.describe()}")


def check_challenge(challenge: Challenge, assignment: dict[int, Player], links: dict[int, int]) -> list[str]:
    """Returns the requirements the squad fails (empty list = valid)."""
    failures = []
    open_slots = {s.index for s in challenge.slots if s.open}
    if set(assignment) != open_slots:
        failures.append(f"slots filled {sorted(assignment)} != open slots {sorted(open_slots)}")
    if len({p.id for p in assignment.values()}) != len(assignment):
        failures.append("same item used twice")
    if len({p.base_id for p in assignment.values()}) != len(assignment):
        failures.append("same player used twice")
    for r in challenge.requirements:
        if not check_requirement(r, assignment, challenge.slots, links):
            failures.append(r.describe())
    return failures
