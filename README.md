# SBC Solver for Web App

<img width="1400" height="560" alt="Neon SBC Solver Soccer Formation (1)" src="https://github.com/user-attachments/assets/aad2e2c0-c9fd-47c3-9154-318999575391" />


Chrome extension for the EA SPORTS FC 27 Ultimate Team Web App. It finds the cheapest squad from your own club for a Squad Building Challenge and places it on the pitch. For repeated SBCs and whole sets it can also submit every squad for you, back to back.

Everything runs inside your browser: no server, no account, nothing collected or sent anywhere.

<img width="440" height="280" alt="SBC Solver Snowflake Squad (1)" src="https://github.com/user-attachments/assets/c99c1c1a-03fc-4b85-ab06-48ed9e6fc43a" />


**[Install from the Chrome Web Store →](https://chromewebstore.google.com/detail/sbc-solver-for-web-app/bnjielgnbghfkfjlkdgjnopinmnebpfp)**

> Not affiliated with or endorsed by EA. Third-party tools may be against EA's terms of service; use at your own risk. The extension only submits SBCs when you press **Complete** in its preview, and never buys, lists or bids, or touches the transfer market.

## Install

1. Open the [Chrome Web Store page](https://chromewebstore.google.com/detail/sbc-solver-for-web-app/bnjielgnbghfkfjlkdgjnopinmnebpfp) and press **Add to Chrome**.
2. Open the [FC 27 Web App](https://www.ea.com/ea-sports-fc/ultimate-team/web-app/) (press F5 if it was already open).

The **SBC Solver** panel appears bottom-left. Its pill should say **Solver ready** (blue dot). Chrome keeps the store version up to date on its own.

<details>
<summary>Manual install (from a GitHub release)</summary>

1. Download `fc27-sbc-solver-vX.Y.Z.zip` from the [latest release](../../releases/latest) and unzip it somewhere you'll keep it (Chrome loads the extension from that folder).
2. Open `chrome://extensions` and turn on **Developer mode** (top-right).
3. **Load unpacked** → select the unzipped `fc27-sbc-solver-vX.Y.Z` folder (the one containing `manifest.json`).
4. Open the Web App and press F5.

**Update:** download the new release, replace the folder's contents with it, press reload ↻ on the extension card, then F5 the Web App. (Keeping the same folder keeps your settings.) Chrome may warn about developer-mode extensions on startup; that's normal for unpacked extensions.

</details>

## Use

<p>
  <img width="49%" alt="Screenshot 2026-10-23 091957 (1)" src="https://github.com/user-attachments/assets/4be1f4d0-088c-4b0c-a063-e83e014a9859" />

  <img width="49%" alt="Screenshot 2026-10-23 091928 (1)" src="https://github.com/user-attachments/assets/16f3f1bd-ac96-4305-a518-0faf57c90d5a" />

</p>

1. Open an SBC. An **Auto Complete** button (blue outline) appears in the app's SBC sidebar; on a set's overview page it's **Auto Complete Set**.
2. Pick your options and press **Find squad**. The summary at the bottom of the dialog says exactly what will happen, and the panel shows each step as it works.
3. Check the squad, then press **Submit** in the app. **Undo fill** in the panel puts back what was there before.

**Auto Complete options**

- **Use:** tradeable players, special players, concept players, and **Ignore exclusions** (ignores the max player value and any excluded players).
- **Take from:** SBC storage first, unassigned duplicates, transfer list duplicates, and keep players already in the squad.
- **Leave out:** your active squad, and rares unless the SBC requires them.
- **Ratings:** a rating range, plus a separate range for special cards.
- **Strategy:** pick by **Price** (cheapest squad) or **Rating** (lowest-rated squad), and complete **This challenge** or the **Whole set**.
- **Repeat:** solve a repeatable SBC multiple times.

**More**

- **Whole sets / solve multiple times:** a preview lists every squad (no player used twice) before anything is placed. Toggle off any you don't want, then press **Complete** (the default) to fill and submit each remaining squad back to back, or **Fill only** to place them and submit yourself. If your club can't cover all of them, you get the ones that are possible. Submitting can't be undone; it stops at the first squad the app doesn't accept.
- **Gallery (points) SBCs:** on the card-grid screen, Auto Complete finds the cheapest cards whose FUT Gallery points reach the target, using at most **Max cards** (a 1–30 slider; fewer cards means higher-rated ones, so use the rating range to protect cards you want to keep). **Submit N cards** (the default) selects and submits them; **Select on grid** only ticks them so you can press Review Selection yourself.
- **Concept players:** when your club can't cover an SBC, the missing slots are filled with concept players found through EA's own concept search, marked **to buy** with an estimated price (the median EA price of your cards at that rating; 150 + OVR below 75). Squads containing concept players are filled, never submitted: buy those cards first.
- **Price badges on cards:** coin value (EA market average), green `$` = tradeable, grey 🚫 = untradeable, blue = from SBC storage, ◆ = FUT Gallery score. Values with `~` and a dashed border are estimates (EA has no price for that card): the median EA price of your own cards with the same rating.
- **Squad value** in the SBC header, pack value on store previews, and estimated SBC values on the SBC page.
- ⚙ in the panel: turn each display on or off, plus max player value (0 = no limit) and time limit. Click the panel header to collapse it.

## How it works

- `extension/src/page-hook.js` runs in the Web App page: reads your club and the SBC, places squads, draws badges.
- `extension/src/solver/sbc-solver.js` runs in the extension's service worker on [HiGHS](https://highs.dev) compiled to WebAssembly (`extension/vendor/highs/`, highs-js 1.15.3, MIT):
  - rating SBCs without chemistry: exact, one small model per reachable rating sum, cheapest first;
  - chemistry SBCs: simulated-annealing search, then an exact re-solve around its squad;
  - sets: each challenge alone; if they'd share players, one after another (hardest first) plus a joint re-solve.
- Every squad is re-checked by independent rule code before it's placed. Game rules (team rating rounding, chemistry thresholds, bricks) are confirmed against the app; see [docs/webapp-internals.md](docs/webapp-internals.md).
- Cost: EA market average. Untradeables and SBC storage count at 30% of their value. Excluded by default: loans, special cards, players in evolutions, anyone worth over 50k.


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

## Privacy

Nothing leaves your browser except the Web App's own requests to EA. Details: [PRIVACY.md](PRIVACY.md).

## Credits

- [HiGHS](https://highs.dev) / [highs-js](https://github.com/lovasoa/highs-js) (MIT): the optimizer.
- FSU (`color8892/fsu-fut-enhancer`, MIT) was read as a reference for Web App internals; no code copied. It bundles market automation that this project deliberately excludes.
- EAFC Automated SBC Solving userscript (MIT): reference for the Web App's SBC submit call.
