# Road to 75

**Live:** https://mls-road-to-75.netlify.app

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

1. **Setup** — pick a difficulty (Easy 5 rerolls / Normal 3 / Hard 1), one of five
   formations, and the conference your club joins.
2. **Draft** — each spin lands on a random (team, season) pair drawn from every MLS
   team-season 2013–2026. Take exactly one player from that roster into an open
   slot. 11 starters + 3 subs (one defender, one midfielder, one attacker).
   Picks are permanent — cursed picks are the point.
3. **Season** — your squad joins the 2026 league as an expansion side, plays 34
   games against the real current clubs, then the MLS Cup Playoffs.

### Draft rules

- **Position eligibility** uses ASA's `general_position` codes: GK←GK, CB←CB,
  FB←FB, DM←DM/CM, CM←CM/DM/AM, AM←AM/CM, W←W/AM, ST←ST/W. Sub slots take
  D←CB/FB, M←DM/CM/AM, A←W/ST.
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

Players under 180 minutes in a season are dropped as noise. 2026 is a partial
season, so those scores are pro-rated to a full 34 games and labelled *projected*.

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

Your squad's strength is the sum of the starting XI's scores plus 30% of the subs'.

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
python scripts/fetch_raw.py    # caches the ASA API responses to scripts/.cache/
python scripts/build_data.py   # writes public/data/{pool,sim}.json
```

The deployed game makes **zero** API calls — everything is baked into two JSON
files (~330 KB total). Club badges and player headshots are hotlinked from ASA's
public S3 bucket and fall back to a monogram avatar if an image 404s.

Data © [American Soccer Analysis](https://www.americansocceranalysis.com/).
