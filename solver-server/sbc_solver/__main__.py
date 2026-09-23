"""CLI: python -m sbc_solver --club CLUB.json --sbc SBC.json [--top 3]"""
from __future__ import annotations

import argparse
import json
import sys

from . import CostOptions, SolveOptions, load_challenges, load_club, solve


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="sbc_solver")
    ap.add_argument("--club", required=True, help="club dump JSON from the extension")
    ap.add_argument("--sbc", required=True, help="SBC dump or 'Dump all SBCs' JSON from the extension")
    ap.add_argument("--challenge", type=int, help="only solve this challenge id (multi-SBC files)")
    ap.add_argument("--top", type=int, default=3, help="number of solutions")
    ap.add_argument("--time", type=float, default=10.0, help="time limit in seconds")
    ap.add_argument("--allow-special", action="store_true", help="allow special cards")
    ap.add_argument("--max-cost", type=int, default=50000, help="never use players worth more")
    ap.add_argument("--json", action="store_true", help="print raw JSON result")
    args = ap.parse_args(argv)

    players, links = load_club(args.club)
    challenges = [c for c in load_challenges(args.sbc) if args.challenge in (None, c.id)]
    results = []
    for challenge in challenges:
        result = solve(
            challenge,
            players,
            links,
            CostOptions(allow_special=args.allow_special, max_cost=args.max_cost),
            SolveOptions(time_limit_s=args.time, max_solutions=args.top),
        )
        results.append({"challengeId": challenge.id, "name": challenge.name, **result})
        if not args.json:
            _print(challenge, result)
    if args.json:
        json.dump(results if len(results) != 1 else results[0], sys.stdout, indent=2, ensure_ascii=False)
    return 0


def _print(challenge, result) -> None:
    print(f"\n=== [{challenge.id}] {challenge.name} ({challenge.formation})")
    for r in challenge.requirements:
        print(f"    {r.describe()}")
    print(f"status: {result['status']}  {result.get('stats', '')}")
    for u in result.get("unsupported", []):
        print(f"  unsupported: {u}")
    for n, sol in enumerate(result["solutions"], 1):
        print(f"\n#{n}  cost {sol['totalCost']:,}  rating {sol['teamRating']}  chem {sol['chemistry']}"
              + (f"  INVALID: {sol['validationErrors']}" if sol["validationErrors"] else ""))
        for s in sol["slots"]:
            flag = "" if s["inPosition"] else " (out of position)"
            trade = "" if s["tradable"] else " untradeable"
            print(f"  {s['position']:>4}  {s['rating']}  {s['name']:<24} {s['cost']:>7,}{trade}{flag}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
