// MAIN-world script: the only file that touches Web App internals (see docs/webapp-internals.md).
// Answers content.js requests: recon dumps, solver input, squad fills (never submits), and the
// price badges on player cards. Every access is defensive: EA updates can rename things.
(() => {
  "use strict";

  const NS = "sbcsolver";
  const PAGE_SIZE = 100;
  const PAGE_DELAY_MS = [1500, 3000]; // randomized pause between club pages
  const RAW_SAMPLE_ITEMS = 5; // full raw snapshots kept for this many items (recon only)

  const g = (name) => {
    try {
      return window[name];
    } catch {
      return undefined;
    }
  };
  const isObj = (v) => v !== null && typeof v === "object";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = ([lo, hi]) => lo + Math.random() * (hi - lo);

  // ---------- generic serialization ----------

  function snapshot(value, depth = 2, seen = new WeakSet()) {
    if (value === null || value === undefined) return value;
    const t = typeof value;
    if (t === "string" || t === "number" || t === "boolean") return value;
    if (t === "bigint") return String(value);
    if (t === "function" || t === "symbol") return undefined;
    if (typeof Node !== "undefined" && value instanceof Node) return "[DOM]";
    if (seen.has(value)) return "[cycle]";
    seen.add(value);
    if (Array.isArray(value)) {
      if (depth < 0) return `[array(${value.length})]`;
      return value.slice(0, 60).map((v) => snapshot(v, depth - 1, seen));
    }
    if (value instanceof Map || value instanceof Set) {
      if (depth < 0) return `[${value.constructor.name}(${value.size})]`;
      return Array.from(value).slice(0, 60).map((v) => snapshot(v, depth - 1, seen));
    }
    // EA's collection wrapper keeps entries in _collection
    if (isObj(value._collection) && depth >= 0) {
      return { __collection: snapshot(value._collection, depth, seen) };
    }
    if (depth < 0) return `[${ctorName(value)}]`;
    const out = {};
    for (const key of Object.keys(value)) {
      if (key.startsWith("__")) continue; // DOM/view internals
      let v;
      try {
        v = value[key];
      } catch {
        continue;
      }
      const s = snapshot(v, depth - 1, seen);
      if (s !== undefined) out[key] = s;
    }
    const name = ctorName(value);
    if (name && name !== "Object") out.__type = name;
    return out;
  }

  function ctorName(obj) {
    try {
      return obj?.constructor?.name || obj?.className || undefined;
    } catch {
      return undefined;
    }
  }

  function protoMethods(obj) {
    const names = new Set();
    let p = isObj(obj) ? obj : null; // own props too: some objects carry methods directly
    while (p && p !== Object.prototype) {
      for (const k of Object.getOwnPropertyNames(p)) {
        if (k === "constructor") continue;
        try {
          if (typeof Object.getOwnPropertyDescriptor(p, k)?.value === "function") names.add(k);
        } catch {
          /* ignore */
        }
      }
      p = Object.getPrototypeOf(p);
    }
    return Array.from(names).sort();
  }

  function callIfFn(obj, name, ...args) {
    try {
      return typeof obj?.[name] === "function" ? obj[name](...args) : undefined;
    } catch (e) {
      return `[threw: ${e?.message || e}]`;
    }
  }

  // Wraps EA's observable pattern: obs.observe(ctx, (sender, response) => ...)
  function observeOnce(observable, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      if (!observable || typeof observable.observe !== "function") {
        reject(new Error("not an observable"));
        return;
      }
      const ctx = {};
      const timer = setTimeout(() => reject(new Error("observable timed out")), timeoutMs);
      observable.observe(ctx, (sender, response) => {
        clearTimeout(timer);
        try {
          sender?.unobserve?.(ctx);
        } catch {
          /* ignore */
        }
        resolve(response);
      });
    });
  }

  function enumNameMap(enumObj) {
    const map = {};
    if (!isObj(enumObj)) return map;
    for (const [k, v] of Object.entries(enumObj)) {
      if (typeof v === "number" || typeof v === "string") map[v] = k;
    }
    return map;
  }

  // ---------- items ----------

  // Zero-arg predicates/getters called if present (confirmed on UTItemEntity, FC 27 probe 2026-09-23).
  const ITEM_PREDICATES = [
    "isPlayer", "isDuplicate", "isSpecial", "isLimitedUse", "isEnrolledInAcademy", "isGK",
    "isGoldRating", "isSilverRating", "isBronzeRating", "isValid", "isStorageItem", "isRare",
    "isCommon", "isTradeable", "isEffectivelyTradable", "isLegend", "isLeagueHeroItem",
    "isTradeableDuplicate", "isUnTradeableDuplicate", "isDuplicateLoanPlayer", "isTimeLimited",
    "isActiveInAcademy", "isActiveInTimedEvolution", "isAcademyGraduate", "isSuperChem",
    "isMovable", "isStorable"
  ];
  const ITEM_GETTERS = ["getBaseRating", "getTier", "getBaseRarity", "getMarketAverage", "getBasePossiblePositions"];

  const isPrimitiveish = (v) =>
    v === null ||
    ["string", "number", "boolean"].includes(typeof v) ||
    (Array.isArray(v) && v.every((x) => typeof x !== "object" || x === null));

  // Values like rating/rareflag live behind prototype getters (backed by _rating/_rareflag),
  // so Object.keys misses them.
  function readAccessors(obj) {
    const out = {};
    let p = Object.getPrototypeOf(obj);
    while (p && p !== Object.prototype) {
      for (const k of Object.getOwnPropertyNames(p)) {
        if (k in out) continue;
        const d = Object.getOwnPropertyDescriptor(p, k);
        if (!d || typeof d.get !== "function") continue;
        try {
          const v = obj[k];
          if (isPrimitiveish(v)) out[k] = v;
        } catch {
          /* ignore */
        }
      }
      p = Object.getPrototypeOf(p);
    }
    return out;
  }

  function serializeItem(item, withRaw) {
    if (!isObj(item)) return null;
    const fields = {};
    for (const key of Object.keys(item)) {
      if (key.startsWith("_")) continue;
      let v;
      try {
        v = item[key];
      } catch {
        continue;
      }
      if (isPrimitiveish(v)) fields[key] = v;
    }
    Object.assign(fields, readAccessors(item));
    for (const name of ITEM_GETTERS) {
      if (typeof item[name] === "function") fields[name] = snapshot(callIfFn(item, name), 1);
    }
    if (fields.rating === undefined && typeof item._rating === "number") fields.rating = item._rating;
    if (fields.rareflag === undefined && typeof item._rareflag === "number") fields.rareflag = item._rareflag;
    const staticData = isObj(item._staticData) ? snapshot(item._staticData, 1) : undefined;
    const predicates = {};
    for (const name of ITEM_PREDICATES) {
      if (typeof item[name] === "function") predicates[name] = callIfFn(item, name);
    }
    const out = { fields, staticData, predicates };
    if (withRaw) {
      out.raw = snapshot(item, 2);
      out.protoMethods = protoMethods(item);
    }
    return out;
  }

  // ---------- controllers ----------

  function appMain() {
    return g("_appMain") || callIfFn(window, "getAppMain");
  }

  // BFS over controller-ish objects looking for anything holding an SBC challenge.
  function findControllers(maxDepth = 8) {
    const root = appMain()?._rootViewController || callIfFn(appMain(), "getRootViewController");
    const found = [];
    if (!root) return found;
    const seen = new Set();
    const queue = [{ node: root, path: "root", depth: 0 }];
    const LINK_KEYS = [
      "currentController", "leftController", "rightController", "_childViewControllers",
      "childViewControllers", "presentedViewController", "_presentedViewController",
      "_navigationController", "navigationController"
    ];
    while (queue.length) {
      const { node, path, depth } = queue.shift();
      if (!isObj(node) || seen.has(node)) continue;
      seen.add(node);
      found.push({ node, path, className: node.className || ctorName(node) });
      if (depth >= maxDepth) continue;
      for (const key of LINK_KEYS) {
        let v;
        try {
          v = node[key];
        } catch {
          continue;
        }
        if (Array.isArray(v)) v.forEach((c, i) => queue.push({ node: c, path: `${path}.${key}[${i}]`, depth: depth + 1 }));
        else if (isObj(v)) queue.push({ node: v, path: `${path}.${key}`, depth: depth + 1 });
      }
    }
    return found;
  }

  // ---------- commands ----------

  const PROBE_GLOBALS = [
    "services", "repositories", "_appMain", "getAppMain", "UTSearchCriteriaDTO",
    "SBCEligibilityKey", "SBCEligibilityScope", "UTSquadChemCalculatorUtils", "UTSBCChallengeEntity",
    "UTSBCSetEntity", "UTSquadEntity", "UTItemEntity", "UTNullItemEntity", "UTPlayerItemView",
    "UTSBCSquadOverviewViewController", "UTSBCSquadDetailPanelViewController", "SearchSortType",
    "ItemPile", "JSUtils", "generateSbcSquadOptions", "PlayerRarity", "ItemRarity"
  ];

  function probe() {
    const globals = {};
    for (const name of PROBE_GLOBALS) globals[name] = typeof g(name);

    const services = g("services");
    const repositories = g("repositories");
    const serviceMethods = {};
    if (isObj(services)) {
      for (const k of Object.keys(services)) serviceMethods[k] = protoMethods(services[k]);
    }

    let windowNames = [];
    try {
      windowNames = Object.getOwnPropertyNames(window);
    } catch {
      /* ignore */
    }
    const utGlobals = windowNames.filter((n) => /^UT[A-Z]/.test(n)).sort();
    const sbcNamed = windowNames.filter((n) => /sbc|eligib|chem/i.test(n)).sort();
    const enums = {};
    for (const n of windowNames) {
      if (!/^(SBC|UTSBC|Item|Player|Rarity|Chem|Formation|Position)/.test(n)) continue;
      const v = g(n);
      if (isObj(v) && !Array.isArray(v) && typeof v !== "function") {
        const vals = Object.values(v);
        if (vals.length && vals.length < 400 && vals.every((x) => typeof x === "number" || typeof x === "string")) {
          enums[n] = v;
        }
      }
    }

    const controllers = findControllers().map(({ path, className, node }) => ({
      path,
      className,
      hasChallenge: isObj(node._challenge) || isObj(node.challenge),
      hasSquad: isObj(node._squad) || isObj(node.squad)
    }));

    let teamLinksCount;
    try {
      teamLinksCount = Array.from(repositories?.TeamConfig?.teamLinks || []).length;
    } catch {
      teamLinksCount = "[unreadable]";
    }

    return {
      kind: "probe",
      capturedAt: new Date().toISOString(),
      url: location.href,
      scripts: Array.from(document.scripts).map((s) => s.src).filter(Boolean),
      globals,
      serviceKeys: isObj(services) ? Object.keys(services).sort() : null,
      serviceMethods,
      repositoryKeys: isObj(repositories) ? Object.keys(repositories).sort() : null,
      itemRepoKeys: isObj(repositories?.Item) ? Object.keys(repositories.Item).sort() : null,
      teamLinksCount,
      utGlobalsCount: utGlobals.length,
      utGlobals,
      sbcNamed,
      enums,
      controllers
    };
  }

  function clubCache() {
    const repos = g("repositories");
    const services = g("services");
    const candidates = [
      () => repos?.Item?.club?.items?.values?.(),
      () => services?.Club?.clubDao?.clubRepo?.items?.values?.(),
      () => services?.Item?.itemDao?.itemRepo?.club?.items?.values?.()
    ];
    for (const get of candidates) {
      try {
        const v = get();
        if (v) {
          const arr = Array.from(v);
          if (arr.length) return arr;
        }
      } catch {
        /* try next */
      }
    }
    return [];
  }

  // Per page load: the club player count and SBC storage, so repeated solves skip the network.
  const sessionMemo = { expected: null, storage: null };

  function storageCache() {
    try {
      const v = g("repositories")?.Item?.storage?.values?.();
      return v ? Array.from(v) : [];
    } catch {
      return [];
    }
  }

  // Item ids in your active squad (starters, subs, reserves), so auto-complete can leave them
  // alone. Read from the app's squad cache (FSU reads the same place); if the Squads screen
  // hasn't been opened this session, one requestSquadById (what that screen sends) fills it.
  let activeSquadMemo = null;

  function squadItemIds(squad) {
    const slots = callIfFn(squad, "getPlayers");
    if (!Array.isArray(slots)) return null;
    return slots.map((sl) => (callIfFn(sl, "getItem") || sl?.item)?.id).filter((id) => id > 0);
  }

  async function activeSquadIds() {
    const services = g("services");
    const activeId = services?.Squad?.activeSquad ?? callIfFn(services?.Squad, "getActiveSquadId");
    const persona = callIfFn(services?.User, "getUser")?.selectedPersona;
    try {
      const bucket = g("repositories")?.Squad?.squads?.get?.(persona);
      const ids = squadItemIds(bucket?.get?.(activeId));
      if (ids?.length) return { known: true, ids };
    } catch {
      /* fall through */
    }
    if (activeSquadMemo) return activeSquadMemo;
    if (activeId === undefined || typeof services?.Squad?.requestSquadById !== "function") return { known: false, ids: [] };
    try {
      const res = await observeOnce(services.Squad.requestSquadById(activeId));
      const squad = res?.response?.squad ?? res?.data?.squad ?? res?.squad ?? res?.response;
      const ids = squadItemIds(squad);
      activeSquadMemo = ids?.length ? { known: true, ids } : { known: false, ids: [] };
    } catch {
      activeSquadMemo = { known: false, ids: [] };
    }
    return activeSquadMemo;
  }

  // opts.lite: for solving. Reuses per-session reads and skips recon-only extras.
  async function dumpClub(progress, opts = {}) {
    const lite = !!opts.lite;
    const services = g("services");
    const Criteria = g("UTSearchCriteriaDTO");
    if (!services?.Club) throw new Error("services.Club not found; run Probe and check serviceKeys");

    const notes = [];
    let expected = lite ? sessionMemo.expected : null;
    if (expected === null) try {
      const stats = await observeOnce(services.Club.getStats());
      const players = stats?.response?.stats?.find?.((s) => s.type === "players");
      expected = players?.count ?? null;
      sessionMemo.expected = expected;
    } catch (e) {
      notes.push(`getStats failed: ${e.message}`);
    }
    progress(`Club reports ${expected ?? "?"} players`);

    // The club cache also holds kits, tifos, balls, etc.; keep players only.
    const isPlayerItem = (it) => it?.type === "player" || callIfFn(it, "isPlayer") === true;
    const byId = new Map();
    const cached = clubCache();
    cached.filter(isPlayerItem).forEach((it) => it?.id && byId.set(it.id, it));
    notes.push(`cache had ${cached.length} items, ${byId.size} players`);

    if (expected === null || byId.size < expected) {
      if (typeof Criteria !== "function") throw new Error("UTSearchCriteriaDTO not found; cannot page club");
      for (let page = 0; page < 200; page++) {
        const c = new Criteria();
        c.type = "player";
        c.sortBy = "ovr";
        c.sort = "desc";
        c.count = PAGE_SIZE;
        c.offset = page * PAGE_SIZE;
        progress(`Reading club page ${page + 1}${expected ? ` of ~${Math.ceil(expected / PAGE_SIZE)}` : ""}`);
        const res = await observeOnce(services.Club.search(c));
        if (!res?.success) {
          notes.push(`page ${page} failed: status ${res?.status}`);
          break;
        }
        const items = res.response?.items || [];
        items.filter(isPlayerItem).forEach((it) => it?.id && byId.set(it.id, it));
        if (res.response?.retrievedAll || items.length < PAGE_SIZE) break;
        await sleep(jitter(PAGE_DELAY_MS));
      }
    }

    // SBC storage (usable in SBCs): best effort, read from repository after one search.
    let storage = storageCache().filter(isPlayerItem);
    if (!storage.length && lite && sessionMemo.storage) storage = sessionMemo.storage;
    else if (!storage.length) {
      try {
        if (typeof services.Item?.searchStorageItems === "function" && typeof Criteria === "function") {
          await sleep(jitter(lite ? [300, 700] : PAGE_DELAY_MS));
          const res = await observeOnce(services.Item.searchStorageItems(new Criteria()));
          storage = (res?.response?.items || []).filter(isPlayerItem);
          sessionMemo.storage = storage;
        }
      } catch (e) {
        notes.push(`storage read failed: ${e.message}`);
      }
    }

    let teamLinks = null;
    try {
      teamLinks = Array.from(g("repositories")?.TeamConfig?.teamLinks || []).map((x) => snapshot(x, 1));
    } catch (e) {
      notes.push(`teamLinks unreadable: ${e.message}`);
    }

    // rareflag -> rarity name/metadata table
    let rarities = null;
    if (!lite) try {
      rarities = snapshot(g("repositories")?.Rarity, 3);
    } catch (e) {
      notes.push(`rarity repo unreadable: ${e.message}`);
    }

    const items = Array.from(byId.values());
    progress(`Serializing ${items.length} club + ${storage.length} storage items`);
    return {
      kind: "club",
      capturedAt: new Date().toISOString(),
      expectedCount: expected,
      count: items.length,
      notes,
      teamLinks,
      rarities,
      players: items.map((it, i) => serializeItem(it, !lite && i < RAW_SAMPLE_ITEMS)),
      storage: storage.map((it, i) => serializeItem(it, !lite && i < 2)),
      unassigned: unassignedPlayers().map((it) => serializeItem(it, false)),
      transferDuplicates: transferDuplicates().map((it) => serializeItem(it, false)),
      activeSquad: await activeSquadIds()
    };
  }

  function serializeRequirement(req, keyNames, scopeNames) {
    const kv = {};
    const coll = req?.kvPairs?._collection;
    if (isObj(coll)) {
      for (const [k, v] of Object.entries(coll)) kv[keyNames[k] || k] = snapshot(v, 1);
    }
    const firstKey = callIfFn(req, "getFirstKey");
    return {
      text: requirementText(req),
      firstKey,
      firstKeyName: keyNames[firstKey],
      firstValue: snapshot(callIfFn(req, "getValue", firstKey), 1),
      scope: req?.scope,
      scopeName: scopeNames[req?.scope],
      count: req?.count,
      kv,
      raw: snapshot(req, 3),
      protoMethods: protoMethods(req)
    };
  }

  // Human-readable requirement text ("Min. 3 Players: Premier League") to pin down encodings.
  function requirementText(req) {
    const loc = g("services")?.Localization;
    for (const args of [[], [loc]]) {
      const t = callIfFn(req, "buildString", ...args);
      if (typeof t === "string" && !t.startsWith("[threw")) return t;
    }
    return null;
  }

  function serializeSquad(squad, lite = false) {
    if (!isObj(squad)) return null;
    const summary = {};
    for (const name of protoMethods(squad)) {
      if (/^get.*(rating|chem)/i.test(name) && squad[name].length === 0) summary[name] = snapshot(callIfFn(squad, name), 1);
    }
    const formation = callIfFn(squad, "getFormation");
    const slots = callIfFn(squad, "getPlayers");
    return {
      summary,
      formation: snapshot(formation, 3),
      formationMethods: protoMethods(formation),
      // 23 slots exist (11 starters + subs/reserves); SBC slots are the ones with a position.
      slots: Array.isArray(slots)
        ? slots
            .map((slot, i) => ({ slot, i }))
            .filter(({ slot }) => isObj(slot?.position))
            .map(({ slot, i }) => {
              const item = callIfFn(slot, "getItem");
              // Custom-brick placeholders may have no item id but still carry club/league/nation.
              const brickCard = slot.requirement?.playerType === "CUSTOM_BRICK" && isObj(item)
                && (item.teamId > 0 || item.leagueId > 0 || item.nationId > 0);
              const filled = isObj(item) && (item.definitionId > 0 || item.id > 0 || brickCard);
              const { _item, ...rest } = slot;
              return {
                i,
                raw: snapshot(rest, 1),
                accessors: readAccessors(slot),
                position: snapshot(slot.position, 1),
                requirement: snapshot(slot.requirement, 2),
                item: filled ? serializeItem(item, !lite && i < 2) : null
              };
            })
        : snapshot(slots, 1),
      chemistryVO: snapshot(squad.chemistryVO, 3),
      slotMethods: Array.isArray(slots) && slots[0] ? protoMethods(slots[0]) : null,
      raw: snapshot(squad, 1),
      protoMethods: protoMethods(squad)
    };
  }

  // Server switch between the two formulas in UTSquadEntity._calculateRating.
  function ratingFloatMode() {
    const key = g("UTServerSettingsRepository")?.KEY?.SQUAD_RATING_FLOAT_CALCULATION_ENABLED;
    const v = callIfFn(g("services")?.Configuration, "checkFeatureEnabled", key);
    return typeof v === "boolean" ? v : null;
  }

  // formation name -> general positions, learned from every squad the app shows us. Lets the
  // solver estimate challenges that were never loaded (loading one marks it "In Progress").
  const learnedFormations = new Map();

  function learnFormation(squad) {
    const f = callIfFn(squad, "getFormation");
    if (isObj(f) && typeof f.name === "string" && Array.isArray(f.generalPositions) && f.generalPositions.length === 11) {
      learnedFormations.set(f.name, f.generalPositions.slice());
    }
  }

  // challenge id -> slot layout (positions, BRICK / CUSTOM_BRICK slots, custom brick cards),
  // learned whenever the app has loaded a challenge. Tile estimates for never-loaded challenges
  // use it, so e.g. a 10-player brick challenge isn't priced as 11 players.
  const learnedSlots = new Map();
  let slotsVersion = 0;

  function learnSlots(challenge, squadDump) {
    const skeleton = (squadDump?.slots || []).map((s) => {
      const playerType = s.requirement?.playerType || "DEFAULT";
      return { i: s.i, position: s.position, requirement: { playerType }, item: playerType === "CUSTOM_BRICK" ? s.item : null };
    });
    if (skeleton.length !== 11) return;
    const key = JSON.stringify(skeleton);
    if (learnedSlots.get(challenge.id)?.key === key) return;
    learnedSlots.set(challenge.id, { key, slots: skeleton });
    slotsVersion++;
  }

  function exportSlots() {
    return Object.fromEntries([...learnedSlots].map(([id, v]) => [id, v.slots]));
  }

  function seedSlots(progress, args) {
    for (const [id, slots] of Object.entries(args?.slots || {})) {
      if (!learnedSlots.has(Number(id)) && Array.isArray(slots)) {
        learnedSlots.set(Number(id), { key: JSON.stringify(slots), slots });
      }
    }
    return learnedSlots.size;
  }

  // Compact challenge snapshot for the solver (same shape as a Dump SBC file).
  function serializeChallenge(challenge) {
    if (isObj(challenge.squad)) learnFormation(challenge.squad);
    const squadDump = serializeSquad(challenge.squad, true);
    if (squadDump) learnSlots(challenge, squadDump);
    const keyNames = enumNameMap(g("SBCEligibilityKey"));
    const scopeNames = enumNameMap(g("SBCEligibilityScope"));
    const reqs = Array.isArray(challenge.eligibilityRequirements) ? challenge.eligibilityRequirements : [];
    return {
      kind: "sbc",
      challenge: {
        id: challenge.id,
        name: challenge.name,
        setId: challenge.setId,
        formation: challenge.formation,
        eligibilityOperation: challenge.eligibilityOperation
      },
      ratingFloatMode: ratingFloatMode(),
      requirements: reqs.map((r) => serializeRequirement(r, keyNames, scopeNames)),
      squad: squadDump || (learnedSlots.has(challenge.id) ? { slots: learnedSlots.get(challenge.id).slots } : null),
      formationPositions: isObj(challenge.squad) ? null : learnedFormations.get(challenge.formation) || null,
      brickChallenge: challenge.type === "BRICK_CHALLENGE"
    };
  }

  function dumpSbc(opts = {}) {
    const lite = typeof opts === "object" && !!opts.lite;
    const hits = findControllers().filter(({ node }) => isObj(node._challenge) || isObj(node.challenge));
    if (!hits.length) throw new Error("No controller with a challenge found. Open an SBC challenge (the squad screen) and retry.");
    const { node, path, className } = hits[0];
    const challenge = node._challenge || node.challenge;
    if (lite) return serializeChallenge(challenge);
    const keyNames = enumNameMap(g("SBCEligibilityKey"));
    const scopeNames = enumNameMap(g("SBCEligibilityScope"));
    const reqs = Array.isArray(challenge.eligibilityRequirements) ? challenge.eligibilityRequirements : [];
    const set = node._set || node._sbcSet || node.set || null;
    return {
      kind: "sbc",
      capturedAt: new Date().toISOString(),
      controller: { path, className, otherHits: hits.slice(1).map((h) => h.path) },
      enums: { SBCEligibilityKey: g("SBCEligibilityKey") ?? null, SBCEligibilityScope: g("SBCEligibilityScope") ?? null },
      challenge: {
        id: challenge.id,
        name: challenge.name,
        setId: challenge.setId,
        formation: challenge.formation,
        eligibilityOperation: challenge.eligibilityOperation,
        raw: snapshot(challenge, 1),
        protoMethods: protoMethods(challenge)
      },
      set: set ? snapshot(set, 1) : null,
      ratingFloatMode: ratingFloatMode(),
      requirements: reqs.map((r) => serializeRequirement(r, keyNames, scopeNames)),
      squad: serializeSquad(challenge.squad, lite)
    };
  }

  // Every challenge the app has already loaded (open a few SBCs first). No network calls.
  function dumpAllSbcs() {
    const repo = g("services")?.SBC?.repository;
    if (!isObj(repo)) throw new Error("services.SBC.repository not found");
    const keyNames = enumNameMap(g("SBCEligibilityKey"));
    const scopeNames = enumNameMap(g("SBCEligibilityScope"));
    const challenges = new Map();
    const sets = new Map();
    const seen = new WeakSet();
    const walk = (node, depth) => {
      if (!isObj(node) || seen.has(node) || depth > 6) return;
      if (typeof Node !== "undefined" && node instanceof Node) return;
      seen.add(node);
      if (Array.isArray(node.eligibilityRequirements) && node.id !== undefined) {
        challenges.set(node.id, node);
        return;
      }
      if (isObj(node.challenges) && node.id !== undefined && typeof node.name === "string") sets.set(node.id, node);
      const children = Array.isArray(node) ? node : node instanceof Map ? Array.from(node.values()) : Object.values(node);
      for (const child of children) walk(child, depth + 1);
    };
    walk(repo, 0);
    if (!challenges.size) throw new Error("No loaded challenges found. Open a few SBCs, then retry.");
    return {
      kind: "sbc-all",
      capturedAt: new Date().toISOString(),
      enums: { SBCEligibilityKey: g("SBCEligibilityKey") ?? null, SBCEligibilityScope: g("SBCEligibilityScope") ?? null },
      sets: Array.from(sets.values()).map((st) => ({ id: st.id, name: st.name, challengesCount: st.challengesCount })),
      challenges: Array.from(challenges.values()).map((ch) => ({
        challenge: {
          id: ch.id,
          name: ch.name,
          setId: ch.setId,
          formation: ch.formation,
          type: ch.type,
          eligibilityOperation: ch.eligibilityOperation
        },
        requirements: ch.eligibilityRequirements.map((r) => serializeRequirement(r, keyNames, scopeNames)),
        squad: isObj(ch.squad) ? serializeSquad(ch.squad) : null
      }))
    };
  }

  // Source of the app's own team-rating code, to read the exact rounding rule. Read-only.
  function ratingCode() {
    const MAX_LEN = 6000;
    const hits = [];
    const seenFns = new Set();
    const consider = (owner, name, fn) => {
      if (typeof fn !== "function" || seenFns.has(fn)) return;
      let src;
      try {
        src = Function.prototype.toString.call(fn);
      } catch {
        return;
      }
      const byName = /rating/i.test(name) && /squad|chem|sbc/i.test(owner);
      const byBody = /rating/i.test(src) && /Math\.(floor|round|ceil)|toFixed|\|\s*0\b/.test(src) && /\b11\b|length/.test(src);
      if (!byName && !byBody) return;
      seenFns.add(fn);
      hits.push({ owner, name, byName, byBody, length: src.length, source: src.slice(0, MAX_LEN) });
    };
    let names = [];
    try {
      names = Object.getOwnPropertyNames(window);
    } catch {
      /* ignore */
    }
    for (const n of names) {
      if (!/^UT[A-Z]/.test(n)) continue;
      const cls = g(n);
      if (typeof cls !== "function") continue;
      for (const target of [cls, cls.prototype]) {
        if (!isObj(target) && typeof target !== "function") continue;
        for (const k of Object.getOwnPropertyNames(target)) {
          if (k === "constructor" || k === "prototype" || k === "caller" || k === "arguments") continue;
          let d;
          try {
            d = Object.getOwnPropertyDescriptor(target, k);
          } catch {
            continue;
          }
          if (d) consider(n, k, d.value || d.get);
        }
      }
      if (hits.length >= 60) break;
    }
    return { kind: "rating-code", capturedAt: new Date().toISOString(), count: hits.length, hits };
  }

  // Everything the solver needs, read from the app's memory. Read-only.
  async function solveInput(progress) {
    const sbc = dumpSbc({ lite: true }); // fails fast when no SBC is open
    const club = await dumpClub(progress, { lite: true });
    return { sbc, club };
  }

  // ---------- auto-fill (Phase 3) ----------
  // Places a solved squad with the app's own squad methods, saves it once, never submits.

  const FILL_PAUSE_MS = [500, 1100]; // human-ish pause before the single save
  let lastFill = null; // [{ challengeId, original: items per slot }] for Undo
  const setChallenges = new Map(); // challenge id -> loaded challenge entity (whole-set fills)

  function currentChallenge() {
    const hit = findControllers().find(({ node }) => isObj(node._challenge) || isObj(node.challenge));
    return hit ? hit.node._challenge || hit.node.challenge : null;
  }

  function emptyItem() {
    const Item = g("UTItemEntity");
    if (typeof Item !== "function") throw new Error("UTItemEntity not found");
    return new Item();
  }

  async function applySquad(challenge, items, progress, label) {
    const squad = challenge.squad;
    progress(`${label}…`);
    await sleep(jitter(FILL_PAUSE_MS));
    squad.removeAllItems();
    squad.setPlayers(items, true);
    progress("Saving squad…");
    const res = await observeOnce(g("services").SBC.saveChallenge(challenge));
    if (!res?.success) throw new Error(`save rejected (status ${res?.status ?? "?"})`);
    callIfFn(challenge.onDataChange, "notify", { squad });
  }

  function squadState(challenge) {
    const squad = challenge.squad;
    return {
      rating: callIfFn(squad, "getRating"),
      chemistry: callIfFn(squad, "getChemistry"),
      meetsRequirements: callIfFn(challenge, "meetsRequirements"),
      canSubmit: callIfFn(challenge, "canSubmit")
    };
  }

  function itemsById() {
    const byId = new Map();
    [...clubCache(), ...storageCache(), ...(sessionMemo.storage || []), ...unassignedPlayers(), ...transferDuplicates()]
      .forEach((it) => it?.id && byId.set(it.id, it));
    return byId;
  }

  function pileValues(pile) {
    try {
      const v = g("repositories")?.Item?.[pile]?.values?.();
      return v ? Array.from(v) : [];
    } catch {
      return [];
    }
  }

  const isPlayerCard = (it) => it?.type === "player" || callIfFn(it, "isPlayer") === true;

  // Unassigned pile (cached by the app once you've visited it).
  function unassignedPlayers() {
    return pileValues("unassigned").filter(isPlayerCard);
  }

  // Transfer-list duplicates that aren't currently listed for sale.
  function transferDuplicates() {
    return pileValues("transfer").filter((it) => {
      if (!isPlayerCard(it) || callIfFn(it, "isDuplicate") !== true) return false;
      const state = it._auction?._tradeState ?? callIfFn(it, "getAuctionData")?._tradeState;
      return !state || state === "inactive" || state === "expired";
    });
  }

  function checkFillable(challenge) {
    const squad = challenge?.squad;
    for (const m of ["getPlayers", "removeAllItems", "setPlayers"]) {
      if (typeof squad?.[m] !== "function") throw new Error(`${challenge?.name || "challenge"}: squad.${m} missing`);
    }
    if (typeof g("services")?.SBC?.saveChallenge !== "function") throw new Error("services.SBC.saveChallenge missing");
  }

  // Items per slot: solver's players in their slots, bricks kept, every other slot emptied.
  function plannedItems(challenge, planSlots, byId) {
    const slots = challenge.squad.getPlayers();
    const original = slots.map((s) => s.getItem());
    const planned = slots.map((slot, i) => (isFixedSlot(slot) ? original[i] : emptyItem()));
    for (const { slotIndex, playerId } of planSlots) {
      const item = byId.get(playerId);
      if (!item) throw new Error(`player ${playerId} is no longer in your club; press Solve again`);
      if (!slots[slotIndex] || !isObj(slots[slotIndex].position)) throw new Error(`slot ${slotIndex} not in this formation`);
      planned[slotIndex] = item;
    }
    return { original, planned };
  }

  // Brick and custom-brick slots (locked placeholders) and subs/reserves are never touched.
  function isFixedSlot(slot) {
    if (!isObj(slot?.position)) return true;
    if (callIfFn(slot, "isBrick") === true || callIfFn(slot, "isCustomBrick") === true) return true;
    const type = slot.requirement?.playerType;
    return typeof type === "string" && type !== "DEFAULT";
  }

  function wrongSlots(challenge, planSlots) {
    const placed = challenge.squad.getPlayers();
    return planSlots.filter(({ slotIndex, playerId }) => placed[slotIndex]?.getItem()?.id !== playerId).map((w) => w.slotIndex);
  }

  async function fillSquad(progress, args) {
    const challenge = currentChallenge();
    if (!challenge) throw new Error("Open the SBC's squad screen first.");
    if (challenge.id !== args?.challengeId) throw new Error("A different SBC is open now. Press Solve again.");
    const squad = challenge.squad;
    checkFillable(challenge);
    const { original, planned } = plannedItems(challenge, args.slots, itemsById());

    lastFill = [{ challengeId: challenge.id, original }];
    try {
      await applySquad(challenge, planned, progress, "Placing players");
    } catch (e) {
      try {
        squad.removeAllItems();
        squad.setPlayers(original, true);
      } catch {
        /* keep the original error */
      }
      lastFill = null;
      throw new Error(`Fill failed and was rolled back: ${e.message}`);
    }

    return { ...squadState(challenge), wrongSlots: wrongSlots(challenge, args.slots) };
  }

  // The live entity for a challenge: the open screen's own object if it's the open one.
  function challengeEntity(id) {
    const open = currentChallenge();
    return open && open.id === id ? open : setChallenges.get(id);
  }

  async function undoFill(progress) {
    if (!lastFill?.length) throw new Error("Nothing to undo.");
    for (const { challengeId, original } of lastFill) {
      const challenge = challengeEntity(challengeId);
      if (!challenge) throw new Error("Open the SBC (or its set) that was filled to undo it.");
      await applySquad(challenge, original, progress, `Restoring ${challenge.name}`);
    }
    lastFill = null;
    const open = currentChallenge();
    return open ? squadState(open) : {};
  }

  // ---------- whole SBC set ----------

  const SET_LOAD_PAUSE_MS = [300, 700]; // between challenge loads, one request at a time

  function currentSet(challenge) {
    const repo = g("services")?.SBC?.repository;
    return callIfFn(repo, "getSetById", challenge?.setId) || null;
  }

  // How many more times a repeatable SBC can be completed, or null when unlimited/unknown.
  // The set holds the limit: `repeats` per window (REFRESH mode resets every refreshInterval
  // seconds) and `timesCompleted` so far; the challenge's own timesCompleted is lifetime.
  function repeatsLeft(ch, set) {
    if (ch?.repeatable !== true || !isObj(set)) return null;
    if (/UNLIMITED/i.test(String(set.repeatabilityMode ?? ""))) return null;
    const repeats = Number(set.repeats);
    if (!Number.isFinite(repeats) || repeats <= 0) return null;
    return Math.max(0, repeats - (Number(set.timesCompleted) || 0));
  }

  function squadCount(squad) {
    const slots = callIfFn(squad, "getPlayers");
    if (!Array.isArray(slots)) return null;
    return slots.slice(0, 11).filter((s) => Number(callIfFn(s, "getItem")?.id) > 0).length;
  }

  const isSetEntity = (v) =>
    isObj(v) && typeof v.name === "string" && typeof v.challengesCount === "number" && isObj(v.challenges);

  // Controllers on the visible path only (not other tabs' stacks).
  function activeControllers() {
    const out = [];
    let layer = [appMain()?._rootViewController].filter(isObj);
    for (let depth = 0; depth < 8 && layer.length; depth++) {
      const next = [];
      for (const node of layer) {
        out.push(node);
        for (const k of ["currentController", "leftController", "rightController", "presentedViewController", "_presentedViewController"]) {
          let v;
          try {
            v = node[k];
          } catch {
            continue;
          }
          if (isObj(v) && !out.includes(v)) next.push(v);
        }
      }
      layer = next;
    }
    return out;
  }

  // The set whose overview page is open (no challenge squad open).
  function setOnScreen() {
    for (const node of activeControllers()) {
      const cls = node.className || ctorName(node) || "";
      if (!/SBC/.test(cls) || /Hub/.test(cls)) continue;
      for (const key of Object.keys(node)) {
        let v;
        try {
          v = node[key];
        } catch {
          continue;
        }
        if (isSetEntity(v)) return v;
        if (isObj(v) && !Array.isArray(v) && !(typeof Node !== "undefined" && v instanceof Node)) {
          for (const k2 of Object.keys(v)) {
            let w;
            try {
              w = v[k2];
            } catch {
              continue;
            }
            if (isSetEntity(w)) return w;
          }
        }
      }
    }
    return null;
  }

  // Loads every unfinished challenge of the open SBC's set (same requests as opening them).
  async function setInput(progress) {
    const services = g("services");
    const open = currentChallenge();
    const set = open ? currentSet(open) : setOnScreen();
    if (!isObj(set)) throw new Error("Couldn't find this SBC's set.");
    progress(`Loading ${set.name}…`);
    const listed = await observeOnce(services.SBC.requestChallengesForSet(set));
    const list = listed?.data?.challenges || listed?.response?.challenges;
    if (!listed?.success || !Array.isArray(list)) throw new Error("Couldn't load the set's challenges.");
    const todo = list.filter((c) => callIfFn(c, "isCompleted") !== true);
    if (!todo.length) throw new Error("Every challenge in this set is already completed.");

    setChallenges.clear();
    const out = [];
    for (const [n, ch] of todo.entries()) {
      let entity = open && ch.id === open.id ? open : ch;
      if (!isObj(entity.squad)) {
        progress(`Loading challenge ${n + 1} of ${todo.length}: ${ch.name}…`);
        await sleep(jitter(SET_LOAD_PAUSE_MS));
        const res = await observeOnce(services.SBC.loadChallenge(ch));
        if (!res?.success || !isObj(ch.squad)) throw new Error(`Couldn't load "${ch.name}".`);
        entity = ch;
        const cached = callIfFn(set, "getChallenge", ch.id);
        if (isObj(cached) && !isObj(cached.squad)) callIfFn(cached, "update", ch);
      }
      setChallenges.set(entity.id, entity);
      out.push(serializeChallenge(entity));
    }
    const club = await dumpClub(progress, { lite: true });
    return { setName: set.name, sbcs: out, club };
  }

  async function fillSet(progress, args) {
    const plan = Array.isArray(args?.plan) ? args.plan : [];
    if (!plan.length) throw new Error("Nothing to fill.");
    const byId = itemsById();
    const openId = currentChallenge()?.id;
    // Check everything before touching anything; fill the open challenge last so its screen updates at the end.
    const steps = plan.map(({ challengeId, slots }) => {
      const challenge = challengeEntity(challengeId);
      if (!challenge) throw new Error("The set changed. Press Fill whole set again.");
      checkFillable(challenge);
      return { challenge, slots, ...plannedItems(challenge, slots, byId) };
    }).sort((a, b) => (a.challenge.id === openId) - (b.challenge.id === openId));

    lastFill = [];
    const results = [];
    for (const [n, step] of steps.entries()) {
      try {
        await applySquad(step.challenge, step.planned, progress, `Filling ${n + 1} of ${steps.length}: ${step.challenge.name}`);
      } catch (e) {
        try {
          step.challenge.squad.removeAllItems();
          step.challenge.squad.setPlayers(step.original, true);
        } catch {
          /* keep the original error */
        }
        results.push({ challengeId: step.challenge.id, ok: false, error: e.message });
        break; // stop at the first failure; earlier fills stay (Undo reverts them)
      }
      lastFill.push({ challengeId: step.challenge.id, original: step.original });
      results.push({
        challengeId: step.challenge.id,
        ok: true,
        ...squadState(step.challenge),
        wrongSlots: wrongSlots(step.challenge, step.slots)
      });
      if (n < steps.length - 1) await sleep(jitter(SET_LOAD_PAUSE_MS));
    }
    return { results };
  }

  // ---------- player details for the preview modal ----------

  function itemName(item) {
    const sd = item._staticData || {};
    return sd.knownAs && sd.knownAs !== "---" ? sd.knownAs : [sd.firstName, sd.lastName].filter((x) => x && x !== "---").join(" ") || sd.name || String(item.definitionId);
  }

  function describePlayers(progress, args) {
    const assets = g("AssetLocationUtils");
    const F = assets?.FILTER || {};
    const img = (type, id) => {
      if (type === undefined || typeof assets?.getFilterImage !== "function") return null;
      const url = callIfFn(assets, "getFilterImage", type, id);
      return typeof url === "string" && !url.startsWith("[threw") ? url : null;
    };
    const byId = itemsById();
    const out = {};
    for (const id of args?.ids || []) {
      const item = byId.get(id);
      if (!item) continue;
      const { price } = priceOf(item);
      out[id] = {
        name: itemName(item),
        rating: item.rating,
        tier: callIfFn(item, "getTier"),
        rareflag: item.rareflag,
        special: callIfFn(item, "isSpecial") === true,
        tradable: isTradableItem(item),
        storage: isStorageCard(item),
        price,
        img: {
          league: img(F.LEAGUE, item.leagueId),
          club: img(F.CLUB, item.teamId),
          nation: img(F.NATION, item.nationId),
          rarity: item.rareflag > 1 ? img(F.RARITY, item.rareflag) : null
        }
      };
    }
    return out;
  }

  // ---------- SBC hub tiles: club-based value per set ----------

  const TILE_PAUSE_MS = [400, 800]; // between set listings, one request at a time
  const tileValues = new Map(); // set id -> { text, tone, title }
  let setsCache = null;
  let setsCacheAt = 0;

  function repoSets() {
    if (setsCache && Date.now() - setsCacheAt < 5000) return setsCache;
    const found = new Map();
    const seen = new WeakSet();
    const walk = (node, depth) => {
      if (!isObj(node) || seen.has(node) || depth > 5) return;
      if (typeof Node !== "undefined" && node instanceof Node) return;
      seen.add(node);
      if (isSetEntity(node) && node.id !== undefined) {
        found.set(node.id, node);
        return;
      }
      const kids = Array.isArray(node) ? node : node instanceof Map ? Array.from(node.values()) : Object.values(node);
      for (const k of kids) walk(k, depth + 1);
    };
    walk(g("services")?.SBC?.repository, 0);
    setsCache = Array.from(found.values());
    setsCacheAt = Date.now();
    return setsCache;
  }

  function onHubScreen() {
    return activeControllers().some((n) => /SBCHub/.test(n.className || ctorName(n) || ""));
  }

  // Tile title elements: text nodes whose whole text is a set name.
  function hubTileTitles() {
    const byName = new Map(repoSets().map((st) => [st.name.trim(), st]));
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const set = byName.get((n.nodeValue || "").trim());
      const el = n.parentElement;
      if (!set || !el || el.closest("#sbcs, #sbcs-modal, .sbcs-tile")) continue;
      out.push({ set, el });
    }
    return out;
  }

  function ensureTileStyle() {
    if (document.getElementById("sbcs-tile-style")) return;
    const st = document.createElement("style");
    st.id = "sbcs-tile-style";
    st.textContent = `.sbcs-tile{display:inline-flex;align-items:center;margin-left:10px;padding:1px 8px;border-radius:9px;
      font:700 12.5px/1.5 system-ui,sans-serif;color:#ffd45a;background:#0b0f16d9;border:1px solid #ffd45a55;
      vertical-align:middle;white-space:nowrap}
      .sbcs-tile.warn{color:#ffc857;border-color:#ffc85755} .sbcs-tile.bad{color:#aeb6c0;border-color:#aeb6c055}
      .sbcs-tile.pending{color:#aeb6c0;border-color:#aeb6c033;font-weight:600}`;
    document.head.appendChild(st);
  }

  function renderTileBadges(titles) {
    ensureTileStyle();
    for (const { set, el } of titles) {
      const v = tileValues.get(set.id);
      let badge = el.parentElement?.querySelector(`:scope > .sbcs-tile[data-set="${set.id}"]`);
      if (!v || !overlayOn) {
        badge?.remove();
        continue;
      }
      if (!badge) {
        badge = document.createElement("span");
        badge.dataset.set = String(set.id);
        el.after(badge);
      }
      badge.className = `sbcs-tile ${v.tone || ""}`;
      badge.textContent = v.text;
      badge.title = v.title || "";
    }
  }

  function setTileValue(progress, args) {
    if (args?.setId === undefined) return false;
    if (args.clear) tileValues.delete(args.setId);
    else tileValues.set(args.setId, { text: String(args.text), tone: args.tone, title: args.title });
    return true;
  }

  function seedFormations(progress, args) {
    for (const [name, positions] of Object.entries(args?.formations || {})) {
      if (!learnedFormations.has(name) && Array.isArray(positions) && positions.length === 11) learnedFormations.set(name, positions);
    }
    return learnedFormations.size;
  }

  // Lists a set's challenges (same request as opening the set page; nothing is loaded or started).
  async function tileInput(progress, args) {
    const set = repoSets().find((st) => st.id === args?.setId);
    if (!set) throw new Error("set not found");
    await sleep(jitter(TILE_PAUSE_MS));
    const listed = await observeOnce(g("services").SBC.requestChallengesForSet(set));
    const list = listed?.data?.challenges || listed?.response?.challenges;
    if (!listed?.success || !Array.isArray(list)) throw new Error("couldn't list the set");
    const todo = list.filter((c) => callIfFn(c, "isCompleted") !== true);
    return { setId: set.id, sbcs: todo.map(serializeChallenge) };
  }

  // ---------- recon: where does FC 27 keep the FUT Gallery item score? ----------

  function galleryProbe() {
    const MATCH = /galler|showcase|score|holo/i;
    const services = g("services");
    const repos = g("repositories");
    let names = [];
    try {
      names = Object.getOwnPropertyNames(window);
    } catch {
      /* ignore */
    }
    const classes = {};
    const sources = [];
    for (const n of names) {
      if (!/^UT[A-Z]/.test(n)) continue;
      const cls = g(n);
      if (typeof cls !== "function") continue;
      const methods = protoMethods(cls.prototype).filter((m) => MATCH.test(m));
      if (MATCH.test(n) || methods.length) classes[n] = MATCH.test(n) ? protoMethods(cls.prototype) : methods;
      for (const m of methods) {
        try {
          const src = Function.prototype.toString.call(cls.prototype[m]);
          if (sources.length < 60) sources.push({ owner: n, name: m, source: src.slice(0, 3000) });
        } catch {
          /* ignore */
        }
      }
    }
    const item = clubCache().find((it) => it?.type === "player");
    const itemHits = {};
    if (item) {
      let p = item;
      while (p && p !== Object.prototype) {
        for (const k of Object.getOwnPropertyNames(p)) {
          if (!MATCH.test(k) || k in itemHits) continue;
          let v;
          try {
            v = typeof item[k] === "function" ? `fn(${item[k].length})` : snapshot(item[k], 1);
          } catch (e) {
            v = `[threw ${e.message}]`;
          }
          itemHits[k] = v;
        }
        p = Object.getPrototypeOf(p);
      }
    }
    return {
      kind: "gallery-probe",
      capturedAt: new Date().toISOString(),
      showcaseService: isObj(services?.Showcase) ? { methods: protoMethods(services.Showcase), state: snapshot(services.Showcase, 2) } : null,
      matchingServices: Object.keys(services || {}).filter((k) => MATCH.test(k)),
      matchingRepositories: Object.fromEntries(Object.keys(repos || {}).filter((k) => MATCH.test(k)).map((k) => [k, snapshot(repos[k], 3)])),
      classes,
      sources,
      sampleItem: item ? { definitionId: item.definitionId, rating: item.rating, hits: itemHits } : null
    };
  }

  // ---------- "Auto Complete" button in the app's own SBC sidebar ----------
  // Inserted above the app's first sidebar button (Exchange Players / Go to Challenge). Clicking
  // it asks content.js to open the auto-complete options. Re-inserted if the app re-renders.

  const squash = (t) => String(t).replace(/\s+/g, " ").trim().toLowerCase();

  // The requirements panel shows the challenge's description or requirement lines. Other
  // right-panel screens hold the challenge too (Player Details after tapping a card) but show
  // neither, so the button never lands there.
  function showsChallenge(root, ch) {
    const texts = [ch.description, ...(ch.eligibilityRequirements || []).map(requirementText)]
      .filter((t) => typeof t === "string" && t.trim().length > 3)
      .map(squash);
    if (!texts.length) return false;
    const page = squash(root.textContent || "");
    return texts.some((t) => page.includes(t));
  }

  function sidebarRoot(scope) {
    for (const node of activeControllers()) {
      const cls = node.className || ctorName(node) || "";
      const ch = isObj(node._challenge) ? node._challenge : isObj(node.challenge) ? node.challenge : null;
      const fits = scope === "challenge" ? ch && !/Overview/.test(cls) : /SBC/.test(cls) && !/Hub|Overview/.test(cls);
      if (!fits) continue;
      const root = callIfFn(node, "getView")?.__root;
      if (!root || !root.isConnected || !root.querySelector("button")) continue;
      if (scope === "challenge" && !showsChallenge(root, ch)) continue;
      return root;
    }
    return null;
  }

  function ensureSidebarStyle() {
    if (document.getElementById("sbcs-side-style")) return;
    const st = document.createElement("style");
    st.id = "sbcs-side-style";
    st.textContent = `.sbcs-side{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;box-sizing:border-box;
      background:#0b0f16;color:#3ddc84;border:2px solid #27b36a;cursor:pointer;font-weight:600}
      .sbcs-side:hover{background:#12301f}
      .sbcs-side[disabled]{opacity:.5;cursor:default}`;
    document.head.appendChild(st);
  }

  // Returns true when our button is on screen.
  function ensureSidebarButton(scope, label) {
    const root = sidebarRoot(scope);
    // Drop ours from anywhere else (e.g. left behind when the panel switched screens).
    document.querySelectorAll(".sbcs-side").forEach((b) => {
      if (!root || !root.contains(b)) b.remove();
    });
    if (!root) return false;
    const existing = root.querySelector(".sbcs-side");
    if (existing) {
      if (existing.textContent !== label) existing.textContent = label;
      return true;
    }
    const ref = [...root.querySelectorAll("button")].find((b) => b.offsetHeight > 24 && !b.closest(".sbcs-side"));
    if (!ref) return false;
    ensureSidebarStyle();
    const cs = getComputedStyle(ref);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sbcs-side";
    btn.textContent = label;
    Object.assign(btn.style, {
      height: `${ref.offsetHeight}px`,
      borderRadius: cs.borderRadius,
      fontSize: cs.fontSize,
      fontFamily: cs.fontFamily,
      marginBottom: cs.marginBottom !== "0px" ? cs.marginBottom : "10px"
    });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.postMessage({ ns: NS, dir: "event", type: "autoComplete", scope }, location.origin);
    });
    ref.parentElement.insertBefore(btn, ref);
    return true;
  }

  // ---------- context (polled by the panel) ----------

  function context() {
    if (overlayOn && installSquadValue()) renderSquadValue(); // fallback refresh
    const formations = Object.fromEntries(learnedFormations);
    if (onHubScreen()) {
      document.querySelectorAll(".sbcs-side").forEach((b) => b.remove());
      const titles = hubTileTitles();
      renderTileBadges(titles);
      const ids = [...new Set(titles.filter(({ set }) => callIfFn(set, "isComplete") !== true).map(({ set }) => set.id))];
      return { onSbc: false, onHub: true, hubSets: ids, formations, slotsVersion };
    }
    const ch = currentChallenge();
    if (!ch) {
      const overview = setOnScreen();
      if (!overview) {
        document.querySelectorAll(".sbcs-side").forEach((b) => b.remove());
        return { onSbc: false, formations };
      }
      return {
        onSbc: false,
        onSet: true,
        sidebarButton: ensureSidebarButton("set", "Auto Complete Set"),
        setId: overview.id,
        setName: overview.name,
        setChallenges: overview.challengesCount,
        setCompleted: overview.challengesCompletedCount,
        canUndo: !!lastFill?.length,
        formations
      };
    }
    if (isObj(ch.squad)) {
      learnFormation(ch.squad);
      learnSlots(ch, serializeSquad(ch.squad, true));
    }
    const set = currentSet(ch);
    return {
      formations,
      slotsVersion,
      sidebarButton: ensureSidebarButton("challenge", "Auto Complete"),
      repeatable: ch.repeatable === true,
      repeatsLeft: repeatsLeft(ch, set),
      // Lets the panel drop a stale result once the squad is submitted or cleared.
      timesCompleted: Number(ch.timesCompleted) || 0,
      challengeStatus: ch.status ?? null,
      squadCount: squadCount(ch.squad),
      repeats: Number(set?.repeats) || null,
      onSbc: true,
      challengeId: ch.id,
      challengeName: ch.name,
      setId: ch.setId,
      setName: set?.name ?? null,
      setChallenges: set?.challengesCount ?? null,
      setCompleted: set?.challengesCompletedCount ?? null,
      canUndo: !!lastFill?.length
    };
  }

  // ---------- price overlay on player cards ----------

  let overlayOn = false;
  let overlayPatched = false;

  function formatCoins(v) {
    if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
    if (v >= 1e4) return `${Math.round(v / 1e3)}k`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
    return String(v);
  }

  function ensureOverlayStyle() {
    if (document.getElementById("sbcs-price-style")) return;
    const st = document.createElement("style");
    st.id = "sbcs-price-style";
    // Inside the card's top-right corner: the app's card containers clip anything outside the card.
    // Row 1: coins · tradeable/untradeable · SBC storage. Row 2: gallery score.
    st.textContent = `.sbcs-badges{position:absolute;right:4%;top:3%;z-index:20;display:flex;flex-direction:column;
        align-items:flex-end;gap:2px;pointer-events:none}
      .sbcs-badges .r{display:flex;gap:2px}
      .sbcs-badges .b{display:flex;align-items:center;justify-content:center;gap:2px;background:#0b0f16f0;
        font:700 10px/1.45 system-ui,sans-serif;border-radius:8px;white-space:nowrap;box-shadow:0 1px 2px #0008;
        border:1.5px solid}
      .sbcs-badges .coin{color:#f5c518;border-color:#f5c518;padding:0 5px}
      .sbcs-badges .coin.est{border-style:dashed}
      .sbcs-badges .dot{width:17px;height:17px;border-radius:50%;padding:0}
      .sbcs-badges .trade{color:#3ddc84;border-color:#27b36a;font-weight:800}
      .sbcs-badges .untrade{border-color:#8a929c}
      .sbcs-badges .store{border-color:#2f9bff}
      .sbcs-badges .gal{color:#8ce6d6;border-color:#8ce6d6;padding:0 5px}
      .sbcs-badges svg{width:10px;height:10px;flex:none}
      .sbcs-badges.below{right:auto;top:auto;align-items:center;transform:translateX(-50%)}`;
    document.head.appendChild(st);
  }

  // Green $ = tradeable (could be sold); grey 🚫 = untradeable; blue can = from SBC storage.
  const NS_SVG = "http://www.w3.org/2000/svg";

  function svgIcon(children) {
    const svg = document.createElementNS(NS_SVG, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    for (const [tag, attrs] of children) {
      const node = document.createElementNS(NS_SVG, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
      svg.append(node);
    }
    return svg;
  }

  const UNTRADEABLE_ICON = [
    ["circle", { cx: 8, cy: 8, r: 6.6, fill: "none", stroke: "#b4bcc6", "stroke-width": 1.6 }],
    ["line", { x1: 3.4, y1: 3.4, x2: 12.6, y2: 12.6, stroke: "#b4bcc6", "stroke-width": 1.8, "stroke-linecap": "round" }]
  ];
  const STORAGE_ICON = [
    ["path", { d: "M3.5 4v8c0 1.4 2 2.5 4.5 2.5s4.5-1.1 4.5-2.5V4z", fill: "#2f7df6" }],
    ["ellipse", { cx: 8, cy: 4, rx: 4.5, ry: 2.2, fill: "#6aa8ff" }]
  ];

  const GALLERY_ICON = [["path", { d: "M8 1.5 14.5 8 8 14.5 1.5 8z", fill: "#8ce6d6" }]];

  // FUT Gallery item score. Where FC 27 keeps it is still unknown (see galleryProbe); these are
  // guesses, and the row stays hidden until one returns a number.
  function galleryScore(item) {
    for (const name of ["getGalleryScore", "getShowcaseScore", "getItemScore", "getScore"]) {
      const v = callIfFn(item, name);
      if (typeof v === "number" && v > 0) return v;
    }
    for (const key of ["galleryScore", "showcaseScore", "itemScore", "score", "_galleryScore", "_score"]) {
      const v = item[key];
      if (typeof v === "number" && v > 0) return v;
    }
    return 0;
  }

  // EA gives SBC-storage items no market price (-1). Storage holds duplicates of club players,
  // so fall back to the price of a club item with the same definitionId.
  let clubPriceMap = null;
  let clubPriceAt = 0;

  function clubPrice(definitionId) {
    if (!clubPriceMap || Date.now() - clubPriceAt > 15000) {
      clubPriceMap = new Map();
      for (const it of clubCache()) {
        const p = callIfFn(it, "getMarketAverage");
        if (typeof p === "number" && p > 0 && it.definitionId) clubPriceMap.set(it.definitionId, p);
      }
      clubPriceAt = Date.now();
    }
    return clubPriceMap.get(definitionId) || 0;
  }

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

  // Same curve as the solver's (sbc-solver.js), from the club plus cards seen this session.
  let ratingCurve = null;
  let ratingCurveAt = 0;
  function ratingEstimate(item) {
    if (!ratingCurve || Date.now() - ratingCurveAt > 60000) {
      const samples = [];
      for (const it of clubCache()) {
        if (callIfFn(it, "isSpecial") === true) continue;
        const p = callIfFn(it, "getMarketAverage");
        if (typeof p === "number" && p > 0) samples.push([Number(it.rating) || 0, p]);
      }
      ratingCurve = ratingPriceCurve(samples);
      ratingCurveAt = Date.now();
    }
    const r = Number(item.rating) || 0;
    return ratingCurve(r) * (callIfFn(item, "isSpecial") === true ? 5 : 1);
  }

  // Every real EA price seen this session, by card version. The same card can appear as a
  // separate object without a price (e.g. a store preview tile vs. the pack's content list).
  const seenPrices = new Map();

  function rememberPrice(item) {
    const p = callIfFn(item, "getMarketAverage");
    if (typeof p === "number" && p > 0 && item?.definitionId) seenPrices.set(item.definitionId, p);
    return p;
  }

  let ownedIds = null;
  let ownedAt = 0;
  // Cached for a few seconds: this runs for every card the app draws.
  function isOwned(item) {
    if (!(item?.id > 0)) return false;
    if (!ownedIds || Date.now() - ownedAt > 5000) {
      ownedIds = new Set(itemsById().keys());
      ownedAt = Date.now();
    }
    return ownedIds.has(item.id);
  }

  // { price, source }: "ea" (market average), "seen" (EA price of the same card seen elsewhere),
  // "copy" (your club copy's price), "rating" (estimate; only for your own cards), "none".
  function priceOf(item) {
    const own = rememberPrice(item);
    if (typeof own === "number" && own > 0) return { price: own, source: "ea" };
    const seen = seenPrices.get(item.definitionId);
    if (seen) return { price: seen, source: "seen" };
    const copy = clubPrice(item.definitionId);
    if (copy > 0) return { price: copy, source: "copy" };
    if (isOwned(item)) return { price: ratingEstimate(item), source: "rating" };
    return { price: 0, source: "none" };
  }

  const PRICE_NOTE = {
    ea: "EA market average",
    seen: "EA market average (seen on another copy of this card)",
    copy: "price of your club copy (EA has none for storage items)",
    rating: "estimate: median EA price of your cards with this rating (EA has none for this card)"
  };

  function isStorageCard(item) {
    return callIfFn(item, "isStorageItem") === true;
  }

  function decorateCard(view, item) {
    const root = view?.__root;
    if (!root || !root.isConnected) return;
    root.querySelectorAll(":scope > .sbcs-badges").forEach((n) => n.remove());
    root.__sbcsWrap?.remove();
    root.__sbcsWrap = null;
    if (!overlayOn || !isObj(item) || item.type !== "player" || callIfFn(item, "isValid") === false) return;
    const { price, source } = priceOf(item);
    const tradable = isTradableItem(item);
    const bubble = (cls, title, ...children) => {
      const b = document.createElement("div");
      b.className = `b ${cls}`;
      b.title = title;
      b.append(...children);
      return b;
    };
    const wrap = document.createElement("div");
    wrap.className = "sbcs-badges";
    const row = document.createElement("div");
    row.className = "r";
    if (price) {
      row.append(bubble(source === "rating" ? "coin est" : "coin", `${price.toLocaleString("en-US")} coins · ${PRICE_NOTE[source]}`,
        document.createTextNode(`${source === "rating" ? "~" : ""}${formatCoins(price)}`)));
    }
    row.append(tradable
      ? bubble("dot trade", "Tradeable (could be sold)", document.createTextNode("$"))
      : bubble("dot untrade", "Untradeable (can't be sold)", svgIcon(UNTRADEABLE_ICON)));
    if (isStorageCard(item)) row.append(bubble("dot store", "From SBC storage", svgIcon(STORAGE_ICON)));
    wrap.append(row);
    const score = galleryScore(item);
    if (score) {
      const row2 = document.createElement("div");
      row2.className = "r";
      row2.append(bubble("gal", "FUT Gallery item score", svgIcon(GALLERY_ICON), document.createTextNode(score.toLocaleString("en-US"))));
      wrap.append(row2);
    }
    if (getComputedStyle(root).position === "static") root.style.position = "relative";
    root.appendChild(wrap);
    root.__sbcsWrap = wrap;
    watchBadges(root, wrap);
  }

  // Another extension's marker can land on our top-right row, sometimes drawn
  // after ours. Only geometry is used, nothing of theirs is read: if a small visible element
  // (not ours, not the card art) covers our row, slide the row left of it, or below it when
  // there's no room. Re-checked while the card's DOM changes for a few seconds.
  const OVERLAY_WATCH_MS = 15000;

  function paints(n) {
    if (/^(IMG|SVG|CANVAS|VIDEO)$/i.test(n.tagName)) return true;
    for (const c of n.childNodes) if (c.nodeType === 3 && c.textContent.trim()) return true;
    const cs = getComputedStyle(n);
    if (cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    if (cs.backgroundImage !== "none") return true;
    const bg = cs.backgroundColor.match(/[\d.]+/g);
    return !!bg && (bg.length < 4 || Number(bg[3]) > 0);
  }

  function overlayRects(root, wrap, card) {
    const scope = [...root.querySelectorAll("*")];
    const parent = root.parentElement;
    if (parent && parent.childElementCount <= 5) {
      for (const sib of parent.children) if (sib !== root) scope.push(sib, ...sib.querySelectorAll("*"));
    }
    // Marker-sized only: the card art, headshot and big containers are larger or taller.
    const maxArea = 0.15 * card.width * card.height;
    const maxHeight = 0.35 * card.height;
    const out = [];
    for (const n of scope) {
      if (wrap.contains(n) || n.contains(wrap)) continue;
      const b = n.getBoundingClientRect();
      if (!b.width || !b.height || b.width * b.height > maxArea || b.height > maxHeight) continue;
      out.push([n, b]);
    }
    return out;
  }

  // On the squad pitch the app draws the slot's position pill (e.g. "CM") centered under the
  // card; other extensions often put their stats on the card there. So on the pitch our row goes centered below
  // the pill; everywhere else (club lists, search) it stays in the card's top-right corner.
  const PITCH_POSITIONS = new Set(["GK", "RB", "RWB", "CB", "LB", "LWB", "CDM", "CM", "CAM", "RM", "LM", "RW", "LW", "CF", "ST"]);

  const PILL_SCOPE_MAX = 250;

  function pitchLabel(root) {
    const card = root.getBoundingClientRect();
    if (!card.width) return null;
    // The pill is within a slot's few elements; stop before a whole list/pitch (keeps big club
    // lists cheap).
    let scope = root;
    for (let up = 0; up < 3 && scope.parentElement && scope.parentElement.getElementsByTagName("*").length <= PILL_SCOPE_MAX; up++) {
      scope = scope.parentElement;
    }
    const cx = card.left + card.width / 2;
    for (const n of scope.querySelectorAll("*")) {
      if (n.childElementCount || n.closest(".sbcs-badges") || !PITCH_POSITIONS.has((n.textContent || "").trim())) continue;
      const b = n.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      // Centered under the card (the card's own position text sits top-left, so it never matches).
      if (Math.abs(b.left + b.width / 2 - cx) > 0.2 * card.width) continue;
      if (b.top < card.top + 0.5 * card.height || b.top > card.bottom + card.height) continue;
      return n;
    }
    return null;
  }

  const clips = (el) => {
    const cs = getComputedStyle(el);
    return cs.overflow !== "visible" || cs.overflowX !== "visible" || cs.overflowY !== "visible";
  };

  // Host: the nearest ancestor holding both the card and the pill, climbing past any ancestor
  // whose clipping would cut the row off.
  function placeBelow(root, wrap, label) {
    let host = root.parentElement;
    while (host && !host.contains(label)) host = host.parentElement;
    if (!host) return false;
    const want = () => {
      const card = root.getBoundingClientRect();
      const pill = label.getBoundingClientRect();
      return { x: card.left + card.width / 2, y: pill.bottom + 3 };
    };
    for (let tries = 0; tries < 6 && host; tries++) {
      if (wrap.parentElement !== host) host.appendChild(wrap);
      if (getComputedStyle(host).position === "static") host.style.position = "relative";
      wrap.classList.add("below");
      const h = host.getBoundingClientRect();
      const scale = host.offsetWidth ? h.width / host.offsetWidth : 1;
      const { x, y } = want();
      wrap.style.left = `${(x - h.left) / scale - host.clientLeft}px`;
      wrap.style.top = `${(y - h.top) / scale - host.clientTop}px`;
      wrap.style.right = "";
      const r = wrap.getBoundingClientRect();
      let clipper = null;
      for (let a = host; a && a !== document.body; a = a.parentElement) {
        if (!clips(a)) continue;
        const c = a.getBoundingClientRect();
        if (r.left < c.left - 1 || r.right > c.right + 1 || r.top < c.top - 1 || r.bottom > c.bottom + 1) clipper = a;
      }
      if (!clipper) return true;
      host = clipper.parentElement;
    }
    return true;
  }

  function placeCorner(root, wrap) {
    if (wrap.parentElement !== root) root.appendChild(wrap);
    wrap.classList.remove("below");
    wrap.style.left = "";
    placeBadges(root, wrap);
  }

  function layoutBadges(root, wrap) {
    if (!root.isConnected || root.__sbcsWrap !== wrap) {
      wrap.remove();
      return false;
    }
    const label = pitchLabel(root);
    if (label && placeBelow(root, wrap, label)) return true;
    placeCorner(root, wrap);
    return true;
  }

  // Rows moved out of the card (pitch) don't go away with it: sweep them when the card leaves.
  const floatingWraps = new Map(); // wrap -> card root
  let sweepTimer = null;
  let resizeHooked = false;
  function trackFloating(root, wrap) {
    floatingWraps.set(wrap, root);
    if (!resizeHooked) {
      resizeHooked = true;
      window.addEventListener("resize", () => requestAnimationFrame(() => {
        for (const [w, r] of floatingWraps) layoutBadges(r, w);
      }));
    }
    if (sweepTimer) return;
    sweepTimer = setInterval(() => {
      for (const [w, r] of floatingWraps) {
        if (!overlayOn || !r.isConnected || r.__sbcsWrap !== w || !w.isConnected) {
          w.remove();
          floatingWraps.delete(w);
        }
      }
      if (!floatingWraps.size) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
    }, 1000);
  }

  function placeBadges(root, wrap) {
    if (!wrap.isConnected) return false;
    wrap.style.right = "";
    wrap.style.top = "";
    const card = root.getBoundingClientRect();
    if (!card.width || !card.height) return true;
    const candidates = overlayRects(root, wrap, card);
    const hits = (r) => candidates.filter(([n, b]) =>
      b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top && paints(n)).map(([, b]) => b);
    let r = wrap.getBoundingClientRect();
    let found = hits(r);
    if (!found.length) return true;
    // Left of the covering element(s), if the row still fits inside the card.
    const baseRight = card.right - r.right;
    const shiftLeft = r.right - Math.min(...found.map((b) => b.left)) + 2;
    if (r.left - shiftLeft >= card.left + 2) {
      wrap.style.right = `${baseRight + shiftLeft}px`;
      if (!hits(wrap.getBoundingClientRect()).length) return true;
      wrap.style.right = "";
    }
    // Otherwise below them (a few passes in case there's a stack).
    const baseTop = r.top - card.top;
    let top = baseTop;
    for (let pass = 0; pass < 3 && found.length; pass++) {
      top = Math.max(top, ...found.map((b) => b.bottom - card.top + 2));
      wrap.style.top = `${top}px`;
      r = wrap.getBoundingClientRect();
      found = hits(r);
    }
    return true;
  }

  function watchBadges(root, wrap) {
    let queued = false;
    const run = () => {
      queued = false;
      if (!layoutBadges(root, wrap)) return obs.disconnect();
      if (wrap.parentElement !== root) trackFloating(root, wrap);
    };
    const obs = new MutationObserver((records) => {
      if (!wrap.isConnected) return obs.disconnect();
      const foreign = records.some((rec) => [...rec.addedNodes, ...rec.removedNodes].some((n) => n !== wrap && !wrap.contains(n)));
      if (foreign && !queued) {
        queued = true;
        requestAnimationFrame(run);
      }
    });
    obs.observe(root, { childList: true, subtree: true });
    if (root.parentElement) obs.observe(root.parentElement, { childList: true });
    setTimeout(() => obs.disconnect(), OVERLAY_WATCH_MS);
    requestAnimationFrame(run);
    // The pitch can still be animating in: settle the position a couple more times.
    setTimeout(run, 400);
    setTimeout(run, 1500);
  }

  // ---------- store pack preview: what the contents are worth ----------
  // Wraps UTStoreRevealModalListView.prototype.addItems (the "Pack Content" list; FSU wraps
  // the same method) and adds a summary box: EA market value, quick-sell value and profit vs.
  // the pack's coin price. Read-only: nothing is bought.

  const EA_TAX = 0.05;
  let packPatched = false;

  function packPrice(root) {
    // The coin price is on the pack's buy button (first button showing only a number).
    const modal = root.closest("[class*='modal'], [class*='Modal'], section, dialog") || document.body;
    for (const b of modal.querySelectorAll("button")) {
      const t = (b.textContent || "").trim().replace(/[\s,.]/g, "");
      if (/^\d{3,8}$/.test(t)) return Number(t);
    }
    return 0;
  }

  function packSummary(items) {
    const out = { count: 0, market: 0, marketItems: 0, quick: 0, best: 0, unpriced: 0 };
    for (const it of items || []) {
      if (!isObj(it)) continue;
      out.count++;
      const quick = Math.max(0, Number(it.discardValue) || 0);
      const { price } = priceOf(it);
      const tradable = callIfFn(it, "isTradeable") !== false && !(it.untradeableCount > 0);
      out.quick += quick;
      if (price > 0) {
        out.market += price;
        out.marketItems++;
      } else out.unpriced++;
      out.best += tradable && price > 0 ? Math.max(Math.round(price * (1 - EA_TAX)), quick) : quick;
    }
    return out;
  }

  function renderPackSummary(view, items) {
    const root = view?.__root;
    if (!root || !root.isConnected) return;
    root.querySelectorAll(":scope > .sbcs-pack").forEach((n) => n.remove());
    if (!overlayOn) return;
    const sum = packSummary(items);
    if (!sum.count) return;
    const price = packPrice(root);
    const box = document.createElement("div");
    box.className = "sbcs-pack";
    const line = (label, value, cls = "") => {
      const r = document.createElement("div");
      r.className = `ln ${cls}`;
      const a = document.createElement("span");
      a.textContent = label;
      const b = document.createElement("b");
      b.textContent = value;
      r.append(a, b);
      return r;
    };
    const f = (v) => v.toLocaleString("en-US");
    box.append(
      line(`Market value (${sum.marketItems} of ${sum.count} items priced)`, f(sum.market)),
      line("Quick-sell value", f(sum.quick)),
      line("Best sell-back (after 5% EA tax)", f(sum.best))
    );
    if (price) {
      const profit = sum.best - price;
      box.append(line(`vs. pack price ${f(price)}`, `${profit >= 0 ? "+" : ""}${f(profit)}`, profit >= 0 ? "up" : "down"));
    }
    box.title = "EA market averages and quick-sell values of the items shown. Best sell-back takes, per item, the higher of "
      + "market price minus EA's 5% tax or quick sell (untradeable items can only be quick-sold)."
      + (sum.unpriced ? ` ${sum.unpriced} item(s) have no market price and count at quick sell.` : "");
    root.prepend(box);
  }

  function installPackSummary() {
    if (packPatched) return;
    const View = g("UTStoreRevealModalListView");
    const orig = View?.prototype?.addItems;
    if (typeof orig !== "function") return;
    View.prototype.addItems = function (items, ...rest) {
      const out = orig.call(this, items, ...rest);
      const list = Array.isArray(items) ? items.slice() : [];
      list.forEach(rememberPrice);
      setTimeout(() => renderPackSummary(this, list), 0);
      return out;
    };
    if (!document.getElementById("sbcs-pack-style")) {
      const st = document.createElement("style");
      st.id = "sbcs-pack-style";
      st.textContent = `.sbcs-pack{margin:8px 12px;padding:8px 12px;border-radius:10px;background:#0b0f16e6;border:1px solid #f5c51855;
        font:600 13px/1.5 system-ui,sans-serif;color:#e8edf5}
        .sbcs-pack .ln{display:flex;justify-content:space-between;gap:12px}
        .sbcs-pack .ln b{color:#f5c518} .sbcs-pack .up b{color:#3ddc84} .sbcs-pack .down b{color:#ff6b6b}`;
      document.head.appendChild(st);
    }
    packPatched = true;
  }

  // ---------- live squad value in the SBC stats bar ----------
  // Sum of the card badges (EA market average) for the players in the open SBC squad. Updated
  // from the app's own squad-change methods, so manual edits and fills both refresh it.

  let statsView = null; // last UTSBCSquadStatsView instance (the Requirements / Rating / Chemistry bar)
  let valuePatched = false;
  let valueTimer = null;

  function isTradableItem(item) {
    return callIfFn(item, "isTradeable") !== false && item.untradeableCount === 0;
  }

  function squadValue(challenge) {
    const slots = callIfFn(challenge?.squad, "getPlayers");
    const out = { total: 0, tradable: 0, tradableCount: 0, players: 0, unpriced: 0 };
    if (!Array.isArray(slots)) return out;
    for (const slot of slots) {
      if (isFixedSlot(slot)) continue; // subs/reserves and (custom) bricks aren't your cards
      const item = callIfFn(slot, "getItem");
      if (!isObj(item) || !(item.id > 0) || item.type !== "player") continue;
      out.players++;
      const { price, source } = priceOf(item);
      if (source === "rating") out.estimated = (out.estimated || 0) + 1;
      if (!price) {
        out.unpriced++;
        continue;
      }
      out.total += price;
      if (isTradableItem(item)) {
        out.tradable += price;
        out.tradableCount++;
      }
    }
    return out;
  }

  function renderSquadValue() {
    const root = statsView?.__root;
    let box = document.getElementById("sbcs-value");
    const challenge = currentChallenge();
    if (!overlayOn || !root || !root.isConnected || !challenge) {
      box?.remove();
      return;
    }
    if (!box || box.parentNode !== root) {
      box?.remove();
      box = document.createElement("div");
      box.id = "sbcs-value";
      const label = document.createElement("div");
      label.className = "l";
      label.textContent = "Squad value";
      const value = document.createElement("div");
      value.className = "v";
      box.append(label, value);
      root.appendChild(box);
    }
    const v = squadValue(challenge);
    const valueEl = box.querySelector(".v");
    valueEl.replaceChildren(document.createTextNode(v.total.toLocaleString("en-US")));
    if (v.tradableCount) {
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = ` $${formatCoins(v.tradable)}`;
      valueEl.append(t);
    }
    box.title = [
      `${v.total.toLocaleString("en-US")} total (EA market average)`,
      `${v.tradableCount} tradeable card${v.tradableCount === 1 ? "" : "s"}: ${v.tradable.toLocaleString("en-US")}`,
      `${v.players - v.tradableCount - v.unpriced} untradeable: ${(v.total - v.tradable).toLocaleString("en-US")}`,
      v.unpriced ? `${v.unpriced} without a price` : "",
      v.estimated ? `${v.estimated} priced by rating estimate (EA has no price)` : ""
    ].filter(Boolean).join("\n");
  }

  function scheduleSquadValue() {
    clearTimeout(valueTimer);
    valueTimer = setTimeout(renderSquadValue, 60); // after the app finishes updating the squad
  }

  function installSquadValue() {
    if (valuePatched) return true;
    const Stats = g("UTSBCSquadStatsView");
    const Squad = g("UTSquadEntity");
    if (typeof Stats?.prototype?.setRating !== "function" || typeof Squad !== "function") return false;
    const origSetRating = Stats.prototype.setRating;
    Stats.prototype.setRating = function (...args) {
      const out = origSetRating.apply(this, args);
      statsView = this;
      scheduleSquadValue();
      return out;
    };
    for (const m of ["setPlayers", "addItemToSlot", "removeItemFromSlot", "removeAllItems", "swapPlayersByIndex"]) {
      const orig = Squad.prototype[m];
      if (typeof orig !== "function") continue;
      Squad.prototype[m] = function (...args) {
        const out = orig.apply(this, args);
        scheduleSquadValue();
        return out;
      };
    }
    if (!document.getElementById("sbcs-value-style")) {
      const st = document.createElement("style");
      st.id = "sbcs-value-style";
      st.textContent = `#sbcs-value{display:flex;flex-direction:column;justify-content:center;gap:2px;
        margin-left:18px;padding-left:14px;border-left:1px solid #ffffff26;font-family:inherit;white-space:nowrap}
        #sbcs-value .l{font-size:.75em;font-weight:600;opacity:.95}
        #sbcs-value .v{font-size:.85em;font-weight:700;color:#ffd45a}
        #sbcs-value .v .t{color:#3ddc84;font-weight:700;margin-left:4px}`;
      document.head.appendChild(st);
    }
    valuePatched = true;
    return true;
  }

  function setPriceOverlay(progress, args) {
    overlayOn = !!args?.enabled;
    installSquadValue();
    installPackSummary();
    scheduleSquadValue();
    if (overlayOn && !overlayPatched) {
      const View = g("UTPlayerItemView");
      const orig = View?.prototype?.renderItem;
      if (typeof orig !== "function") throw new Error("UTPlayerItemView.renderItem missing");
      View.prototype.renderItem = function (item, ...rest) {
        const out = orig.call(this, item, ...rest);
        setTimeout(() => decorateCard(this, item), 0); // after the app finishes drawing
        return out;
      };
      overlayPatched = true;
      ensureOverlayStyle();
    }
    if (!overlayOn) document.querySelectorAll(".sbcs-badges").forEach((n) => n.remove());
    return { enabled: overlayOn };
  }

  // ---------- bridge ----------

  const COMMANDS = {
    probe, dumpClub, dumpSbc, dumpAllSbcs, ratingCode, solveInput, fillSquad, undoFill,
    setInput, fillSet, context, setPriceOverlay, describePlayers, setTileValue, seedFormations, tileInput,
    galleryProbe, exportSlots, seedSlots
  };
  const QUICK = new Set(["context", "setPriceOverlay", "describePlayers", "setTileValue", "seedFormations", "exportSlots", "seedSlots"]); // instant and read-mostly: allowed while busy
  let busy = false;

  window.addEventListener("message", async (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const msg = ev.data;
    if (!isObj(msg) || msg.ns !== NS || msg.dir !== "req" || typeof msg.id !== "string") return;
    const reply = (payload) => window.postMessage({ ns: NS, id: msg.id, ...payload }, location.origin);
    const fn = Object.prototype.hasOwnProperty.call(COMMANDS, msg.cmd) ? COMMANDS[msg.cmd] : null;
    if (!fn) return reply({ dir: "res", ok: false, error: `unknown command ${msg.cmd}` });
    if (QUICK.has(msg.cmd)) {
      try {
        return reply({ dir: "res", ok: true, data: fn(() => {}, isObj(msg.args) ? msg.args : undefined) });
      } catch (e) {
        return reply({ dir: "res", ok: false, error: e?.message || String(e) });
      }
    }
    if (busy) return reply({ dir: "res", ok: false, error: "another command is running" });
    busy = true;
    try {
      const data = await fn((text) => reply({ dir: "progress", text }), isObj(msg.args) ? msg.args : undefined);
      // round-trip through JSON so structured clone never sees exotic objects
      reply({ dir: "res", ok: true, data: JSON.parse(JSON.stringify(data)) });
    } catch (e) {
      reply({ dir: "res", ok: false, error: e?.message || String(e) });
    } finally {
      busy = false;
    }
  });
})();
