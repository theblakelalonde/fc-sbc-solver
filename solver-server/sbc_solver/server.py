"""Local solver server for the extension: python -m sbc_solver.server [--port 8765]

Binds to 127.0.0.1 only. Accepts requests from the extension's service worker
(Origin chrome-extension://...) or from local tools with no Origin; web pages are refused,
and the Host header must be localhost to block DNS-rebinding tricks.

POST /solve      {"club": <club dump>, "sbc": <sbc dump>, "options": {...}}      -> SolveResult
POST /solve-set  {"club": <club dump>, "sbcs": [<sbc dump>, ...], "options": {...}} -> set result
GET  /health -> {"ok": true, "version": ...}
"""
from __future__ import annotations

import argparse
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .costs import CostOptions
from .data import challenge_from_dump, club_from_dump
from .solver import SolveOptions, solve, solve_set

VERSION = "0.4.0"
DEFAULT_PORT = 8765
MAX_BODY = 32 * 1024 * 1024
ALLOWED_HOSTS = {"127.0.0.1", "localhost"}

# One solve at a time: each solve already uses several CPU workers.
_solve_lock = threading.Lock()


def options_from_request(opts: dict) -> tuple[CostOptions, SolveOptions]:
    """Maps the extension's settings / auto-complete options onto solver options."""
    num = lambda key, default: int(opts[key]) if opts.get(key) not in (None, "") else default  # noqa: E731
    cost = CostOptions(
        allow_special=bool(opts.get("allowSpecial", False)),
        max_cost=num("maxCost", 50000),
        max_rating=num("maxRating", None),
        locked={int(i) for i in opts.get("locked", [])},
        overrides={int(k): int(v) for k, v in (opts.get("overrides") or {}).items()},
        untradeable_factor=float(opts.get("untradeableFactor", 0.3)),
        allow_tradeable=bool(opts.get("allowTradeable", True)),
        ignore_exclusions=bool(opts.get("ignoreExclusions", False)),
        storage_first=bool(opts.get("storageFirst", False)),
        rares_only_if_required=bool(opts.get("raresOnlyIfRequired", True)),
        use_unassigned=bool(opts.get("useUnassigned", True)),
        use_transfer_duplicates=bool(opts.get("useTransferDuplicates", True)),
        rating_min=num("ratingMin", 0),
        rating_max=num("ratingMax", 99),
        special_rating_min=num("specialRatingMin", 0),
        special_rating_max=num("specialRatingMax", 99),
        keep={int(k): int(v) for k, v in (opts.get("keep") or {}).items()},
        exclude_active_squad=bool(opts.get("excludeActiveSquad", True)),
    )
    solve_opts = SolveOptions(
        objective="rating" if opts.get("solveUsing") == "rating" else "price",
        time_limit_s=min(120.0, float(opts.get("timeLimitS", 10.0))),
        max_solutions=max(1, min(10, int(opts.get("maxSolutions", 3)))),
        relative_gap=min(0.2, max(0.0, float(opts.get("relativeGap", 0.01)))),
    )
    return cost, solve_opts


def handle_solve_set(payload: dict) -> dict:
    players, links = club_from_dump(payload["club"])
    challenges = [challenge_from_dump(d) for d in payload["sbcs"]]
    if not challenges:
        raise ValueError("no challenges")
    opts = dict(payload.get("options") or {})
    opts.setdefault("timeLimitS", min(60.0, 10.0 * len(challenges)))
    cost_opts, solve_opts = options_from_request(opts)
    result = solve_set(challenges, players, links, cost_opts, solve_opts)
    return {"challenge": {"name": f"set of {len(challenges)}"}, **result}


def handle_solve(payload: dict) -> dict:
    players, links = club_from_dump(payload["club"])
    challenge = challenge_from_dump(payload["sbc"])
    cost_opts, solve_opts = options_from_request(payload.get("options") or {})
    result = solve(challenge, players, links, cost_opts, solve_opts)
    return {
        "challenge": {"id": challenge.id, "name": challenge.name, "formation": challenge.formation},
        "requirements": [r.describe() for r in challenge.requirements],
        **result,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = f"sbc-solver/{VERSION}"

    def _allowed(self) -> bool:
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]")
        origin = self.headers.get("Origin")
        return host in ALLOWED_HOSTS and (origin is None or origin.startswith("chrome-extension://"))

    def _send(self, status: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        if not self._allowed():
            return self._send(403, {"error": "forbidden"})
        if self.path == "/health":
            return self._send(200, {"ok": True, "version": VERSION})
        self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if not self._allowed():
            return self._send(403, {"error": "forbidden"})
        handler = {"/solve": handle_solve, "/solve-set": handle_solve_set}.get(self.path)
        if handler is None:
            return self._send(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self._send(413, {"error": "body missing or too large"})
        try:
            payload = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeDecodeError):
            return self._send(400, {"error": "invalid JSON"})
        needed = "sbc" if handler is handle_solve else "sbcs"
        if not isinstance(payload, dict) or "club" not in payload or needed not in payload:
            return self._send(400, {"error": f"expected {{club, {needed}, options}}"})
        if not _solve_lock.acquire(timeout=1):
            return self._send(429, {"error": "a solve is already running"})
        started = time.perf_counter()
        try:
            result = handler(payload)
        except (KeyError, TypeError, ValueError) as e:
            return self._send(400, {"error": f"bad input: {e!r}"})
        finally:
            _solve_lock.release()
        self.log_message(
            "solve %s -> %s in %.2fs", result["challenge"]["name"], result["status"], time.perf_counter() - started
        )
        self._send(200, result)


def make_server(port: int = DEFAULT_PORT) -> ThreadingHTTPServer:
    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="sbc_solver.server")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = ap.parse_args(argv)
    server = make_server(args.port)
    print(f"SBC solver {VERSION} listening on http://127.0.0.1:{args.port}  (Ctrl+C to stop)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
