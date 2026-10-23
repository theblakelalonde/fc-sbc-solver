# Chrome Web Store: listing and submission

Copy-paste answers for the Chrome Web Store Developer Dashboard.

## Package

Upload `fc27-sbc-solver-vX.Y.Z-chrome-web-store.zip` from the GitHub release (manifest.json at the zip root). Each update: bump `"version"` in `extension/manifest.json`, release as usual, upload the new store zip under **Package**, submit for review.

## Store listing

**Name:** SBC Solver for Web App

**Summary** (132 characters max):

> Solves SBCs in the EA SPORTS FC Ultimate Team Web App from your own club and fills the squads. Not affiliated with EA.

**Description** (plain text, paste as is):

```text
Auto Complete for Squad Building Challenges in the EA SPORTS FC Ultimate Team Web App.

Open an SBC, press Auto Complete in the challenge sidebar, pick your options, and the cheapest squad from your own club is placed on the pitch, ready to review and submit.

WHAT IT DOES
• Finds the cheapest squad that meets every requirement (ratings, chemistry, leagues, nations, clubs, rarities and more) using the cards you already own: club, SBC storage, unassigned and transfer list duplicates.
• Whole sets and repeatable SBCs: preview every squad first (no player used twice), then fill them, or fill and submit them back to back.
• Gallery (points) SBCs: picks the cheapest cards that reach the points target, using at most the number of cards you choose.
• Concept players (optional): when your club can't cover a challenge, the missing slots are filled with players to buy, with an estimated price. Squads with concept players are never submitted.

YOU STAY IN CONTROL
• Leave out your active squad, rares or special cards, set rating ranges and a max player value, and pick by price or by lowest rating.
• A live summary tells you exactly what will happen before you press Find squad.
• Step-by-step progress while it works, and Undo puts back whatever was in the squad before.

PRICES AT A GLANCE
• Coin value on every player card (EA market average), plus tradeable, untradeable and SBC storage markers and the card's FUT Gallery score.
• Squad value in the SBC header, pack value on store previews, and estimated SBC values on the SBC page.

PRIVATE BY DESIGN
Everything runs in your browser. No account, no server, nothing collected or sent anywhere. It never buys, lists or bids on the transfer market.

Not affiliated with or endorsed by Electronic Arts. EA SPORTS FC is a trademark of Electronic Arts Inc. Third-party tools may be against EA's terms of service; use at your own risk.
```

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
