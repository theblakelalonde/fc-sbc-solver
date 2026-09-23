"""CP-SAT model: pick players for an SBC's open slots at minimum cost.

Result shape matches what the extension's solver (extension/src/solver/sbc-solver.js) returns.
"""
from __future__ import annotations

import itertools
import time
from collections import Counter, defaultdict
from dataclasses import dataclass

from ortools.sat.python import cp_model

from . import rules
from .costs import CostOptions, exclusion_reason, fodder_value, player_cost
from .data import (
    ALL_PLAYERS_CHEMISTRY_POINTS, CHEMISTRY_POINTS, CLUB_COUNT, EXACT, FIRST_OWNER_PLAYERS_COUNT,
    CLUB_ID, GREATER, LEAGUE_COUNT, LEAGUE_ID, LEGEND_COUNT, LOWER, NATION_COUNT, NATION_ID,
    PLAYER_COUNT, PLAYER_LEVEL, PLAYER_QUALITY, PLAYER_RARITY, PLAYER_RARITY_GROUP, SAME_CLUB_COUNT,
    SAME_LEAGUE_COUNT, SAME_NATION_COUNT, TEAM_RATING, Challenge, Player, Slot,
)

MAX_RATING = 99
# Objective = cost * COST_SCALE + tiebreaks. Tiebreaks (lower ratings, then players in position)
# add at most 11 * (99 + 10) < COST_SCALE, so they only ever decide between equal-cost squads.
COST_SCALE = 1200
RATING_SCALE = 10**9  # "solve using rating": rating dominates cost
OUT_OF_POSITION_PENALTY = 10


@dataclass
class SolveOptions:
    time_limit_s: float = 10.0
    max_solutions: int = 3
    workers: int = 8
    # Stop once the squad is proven within this share of the cheapest possible. Market prices
    # move more than 1%, so proving the last coin isn't worth the extra seconds.
    relative_gap: float = 0.01
    # "price": cheapest squad. "rating": use the lowest-rated players that work (price breaks ties).
    objective: str = "price"


def _add_compare(model: cp_model.CpModel, expr, scope: int, target: int) -> None:
    if scope == GREATER:
        model.Add(expr >= target)
    elif scope == LOWER:
        model.Add(expr <= target)
    else:
        model.Add(expr == target)


class _Model:
    """Variables and constraints for one challenge. Pass a shared `model` to put several
    challenges in one CP-SAT model (whole-set solving); the caller then sets the objective."""

    def __init__(
        self,
        challenge: Challenge,
        pool: list[Player],
        links: dict[int, int],
        costs: dict[int, int],
        model: cp_model.CpModel | None = None,
        fixed: dict[int, Player] | None = None,
        objective: str = "price",
    ):
        self.ch = challenge
        self.pool = pool
        self.fixed = fixed or {}  # slot index -> player kept in that slot ("keep squad players")
        self.objective_kind = objective
        self.links = links
        self.costs = costs
        self.open_slots = [s for s in challenge.slots if s.open]
        self.bricks = rules.bricks(challenge.slots)
        # Slots with the same general position (RCB/LCB, RS/LS) are interchangeable, so players
        # are assigned to a position type with a capacity; concrete slots are picked afterwards.
        self.slot_types = Counter(s.general_position for s in self.open_slots)
        self.standalone = model is None
        self.m = model or cp_model.CpModel()
        self.y = {p.id: self.m.NewBoolVar(f"y_{challenge.id}_{p.id}") for p in pool}
        self.x: dict[tuple[int, int], cp_model.IntVar] = {}  # (player id, general position) -> bool
        self._build()

    # ---- structure ----

    def _build(self) -> None:
        m, y = self.m, self.y
        m.Add(sum(y.values()) == len(self.open_slots))
        by_base = defaultdict(list)
        for p in self.pool:
            by_base[p.base_id].append(y[p.id])
        for vs in by_base.values():
            if len(vs) > 1:
                m.Add(sum(vs) <= 1)
        for p in self.fixed.values():
            m.Add(y[p.id] == 1)

        needs_chem = any(r.key in (CHEMISTRY_POINTS, ALL_PLAYERS_CHEMISTRY_POINTS) for r in self.ch.requirements)
        if needs_chem:
            self._build_assignment()
            self._build_chemistry()

        for r in self.ch.requirements:
            self._add_requirement(r)

        if self.objective_kind == "rating":
            # Lowest total rating first, then cost (costs stay below RATING_SCALE).
            weight = {p.id: p.rating * RATING_SCALE + self.costs[p.id] for p in self.pool}
        else:
            weight = {p.id: self.costs[p.id] * COST_SCALE + p.rating for p in self.pool}
        objective = sum((weight[p.id] + OUT_OF_POSITION_PENALTY) * y[p.id] for p in self.pool)
        if self.x:
            # Refund the penalty for every player placed in position.
            objective -= OUT_OF_POSITION_PENALTY * sum(sum(v) for v in self.x_in_position.values())
        self.objective = objective
        if self.standalone:
            m.Minimize(objective)

    def extract(self, solver: cp_model.CpSolver, by_id: dict[int, Player]) -> dict[int, Player]:
        """Slot index -> player from a solved model."""
        chosen = [by_id[pid] for pid, v in self.y.items() if solver.Value(v)]
        if not self.x:
            return _assign_positions(chosen, self.open_slots, self.fixed)
        # Kept players stay in their own slot; everyone else takes a free slot of their type.
        assignment = dict(self.fixed)
        kept = {p.id for p in self.fixed.values()}
        free = defaultdict(list)
        for s in self.open_slots:
            if s.index not in self.fixed:
                free[s.general_position].append(s.index)
        for (pid, gen), v in self.x.items():
            if solver.Value(v) and pid not in kept:
                assignment[free[gen].pop(0)] = by_id[pid]
        return assignment

    def _build_assignment(self) -> None:
        # Every player in an ALL_PLAYERS_CHEMISTRY_POINTS >= 1 squad must be in position.
        min_each = max(
            (r.values[0] for r in self.ch.requirements if r.key == ALL_PLAYERS_CHEMISTRY_POINTS), default=0
        )
        by_type = defaultdict(list)
        self.x_in_position = defaultdict(list)  # player id -> x vars for in-position types
        for p in self.pool:
            row = []
            for gen in self.slot_types:
                ok = gen in p.positions
                if min_each >= 1 and not ok:
                    continue
                v = self.m.NewBoolVar(f"x_{p.id}_{gen}")
                self.x[p.id, gen] = v
                row.append(v)
                by_type[gen].append(v)
                if ok:
                    self.x_in_position[p.id].append(v)
            self.m.Add(sum(row) == self.y[p.id])
        slot_by_index = {s.index: s for s in self.open_slots}
        for si, p in self.fixed.items():
            key = (p.id, slot_by_index[si].general_position)
            if key in self.x:
                self.m.Add(self.x[key] == 1)
            else:
                self.m.Add(self.y[p.id] == 0)  # kept player can't stand there: infeasible
        for gen, capacity in self.slot_types.items():
            self.m.Add(sum(by_type[gen]) == capacity)

    def _contrib(self, p: Player):
        if rules.OUT_OF_POSITION_CONTRIBUTES:
            return self.y[p.id]
        return sum(self.x_in_position[p.id])

    def _build_chemistry(self) -> None:
        m = self.m
        self.contrib = {p.id: self._contrib(p) for p in self.pool}
        points = {}
        for kind, key_fn, thresholds in (
            ("n", lambda p: p.nation_id, rules.NATION_THRESHOLDS),
            ("l", lambda p: p.league_id, rules.LEAGUE_THRESHOLDS),
            ("c", lambda p: rules.canonical_club(p.team_id, self.links), rules.CLUB_THRESHOLDS),
        ):
            groups = defaultdict(list)
            for p in self.pool:
                groups[key_fn(p)].append(self.contrib[p.id])
            brick_links = Counter(key_fn(b) for b in self.bricks)
            for g, members in groups.items():
                levels = []
                for t in thresholds:
                    if t > len(members) + brick_links[g]:
                        break
                    b = m.NewBoolVar(f"lvl_{kind}{g}_{t}")
                    m.Add(sum(members) + brick_links[g] >= t).OnlyEnforceIf(b)
                    levels.append(b)
                points[kind, g] = sum(levels) if levels else 0
        self.link_points = {
            p.id: points["n", p.nation_id]
            + points["l", p.league_id]
            + points["c", rules.canonical_club(p.team_id, self.links)]
            for p in self.pool
        }
        # chem[p] is only bounded above, which is exact for "min chemistry" requirements.
        self.chem = {}
        for p in self.pool:
            c = m.NewIntVar(0, rules.MAX_PLAYER_CHEM, f"chem_{p.id}")
            m.Add(c <= self.link_points[p.id])
            m.Add(c <= rules.MAX_PLAYER_CHEM * self.contrib[p.id])
            self.chem[p.id] = c
        # Custom bricks earn chem too, from the same link counts (groups no player shares
        # only have the bricks' own count).
        thresholds = {"n": rules.NATION_THRESHOLDS, "l": rules.LEAGUE_THRESHOLDS, "c": rules.CLUB_THRESHOLDS}
        self.brick_chem = []
        for k, b in enumerate(self.bricks):
            keys = {"n": b.nation_id, "l": b.league_id, "c": rules.canonical_club(b.team_id, self.links)}
            pts = 0
            for kind, g in keys.items():
                if (kind, g) in points:
                    pts += points[kind, g]
                else:
                    same = sum(1 for o in self.bricks if {"n": o.nation_id, "l": o.league_id,
                               "c": rules.canonical_club(o.team_id, self.links)}[kind] == g)
                    pts += rules.threshold_points(same, thresholds[kind])
            c = m.NewIntVar(0, rules.MAX_PLAYER_CHEM, f"brick_chem_{k}")
            m.Add(c <= pts)
            self.brick_chem.append(c)

    # ---- requirements ----

    def _add_requirement(self, r) -> None:
        m, y, k = self.m, self.y, r.key
        t = r.values[0] if r.values else 0
        if k in rules.PER_PLAYER_KEYS:
            matching = [y[p.id] for p in self.pool if rules.player_matches(r, p, self.links)]
            if r.count < 0:
                for p in self.pool:
                    if not rules.player_matches(r, p, self.links):
                        m.Add(y[p.id] == 0)
            else:
                brick_hits = sum(rules.player_matches(r, b, self.links) for b in self.bricks)
                self._compare_with_bricks(sum(matching), brick_hits, r.scope, r.count)
        elif k == TEAM_RATING:
            self._add_team_rating(r.scope, t)
        elif k == CHEMISTRY_POINTS:
            m.Add(sum(self.chem.values()) + sum(self.brick_chem) >= t)
        elif k == ALL_PLAYERS_CHEMISTRY_POINTS:
            for p in self.pool:
                m.Add(self.link_points[p.id] >= t).OnlyEnforceIf(y[p.id])
        elif k in (SAME_NATION_COUNT, SAME_LEAGUE_COUNT, SAME_CLUB_COUNT):
            self._add_same_group(k, r.scope, t)
        elif k in (NATION_COUNT, LEAGUE_COUNT, CLUB_COUNT):
            self._add_distinct_groups(k, r.scope, t)
        elif k == FIRST_OWNER_PLAYERS_COUNT:
            _add_compare(m, sum(y[p.id] for p in self.pool if p.owners == 1), r.scope, t)
        elif k == LEGEND_COUNT:
            _add_compare(m, sum(y[p.id] for p in self.pool if p.legend), r.scope, t)
        elif k == PLAYER_COUNT:
            _add_compare(m, sum(y.values()), r.scope, t)

    def _compare_with_bricks(self, expr, brick_hits: int, scope: int, target: int) -> None:
        """Mirror of rules.compare_with_bricks: minimums from players alone, maximums with bricks."""
        if scope in (GREATER, EXACT):
            self.m.Add(expr >= target)
        if scope in (LOWER, EXACT):
            self.m.Add(expr + brick_hits <= target)

    def _add_team_rating(self, scope: int, target: int) -> None:
        """Displayed rating vs target, with S = sum of ratings, E = sum max(0, r - S/11).

        Scaled by 11 to stay integral: 11*S + sum max(0, 11*r - S), compared with the bounds from
        rules.team_rating_bounds (which include the app's Math.round step).
        Rating depends only on how many players of each rating are picked, so the excess is
        modelled per rating value (as in Regista6's squad_rating_constraint_3, MIT).
        """
        m, y = self.m, self.y
        n = rules.SQUAD_SIZE
        by_rating = defaultdict(list)
        for p in self.pool:
            by_rating[p.rating].append(y[p.id])
        total = sum(p.rating * y[p.id] for p in self.pool)
        s_var = m.NewIntVar(0, n * MAX_RATING, "rating_sum")
        m.Add(s_var == total)
        excess = []
        for v, members in by_rating.items():
            cnt = m.NewIntVar(0, min(n, len(members)), f"cnt_{v}")
            m.Add(cnt == sum(members))
            gap = m.NewIntVar(0, n * v, f"gap_{v}")
            m.AddMaxEquality(gap, [n * v - s_var, 0])
            if scope == GREATER:
                # Only a lower bound on the rating is needed, so cnt*gap can be bounded from
                # above linearly: one term per possible pick k, each <= gap and 0 unless picked.
                # This relaxes far better than a multiplication constraint.
                picks = [m.NewBoolVar(f"pick_{v}_{k}") for k in range(min(n, len(members)))]
                for k in range(1, len(picks)):
                    m.AddImplication(picks[k], picks[k - 1])
                m.Add(cnt == sum(picks))
                for k, u in enumerate(picks):
                    w = m.NewIntVar(0, n * v, f"w_{v}_{k}")
                    m.Add(w <= gap)
                    m.Add(w <= n * v * u)
                    excess.append(w)
            else:
                e = m.NewIntVar(0, n * n * v, f"excess_{v}")
                m.AddMultiplicationEquality(e, [cnt, gap])
                excess.append(e)
        scaled = n * s_var + sum(excess)
        low = rules.team_rating_bounds(target)[0]
        high = rules.team_rating_bounds(target)[1]
        if scope in (GREATER, EXACT):
            m.Add(scaled >= low)
        if scope in (LOWER, EXACT):
            m.Add(scaled <= high)

    def _group_fn(self, key: int):
        if key in (SAME_NATION_COUNT, NATION_COUNT):
            return lambda p: p.nation_id
        if key in (SAME_LEAGUE_COUNT, LEAGUE_COUNT):
            return lambda p: p.league_id
        return lambda p: rules.canonical_club(p.team_id, self.links)

    def _groups(self, key: int) -> dict[int, list]:
        fn = self._group_fn(key)
        groups = defaultdict(list)
        for p in self.pool:
            groups[fn(p)].append(self.y[p.id])
        return groups

    def _add_same_group(self, key: int, scope: int, t: int) -> None:
        m = self.m
        groups = self._groups(key)
        brick_groups = Counter(self._group_fn(key)(b) for b in self.bricks)
        if scope in (LOWER, EXACT):
            for g, members in groups.items():
                m.Add(sum(members) + brick_groups[g] <= t)
            if any(n > t for g, n in brick_groups.items() if g not in groups):
                m.Add(sum(self.y.values()) <= -1)  # bricks alone already break the maximum: infeasible
        if scope in (GREATER, EXACT):
            hits = []
            for g, members in groups.items():
                if len(members) >= t:
                    b = m.NewBoolVar(f"same_{key}_{g}")
                    m.Add(sum(members) >= t).OnlyEnforceIf(b)
                    hits.append(b)
            m.Add(sum(hits) >= 1)

    def _add_distinct_groups(self, key: int, scope: int, t: int) -> None:
        m = self.m
        brick_groups = {self._group_fn(key)(b) for b in self.bricks}
        used = {}
        for g, members in self._groups(key).items():
            u = m.NewBoolVar(f"used_{key}_{g}")
            m.Add(u <= sum(members))
            for v in members:
                m.Add(u >= v)
            used[g] = u
        players_only = sum(used.values())
        with_bricks = sum(u for g, u in used.items() if g not in brick_groups) + len(brick_groups)
        if scope in (GREATER, EXACT):
            m.Add(players_only >= t)
        if scope in (LOWER, EXACT):
            m.Add(with_bricks <= t)


def _prune_dominated(pool: list[Player], challenges: list[Challenge], links, costs, always: set[int] = frozenset()) -> list[Player]:
    """Keep only the cheapest players among those identical for this challenge.

    Players with the same signature (every attribute the requirements look at) differ only in
    cost. Keeping open_slots + 11 of each, with distinct base ids, is enough: any optimal squad
    can swap an unkept player for a kept, cheaper one whose base id isn't already in the squad.
    """
    keys = {r.key for ch in challenges for r in ch.requirements}
    chem = bool(keys & {CHEMISTRY_POINTS, ALL_PLAYERS_CHEMISTRY_POINTS})
    nation = chem or bool(keys & {NATION_ID, SAME_NATION_COUNT, NATION_COUNT})
    league = chem or bool(keys & {LEAGUE_ID, SAME_LEAGUE_COUNT, LEAGUE_COUNT})
    club = chem or bool(keys & {CLUB_ID, SAME_CLUB_COUNT, CLUB_COUNT})

    def signature(p: Player) -> tuple:
        return (
            p.rating,
            p.tier if keys & {PLAYER_QUALITY, PLAYER_LEVEL} else None,
            p.rareflag if PLAYER_RARITY in keys else None,
            p.groups if PLAYER_RARITY_GROUP in keys else None,
            p.nation_id if nation else None,
            p.league_id if league else None,
            rules.canonical_club(p.team_id, links) if club else None,
            tuple(sorted(p.positions)) if chem else None,
            p.owners == 1 if FIRST_OWNER_PLAYERS_COUNT in keys else None,
            p.legend if LEGEND_COUNT in keys else None,
        )

    keep_per_group = sum(s.open for ch in challenges for s in ch.slots) + rules.SQUAD_SIZE
    groups = defaultdict(list)
    for p in pool:
        groups[signature(p)].append(p)
    kept = [p for p in pool if p.id in always]
    for members in groups.values():
        seen_bases = set()
        for p in sorted(members, key=lambda q: (costs[q.id], q.id)):
            if p.base_id in seen_bases or p.id in always:
                continue
            seen_bases.add(p.base_id)
            kept.append(p)
            if len(seen_bases) >= keep_per_group:
                break
    return kept


def _assign_positions(players: list[Player], slots: list[Slot], fixed: dict[int, Player] | None = None) -> dict[int, Player]:
    """No chemistry requirement: place chosen players, maximizing how many are in position.
    Kept players (`fixed`) stay in their slots."""
    fixed = fixed or {}
    kept = {p.id for p in fixed.values()}
    players = [p for p in players if p.id not in kept]
    slots = [s for s in slots if s.index not in fixed]
    m = cp_model.CpModel()
    x = {(p.id, s.index): m.NewBoolVar("") for p in players for s in slots}
    for p in players:
        m.AddExactlyOne(x[p.id, s.index] for s in slots)
    for s in slots:
        m.AddExactlyOne(x[p.id, s.index] for p in players)
    m.Maximize(sum(x[p.id, s.index] for p in players for s in slots if rules.in_position(p, s)))
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 2.0
    solver.Solve(m)
    return {**fixed, **{s.index: p for p in players for s in slots if solver.Value(x[p.id, s.index])}}


_STATUS = {
    cp_model.OPTIMAL: "optimal",
    cp_model.FEASIBLE: "feasible",
    cp_model.INFEASIBLE: "infeasible",
    cp_model.MODEL_INVALID: "error",
    cp_model.UNKNOWN: "timeout",
}


def _unsupported(challenge: Challenge) -> list[str]:
    return rules.unsupported(challenge) + [
        r.describe()
        for r in challenge.requirements
        if r.key in (CHEMISTRY_POINTS, ALL_PLAYERS_CHEMISTRY_POINTS) and r.scope != GREATER
    ]


def _usable_pool(players: list[Player], cost_opts: CostOptions):
    excluded = Counter()
    pool = []
    for p in players:
        reason = exclusion_reason(p, cost_opts)
        if reason:
            excluded[reason] += 1
        else:
            pool.append(p)
    return pool, excluded, {p.id: player_cost(p, cost_opts) for p in pool}


def _new_solver(opts: SolveOptions, time_limit: float) -> cp_model.CpSolver:
    solver = cp_model.CpSolver()
    solver.parameters.num_workers = opts.workers
    solver.parameters.relative_gap_limit = opts.relative_gap
    solver.parameters.max_time_in_seconds = max(0.5, time_limit)
    return solver


def _gap(solver: cp_model.CpSolver) -> float:
    obj, bound = solver.ObjectiveValue(), solver.BestObjectiveBound()
    return (obj - bound) / obj if obj > 0 else 0.0


def solve(
    challenge: Challenge,
    players: list[Player],
    links: dict[int, int],
    cost_opts: CostOptions | None = None,
    opts: SolveOptions | None = None,
) -> dict:
    cost_opts = cost_opts or CostOptions()
    opts = opts or SolveOptions()
    started = time.perf_counter()

    problems = _unsupported(challenge)
    if problems:
        return {"status": "unsupported", "unsupported": problems, "solutions": []}

    pool, excluded, costs = _usable_pool(players, cost_opts)
    by_item = {p.id: p for p in players}
    open_indices = {s.index for s in challenge.slots if s.open}
    fixed = {si: by_item[pid] for si, pid in cost_opts.keep.items() if si in open_indices and pid in by_item}
    before = len(pool)
    pool = _prune_dominated(pool, [challenge], links, costs, always={p.id for p in fixed.values()})

    model = _Model(challenge, pool, links, costs, fixed=fixed, objective=opts.objective)
    solver = _new_solver(opts, opts.time_limit_s)
    if opts.objective == "rating":
        # Rating dominates the objective, so a 1% gap would allow ~9 rating points of slack.
        solver.parameters.relative_gap_limit = min(opts.relative_gap, 0.0005)
    by_id = {p.id: p for p in pool}
    open_slots = model.open_slots

    solutions = []
    status_name = None
    gap = None
    deadline = started + opts.time_limit_s
    for _ in range(max(1, opts.max_solutions)):
        solver.parameters.max_time_in_seconds = max(0.5, deadline - time.perf_counter())
        status = solver.Solve(model.m)
        if status_name is None:
            status_name = _STATUS.get(status, "error")
            if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
                gap = _gap(solver)
        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            break
        assignment = model.extract(solver, by_id)
        chosen = list(assignment.values())
        solutions.append(_describe(challenge, assignment, links, costs))
        # Next solution must differ by at least one player.
        model.m.Add(sum(model.y[p.id] for p in chosen) <= len(chosen) - 1)

    return {
        "status": status_name,
        "solutions": solutions,
        "stats": {
            "poolSize": len(pool),
            "prunedDominated": before - len(pool),
            "excluded": dict(excluded),
            "openSlots": len(open_slots),
            "wallTimeS": round(time.perf_counter() - started, 3),
            "provenGap": None if gap is None else round(gap, 4),  # first solution vs best bound
        },
    }


def solve_set(
    challenges: list[Challenge],
    players: list[Player],
    links: dict[int, int],
    cost_opts: CostOptions | None = None,
    opts: SolveOptions | None = None,
) -> dict:
    """Solve the challenges of an SBC set together: each club item is used at most once
    across all squads, and the total cost is kept low.

    1. Solve each challenge alone. Impossible or unsupported ones are reported and skipped;
       the rest are still solved (status "partial").
    2. If those solo squads share no players, they are already the cheapest set: done.
    3. Otherwise: greedy (one challenge at a time, a few orders), then re-solve pairs of
       challenges together until within 1% of the solo lower bound, no pair improves, or
       time runs out. `opts.time_limit_s` is a cap, not a target.
    """
    cost_opts = cost_opts or CostOptions()
    opts = opts or SolveOptions(time_limit_s=30.0)
    started = time.perf_counter()
    deadline = started + opts.time_limit_s
    entries = {c.id: {"challengeId": c.id, "name": c.name} for c in challenges}

    todo = []
    for c in challenges:
        problems = _unsupported(c)
        if problems:
            entries[c.id].update(status="unsupported", unsupported=problems)
        else:
            todo.append(c)

    pool, excluded, costs = _usable_pool(players, cost_opts)
    before = len(pool)
    pool = _prune_dominated(pool, todo, links, costs) if todo else pool
    by_id = {p.id: p for p in pool}

    # 1. each challenge alone: feasibility + a lower bound for the set
    alone: dict[int, dict[int, Player]] = {}
    lower_bound = 0.0
    per_challenge = max(1.5, 0.3 * opts.time_limit_s / max(1, len(todo)))
    for c in todo:
        model = _Model(c, pool, links, costs)
        solver = _new_solver(opts, min(per_challenge, max(0.5, deadline - time.perf_counter())))
        status = solver.Solve(model.m)
        if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            alone[c.id] = model.extract(solver, by_id)
            lower_bound += _set_cost({c.id: alone[c.id]}, costs) * (1 - _gap(solver))
        else:
            entries[c.id]["status"] = "infeasible" if status == cp_model.INFEASIBLE else "timeout"
    solvable = [c for c in todo if c.id in alone]

    # 2. solo squads that don't compete for players are already the best set
    used = [p.id for a in alone.values() for p in a.values()]
    method = "independent"
    assignments = alone if len(used) == len(set(used)) else None

    # 3. squads compete for players: greedy + pair improvement
    if assignments is None:
        method = "shared players"
        greedy = _greedy_set(solvable, pool, links, costs, opts, time.perf_counter() + 0.25 * opts.time_limit_s)
        if greedy:
            assignments, _ = _improve_pairs(
                solvable, pool, links, costs, opts, greedy[1], deadline, target=lower_bound * 1.01
            )
        else:
            for c in solvable:
                entries[c.id]["status"] = "not enough players to do it together with the others"
            solvable = []

    total = 0
    for c in solvable:
        sol = _describe(c, assignments[c.id], links, costs)
        entries[c.id].update(status="solved", solution=sol)
        total += sol["totalCost"]

    solved = sum(e.get("status") == "solved" for e in entries.values())
    if solved == len(challenges):
        status_name = "optimal" if method == "independent" else "feasible"
    elif solved:
        status_name = "partial"
    elif any(e.get("status") == "unsupported" for e in entries.values()):
        status_name = "unsupported"
    else:
        status_name = "infeasible"
    return {
        "status": status_name,
        "challenges": [entries[c.id] for c in challenges],
        "totalCost": total,
        "stats": {
            "poolSize": len(pool),
            "prunedDominated": before - len(pool),
            "excluded": dict(excluded),
            "wallTimeS": round(time.perf_counter() - started, 3),
            "method": method,
        },
    }


def _joint(challenges, pool, links, costs, opts: SolveOptions, time_limit: float, hints=None):
    """One CP-SAT model over `challenges` with disjoint players. Returns {id: assignment} or None."""
    m = cp_model.CpModel()
    subs = [_Model(c, pool, links, costs, model=m) for c in challenges]
    for p in pool:
        m.Add(sum(sub.y[p.id] for sub in subs) <= 1)
    m.Minimize(sum(sub.objective for sub in subs))
    for sub, c in zip(subs, challenges):
        if hints and c.id in hints:
            _hint(m, sub, hints[c.id])
    solver = _new_solver(opts, time_limit)
    if solver.Solve(m) not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return None
    by_id = {p.id: p for p in pool}
    return {c.id: sub.extract(solver, by_id) for sub, c in zip(subs, challenges)}


def _improve_pairs(challenges, pool, links, costs, opts, assignments, deadline, target: float = 0.0):
    """Returns (assignments, stable). Stops early once the total cost reaches `target`."""
    pairs = list(itertools.combinations(range(len(challenges)), 2))
    improved_any = True
    while improved_any:
        improved_any = False
        for i, j in pairs:
            if _set_cost(assignments, costs) <= target:
                return assignments, True
            remaining = deadline - time.perf_counter()
            if remaining <= 0.3:
                return assignments, False
            pair = [challenges[i], challenges[j]]
            others = {p.id for c in challenges if c not in pair for p in assignments[c.id].values()}
            sub_pool = [p for p in pool if p.id not in others]
            current = _set_cost({c.id: assignments[c.id] for c in pair}, costs)
            step = SolveOptions(workers=opts.workers, relative_gap=opts.relative_gap)
            result = _joint(pair, sub_pool, links, costs, step, min(2.0, remaining), hints=assignments)
            if result and _set_cost(result, costs) < current:
                assignments = {**assignments, **result}
                improved_any = True
    return assignments, True


def _set_cost(assignments: dict[int, dict[int, Player]], costs: dict[int, int]) -> int:
    return sum(costs[p.id] for a in assignments.values() for p in a.values())


def _greedy_set(challenges, pool, links, costs, opts: SolveOptions, deadline: float):
    """Fill challenges one after another, removing used players; try a few orders.
    The first order always runs to the end (at least 2 s per step); later orders only while
    time is left. Returns (total cost, {challenge id: assignment}) for the cheapest, or None."""
    n = len(challenges)
    if n <= 3:
        orders = list(itertools.permutations(range(n)))
    else:
        by_reqs = sorted(range(n), key=lambda i: -len(challenges[i].requirements))
        orders = list(dict.fromkeys([tuple(range(n)), tuple(reversed(range(n))), tuple(by_reqs)]))
    by_id = {p.id: p for p in pool}
    best = None
    for k, order in enumerate(orders):
        if k > 0 and time.perf_counter() >= deadline:
            break
        used: set[int] = set()
        result: dict[int, dict[int, Player]] = {}
        for i in order:
            remaining = deadline - time.perf_counter()
            if k > 0 and remaining <= 0.2:
                return best
            c = challenges[i]
            model = _Model(c, [p for p in pool if p.id not in used], links, costs)
            step = SolveOptions(workers=opts.workers, relative_gap=0.02)
            solver = _new_solver(step, min(4.0, max(2.0, remaining)))
            if solver.Solve(model.m) not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
                result = None
                break
            result[c.id] = model.extract(solver, by_id)
            used |= {p.id for p in result[c.id].values()}
        if result:
            total = _set_cost(result, costs)
            if best is None or total < best[0]:
                best = (total, result)
    return best


def _hint(m: cp_model.CpModel, sub: "_Model", assignment: dict[int, Player]) -> None:
    chosen = {p.id for p in assignment.values()}
    for pid, v in sub.y.items():
        m.AddHint(v, pid in chosen)
    if sub.x:
        gen_of = {s.index: s.general_position for s in sub.open_slots}
        pairs = {(p.id, gen_of[i]) for i, p in assignment.items()}
        for key, v in sub.x.items():
            m.AddHint(v, key in pairs)


def _badge_price(p: Player) -> int:
    """EA market average, or the same rating estimate the extension's card badge shows."""
    return p.market_price if p.market_price > 0 else fodder_value(p)


def _describe(challenge: Challenge, assignment: dict[int, Player], links, costs) -> dict:
    slot_by_index = {s.index: s for s in challenge.slots}
    chem = rules.chemistry(assignment, challenge.slots, links)
    return {
        "slots": [
            {
                "slotIndex": i,
                "position": slot_by_index[i].name,
                "playerId": p.id,
                "name": p.name,
                "rating": p.rating,
                "cost": costs[p.id],  # solver's internal weighting (untradeables discounted)
                "marketPrice": _badge_price(p),  # as on the card badge
                "tradable": p.tradable,
                "inPosition": rules.in_position(p, slot_by_index[i]),
                "chemistry": chem.per_slot[i],
            }
            for i, p in sorted(assignment.items())
        ],
        "totalCost": sum(costs[p.id] for p in assignment.values()),
        "squadValue": sum(_badge_price(p) for p in assignment.values()),
        "teamRating": rules.team_rating([p.rating for p in assignment.values()]),
        "chemistry": chem.total,
        "validationErrors": rules.check_challenge(challenge, assignment, links),
    }
