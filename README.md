# Road to 75

**Live:** https://mls-road-to-75.netlify.app

Two leagues, both chasing **75 points**. Pick one on the setup screen; each
ships its own player pool, coaches, calibration and playoff format.

Styled in [American Soccer Analysis](https://www.americansocceranalysis.com/)
livery — their blue (`#20b0e0`) and red (`#c02030`), sampled from the ASA
banner. Every rating in the game comes from ASA's data. This is a fan project,
not an ASA product.

> Currently private — the "75 Points" Netlify team has team-wide site protection
> on, so the URL asks for a Netlify sign-in. To open it up to everyone, set
> **Team settings → Site protection** to public in the Netlify dashboard.

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

## The two leagues

|  | MLS | NWSL |
|---|---|---|
| Seasons in the pool | 2013–2026 | 2016–2026 |
| Minutes floor | 500 | 250 |
| Season | 34 games, two conferences | 30 games, single table |
| Target | 75 points | 75 points |
| Playoffs | top 8 **per conference**, best-of-3 round one, then knockout | top 8 **overall**, straight knockout |
| Designated Players / cap | yes | no |

Both leagues target 75. In the NWSL that is a genuinely steeper ask: Kansas
City's record 65 points came in a 26-game season, a 2.50-per-game pace, and 75
over 30 games is exactly that pace again — where MLS's 75 over 34 is 2.21. A
flawless draft takes 75 and the trophy about **9.8%** of the time in MLS on
normal, against **1.8%** in the NWSL. Around 70 would put the two on equal
footing if that asymmetry ever grates.

Everything else is measured per league rather than shared: each has its own
calibration fit, its own scoring environment (MLS averages 1.46 goals per team
per game with a +0.52 home edge; the NWSL 1.32 and +0.27), its own tuned
strength coefficient, and its own single-season records driving the
achievements.

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
```

The Netlify project is connected to this repo through the Netlify GitHub App, so
**pushing to `main` auto-deploys** (`npm run build` → `dist`). Pull requests get
deploy previews and build statuses reported back on the PR.

Rebuilding the data (needs the ASA client — `pip install itscalledsoccer pandas`):

```bash
python scripts/fetch_raw.py      mls   # caches the ASA API responses
python scripts/build_events.py   mls   # event CSVs -> sides, goals, assists
python scripts/build_coaches.py  mls   # rates coaches and finds their trophies
python scripts/build_data.py     mls   # writes public/data/{pool,sim}.json
```

Swap `mls` for `nwsl` to rebuild the other league (into `nwsl-pool.json` and
`nwsl-sim.json`). Per-league settings live in `scripts/leagues.py`.

`build_events.py` reads the season event CSVs (`{year}MLS_events.csv`), which
live outside this repo because they are ~400 MB each; pass their directory as
an argument if it isn't the default.

The deployed game makes **zero** API calls — everything is baked into two JSON
files (~330 KB total). Club badges and player headshots are hotlinked from ASA's
public S3 bucket and fall back to a monogram avatar if an image 404s.

Data © [American Soccer Analysis](https://www.americansocceranalysis.com/).
