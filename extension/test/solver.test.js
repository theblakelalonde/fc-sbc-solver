// Tests for the in-extension solver (src/solver/sbc-solver.js + HiGHS WebAssembly), mirroring
// solver-server/tests (the Python reference). Run: node --test extension/test/
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const loadHighs = require("../vendor/highs/highs.js");
const S = require("../src/solver/sbc-solver.js");

const FIXTURES = path.join(__dirname, "..", "..", "test", "fixtures");
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));

let highs;
const club = S.clubFromDump(fixture("club-121.json"));
const { players, links } = club;
const realChallenges = new Map(fixture("sbc-all-11.json").challenges.map((d) => {
  const c = S.challengeFromDump(d);
  return [c.id, c];
}));

test.before(async () => {
  highs = await loadHighs();
});

const opts = (o = {}) => S.solveOptions({ timeLimitS: 10, ...o });
const solve = (ch, ps = players, cost = {}, o = {}) => S.solve(highs, ch, ps, links, S.costOptions(cost), opts(o));

const F442 = [[0, 0, "GK"], [3, 3, "RB"], [4, 5, "RCB"], [6, 5, "LCB"], [7, 7, "LB"], [12, 12, "RM"],
  [13, 14, "RCM"], [15, 14, "LCM"], [16, 16, "LM"], [24, 25, "RS"], [26, 25, "LS"]];
function challenge(reqs, bricks = []) {
  return {
    id: 1, name: "test", formation: "f442", operation: "AND", layoutUnknown: false, squadPlayerIds: {},
    requirements: reqs,
    slots: F442.map(([pid, gen, name], i) => ({ index: i, positionId: pid, general: gen, name,
      type: bricks.includes(i) ? "BRICK" : "DEFAULT", brick: null }))
  };
}
const req = (key, scope, values, count = -1) => ({ key, scope, count, values });
const { K, GREATER, LOWER, EXACT } = S;

function assertValid(result, ch) {
  assert.ok(["optimal", "feasible"].includes(result.status), JSON.stringify(result).slice(0, 300));
  assert.ok(result.solutions.length);
  for (const sol of result.solutions) {
    assert.deepEqual(sol.validationErrors, []);
    assert.equal(sol.slots.length, ch.slots.filter((s) => s.type === "DEFAULT").length);
  }
}

// ---------- rules ----------

test("team rating matches the app's float-mode code on random squads", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let n = 0; n < 5000; n++) {
    const size = rnd() < 0.5 ? 10 : 11;
    const ratings = Array.from({ length: size }, () => 45 + Math.floor(rnd() * 55));
    const sum = ratings.reduce((a, r) => a + r, 0);
    const avg = Math.min(sum / 11, 99);
    const total = sum + ratings.filter((r) => r > avg).reduce((a, r) => a + r - avg, 0);
    const app = Math.min(Math.max(Math.floor(Math.floor(total + 0.5) / 11), 0), 99);
    assert.equal(S.teamRating(ratings), app, JSON.stringify(ratings));
  }
});

test("chemistry and rating match the filled fixture squad (app: rating 84, chem 17)", () => {
  const data = fixture("sbc-2x79-upgrade-filled.json");
  const ch = S.challengeFromDump(data);
  const assignment = new Map(data.squad.slots.filter((s) => s.item).map((s) => [s.i, S.playerFromItem(s.item)]));
  const chem = S.chemistry(assignment, ch.slots, links);
  assert.equal(chem.total, 17);
  for (const s of data.squad.slots.filter((x) => x.item)) assert.equal(chem.perSlot.get(s.i), s.accessors.chemistry);
  assert.equal(S.teamRating([...assignment.values()].map((p) => p.rating)), 84);
});

// ---------- solving real SBCs ----------

test("2x 79+ Upgrade (brick) solves to the same cost as the Python reference (1,920)", () => {
  const ch = S.challengeFromDump(fixture("sbc-2x79-upgrade-filled.json"));
  const r = solve(ch, players, {}, { relativeGap: 0 });
  assert.equal(r.status, "optimal");
  assertValid(r, ch);
  assert.equal(r.solutions[0].totalCost, 1920);
  assert.ok(r.solutions[0].slots.every((s) => s.slotIndex !== 0));
});

const EXPECTED = { 16: "infeasible", 42: "infeasible", 18: "solved", 25: "solved", 26: "solved", 27: "solved",
  28: "solved", 35: "infeasible", 37: "infeasible", 38: "solved", 39: "solved" };
for (const [id, want] of Object.entries(EXPECTED)) {
  test(`real SBC ${id} (${realChallenges.get(Number(id)).name}): ${want}`, () => {
    const ch = realChallenges.get(Number(id));
    const r = solve(ch);
    if (want === "infeasible") assert.equal(r.status, "infeasible");
    else assertValid(r, ch);
  });
}

// ---------- brute force on small pools ----------

function syntheticPool(seed, n) {
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  return Array.from({ length: n }, (_, i) => {
    const rating = 70 + Math.floor(rnd() * 21);
    return { id: i + 1, definitionId: 1000 + i, baseId: 1000 + i, name: `P${i}`, rating, rareflag: 0,
      tier: rating >= 75 ? 3 : 2, teamId: 1 + Math.floor(rnd() * 4), leagueId: 1 + Math.floor(rnd() * 3),
      nationId: 1 + Math.floor(rnd() * 4), positions: [[0, 3, 5, 7, 12, 14, 16, 25][Math.floor(rnd() * 8)]],
      tradable: true, loans: -1, limitedUse: false, owners: 1, groups: [], special: false, legend: false, hero: false,
      marketPrice: 200 + Math.floor(rnd() * 19800), inStorage: false, inAcademy: false, inEvolution: false,
      inUnassigned: false, inTransfer: false, inActiveSquad: false };
  });
}

function* combinations(arr, k, start = 0, prefix = []) {
  if (prefix.length === k) {
    yield prefix;
    return;
  }
  for (let i = start; i < arr.length; i++) yield* combinations(arr, k, i + 1, prefix.concat([arr[i]]));
}

for (let seed = 1; seed <= 6; seed++) {
  test(`team rating constraint matches brute force (seed ${seed})`, () => {
    const pool = syntheticPool(seed * 7919, 14);
    const target = 78 + (seed % 7);
    const ch = challenge([req(K.TEAM_RATING, GREATER, [target])]);
    const c = S.costOptions({ maxCost: 1e9 });
    let best = null;
    for (const combo of combinations(pool, 11)) {
      if (S.teamRating(combo.map((p) => p.rating)) >= target) {
        const cost = combo.reduce((a, p) => a + S.playerCost(p, c), 0);
        if (best === null || cost < best) best = cost;
      }
    }
    const r = S.solve(highs, ch, pool, new Map(), c, S.solveOptions({ relativeGap: 0 }));
    if (best === null) assert.equal(r.status, "infeasible");
    else assert.equal(r.solutions[0].totalCost, best);
  });
}

for (const [label, reqs] of [
  ["rating84", [req(K.TEAM_RATING, GREATER, [84])]],
  ["rating83+chem20", [req(K.TEAM_RATING, GREATER, [83]), req(K.CHEMISTRY_POINTS, GREATER, [20])]],
  ["chem25+each1", [req(K.CHEMISTRY_POINTS, GREATER, [25]), req(K.ALL_PLAYERS_CHEMISTRY_POINTS, GREATER, [1])]],
  ["PLx4+maxsame2+r82", [req(K.LEAGUE_ID, GREATER, [13], 4), req(K.SAME_NATION_COUNT, LOWER, [2]), req(K.TEAM_RATING, GREATER, [82])]],
  ["nations+clubs+gold", [req(K.NATION_COUNT, GREATER, [7]), req(K.CLUB_COUNT, LOWER, [8]), req(K.PLAYER_QUALITY, GREATER, [3])]],
  ["3x84+exact82", [req(K.PLAYER_MIN_OVR, GREATER, [84], 3), req(K.TEAM_RATING, EXACT, [82])]]
]) {
  test(`requirement mix on the real club: ${label}`, () => {
    const ch = challenge(reqs);
    assertValid(solve(ch), ch);
  });
}

// ---------- options ----------

const gold = () => challenge([req(K.PLAYER_QUALITY, GREATER, [3])]);

test("option: no tradeable players", () => {
  const r = solve(gold(), players, { allowTradeable: false });
  assert.ok(r.solutions[0].slots.every((s) => !s.tradable));
});

test("option: rating range", () => {
  const r = solve(gold(), players, { ratingMin: 80, ratingMax: 82 });
  assert.ok(r.solutions[0].slots.every((s) => s.rating >= 80 && s.rating <= 82));
});

test("option: keep squad players in their slots", () => {
  const golds = players.filter((p) => p.tier === 3 && !p.special && p.loans < 0).sort((a, b) => b.rating - a.rating);
  const keep = { 1: golds[0].id, 2: golds[1].id };
  const r = solve(gold(), players, { keep });
  const placed = Object.fromEntries(r.solutions[0].slots.map((s) => [s.slotIndex, s.playerId]));
  assert.equal(placed[1], keep[1]);
  assert.equal(placed[2], keep[2]);
  assert.deepEqual(r.solutions[0].validationErrors, []);
});

test("option: exclude active squad players", () => {
  const first = solve(gold()).solutions[0];
  const used = new Set(first.slots.map((s) => s.playerId));
  const marked = players.map((p) => (used.has(p.id) ? { ...p, inActiveSquad: true } : p));
  const again = solve(gold(), marked);
  assert.ok(again.solutions[0].slots.every((s) => !used.has(s.playerId)));
});

test("option: solve using rating uses no higher total rating than price", () => {
  const ch = challenge([req(K.TEAM_RATING, GREATER, [80])]);
  const byPrice = solve(ch).solutions[0];
  const byRating = solve(ch, players, {}, { solveUsing: "rating", relativeGap: 0 }).solutions[0];
  const total = (sol) => sol.slots.reduce((a, s) => a + s.rating, 0);
  assert.ok(total(byRating) <= total(byPrice));
  assert.deepEqual(byRating.validationErrors, []);
});

// ---------- custom bricks ----------

test("custom brick: solved around, and it earns chemistry", () => {
  const madrid = players.find((p) => p.teamId === 243);
  const ch = challenge([req(K.SAME_LEAGUE_COUNT, LOWER, [4]), req(K.SAME_CLUB_COUNT, GREATER, [3]),
    req(K.CLUB_COUNT, LOWER, [4]), req(K.NATION_COUNT, GREATER, [2]), req(K.PLAYER_QUALITY, GREATER, [3]),
    req(K.CHEMISTRY_POINTS, GREATER, [12])]);
  ch.slots[8] = { ...ch.slots[8], type: "CUSTOM_BRICK", brick: { ...madrid, id: 0, baseId: 0, rating: 0, positions: [23] } };
  const r = solve(ch);
  assertValid(r, ch);
  assert.ok(r.solutions[0].slots.every((s) => s.slotIndex !== 8));
});

// ---------- whole sets ----------

test("set: Leagues & Nations (3 challenges) uses each player once", () => {
  const chs = [25, 26, 27].map((id) => realChallenges.get(id));
  const r = S.solveSet(highs, chs, players, links, S.costOptions({}), S.solveOptions({ timeLimitS: 30 }));
  const ids = [];
  for (const [k, e] of r.challenges.entries()) {
    assert.equal(e.status, "solved", e.name);
    assert.deepEqual(e.solution.validationErrors, []);
    assert.equal(e.solution.slots.length, chs[k].slots.filter((s) => s.type === "DEFAULT").length);
    ids.push(...e.solution.slots.map((s) => s.playerId));
  }
  assert.equal(new Set(ids).size, ids.length);
});

test("set: impossible challenges are skipped, the rest filled", () => {
  const r = S.solveSet(highs, [35, 37, 38, 39].map((id) => realChallenges.get(id)), players, links,
    S.costOptions({}), S.solveOptions({ timeLimitS: 20 }));
  assert.equal(r.status, "partial");
  const st = Object.fromEntries(r.challenges.map((e) => [e.challengeId, e.status]));
  assert.equal(st[35], "infeasible");
  assert.equal(st[37], "infeasible");
  assert.equal(st[38], "solved");
  assert.equal(st[39], "solved");
});

test("handlers accept the extension's payloads", () => {
  const res = S.handleSolve(highs, { club: fixture("club-121.json"), sbc: fixture("sbc-2x79-upgrade-filled.json"),
    options: { maxSolutions: 1 } });
  assert.equal(res.status, "optimal");
  assert.equal(res.challenge.name, "2x 79+ Upgrade");
});

test("unpriced cards are estimated from the club's own prices at that rating", () => {
  // Mac Allister (84, SBC storage, no EA price): median of the club's 84-rated non-special cards.
  const mac = players.find((p) => p.name === "Mac Allister");
  const same = players.filter((p) => p.rating === 84 && !p.special && !p.inStorage && p.marketPrice > 0)
    .map((p) => p.marketPrice).sort((a, b) => a - b);
  assert.ok(same.length >= 5);
  assert.equal(S.fodderValue(mac), same[same.length >> 1]);
  assert.ok(S.fodderValue(mac) < 1500, `estimate ${S.fodderValue(mac)}`);
});

test("solve multiple times: returns the squads that are possible, not nothing", () => {
  // 5-player "exactly Bronze" SBC 3 times; the club has 10 bronze cards, so 2 of 3.
  const bronze = players.filter((p) => p.tier === 1).length;
  assert.equal(bronze, 10);
  const base = challenge([req(K.PLAYER_QUALITY, EXACT, [1])], [5, 6, 7, 8, 9, 10]);
  const copies = [0, 1, 2].map((k) => ({ ...base, id: 100 + k, name: `copy ${k + 1}` }));
  const r = S.solveSet(highs, copies, players, links, S.costOptions({ allowTradeable: true }), S.solveOptions({ timeLimitS: 20 }));
  const solved = r.challenges.filter((c) => c.status === "solved");
  assert.equal(solved.length, 2, JSON.stringify(r.challenges.map((c) => c.status)));
  assert.equal(r.status, "partial");
  const ids = solved.flatMap((c) => c.solution.slots.map((x) => x.playerId));
  assert.equal(new Set(ids).size, ids.length);
  for (const c of solved) assert.deepEqual(c.solution.validationErrors, []);
});
