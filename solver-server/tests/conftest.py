import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT.parent / "test" / "fixtures"
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).parent))

from sbc_solver.data import load_challenge, load_club  # noqa: E402


@pytest.fixture(scope="session")
def club():
    return load_club(FIXTURES / "club-121.json")


@pytest.fixture(scope="session")
def players(club):
    return club[0]


@pytest.fixture(scope="session")
def links(club):
    return club[1]


@pytest.fixture(scope="session")
def brick_challenge():
    return load_challenge(FIXTURES / "sbc-2x79-upgrade-filled.json")
