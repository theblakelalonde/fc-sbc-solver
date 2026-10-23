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

## Automatic upload on release (one-time setup)

The release workflow uploads the store zip and submits it for review by itself once these four GitHub secrets exist. Without them it only makes the GitHub release.

1. **Google Cloud project:** go to https://console.cloud.google.com, create a project (e.g. "SBC Solver publishing"), then **APIs & Services → Library** → search **Chrome Web Store API** → **Enable**.
2. **OAuth consent screen** (**APIs & Services → OAuth consent screen**): User type **External**, fill in an app name and your email, skip scopes, add your own Google account as a **test user**, save. Then set **Publishing status → In production** (ignore the verification prompt; you're the only user). In "Testing" status Google expires refresh tokens after 7 days and the upload starts failing.
3. **OAuth client** (**APIs & Services → Credentials → Create credentials → OAuth client ID**): type **Web application**, add the authorized redirect URI `https://developers.google.com/oauthplayground`, create. Copy the **client ID** and **client secret**.
4. **Refresh token:** open https://developers.google.com/oauthplayground → ⚙ (top right) → tick **Use your own OAuth credentials** → paste the client ID and secret. In "Input your own scopes" enter `https://www.googleapis.com/auth/chromewebstore` → **Authorize APIs** → sign in with the account that owns the extension → **Exchange authorization code for tokens**. Copy the **refresh token**.
5. **Publisher ID:** Chrome Web Store Developer Dashboard → **Publisher → Settings** (or Account) → copy the publisher ID.
6. **GitHub secrets:** repo → **Settings → Secrets and variables → Actions → New repository secret**, add:
   - `CWS_CLIENT_ID`
   - `CWS_CLIENT_SECRET`
   - `CWS_REFRESH_TOKEN`
   - `CWS_PUBLISHER_ID`

The account needs 2-Step Verification turned on to publish. The extension ID (`bnjielgnbghfkfjlkdgjnopinmnebpfp`) is already in the workflow.

After that, every release (bump the version, push the tag) also uploads to the store and submits it for review; the run's log shows the store's responses. If a run fails at the store step, the GitHub release is already made: fix the secret or the package and upload manually under **Package**.
