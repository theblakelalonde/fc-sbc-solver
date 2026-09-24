// Isolated-world script: owns the panel UI and file downloads; asks page-hook.js (MAIN world)
// for game data and fills, and background.js for solves. Fills never submit.
(() => {
  "use strict";

  const NS = "sbcsolver";
  const pending = new Map(); // id -> { resolve, reject, onProgress, timer }
  // Auto-complete options; they map 1:1 onto the solver's CostOptions.
  const DEFAULT_AUTO = {
    allowTradeable: true, allowSpecial: false, ignoreExclusions: false, storageFirst: false,
    raresOnlyIfRequired: true, useUnassigned: true, useTransferDuplicates: true, keepSquadPlayers: false,
    solveMultiple: false, solveTimes: 2, ratingMin: 45, ratingMax: 99, specialRatingMin: 45, specialRatingMax: 99,
    solveUsing: "price", scope: "challenge", excludeActiveSquad: true
  };
  const MAX_SOLVE_TIMES = 10;
  const DEFAULT_SETTINGS = { timeLimitS: 10, maxCost: 50000, showPrices: true, collapsed: false, auto: DEFAULT_AUTO };
  const CONTEXT_POLL_MS = 1500;
  const HEALTH_POLL_MS = 15000;

  // ---------- bridges ----------

  let onPageEvent = () => {}; // set by the panel once it's built

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const msg = ev.data;
    if (msg?.ns === NS && msg.dir === "event") return onPageEvent(msg);
    if (!msg || msg.ns !== NS || typeof msg.id !== "string" || !pending.has(msg.id)) return;
    const p = pending.get(msg.id);
    if (msg.dir === "progress") {
      p.onProgress(String(msg.text));
    } else if (msg.dir === "res") {
      pending.delete(msg.id);
      clearTimeout(p.timer);
      msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error));
    }
  });

  function request(cmd, { onProgress = () => {}, args, timeoutMs = 10 * 60 * 1000 } = {}) {
    const id = `${cmd}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("The page didn't answer. Press F5 on this tab."));
      }, timeoutMs);
      pending.set(id, { resolve, reject, onProgress, timer });
      window.postMessage({ ns: NS, dir: "req", id, cmd, args }, location.origin);
    });
  }

  function extensionAlive() {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  function toBackground(msg) {
    if (!extensionAlive()) return Promise.reject(new Error("The extension was reloaded. Press F5 on this tab."));
    return chrome.runtime.sendMessage(msg).then((res) => {
      if (!res) throw new Error("No response from the extension background.");
      if (!res.ok) throw new Error(res.error);
      return res.data;
    });
  }

  async function loadSettings() {
    try {
      const { settings } = await chrome.storage.local.get("settings");
      const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
      merged.auto = { ...DEFAULT_AUTO, ...(settings?.auto || {}) };
      if (typeof settings?.allowSpecial === "boolean" && !settings.auto) merged.auto.allowSpecial = settings.allowSpecial;
      return merged;
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings(settings) {
    try {
      chrome.storage.local.set({ settings });
    } catch {
      /* extension reloaded; ignore */
    }
  }

  function download(name, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ---------- DOM helpers (textContent only: names from the game are never parsed as HTML) ----------

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function button(label, className, onClick) {
    const b = el("button", className, label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  const fmt = (n) => Number(n).toLocaleString("en-US");

  const CSS = `
  #sbcs{position:fixed;left:14px;bottom:14px;z-index:2147483647;width:340px;max-width:calc(100vw - 28px);
    background:#0d131cf2;color:#e8edf5;font:13px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;
    border:1px solid #ffffff1a;border-radius:14px;box-shadow:0 10px 30px #0009;overflow:hidden}
  #sbcs *{box-sizing:border-box}
  #sbcs [hidden]{display:none!important}
  #sbcs .hd{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;user-select:none}
  #sbcs .ttl{font-weight:700;letter-spacing:.2px;flex:1}
  #sbcs .pill{font-size:11px;padding:2px 8px;border-radius:99px;background:#ffffff12;display:flex;align-items:center;gap:5px}
  #sbcs .dot{width:7px;height:7px;border-radius:50%;background:#888}
  #sbcs .pill.on .dot{background:#3ddc84} #sbcs .pill.off .dot{background:#ff6b6b}
  #sbcs .icon{background:none;border:0;color:#aab4c3;font-size:15px;cursor:pointer;padding:2px 4px;border-radius:6px}
  #sbcs .icon:hover{background:#ffffff14;color:#fff}
  #sbcs .bd{padding:0 12px 12px;display:flex;flex-direction:column;gap:10px}
  #sbcs.collapsed .bd{display:none}
  #sbcs .mini{display:none}
  #sbcs.collapsed .mini:not([hidden]){display:flex;gap:8px;align-items:center;padding:0 12px 10px;color:#c9d2df;font-size:12px}
  #sbcs .mini > div:last-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
  #sbcs .ctx{background:#ffffff0d;border-radius:10px;padding:8px 10px}
  #sbcs .ctx .name{font-weight:600}
  #sbcs .muted{color:#9aa6b8;font-size:12px}
  #sbcs .btns{display:flex;flex-direction:column;gap:6px}
  #sbcs .btn{width:100%;padding:9px 10px;border-radius:10px;border:1px solid #ffffff22;background:#1c2635;color:#fff;
    font:600 13px system-ui,sans-serif;cursor:pointer;transition:filter .15s}
  #sbcs .btn:hover:not(:disabled){filter:brightness(1.2)}
  #sbcs .btn:disabled{opacity:.45;cursor:not-allowed}
  #sbcs .btn.primary{background:linear-gradient(180deg,#27b36a,#1c8a51);border-color:#3ddc8466}
  #sbcs .btn.small{width:auto;padding:5px 10px;font-size:12px}
  #sbcs .status{display:flex;gap:8px;align-items:flex-start;color:#c9d2df}
  #sbcs .spin{width:14px;height:14px;flex:none;margin-top:2px;border:2px solid #ffffff33;border-top-color:#3ddc84;
    border-radius:50%;animation:sbcs-spin .8s linear infinite}
  @keyframes sbcs-spin{to{transform:rotate(360deg)}}
  #sbcs .card{background:#ffffff0d;border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px}
  #sbcs .tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
  #sbcs .tile{background:#0006;border-radius:8px;padding:6px;text-align:center}
  #sbcs .tile b{display:block;font-size:16px}
  #sbcs .tile span{font-size:11px;color:#9aa6b8}
  #sbcs .ok{color:#3ddc84} #sbcs .warn{color:#ffc857} #sbcs .bad{color:#ff6b6b}
  #sbcs .rows{display:flex;flex-direction:column;gap:4px}
  #sbcs .row{display:flex;justify-content:space-between;gap:8px}
  #sbcs .row .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #sbcs .drawer{background:#ffffff0d;border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px}
  #sbcs .field{display:flex;justify-content:space-between;align-items:center;gap:10px}
  #sbcs input.coins{width:100px;background:#0008;color:#fff;border:1px solid #ffffff2a;border-radius:6px;padding:3px 6px;font:inherit;text-align:right}
  #sbcs input.coins::placeholder{color:#9aa6b8}
  #sbcs input[type=number]{width:100px;background:#0008;color:#fff;border:1px solid #ffffff2a;border-radius:6px;padding:3px 6px;font:inherit}
  #sbcs input[type=checkbox]{accent-color:#27b36a;width:15px;height:15px}
  #sbcs details summary{cursor:pointer;color:#9aa6b8;font-size:12px}
  #sbcs .dev{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
  `;

  // ---------- preview modal (whole set now; repeated SBCs later) ----------

  const MODAL_CSS = `
  #sbcs-modal{position:fixed;inset:0;z-index:2147483647;background:#000a;display:flex;align-items:center;justify-content:center;
    font:13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;color:#e8edf5}
  #sbcs-modal *{box-sizing:border-box}
  #sbcs-modal .dlg{width:min(880px,94vw);max-height:88vh;display:flex;flex-direction:column;background:#141a23;
    border:1px solid #ffffff1a;border-radius:14px;box-shadow:0 20px 60px #000c;overflow:hidden}
  #sbcs-modal .top{padding:16px 18px 10px}
  #sbcs-modal h2{margin:0 0 4px;font-size:18px}
  #sbcs-modal .sub{color:#9aa6b8;font-size:12px}
  #sbcs-modal .notes{margin:10px 18px 0;padding:8px 10px;border-radius:8px;background:#ffc85714;color:#ffc857;font-size:12px}
  #sbcs-modal .scroll{overflow:auto;padding:10px 18px;display:flex;flex-direction:column;gap:12px}
  #sbcs-modal .sec{flex:none;border:1px solid #ffffff14;border-radius:10px;overflow:hidden}
  #sbcs-modal .sec.off{opacity:.45}
  #sbcs-modal .sh{display:flex;align-items:center;gap:12px;padding:8px 12px;background:#1d2531;font-weight:700}
  #sbcs-modal .sh .nm{flex:1} #sbcs-modal .sh .val{font-weight:600;color:#c9d2df}
  #sbcs-modal .row{display:grid;grid-template-columns:26px 34px minmax(120px,1fr) 26px 26px 26px 22px 22px 80px;
    align-items:center;gap:8px;padding:5px 12px;border-top:1px solid #ffffff0d}
  #sbcs-modal .row:nth-child(odd){background:#ffffff05}
  #sbcs-modal .ovr{font-weight:700;text-align:center}
  #sbcs-modal .nm2{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
  #sbcs-modal img{width:22px;height:22px;object-fit:contain}
  #sbcs-modal .chip{width:18px;height:24px;border-radius:4px 4px 6px 6px;margin:auto}
  #sbcs-modal .chip.t1{background:linear-gradient(#d9a37a,#8a5a3a)} #sbcs-modal .chip.t2{background:linear-gradient(#e4e8ee,#8e98a4)}
  #sbcs-modal .chip.t3{background:linear-gradient(#f6e39a,#c9a24a)} #sbcs-modal .chip.rare{box-shadow:0 0 0 1px #fff8 inset,0 0 4px #ffe58a}
  #sbcs-modal .chip.sp{background:linear-gradient(#b88cff,#5b2ea8)}
  #sbcs-modal .price{text-align:right;font-weight:700;display:flex;justify-content:flex-end;align-items:center;gap:4px}
  #sbcs-modal .coin{width:11px;height:11px;border-radius:50%;background:radial-gradient(#ffe58a,#c9a24a);display:inline-block}
  #sbcs-modal svg{width:16px;height:16px;display:block;margin:auto}
  #sbcs-modal .dollar{color:#3ddc84;font-weight:800;text-align:center;font-size:14px}
  #sbcs-modal .foot{display:flex;align-items:center;gap:10px;padding:12px 18px;border-top:1px solid #ffffff14;background:#10151d}
  #sbcs-modal .foot .sum{flex:1;color:#c9d2df}
  #sbcs-modal button{padding:9px 16px;border-radius:10px;border:1px solid #ffffff22;background:#1c2635;color:#fff;
    font:600 13px system-ui,sans-serif;cursor:pointer}
  #sbcs-modal button.go{background:linear-gradient(180deg,#27b36a,#1c8a51);border-color:#3ddc8466}
  #sbcs-modal button:disabled{opacity:.45;cursor:not-allowed}
  #sbcs-modal .sw{position:relative;width:38px;height:20px;flex:none}
  #sbcs-modal .sw input{opacity:0;width:0;height:0}
  #sbcs-modal .sw span{position:absolute;inset:0;border-radius:20px;background:#3a4454;cursor:pointer;transition:.15s}
  #sbcs-modal .sw span::after{content:"";position:absolute;left:3px;top:3px;width:14px;height:14px;border-radius:50%;background:#fff;transition:.15s}
  #sbcs-modal .sw input:checked+span{background:#27b36a} #sbcs-modal .sw input:checked+span::after{left:21px}
  #sbcs-modal .dlg.narrow{width:min(440px,94vw)}
  #sbcs-modal .opts{display:flex;flex-direction:column;gap:2px}
  #sbcs-modal .orow{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 2px;
    border-bottom:1px solid #ffffff0d;cursor:pointer}
  #sbcs-modal .orow .orow{border:0;padding:0;flex:1}
  #sbcs-modal .orow.dis{opacity:.45;cursor:not-allowed}
  #sbcs-modal .left{color:#9aa6b8;font-size:12px;white-space:nowrap}
  #sbcs-modal .orange{padding:8px 2px;display:flex;flex-direction:column;gap:6px}
  #sbcs-modal .orange .orow{border:0;cursor:default;justify-content:flex-start}
  #sbcs-modal .olabel{font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#9aa6b8}
  #sbcs-modal input[type=number]{width:70px;background:#0008;color:#fff;border:1px solid #ffffff2a;border-radius:8px;padding:5px 8px;font:inherit}
  #sbcs-modal select{background:#0008;color:#fff;border:1px solid #ffffff2a;border-radius:8px;padding:7px 8px;font:inherit}
  #sbcs-modal .saved{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;margin-bottom:6px;
    border-radius:8px;background:#27b36a1f;color:#bff5d6}
  `;

  const SVG_NS = "http://www.w3.org/2000/svg";
  function svg(children, title) {
    const node = document.createElementNS(SVG_NS, "svg");
    node.setAttribute("viewBox", "0 0 16 16");
    for (const [tag, attrs] of children) {
      const c = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) c.setAttribute(k, v);
      node.append(c);
    }
    if (title) {
      const t = document.createElementNS(SVG_NS, "title");
      t.textContent = title;
      node.append(t);
    }
    return node;
  }
  const UNTRADEABLE_SVG = [
    ["circle", { cx: 8, cy: 8, r: 6.6, fill: "none", stroke: "#b4bcc6", "stroke-width": 1.6 }],
    ["line", { x1: 3.4, y1: 3.4, x2: 12.6, y2: 12.6, stroke: "#b4bcc6", "stroke-width": 1.8, "stroke-linecap": "round" }]
  ];
  const STORAGE_SVG = [
    ["path", { d: "M3.5 4v8c0 1.4 2 2.5 4.5 2.5s4.5-1.1 4.5-2.5V4z", fill: "#2f7df6" }],
    ["ellipse", { cx: 8, cy: 4, rx: 4.5, ry: 2.2, fill: "#6aa8ff" }]
  ];

  function imgOrBlank(url, title) {
    if (!url) return el("span");
    const i = el("img");
    i.src = url;
    i.alt = "";
    i.title = title;
    i.addEventListener("error", () => (i.style.visibility = "hidden"));
    return i;
  }

  function playerRow(p) {
    const row = el("div", "row");
    let chip;
    if (p.special && p.img?.rarity) chip = imgOrBlank(p.img.rarity, "Special card");
    else chip = el("div", `chip t${p.tier || 3}${p.rareflag === 1 ? " rare" : ""}${p.special ? " sp" : ""}`);
    const tradeIcon = p.tradable ? el("div", "dollar", "$") : svg(UNTRADEABLE_SVG, "Untradeable");
    if (p.tradable) tradeIcon.title = "Tradeable (could be sold)";
    const store = p.storage ? svg(STORAGE_SVG, "From SBC storage") : el("span");
    const price = el("div", "price");
    price.append(document.createTextNode(p.price ? fmt(p.price) : "–"), el("span", "coin"));
    row.append(
      chip, el("div", "ovr", String(p.rating ?? "")), el("div", "nm2", p.name || "?"),
      imgOrBlank(p.img?.league, "League"), imgOrBlank(p.img?.club, "Club"), imgOrBlank(p.img?.nation, "Nation"),
      tradeIcon, store, price
    );
    return row;
  }

  // Small dialog with custom body (the auto-complete options). Returns { close }.
  function openDialog({ title, subtitle, body, confirmLabel, onConfirm }) {
    if (!document.getElementById("sbcs-modal-style")) {
      const st = el("style");
      st.id = "sbcs-modal-style";
      st.textContent = MODAL_CSS;
      document.head.appendChild(st);
    }
    const overlay = el("div");
    overlay.id = "sbcs-modal";
    const dlg = el("div", "dlg narrow");
    const top = el("div", "top");
    top.append(el("h2", "", title), el("div", "sub", subtitle));
    const scroll = el("div", "scroll");
    scroll.append(body);
    const foot = el("div", "foot");
    const cancel = el("button", "", "Cancel");
    const go = el("button", "go", confirmLabel);
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    function close() {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
    }
    cancel.addEventListener("click", close);
    go.addEventListener("click", () => {
      close();
      onConfirm();
    });
    document.addEventListener("keydown", onKey, true);
    foot.append(el("div", "sum"), cancel, go);
    dlg.append(top, scroll, foot);
    overlay.append(dlg);
    document.body.append(overlay);
    go.focus();
    return { close };
  }

  // sections: [{ id, name, players: [details] }]. Resolves with the ids to fill, or null if cancelled.
  function showPreview({ title, subtitle, notes, sections, confirmLabel }) {
    return new Promise((resolve) => {
      if (!document.getElementById("sbcs-modal-style")) {
        const st = el("style");
        st.id = "sbcs-modal-style";
        st.textContent = MODAL_CSS;
        document.head.appendChild(st);
      }
      const overlay = el("div");
      overlay.id = "sbcs-modal";
      const dlg = el("div", "dlg");
      const top = el("div", "top");
      top.append(el("h2", "", title), el("div", "sub", subtitle));
      dlg.append(top);
      if (notes?.length) {
        const n = el("div", "notes");
        notes.forEach((t) => n.append(el("div", "", t)));
        dlg.append(n);
      }
      const scroll = el("div", "scroll");
      const included = new Set(sections.map((sec) => sec.id));
      const sum = el("div", "sum");
      const go = el("button", "go");
      const refresh = () => {
        const chosen = sections.filter((sec) => included.has(sec.id));
        const players = chosen.flatMap((sec) => sec.players);
        const value = players.reduce((a, p) => a + (p.price || 0), 0);
        const tradable = players.filter((p) => p.tradable).length;
        sum.textContent = `${chosen.length} squad${chosen.length === 1 ? "" : "s"} · ${players.length} players · value ${fmt(value)}`
          + (tradable ? ` · ${tradable} tradeable` : " · no tradeable cards");
        go.textContent = `${confirmLabel} (${chosen.length})`;
        go.disabled = !chosen.length;
      };
      for (const sec of sections) {
        const box = el("div", "sec");
        const head = el("div", "sh");
        const value = sec.players.reduce((a, p) => a + (p.price || 0), 0);
        const sw = el("label", "sw");
        const cb = el("input");
        cb.type = "checkbox";
        cb.checked = true;
        cb.addEventListener("change", () => {
          cb.checked ? included.add(sec.id) : included.delete(sec.id);
          box.classList.toggle("off", !cb.checked);
          refresh();
        });
        sw.append(cb, el("span"));
        head.append(el("div", "nm", sec.name), el("div", "val", `Squad value ${fmt(value)}`), sw);
        box.append(head);
        [...sec.players].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0)).forEach((p) => box.append(playerRow(p)));
        scroll.append(box);
      }
      const foot = el("div", "foot");
      const cancel = el("button", "", "Cancel");
      const close = (value) => {
        document.removeEventListener("keydown", onKey, true);
        overlay.remove();
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          close(null);
        }
      };
      cancel.addEventListener("click", () => close(null));
      go.addEventListener("click", () => close([...included]));
      document.addEventListener("keydown", onKey, true);
      foot.append(sum, cancel, go);
      dlg.append(scroll, foot);
      overlay.append(dlg);
      document.body.append(overlay);
      refresh();
      go.focus();
    });
  }

  // ---------- panel ----------

  async function buildPanel() {
    const settings = await loadSettings();
    const style = el("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    const root = el("div");
    root.id = "sbcs";
    if (settings.collapsed) root.classList.add("collapsed");

    // header
    const header = el("div", "hd");
    const title = el("div", "ttl", "SBC Solver");
    const health = el("div", "pill", "");
    const healthDot = el("span", "dot");
    const healthText = el("span", "", "Checking solver…");
    health.append(healthDot, healthText);
    const gear = button("⚙", "icon", (e) => {
      e.stopPropagation();
      drawer.hidden = !drawer.hidden;
      if (root.classList.contains("collapsed")) setCollapsed(false);
    });
    gear.title = "Settings";
    const chevron = button(settings.collapsed ? "▴" : "▾", "icon", (e) => {
      e.stopPropagation();
      setCollapsed(!root.classList.contains("collapsed"));
    });
    chevron.title = "Collapse";
    header.append(title, health, gear, chevron);
    header.addEventListener("click", () => setCollapsed(!root.classList.contains("collapsed")));

    function setCollapsed(v) {
      root.classList.toggle("collapsed", v);
      chevron.textContent = v ? "▴" : "▾";
      settings.collapsed = v;
      saveSettings(settings);
    }

    // body
    const body = el("div", "bd");
    const ctxBox = el("div", "ctx");
    const ctxName = el("div", "name", "No SBC open");
    const ctxSub = el("div", "muted", "Open an SBC's squad screen to start.");
    ctxBox.append(ctxName, ctxSub);

    // Normally the "Auto Complete" button sits in the app's own SBC sidebar; these show only if
    // that injection fails (e.g. after an EA update).
    const fillOne = button("Auto Complete", "btn primary", () => openAutoOptions("challenge"));
    const fillSet = button("Auto Complete Set", "btn", () => openAutoOptions("set"));
    const btns = el("div", "btns");
    btns.append(fillOne, fillSet);

    const status = el("div", "status");
    const spinner = el("div", "spin");
    const statusText = el("div", "", "");
    status.append(spinner, statusText);
    status.hidden = true;

    const result = el("div");
    const offline = el("div", "card");
    offline.hidden = true;
    offline.append(
      el("div", "warn", "The solver didn't load."),
      el("div", "muted", "Open chrome://extensions, press the reload button on SBC Solver, then F5 this tab."),
      button("Check again", "btn small", () => checkHealth())
    );

    const drawer = buildDrawer();
    drawer.hidden = true;

    // Collapsed panel: the status line stays visible (same text as the full one).
    const mini = el("div", "mini");
    const miniSpin = el("div", "spin");
    const miniText = el("div", "", "");
    mini.append(miniSpin, miniText);
    mini.hidden = true;
    mini.addEventListener("click", () => setCollapsed(false));

    body.append(drawer, ctxBox, btns, offline, status, result);
    root.append(header, mini, body);
    document.body.appendChild(root);

    // ---------- settings drawer ----------

    function buildDrawer() {
      const d = el("div", "drawer");
      const numberField = (label, key, min, max, step) => {
        const row = el("label", "field");
        const input = el("input");
        Object.assign(input, { type: "number", min, max, step, value: settings[key] });
        input.addEventListener("change", () => {
          const v = Number(input.value);
          if (!Number.isFinite(v)) return;
          settings[key] = Math.min(max, Math.max(min, v));
          input.value = settings[key];
          saveSettings(settings);
        });
        row.append(el("span", "", label), input);
        return row;
      };
      // Coin amount typed with thousands separators ("50,000"); empty or 0 = no limit.
      const coinsField = (label, key, max) => {
        const row = el("label", "field");
        const input = el("input", "coins");
        Object.assign(input, { type: "text", inputMode: "numeric", placeholder: "No limit", autocomplete: "off" });
        const show = (v) => (input.value = v > 0 ? v.toLocaleString("en-US") : "");
        show(settings[key]);
        let lastDigits = input.value.replace(/\D/g, "");
        input.addEventListener("input", (e) => {
          // Reformat as you type, keeping the caret after the same digit.
          const caret = input.selectionStart ?? input.value.length;
          let digitsBefore = input.value.slice(0, caret).replace(/\D/g, "").length;
          let raw = input.value.replace(/\D/g, "");
          // Deleting a comma removes nothing, so take the digit next to it instead.
          if (raw === lastDigits && /^delete/.test(e.inputType || "")) {
            if (e.inputType === "deleteContentBackward" && digitsBefore > 0) {
              raw = raw.slice(0, digitsBefore - 1) + raw.slice(digitsBefore);
              digitsBefore--;
            } else if (e.inputType === "deleteContentForward") {
              raw = raw.slice(0, digitsBefore) + raw.slice(digitsBefore + 1);
            }
          }
          const digits = raw.replace(/^0+(?=\d)/, "").slice(0, String(max).length);
          lastDigits = digits;
          input.value = digits ? Number(digits).toLocaleString("en-US") : "";
          let pos = 0;
          for (let seen = 0; pos < input.value.length && seen < digitsBefore; pos++) if (/\d/.test(input.value[pos])) seen++;
          input.setSelectionRange(pos, pos);
        });
        input.addEventListener("change", () => {
          const v = Math.min(max, Number(input.value.replace(/\D/g, "")) || 0);
          settings[key] = v;
          show(v);
          lastDigits = input.value.replace(/\D/g, "");
          saveSettings(settings);
        });
        row.append(el("span", "", label), input);
        return row;
      };
      const toggleField = (label, key, onChange) => {
        const row = el("label", "field");
        const box = el("input");
        box.type = "checkbox";
        box.checked = !!settings[key];
        box.addEventListener("change", () => {
          settings[key] = box.checked;
          saveSettings(settings);
          onChange?.(box.checked);
        });
        row.append(el("span", "", label), box);
        return row;
      };
      d.append(
        el("div", "muted", "Settings"),
        toggleField("Show prices (cards + squad value)", "showPrices", (v) => applyPrices(v)),
        coinsField("Max player value", "maxCost", 10000000),
        numberField("Time limit per SBC (s)", "timeLimitS", 2, 60, 1)
      );
      const dev = el("details");
      dev.append(el("summary", "", "Developer tools"));
      const devRow = el("div", "dev");
      const addDump = (label, cmd, prefix) =>
        devRow.append(button(label, "btn small", async () => {
          showBusy(`${label}…`);
          try {
            const data = await request(cmd, { onProgress: showBusy });
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            download(`${prefix}-${stamp}.json`, data);
            showDone(`Saved ${prefix}-${stamp}.json`);
          } catch (e) {
            showDone(`${label} failed: ${e.message}`, "bad");
          }
        }));
      addDump("Probe", "probe", "probe");
      addDump("Dump club", "dumpClub", "club");
      addDump("Dump SBC", "dumpSbc", "sbc");
      addDump("Dump all SBCs", "dumpAllSbcs", "sbc-all");
      addDump("Rating code", "ratingCode", "rating-code");
      addDump("Gallery probe", "galleryProbe", "gallery-probe");
      dev.append(devRow);
      d.append(dev);
      return d;
    }

    // ---------- state + status ----------

    let busy = false;
    let ctx = { onSbc: false };
    let solverOnline = null;
    let pricesApplied = false;

    function refreshButtons() {
      // From a challenge's squad screen (sets with 2+ challenges) or from a set's overview page.
      const setOpen = (ctx.onSbc && (ctx.setChallenges ?? 0) > 1) || ctx.onSet;
      const left = setOpen ? (ctx.setChallenges ?? 0) - (ctx.setCompleted ?? 0) : 0;
      fillOne.hidden = !ctx.onSbc || !!ctx.sidebarButton;
      fillOne.disabled = busy || solverOnline === false;
      fillSet.hidden = !ctx.onSet || !!ctx.sidebarButton;
      fillSet.className = "btn primary";
      fillSet.disabled = busy || left < 1 || solverOnline === false;
    }

    function showBusy(text) {
      status.hidden = false;
      spinner.hidden = false;
      statusText.className = "";
      statusText.textContent = text;
      syncMini();
    }

    function showDone(text, tone = "") {
      status.hidden = false;
      spinner.hidden = true;
      statusText.className = tone;
      statusText.textContent = text;
      syncMini();
    }

    function syncMini() {
      mini.hidden = status.hidden;
      miniSpin.hidden = spinner.hidden;
      miniText.className = statusText.className;
      miniText.textContent = statusText.textContent;
      mini.title = statusText.textContent;
    }

    // A result belongs to the screen it was made on. Once that challenge is submitted (times
    // completed / status change), its squad emptied, or another SBC opened, it's cleared.
    let shownFor = null;
    const screenKey = (c) => (c.onSbc ? `c${c.challengeId}:${c.timesCompleted ?? ""}:${c.challengeStatus ?? ""}`
      : c.onSet ? `s${c.setId}:${c.setCompleted ?? ""}` : c.onHub ? "hub" : "none");

    function clearResult() {
      shownFor = null;
      result.replaceChildren();
      status.hidden = true;
      syncMini();
    }

    function trackResult() {
      if (busy) return;
      const shown = result.childElementCount > 0 || !status.hidden;
      if (!shown) return (shownFor = null);
      if (!shownFor) return (shownFor = { key: screenKey(ctx), filled: ctx.squadCount ?? 0 });
      const emptied = ctx.onSbc && shownFor.filled > 0 && ctx.squadCount === 0;
      if (screenKey(ctx) !== shownFor.key || emptied) clearResult();
    }

    function setBusy(v) {
      busy = v;
      if (v) shownFor = null; // a new run: its result is tracked from the next poll
      refreshButtons();
    }

    // ---------- polling ----------

    async function pollContext() {
      try {
        ctx = await request("context", { timeoutMs: 3000 });
        if (!pricesApplied) applyPrices(settings.showPrices);
      } catch {
        ctx = { onSbc: false };
      }
      rememberFormations(ctx.formations);
      rememberSlots(ctx.slotsVersion);
      if (ctx.onSbc) {
        ctxName.textContent = ctx.challengeName;
        ctxSub.textContent = ctx.setName && ctx.setChallenges > 1
          ? `Set: ${ctx.setName} · ${ctx.setCompleted ?? 0}/${ctx.setChallenges} done`
          : "Single challenge";
      } else if (ctx.onSet) {
        ctxName.textContent = ctx.setName;
        ctxSub.textContent = `Set overview · ${ctx.setCompleted ?? 0}/${ctx.setChallenges} done`;
      } else if (ctx.onHub) {
        ctxName.textContent = "SBC hub";
        ctxSub.textContent = hubProgress || "Tiles show each set's squad value from your club.";
        startHubWorker(ctx.hubSets || []);
      } else {
        ctxName.textContent = "No SBC open";
        ctxSub.textContent = "Open an SBC to start.";
      }
      trackResult();
      refreshButtons();
    }

    // ---------- learned formations (so never-opened challenges can be estimated) ----------

    let storedFormations = {};
    let formationsSeeded = false;
    try {
      chrome.storage.local.get("formations").then((r) => (storedFormations = r.formations || {}));
    } catch {
      /* extension reloaded */
    }

    // Slot layouts (which slots are bricks) learned by the page, kept across reloads.
    let storedSlots = {};
    let slotsSeeded = false;
    let slotsSeen = 0;
    try {
      chrome.storage.local.get("slotLayouts").then((r) => (storedSlots = r.slotLayouts || {}));
    } catch {
      /* extension reloaded */
    }

    async function rememberSlots(version) {
      if (!slotsSeeded && Object.keys(storedSlots).length) {
        await request("seedSlots", { args: { slots: storedSlots }, timeoutMs: 3000 }).then(() => (slotsSeeded = true), () => {});
      }
      if (typeof version !== "number" || version === slotsSeen) return;
      slotsSeen = version;
      try {
        const fresh = await request("exportSlots", { timeoutMs: 3000 });
        storedSlots = { ...storedSlots, ...fresh };
        chrome.storage.local.set({ slotLayouts: storedSlots });
      } catch {
        /* page busy or extension reloaded; next poll retries */
      }
    }

    function rememberFormations(fresh) {
      if (!fresh) return;
      if (!formationsSeeded && Object.keys(storedFormations).length) {
        request("seedFormations", { args: { formations: storedFormations }, timeoutMs: 3000 })
          .then(() => (formationsSeeded = true), () => {});
      }
      const added = Object.keys(fresh).filter((k) => !storedFormations[k]);
      if (!added.length) return;
      storedFormations = { ...storedFormations, ...fresh };
      try {
        chrome.storage.local.set({ formations: storedFormations });
      } catch {
        /* extension reloaded */
      }
    }

    // ---------- hub tiles: squad value of each set from your club ----------

    const TILE_TTL_MS = 60 * 60 * 1000;
    let tileCache = {};
    try {
      chrome.storage.local.get("tileCache").then((r) => (tileCache = r.tileCache || {}));
    } catch {
      /* extension reloaded */
    }
    let hubRunning = false;
    let hubStop = false;
    let hubStep = Promise.resolve();
    let hubProgress = "";

    const short = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `${Math.round(v / 1e3)}k` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(v));

    function saveTileCache() {
      try {
        chrome.storage.local.set({ tileCache });
      } catch {
        /* extension reloaded */
      }
    }

    function showTile(setId, v) {
      return request("setTileValue", { args: { setId, ...v }, timeoutMs: 3000 }).catch(() => {});
    }

    function tileFromResult(res) {
      const all = res.challenges || [];
      const solved = all.filter((c) => c.status === "solved");
      const value = solved.reduce((a, c) => a + (c.solution.squadValue ?? 0), 0);
      const tradeable = solved.flatMap((c) => c.solution.slots).filter((x) => x.tradable).length;
      const missing = all.filter((c) => c.status !== "solved").map((c) => `${c.name}: ${SET_STATUS_TEXT[c.status] || c.status}`);
      const note = `Squad value of the cheapest squads from your club (EA prices)${tradeable ? `, incl. ${tradeable} tradeable` : ""}. Estimate: never-opened challenges aren't loaded.`;
      if (!solved.length) {
        // "unsupported" usually means a never-opened challenge in a formation we haven't seen yet.
        if (all.some((c) => c.status === "unsupported" || c.status === "timeout")) {
          const why = all.flatMap((c) => c.unsupported || []).join("\n");
          return { text: "?", tone: "bad", title: `Can't estimate yet. Opening one of its challenges once usually fixes it.${why ? `\n${why}` : ""}` };
        }
        return { text: "✕ not with your club", tone: "bad", title: missing.join("\n") };
      }
      if (missing.length) {
        return { text: `≈ ${short(value)} · ${solved.length}/${all.length}`, tone: "warn", title: `${note}\nCan't do:\n${missing.join("\n")}` };
      }
      return { text: `≈ ${short(value)}`, tone: "", title: note };
    }

    function startHubWorker(ids) {
      if (hubRunning || busy || !settings.showPrices || solverOnline === false) return;
      hubRunning = true;
      hubStop = false;
      runHubWorker(ids).finally(() => {
        hubRunning = false;
        hubProgress = "";
      });
    }

    async function runHubWorker(ids) {
      const now = Date.now();
      const fresh = (id) => tileCache[id] && now - tileCache[id].at < TILE_TTL_MS;
      for (const id of ids) if (fresh(id)) await showTile(id, tileCache[id]);
      const todo = ids.filter((id) => !fresh(id));
      let club = null;
      for (const [n, id] of todo.entries()) {
        if (hubStop || busy || !ctx.onHub) return;
        hubProgress = `Pricing tiles from your club… ${n + 1}/${todo.length}`;
        ctxSub.textContent = hubProgress;
        let step;
        hubStep = step = (async () => {
          await showTile(id, { text: "…", tone: "pending", title: "Pricing from your club…" });
          try {
            club ??= await request("dumpClub", { args: { lite: true } });
            const inp = await request("tileInput", { args: { setId: id } });
            if (!inp.sbcs.length) return showTile(id, { clear: true });
            const res = await toBackground({
              type: "solveSet",
              payload: {
                club,
                sbcs: inp.sbcs,
                options: solverOptions({ relativeGap: 0.05, timeLimitS: Math.min(8, 2 * inp.sbcs.length) })
              }
            });
            tileCache[id] = { ...tileFromResult(res), at: Date.now() };
            saveTileCache();
            await showTile(id, tileCache[id]);
          } catch (e) {
            await showTile(id, { text: "–", tone: "bad", title: e.message });
            if (/not running/.test(e.message)) hubStop = true;
          }
        })();
        await step;
      }
    }

    // Fills and tile pricing share the page bridge: stop the worker and wait for its current step.
    async function pauseHubWorker() {
      hubStop = true;
      await hubStep.catch(() => {});
    }

    function clubChanged() {
      tileCache = {};
      saveTileCache();
    }

    async function checkHealth() {
      try {
        await toBackground({ type: "health" });
        solverOnline = true;
      } catch {
        solverOnline = false;
      }
      health.className = `pill ${solverOnline ? "on" : "off"}`;
      healthText.textContent = solverOnline ? "Solver ready" : "Solver not loaded";
      offline.hidden = solverOnline;
      refreshButtons();
    }

    async function applyPrices(enabled) {
      try {
        await request("setPriceOverlay", { args: { enabled }, timeoutMs: 5000 });
        pricesApplied = true;
      } catch {
        pricesApplied = false; // page not ready yet; the context poll retries
      }
    }

    // ---------- auto-complete options → solver options ----------

    function solverOptions(extra = {}) {
      const a = settings.auto;
      return {
        maxCost: settings.maxCost,
        allowTradeable: a.allowTradeable,
        allowSpecial: a.allowSpecial,
        ignoreExclusions: a.ignoreExclusions,
        storageFirst: a.storageFirst,
        raresOnlyIfRequired: a.raresOnlyIfRequired,
        useUnassigned: a.useUnassigned,
        useTransferDuplicates: a.useTransferDuplicates,
        ratingMin: a.ratingMin,
        ratingMax: a.ratingMax,
        specialRatingMin: a.specialRatingMin,
        specialRatingMax: a.specialRatingMax,
        solveUsing: a.solveUsing,
        excludeActiveSquad: a.excludeActiveSquad,
        ...extra
      };
    }

    // "Keep squad players": items already in the SBC's open slots stay where they are.
    function keptSlots(sbc) {
      const keep = {};
      for (const slot of sbc?.squad?.slots || []) {
        const type = slot.requirement?.playerType || "DEFAULT";
        if (type === "DEFAULT" && slot.item?.fields?.id > 0) keep[slot.i] = slot.item.fields.id;
      }
      return keep;
    }

    const planOf = (sol) => sol.slots.map((x) => ({ slotIndex: x.slotIndex, playerId: x.playerId }));

    // Shown when "Exclude Active Squad Players" is on but the page couldn't read that squad.
    function activeSquadWarning(club) {
      if (!settings.auto.excludeActiveSquad || club?.activeSquad?.known !== false) return null;
      return el("div", "warn", "Couldn't read your active squad, so its players weren't excluded. Open Squads once, then run again.");
    }

    // ---------- solve a repeatable SBC several times ----------

    const savedSquads = {}; // challenge id -> [{ plan, sol }] still to fill (after you submit)

    async function runFillMultiple(times) {
      if (busy) return;
      if (ctx.repeatsLeft != null) times = Math.min(times, ctx.repeatsLeft);
      if (times < 2) return runFillOne();
      setBusy(true);
      result.replaceChildren();
      await pauseHubWorker();
      try {
        showBusy("Reading your club…");
        const input = await request("solveInput", { onProgress: showBusy });
        const id = input.sbc.challenge.id;
        // Same challenge N times, each copy with its own id, solved like a set (no player reused).
        const copies = Array.from({ length: times }, (_, k) => ({
          ...input.sbc,
          challenge: { ...input.sbc.challenge, id: id * 100 + k, name: `${input.sbc.challenge.name} · solution ${k + 1}` }
        }));
        const budget = Math.min(60, settings.timeLimitS * times);
        showBusy(`Finding ${times} squads with no player reused (up to ${budget}s)…`);
        const res = await toBackground({
          type: "solveSet",
          payload: { club: input.club, sbcs: copies, options: solverOptions({ timeLimitS: budget }) }
        });
        const solved = res.challenges.filter((c) => c.status === "solved" && !c.solution.validationErrors?.length);
        if (!solved.length) return showNoSolution(res.challenges[0]?.status || res.status, res.challenges[0]?.unsupported);
        const ids = solved.flatMap((c) => c.solution.slots.map((x) => x.playerId));
        const details = await request("describePlayers", { args: { ids }, timeoutMs: 5000 });
        showBusy("Waiting for you to confirm…");
        const chosenIds = await showPreview({
          title: `${input.sbc.challenge.name}: ${solved.length} completions`,
          subtitle: `Solved in ${res.stats?.wallTimeS ?? "?"}s · no player used twice · the first squad is placed now; the rest wait for you to submit`,
          notes: solved.length < times ? [`Only ${solved.length} of ${times} squads are possible with your club.`] : [],
          sections: solved.map((c) => ({
            id: c.challengeId,
            name: c.name,
            players: c.solution.slots.map((x) => ({ name: x.name, rating: x.rating, price: x.marketPrice, tradable: x.tradable, ...(details[x.playerId] || {}) }))
          })),
          confirmLabel: "Use squads"
        });
        if (!chosenIds) return showDone("Cancelled. Nothing was changed.");
        const queue = solved.filter((c) => chosenIds.includes(c.challengeId)).map((c) => ({ plan: planOf(c.solution), sol: c.solution }));
        const first = queue.shift();
        const app = await request("fillSquad", { onProgress: showBusy, args: { challengeId: id, slots: first.plan } });
        savedSquads[id] = queue;
        clubChanged();
        showDone(queue.length
          ? `Squad 1 placed. Submit it, then open this SBC again and press Auto Complete for the next one (${queue.length} saved).`
          : "Squad placed. Review it, then press Submit in the app.", "ok");
        result.append(singleCard(first.sol, app, res.stats));
      } catch (e) {
        showDone(e.message, "bad");
      } finally {
        setBusy(false);
        pollContext();
      }
    }

    async function fillNextSaved(id) {
      if (busy || !savedSquads[id]?.length) return;
      setBusy(true);
      result.replaceChildren();
      await pauseHubWorker();
      try {
        const next = savedSquads[id].shift();
        const app = await request("fillSquad", { onProgress: showBusy, args: { challengeId: id, slots: next.plan } });
        clubChanged();
        const left = savedSquads[id].length;
        showDone(left ? `Saved squad placed (${left} more saved). Submit it when ready.` : "Last saved squad placed. Submit it when ready.", "ok");
        result.append(singleCard(next.sol, app, {}));
      } catch (e) {
        showDone(`${e.message} Generate new squads instead.`, "bad");
        delete savedSquads[id];
      } finally {
        setBusy(false);
        pollContext();
      }
    }

    // ---------- the "Auto Complete" options dialog (opened from the app's sidebar) ----------

    const AUTO_TOGGLES = [
      ["useConcept", "Use Concept Players", "Not available: concept players are cards you'd have to buy, and pricing them needs outside market data."],
      ["allowTradeable", "Allow Tradeable Players", "Off: only untradeable cards are used."],
      ["allowSpecial", "Allow Special Players", "Special cards (TOTW, promos, icons…)."],
      ["excludeActiveSquad", "Exclude Active Squad Players", "Never use players from your active squad (starters, subs and reserves)."],
      ["ignoreExclusions", "Ignore exclusions", "Ignore the max player value (⚙) and any excluded players."],
      ["storageFirst", "Use Storage First", "SBC storage cards count as nearly free, so they're used before anything else."],
      ["raresOnlyIfRequired", "Only Use Rares if Required", "Rare cards get a big penalty and are used only when nothing else works."],
      ["useUnassigned", "Use Unassigned Duplicates", "Duplicates waiting in Unassigned (visit that screen once so the app loads them)."],
      ["useTransferDuplicates", "Use Transfer List Duplicates", "Duplicates on your transfer list that aren't listed for sale."],
      ["keepSquadPlayers", "Keep Squad Players, Fill Rest", "Players already in this SBC stay; only the empty slots are filled."]
    ];

    function openAutoOptions(scope) {
      if (busy) return;
      const a = settings.auto;
      const id = ctx.challengeId;
      const inSet = ctx.onSbc && (ctx.setChallenges ?? 0) > 1;
      const left = (ctx.setChallenges ?? 0) - (ctx.setCompleted ?? 0);
      const body = el("div", "opts");
      const save = () => saveSettings(settings);
      const toggleRow = (key, label, tip, disabled = false) => {
        const row = el("label", `orow${disabled ? " dis" : ""}`);
        row.title = tip;
        const sw = el("span", "sw");
        const cb = el("input");
        cb.type = "checkbox";
        cb.checked = !disabled && !!a[key];
        cb.disabled = disabled;
        cb.addEventListener("change", () => {
          a[key] = cb.checked;
          save();
          refreshMultiple();
        });
        sw.append(cb, el("span"));
        row.append(el("span", "", label), sw);
        return row;
      };
      const rangeRow = (label, minKey, maxKey) => {
        const box = el("div", "orange");
        box.append(el("div", "olabel", label));
        const line = el("div", "orow");
        const num = (key) => {
          const input = el("input");
          Object.assign(input, { type: "number", min: 45, max: 99, step: 1, value: a[key] });
          input.addEventListener("change", () => {
            const v = Math.min(99, Math.max(45, Number(input.value) || a[key]));
            a[key] = v;
            input.value = v;
            if (a[minKey] > a[maxKey]) {
              [a[minKey], a[maxKey]] = [a[maxKey], a[minKey]];
              box.querySelectorAll("input")[0].value = a[minKey];
              box.querySelectorAll("input")[1].value = a[maxKey];
            }
            save();
          });
          return input;
        };
        line.append(el("span", "", "Min"), num(minKey), el("span", "", "Max"), num(maxKey));
        box.append(line);
        return box;
      };

      if (scope === "challenge" && savedSquads[id]?.length) {
        const saved = el("div", "saved");
        saved.append(
          el("div", "", `${savedSquads[id].length} saved squad${savedSquads[id].length > 1 ? "s" : ""} from "Solve multiple times".`),
          button("Fill next saved squad", "go", () => {
            close();
            fillNextSaved(id);
          })
        );
        body.append(saved);
      }
      for (const [key, label, tip] of AUTO_TOGGLES) body.append(toggleRow(key, label, tip, key === "useConcept"));

      // Solve multiple times (repeatable SBCs only)
      const multi = el("div", "orow");
      const multiToggle = toggleRow("solveMultiple", "Solve Multiple Times", "Repeatable SBCs: find several squads with no player reused.");
      // Never more squads than the SBC can still be completed (this one included).
      const maxTimes = Math.min(MAX_SOLVE_TIMES, ctx.repeatsLeft ?? MAX_SOLVE_TIMES);
      const times = el("input");
      Object.assign(times, { type: "number", min: 2, max: maxTimes, step: 1, value: Math.min(a.solveTimes, maxTimes) });
      times.addEventListener("change", () => {
        times.value = Math.min(maxTimes, Math.max(2, Number(times.value) || 2));
        a.solveTimes = Number(times.value);
        save();
      });
      multi.append(multiToggle, times);
      if (ctx.repeatsLeft != null) {
        times.title = `${ctx.repeatsLeft} of ${ctx.repeats} completions left`;
        multi.append(el("span", "left", `of ${ctx.repeatsLeft} left`));
      }
      const multiAllowed = scope === "challenge" && ctx.repeatable && maxTimes >= 2;
      if (!multiAllowed) {
        multiToggle.classList.add("dis");
        multiToggle.querySelector("input").disabled = true;
        multiToggle.querySelector("input").checked = false;
        multiToggle.title = !ctx.repeatable || scope !== "challenge"
          ? "Only for repeatable SBCs."
          : `Only ${ctx.repeatsLeft} completion${ctx.repeatsLeft === 1 ? "" : "s"} left for this SBC.`;
      }
      body.append(multi);
      function refreshMultiple() {
        times.disabled = !multiAllowed || !a.solveMultiple;
      }
      refreshMultiple();

      body.append(rangeRow("Rating range", "ratingMin", "ratingMax"), rangeRow("Special rating range", "specialRatingMin", "specialRatingMax"));

      const using = el("div", "orange");
      using.append(el("div", "olabel", "Solve using"));
      const select = el("select");
      [["price", "Price (cheapest squad)"], ["rating", "Rating (lowest-rated players)"]].forEach(([v, t]) => {
        const o = el("option", "", t);
        o.value = v;
        select.append(o);
      });
      select.value = a.solveUsing;
      select.addEventListener("change", () => {
        a.solveUsing = select.value;
        save();
      });
      using.append(select);
      body.append(using);

      let whole = scope === "set";
      if (scope === "challenge" && inSet && left > 1) {
        const pick = el("div", "orange");
        pick.append(el("div", "olabel", "Complete"));
        const which = el("select");
        [["challenge", "This challenge"], ["set", `Whole set (${left} challenges left)`]].forEach(([v, t]) => {
          const o = el("option", "", t);
          o.value = v;
          which.append(o);
        });
        which.value = a.scope === "set" ? "set" : "challenge";
        whole = which.value === "set";
        which.addEventListener("change", () => {
          whole = which.value === "set";
          a.scope = which.value;
          save();
        });
        pick.append(which);
        body.append(pick);
      }

      const { close } = openDialog({
        title: scope === "set" ? "Auto Complete Set" : "Auto Complete SBC",
        subtitle: "Select your auto-complete options.",
        body,
        confirmLabel: "Generate solution",
        onConfirm: () => {
          if (whole) runFillSet();
          else if (multiAllowed && a.solveMultiple) runFillMultiple(Math.min(a.solveTimes, maxTimes));
          else runFillOne();
        }
      });
    }

    onPageEvent = (msg) => {
      if (msg.type === "autoComplete") openAutoOptions(msg.scope === "set" ? "set" : "challenge");
    };

    // ---------- fill this SBC ----------

    async function runFillOne() {
      if (busy) return;
      setBusy(true);
      result.replaceChildren();
      await pauseHubWorker();
      try {
        showBusy("Reading your club…");
        const input = await request("solveInput", { onProgress: showBusy });
        showBusy(`Finding the cheapest squad (up to ${settings.timeLimitS}s)…`);
        const res = await toBackground({
          type: "solve",
          payload: {
            club: input.club,
            sbc: input.sbc,
            options: solverOptions({
              maxSolutions: 1,
              timeLimitS: settings.timeLimitS,
              keep: settings.auto.keepSquadPlayers ? keptSlots(input.sbc) : {}
            })
          }
        });
        const sol = res.solutions?.[0];
        if (!sol) return showNoSolution(res.status, res.unsupported);
        if (sol.validationErrors?.length) return showDone(`Not filled: solver self-check failed (${sol.validationErrors.join("; ")}).`, "bad");
        const app = await request("fillSquad", {
          onProgress: showBusy,
          args: { challengeId: res.challenge.id, slots: sol.slots.map((x) => ({ slotIndex: x.slotIndex, playerId: x.playerId })) }
        });
        clubChanged();
        showDone("Squad placed. Review it, then press Submit in the app.", "ok");
        result.append(singleCard(sol, app, res.stats));
        const warn = activeSquadWarning(input.club);
        if (warn) result.append(warn);
      } catch (e) {
        showDone(e.message, "bad");
      } finally {
        setBusy(false);
        pollContext();
      }
    }

    function showNoSolution(status, unsupported) {
      if (status === "unsupported") {
        showDone("This SBC has a requirement the solver doesn't support yet.", "warn");
        const card = el("div", "card");
        (unsupported || []).forEach((u) => card.append(el("div", "muted", `• ${u}`)));
        result.append(card);
      } else if (/not enough players/.test(status || "")) {
        showDone("Your club doesn't have enough players for that many squads without reusing cards.", "warn");
      } else if (status === "infeasible") {
        const cap = settings.maxCost > 0 ? ` or raise Max player value (⚙, now ${fmt(settings.maxCost)})` : "";
        showDone(`Your club can't complete this SBC with these options. Try Allow Special Players, Allow Tradeable Players or Ignore exclusions in Auto Complete${cap}.`, "warn");
      } else {
        showDone("No squad found in time. Try a longer time limit (⚙).", "warn");
      }
    }

    // Whether a fill gives up cards you could have sold.
    function tradeableNote(slots) {
      const sold = slots.filter((x) => x.tradable);
      if (!sold.length) return el("div", "ok", "✓ No tradeable cards used");
      const worth = sold.reduce((a, x) => a + (x.marketPrice ?? 0), 0);
      return el("div", "warn", `⚠ Uses ${sold.length} tradeable card${sold.length > 1 ? "s" : ""} (worth ${fmt(worth)})`);
    }

    // value = sum of EA market averages (what the card badges show), not the solver's weighting.
    function tiles(value, rating, chem) {
      const t = el("div", "tiles");
      [["Squad value", fmt(value)], ["Rating", rating], ["Chem", chem]].forEach(([k, v]) => {
        const tile = el("div", "tile");
        tile.append(el("b", "", String(v ?? "–")), el("span", "", k));
        t.append(tile);
      });
      return t;
    }

    function mismatchNote(sol, app) {
      const m = [];
      if (app.rating != null && app.rating !== sol.teamRating) m.push(`rating: app ${app.rating}, solver ${sol.teamRating}`);
      if (app.chemistry != null && app.chemistry !== sol.chemistry) m.push(`chem: app ${app.chemistry}, solver ${sol.chemistry}`);
      if (app.wrongSlots?.length) m.push(`slots not as planned: ${app.wrongSlots.join(", ")}`);
      return m.length ? el("div", "warn", `Please report: ${m.join("; ")}`) : null;
    }

    function undoButton() {
      const b = button("Undo fill", "btn small", async () => {
        if (busy) return;
        setBusy(true);
        b.disabled = true;
        try {
          await request("undoFill", { onProgress: showBusy });
          showDone("Previous squad restored.");
          result.replaceChildren();
        } catch (e) {
          showDone(`Undo failed: ${e.message}`, "bad");
          b.disabled = false;
        } finally {
          setBusy(false);
        }
      });
      return b;
    }

    function singleCard(sol, app, stats) {
      const card = el("div", "card");
      const met = app.meetsRequirements === true || app.canSubmit === true;
      card.append(
        tiles(sol.squadValue ?? 0, app.rating ?? sol.teamRating, app.chemistry ?? sol.chemistry),
        el("div", met ? "ok" : "warn", met ? "✓ All requirements met" : "⚠ The app doesn't show all requirements met. Check the squad."),
        tradeableNote(sol.slots),
        el("div", "muted", `Solved in ${stats?.wallTimeS ?? "?"}s`)
      );
      const note = mismatchNote(sol, app);
      if (note) card.append(note);
      card.append(undoButton());
      return card;
    }

    // ---------- fill whole set ----------

    async function runFillSet() {
      if (busy) return;
      setBusy(true);
      result.replaceChildren();
      await pauseHubWorker();
      try {
        showBusy("Loading the set's challenges…");
        const input = await request("setInput", { onProgress: showBusy });
        const n = input.sbcs.length;
        const budget = Math.min(60, settings.timeLimitS * n); // a cap: usually finishes sooner
        showBusy(`Solving ${n} challenges together, no player used twice (up to ${budget}s)…`);
        const res = await toBackground({
          type: "solveSet",
          payload: {
            club: input.club,
            sbcs: input.sbcs,
            options: solverOptions({ timeLimitS: budget })
          }
        });
        const solvable = res.challenges.filter((c) => c.status === "solved");
        if (!solvable.length) {
          showDone(`None of the ${input.setName} challenges can be filled. Nothing was changed.`, "warn");
          result.append(setCard(res, []));
          return;
        }
        const bad = solvable.find((c) => c.solution.validationErrors?.length);
        if (bad) return showDone(`Not filled: solver self-check failed for ${bad.name}.`, "bad");

        // Preview before touching anything.
        const ids = solvable.flatMap((c) => c.solution.slots.map((x) => x.playerId));
        const details = await request("describePlayers", { args: { ids }, timeoutMs: 5000 });
        const skippedNotes = res.challenges
          .filter((c) => c.status !== "solved")
          .map((c) => `${c.name}: ${SET_STATUS_TEXT[c.status] || c.status}`);
        showBusy("Waiting for you to confirm…");
        const chosenIds = await showPreview({
          title: `${input.setName}: preview`,
          subtitle: `${solvable.length} of ${n} challenges solved in ${res.stats?.wallTimeS ?? "?"}s · no player used twice`,
          notes: skippedNotes.length ? ["Can't be filled:", ...skippedNotes] : [],
          sections: solvable.map((c) => ({
            id: c.challengeId,
            name: c.name,
            players: c.solution.slots.map((x) => ({
              name: x.name, rating: x.rating, price: x.marketPrice, tradable: x.tradable, ...(details[x.playerId] || {})
            }))
          })),
          confirmLabel: "Fill squads"
        });
        if (!chosenIds) return showDone("Cancelled. Nothing was changed.");
        const chosen = solvable.filter((c) => chosenIds.includes(c.challengeId));
        const fill = await request("fillSet", {
          onProgress: showBusy,
          args: {
            plan: chosen.map((c) => ({
              challengeId: c.challengeId,
              slots: c.solution.slots.map((x) => ({ slotIndex: x.slotIndex, playerId: x.playerId }))
            }))
          }
        });
        clubChanged();
        const failed = fill.results.find((r) => !r.ok);
        const skipped = n - chosen.length;
        showDone(failed
          ? `Stopped at a challenge that failed to save: ${failed.error}. Earlier fills were kept (Undo reverts them).`
          : skipped
            ? `Filled ${chosen.length} of ${n} challenges (the rest are listed below). Open each filled one and press Submit.`
            : `All ${n} challenges filled. Open each one and press Submit.`, failed || skipped ? "warn" : "ok");
        result.append(setCard(res, fill.results));
      } catch (e) {
        showDone(e.message, "bad");
      } finally {
        setBusy(false);
        pollContext();
      }
    }

    const SET_STATUS_TEXT = {
      solved: "not filled",
      infeasible: "not possible with your club",
      unsupported: "unsupported requirement",
      timeout: "no squad found in time"
    };

    function setCard(res, fillResults) {
      const card = el("div", "card");
      const byId = new Map(fillResults.map((r) => [r.challengeId, r]));
      const filled = res.challenges.filter((c) => byId.get(c.challengeId)?.ok);
      const value = filled.reduce((a, c) => a + (c.solution.squadValue ?? 0), 0);
      if (filled.length) {
        card.append(
          el("div", "", `Total squad value ${fmt(value)} · ${filled.length}/${res.challenges.length} filled`),
          tradeableNote(filled.flatMap((c) => c.solution.slots))
        );
      }
      const rows = el("div", "rows");
      for (const c of res.challenges) {
        const r = byId.get(c.challengeId);
        const met = r?.ok && (r.meetsRequirements === true || r.canSubmit === true);
        const row = el("div", "row");
        const mark = r
          ? !r.ok ? "save failed" : met ? `✓ ${fmt(c.solution.squadValue ?? 0)}` : `⚠ ${fmt(c.solution.squadValue ?? 0)}`
          : SET_STATUS_TEXT[c.status] || c.status;
        row.append(el("span", "n", c.name), el("span", !r ? "warn" : !r.ok ? "bad" : met ? "ok" : "warn", mark));
        rows.append(row);
        if (r?.ok) {
          const note = mismatchNote(c.solution, r);
          if (note) rows.append(note);
        }
      }
      card.append(rows);
      if (filled.length) card.append(undoButton());
      return card;
    }

    // ---------- start ----------

    refreshButtons();
    checkHealth();
    pollContext();
    setInterval(() => !busy && pollContext(), CONTEXT_POLL_MS);
    setInterval(() => !busy && checkHealth(), HEALTH_POLL_MS);
  }

  if (!document.getElementById("sbcs")) buildPanel();
})();
