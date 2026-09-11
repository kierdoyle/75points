# Road to 75

**Live:** https://kierdoyle.github.io/75points/

Three leagues — MLS, the NWSL, and USL's two tiers drafted as one — each
chasing one point more than its own all-time record. Pick one on the setup
screen; each ships its own player pool, coaches, calibration and playoff
format.

Styled in [American Soccer Analysis](https://www.americansocceranalysis.com/)
livery — their blue (`#20b0e0`) and red (`#c02030`), sampled from the ASA
banner. Every rating in the game comes from ASA's data. This is a fan project,
not an ASA product.

### Where it is hosted

| | URL | Notes |
|---|---|---|
| GitHub Pages | https://kierdoyle.github.io/75points/ | Free, no account limits. Deploys on every push to `main`. |
| Netlify | https://75points.americansocceranalysis.com | Custom domain. Auto-deploys on push through the Netlify GitHub App. |

Both are driven from `main` and carry the same game, rooms included; the only
difference between the builds is the base path (see `vite.config.js`), because
Pages serves from `/75points/`. Netlify is the one to hand people. Pages is the
mirror that keeps working if the Netlify account runs out of credits, which
blocks deploys outright — prebuilt uploads included — until the usage period
rolls over.

A static, mobile-first MLS spin-team game in the spirit of the [7-0 World Cup game](https://7a0.com.br/en)
and the 82-0 NBA game. Spin your way through every MLS team-season since 2013,
draft a 14-man squad out of whatever the slot machine gives you, then run a 2026
season as an expansion club.

**Win condition: 75+ regular-season points *and* MLS Cup.**

75 would break the all-time MLS record (74, New England 2021). It is supposed to
be nearly impossible — even a perfectly drafted squad wins about 6% of the time.

## How it plays

1. **Setup** — pick a league, a difficulty, one of five formations, and (in MLS)
   the conference your club joins.

   | | Rerolls | DPs | Salary cap | Ratings |
   |---|---|---|---|---|
   | Easy | 5 | unlimited | — | shown |
   | Normal | 3 | 3 | — | shown |
   | Hard | 1 | 3 | yes | shown |
   | **Max** | none | 3 | yes | **hidden** |

   Max drafts blind: no g+ on the players, no percentile on the coaches, no
   projected points. Everything is revealed the moment the season kicks off.

   Blind boards are also **shuffled**. Rosters are stored best-first, so
   grouping them by position would leave the best player at the top of every
   group — the whole answer, with the numbers merely painted out. The order is
   derived from the board and the day, so a daily is still the same puzzle for
   everyone playing it.

   There is no public NWSL salary data, so that league has no Designated
   Players and no cap — its difficulties differ **only** in rerolls.

   Rerolls turn out to be the strongest difficulty lever by some distance —
   each one is worth about a point of final table position, more than the
   entire salary cap contributes.
2. **Draft** — each spin lands on a random (team, season) pair drawn from every MLS
   team-season 2013–2026. Take exactly one player from that roster into an open
   slot. 11 starters + 3 subs (one defender, one midfielder, one attacker).
   Picks are permanent — cursed picks are the point.
3. **Head coach** — pick one of three names off the touchline.
4. **Season** — your squad joins the 2026 league as an expansion side, plays 34
   games against the real current clubs, then the MLS Cup Playoffs.

Or [draft against friends](#draft-rooms) in a room.

## Draft rooms

Up to eight people draft together in a room. Create one, read the four-letter
code out, and everyone else joins with it — no accounts, no installs.

The shape of it:

* **One shared board a round.** Every round reveals a single club-season and
  the whole room drafts from that one roster, in **snake order** (1-2-3, then
  3-2-1). Everyone faces identical boards over the 14 rounds, so whoever comes
  out on top genuinely out-drafted the room rather than out-spun it.
* **The draft order is drawn at random** when the host starts, not taken from
  the order people arrived in — otherwise the host would open every draft.
* **Boards are shuffled**, always, not only when ratings are hidden. Everyone
  is reading the same list, so a best-first one would make every pick the
  obvious top name and stop the draft being a decision.
* **A player taken is gone.** Room-wide, for the rest of the draft. That is
  enforced by a unique index in the database, not by the browser, so two people
  tapping the same name at the same instant resolve to exactly one owner and
  the loser is told immediately.
* **The same slot-machine reveal.** Each round's club-season is spun up in
  front of the whole room, not just whoever is on the clock, and the reel keeps
  turning while the next board is being drawn so the wait reads as the machine
  deciding rather than the game stalling.
* **A clock on every pick** (30/60/120s, the host's choice). Run out and the
  best player left on the board is taken for you, into the best slot for it.
  A drafter who closes their tab is covered by the room three seconds later, so
  one person wandering off never stalls everyone else.
* **A team talk before kickoff.** Once the draft ends everyone rearranges their
  own XI — tap two players to swap them, same rules as the solo game — and
  appoints a coach, then readies up. The season starts when the last person is
  ready.
* **Everyone plays the same season.** All the drafted clubs enter the 2026
  league at once and *play each other* — conference rivals home and away,
  everyone else at least once. One table, one bracket, one Cup. The room screen
  ranks all of you, and the head-to-heads are there to argue about.
* **The regular season stops at the table.** Everyone watches their own 34
  games, then the room lands on the full conference table with the golden boots
  around it. The **host decides when the playoffs start**, so there is time to
  gloat before the knockouts.
* **The same end screen as the solo game** — final table, goal and assist
  leaders, achievements, the shareable text and the PNG export card.
* **Reload-safe.** Refresh, switch apps, drop your phone — the setup screen
  offers your room back, and rejoining restores your seat and squad intact. A
  shared `#room=` link goes straight in. Leaving is always one tap away, from
  the lobby or mid-draft.

Rerolls do not apply in a room: the board is shared, so there is nothing to
reroll. Difficulty still sets the DP limit and the salary cap — which means that
in the NWSL, where there is no public salary data, only Max changes anything at
all (it hides the ratings). Coaches are dealt three each off one shuffled list,
so no two clubs in a room can appoint the same one.

Every league runs rooms. In a single-table league — the NWSL, or USL — the room
plays that one table and its straight knockout bracket, so everyone in the room
meets home and away.

Nothing about a room is stored beyond the code, the seed and the ordered list of
picks — the squads, the coach shortlists and the entire season are *derived*
from those on each device. That is what lets every client simulate the same
season without a server ever running it.

### Head coaches

Every coach with enough league games — 30 in MLS, 20 in the NWSL's shorter
seasons — is rated on two career percentile ranks,
shown as a plain 0–100: **attack** is their average rank for expected goals
for, **defence** for expected goals against. Those swing the team's goals
scored and conceded by up to 2.5% either way, and a median (50th percentile)
coach changes nothing — which keeps the league calibration intact, since a
random coach averages out neutral. You get one reroll of the shortlist.

| Badge | Earned by | Effect |
|---|---|---|
| 🏆 **Playoff Proven** | Won MLS Cup | +2.5% in the playoffs |
| 🛡 **Proven Winner** | Won the Supporters' Shield | +2.5% in the regular season |

Trophies are read straight out of the games table — the MLS Cup winner is the
last knockout game of each completed season, the Shield the best regular-season
record — and all 13 of each since 2013 match the record books.

The coach is a mild net buff — choosing from a shortlist skews the draw above
the median, and the trophy bonuses only ever add — but at 2.5% the effect is
small enough not to distort the target.

## The three leagues

|  | MLS | NWSL | USL |
|---|---|---|---|
| Seasons in the pool | 2013–2026 | 2016–2026 | 2017–2026 |
| Minutes floor | 500 | 250 | 400 |
| Season | 34 games, two conferences | 30 games, single table | 34 games, single table |
| Target | 75 points | 75 points | **79 points** |
| Playoffs | top 8 **per conference**, best-of-3 round one, then knockout | top 8 **overall**, straight knockout | top 8 **overall**, straight knockout |
| Designated Players / cap | yes | no | no |
| Flanks | from the event feed | from the event feed | not available |

The target is always one point past what the league has actually managed. MLS's
record is 74, the NWSL's 65 in a 26-game season — a 2.50-per-game pace that 75
over 30 games reproduces exactly — and USL's is Phoenix Rising's 78 in 2019, so
USL is a road to **79**. Every screen reads the number from the league's data
file, so the game renames itself.

A flawless draft takes the target and the trophy about **9.8%** of the time in
MLS on normal, **2.6%** in USL and **1.8%** in the NWSL.

Everything else is measured per league rather than shared: each has its own
calibration fit, its own scoring environment (MLS averages 1.46 goals per team
per game with a +0.52 home edge; USL 1.42 and +0.37; the NWSL 1.32 and +0.27),
its own tuned strength coefficient, and its own single-season records driving
the achievements.

### USL is two tiers in one pool

The Championship and League One are drafted together rather than split out, so a
board can land on 2019 Phoenix Rising or on this year's Union Omaha, and all
forty-odd clubs share one 2026 table. Two things follow from the data ASA
publishes for them:

* **No salary data**, as in the NWSL, so no Designated Players and no cap —
  outside MLS, difficulty is rerolls and whether the ratings are hidden.
* **No event feed.** Goals and assists come from the xgoals table instead, so
  the sim still knows who scores, but nobody has an established flank: a USL
  full back or winger plays either side at full strength. The g+ ratings
  themselves are unaffected — they come from the same goals-added tables as
  every other league.

Season lengths differ between the tiers (34 games and about 30), which the
calibration handles by fitting on points *per game*; the pool pro-rates both to
the 34-game slate the sim plays.

## Squad screen

Each player shows the season they were spun from and their effective g+ after
penalties. Tap (or hover) any of them for the full name, season and value.

## Export

The end screen renders the whole season to a PNG — squad with seasons and
values, coach, achievements, leaders and a result strip. It is drawn on a
canvas rather than captured from the page: the ASA image buckets send no
`Access-Control-Allow-Origin` header, so a badge or headshot painted onto a
canvas would taint it and make the export throw.

## Draft efficiency

The spins you were dealt are fixed once they happen, so "the optimal draft"
has a precise meaning: over those same 14 boards, the assignment of one player
per board to one slot each that maximises squad strength. With 14 of each that
is small enough to solve **exactly** — a DP over which slots are filled, 2^14
states — rather than approximated with a greedy pass, which can be beaten and
would make the number meaningless. The Designated Player limit is part of the
solve, so the benchmark is a squad you could genuinely have built; it binds in
about a quarter of drafts.

The percentage places your squad between the worst and best assignments those
boards allowed, rather than as a raw fraction of the best — a plain ratio
breaks down as soon as either figure is negative, which a poor draft manages
easily. For reference, a bot that always grabs the highest-value option in
front of it lands around **87%**, and a random one around **43%**.

Taking the very best squad the boards allowed earns the **Perfect Draft**
achievement. It is genuinely hard: greedy play tops out near 98%, because the
optimum sometimes needs you to pass on the best player in front of you to fit a
later board.

## Achievements

The season ends with whatever it earned: Invincible for going unbeaten, Record
Breakers for passing New England's 74 points, Goal Machine for passing LAFC's
85 goals, Winning Machine, Fortress, Golden Boot, Playmaker and more. The top
three go into the share text.

### Draft rules

**A player is only at full strength in the exact role they filled in the season
they were spun from** — same position, and same flank if the slot has one.
Anywhere else costs a flat **−20%**, whether that role comes from another
season of their career or from covering an adjacent one. Being both out of
position *and* on the wrong flank does not double up.

Who can play where is generous. A player is eligible for:

- the position they held in the spun season (free),
- any position they have held in **another season** of their career (−20%),
- an adjacent role their position can cover (−20%): DM↔CM, CM↔AM, and an
  attacking midfielder pushing out to the wing. Only **one step** — a CM can
  cover DM or AM, but a DM can never play AM.

**A flank has to be earned.** A fullback or winger can only line up on a side
they have actually played at some point in their career, and it costs the same
−20% if it isn't the side they played in the spun season. Kai Wagner has never
played right back, so he simply can't; Dan Gargan, who spent seasons on both
flanks, switches at −20%. Players who never established a side move freely.

Bench slots cover a whole band and cost nothing.

Which side someone played comes from the **season mean** of their touch
y-coordinates, with a deadband around the middle for genuine two-footers.

So Đorđe Mihailović, spun from a season listed at DM, plays DM at full
strength and his career AM and W roles at −20%. Yuya Kubo, spun as a winger,
covers five positions — but only the wing for free.

Which flank a player belongs on is taken from **where they actually played** —
the mean y coordinate of their touches in the event feed (see
`scripts/build_events.py`), per season. A player's career flanks are the union
across their seasons. 2020 has no event feed, so those player-seasons record no
side, which leaves them free to play either.

Sub slots take D←CB/FB, M←DM/CM/AM, A←W/ST.

You can **swap any two drafted players** whose positions are mutually legal,
both during the draft (Squad tab) and on the review screen before kick-off.
Every pick is confirmed on a sheet first, so a mistaken tap can be backed out.

### Hard mode: the salary cap

Hard mode adds each player's real salary from their spun season, and the squad
has to come in compliant under the 2026 rules:

- A **Designated Player** carries the maximum budget charge ($803,125) whatever
  they actually earn. Anyone else above that has to be **bought down** to it
  with allocation money.
- Up to three players aged 22 or under can be carried at **U22 Initiative**
  rates ($150,000 at 20 or younger, $200,000 at 21–22). The slots go to
  whoever saves the most.
- Whatever the squad is still over the cap by also comes out of allocation.

The published figures cover a 20-man senior roster, so both the cap and the
allocation pot are scaled to this game's 14-man squad — the same money per
player a real club works with:

| | League (20 players) | This game (14) |
|---|---|---|
| Salary cap | $6,425,000 | **$4,497,500** |
| Allocation money | $6,000,000 | **$4,200,000** |

A pick is refused if it would make the squad impossible to complete legally —
every empty slot is costed at the senior minimum ($113,400) — so the draft can
never be spent into a dead end.

**Honest caveat:** the cap is a genuine constraint — a typical hard-mode squad
spends $3.4M of its $4.2M allocation and carries 2 DPs rather than 3 — but on
its own it barely moves the difficulty. Sweeping the allocation from full to
zero only drags a perfect draft from 70 to 68 points, because elite g+ players
are often cheap (goalkeepers, old seasons, youngsters) and the DP tag already
absorbs the three priciest. Hard mode gets most of its bite from having no
rerolls.
- **Designated Players**: anyone whose guaranteed compensation that season topped
  **$1.7M**. Max 3 DPs in the squad; a 4th is blocked. The threshold is flat
  across all seasons, so 2013 stars are cheap — a deliberate quirk.
- **No duplicates** — the same player can't be drafted twice, even from a
  different season.
- **Rerolls** discard the current spin. A spin that offers *no* legal pick is dead
  and auto-respins for free, so the draft can never soft-lock.

## Ratings and the sim

Every player is scored by their **g+ above average** for that season — the sum of
`goals_added_above_avg` across all action types from
[American Soccer Analysis](https://www.americansocceranalysis.com/), which is
already position-adjusted. Goalkeepers use the keeper model (Claiming, Fielding,
Handling, Passing, Shotstopping, Sweeping), which has a much wider spread than
outfield g+ — so a great keeper is the single biggest swing in the draft.

Players under **500 minutes** in a season are dropped as noise — g+ over a
handful of appearances says very little. 2026 is a partial season, so those
scores are pro-rated to a full 34 games and labelled *projected*; the floor is
applied to real minutes, before that scaling.

The sim is calibrated against 290 real team-seasons (2013–2025, excluding the
short 2020 season):

```
ppg = 1.374 + 0.700 × (team g+ per game)      residual σ = 0.244 ppg
```

An average side (g+ 0) takes ~47 points. The strongest team-season on record —
2019 LAFC — projects to ~73. Matches are simulated as Poisson goals around a
league base of 1.4 goals/team/game with a home edge worth ~+0.35 goal difference;
the strength-to-goals coefficient is tuned so season points from match simulation
reproduce that fitted line, and match randomness alone then generates close to
the observed real-world spread.

Your squad's strength counts **starters at 91%** and **substitutes at 30%** of
their scores, **after** position penalties — nobody plays every minute.

With that, a flawless draft takes 75 points *and* MLS Cup about 9.8% of the
time on Easy, 6.8% on Normal and 5.5% on Hard. A realistic drafter manages
0.4%.

Goals are attributed to players from a positional prior weighted by their real
goals and assists per 90, so a prolific forward scores like one. It is tuned so
the top scorer takes roughly a quarter to a third of the team's goals — about
what real Golden Boot winners manage — and `npm run sanity` asserts it.

Playoffs follow the real format: top 8 per conference, best-of-3 Round One with
drawn games going straight to penalties, then single-elimination Conference
Semifinals, Conference Final, and MLS Cup, each hosted by the better seed.

## Development

```bash
npm install
npm run dev        # local dev server
npm run build      # -> dist/
npm run sanity     # headless calibration + 500-draft balance check
npm run rooms      # headless multiplayer draft: exclusivity, snake, determinism
```

`npm run rooms` plays whole rooms with no server, against an in-memory stand-in
for the room tables, and checks the three properties a shared draft lives on:
nobody is drafted twice, every squad fills, and two clients holding the same
room row compute the same season. Add `-- nwsl` for the other league.

Draft rooms can also be played locally with **no database at all**: open
`?mock&client=a` and `?mock&client=b` in two tabs and they draft against each
other through `localStorage` (`src/roommock.js`, dev-only — it is compiled out
of production builds).

### Database

Play logging and draft rooms share one Supabase project. The browser talks to
it directly, with a publishable key that ships in the bundle and is granted
nothing but EXECUTE on a handful of `SECURITY DEFINER` functions — every table
is behind RLS with no policies, so there is no reachable surface but those.

Run once each in the Supabase SQL editor:

```
supabase/schema.sql   # play logging
supabase/rooms.sql    # draft rooms
```

`rooms.sql` is written to be re-runnable: it creates what is missing and
migrates what is not (`add column if not exists`, and the phase constraint is
dropped and re-added), so applying a newer copy over a live room database is
safe.

The Netlify project is connected to this repo through the Netlify GitHub App, so
**pushing to `main` auto-deploys** (`npm run build` → `dist`). Pull requests get
deploy previews and build statuses reported back on the PR.

Rebuilding the data (needs the ASA client — `pip install itscalledsoccer pandas`):

```bash
python scripts/fetch_raw.py      mls   # caches the ASA API responses
python scripts/build_events.py   mls   # event CSVs -> sides, goals, assists
python scripts/build_coaches.py  mls   # rates coaches and finds their trophies
python scripts/build_data.py     mls   # writes src/data/{pool,sim}.json
```

Swap `mls` for `nwsl` or `usl` to rebuild another league. Per-league settings
live in `scripts/leagues.py`; `usl` pulls both `uslc` and `usl1` and
concatenates them, and skips `build_events.py` entirely since no event CSVs
exist for it.

`fetch_raw.py` takes seasons: `fetch_raw.py mls 2026` refreshes only the year in
progress, which is all a mid-season update needs — the finished seasons are
never going to change, and re-pulling fourteen of them costs a few hundred
requests for nothing.

`build_events.py` reads the season event CSVs (`{year}MLS_events.csv`), which
live outside this repo because they are ~400 MB each; pass their directory as
an argument if it isn't the default.

The deployed game makes **zero** API calls — everything is baked into two JSON
files (~330 KB total). Club badges and player headshots are hotlinked from ASA's
public S3 bucket and fall back to a monogram avatar if an image 404s.

Data © [American Soccer Analysis](https://www.americansocceranalysis.com/).
