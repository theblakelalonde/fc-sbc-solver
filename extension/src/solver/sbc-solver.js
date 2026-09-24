// In-extension SBC solver: a JavaScript port of solver-server/sbc_solver (the Python/CP-SAT
// reference implementation) that builds a mixed-integer linear program and solves it with
// HiGHS compiled to WebAssembly (vendor/highs.js, MIT). Runs in the extension's service
// worker; the same file loads in Node for tests (extension/test/solver.test.js).
//
// Game rules (rating, chemistry, requirement encodings) are documented in
// docs/webapp-internals.md; every returned squad is re-checked with checkChallenge below.
(function (root) {
  "use strict";

  // ---------- constants ----------

  // SBCEligibilityKey (CONFIRMED enum values)
  const K = {
    TEAM_STAR_RATING: 0, PLAYER_COUNT: 2, PLAYER_QUALITY: 3, SAME_NATION_COUNT: 4, SAME_LEAGUE_COUNT: 5,
    SAME_CLUB_COUNT: 6, NATION_COUNT: 7, LEAGUE_COUNT: 8, CLUB_COUNT: 9, NATION_ID: 10, LEAGUE_ID: 11,
    CLUB_ID: 12, SCOPE: 13, LEGEND_COUNT: 15, NUM_TROPHY_REQUIRED: 16, PLAYER_LEVEL: 17, PLAYER_RARITY: 18,
    TEAM_RATING: 19, PLAYER_COUNT_COMBINED: 21, PLAYER_RARITY_GROUP: 25, PLAYER_MIN_OVR: 26,
    PLAYER_EXACT_OVR: 27, PLAYER_MAX_OVR: 28, FIRST_OWNER_PLAYERS_COUNT: 30, PLAYER_TRADABILITY: 33,
    CHEMISTRY_POINTS: 35, ALL_PLAYERS_CHEMISTRY_POINTS: 36
  };
  const KEY_NAMES = Object.fromEntries(Object.entries(K).map(([k, v]) => [v, k]));
  const GREATER = 0, LOWER = 1, EXACT = 2;
  const SCOPE_NAMES = { 0: "min", 1: "max", 2: "exactly" };

  // General positions per formation (UTSquadFormationDTO.generalPositions), CONFIRMED from dumps.
  const FORMATION_POSITIONS = {
    f442: [0, 3, 5, 5, 7, 12, 14, 14, 16, 25, 25],
    f41212: [0, 3, 5, 5, 7, 10, 12, 16, 18, 25, 25],
    f343: [0, 5, 5, 5, 12, 14, 14, 16, 23, 25, 27],
    f4141: [0, 3, 5, 5, 7, 10, 12, 14, 14, 16, 25],
    f3142: [0, 5, 5, 5, 10, 12, 14, 14, 16, 25, 25],
    f451: [0, 3, 5, 5, 7, 12, 14, 16, 18, 18, 25],
    f532: [0, 3, 5, 5, 5, 7, 10, 14, 14, 25, 25],
    f5212: [0, 3, 5, 5, 5, 7, 14, 14, 18, 25, 25]
  };
  const POSITION_NAMES = { 0: "GK", 2: "RWB", 3: "RB", 5: "CB", 7: "LB", 8: "LWB", 10: "CDM", 12: "RM", 14: "CM",
    16: "LM", 18: "CAM", 21: "CF", 23: "RW", 25: "ST", 27: "LW" };

  const SQUAD_SIZE = 11;
  const MAX_RATING = 99;
  const NATION_THRESHOLDS = [2, 5, 8];
  const LEAGUE_THRESHOLDS = [3, 5, 8];
  const CLUB_THRESHOLDS = [2, 4, 7];
  const MAX_PLAYER_CHEM = 3;

  // ---------- data (dump JSON -> players / challenges) ----------

  function playerFromItem(item, { inStorage = false, pile = "club" } = {}) {
    const f = item.fields || {};
    const sd = item.staticData || {};
    const pr = item.predicates || {};
    const name = sd.knownAs && sd.knownAs !== "---" ? sd.knownAs : sd.name || String(f.definitionId);
    let tier = f.getTier;
    if (!Number.isInteger(tier) || tier <= 0) tier = pr.isGoldRating ? 3 : pr.isSilverRating ? 2 : 1;
    const market = Number.isInteger(f.getMarketAverage) ? f.getMarketAverage : -1;
    return {
      id: Number(f.id) || 0,
      definitionId: Number(f.definitionId) || 0,
      baseId: Number(f.databaseId || f.definitionId) || 0,
      name,
      rating: Number(f.rating) || 0,
      rareflag: Number(f.rareflag) || 0,
      tier,
      teamId: Number(f.teamId) || 0,
      leagueId: Number(f.leagueId) || 0,
      nationId: Number(f.nationId) || 0,
      positions: f.possiblePositions || f.basePossiblePositions || [],
      tradable: !!f.tradable,
      loans: f.loans === undefined ? -1 : Number(f.loans),
      limitedUse: !!f.limitedUseType || !!pr.isLimitedUse,
      owners: Number(f.owners) || 1,
      groups: f.groups || [],
      special: !!pr.isSpecial,
      legend: !!pr.isLegend,
      hero: !!pr.isLeagueHeroItem,
      marketPrice: market,
      inStorage,
      inAcademy: !!pr.isEnrolledInAcademy || !!pr.isActiveInAcademy,
      inEvolution: !!pr.isActiveInTimedEvolution,
      inUnassigned: pile === "unassigned",
      inTransfer: pile === "transfer",
      inActiveSquad: false
    };
  }

  function teamLinkMap(pairs) {
    const parent = new Map();
    const find = (a) => {
      if (!parent.has(a)) parent.set(a, a);
      while (parent.get(a) !== a) {
        parent.set(a, parent.get(parent.get(a)));
        a = parent.get(a);
      }
      return a;
    };
    for (const pair of pairs || []) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const a = find(Number(pair[0])), b = find(Number(pair[1]));
      if (a !== b) parent.set(Math.max(a, b), Math.min(a, b));
    }
    const links = new Map();
    for (const k of parent.keys()) links.set(k, find(k));
    return links;
  }

  // EA gives SBC-storage items no market price; storage holds duplicates of club players.
  function borrowMissingPrices(players) {
    const known = new Map();
    for (const p of players) if (p.marketPrice > 0) known.set(p.definitionId, p.marketPrice);
    return players.map((p) => (p.marketPrice <= 0 && known.has(p.definitionId) ? { ...p, marketPrice: known.get(p.definitionId) } : p));
  }

  function clubFromDump(data) {
    let players = (data.players || []).filter((i) => i && i.fields && i.fields.type === "player").map((i) => playerFromItem(i));
    players = players.concat((data.storage || []).filter(Boolean).map((i) => playerFromItem(i, { inStorage: true })));
    players = players.concat((data.unassigned || []).filter(Boolean).map((i) => playerFromItem(i, { pile: "unassigned" })));
    players = players.concat((data.transferDuplicates || []).filter(Boolean).map((i) => playerFromItem(i, { pile: "transfer" })));
    const active = new Set(((data.activeSquad || {}).ids || []).map(Number));
    if (active.size) players = players.map((p) => (active.has(p.id) ? { ...p, inActiveSquad: true } : p));
    players = borrowMissingPrices(players);
    const curve = ratingPriceCurve(players.filter((p) => !p.special && !p.inStorage).map((p) => [p.rating, p.marketPrice]));
    players = players.map((p) => (p.marketPrice > 0 ? p : { ...p, ratingEstimate: curve(p.rating) }));
    return { players, links: teamLinkMap(data.teamLinks || []) };
  }

  function challengeFromDump(data) {
    const ch = data.challenge;
    const requirements = [];
    for (const r of data.requirements || []) {
      let kv = ((r.raw || {}).kvPairs || {}).__collection || {};
      if (!Object.keys(kv).length && r.firstKey !== undefined && r.firstKey !== null) kv = { [r.firstKey]: r.firstValue || [] };
      for (const [key, values] of Object.entries(kv)) {
        requirements.push({
          key: Number(key),
          scope: r.scope === undefined ? GREATER : Number(r.scope),
          count: r.count === undefined ? -1 : Number(r.count),
          values: (values || []).map(Number)
        });
      }
    }
    let slots = [];
    const squadPlayerIds = {};
    for (const s of ((data.squad || {}).slots) || []) {
      const pos = s.position;
      if (!pos) continue;
      const type = (s.requirement || {}).playerType || "DEFAULT";
      slots.push({
        index: Number(s.i),
        positionId: Number(pos.id),
        general: Number(pos.typeId),
        name: pos.name || "",
        type,
        brick: type === "CUSTOM_BRICK" && s.item ? playerFromItem(s.item) : null
      });
      if (s.item && type === "DEFAULT") squadPlayerIds[Number(s.i)] = Number(s.item.fields.id);
    }
    let layoutUnknown = false;
    if (!slots.length) {
      // Never loaded (loading marks a challenge "In Progress"): use formation positions; a brick
      // challenge can have several bricks, so without its learned layout it can't be priced.
      const positions = data.formationPositions || FORMATION_POSITIONS[ch.formation || ""];
      if (positions && positions.length === 11) {
        slots = positions.map((g, i) => ({ index: i, positionId: g, general: g, name: POSITION_NAMES[g] || "?", type: "DEFAULT", brick: null }));
      } else {
        slots = Array.from({ length: 11 }, (_, i) => ({ index: i, positionId: -1, general: -1, name: "?", type: "DEFAULT", brick: null }));
      }
      layoutUnknown = !!data.brickChallenge;
    }
    const summary = (data.squad || {}).summary || {};
    const filled = Object.keys(squadPlayerIds).length > 0;
    return {
      id: Number(ch.id),
      name: ch.name || "",
      formation: ch.formation || "",
      operation: ch.eligibilityOperation || "AND",
      requirements,
      slots,
      layoutUnknown,
      appRating: filled ? summary.getRating : null,
      appChemistry: filled ? summary.getChemistry : null,
      squadPlayerIds
    };
  }

  const describeReq = (r) =>
    `${KEY_NAMES[r.key] || `KEY_${r.key}`} ${SCOPE_NAMES[r.scope] ?? r.scope} [${r.values.join(",")}]${r.count < 0 ? "" : ` count=${r.count}`}`;
  const isOpen = (s) => s.type === "DEFAULT";

  // ---------- costs and options ----------

  // Price estimate by rating for cards EA doesn't price (SBC storage, some untradeables): the
  // median EA price of your own non-special cards at that rating (min. 5 cards). Ratings without
  // enough cards use the prior curve below, scaled by how your club's prices compare to it.
  const RATING_PRIOR = { 75: 400, 76: 450, 77: 500, 78: 600, 79: 650, 80: 700, 81: 700, 82: 750, 83: 950,
    84: 1200, 85: 2500, 86: 5000, 87: 9000, 88: 15000, 89: 22000, 90: 35000 };
  const RATING_MIN_SAMPLES = 5;
  const ratingPrior = (r) => (r < 75 ? 150 + r : RATING_PRIOR[r] ?? 50000);

  // samples: [rating, price][] -> (rating) => estimate
  function ratingPriceCurve(samples) {
    const byRating = new Map();
    for (const [r, p] of samples) if (r > 0 && p > 0) byRating.set(r, (byRating.get(r) || []).concat(p));
    const median = new Map();
    for (const [r, ps] of byRating) {
      if (ps.length < RATING_MIN_SAMPLES) continue;
      ps.sort((a, b) => a - b);
      median.set(r, ps[ps.length >> 1]);
    }
    const ratios = [...median].map(([r, m]) => m / ratingPrior(r)).sort((a, b) => a - b);
    const scale = ratios.length ? ratios[ratios.length >> 1] : 1;
    return (r) => median.get(r) ?? Math.max(1, Math.round(ratingPrior(r) * scale));
  }
  const RARE_PENALTY = 5000; // "only use rares if required"
  const STORAGE_FIRST_FACTOR = 0.02; // "use storage first"

  // Unpriced card: the club-calibrated estimate set by clubFromDump, else the prior curve.
  function fodderValue(p) {
    const base = p.ratingEstimate > 0 ? p.ratingEstimate : ratingPrior(p.rating);
    return base * (p.special ? 5 : 1);
  }
  const badgePrice = (p) => (p.marketPrice > 0 ? p.marketPrice : fodderValue(p));

  // Maps the extension's settings / auto-complete options (same names as the Python server).
  function costOptions(o = {}) {
    const num = (k, d) => (o[k] === undefined || o[k] === null || o[k] === "" ? d : Number(o[k]));
    return {
      untradeableFactor: num("untradeableFactor", 0.3),
      storageFactor: 0.3,
      overrides: new Map(Object.entries(o.overrides || {}).map(([k, v]) => [Number(k), Number(v)])),
      locked: new Set((o.locked || []).map(Number)),
      allowSpecial: !!o.allowSpecial,
      maxCost: num("maxCost", 50000) > 0 ? num("maxCost", 50000) : Infinity, // 0 / empty = no limit
      maxRating: num("maxRating", null),
      allowTradeable: o.allowTradeable !== false,
      ignoreExclusions: !!o.ignoreExclusions,
      storageFirst: !!o.storageFirst,
      raresOnlyIfRequired: o.raresOnlyIfRequired !== false,
      useUnassigned: o.useUnassigned !== false,
      useTransferDuplicates: o.useTransferDuplicates !== false,
      ratingMin: num("ratingMin", 0),
      ratingMax: num("ratingMax", 99),
      specialRatingMin: num("specialRatingMin", 0),
      specialRatingMax: num("specialRatingMax", 99),
      keep: new Map(Object.entries(o.keep || {}).map(([k, v]) => [Number(k), Number(v)])),
      excludeActiveSquad: o.excludeActiveSquad !== false
    };
  }

  function playerCost(p, opts) {
    if (opts.overrides.has(p.id)) return Math.max(0, Math.round(opts.overrides.get(p.id)));
    let value = p.marketPrice > 0 ? p.marketPrice : fodderValue(p);
    if (p.inStorage) value *= opts.storageFirst ? STORAGE_FIRST_FACTOR : opts.storageFactor;
    else if (!p.tradable) value *= opts.untradeableFactor;
    if (opts.raresOnlyIfRequired && p.rareflag === 1) value += RARE_PENALTY;
    return Math.round(value);
  }

  function exclusionReason(p, opts) {
    if ([...opts.keep.values()].includes(p.id)) return null;
    if (p.loans >= 0 || p.limitedUse) return "loan";
    if (p.inAcademy || p.inEvolution) return "evolution";
    if (p.inActiveSquad && opts.excludeActiveSquad) return "active squad";
    if (p.inUnassigned && !opts.useUnassigned) return "unassigned";
    if (p.inTransfer && !opts.useTransferDuplicates) return "transfer list";
    if (opts.overrides.has(p.id)) return null;
    if (p.special && !opts.allowSpecial) return "special";
    if (p.tradable && !opts.allowTradeable) return "tradeable";
    const [lo, hi] = p.special ? [opts.specialRatingMin, opts.specialRatingMax] : [opts.ratingMin, opts.ratingMax];
    if (p.rating < lo || p.rating > hi) return "rating range";
    if (opts.ignoreExclusions) return null;
    if (opts.locked.has(p.id)) return "locked";
    if (opts.maxRating !== null && p.rating > opts.maxRating) return "rating";
    if (p.marketPrice > opts.maxCost) return "value";
    return null;
  }

  // ---------- game rules (independent check of every squad) ----------

  function ratingScaled(ratings) {
    const total = ratings.reduce((a, r) => a + r, 0);
    return SQUAD_SIZE * total + ratings.reduce((a, r) => a + Math.max(0, SQUAD_SIZE * r - total), 0);
  }

  // App float mode (UTSquadEntity._calculateRating): floor(Math.round(S + E) / 11).
  function teamRating(ratings) {
    const scaled = ratingScaled(ratings);
    const rounded = Math.floor((2 * scaled + SQUAD_SIZE) / (2 * SQUAD_SIZE));
    return Math.min(99, Math.floor(rounded / SQUAD_SIZE));
  }
  const teamRatingBounds = (t) => [SQUAD_SIZE * SQUAD_SIZE * t - 5, SQUAD_SIZE * SQUAD_SIZE * t + SQUAD_SIZE * SQUAD_SIZE - 6];

  const thresholdPoints = (count, th) => th.filter((t) => count >= t).length;
  const canonicalClub = (teamId, links) => (links.has(teamId) ? links.get(teamId) : teamId);
  const inPosition = (p, slot) => p.positions.includes(slot.general);
  const bricksOf = (slots) => slots.filter((s) => s.brick).map((s) => s.brick);

  function count(values) {
    const m = new Map();
    for (const v of values) m.set(v, (m.get(v) || 0) + 1);
    return m;
  }

  // Custom bricks add to link counts and earn chem themselves (CONFIRMED: Madrid Dreams 17 vs 16).
  function chemistry(assignment, slots, links) {
    const bySlot = new Map(slots.map((s) => [s.index, s]));
    const contributing = [...assignment].filter(([i, p]) => inPosition(p, bySlot.get(i))).map(([, p]) => p).concat(bricksOf(slots));
    const nations = count(contributing.map((p) => p.nationId));
    const leagues = count(contributing.map((p) => p.leagueId));
    const clubs = count(contributing.map((p) => canonicalClub(p.teamId, links)));
    const pts = (p) => Math.min(MAX_PLAYER_CHEM, thresholdPoints(nations.get(p.nationId) || 0, NATION_THRESHOLDS)
      + thresholdPoints(leagues.get(p.leagueId) || 0, LEAGUE_THRESHOLDS)
      + thresholdPoints(clubs.get(canonicalClub(p.teamId, links)) || 0, CLUB_THRESHOLDS));
    const perSlot = new Map();
    for (const [i, p] of assignment) perSlot.set(i, inPosition(p, bySlot.get(i)) ? pts(p) : 0);
    for (const s of slots) if (s.brick) perSlot.set(s.index, pts(s.brick));
    let total = 0;
    for (const v of perSlot.values()) total += v;
    return { perSlot, total };
  }

  const compare = (v, scope, t) => (scope === GREATER ? v >= t : scope === LOWER ? v <= t : v === t);

  const PER_PLAYER_KEYS = new Set([K.NATION_ID, K.LEAGUE_ID, K.CLUB_ID, K.PLAYER_RARITY, K.PLAYER_RARITY_GROUP,
    K.PLAYER_QUALITY, K.PLAYER_LEVEL, K.PLAYER_MIN_OVR, K.PLAYER_EXACT_OVR, K.PLAYER_MAX_OVR]);
  const SQUAD_KEYS = new Set([K.TEAM_RATING, K.CHEMISTRY_POINTS, K.ALL_PLAYERS_CHEMISTRY_POINTS, K.SAME_NATION_COUNT,
    K.SAME_LEAGUE_COUNT, K.SAME_CLUB_COUNT, K.NATION_COUNT, K.LEAGUE_COUNT, K.CLUB_COUNT,
    K.FIRST_OWNER_PLAYERS_COUNT, K.LEGEND_COUNT, K.PLAYER_COUNT]);

  function playerMatches(r, p, links) {
    const v = r.values;
    switch (r.key) {
      case K.NATION_ID: return v.includes(p.nationId);
      case K.LEAGUE_ID: return v.includes(p.leagueId);
      case K.CLUB_ID: return v.map((t) => canonicalClub(t, links)).includes(canonicalClub(p.teamId, links));
      case K.PLAYER_RARITY: return v.includes(p.rareflag);
      case K.PLAYER_RARITY_GROUP: return v.some((g) => p.groups.includes(g));
      case K.PLAYER_LEVEL: return p.tier === v[0];
      case K.PLAYER_QUALITY: return r.count < 0 ? compare(p.tier, r.scope, v[0]) : p.tier === v[0];
      case K.PLAYER_MIN_OVR: return p.rating >= v[0];
      case K.PLAYER_EXACT_OVR: return p.rating === v[0];
      case K.PLAYER_MAX_OVR: return p.rating <= v[0];
      default: throw new Error(`not a per-player key ${r.key}`);
    }
  }

  function unsupported(ch) {
    const out = ch.requirements.filter((r) => !PER_PLAYER_KEYS.has(r.key) && !SQUAD_KEYS.has(r.key)).map(describeReq);
    if (ch.operation !== "AND" && ch.requirements.length > 1) out.push(`eligibilityOperation ${ch.operation}`);
    for (const s of ch.slots) {
      if (s.type !== "DEFAULT" && s.type !== "BRICK" && !(s.type === "CUSTOM_BRICK" && s.brick)) out.push(`slot ${s.index} type ${s.type}`);
    }
    if (ch.layoutUnknown) out.push("brick layout unknown: open this challenge once so its bricks are learned");
    const chem = ch.requirements.some((r) => r.key === K.CHEMISTRY_POINTS || r.key === K.ALL_PLAYERS_CHEMISTRY_POINTS);
    if (chem && ch.slots.some((s) => s.general < 0)) out.push("formation positions unknown (open this SBC's squad screen once)");
    for (const r of ch.requirements) {
      if ((r.key === K.CHEMISTRY_POINTS || r.key === K.ALL_PLAYERS_CHEMISTRY_POINTS) && r.scope !== GREATER) out.push(describeReq(r));
    }
    return out;
  }

  // Whether custom bricks count toward a requirement is unconfirmed: minimums from players alone,
  // maximums with the bricks included.
  function compareWithBricks(onlyPlayers, withBricks, scope, t) {
    if (scope === GREATER) return onlyPlayers >= t;
    if (scope === LOWER) return withBricks <= t;
    return onlyPlayers >= t && withBricks <= t;
  }

  function groupFn(key, links) {
    if (key === K.SAME_NATION_COUNT || key === K.NATION_COUNT) return (p) => p.nationId;
    if (key === K.SAME_LEAGUE_COUNT || key === K.LEAGUE_COUNT) return (p) => p.leagueId;
    return (p) => canonicalClub(p.teamId, links);
  }

  function checkRequirement(r, assignment, slots, links) {
    const players = [...assignment.values()];
    const extra = bricksOf(slots);
    const t = r.values.length ? r.values[0] : 0;
    const k = r.key;
    if (PER_PLAYER_KEYS.has(k)) {
      if (r.count < 0) return players.every((p) => playerMatches(r, p, links));
      const n = players.filter((p) => playerMatches(r, p, links)).length;
      return compareWithBricks(n, n + extra.filter((b) => playerMatches(r, b, links)).length, r.scope, r.count);
    }
    if (k === K.TEAM_RATING) return compare(teamRating(players.map((p) => p.rating)), r.scope, t);
    if (k === K.CHEMISTRY_POINTS) return compare(chemistry(assignment, slots, links).total, r.scope, t);
    if (k === K.ALL_PLAYERS_CHEMISTRY_POINTS) {
      const per = chemistry(assignment, slots, links).perSlot;
      return [...assignment.keys()].every((i) => compare(per.get(i), r.scope, t));
    }
    if (k === K.SAME_NATION_COUNT || k === K.SAME_LEAGUE_COUNT || k === K.SAME_CLUB_COUNT) {
      const fn = groupFn(k, links);
      const largest = Math.max(0, ...count(players.map(fn)).values());
      const largestAll = Math.max(0, ...count(players.concat(extra).map(fn)).values());
      return compareWithBricks(largest, largestAll, r.scope, t);
    }
    if (k === K.NATION_COUNT || k === K.LEAGUE_COUNT || k === K.CLUB_COUNT) {
      const fn = groupFn(k, links);
      return compareWithBricks(new Set(players.map(fn)).size, new Set(players.concat(extra).map(fn)).size, r.scope, t);
    }
    if (k === K.FIRST_OWNER_PLAYERS_COUNT) return compare(players.filter((p) => p.owners === 1).length, r.scope, t);
    if (k === K.LEGEND_COUNT) return compare(players.filter((p) => p.legend).length, r.scope, t);
    if (k === K.PLAYER_COUNT) return compare(players.length, r.scope, t);
    throw new Error(`unsupported requirement ${describeReq(r)}`);
  }

  function checkChallenge(ch, assignment, links) {
    const failures = [];
    const open = ch.slots.filter(isOpen).map((s) => s.index).sort((a, b) => a - b);
    const filled = [...assignment.keys()].sort((a, b) => a - b);
    if (JSON.stringify(open) !== JSON.stringify(filled)) failures.push(`slots filled ${filled} != open slots ${open}`);
    const players = [...assignment.values()];
    if (new Set(players.map((p) => p.id)).size !== players.length) failures.push("same item used twice");
    if (new Set(players.map((p) => p.baseId)).size !== players.length) failures.push("same player used twice");
    for (const r of ch.requirements) if (!checkRequirement(r, assignment, ch.slots, links)) failures.push(describeReq(r));
    return failures;
  }

  // ---------- MILP model (CPLEX LP text for HiGHS) ----------

  class Lp {
    constructor() {
      this.types = new Map(); // name -> "bin" | "int" | "cont"
      this.bounds = new Map(); // name -> [lb, ub]
      this.rows = [];
      this.objective = new Map();
    }
    v(name, type = "bin", lb = 0, ub = 1) {
      if (!this.types.has(name)) {
        this.types.set(name, type);
        if (type !== "bin") this.bounds.set(name, [lb, ub]);
      }
      return name;
    }
    // terms: [[coef, name], ...]; sense: ">=", "<=", "="
    row(terms, sense, rhs) {
      const merged = new Map();
      for (const [c, n] of terms) if (c) merged.set(n, (merged.get(n) || 0) + c);
      const t = [...merged].filter(([, c]) => c);
      if (!t.length) {
        const ok = sense === ">=" ? 0 >= rhs : sense === "<=" ? 0 <= rhs : rhs === 0;
        if (!ok) this.infeasible = true;
        return;
      }
      this.rows.push([t, sense, rhs]);
    }
    obj(coef, name) {
      if (coef) this.objective.set(name, (this.objective.get(name) || 0) + coef);
    }
    text() {
      const fmt = (terms) => {
        const parts = terms.map(([n, c]) => `${c < 0 ? "-" : "+"} ${Math.abs(c)} ${n}`);
        const lines = [];
        for (let i = 0; i < parts.length; i += 12) lines.push(" " + parts.slice(i, i + 12).join(" "));
        return lines.join("\n");
      };
      const out = ["Minimize", " obj:"];
      const objTerms = [...this.objective].filter(([, c]) => c);
      out.push(objTerms.length ? fmt(objTerms) : ` 0 ${this.types.keys().next().value}`);
      out.push("Subject To");
      this.rows.forEach(([t, sense, rhs], i) => out.push(` r${i}:\n${fmt(t)} ${sense} ${rhs}`));
      if (this.infeasible) {
        const any = this.types.keys().next().value;
        out.push(` rinf: + 1 ${any} >= 2`);
        this.types.set(any, "bin");
      }
      out.push("Bounds");
      for (const [n, [lb, ub]] of this.bounds) out.push(` ${lb} <= ${n} <= ${ub}`);
      const bins = [...this.types].filter(([, t]) => t === "bin").map(([n]) => n);
      const ints = [...this.types].filter(([, t]) => t === "int").map(([n]) => n);
      if (bins.length) {
        out.push("Binaries");
        for (let i = 0; i < bins.length; i += 20) out.push(" " + bins.slice(i, i + 20).join(" "));
      }
      if (ints.length) {
        out.push("Generals");
        for (let i = 0; i < ints.length; i += 20) out.push(" " + ints.slice(i, i + 20).join(" "));
      }
      out.push("End");
      return out.join("\n");
    }
  }

  const COST_SCALE = 1200; // cost dominates; ratings (and position) only break ties
  const RATING_SCALE = 1e6; // "solve using rating"
  const OOP_PENALTY = 10;
  const BIG = SQUAD_SIZE * MAX_RATING; // 1089

  // Variables and constraints for one challenge inside an Lp (several share one Lp for sets).
  class ChallengeModel {
    constructor(lp, tag, ch, pool, links, costs, { fixed = new Map(), objective = "price", ratingSum = null } = {}) {
      Object.assign(this, { lp, tag, ch, pool, links, costs, fixed, objective, ratingSum });
      this.openSlots = ch.slots.filter(isOpen);
      this.bricks = bricksOf(ch.slots);
      this.slotTypes = count(this.openSlots.map((s) => s.general));
      this.y = pool.map((p, i) => lp.v(`y${tag}_${i}`));
      this.x = new Map(); // `${i}|${gen}` -> var
      this.xIn = pool.map(() => []); // in-position x vars per player
      this.chem = [];
      this.brickChem = [];
      this.objTerms = [];
      this.build();
    }

    idx(p) {
      if (!this.index) this.index = new Map(this.pool.map((q, i) => [q.id, i]));
      return this.index.get(p.id);
    }

    build() {
      const { lp, y, pool } = this;
      lp.row(y.map((v) => [1, v]), "=", this.openSlots.length);
      const byBase = new Map();
      pool.forEach((p, i) => byBase.set(p.baseId, (byBase.get(p.baseId) || []).concat(i)));
      for (const members of byBase.values()) if (members.length > 1) lp.row(members.map((i) => [1, y[i]]), "<=", 1);
      for (const p of this.fixed.values()) lp.row([[1, y[this.idx(p)]]], "=", 1);

      const needsChem = this.ch.requirements.some((r) => r.key === K.CHEMISTRY_POINTS || r.key === K.ALL_PLAYERS_CHEMISTRY_POINTS);
      if (needsChem) {
        this.buildAssignment();
        this.buildChemistry();
      }
      for (const r of this.ch.requirements) this.addRequirement(r);

      pool.forEach((p, i) => {
        const w = this.objective === "rating"
          ? p.rating * RATING_SCALE + Math.min(this.costs.get(p.id), RATING_SCALE - 1)
          : this.costs.get(p.id) * COST_SCALE + p.rating;
        this.objTerms.push([w + OOP_PENALTY, y[i]]);
      });
      if (this.x.size) this.xIn.forEach((vars) => vars.forEach((v) => this.objTerms.push([-OOP_PENALTY, v])));
    }

    buildAssignment() {
      const { lp, y, pool } = this;
      const minEach = Math.max(0, ...this.ch.requirements.filter((r) => r.key === K.ALL_PLAYERS_CHEMISTRY_POINTS).map((r) => r.values[0]));
      const byType = new Map();
      pool.forEach((p, i) => {
        const row = [];
        for (const gen of this.slotTypes.keys()) {
          const ok = p.positions.includes(gen);
          if (minEach >= 1 && !ok) continue;
          const v = lp.v(`x${this.tag}_${i}_${gen}`);
          this.x.set(`${i}|${gen}`, v);
          row.push([1, v]);
          byType.set(gen, (byType.get(gen) || []).concat([[1, v]]));
          if (ok) this.xIn[i].push(v);
        }
        row.push([-1, y[i]]);
        lp.row(row, "=", 0);
      });
      for (const [gen, capacity] of this.slotTypes) lp.row(byType.get(gen) || [], "=", capacity);
      const bySlot = new Map(this.openSlots.map((s) => [s.index, s]));
      for (const [si, p] of this.fixed) {
        const v = this.x.get(`${this.idx(p)}|${bySlot.get(si).general}`);
        if (v) lp.row([[1, v]], "=", 1);
        else lp.row([[1, y[this.idx(p)]]], "=", 0); // kept player can't stand there: infeasible
      }
    }

    buildChemistry() {
      const { lp, pool, links } = this;
      const contrib = (i) => this.xIn[i].map((v) => [1, v]);
      const kinds = [
        ["n", (p) => p.nationId, NATION_THRESHOLDS],
        ["l", (p) => p.leagueId, LEAGUE_THRESHOLDS],
        ["c", (p) => canonicalClub(p.teamId, links), CLUB_THRESHOLDS]
      ];
      const points = new Map(); // `${kind}|${group}` -> [[1, levelVar], ...]
      for (const [kind, key, thresholds] of kinds) {
        const groups = new Map();
        pool.forEach((p, i) => groups.set(key(p), (groups.get(key(p)) || []).concat(i)));
        const brickLinks = count(this.bricks.map(key));
        for (const [g, members] of groups) {
          const extra = brickLinks.get(g) || 0;
          const levels = [];
          for (const t of thresholds) {
            if (t > members.length + extra) break;
            const b = lp.v(`l${this.tag}_${kind}${String(g).replace(/-/g, "m")}_${t}`);
            // sum(contrib) + extra >= t * b
            lp.row(members.flatMap(contrib).concat([[-t, b]]), ">=", -extra);
            levels.push([1, b]);
          }
          points.set(`${kind}|${g}`, levels);
        }
      }
      const pointTerms = (p) => kinds.flatMap(([kind, key]) => points.get(`${kind}|${key(p)}`) || []);
      this.pointTerms = pool.map(pointTerms);
      pool.forEach((p, i) => {
        const c = lp.v(`h${this.tag}_${i}`, "int", 0, MAX_PLAYER_CHEM);
        lp.row([[1, c], ...this.pointTerms[i].map(([co, v]) => [-co, v])], "<=", 0);
        lp.row([[1, c], ...contrib(i).map(([, v]) => [-MAX_PLAYER_CHEM, v])], "<=", 0);
        this.chem.push(c);
      });
      // Custom bricks earn chem from the same link counts.
      this.bricks.forEach((b, k) => {
        let constant = 0;
        const terms = [];
        for (const [kind, key, thresholds] of kinds) {
          const levels = points.get(`${kind}|${key(b)}`);
          if (levels) terms.push(...levels);
          else constant += thresholdPoints(this.bricks.filter((o) => key(o) === key(b)).length, thresholds);
        }
        const c = lp.v(`hb${this.tag}_${k}`, "int", 0, MAX_PLAYER_CHEM);
        lp.row([[1, c], ...terms.map(([co, v]) => [-co, v])], "<=", constant);
        this.brickChem.push(c);
      });
    }

    compareWithBricks(terms, brickHits, scope, target) {
      if (scope === GREATER || scope === EXACT) this.lp.row(terms, ">=", target);
      if (scope === LOWER || scope === EXACT) this.lp.row(terms, "<=", target - brickHits);
    }

    addRequirement(r) {
      const { lp, y, pool, links } = this;
      const k = r.key;
      const t = r.values.length ? r.values[0] : 0;
      const cmp = (terms, scope, target) => {
        if (scope === GREATER) lp.row(terms, ">=", target);
        else if (scope === LOWER) lp.row(terms, "<=", target);
        else lp.row(terms, "=", target);
      };
      if (PER_PLAYER_KEYS.has(k)) {
        if (r.count < 0) {
          pool.forEach((p, i) => {
            if (!playerMatches(r, p, links)) lp.row([[1, y[i]]], "=", 0);
          });
        } else {
          const terms = pool.map((p, i) => (playerMatches(r, p, links) ? [1, y[i]] : null)).filter(Boolean);
          const hits = this.bricks.filter((b) => playerMatches(r, b, links)).length;
          this.compareWithBricks(terms, hits, r.scope, r.count);
        }
      } else if (k === K.TEAM_RATING) {
        if (this.ratingSum === null) this.addTeamRating(r.scope, t);
        else this.addTeamRatingAtSum(r.scope, t, this.ratingSum);
      } else if (k === K.CHEMISTRY_POINTS) {
        lp.row(this.chem.concat(this.brickChem).map((v) => [1, v]), ">=", t);
      } else if (k === K.ALL_PLAYERS_CHEMISTRY_POINTS) {
        pool.forEach((p, i) => lp.row([...this.pointTerms[i], [-t, y[i]]], ">=", 0));
      } else if (k === K.SAME_NATION_COUNT || k === K.SAME_LEAGUE_COUNT || k === K.SAME_CLUB_COUNT) {
        this.addSameGroup(k, r.scope, t);
      } else if (k === K.NATION_COUNT || k === K.LEAGUE_COUNT || k === K.CLUB_COUNT) {
        this.addDistinctGroups(k, r.scope, t);
      } else if (k === K.FIRST_OWNER_PLAYERS_COUNT) {
        cmp(pool.map((p, i) => (p.owners === 1 ? [1, y[i]] : null)).filter(Boolean), r.scope, t);
      } else if (k === K.LEGEND_COUNT) {
        cmp(pool.map((p, i) => (p.legend ? [1, y[i]] : null)).filter(Boolean), r.scope, t);
      } else if (k === K.PLAYER_COUNT) {
        cmp(y.map((v) => [1, v]), r.scope, t);
      }
    }

    // Team rating = floor(round(S + E) / 11), S = sum of ratings, E = sum max(0, r - S/11), with
    // empty/brick slots counting 0 and n = 11. Scaled by 11: 11*S + sum over rating values v of
    // cnt_v * max(0, 11v - S), bounded by teamRatingBounds. Per rating value v:
    //   gap_v = max(0, 11v - S) via a binary z_v; cnt_v * gap_v via one binary per pick.
    // For "min rating" only upper bounds on the excess are needed (fewer constraints).
    addTeamRating(scope, target) {
      const { lp, y, pool, tag } = this;
      const n = SQUAD_SIZE;
      const S = lp.v(`S${tag}`, "cont", 0, n * MAX_RATING);
      lp.row([[1, S], ...pool.map((p, i) => [-p.rating, y[i]])], "=", 0);
      const exact = scope !== GREATER;
      const byRating = new Map();
      pool.forEach((p, i) => byRating.set(p.rating, (byRating.get(p.rating) || []).concat(i)));
      const excess = [];
      for (const [v, members] of byRating) {
        const gap = lp.v(`g${tag}_${v}`, "cont", 0, n * v);
        const z = lp.v(`z${tag}_${v}`);
        lp.row([[1, gap], [1, S], [BIG, z]], "<=", n * v + BIG); // gap <= 11v - S + BIG(1 - z)
        lp.row([[1, gap], [-(n * v), z]], "<=", 0); // gap <= 11v * z
        if (exact) {
          lp.row([[1, gap], [1, S]], ">=", n * v); // gap >= 11v - S
        }
        const picks = [];
        for (let k = 0; k < Math.min(n, members.length); k++) picks.push(lp.v(`u${tag}_${v}_${k}`));
        for (let k = 1; k < picks.length; k++) lp.row([[1, picks[k]], [-1, picks[k - 1]]], "<=", 0);
        lp.row([...picks.map((u) => [1, u]), ...members.map((i) => [-1, y[i]])], "=", 0);
        picks.forEach((u, k) => {
          const w = lp.v(`w${tag}_${v}_${k}`, "cont", 0, n * v);
          lp.row([[1, w], [-1, gap]], "<=", 0); // w <= gap
          lp.row([[1, w], [-(n * v), u]], "<=", 0); // w <= 11v * u
          if (exact) lp.row([[1, w], [-1, gap], [-(n * v), u]], ">=", -(n * v)); // w >= gap - 11v(1 - u)
          excess.push(w);
        });
      }
      const [low, high] = teamRatingBounds(target);
      const scaled = [[n, S], ...excess.map((w) => [1, w])];
      if (scope === GREATER || scope === EXACT) lp.row(scaled, ">=", low);
      if (scope === LOWER || scope === EXACT) lp.row(scaled, "<=", high);
    }

    // With the rating sum fixed at S, each player's excess max(0, 11r - S) is a constant, so the
    // team-rating condition becomes two linear rows (see solveRatingBySum).
    addTeamRatingAtSum(scope, target, S) {
      const { lp, y, pool } = this;
      const n = SQUAD_SIZE;
      lp.row(pool.map((p, i) => [p.rating, y[i]]), "=", S);
      const excess = pool.map((p, i) => [Math.max(0, n * p.rating - S), y[i]]);
      const [low, high] = teamRatingBounds(target);
      if (scope === GREATER || scope === EXACT) lp.row(excess, ">=", low - n * S);
      if (scope === LOWER || scope === EXACT) lp.row(excess, "<=", high - n * S);
    }

    groups(key) {
      const fn = groupFn(key, this.links);
      const out = new Map();
      this.pool.forEach((p, i) => out.set(fn(p), (out.get(fn(p)) || []).concat(i)));
      return out;
    }

    addSameGroup(key, scope, t) {
      const { lp, y } = this;
      const groups = this.groups(key);
      const brickGroups = count(this.bricks.map(groupFn(key, this.links)));
      if (scope === LOWER || scope === EXACT) {
        for (const [g, members] of groups) lp.row(members.map((i) => [1, y[i]]), "<=", t - (brickGroups.get(g) || 0));
        for (const [g, nb] of brickGroups) if (!groups.has(g) && nb > t) lp.infeasible = true;
      }
      if (scope === GREATER || scope === EXACT) {
        const hits = [];
        let j = 0;
        for (const [, members] of groups) {
          if (members.length < t) continue;
          const h = lp.v(`s${this.tag}_${key}_${j++}`);
          lp.row([...members.map((i) => [1, y[i]]), [-t, h]], ">=", 0);
          hits.push([1, h]);
        }
        lp.row(hits, ">=", 1);
      }
    }

    addDistinctGroups(key, scope, t) {
      const { lp, y } = this;
      const brickGroups = new Set(this.bricks.map(groupFn(key, this.links)));
      const used = [];
      let j = 0;
      for (const [g, members] of this.groups(key)) {
        const u = lp.v(`d${this.tag}_${key}_${j++}`);
        lp.row([[1, u], ...members.map((i) => [-1, y[i]])], "<=", 0);
        members.forEach((i) => lp.row([[1, u], [-1, y[i]]], ">=", 0));
        used.push([g, u]);
      }
      if (scope === GREATER || scope === EXACT) lp.row(used.map(([, u]) => [1, u]), ">=", t);
      if (scope === LOWER || scope === EXACT) {
        lp.row(used.filter(([g]) => !brickGroups.has(g)).map(([, u]) => [1, u]), "<=", t - brickGroups.size);
      }
    }

    // Slot index -> player from a solution's column values.
    extract(values) {
      const on = (name) => (values[name] ?? 0) > 0.5;
      const chosen = this.pool.filter((p, i) => on(this.y[i]));
      if (!this.x.size) return assignPositions(chosen, this.openSlots, this.fixed);
      const assignment = new Map(this.fixed);
      const kept = new Set([...this.fixed.values()].map((p) => p.id));
      const free = new Map();
      for (const s of this.openSlots) if (!this.fixed.has(s.index)) free.set(s.general, (free.get(s.general) || []).concat(s.index));
      for (const [key, v] of this.x) {
        if (!on(v)) continue;
        const [i, gen] = key.split("|").map(Number);
        const p = this.pool[i];
        if (kept.has(p.id)) continue;
        assignment.set(free.get(gen).shift(), p);
      }
      return assignment;
    }
  }

  // No chemistry requirement: place players to maximize how many are in position (bipartite
  // matching on in-position edges), kept players pinned to their slots.
  function assignPositions(players, slots, fixed = new Map()) {
    const kept = new Set([...fixed.values()].map((p) => p.id));
    const free = players.filter((p) => !kept.has(p.id));
    const open = slots.filter((s) => !fixed.has(s.index));
    const slotOwner = new Map();
    const tryAssign = (pi, seen) => {
      for (const s of open) {
        if (!inPosition(free[pi], s) || seen.has(s.index)) continue;
        seen.add(s.index);
        if (!slotOwner.has(s.index) || tryAssign(slotOwner.get(s.index), seen)) {
          slotOwner.set(s.index, pi);
          return true;
        }
      }
      return false;
    };
    free.forEach((_, pi) => tryAssign(pi, new Set()));
    const assignment = new Map(fixed);
    const placed = new Set(slotOwner.values());
    for (const [si, pi] of slotOwner) assignment.set(si, free[pi]);
    const rest = free.filter((_, pi) => !placed.has(pi));
    for (const s of open) if (!assignment.has(s.index)) assignment.set(s.index, rest.shift());
    return assignment;
  }

  // Keep only the cheapest players among those identical for these challenges (see Python
  // _prune_dominated): open slots + 11 per signature, distinct base ids.
  function pruneDominated(pool, challenges, links, costs, always = new Set()) {
    const keys = new Set(challenges.flatMap((c) => c.requirements.map((r) => r.key)));
    const chem = keys.has(K.CHEMISTRY_POINTS) || keys.has(K.ALL_PLAYERS_CHEMISTRY_POINTS);
    const nation = chem || [K.NATION_ID, K.SAME_NATION_COUNT, K.NATION_COUNT].some((k) => keys.has(k));
    const league = chem || [K.LEAGUE_ID, K.SAME_LEAGUE_COUNT, K.LEAGUE_COUNT].some((k) => keys.has(k));
    const club = chem || [K.CLUB_ID, K.SAME_CLUB_COUNT, K.CLUB_COUNT].some((k) => keys.has(k));
    const sig = (p) => JSON.stringify([
      p.rating,
      keys.has(K.PLAYER_QUALITY) || keys.has(K.PLAYER_LEVEL) ? p.tier : null,
      keys.has(K.PLAYER_RARITY) ? p.rareflag : null,
      keys.has(K.PLAYER_RARITY_GROUP) ? p.groups : null,
      nation ? p.nationId : null,
      league ? p.leagueId : null,
      club ? canonicalClub(p.teamId, links) : null,
      chem ? [...p.positions].sort((a, b) => a - b) : null,
      keys.has(K.FIRST_OWNER_PLAYERS_COUNT) ? p.owners === 1 : null,
      keys.has(K.LEGEND_COUNT) ? p.legend : null
    ]);
    const keep = challenges.reduce((a, c) => a + c.slots.filter(isOpen).length, 0) + SQUAD_SIZE;
    const groups = new Map();
    for (const p of pool) groups.set(sig(p), (groups.get(sig(p)) || []).concat([p]));
    const kept = pool.filter((p) => always.has(p.id));
    for (const members of groups.values()) {
      const bases = new Set();
      for (const p of members.sort((a, b) => costs.get(a.id) - costs.get(b.id) || a.id - b.id)) {
        if (bases.has(p.baseId) || always.has(p.id)) continue;
        bases.add(p.baseId);
        kept.push(p);
        if (bases.size >= keep) break;
      }
    }
    return kept;
  }

  // ---------- local search (chemistry SBCs, sets, repeated solves) ----------
  // A linear model can only approximate chemistry's min(3, links) per player, so HiGHS searches
  // nearly blind there. This simulated-annealing search works on real squads instead: squads are
  // scored as cost + VIOLATION_WEIGHT * (how far requirements are from being met), using the same
  // rules as checkChallenge, and the best fully valid squad seen is kept. Several squads (a set,
  // or one repeatable SBC N times) are searched together with no item used twice.

  const LS_TUNING = {}; // overridable for tuning experiments
  const VIOLATION_WEIGHT = 5e6; // ~4k coins per unit (1 chem point, 1/11 rating point, 1 player)

  function mulberry32(seed) {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const over = (v, scope, t) => (scope === GREATER ? Math.max(0, t - v) : scope === LOWER ? Math.max(0, v - t) : Math.abs(v - t));
  const withBricksOver = (only, all, scope, t) =>
    scope === GREATER ? Math.max(0, t - only) : scope === LOWER ? Math.max(0, all - t) : Math.max(0, t - only) + Math.max(0, all - t);

  // How far a squad is from meeting a challenge (0 = valid). Mirrors checkRequirement.
  function violation(ch, assignment, links, extra) {
    const players = [...assignment.values()];
    let v = players.length - new Set(players.map((p) => p.baseId)).size;
    let chem = null;
    const getChem = () => (chem ??= chemistry(assignment, ch.slots, links));
    for (const r of ch.requirements) {
      const k = r.key;
      const t = r.values.length ? r.values[0] : 0;
      if (PER_PLAYER_KEYS.has(k)) {
        if (r.count < 0) {
          v += players.filter((p) => !playerMatches(r, p, links)).length;
        } else {
          const n = players.filter((p) => playerMatches(r, p, links)).length;
          v += withBricksOver(n, n + extra.filter((b) => playerMatches(r, b, links)).length, r.scope, r.count);
        }
      } else if (k === K.TEAM_RATING) {
        const scaled = ratingScaled(players.map((p) => p.rating));
        const [low, high] = teamRatingBounds(t);
        if (r.scope !== LOWER) v += Math.max(0, low - scaled) / SQUAD_SIZE;
        if (r.scope !== GREATER) v += Math.max(0, scaled - high) / SQUAD_SIZE;
      } else if (k === K.CHEMISTRY_POINTS) {
        v += over(getChem().total, r.scope, t);
      } else if (k === K.ALL_PLAYERS_CHEMISTRY_POINTS) {
        const per = getChem().perSlot;
        for (const i of assignment.keys()) v += Math.max(0, t - per.get(i));
      } else if (k === K.SAME_NATION_COUNT || k === K.SAME_LEAGUE_COUNT || k === K.SAME_CLUB_COUNT) {
        const fn = groupFn(k, links);
        const only = count(players.map(fn));
        if (r.scope !== LOWER) v += Math.max(0, t - Math.max(0, ...only.values()));
        if (r.scope !== GREATER) for (const n of count(players.concat(extra).map(fn)).values()) v += Math.max(0, n - t);
      } else if (k === K.NATION_COUNT || k === K.LEAGUE_COUNT || k === K.CLUB_COUNT) {
        const fn = groupFn(k, links);
        v += withBricksOver(new Set(players.map(fn)).size, new Set(players.concat(extra).map(fn)).size, r.scope, t);
      } else if (k === K.FIRST_OWNER_PLAYERS_COUNT) {
        v += over(players.filter((p) => p.owners === 1).length, r.scope, t);
      } else if (k === K.LEGEND_COUNT) {
        v += over(players.filter((p) => p.legend).length, r.scope, t);
      } else if (k === K.PLAYER_COUNT) {
        v += over(players.length, r.scope, t);
      }
    }
    return v;
  }

  // challenges: [{ ch, fixed: Map(slot -> player) }]; pool: shared candidates (no item twice).
  // Returns { assignments: [Map] , total } for the best valid squads found, or null.
  function localSearch(items, pool, links, costs, { objective = "price", timeLimit = 2, seed = 1, tune = {} } = {}) {
    const T = { iterations: 20000, maxRuns: 12, t0: 2e6, t1: 2e3, ...LS_TUNING, ...tune };
    const rnd = mulberry32(seed);
    const started = now();
    const weight = (p) => (objective === "rating"
      ? p.rating * RATING_SCALE + Math.min(costs.get(p.id), RATING_SCALE - 1)
      : costs.get(p.id) * COST_SCALE + p.rating);
    const specs = items.map(({ ch, fixed }) => ({
      ch,
      fixed,
      extra: bricksOf(ch.slots),
      free: ch.slots.filter((s) => isOpen(s) && !fixed.has(s.index)),
      chem: ch.requirements.some((r) => r.key === K.CHEMISTRY_POINTS || r.key === K.ALL_PLAYERS_CHEMISTRY_POINTS)
    }));
    const fixedIds = new Set(items.flatMap(({ fixed }) => [...fixed.values()].map((p) => p.id)));
    const cands = pool.filter((p) => !fixedIds.has(p.id));
    if (!cands.length && specs.some((s) => s.free.length)) return null;

    const scoreOf = (spec, a) => {
      let w = 0;
      for (const [si, p] of a) {
        w += weight(p);
        if (spec.chem && !inPosition(p, spec.ch.slots.find((s) => s.index === si))) w += OOP_PENALTY;
      }
      const viol = violation(spec.ch, a, links, spec.extra);
      return { w, viol, score: w + VIOLATION_WEIGHT * viol };
    };

    let best = null; // { total, assignments }
    const consider = (state) => {
      if (state.evals.some((e) => e.viol > 1e-9)) return;
      const total = state.evals.reduce((a, e) => a + e.w, 0);
      if (!best || total < best.total) best = { total, assignments: state.squads.map((a) => new Map(a)) };
    };

    const initial = () => {
      const used = new Set(fixedIds);
      const order = cands.map((p) => ({ p, key: weight(p) * (0.7 + 0.6 * rnd()) })).sort((a, b) => a.key - b.key).map((x) => x.p);
      const squads = specs.map((spec) => {
        const a = new Map(spec.fixed);
        for (const s of spec.free) {
          const pick = order.find((p) => !used.has(p.id) && (!spec.chem || inPosition(p, s))) || order.find((p) => !used.has(p.id));
          if (!pick) return null;
          used.add(pick.id);
          a.set(s.index, pick);
        }
        return a;
      });
      if (squads.includes(null)) return null;
      return { squads, used, evals: squads.map((a, k) => scoreOf(specs[k], a)) };
    };

    const tryMove = (state, k, a2, freedId, takenId, temp) => {
      const e2 = scoreOf(specs[k], a2);
      const delta = e2.score - state.evals[k].score;
      if (delta <= 0 || (temp > 0 && rnd() < Math.exp(-delta / temp))) {
        state.squads[k] = a2;
        state.evals[k] = e2;
        if (freedId !== undefined) state.used.delete(freedId);
        if (takenId !== undefined) state.used.add(takenId);
        return true;
      }
      return false;
    };

    const step = (state, temp) => {
      const k = Math.floor(rnd() * specs.length);
      const spec = specs[k];
      if (!spec.free.length) return;
      const r = rnd();
      if (spec.free.length > 1 && spec.chem && r < 0.25) {
        // swap two slots of the same squad (positions matter for chemistry)
        const s1 = spec.free[Math.floor(rnd() * spec.free.length)];
        const s2 = spec.free[Math.floor(rnd() * spec.free.length)];
        if (s1 === s2) return;
        const a2 = new Map(state.squads[k]);
        a2.set(s1.index, state.squads[k].get(s2.index));
        a2.set(s2.index, state.squads[k].get(s1.index));
        tryMove(state, k, a2, undefined, undefined, temp);
      } else if (specs.length > 1 && r < 0.35) {
        // exchange players between two squads
        const k2 = Math.floor(rnd() * specs.length);
        if (k2 === k || !specs[k2].free.length) return;
        const s1 = spec.free[Math.floor(rnd() * spec.free.length)];
        const s2 = specs[k2].free[Math.floor(rnd() * specs[k2].free.length)];
        const a1 = new Map(state.squads[k]);
        const b1 = new Map(state.squads[k2]);
        a1.set(s1.index, state.squads[k2].get(s2.index));
        b1.set(s2.index, state.squads[k].get(s1.index));
        const e1 = scoreOf(spec, a1);
        const e2 = scoreOf(specs[k2], b1);
        const delta = e1.score + e2.score - state.evals[k].score - state.evals[k2].score;
        if (delta <= 0 || (temp > 0 && rnd() < Math.exp(-delta / temp))) {
          state.squads[k] = a1;
          state.squads[k2] = b1;
          state.evals[k] = e1;
          state.evals[k2] = e2;
        }
      } else {
        // replace a player with an unused candidate
        const s = spec.free[Math.floor(rnd() * spec.free.length)];
        let q = null;
        for (let tries = 0; tries < 8 && !q; tries++) {
          const c = cands[Math.floor(rnd() * cands.length)];
          if (!state.used.has(c.id)) q = c;
        }
        if (!q) return;
        const out = state.squads[k].get(s.index);
        const a2 = new Map(state.squads[k]);
        a2.set(s.index, q);
        tryMove(state, k, a2, out.id, q.id, temp);
      }
    };

    // Deterministic finish: best single replacement until none improves.
    const polish = (state) => {
      let improved = true;
      while (improved && now() - started < timeLimit) {
        improved = false;
        for (const [k, spec] of specs.entries()) {
          for (const s of spec.free) {
            let bestMove = null;
            for (const q of cands) {
              if (state.used.has(q.id)) continue;
              const a2 = new Map(state.squads[k]);
              a2.set(s.index, q);
              const e2 = scoreOf(spec, a2);
              if (e2.score < state.evals[k].score - 1e-6 && (!bestMove || e2.score < bestMove.e2.score)) bestMove = { q, a2, e2 };
            }
            if (bestMove) {
              state.used.delete(state.squads[k].get(s.index).id);
              state.used.add(bestMove.q.id);
              state.squads[k] = bestMove.a2;
              state.evals[k] = bestMove.e2;
              improved = true;
            }
          }
        }
        consider(state);
      }
    };

    const iterations = T.iterations * specs.length;
    let runs = 0;
    while (now() - started < timeLimit && runs < T.maxRuns) {
      runs++;
      const state = initial();
      if (!state) return best;
      const { t0, t1 } = T;
      for (let it = 0; it < iterations; it++) {
        if ((it & 1023) === 0) {
          if (now() - started >= timeLimit) break;
          consider(state);
        }
        step(state, t0 * Math.pow(t1 / t0, it / iterations));
      }
      consider(state);
      polish(state);
      consider(state);
    }
    return best;
  }

  // ---------- solving ----------

  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000;

  function runHighs(highs, lp, timeLimit, gap) {
    const text = lp.text();
    const res = highs.solve(text, {
      output_flag: false,
      time_limit: Math.max(0.5, timeLimit),
      mip_rel_gap: Math.max(0, gap)
    });
    const values = {};
    for (const [name, col] of Object.entries(res.Columns || {})) values[name] = col.Primal;
    const status = res.Status;
    const hasSolution = status === "Optimal" || (Object.keys(values).length > 0 && Number.isFinite(res.ObjectiveValue)
      && !/infeasible/i.test(status));
    return {
      status: status === "Optimal" ? "optimal" : /infeasible/i.test(status) ? "infeasible" : hasSolution ? "feasible" : "timeout",
      values,
      objective: res.ObjectiveValue,
      hasSolution
    };
  }

  // Like runHighs, but seeds HiGHS with a known squad (column name -> value, e.g. the local
  // search's y/x values); HiGHS completes the remaining columns itself. The result is never
  // worse than the start.
  function runHighsFrom(highs, lp, timeLimit, gap, start) {
    const model = highs.createModel({ format: "lp", data: lp.text() });
    try {
      model.options.set({ output_flag: false, time_limit: Math.max(0.5, timeLimit), mip_rel_gap: Math.max(0, gap) });
      const indices = [];
      const values = [];
      for (const [name, v] of start) {
        const j = model.getColByName(name);
        if (j >= 0) {
          indices.push(j);
          values.push(v);
        }
      }
      if (indices.length) model.setSolution({ indices, values });
      model.run();
      const code = model.getModelStatus();
      const primal = Number(model.info.get("primal_solution_status"));
      const hasSolution = primal === 2 || code === 7;
      const colValue = hasSolution ? model.getSolution().colValue : null;
      const out = {};
      if (colValue) for (let j = 0; j < colValue.length; j++) out[model.getColName(j)] = colValue[j];
      return {
        status: code === 7 ? "optimal" : code === 8 ? "infeasible" : hasSolution ? "feasible" : "timeout",
        values: out,
        objective: hasSolution ? model.getObjectiveValue() : Infinity,
        hasSolution
      };
    } finally {
      model.dispose();
    }
  }

  // Kernel for the exact re-solve: the local search's players, plus the cheapest others and the
  // cheapest ones sharing a nation/league/club with the squad (who could raise chemistry).
  const KERNEL_EXTRA = 35;
  function kernelPool(pool, squadPlayers, costs, links) {
    const used = new Set(squadPlayers.map((p) => p.id));
    const keys = new Set(squadPlayers.flatMap((p) => [`n${p.nationId}`, `l${p.leagueId}`, `c${canonicalClub(p.teamId, links)}`]));
    const rest = pool.filter((p) => !used.has(p.id)).sort((a, b) => costs.get(a.id) - costs.get(b.id));
    const linked = rest.filter((p) => keys.has(`n${p.nationId}`) || keys.has(`l${p.leagueId}`) || keys.has(`c${canonicalClub(p.teamId, links)}`));
    return [...new Map([...squadPlayers, ...rest.slice(0, KERNEL_EXTRA), ...linked.slice(0, KERNEL_EXTRA)]
      .map((p) => [p.id, p])).values()];
  }

  // Chemistry SBC: local search, then an exact HiGHS re-solve on a small kernel seeded with the
  // search's squad. Returns an assignment (Map) or null.
  function chemistrySolve(highs, ch, pool, links, costs, fixed, opts, timeLimit) {
    const started = now();
    const ls = localSearch([{ ch, fixed }], pool, links, costs, {
      objective: opts.objective,
      timeLimit: Math.min(LOCAL_SEARCH_SECONDS, 0.4 * timeLimit)
    });
    if (!ls) return null;
    const assignment = ls.assignments[0];
    const remaining = timeLimit - (now() - started);
    if (remaining < 0.5) return assignment;
    const kernel = kernelPool(pool, [...assignment.values()], costs, links);
    const lp = new Lp();
    const m = new ChallengeModel(lp, "k", ch, kernel, links, costs, { fixed, objective: opts.objective });
    m.objTerms.forEach(([c, v]) => lp.obj(c, v));
    const chosen = new Set([...assignment.values()].map((p) => p.id));
    const bySlot = new Map(ch.slots.map((s) => [s.index, s]));
    const place = new Map([...assignment].map(([si, p]) => [p.id, bySlot.get(si).general]));
    const start = new Map();
    kernel.forEach((p, i) => start.set(m.y[i], chosen.has(p.id) ? 1 : 0));
    for (const [key, v] of m.x) {
      const [i, gen] = key.split("|").map(Number);
      start.set(v, place.get(kernel[i].id) === gen ? 1 : 0);
    }
    const res = runHighsFrom(highs, lp, Math.min(KERNEL_SECONDS, remaining), opts.relativeGap, start);
    if (!res.hasSolution) return assignment;
    const better = m.extract(res.values);
    const cost = (a) => [...a.values()].reduce((t, p) => t + costs.get(p.id), 0);
    return checkChallenge(ch, better, links).length === 0 && cost(better) <= cost(assignment) ? better : assignment;
  }

  // Exact team-rating solve without the slow max(0, ...) modelling: for every reachable rating
  // sum S (cheapest first, by a knapsack lower bound that ignores the other requirements), solve
  // the small model with S fixed; stop when no remaining S can beat the best squad found.
  function solveRatingBySum(highs, ch, pool, links, costs, fixed, opts, timeLimit) {
    const started = now();
    const n = ch.slots.filter(isOpen).length;
    const weight = (p) => (opts.objective === "rating"
      ? p.rating * RATING_SCALE + Math.min(costs.get(p.id), RATING_SCALE - 1)
      : costs.get(p.id) * COST_SCALE + p.rating);
    // lb[k][s]: least weight of k pool players with rating sum s (0/1 knapsack with a count).
    const maxSum = n * MAX_RATING;
    const lb = Array.from({ length: n + 1 }, () => new Float64Array(maxSum + 1).fill(Infinity));
    lb[0][0] = 0;
    for (const p of pool) {
      const w = weight(p) + OOP_PENALTY;
      for (let k = Math.min(n, pool.length) - 1; k >= 0; k--) {
        const from = lb[k], to = lb[k + 1];
        for (let s0 = maxSum - p.rating; s0 >= 0; s0--) {
          if (from[s0] !== Infinity && from[s0] + w < to[s0 + p.rating]) to[s0 + p.rating] = from[s0] + w;
        }
      }
    }
    // Kept players are forced in, so any S is at least their rating sum; the bound stays valid.
    const minKept = [...fixed.values()].reduce((a, p) => a + p.rating, 0);
    const candidates = [];
    for (let S = minKept; S <= maxSum; S++) if (lb[n][S] < Infinity) candidates.push([lb[n][S], S]);
    candidates.sort((a, b) => a[0] - b[0]);
    let best = null;
    let tried = 0;
    for (const [bound, S] of candidates) {
      if (best && bound >= best.objective - 1e-6) break;
      const remaining = timeLimit - (now() - started);
      if (remaining <= 0.05) break;
      const lp = new Lp();
      const m = new ChallengeModel(lp, "r", ch, pool, links, costs, { fixed, objective: opts.objective, ratingSum: S });
      m.objTerms.forEach(([c, v]) => lp.obj(c, v));
      const res = runHighs(highs, lp, remaining, 0);
      tried++;
      if (res.hasSolution && (!best || res.objective < best.objective)) best = { objective: res.objective, assignment: m.extract(res.values) };
    }
    const exhausted = !best || tried === candidates.length || candidates.some(([bound]) => bound >= (best?.objective ?? Infinity));
    return best ? { assignment: best.assignment, proven: exhausted } : { assignment: null, proven: tried === candidates.length };
  }

  function usablePool(players, opts) {
    const excluded = {};
    const pool = [];
    for (const p of players) {
      const reason = exclusionReason(p, opts);
      if (reason) excluded[reason] = (excluded[reason] || 0) + 1;
      else pool.push(p);
    }
    return { pool, excluded, costs: new Map(pool.map((p) => [p.id, playerCost(p, opts)])) };
  }

  function describe(ch, assignment, links, costs) {
    const bySlot = new Map(ch.slots.map((s) => [s.index, s]));
    const chem = chemistry(assignment, ch.slots, links);
    const entries = [...assignment].sort((a, b) => a[0] - b[0]);
    return {
      slots: entries.map(([i, p]) => ({
        slotIndex: i,
        position: bySlot.get(i).name,
        playerId: p.id,
        name: p.name,
        rating: p.rating,
        cost: costs.get(p.id),
        marketPrice: badgePrice(p),
        tradable: p.tradable,
        inPosition: inPosition(p, bySlot.get(i)),
        chemistry: chem.perSlot.get(i)
      })),
      totalCost: entries.reduce((a, [, p]) => a + costs.get(p.id), 0),
      squadValue: entries.reduce((a, [, p]) => a + badgePrice(p), 0),
      teamRating: teamRating(entries.map(([, p]) => p.rating)),
      chemistry: chem.total,
      validationErrors: checkChallenge(ch, assignment, links)
    };
  }

  function solveOptions(o = {}) {
    return {
      timeLimitS: Math.min(120, Number(o.timeLimitS ?? 10)),
      maxSolutions: Math.max(1, Math.min(10, Number(o.maxSolutions ?? 1))),
      relativeGap: Math.min(0.2, Math.max(0, Number(o.relativeGap ?? 0.01))),
      objective: o.solveUsing === "rating" || o.objective === "rating" ? "rating" : "price"
    };
  }

  function solve(highs, challenge, players, links, costOpts, opts) {
    const started = now();
    const problems = unsupported(challenge);
    if (problems.length) return { status: "unsupported", unsupported: problems, solutions: [] };
    const { pool: usable, excluded, costs } = usablePool(players, costOpts);
    const byItem = new Map(players.map((p) => [p.id, p]));
    const open = new Set(challenge.slots.filter(isOpen).map((s) => s.index));
    const fixed = new Map([...costOpts.keep].filter(([si, pid]) => open.has(si) && byItem.has(pid)).map(([si, pid]) => [si, byItem.get(pid)]));
    const pool = pruneDominated(usable, [challenge], links, costs, new Set([...fixed.values()].map((p) => p.id)));
    for (const p of fixed.values()) if (!costs.has(p.id)) costs.set(p.id, playerCost(p, costOpts));
    if (fixed.size) for (const p of fixed.values()) if (!pool.includes(p)) pool.push(p);

    const gap = opts.objective === "rating" ? Math.min(opts.relativeGap, 0.0005) : opts.relativeGap;
    const solutions = [];
    const cuts = [];
    let statusName = null;
    let method = "milp";
    // Chemistry: local search first (see localSearch); HiGHS only if it finds nothing, to prove
    // the SBC impossible (or find the squad the search missed).
    const ratingOnly = challenge.requirements.some((r) => r.key === K.TEAM_RATING) && !needsChemistry(challenge);
    if (ratingOnly && opts.maxSolutions === 1) {
      const r = solveRatingBySum(highs, challenge, pool, links, costs, fixed, opts, opts.timeLimitS);
      if (r.assignment) {
        method = "rating by sum";
        statusName = r.proven ? "optimal" : "feasible";
        solutions.push(describe(challenge, r.assignment, links, costs));
      } else if (r.proven) {
        statusName = "infeasible";
      }
    }
    if (!solutions.length && statusName !== "infeasible" && needsSearch(challenge) && opts.maxSolutions === 1) {
      const found = chemistrySolve(highs, challenge, pool, links, costs, fixed, opts, Math.min(CHEMISTRY_SECONDS, opts.timeLimitS));
      if (found) {
        method = "local search + kernel";
        statusName = "feasible";
        solutions.push(describe(challenge, found, links, costs));
      }
    }
    for (let n = solutions.length || statusName === "infeasible" ? opts.maxSolutions : 0; n < opts.maxSolutions; n++) {
      const lp = new Lp();
      const model = new ChallengeModel(lp, "a", challenge, pool, links, costs, { fixed, objective: opts.objective });
      model.objTerms.forEach(([c, v]) => lp.obj(c, v));
      for (const cut of cuts) lp.row(cut.map((i) => [1, model.y[i]]), "<=", cut.length - 1);
      const res = runHighs(highs, lp, opts.timeLimitS - (now() - started), gap);
      if (statusName === null) statusName = res.status;
      if (!res.hasSolution) break;
      const assignment = model.extract(res.values);
      solutions.push(describe(challenge, assignment, links, costs));
      cuts.push(pool.map((p, i) => (res.values[model.y[i]] > 0.5 ? i : -1)).filter((i) => i >= 0));
      if (now() - started > opts.timeLimitS) break;
    }
    return {
      status: statusName,
      solutions,
      stats: {
        poolSize: pool.length,
        prunedDominated: usable.length - pool.length,
        excluded,
        openSlots: open.size,
        method,
        wallTimeS: Math.round((now() - started) * 1000) / 1000
      }
    };
  }

  const needsChemistry = (ch) => ch.requirements.some((r) => r.key === K.CHEMISTRY_POINTS || r.key === K.ALL_PLAYERS_CHEMISTRY_POINTS);
  // Chemistry and team rating are where a linear model is slow (chemistry's min(3, links),
  // rating's max(0, r - avg)); those SBCs go through local search + a kernel re-solve.
  const needsSearch = (ch) => needsChemistry(ch) || ch.requirements.some((r) => r.key === K.TEAM_RATING);
  const LOCAL_SEARCH_SECONDS = 1.5; // simulated annealing for a chemistry SBC
  const KERNEL_SECONDS = 3; // exact re-solve on the kernel, seeded with the search's squad
  const CHEMISTRY_SECONDS = 5; // cap for one chemistry SBC (search + re-solve)

  // One challenge on a given pool: local search for chemistry SBCs, HiGHS otherwise (and to
  // prove infeasibility). Returns { status, assignment | null }.
  function solveOne(highs, ch, pool, links, costs, opts, timeLimit, { quick = false } = {}) {
    const started = now();
    if (ch.requirements.some((r) => r.key === K.TEAM_RATING) && !needsChemistry(ch)) {
      const r = solveRatingBySum(highs, ch, pool, links, costs, new Map(), opts, timeLimit);
      if (r.assignment) return { status: r.proven ? "optimal" : "feasible", assignment: r.assignment };
      if (r.proven) return { status: "infeasible", assignment: null };
    }
    if (needsSearch(ch)) {
      const found = quick
        ? localSearch([{ ch, fixed: new Map() }], pool, links, costs, { objective: opts.objective, timeLimit: Math.min(LOCAL_SEARCH_SECONDS, 0.6 * timeLimit) })?.assignments[0]
        : chemistrySolve(highs, ch, pool, links, costs, new Map(), opts, Math.min(CHEMISTRY_SECONDS, timeLimit));
      if (found) return { status: "feasible", assignment: found };
    }
    const lp = new Lp();
    const m = new ChallengeModel(lp, "a", ch, pool, links, costs, { objective: opts.objective });
    m.objTerms.forEach(([co, v]) => lp.obj(co, v));
    const res = runHighs(highs, lp, Math.max(0.5, timeLimit - (now() - started)), opts.relativeGap);
    return { status: res.status, assignment: res.hasSolution ? m.extract(res.values) : null };
  }

  const setCost = (assignments, costs) => {
    let total = 0;
    for (const a of assignments.values()) for (const p of a.values()) total += costs.get(p.id);
    return total;
  };

  // Whole SBC set (or one repeatable SBC several times): each item used at most once.
  // 1) solve each alone (impossible ones are reported, the rest still solved);
  // 2) if the solo squads share no players they're already the best set;
  // 3) otherwise greedy orders, then re-solve pairs until within 1% of the solo bound.
  function solveSet(highs, challenges, players, links, costOpts, opts) {
    const started = now();
    const deadline = started + opts.timeLimitS;
    const entries = new Map(challenges.map((c) => [c.id, { challengeId: c.id, name: c.name }]));
    const todo = [];
    for (const c of challenges) {
      const problems = unsupported(c);
      if (problems.length) Object.assign(entries.get(c.id), { status: "unsupported", unsupported: problems });
      else todo.push(c);
    }
    const { pool: usable, excluded, costs } = usablePool(players, costOpts);
    const pool = todo.length ? pruneDominated(usable, todo, links, costs) : usable;

    const alone = new Map();
    const perChallenge = Math.max(1.5, (0.4 * opts.timeLimitS) / Math.max(1, todo.length));
    for (const c of todo) {
      const res = solveOne(highs, c, pool, links, costs, opts, Math.min(perChallenge, Math.max(0.5, deadline - now())), { quick: true });
      if (res.assignment) alone.set(c.id, res.assignment);
      else entries.get(c.id).status = res.status === "infeasible" ? "infeasible" : "timeout";
    }
    let solvable = todo.filter((c) => alone.has(c.id));
    const used = [...alone.values()].flatMap((a) => [...a.values()].map((p) => p.id));
    let method = "independent";
    let assignments = used.length === new Set(used).size ? alone : null;

    if (!assignments) {
      method = "shared players";
      // Greedy (one challenge after another, a few orders), then one joint HiGHS re-solve over
      // all squads on a small kernel, seeded with the greedy squads (never worse than greedy).
      let greedy = greedySet(highs, solvable, pool, links, costs, opts, deadline, alone);
      if ((!greedy || greedy.assignments.size < solvable.length) && !sameChallenges(solvable) && now() < deadline - 1) {
        // No order fits them all one at a time: search all squads together (no item twice).
        const joint = localSearch(solvable.map((ch) => ({ ch, fixed: new Map() })), pool, links, costs, {
          objective: opts.objective,
          timeLimit: Math.max(1, Math.min(4 * solvable.length, deadline - now() - 1))
        });
        if (joint) greedy = { assignments: new Map(solvable.map((c, k) => [c.id, joint.assignments[k]])) };
      }
      if (greedy) {
        // Whatever can't be done alongside the others is reported; the rest still get squads.
        for (const c of solvable) {
          if (!greedy.assignments.has(c.id)) entries.get(c.id).status = "not enough players to do it together with the others";
        }
        solvable = solvable.filter((c) => greedy.assignments.has(c.id));
        assignments = jointKernelSolve(highs, solvable, pool, links, costs, opts, greedy.assignments, deadline);
      } else {
        for (const c of solvable) entries.get(c.id).status = "not enough players to do it together with the others";
        solvable = [];
      }
    }

    let total = 0;
    for (const c of solvable) {
      const sol = describe(c, assignments.get(c.id), links, costs);
      Object.assign(entries.get(c.id), { status: "solved", solution: sol });
      total += sol.totalCost;
    }
    const all = [...entries.values()];
    const solved = all.filter((e) => e.status === "solved").length;
    const status = solved === challenges.length ? (method === "independent" ? "optimal" : "feasible")
      : solved ? "partial" : all.some((e) => e.status === "unsupported") ? "unsupported" : "infeasible";
    return {
      status,
      challenges: challenges.map((c) => entries.get(c.id)),
      totalCost: total,
      stats: { poolSize: pool.length, prunedDominated: usable.length - pool.length, excluded, method,
        wallTimeS: Math.round((now() - started) * 1000) / 1000 }
    };
  }

  // Joint exact re-solve for several squads (no item twice), seeded with `start` assignments.
  function jointKernelSolve(highs, challenges, pool, links, costs, opts, start, deadline) {
    const remaining = deadline - now();
    if (remaining < 1) return start;
    const squadPlayers = challenges.flatMap((c) => [...start.get(c.id).values()]);
    const kernel = kernelPool(pool, squadPlayers, costs, links);
    const lp = new Lp();
    const models = challenges.map((c, k) => new ChallengeModel(lp, `c${k}`, c, kernel, links, costs, { objective: opts.objective }));
    kernel.forEach((p, i) => lp.row(models.map((m) => [1, m.y[i]]), "<=", 1));
    models.forEach((m) => m.objTerms.forEach(([c, v]) => lp.obj(c, v)));
    const seed = new Map();
    challenges.forEach((c, k) => {
      const a = start.get(c.id);
      const chosen = new Set([...a.values()].map((p) => p.id));
      const bySlot = new Map(c.slots.map((s) => [s.index, s]));
      const place = new Map([...a].map(([si, p]) => [p.id, bySlot.get(si).general]));
      kernel.forEach((p, i) => seed.set(models[k].y[i], chosen.has(p.id) ? 1 : 0));
      for (const [key, v] of models[k].x) {
        const [i, gen] = key.split("|").map(Number);
        seed.set(v, place.get(kernel[i].id) === gen ? 1 : 0);
      }
    });
    const res = runHighsFrom(highs, lp, Math.min(KERNEL_SECONDS * challenges.length, remaining), opts.relativeGap, seed);
    if (!res.hasSolution) return start;
    const better = new Map(challenges.map((c, k) => [c.id, models[k].extract(res.values)]));
    const valid = challenges.every((c) => checkChallenge(c, better.get(c.id), links).length === 0);
    return valid && setCost(better, costs) <= setCost(start, costs) ? better : start;
  }

  // One challenge after another, removing used players. Hardest first (most expensive solo
  // squad), starting from its solo squad; the joint re-solve afterwards does the fine-tuning.
  // Challenges one after another (most expensive alone first), each on the players left. A
  // challenge that runs out of players is skipped (the rest still get squads) and the order is
  // retried with it earlier. Best = most squads, then cheapest. Returns null if none is possible.
  const sameChallenges = (challenges) =>
    new Set(challenges.map((c) => JSON.stringify([c.requirements, c.slots]))).size === 1;

  function greedySet(highs, challenges, pool, links, costs, opts, deadline, solo = new Map()) {
    const soloCost = (c) => (solo.has(c.id) ? [...solo.get(c.id).values()].reduce((t, p) => t + costs.get(p.id), 0) : 0);
    const orders = [[...challenges.keys()].sort((a, b) => soloCost(challenges[b]) - soloCost(challenges[a]))];
    const tried = new Set(orders.map((o) => o.join()));
    let best = null;
    for (let k = 0; k < orders.length; k++) {
      const order = orders[k];
      if (k > 0 && now() >= deadline) break;
      const usedIds = new Set();
      const result = new Map();
      for (const [step, i] of order.entries()) {
        const remaining = deadline - now();
        if (k > 0 && remaining <= 0.2) return best;
        const c = challenges[i];
        const sub = pool.filter((p) => !usedIds.has(p.id));
        const res = solveOne(highs, c, sub, links, costs, opts, Math.min(CHEMISTRY_SECONDS, Math.max(2, remaining)));
        if (!res.assignment) {
          // Identical copies (solve multiple times): moving one earlier changes nothing.
          if (step > 0 && !sameChallenges(challenges)) {
            const earlier = [i, ...order.filter((j) => j !== i)];
            if (!tried.has(earlier.join())) {
              tried.add(earlier.join());
              orders.push(earlier);
            }
          }
          continue;
        }
        const a = res.assignment;
        result.set(c.id, a);
        for (const p of a.values()) usedIds.add(p.id);
      }
      if (!result.size) continue;
      const total = setCost(result, costs);
      if (!best || result.size > best.assignments.size || (result.size === best.assignments.size && total < best.total)) {
        best = { total, assignments: result };
      }
      if (best.assignments.size === challenges.length) orders.length = Math.min(orders.length, k + 1);
    }
    return best;
  }

  // ---------- request handlers (same payloads/results as the Python server) ----------

  function handleSolve(highs, payload) {
    const { players, links } = clubFromDump(payload.club);
    const challenge = challengeFromDump(payload.sbc);
    const o = payload.options || {};
    const result = solve(highs, challenge, players, links, costOptions(o), solveOptions(o));
    return {
      challenge: { id: challenge.id, name: challenge.name, formation: challenge.formation },
      requirements: challenge.requirements.map(describeReq),
      ...result
    };
  }

  function handleSolveSet(highs, payload) {
    const { players, links } = clubFromDump(payload.club);
    const challenges = (payload.sbcs || []).map(challengeFromDump);
    if (!challenges.length) throw new Error("no challenges");
    const o = { timeLimitS: Math.min(60, 10 * challenges.length), ...(payload.options || {}) };
    const result = solveSet(highs, challenges, players, links, costOptions(o), solveOptions(o));
    return { challenge: { name: `set of ${challenges.length}` }, ...result };
  }

  const api = {
    K, GREATER, LOWER, EXACT, FORMATION_POSITIONS,
    playerFromItem, clubFromDump, challengeFromDump, teamLinkMap,
    costOptions, solveOptions, playerCost, exclusionReason, fodderValue,
    teamRating, ratingScaled, teamRatingBounds, chemistry, checkChallenge, checkRequirement, unsupported,
    solve, solveSet, handleSolve, handleSolveSet, LS_TUNING
  };
  root.SbcSolver = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
