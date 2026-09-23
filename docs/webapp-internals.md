# FC 27 Web App internals (Phase 0 recon)

Status legend: **CONFIRMED** = seen in a dump from the live FC 27 Web App (2026-09-23 probe/club/SBC dumps). **HYPOTHESIS** = from FC 26-era FSU code (MIT, `color8892/fsu-fut-enhancer`), not yet seen on FC 27.

Web App URL: `https://www.ea.com/ea-sports-fc/ultimate-team/web-app/`. CONFIRMED

Note: disable other Web App extensions while capturing ground-truth dumps (they add their own controllers to the tree), so their patches can't change what we record.

## Globals — CONFIRMED

Present: `services`, `repositories`, `_appMain`, `getAppMain()`, `UTSearchCriteriaDTO`, `SBCEligibilityKey`, `SBCEligibilityScope`, `UTSquadChemCalculatorUtils`, `UTSBCChallengeEntity`, `UTSBCSetEntity`, `UTSquadEntity`, `UTItemEntity`, `UTNullItemEntity`, `UTPlayerItemView`, `UTSBCSquadOverviewViewController`, `ItemRarity`, `ItemPile`, `SearchSortType`, `JSUtils`. About 850 `UT*` globals in total.

Missing: `generateSbcSquadOptions`, `PlayerRarity`.

- `services` keys: Academy, Authentication, Champions, Chemistry, Club, Companion, Configuration, Cosmetics, EventToken, FCConfiguration, Item, Leaderboards, Localization, MTX, MessageQueue, Messages, Metrics, Module, MyStadium, Notification, Objectives, Onboarding, PIN, PlayerHealth, PlayerMetaData, Rivals, SBC, Showcase, Social, Squad, SquadBattles, Store, TransferMarket, URL, UTUtasRequestQueue, User, UserSettings, revenueSDK.
- `repositories` keys: Academy, Champions, Chemistry, Companion, Item, KeyAttributes, PlayStyle, PlayerIcon, PlayerMeta, Rarity, ServerSettings, Social, Squad, SquadBattles, Store, TeamConfig.
- `repositories.Item` keys: cachedDurationIndex, club, inbox, pileSizes, staticData, storage, transfer, unassigned.
- Services return observables: `obs.observe(ctx, (sender, response) => …)`, then `sender.unobserve(ctx)`. CONFIRMED (the club dump used it).

## Controllers — CONFIRMED

Root is `_appMain._rootViewController` (`UTRootViewController`), then `.currentController` (`UTGameTabBarController`), then `.currentController` (`UTGameFlowNavigationController`), then `.currentController` (the current screen).

On the SBC squad screen (desktop layout), `…currentController.leftController` is a `UTSBCSquadOverviewViewController` with `_challenge`. The right panel (`…rightController.currentController`) also holds the challenge.

## Club players — CONFIRMED

- Count: `services.Club.getStats()` → `response.stats.find(s => s.type === "players").count`.
- Cache: `repositories.Item.club.items.values()` holds the whole club once the app has loaded it. For a 121-player club it had all players plus 8 non-players (kits, tifo, ball, stadium, etc.), so filter on `item.type === "player"`. No `Club.search` paging was needed.
- `services.Club` methods: `getStats`, `search`, `onItemMoved`, `onEvoUpgradeRemoved`.
- SBC storage: `services.Item.searchStorageItems(new UTSearchCriteriaDTO())` returned 2 players.
- Team links: `repositories.TeamConfig.teamLinks` is 64 `[idA, idB]` pairs, e.g. `[116009, 1]`.

### Item (`UTItemEntity`) fields

**Own props:** `id`, `definitionId`, `type` (`"player"`), `teamId`, `leagueId`, `nationId`, `preferredPosition` (a `PlayerPosition` id), `basePossiblePositions` (array of `PlayerPosition` ids, 1–6 each), `untradeableCount`, `tradable`, `loans` (-1 = not a loan), `limitedUseType`, `duplicateId`, `groups`, `upgrades`, `owners`, `state`, `utasPile`, `lastSalePrice`, `discardValue`, `playStyle`, `attributes` (6 face stats).

**Behind prototype getters (not own props):** `rating` (backed by `_rating`) and `rareflag` (backed by `_rareflag`). The dump now reads both.

**Name:** `_staticData.firstName` / `lastName` / `knownAs` / `name` (`UTStaticPlayerItemDataDTO`).

**Useful methods:**
- `isPlayer`, `isGK`
- `isRare`, `isCommon`, `isSpecial`, `isLegend`, `isLeagueHeroItem`
- `isGoldRating`, `isSilverRating`, `isBronzeRating`
- `isTradeable`, `isEffectivelyTradable`, `isDuplicate`, `isTradeableDuplicate`, `isUnTradeableDuplicate`, `isDuplicateLoanPlayer`
- `isLimitedUse`, `isTimeLimited`, `isEnrolledInAcademy`, `isActiveInAcademy`, `isActiveInTimedEvolution`, `isAcademyGraduate`
- `isStorageItem`, `isMovable`, `isSuperChem`
- `getBaseRating`, `getTier`, `getBaseRarity`, `getMarketAverage`, `getPriceLimits`, `getBasePossiblePositions`

### Enums

- `PlayerPosition`: 0 GK, 1 SW, 2 RWB, 3 RB, 4 RCB, 5 CB, 6 LCB, 7 LB, 8 LWB, 9 RDM, 10 CDM, 11 LDM, 12 RM, 13 RCM, 14 CM, 15 LCM, 16 LM, 17 RAM, 18 CAM, 19 LAM, 20 RF, 21 CF, 22 LF, 23 RW, 24 RS, 25 ST, 26 LS, 27 LW.
- `ItemRarity`: 0 NONE, 1 RARE, 2 LOCK, 201 MANNEQUIN, 202 MULTI_MANNEQUIN, 999 DEFAULT. Special rarities come from `repositories.Rarity`, which the next club dump includes.
- `SBCEligibilityQualityType` and `ItemRatingTier`: 1 BRONZE, 2 SILVER, 3 GOLD.
- `PlayerPositionGroup`: 1 GK, 2 FB, 3 CB, 4 DM, 5 CM, 6 WM, 7 AM, 8 WG, 9 ST.

## SBC challenge — CONFIRMED

`UTSBCChallengeEntity` fields: `id`, `name`, `setId`, `formation` (e.g. `"f442"`), `type` (e.g. `BRICK_CHALLENGE`), `status`, `repeatable`, `timesCompleted`, `eligibilityOperation` (`"AND"` / `"OR"`), `eligibilityRequirements[]`, `squad` (`UTSquadEntity`).

The app has its own requirement checks: `meetsRequirements`, `isRequirementMet`, `getNumberOfRequirementsMet`, `canSubmit`, plus counters such as `getNumberOfPlayersByLeague/Nation/Club/Rarity/OVR/QualityTier/Tradability`. These can validate solver output without submitting.

### Requirement (`UTSBCEligibilityDTO`)

Shape: `kvPairs._collection` maps key → value array. The DTO also has `scope` and `count` (-1 = not a player-count requirement), plus the methods `getFirstKey`, `getFirstValue`, `getValue(key)`, `keys`, `buildString`.

Example: 2x 79+ Upgrade = `{ PLAYER_QUALITY: [3] }`, scope EXACT, count -1, which means "all players Gold".

- `SBCEligibilityScope`: 0 GREATER (min), 1 LOWER (max), 2 EXACT.
- `SBCEligibilityKey`:

| Id | Key | Id | Key |
|---|---|---|---|
| 0 | TEAM_STAR_RATING | 16 | NUM_TROPHY_REQUIRED |
| 2 | PLAYER_COUNT | 17 | PLAYER_LEVEL |
| 3 | PLAYER_QUALITY | 18 | PLAYER_RARITY |
| 4 | SAME_NATION_COUNT | 19 | TEAM_RATING |
| 5 | SAME_LEAGUE_COUNT | 21 | PLAYER_COUNT_COMBINED |
| 6 | SAME_CLUB_COUNT | 25 | PLAYER_RARITY_GROUP |
| 7 | NATION_COUNT | 26 | PLAYER_MIN_OVR |
| 8 | LEAGUE_COUNT | 27 | PLAYER_EXACT_OVR |
| 9 | CLUB_COUNT | 28 | PLAYER_MAX_OVR |
| 10 | NATION_ID | 30 | FIRST_OWNER_PLAYERS_COUNT |
| 11 | LEAGUE_ID | 33 | PLAYER_TRADABILITY |
| 12 | CLUB_ID | 35 | CHEMISTRY_POINTS |
| 13 | SCOPE | 36 | ALL_PLAYERS_CHEMISTRY_POINTS |
| 15 | LEGEND_COUNT | | |

### Requirement encodings — CONFIRMED against on-screen text (`test/fixtures/sbc-all-11.json`)

| On-screen text | Key | Scope | count | Values |
|---|---|---|---|---|
| Player Quality: Exactly Silver | PLAYER_QUALITY | EXACT | -1 | [2] (tier) |
| Player Quality: Min. Gold | PLAYER_QUALITY | GREATER | -1 | [3] |
| Gold: Min. 1 Players | PLAYER_LEVEL | GREATER | 1 | [3] (tier) |
| Liga Portugal: Min. 2 Players | LEAGUE_ID | GREATER | 2 | [308] |
| Scotland: Min. 1 Player | NATION_ID | GREATER | 1 | [42] |
| PSG OR OM: Min. 1 Player | CLUB_ID | GREATER | 1 | [73, 219] (any of) |
| Leagues in Squad: Exactly 3 | LEAGUE_COUNT | EXACT | -1 | [3] |
| Clubs in Squad: Min. 2 | CLUB_COUNT | GREATER | -1 | [2] |
| Players from the same League: Max 6 | SAME_LEAGUE_COUNT | LOWER | -1 | [6] |
| Players from the same Countries/Regions: Min. 4 | SAME_NATION_COUNT | GREATER | -1 | [4] |
| Team Rating: Min. 78 | TEAM_RATING | GREATER | -1 | [78] |
| Total Chemistry: Min. 30 | CHEMISTRY_POINTS | GREATER | -1 | [30] |

The pattern:
- **Per-player filters** (ids, level): `count` is the number of players, and scope applies to that count.
- **Squad-wide rules:** `count` is -1 and the target is in the value.
- **PLAYER_QUALITY with count -1:** every player's tier is compared using the scope.
- **Slots:** in non-brick challenges, slot `requirement` is null, so every slot is open.
- **Not seen yet:** PLAYER_RARITY, PLAYER_RARITY_GROUP, the OVR keys, ALL_PLAYERS_CHEMISTRY_POINTS, FIRST_OWNER_PLAYERS_COUNT and LEGEND_COUNT.

### Squad and formation

- `squad.getFormation()` → `UTSquadFormationDTO` with `name` (`f442`), `displayName`, and `positions[]` (`{id, typeId, name, typeName}`). The slot `id` is a `PlayerPosition`, e.g. RCB = 4 with `typeId` 5 (CB).
- `squad.getPlayers()` returns 23 `UTSquadSlotEntity`. Only the first 11 have a `position`.
- Each slot has `_item`, `index`, `position`, `requirement` (`UTSBCPlayerRequirementDTO`: `playerType` DEFAULT/BRICK/CUSTOM_BRICK, `elgReq`), `_chemistry`, `clubChemistryPoints`, `leagueChemistryPoints` and `nationChemistryPoints`.
- A BRICK slot is a locked placeholder that stays empty; the solver must not fill it. In the example, slot 0 (GK) is a BRICK, so only 10 players are needed.
- Squad-level getters: `getRating()`, `getChemistry()`, `getStarRating()`, `getParameterChemistry()`. The squad also holds `chemCalculator` (`UTSquadChemCalculatorUtils`) and `chemistryVO`.

## Chemistry — CONFIRMED (fixture `test/fixtures/sbc-2x79-upgrade-filled.json`)

The model below reproduced the app's chemistry exactly: every slot matched, and the total was 17 in both.

Per-player chem = min(3, nation + league + club points).

- Points come from how many squad players share that nation, league or club.
- Clubs are merged through `repositories.TeamConfig.teamLinks` before counting. Example: Miedema (women's team 116017) linked with Foden (Man City, 10), and both earned a club point.
- The app exposes the thresholds itself as `squad.chemistryVO.parameters[].contributionThresholds`, keyed by `typeId`:

| `typeId` | Link | 1 / 2 / 3 points at |
|---|---|---|
| 1 | Nation | 2 / 5 / 8 players |
| 2 | League | 3 / 5 / 8 players |
| 3 | Club | 2 / 4 / 7 players |

Where the app stores chemistry:
- **Per slot:** `clubChemistryPoints`, `leagueChemistryPoints`, `nationChemistryPoints`, `chemistry` (accessor), `inPossiblePosition` (accessor).
- **Squad level:** `chemistryVO.chemistry` and `squad.getChemistry()`.

Not yet tested:
- **Out of position:** every player in the fixture was in position, so the "0 chem when out of position" rule is unconfirmed.
- **Special cards:** icon and hero chem rules are untested.

## Team rating — CONFIRMED from the app's source (captured with ⚙ → Developer tools → Rating code; not in the repo, since it's EA's code)

The rating is computed in `UTSquadEntity._calculateRating`.
- **Who counts:** SBC squads count the 11 field players, and empty or brick slots are skipped. It always divides by 11.
- **Which formula:** a server switch, `UTServerSettingsRepository.KEY.SQUAD_RATING_FLOAT_CALCULATION_ENABLED`, picks between two formulas.
- **Active mode:** float, proven by the 84.69 → 84 fixture. Integer mode would have shown 85 there. The SBC dump now records the switch as `ratingFloatMode`.

**Float mode (active):**
1. `avg = S / 11`
2. `total = S + Σ (r − avg)` over players rated above avg
3. `rating = floor(Math.round(total) / 11)`

The `Math.round` step makes raw ratings from **X.9545 upward show as X+1**. Example: raw 83.967 shows 84, while 86.901 shows 86. The solver works with integer bounds from `rules.team_rating_bounds`: 11·total must fall between 121·R − 5 and 121·R + 115.

**Integer mode (inactive):**
1. `r = floor(S / 11)`
2. `total = S + Σ (rating − r)` over players rated above r
3. `rating = floor(total / 11)`

(Outside SBCs, substitutes add half their excess. That doesn't matter here.)

Star rating: `getStarRating()` compares the rating with `STAR_RATING_THRESHOLDS`. This is needed only for TEAM_STAR_RATING requirements, which aren't supported yet.

## Prices — free source found

`item.getMarketAverage()` (backed by `_marketAverage`) returns EA's own market-average price, e.g. 46950 for Szoboszlai. This can back the default PriceProvider with no third-party scraping. -1 means no data, which is typical for untradeables and non-players.

## Placing players (Phase 3) — not researched yet
