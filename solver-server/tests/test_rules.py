"""Rating and chemistry rules against ground truth captured from the FC 27 Web App."""
import json
import math
import random

from sbc_solver import rules
from sbc_solver.data import _player_from_item, load_challenge

from conftest import FIXTURES


def _fixture_squad():
    data = json.loads((FIXTURES / "sbc-2x79-upgrade-filled.json").read_text(encoding="utf-8"))
    challenge = load_challenge(FIXTURES / "sbc-2x79-upgrade-filled.json")
    assignment = {s["i"]: _player_from_item(s["item"]) for s in data["squad"]["slots"] if s.get("item")}
    app_slot_chem = {s["i"]: s["accessors"]["chemistry"] for s in data["squad"]["slots"] if s.get("item")}
    return challenge, assignment, app_slot_chem


def test_team_rating_matches_app(links):
    challenge, assignment, _ = _fixture_squad()
    ratings = [p.rating for p in assignment.values()]
    assert len(ratings) == 10  # the GK slot is an empty BRICK slot
    assert round(rules.team_rating_raw(ratings), 2) == 84.69
    assert rules.team_rating(ratings) == challenge.app_rating == 84


def _app_rating_float_mode(ratings):
    """Line-by-line port of UTSquadEntity._calculateRating (float mode) from the Web App source
    (test/fixtures/rating-code.json), using floats like JS does."""
    field = 11
    n = sum(ratings)
    avg = min(n / field, 99)
    total = n + sum(r - avg for r in ratings if r > avg)
    n = math.floor(total + 0.5)  # JS Math.round
    return min(max(math.floor(n / field), 0), 99)


def test_team_rating_matches_app_source_on_random_squads():
    rng = random.Random(7)
    for _ in range(20000):
        size = rng.choice([10, 11])  # 10 = one empty brick slot
        ratings = [rng.randint(45, 99) for _ in range(size)]
        assert rules.team_rating(ratings) == _app_rating_float_mode(ratings), ratings


def test_team_rating_round_up_edge():
    rounds_up = [75, 78, 78, 80, 82, 82, 84, 84, 85, 88, 89]  # raw 83.967
    assert round(rules.team_rating_raw(rounds_up), 3) == 83.967
    assert rules.team_rating(rounds_up) == 84
    stays = [76, 81, 82, 84, 84, 87, 87, 88, 88, 90, 90]  # raw 86.901
    assert rules.team_rating(stays) == 86
    assert rules.team_rating([84] * 11) == 84
    assert rules.team_rating([]) == 0


def test_team_rating_bounds_match_team_rating():
    rng = random.Random(3)
    for _ in range(5000):
        ratings = [rng.randint(60, 95) for _ in range(11)]
        shown = rules.team_rating(ratings)
        low, high = rules.team_rating_bounds(shown)
        assert low <= rules.rating_scaled(ratings) <= high


def test_chemistry_matches_app_per_slot(links):
    challenge, assignment, app_slot_chem = _fixture_squad()
    result = rules.chemistry(assignment, challenge.slots, links)
    assert result.per_slot == app_slot_chem
    assert result.total == challenge.app_chemistry == 17


def test_team_links_merge_clubs(links):
    # Miedema's women's team (116017) links with Man City (10): both earn a club point in the fixture.
    assert rules.canonical_club(116017, links) == rules.canonical_club(10, links)


def test_fixture_squad_passes_its_requirements(links):
    challenge, assignment, _ = _fixture_squad()
    assert rules.check_challenge(challenge, assignment, links) == []


def test_storage_items_borrow_club_copy_price(players):
    storage = [p for p in players if p.in_storage]
    assert storage, "fixture has SBC storage items"
    by_def = {p.definition_id: p.market_price for p in players if not p.in_storage and p.market_price > 0}
    for p in storage:
        if p.definition_id in by_def:
            assert p.market_price == by_def[p.definition_id]


def test_unloaded_challenge_uses_formation_table():
    from sbc_solver.data import challenge_from_dump

    dump = {"challenge": {"id": 1, "name": "x", "formation": "f343"}, "requirements": [], "squad": None}
    ch = challenge_from_dump(dump)
    assert [s.general_position for s in ch.slots] == [0, 5, 5, 5, 12, 14, 14, 16, 23, 25, 27]
    learned = challenge_from_dump({**dump, "challenge": {**dump["challenge"], "formation": "f9999"},
                                   "formationPositions": [0, 3, 5, 5, 7, 10, 10, 18, 18, 18, 25]})
    assert learned.slots[5].general_position == 10
    unknown = challenge_from_dump({**dump, "challenge": {**dump["challenge"], "formation": "f9999"}})
    assert all(s.general_position == -1 for s in unknown.slots)


def test_brick_challenge_needs_its_learned_layout():
    import json
    from sbc_solver.data import challenge_from_dump

    d = json.loads((FIXTURES / "sbc-all-11.json").read_text(encoding="utf-8"))
    entry = next(c for c in d["challenges"] if c["challenge"]["id"] == 28)  # 2x 79+ Upgrade
    unknown = challenge_from_dump({**entry, "squad": None, "brickChallenge": True})
    assert any("brick layout unknown" in u for u in rules.unsupported(unknown))
    learned = challenge_from_dump({**entry, "brickChallenge": True, "squad": {"slots": [
        {"i": s["i"], "position": s["position"], "requirement": {"playerType": (s.get("requirement") or {}).get("playerType", "DEFAULT")}, "item": None}
        for s in entry["squad"]["slots"]]}})
    assert not rules.unsupported(learned)
    assert sum(s.open for s in learned.slots) == 10
