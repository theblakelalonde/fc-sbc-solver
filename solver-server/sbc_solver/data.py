"""Normalized solver inputs, parsed from the extension's club/SBC dump JSON.

Field meanings are documented in docs/webapp-internals.md (confirmed on FC 27, 2026-09-23).
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field, replace
from pathlib import Path

# SBCEligibilityKey (CONFIRMED enum values)
TEAM_STAR_RATING = 0
PLAYER_COUNT = 2
PLAYER_QUALITY = 3
SAME_NATION_COUNT = 4
SAME_LEAGUE_COUNT = 5
SAME_CLUB_COUNT = 6
NATION_COUNT = 7
LEAGUE_COUNT = 8
CLUB_COUNT = 9
NATION_ID = 10
LEAGUE_ID = 11
CLUB_ID = 12
SCOPE = 13
LEGEND_COUNT = 15
NUM_TROPHY_REQUIRED = 16
PLAYER_LEVEL = 17
PLAYER_RARITY = 18
TEAM_RATING = 19
PLAYER_COUNT_COMBINED = 21
PLAYER_RARITY_GROUP = 25
PLAYER_MIN_OVR = 26
PLAYER_EXACT_OVR = 27
PLAYER_MAX_OVR = 28
FIRST_OWNER_PLAYERS_COUNT = 30
PLAYER_TRADABILITY = 33
CHEMISTRY_POINTS = 35
ALL_PLAYERS_CHEMISTRY_POINTS = 36

KEY_NAMES = {v: k for k, v in globals().items() if k.isupper() and isinstance(v, int)}

# General positions per formation (UTSquadFormationDTO.generalPositions), CONFIRMED from
# squads captured in test/fixtures/sbc-all-11.json. The extension also sends ones it learns.
FORMATION_POSITIONS = {
    "f442": [0, 3, 5, 5, 7, 12, 14, 14, 16, 25, 25],
    "f41212": [0, 3, 5, 5, 7, 10, 12, 16, 18, 25, 25],
    "f343": [0, 5, 5, 5, 12, 14, 14, 16, 23, 25, 27],
    "f4141": [0, 3, 5, 5, 7, 10, 12, 14, 14, 16, 25],
    "f3142": [0, 5, 5, 5, 10, 12, 14, 14, 16, 25, 25],
    "f451": [0, 3, 5, 5, 7, 12, 14, 16, 18, 18, 25],
    "f532": [0, 3, 5, 5, 5, 7, 10, 14, 14, 25, 25],
    "f5212": [0, 3, 5, 5, 5, 7, 14, 14, 18, 25, 25],
}
POSITION_NAMES = {0: "GK", 2: "RWB", 3: "RB", 5: "CB", 7: "LB", 8: "LWB", 10: "CDM", 12: "RM", 14: "CM",
                  16: "LM", 18: "CAM", 21: "CF", 23: "RW", 25: "ST", 27: "LW"}

# SBCEligibilityScope (CONFIRMED)
GREATER, LOWER, EXACT = 0, 1, 2
SCOPE_NAMES = {GREATER: "min", LOWER: "max", EXACT: "exactly"}


@dataclass(frozen=True)
class Player:
    id: int
    definition_id: int
    base_id: int  # databaseId: same real player across card versions (one per squad)
    name: str
    rating: int
    rareflag: int
    tier: int  # 1 bronze, 2 silver, 3 gold
    team_id: int
    league_id: int
    nation_id: int
    positions: tuple[int, ...]  # PlayerPosition ids (general positions, e.g. 5 = CB)
    tradable: bool
    loans: int  # -1 = not a loan
    limited_use: bool
    owners: int
    groups: tuple[int, ...]
    special: bool
    legend: bool
    hero: bool
    market_price: int  # EA market average; -1 = unknown
    in_storage: bool = False
    in_academy: bool = False
    in_evolution: bool = False
    in_unassigned: bool = False  # duplicate waiting in the unassigned pile
    in_transfer: bool = False  # duplicate on the transfer list, not listed for sale
    in_active_squad: bool = False  # in your active squad (starters, subs or reserves)


@dataclass(frozen=True)
class Slot:
    index: int
    position_id: int  # unique position, e.g. 4 = RCB
    general_position: int  # e.g. 5 = CB; compared with Player.positions
    name: str
    player_type: str  # DEFAULT / BRICK / CUSTOM_BRICK
    # CUSTOM_BRICK slots hold a locked placeholder card (e.g. LaLiga / Real Madrid / Ivory Coast)
    # that isn't a player but carries league, club and nation for chemistry links.
    brick: "Player | None" = None

    @property
    def open(self) -> bool:
        return self.player_type == "DEFAULT"


@dataclass(frozen=True)
class Requirement:
    key: int
    scope: int
    count: int  # -1 = applies to every squad player (per-player keys) / unused (squad keys)
    values: tuple[int, ...]

    @property
    def key_name(self) -> str:
        return KEY_NAMES.get(self.key, f"KEY_{self.key}")

    def describe(self) -> str:
        vals = ",".join(map(str, self.values))
        cnt = "" if self.count < 0 else f" count={self.count}"
        return f"{self.key_name} {SCOPE_NAMES.get(self.scope, self.scope)} [{vals}]{cnt}"


@dataclass
class Challenge:
    id: int
    name: str
    formation: str
    operation: str  # AND / OR
    requirements: list[Requirement]
    slots: list[Slot]
    # Ground truth captured from the app (only when the dumped squad was filled).
    app_rating: int | None = None
    app_chemistry: int | None = None
    # Brick challenge never opened: how many slots are bricks is unknown, so no estimate.
    layout_unknown: bool = False
    squad_player_ids: dict[int, int] = field(default_factory=dict)  # slot index -> item id


def _player_from_item(item: dict, in_storage: bool = False, pile: str = "club") -> Player:
    f = item["fields"]
    sd = item.get("staticData") or {}
    pr = item.get("predicates") or {}
    known = sd.get("knownAs")
    name = known if known and known != "---" else sd.get("name") or str(f.get("definitionId"))
    tier = f.get("getTier")
    if not isinstance(tier, int) or tier <= 0:
        tier = 3 if pr.get("isGoldRating") else 2 if pr.get("isSilverRating") else 1
    return Player(
        id=int(f.get("id") or 0),
        definition_id=int(f.get("definitionId") or 0),
        base_id=int(f.get("databaseId") or f.get("definitionId") or 0),
        name=name,
        rating=int(f.get("rating") or 0),
        rareflag=int(f.get("rareflag") or 0),
        tier=tier,
        team_id=int(f["teamId"]),
        league_id=int(f["leagueId"]),
        nation_id=int(f["nationId"]),
        positions=tuple(f.get("possiblePositions") or f.get("basePossiblePositions") or ()),
        tradable=bool(f.get("tradable")),
        loans=int(f.get("loans", -1)),
        limited_use=bool(f.get("limitedUseType")) or bool(pr.get("isLimitedUse")),
        owners=int(f.get("owners") or 1),
        groups=tuple(f.get("groups") or ()),
        special=bool(pr.get("isSpecial")),
        legend=bool(pr.get("isLegend")),
        hero=bool(pr.get("isLeagueHeroItem")),
        market_price=int(f.get("getMarketAverage") if isinstance(f.get("getMarketAverage"), int) else -1),
        in_storage=in_storage,
        in_academy=bool(pr.get("isEnrolledInAcademy")) or bool(pr.get("isActiveInAcademy")),
        in_evolution=bool(pr.get("isActiveInTimedEvolution")),
        in_unassigned=pile == "unassigned",
        in_transfer=pile == "transfer",
    )


def load_club(path: str | Path) -> tuple[list[Player], dict[int, int]]:
    """Returns (players incl. SBC storage, team link map team_id -> canonical id)."""
    return club_from_dump(json.loads(Path(path).read_text(encoding="utf-8")))


def club_from_dump(data: dict) -> tuple[list[Player], dict[int, int]]:
    players = [_player_from_item(i) for i in data["players"] if i and i["fields"].get("type") == "player"]
    players += [_player_from_item(i, in_storage=True) for i in data.get("storage") or [] if i]
    players += [_player_from_item(i, pile="unassigned") for i in data.get("unassigned") or [] if i]
    players += [_player_from_item(i, pile="transfer") for i in data.get("transferDuplicates") or [] if i]
    active = {int(i) for i in (data.get("activeSquad") or {}).get("ids") or []}
    if active:
        players = [replace(p, in_active_squad=True) if p.id in active else p for p in players]
    return _borrow_missing_prices(players), team_link_map(data.get("teamLinks") or [])


def _borrow_missing_prices(players: list[Player]) -> list[Player]:
    """EA gives SBC-storage items no market price (-1). Storage holds duplicates of club
    players, so use the price of another item with the same definition id."""
    known = {p.definition_id: p.market_price for p in players if p.market_price > 0}
    return [
        replace(p, market_price=known[p.definition_id]) if p.market_price <= 0 and p.definition_id in known else p
        for p in players
    ]


def team_link_map(pairs: list[list[int]]) -> dict[int, int]:
    """Linked clubs (e.g. a women's team and its men's club) share chemistry. Union-find to one id."""
    parent: dict[int, int] = {}

    def find(a: int) -> int:
        parent.setdefault(a, a)
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for pair in pairs:
        if isinstance(pair, list) and len(pair) >= 2:
            a, b = find(int(pair[0])), find(int(pair[1]))
            if a != b:
                parent[max(a, b)] = min(a, b)
    return {k: find(k) for k in parent}


def load_challenge(path: str | Path) -> Challenge:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return challenge_from_dump(data)


def load_challenges(path: str | Path) -> list[Challenge]:
    """Accepts a single SBC dump ("sbc") or a "Dump all SBCs" file ("sbc-all")."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if data.get("kind") == "sbc-all":
        return [challenge_from_dump(entry) for entry in data["challenges"]]
    return [challenge_from_dump(data)]


def challenge_from_dump(data: dict) -> Challenge:
    ch = data["challenge"]
    reqs = []
    for r in data.get("requirements") or []:
        kv = (r.get("raw") or {}).get("kvPairs", {}).get("__collection") or {}
        if not kv and r.get("firstKey") is not None:
            kv = {str(r["firstKey"]): r.get("firstValue") or []}
        for key, values in kv.items():
            reqs.append(
                Requirement(
                    key=int(key),
                    scope=int(r.get("scope", GREATER)),
                    count=int(r.get("count", -1)),
                    values=tuple(int(v) for v in (values or [])),
                )
            )
    slots = []
    squad_ids = {}
    layout_unknown = False
    for s in (data.get("squad") or {}).get("slots") or []:
        pos = s.get("position")
        if not pos:
            continue
        player_type = (s.get("requirement") or {}).get("playerType") or "DEFAULT"
        brick = _player_from_item(s["item"]) if player_type == "CUSTOM_BRICK" and s.get("item") else None
        slots.append(
            Slot(
                index=int(s["i"]),
                position_id=int(pos["id"]),
                general_position=int(pos["typeId"]),
                name=pos.get("name", ""),
                player_type=player_type,
                brick=brick,
            )
        )
        if s.get("item") and player_type == "DEFAULT":
            squad_ids[int(s["i"])] = int(s["item"]["fields"]["id"])
    if not slots:
        # Challenge not loaded (loading one marks it "In Progress"), so there is no squad.
        # Use the formation's general positions when known; otherwise positionless slots
        # (fine unless chemistry is required). A brick challenge can have several bricks, so
        # without its learned layout it can't be priced (see rules.unsupported).
        positions = data.get("formationPositions") or FORMATION_POSITIONS.get(ch.get("formation", ""))
        if positions and len(positions) == 11:
            slots = [Slot(index=i, position_id=g, general_position=g, name=POSITION_NAMES.get(g, "?"), player_type="DEFAULT")
                     for i, g in enumerate(positions)]
        else:
            slots = [Slot(index=i, position_id=-1, general_position=-1, name="?", player_type="DEFAULT") for i in range(11)]
        layout_unknown = bool(data.get("brickChallenge"))
    summary = (data.get("squad") or {}).get("summary") or {}
    return Challenge(
        id=int(ch["id"]),
        name=ch.get("name", ""),
        formation=ch.get("formation", ""),
        operation=ch.get("eligibilityOperation") or "AND",
        requirements=reqs,
        slots=slots,
        app_rating=summary.get("getRating") if squad_ids else None,
        app_chemistry=summary.get("getChemistry") if squad_ids else None,
        squad_player_ids=squad_ids,
        layout_unknown=layout_unknown,
    )
