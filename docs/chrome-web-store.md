# Chrome Web Store: listing and submission

Copy-paste answers for the Chrome Web Store Developer Dashboard.

## Package

Upload `fc27-sbc-solver-vX.Y.Z-chrome-web-store.zip` from the GitHub release (manifest.json at the zip root). Each update: bump `"version"` in `extension/manifest.json`, release as usual, upload the new store zip under **Package**, submit for review.

## Store listing

**Name:** SBC Solver for Web App

**Summary** (132 characters max):

> Solves SBCs in the EA SPORTS FC Ultimate Team Web App from your own club and fills the squads. Not affiliated with EA.

**Description:**

> Auto Complete for Squad Building Challenges in the EA SPORTS FC Ultimate Team Web App.
>
> • Finds the cheapest squad from your own club, SBC storage and duplicates, and places it on the pitch.
> • Whole sets and repeatable SBCs: preview every squad (no player used twice), then fill them, or fill and submit them back to back.
> • Gallery (points) SBCs: picks the cheapest cards that reach the points target, up to the number of cards you choose.
> • Concept players (optional): fills the slots your club can't cover with cards to buy, priced by estimate. Squads with concept players are never submitted.
> • Price badges on cards (EA market average, tradeable / untradeable / SBC storage), squad value in the SBC header, pack value on store previews, and SBC values on the SBC page.
> • Options: tradeable / special players, storage first, exclude your active squad, rating ranges, max player value.
>
> Everything runs in your browser: no account, no server, no data collected. The extension never buys, lists or bids on the transfer market.
>
> Not affiliated with or endorsed by Electronic Arts. EA SPORTS FC is a trademark of Electronic Arts Inc. Third-party tools may be against EA's terms of service; use at your own risk.

**Category:** Tools (or Fun)

**Language:** English

**Graphics:**
- Store icon: `extension/icons/icon-128.png`
- Screenshots: at least one, 1280×800 or 640×400 (the pitch with price badges and the preview modal work well).

## Privacy practices

**Single purpose:**

> Helps complete Squad Building Challenges in the EA SPORTS FC Ultimate Team Web App: finds squads from the user's own club and fills (optionally submits) them.

**Permission justifications:**

- `storage`: saves the user's settings and small caches (formations, brick layouts, SBC tile values) locally.
- Host access to `https://www.ea.com/*ea-sports-fc/ultimate-team/web-app/*` (content scripts): the extension only runs on the Web App, where it reads the user's club and SBCs and fills squads.

**Remote code:** No, I am not using remote code. (The solver, HiGHS compiled to WebAssembly, is bundled in the package.)

**Data usage:** tick **Website content** (it reads the Web App page to solve SBCs). It is not collected or transmitted. Leave everything else unticked. Certify:
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** https://github.com/theblakelalonde/fc-sbc-solver/blob/main/PRIVACY.md

## Distribution

**Visibility:** Public, or Unlisted (only people with the link can install it).

**Trader status:** non-trader (free, non-commercial).
