# Build "Road to 75" — an MLS spin-team game

Build a complete, playable, static web game in this repository (`75points`, remote: https://github.com/kierdoyle/75points), in the spirit of the 7-0 World Cup game (https://7a0.com.br/en) and the 82-0 NBA game: the player assembles a fantasy squad from random spins, then simulates a season chasing a near-impossible target. Then deploy it to Netlify.

Everything below has been verified against the live ASA API — endpoint names, field names, and position codes are real. Trust them.

## Environment (already set up — do not redo)

- Python venv: `/Users/kierdoyle/Toronto/Data/MLSData/.venv/bin/python` with `itscalledsoccer` and `pandas` installed. Use it for all data prep.
- Node v26 + npm installed. Netlify CLI v27 installed globally (`netlify`). The user may or may not have run `netlify login` yet — check `netlify status` before deploying; if not logged in, finish everything else and tell the user to run `netlify login` and then what deploy command to run (or re-invoke you).
- Work only inside this repo. `gh` is authenticated as `kierdoyle`; commit in sensible increments and push to `main` when the game works end-to-end. Add a proper `.gitignore` (node_modules, dist) and a short README with the game rules and the live URL.

## Game concept

1. **Setup screen:** the player picks a **difficulty** (Easy = 5 rerolls, Normal = 3, Hard = 1), a **formation** (offer 4-3-3, 4-4-2, 4-2-3-1, 3-5-2, 5-3-2... at least 4 options), and a **conference** (East or West — this is the conference their fantasy club will play in for the 2026 sim).
2. **Draft phase:** the player fills 11 starting slots + 3 subs (1 defender, 1 midfielder, 1 attacker) = 14 picks. Each **spin** lands on a random **(team, season)** pair drawn league-wide from every MLS team-season 2013–2026 (2026 = partial season, included). The player must pick exactly one player from that team-season's roster who is eligible for at least one open slot, then slot them in. Then spin again, until the squad is full.
3. **Season phase:** their squad becomes an expansion club in their chosen conference for the 2026 season. Simulate a 34-game regular season match by match, then the MLS Cup Playoffs. **Win condition (all difficulties): ≥ 75 regular-season points AND win MLS Cup.** 75 points would break the all-time MLS record (74, New England 2021) — it is *supposed* to be nearly impossible. Do not soften the calibration to make it easy; a genuinely stacked draft should have a real shot, an average one should not.

### Draft rules

- **Position eligibility** (ASA `general_position` codes): GK slot ← `GK` only; CB ← `CB`; FB/wingback ← `FB`; DM ← `DM`, `CM`; CM ← `CM`, `DM`, `AM`; AM ← `AM`, `CM`; W ← `W`, `AM`; ST ← `ST`, `W`. Sub slots: defender ← `CB`/`FB`, midfielder ← `DM`/`CM`/`AM`, attacker ← `W`/`ST`.
- **Designated Player rule:** a player counts as a **DP** if their guaranteed compensation in their spun season exceeds **$1,700,000** (make this a named constant, `DP_THRESHOLD = 1_700_000`; flat across all seasons — yes, that makes old-season stars cheap; that's a deliberate gameplay quirk). **Max 3 DPs in the 14-man squad.** The UI must badge DPs on the spin screen and block a 4th DP pick.
- **No duplicate people:** the same `player_id` can't be picked twice, even from different seasons.
- **Rerolls:** a reroll discards the current (team, season) spin for a fresh one. Count by difficulty. If a spin offers **no eligible pick** for any open slot (all remaining players are wrong positions, already-picked, or blocked by the DP cap), auto-respin for free — that never costs a reroll.
- Once a player is picked they're locked (no undo — cursed picks are the point).

## Data prep (Python script → static JSON, bundled with the site)

Write `scripts/build_data.py` (run with the venv python). It fetches everything from ASA once and writes compact JSON into the site's `public/data/`. The deployed game makes **zero** API calls.

Verified API usage (`from itscalledsoccer.client import AmericanSoccerAnalysis`, `asa = AmericanSoccerAnalysis()`):

- `asa.get_player_goals_added(leagues="mls", season_name="2024")` → DataFrame: `player_id, team_id, general_position, minutes_played, data`, where `data` is a list of dicts per action type: `{'action_type': 'Dribbling', 'goals_added_raw': …, 'goals_added_above_avg': …, 'count_actions': …}` (action types: Dribbling, Fouling, Interrupting, Passing, Receiving, Shooting). Rows exist for 2013 (469 rows) through 2026 (716 rows so far).
- `asa.get_goalkeeper_goals_added(leagues="mls", season_name="2024")` → `player_id, team_id, minutes_played, data` with GK action types (Claiming, Fielding, Handling, Passing, Shotstopping, Sweeping). Same structure, no `general_position` — these are the GKs.
- `asa.get_player_salaries(leagues="mls", season_name="2024")` → `player_id, team_id, season_name, position, base_salary, guaranteed_compensation, mlspa_release`. Multiple rows per player-season (one per MLSPA release) — keep the **latest `mlspa_release`** per (player_id, season); prefer the row matching the spun team_id if the player has rows on several teams. Available for all seasons incl. 2013 and (partial) 2026. Missing salary ⇒ treat as non-DP.
- `asa.get_players(leagues="mls")` → `player_id, player_name, …` (names).
- `asa.get_teams(leagues="mls")` → `team_id, team_name, team_short_name, team_abbreviation` (31 teams incl. defunct Chivas USA).
- `asa.get_games(leagues="mls", season_name="2024")` → per game: `home_score, away_score, home_team_id, away_team_id, season_name, matchday, knockout_game, status, …`. Use `status == "FullTime"` and `knockout_game == False` for regular-season records.

**Player score** = sum of `goals_added_above_avg` across all action types for that season (ASA's above-avg is already position-adjusted — this is exactly "g+ above average for their position"). Same for GKs using their action types. Round to 2 dp for display.

- **2026 pro-rating:** scale each 2026 player's score by `34 / team_games_played_2026` (from the games table) so partial-season spins aren't systematically weak. Label 2026 entries "2026 (projected)".
- **Minutes floor:** exclude players with < 180 minutes in that season from the spin rosters (noise filler). Keep the floor a named constant.
- **Spin pool:** every (team_id, season) with a g+ roster after filtering. That's roughly 14 seasons × ~20–30 teams.

Also emit what the sim needs (see below): per-team-season total strength for 2013–2025 with actual points and games played, and 2026 opponent strengths (per-team sum of pro-rated player scores, current rosters). Keep total JSON payload small (only fields the game uses; ~8–10k player rows is fine).

## Sim engine

Calibrate once in Python, bake the constants into JSON, sim in JS in the browser.

- **Calibration:** for each team-season 2013–2025 (exclude 2020, the COVID short season), compute `strength = Σ player scores` (outfield + GK, same scoring as above, no minutes floor here) and actual regular-season points-per-game from the games data. Fit `ppg = a + b·strength_per_game` by least squares; record residual σ. Sanity-check: an average team (~strength 0) should land near ~1.35 ppg (≈46 pts), and 75+ points should sit ~2+ residual σ above what even top historical strengths produced.
- **User team strength:** Σ starting-XI scores + 0.3 × Σ sub scores (tunable constant).
- **Opponents:** the 29 other 2026 MLS clubs at their pro-rated 2026 strengths.
- **Schedule:** user club joins chosen conference as an expansion side; play each conference rival home & away, fill to 34 with cross-conference games. Sim each match with Poisson goals: convert the strength gap (per-game g+ edge) into λ_home/λ_away around a league base of ~1.4 goals/team/game with MLS-typical home advantage (~+0.35 expected GD); clamp λ ≥ 0.2. Tune so that season-point distributions from match sim match the fitted linear model.
- **League table:** sim the other clubs' seasons too (match-level or points-from-model + noise — your call) to build both conference tables.
- **Playoffs:** top 8 per conference (skip the wild-card game). Round One **best-of-3** (1v8, 2v7, 3v6, 4v5; drawn games go straight to a PK shootout, as in the real format — sim PKs ~50/50 with a slight edge to the stronger side), then single-elimination Conference Semis, Conference Final, and MLS Cup (hosted by the better seed).
- Sanity-test the engine headlessly (Node or Python port) before wiring the UI: average drafts should typically miss the playoffs or exit early; only elite drafts should crack 70+ points.

## UI / UX

- Single-page static app, **mobile-first** (friends will play on phones). Vanilla JS + Vite is plenty; no backend, no accounts.
- Fun slot-machine spin animation for the (team, season) reveal, using **official club badges** hotlinked from ASA's S3 bucket: `https://american-soccer-analysis-headshots.s3.amazonaws.com/club_logos/{team_id}.png` (verified working, incl. defunct clubs like Chivas USA — the `.png` extension is required or S3 returns 403). Do **not** download/bundle the images; hotlink them.
- **Player headshots**, same bucket: `https://american-soccer-analysis-headshots.s3.us-east-1.amazonaws.com/player_headshots/{player_id}.png` (verified working with excellent coverage back to 2013). Show them on the spin-screen roster and on the filled formation/pitch view. Both badges and headshots need a graceful fallback (colored monogram from `team_abbreviation` / player initials) via an `onerror` handler for the occasional 404 — never a broken-image icon.
- Spin screen: team + season header with the club badge, roster grouped by position with headshot, score, DP badge, minutes, and greyed-out ineligible/blocked players with the reason. Show remaining rerolls and open slots (pitch view of the formation filling up).
- Season phase: a matchday-by-matchday results ticker (skippable/fast-forward), live points total vs. the 75-point pace line, then a playoff bracket view.
- End screen: win/lose verdict, final squad, points, playoff run — plus a **copy-to-clipboard share text** (emoji grid + score, Wordle-style) so friends can compare.
- Title: "Road to 75" (or better if you think of one — keep it on-theme).

## Deploy

- `netlify.toml` is already scaffolded here (publish `dist`, build `npm run build`) — adjust if your structure differs.
- Build, test locally with the browser preview tools (verify a full playthrough: draft → season → playoffs → share), then if `netlify status` shows a logged-in user, deploy: `netlify deploy --prod` (create a new site, e.g. `mls-road-to-75`). If not logged in, stop before deploying and give the user the exact commands. (Optionally suggest linking the Netlify site to the GitHub repo afterwards for auto-deploys on push — that's done in the Netlify web UI.)
- Report the live URL when done.

## QA checklist before calling it done

- [ ] Draft can always complete (dead spins auto-respin free; DP cap can never soft-lock the draft).
- [ ] All 5+ formations fill correctly; sub slots enforce D/M/F.
- [ ] DP badge matches salary data; 4th DP is blocked with a clear message.
- [ ] 2026 spins show projected scores, not tiny partial totals.
- [ ] Sim sanity: ~500-run headless batch — median expansion-ish team ~40–50 pts; 75+ only from stacked drafts.
- [ ] Badges/headshots load from S3; a bogus id falls back to the monogram/initials avatar, not a broken image.
- [ ] Works on a 375px-wide viewport.
- [ ] Share text pastes correctly.
