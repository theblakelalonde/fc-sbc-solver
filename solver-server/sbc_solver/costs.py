"""Per-player cost and exclusions, plus the user's
auto-complete options (the extension's options dialog maps 1:1 onto CostOptions).

Cost source order: user override > EA market average (item.getMarketAverage) > rating heuristic.
Untradeable cards can't be sold, so they cost a fraction of their fodder value.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .data import Player

# Rough fodder value by rating when EA has no price. Only the ordering matters much.
_FODDER_BY_RATING = {
    75: 450, 76: 500, 77: 550, 78: 650, 79: 800, 80: 950, 81: 1200, 82: 1800, 83: 3000,
    84: 5000, 85: 8000, 86: 13000, 87: 20000, 88: 30000, 89: 45000, 90: 70000,
}

# "Only use rares if required": a rare card costs this much extra, so it's picked only when
# no common card can do the job.
RARE_PENALTY = 5000
# "Use storage first": storage cards cost almost nothing.
STORAGE_FIRST_FACTOR = 0.02


def fodder_value(p: Player) -> int:
    if p.rating < 75:
        base = 150 + p.rating  # bronze/silver
    else:
        base = _FODDER_BY_RATING.get(p.rating, 100000)
    return base * (5 if p.special else 1)


@dataclass
class CostOptions:
    untradeable_factor: float = 0.3  # untradeables cost this share of their value
    storage_factor: float = 0.3  # SBC storage items are there to be used
    overrides: dict[int, int] = field(default_factory=dict)  # item id -> cost
    locked: set[int] = field(default_factory=set)  # item ids never used
    allow_special: bool = False
    max_cost: int = 50000  # never auto-use players worth more than this
    max_rating: int | None = None  # optional: protect everything rated above this
    # Auto-complete options (same names as the extension's dialog)
    allow_tradeable: bool = True
    ignore_exclusions: bool = False  # ignore max value, rating limits and the locked list
    storage_first: bool = False
    rares_only_if_required: bool = True
    use_unassigned: bool = True  # duplicates waiting in "unassigned"
    use_transfer_duplicates: bool = True  # duplicates on the transfer list (not listed for sale)
    rating_min: int = 0
    rating_max: int = 99
    special_rating_min: int = 0
    special_rating_max: int = 99
    keep: dict[int, int] = field(default_factory=dict)  # slot index -> item id kept in place
    exclude_active_squad: bool = True  # never take players from your active squad


def player_cost(p: Player, opts: CostOptions) -> int:
    if p.id in opts.overrides:
        return max(0, int(opts.overrides[p.id]))
    value = p.market_price if p.market_price > 0 else fodder_value(p)
    if p.in_storage:
        value *= STORAGE_FIRST_FACTOR if opts.storage_first else opts.storage_factor
    elif not p.tradable:
        value *= opts.untradeable_factor
    if opts.rares_only_if_required and p.rareflag == 1:
        value += RARE_PENALTY
    return int(round(value))


def exclusion_reason(p: Player, opts: CostOptions) -> str | None:
    if p.id in opts.keep.values():
        return None  # already in the squad and the user asked to keep it
    if p.loans >= 0 or p.limited_use:
        return "loan"
    if p.in_academy or p.in_evolution:
        return "evolution"
    if p.in_active_squad and opts.exclude_active_squad:
        return "active squad"
    if p.in_unassigned and not opts.use_unassigned:
        return "unassigned"
    if p.in_transfer and not opts.use_transfer_duplicates:
        return "transfer list"
    if p.id in opts.overrides:
        return None  # an explicit cost opts the player in
    if p.special and not opts.allow_special:
        return "special"
    if p.tradable and not opts.allow_tradeable:
        return "tradeable"
    lo, hi = (opts.special_rating_min, opts.special_rating_max) if p.special else (opts.rating_min, opts.rating_max)
    if not lo <= p.rating <= hi:
        return "rating range"
    if opts.ignore_exclusions:
        return None
    if p.id in opts.locked:
        return "locked"
    if opts.max_rating is not None and p.rating > opts.max_rating:
        return "rating"
    if p.market_price > opts.max_cost:
        return "value"
    return None
