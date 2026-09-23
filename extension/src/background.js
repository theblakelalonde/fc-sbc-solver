// Service worker: runs the solver (src/solver/sbc-solver.js) on HiGHS compiled to WebAssembly
// (vendor/highs). Nothing leaves the browser; no local server needed.
importScripts("../vendor/highs/highs.js", "solver/sbc-solver.js");

let highsPromise = null;
let loadError = null;

function loadHighs() {
  if (!highsPromise) {
    // highs.js defines the global Module loader; point it at the bundled .wasm.
    highsPromise = Module({ locateFile: (file) => chrome.runtime.getURL("vendor/highs/" + file) }).catch((e) => {
      highsPromise = null;
      loadError = e;
      throw e;
    });
  }
  return highsPromise;
}

async function run(handler, payload) {
  const highs = await loadHighs();
  try {
    return handler(highs, payload);
  } catch (e) {
    // A WASM abort can leave the instance unusable: start a fresh one next time.
    if (e instanceof WebAssembly.RuntimeError || /abort/i.test(String(e && e.message))) highsPromise = null;
    throw e;
  }
}

async function health() {
  try {
    await loadHighs();
    return { ok: true, engine: "highs-wasm", version: chrome.runtime.getManifest().version };
  } catch (e) {
    throw new Error(`Solver failed to load: ${(loadError || e).message}`);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only our own content scripts talk to us.
  if (sender.id !== chrome.runtime.id || !msg || typeof msg.type !== "string") return false;
  const routes = {
    solve: () => run(SbcSolver.handleSolve, msg.payload),
    solveSet: () => run(SbcSolver.handleSolveSet, msg.payload),
    health
  };
  if (!Object.prototype.hasOwnProperty.call(routes, msg.type)) return false;
  routes[msg.type]().then(
    (data) => sendResponse({ ok: true, data }),
    (e) => sendResponse({ ok: false, error: e.message })
  );
  return true; // async response
});

// Warm up so the first solve doesn't pay the WASM compile.
loadHighs().catch(() => {});
