"""The local HTTP server: solves fixture payloads and refuses web-page origins."""
import http.client
import json
import threading

import pytest

from sbc_solver.server import make_server

from conftest import FIXTURES


@pytest.fixture(scope="module")
def server():
    srv = make_server(0)  # any free port
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    yield srv.server_address[1]
    srv.shutdown()
    srv.server_close()


def request(port, method, path, body=None, headers=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=60)
    data = json.dumps(body).encode() if body is not None else None
    conn.request(method, path, body=data, headers={"Content-Type": "application/json", **(headers or {})})
    resp = conn.getresponse()
    return resp.status, json.loads(resp.read() or b"{}")


def fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def test_health(server):
    status, body = request(server, "GET", "/health")
    assert status == 200 and body["ok"] is True


def test_solve_fixture(server):
    body = {"club": fixture("club-121.json"), "sbc": fixture("sbc-2x79-upgrade-filled.json"), "options": {"maxSolutions": 2}}
    status, result = request(server, "POST", "/solve", body, {"Origin": "chrome-extension://abcdef"})
    assert status == 200
    assert result["status"] == "optimal"
    assert result["challenge"]["name"] == "2x 79+ Upgrade"
    assert len(result["solutions"]) == 2
    assert all(not s["validationErrors"] for s in result["solutions"])


def test_web_page_origin_is_refused(server):
    status, _ = request(server, "POST", "/solve", {"club": {}, "sbc": {}}, {"Origin": "https://evil.example"})
    assert status == 403


def test_foreign_host_header_is_refused(server):
    status, _ = request(server, "GET", "/health", headers={"Host": "attacker.example:8765"})
    assert status == 403


def test_bad_input(server):
    status, body = request(server, "POST", "/solve", {"club": {"players": "nope"}, "sbc": {}})
    assert status == 400
    assert "error" in body


def test_solve_set_endpoint(server):
    data = fixture("sbc-all-11.json")
    sbcs = [c for c in data["challenges"] if c["challenge"]["id"] in (38, 39)]
    body = {"club": fixture("club-121.json"), "sbcs": sbcs, "options": {"timeLimitS": 12}}
    status, result = request(server, "POST", "/solve-set", body)
    assert status == 200, result
    assert [e["status"] for e in result["challenges"]] == ["solved", "solved"]
    ids = [s["playerId"] for e in result["challenges"] for s in e["solution"]["slots"]]
    assert len(ids) == len(set(ids))
