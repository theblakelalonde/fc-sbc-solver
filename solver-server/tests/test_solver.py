"""Solver correctness: every solution is re-checked with rules.py; small cases are brute-forced."""
import itertools
import random
from dataclasses import replace

import pytest

from sbc_solver import CostOptions, SolveOptions, solve
from sbc_solver import rules
from sbc_solver.costs import player_cost
from sbc_solver.data import (
    ALL_PLAYERS_CHEMISTRY_POINTS, CHEMISTRY_POINTS, CLUB_COUNT, EXACT, GREATER, LEAGUE_ID, LOWER,
    NATION_COUNT, PLAYER_MIN_OVR, PLAYER_QUALITY, SAME_NATION_COUNT, TEAM_RATING, Challenge,
    Player, Requirement, Slot,
)

F442 = [
    (0, 0, "GK"), (3, 3, "RB"), (4, 5, "RCB"), (6, 5, "LCB"), (7, 7, "LB"), (12, 12, "RM"),
    (13, 14, "RCM"), (15, 14, "LCM"), (16, 16, "LM"), (24, 25, "RS"), (26, 25, "LS"),
]


def f442_slots(brick_indices=()):
    return [
        Slot(index=i, position_id=pid, general_position=gen, name=name,
             player_type="BRICK" if i in brick_indices else "DEFAULT")
        for i, (pid, gen, name) in enumerate(F442)
    ]


def challenge(*reqs, bricks=()):
    return Challenge(id=1, name="test", formation="f442", operation="AND",
                     requirements=list(reqs), slots=f442_slots(bricks))


def req(key, scope, values, count=-1):
    return Requirement(key=key, scope=scope, count=count, values=tuple(values))


def assert_valid(result, ch, links):
    assert result["status"] in ("optimal", "feasible"), result
    assert result["solutions"]
    for sol in result["solutions"]:
        assert sol["validationErrors"] == [], sol["validationErrors"]
        assert len(sol["slots"]) == len([s for s in ch.slots if s.open])


# ---------- real fixtures ----------


def test_brick_fixture_solves_optimally(brick_challenge, players, links):
    result = solve(brick_challenge, players, links, opts=SolveOptions(max_solutions=3))
    assert result["status"] == "optimal"
    assert_valid(result, brick_challenge, links)
    first = result["solutions"][0]
    assert all(s["slotIndex"] != 0 for s in first["slots"])  # BRICK GK slot stays empty
    costs = [s["totalCost"] for s in result["solutions"]]
    assert costs == sorted(costs)
    ids = [frozenset(s["playerId"] for s in sol["slots"]) for sol in result["solutions"]]
    assert len(set(ids)) == len(ids)


def test_defaults_exclude_loans_and_specials(players, links):
    result = solve(challenge(req(TEAM_RATING, GREATER, [80])), players, links)
    used = {s["playerId"] for sol in result["solutions"] for s in sol["slots"]}
    by_id = {p.id: p for p in players}
    assert not any(by_id[i].loans >= 0 or by_id[i].special for i in used)


@pytest.mark.parametrize(
    "reqs",
    [
        [req(TEAM_RATING, GREATER, [84])],
        [req(TEAM_RATING, GREATER, [83]), req(CHEMISTRY_POINTS, GREATER, [20])],
        [req(CHEMISTRY_POINTS, GREATER, [25]), req(ALL_PLAYERS_CHEMISTRY_POINTS, GREATER, [1])],
        [req(LEAGUE_ID, GREATER, [13], count=4), req(SAME_NATION_COUNT, LOWER, [2]),
         req(TEAM_RATING, GREATER, [82])],
        [req(NATION_COUNT, GREATER, [7]), req(CLUB_COUNT, LOWER, [8]), req(PLAYER_QUALITY, GREATER, [3])],
        [req(PLAYER_MIN_OVR, GREATER, [84], count=3), req(TEAM_RATING, EXACT, [82])],
    ],
    ids=["rating84", "rating83+chem20", "chem25+each1", "PLx4+maxsame2+r82", "nations+clubs+gold", "3x84+exact82"],
)
def test_requirement_mixes_on_real_club(reqs, players, links):
    ch = challenge(*reqs)
    result = solve(ch, players, links, opts=SolveOptions(max_solutions=1, time_limit_s=10))
    assert_valid(result, ch, links)


def test_infeasible_is_reported(players, links):
    result = solve(challenge(req(TEAM_RATING, GREATER, [95])), players, links)
    assert result["status"] == "infeasible"
    assert result["solutions"] == []


def test_unsupported_requirement_is_reported(players, links):
    ch = challenge(req(21, GREATER, [1], count=2))  # PLAYER_COUNT_COMBINED
    result = solve(ch, players, links)
    assert result["status"] == "unsupported"
    assert result["unsupported"]


# ---------- brute force on small synthetic pools ----------


def _synthetic_pool(rng, n):
    pool = []
    for i in range(n):
        rating = rng.randint(70, 90)
        pool.append(Player(
            id=i + 1, definition_id=1000 + i, base_id=1000 + i, name=f"P{i}", rating=rating, rareflag=0,
            tier=3 if rating >= 75 else 2, team_id=rng.randint(1, 4), league_id=rng.randint(1, 3),
            nation_id=rng.randint(1, 4), positions=(rng.choice([0, 3, 5, 7, 12, 14, 16, 25]),),
            tradable=True, loans=-1, limited_use=False, owners=1, groups=(), special=False,
            legend=False, hero=False, market_price=rng.randint(200, 20000),
        ))
    return pool


@pytest.mark.parametrize("seed", range(8))
def test_team_rating_constraint_matches_brute_force(seed):
    rng = random.Random(seed)
    pool = _synthetic_pool(rng, 14)
    target = rng.randint(78, 84)
    ch = challenge(req(TEAM_RATING, GREATER, [target]))
    opts = CostOptions(max_cost=10**9)
    cost = {p.id: player_cost(p, opts) for p in pool}

    best = None
    for combo in itertools.combinations(pool, 11):
        if rules.team_rating([p.rating for p in combo]) >= target:
            c = sum(cost[p.id] for p in combo)
            best = c if best is None else min(best, c)

    result = solve(ch, pool, {}, opts, SolveOptions(max_solutions=1, relative_gap=0))
    if best is None:
        assert result["status"] == "infeasible"
    else:
        assert result["status"] == "optimal"
        assert result["solutions"][0]["totalCost"] == best


@pytest.mark.parametrize("seed", range(5))
def test_brick_rating_counts_empty_slots_as_zero(seed):
    rng = random.Random(100 + seed)
    pool = _synthetic_pool(rng, 12)
    target = rng.randint(74, 80)
    ch = challenge(req(TEAM_RATING, GREATER, [target]), bricks=(0,))
    opts = CostOptions(max_cost=10**9)
    cost = {p.id: player_cost(p, opts) for p in pool}
    best = min(
        (sum(cost[p.id] for p in combo) for combo in itertools.combinations(pool, 10)
         if rules.team_rating([p.rating for p in combo]) >= target),
        default=None,
    )
    result = solve(ch, pool, {}, opts, SolveOptions(max_solutions=1, relative_gap=0))
    if best is None:
        assert result["status"] == "infeasible"
    else:
        assert result["solutions"][0]["totalCost"] == best


def test_same_player_twice_is_blocked(players, links):
    # Duplicate every player as a second card with the same base id; the squad may use only one.
    dupes = [replace(p, id=p.id + 10**13) for p in players]
    ch = challenge(req(TEAM_RATING, GREATER, [80]))
    result = solve(ch, players + dupes, links)
    assert_valid(result, ch, links)


@pytest.mark.parametrize("target", [82, 84])
def test_pruning_never_changes_the_optimum(target, players, links, monkeypatch):
    from sbc_solver import solver as solver_mod

    # Clone the club 3x (new ids and base ids) so signature groups exceed the keep limit.
    clones = [replace(p, id=p.id + k * 10**13, base_id=p.base_id + k * 10**7)
              for k in (1, 2) for p in players]
    pool = players + clones
    ch = challenge(req(TEAM_RATING, GREATER, [target]))
    exact = SolveOptions(max_solutions=1, relative_gap=0, time_limit_s=60)
    pruned = solve(ch, pool, links, opts=exact)
    assert pruned["stats"]["prunedDominated"] > 0
    monkeypatch.setattr(solver_mod, "_prune_dominated", lambda pool, *a, **kw: pool)
    full = solve(ch, pool, links, opts=exact)
    assert pruned["status"] == full["status"] == "optimal"
    assert pruned["solutions"][0]["totalCost"] == full["solutions"][0]["totalCost"]


# Real SBCs captured from the FC 27 Web App (Dump all SBCs, 2026-09-23). Infeasible ones are
# genuinely impossible with this club: 10 bronze / 5 silver players, no Scottish players,
# only one Portuguese player.
REAL_SBC_EXPECTED = {
    16: "infeasible",  # Bronze Upgrade: 11 bronze
    42: "infeasible",  # Silver Upgrade: 11 silver
    18: "solved",  # Gold Upgrade
    25: "solved",  # 3 Leagues & 2 Nations, chem 30
    26: "solved",  # 4 Leagues & 5 Nations, rating 78, chem 25
    27: "solved",  # 5 Leagues & 6 Nations, rating 81, chem 25
    28: "solved",  # 2x 79+ Upgrade (brick)
    35: "infeasible",  # Celtic v Rangers: Scotland min 1
    37: "infeasible",  # FC Porto v SL Benfica: Portugal min 2
    38: "solved",  # PSG v OM
    39: "solved",  # Atletico v Real Madrid
}


@pytest.mark.parametrize("challenge_id", sorted(REAL_SBC_EXPECTED))
def test_real_sbcs(challenge_id, players, links):
    from conftest import FIXTURES
    from sbc_solver.data import load_challenges

    ch = next(c for c in load_challenges(FIXTURES / "sbc-all-11.json") if c.id == challenge_id)
    result = solve(ch, players, links, opts=SolveOptions(max_solutions=1, time_limit_s=10))
    if REAL_SBC_EXPECTED[challenge_id] == "infeasible":
        assert result["status"] == "infeasible"
    else:
        assert_valid(result, ch, links)


# ---------- whole SBC sets ----------


def _real_challenges(ids):
    from conftest import FIXTURES
    from sbc_solver.data import load_challenges

    by_id = {c.id: c for c in load_challenges(FIXTURES / "sbc-all-11.json")}
    return [by_id[i] for i in ids]


def test_solve_set_uses_each_player_once(players, links):
    from sbc_solver import solve_set

    challenges = _real_challenges([25, 26, 27])  # "Leagues & Nations" set: 3 challenges
    result = solve_set(challenges, players, links, opts=SolveOptions(time_limit_s=30))
    assert result["status"] in ("optimal", "feasible"), result
    used = []
    for entry, ch in zip(result["challenges"], challenges):
        assert entry["status"] == "solved"
        sol = entry["solution"]
        assert sol["validationErrors"] == [], (entry["name"], sol["validationErrors"])
        assert len(sol["slots"]) == len([s for s in ch.slots if s.open])
        used += [s["playerId"] for s in sol["slots"]]
    assert len(used) == len(set(used)), "a player was used in two challenges"
    assert result["totalCost"] == sum(e["solution"]["totalCost"] for e in result["challenges"])


def test_solve_set_fills_what_is_possible(players, links):
    from sbc_solver import solve_set

    result = solve_set(_real_challenges([35, 37, 38, 39]), players, links, opts=SolveOptions(time_limit_s=20))
    assert result["status"] == "partial"
    statuses = {e["challengeId"]: e["status"] for e in result["challenges"]}
    assert statuses[35] == statuses[37] == "infeasible"  # no Scottish / one Portuguese player
    assert statuses[38] == statuses[39] == "solved"
    used = [s["playerId"] for e in result["challenges"] if e["status"] == "solved" for s in e["solution"]["slots"]]
    assert len(used) == len(set(used))
    for e in result["challenges"]:
        if e["status"] == "solved":
            assert e["solution"]["validationErrors"] == []


# ---------- custom bricks (e.g. "Madrid Dreams": a locked LaLiga / Real Madrid placeholder) ----------


def _madrid_dreams(players, with_brick=True):
    from sbc_solver.data import CLUB_COUNT, SAME_CLUB_COUNT, SAME_LEAGUE_COUNT

    real_madrid = next(p for p in players if p.team_id == 243)
    brick = replace(real_madrid, id=0, definition_id=0, base_id=0, name="brick", rating=0, positions=(23,))
    slots = f442_slots()
    if with_brick:
        slots[8] = replace(slots[8], player_type="CUSTOM_BRICK", brick=brick)  # LM slot holds the brick
    reqs = [
        req(SAME_LEAGUE_COUNT, LOWER, [4]),
        req(SAME_CLUB_COUNT, GREATER, [3]),
        req(CLUB_COUNT, LOWER, [4]),
        req(NATION_COUNT, GREATER, [2]),
        req(PLAYER_QUALITY, GREATER, [3]),
        req(CHEMISTRY_POINTS, GREATER, [12]),
    ]
    return Challenge(id=99, name="Madrid Dreams", formation="f442", operation="AND", requirements=reqs, slots=slots), brick


def test_custom_brick_slot_is_solved_around(players, links):
    ch, brick = _madrid_dreams(players)
    result = solve(ch, players, links, opts=SolveOptions(max_solutions=1, time_limit_s=10))
    assert result["status"] in ("optimal", "feasible"), result
    sol = result["solutions"][0]
    assert sol["validationErrors"] == []
    assert len(sol["slots"]) == 10 and all(s["slotIndex"] != 8 for s in sol["slots"])
    # "Clubs in squad: max 4" counts the brick's club too
    clubs = {rules.canonical_club(p.team_id, links) for p in players if p.id in {s["playerId"] for s in sol["slots"]}}
    clubs.add(rules.canonical_club(brick.team_id, links))
    assert len(clubs) <= 4


def test_custom_brick_adds_chemistry_links(players, links):
    ch, brick = _madrid_dreams(players)
    madrid = [p for p in players if rules.canonical_club(p.team_id, links) == rules.canonical_club(243, links)]
    assert madrid, "fixture has a Real Madrid-linked player"
    p = madrid[0]
    slot = next(s for s in ch.slots if s.open and s.general_position in p.positions) if any(
        s.open and s.general_position in p.positions for s in ch.slots) else next(s for s in ch.slots if s.open)
    alone = rules.chemistry({slot.index: p}, [s if s.brick is None else replace(s, brick=None) for s in ch.slots], links)
    with_brick = rules.chemistry({slot.index: p}, ch.slots, links)
    assert with_brick.total >= alone.total
    brick_slot = next(s.index for s in ch.slots if s.brick is not None)
    assert with_brick.per_slot[brick_slot] >= 1  # the brick earns chem from its club link with p
    if rules.in_position(p, slot):
        assert with_brick.per_slot[slot.index] >= 1  # club link of 2 (player + brick) = 1 point


# ---------- auto-complete options ----------


def _gold_squad():
    return challenge(req(PLAYER_QUALITY, GREATER, [3]))


def test_option_no_tradeable(players, links):
    result = solve(_gold_squad(), players, links, CostOptions(allow_tradeable=False), SolveOptions(max_solutions=1))
    assert result["status"] in ("optimal", "feasible")
    assert not any(s["tradable"] for s in result["solutions"][0]["slots"])


def test_option_rating_range(players, links):
    result = solve(_gold_squad(), players, links, CostOptions(rating_min=80, rating_max=82), SolveOptions(max_solutions=1))
    assert all(80 <= s["rating"] <= 82 for s in result["solutions"][0]["slots"])


def test_option_solve_using_rating(players, links):
    ch = challenge(req(TEAM_RATING, GREATER, [80]))
    by_price = solve(ch, players, links, opts=SolveOptions(max_solutions=1))["solutions"][0]
    by_rating = solve(ch, players, links, opts=SolveOptions(max_solutions=1, objective="rating", relative_gap=0))["solutions"][0]
    total = lambda sol: sum(s["rating"] for s in sol["slots"])  # noqa: E731
    assert total(by_rating) <= total(by_price)
    assert by_rating["validationErrors"] == []


def test_option_keep_squad_players(players, links):
    ch = _gold_squad()
    gold = sorted((p for p in players if p.tier == 3 and not p.special and p.loans < 0), key=lambda p: -p.rating)
    keep = {1: gold[0].id, 2: gold[1].id}  # an expensive pick the solver wouldn't choose itself
    result = solve(ch, players, links, CostOptions(keep=keep), SolveOptions(max_solutions=1))
    placed = {s["slotIndex"]: s["playerId"] for s in result["solutions"][0]["slots"]}
    assert placed[1] == keep[1] and placed[2] == keep[2]
    assert result["solutions"][0]["validationErrors"] == []


def test_option_unassigned_and_transfer_piles(players, links):
    extra = [replace(p, id=p.id + 7 * 10**12, base_id=p.base_id + 7 * 10**6, in_unassigned=True, market_price=1)
             for p in players if p.tier == 3 and not p.special][:11]
    ch = _gold_squad()
    used = solve(ch, players + extra, links, CostOptions(), SolveOptions(max_solutions=1))["solutions"][0]
    assert {s["playerId"] for s in used["slots"]} & {p.id for p in extra}  # cheap duplicates get used
    off = solve(ch, players + extra, links, CostOptions(use_unassigned=False), SolveOptions(max_solutions=1))["solutions"][0]
    assert not {s["playerId"] for s in off["slots"]} & {p.id for p in extra}


def test_option_exclude_active_squad(players, links):
    ch = _gold_squad()
    first = solve(ch, players, links, CostOptions(), SolveOptions(max_solutions=1))["solutions"][0]
    used = {s["playerId"] for s in first["slots"]}
    marked = [replace(p, in_active_squad=True) if p.id in used else p for p in players]
    again = solve(ch, marked, links, CostOptions(), SolveOptions(max_solutions=1))
    assert not {s["playerId"] for sol in again["solutions"] for s in sol["slots"]} & used
    allowed = solve(ch, marked, links, CostOptions(exclude_active_squad=False), SolveOptions(max_solutions=1))["solutions"][0]
    assert allowed["totalCost"] == first["totalCost"]
