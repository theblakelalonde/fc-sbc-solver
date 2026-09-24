# FC 27 SBC Solver

Chrome extension for the EA SPORTS FC 27 Ultimate Team Web App. It finds the cheapest squad from your own club for a Squad Building Challenge and places it on the pitch. For repeated SBCs and whole sets it can also submit every squad for you, back to back.

Everything runs inside your browser: no server, no account, nothing to install beyond loading the extension.

> Not affiliated with or endorsed by EA. Third-party tools may be against EA's terms of service; use at your own risk. The extension only submits SBCs when you press **Complete** in its preview, and never buys, lists or bids, or touches the transfer market.

## Install

1. Download `fc27-sbc-solver-vX.Y.Z.zip` from the [latest release](../../releases/latest) and unzip it somewhere you'll keep it (Chrome loads the extension from that folder).
2. Open `chrome://extensions` and turn on **Developer mode** (top-right).
3. **Load unpacked** → select the unzipped `fc27-sbc-solver-vX.Y.Z` folder (the one containing `manifest.json`).
4. Open the [FC 27 Web App](https://www.ea.com/ea-sports-fc/ultimate-team/web-app/) and press F5.

The **SBC Solver** panel appears bottom-left. Its pill should say **Solver ready** (green).

**Update:** download the new release, replace the folder's contents with it, press reload ↻ on the extension card, then F5 the Web App. (Keeping the same folder keeps your settings.)

Chrome may warn about developer-mode extensions on startup; that's normal for unpacked extensions.

## Use

1. Open an SBC. An **Auto Complete** button (green outline) appears in the app's SBC sidebar; on a set's overview page it's **Auto Complete Set**.
2. Pick options (tradeable players, special players, storage first, exclude active squad, solve multiple times, rating ranges, …) and press **Generate solution**.
3. Check the squad, then press **Submit** in the app. **Undo fill** in the panel puts back what was there before.

- **Whole sets / solve multiple times:** a preview lists every squad (no player used twice) before anything is placed. Toggle off any you don't want, then press **Complete** (the default) to fill and submit each remaining squad back to back, or **Fill only** to place them and submit yourself. If your club can't cover all of them, you get the ones that are possible. Submitting can't be undone; it stops at the first squad the app doesn't accept.
- **Price badges on cards:** coin value (EA market average), green `$` = tradeable, grey 🚫 = untradeable, blue = from SBC storage. Values with `~` and a dashed border are estimates (EA has no price for that card): the median EA price of your own cards with the same rating.
- **Squad value** in the SBC header, and a value summary on store pack previews.
- ⚙ in the panel: turn each display on or off (card price badges, squad value, pack value, SBC values on the SBC page), plus max player value (0 = no limit) and time limit. Click the panel header to collapse it.

## How it works

- `extension/src/page-hook.js` runs in the Web App page: reads your club and the SBC, places squads, draws badges.
- `extension/src/solver/sbc-solver.js` runs in the extension's service worker on [HiGHS](https://highs.dev) compiled to WebAssembly (`extension/vendor/highs/`, highs-js 1.15.3, MIT):
  - rating SBCs without chemistry: exact, one small model per reachable rating sum, cheapest first;
  - chemistry SBCs: simulated-annealing search, then an exact re-solve around its squad;
  - sets: each challenge alone; if they'd share players, one after another (hardest first) plus a joint re-solve.
- Every squad is re-checked by independent rule code before it's placed. Game rules (team rating rounding, chemistry thresholds, bricks) are confirmed against the app; see [docs/webapp-internals.md](docs/webapp-internals.md).
- Cost: EA market average. Untradeables and SBC storage count at 30% of their value. Excluded by default: loans, special cards, players in evolutions, anyone worth over 50k.

## Development

Run from source: **Load unpacked** the repo's `extension/` folder. After editing files: reload the extension card, then F5 the Web App tab.

**Releasing:** bump `"version"` in `extension/manifest.json`, commit, then push a matching tag (`git tag v0.9.6`, `git push origin v0.9.6`). The [release workflow](.github/workflows/release.yml) builds the zip and publishes the release.

Tests (Node 20+), about 90 s, using the dumps in `test/fixtures/`:

```bash
cd extension
node --test test/solver.test.js
```

**Developer tools** (⚙ → Developer tools): Probe (which Web App globals exist), Dump club, Dump SBC, Dump all SBCs. Put reviewed dumps in `test/fixtures/`. Dumps can contain account identifiers; check before committing.

### Reference solver (Python, optional)

`solver-server/` is the original Python + OR-Tools CP-SAT solver, kept to cross-check the extension's results. The extension doesn't use it.

```bash
cd solver-server
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python -m sbc_solver --club ../test/fixtures/club-121.json --sbc ../test/fixtures/sbc-2x79-upgrade-filled.json
.venv/Scripts/python -m pytest -q
```

`start-solver.cmd` starts its HTTP server (old extension versions only).

## Credits

- [HiGHS](https://highs.dev) / [highs-js](https://github.com/lovasoa/highs-js) (MIT): the optimizer.
- FSU (`color8892/fsu-fut-enhancer`, MIT) was read as a reference for Web App internals; no code copied. It bundles market automation that this project deliberately excludes.
- EAFC Automated SBC Solving userscript (MIT): reference for the Web App's SBC submit call.
