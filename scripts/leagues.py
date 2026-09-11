"""Per-league configuration shared by the data-building scripts.

The leagues differ in more than branding. The NWSL runs a single table with no
conferences, a shorter history, no public salary data (so no Designated Players
and no cap), and a straight top-eight knockout bracket. USL is two ASA leagues
drafted as one pool, and has no event feed behind it.

Two optional keys carry those differences:

  asa_leagues  the ASA league codes to pull and concatenate. Defaults to the
               key itself; USL sets ["uslc", "usl1"] so both tiers land in one
               pool.
  events       whether an event-feed summary exists. Without one there are no
               flanks and no per-90 scoring rates, which the game already
               degrades gracefully for -- 2020 has no feed either.
"""

LEAGUES = {
    "mls": {
        "name": "MLS",
        "seasons": [str(y) for y in range(2013, 2027)],
        # 2020 was the COVID year: a short, bubble-interrupted season. MLS Cup
        # was still played and won, so the trophy counts even though the
        # season is no use for calibration.
        "skip_calibration": {"2020"},
        "skip_trophies": set(),
        # Kept out of the spin pool as well: 22 games of bubble soccer produce
        # g+ totals that aren't comparable with a full season's.
        "exclude_seasons": {"2020"},
        "cup_name": "MLS Cup",
        "shield_name": "Supporters' Shield",
        "exclude_coaches": set(),
        "current_season": "2026",
        "season_games": 34,
        # Tuned by `npm run sanity -- tune` so season points from match sim
        # reproduce the fitted line.
        "k_strength": 0.795,
        "target_points": 75,
        "min_minutes": 500,
        "coach_min_games": 30,
        "events_pattern": "{season}MLS_events.csv",
        "salaries": True,
        "conferences": True,
    },
    "nwsl": {
        "name": "NWSL",
        "seasons": [str(y) for y in range(2016, 2027)],
        # 2020 was the Challenge Cup and Fall Series only: no true regular
        # season and no Championship, so it counts for neither.
        "skip_calibration": {"2020"},
        "skip_trophies": {"2020"},
        # And nothing anyone should be able to draft from either.
        "exclude_seasons": {"2020"},
        "cup_name": "NWSL Championship",
        "shield_name": "NWSL Shield",
        # Kept out of the game regardless of their record.
        "exclude_coaches": {
            "Paul Riley", "Rory Dames", "Christy Holly", "Richie Burke",
            "Farid Benstiti",
        },
        "current_season": "2026",
        # 16 clubs from 2026, so a full double round-robin is 30 games.
        "season_games": 30,
        "k_strength": 0.680,
        # Kansas City's record 65 points came in a 26-game season (2.50 ppg),
        # which over this 30-game one is exactly a 75-point pace.
        "target_points": 75,
        "min_minutes": 250,
        # Shorter seasons, so a lower bar for trusting a coach's percentiles.
        "coach_min_games": 20,
        "events_pattern": "{season}NWSL_events.csv",
        "salaries": False,
        "conferences": False,
    },
    "usl": {
        "name": "USL",
        # The Championship has goals added from 2017, League One from 2019.
        # Seasons before a tier existed simply come back empty.
        "seasons": [str(y) for y in range(2017, 2027)],
        "asa_leagues": ["uslc", "usl1"],
        # 16 games in a bubble-shortened 2020: no use for fitting, and not
        # comparable with a full season in the spin pool either.
        "skip_calibration": {"2020"},
        "skip_trophies": set(),
        "exclude_seasons": {"2020"},
        # Both tiers are drafted as one pool, so the trophies are the game's
        # rather than either league's. The Players' Shield is real; the Cup
        # stands in for two separate finals.
        "cup_name": "USL Cup",
        "shield_name": "Players' Shield",
        "exclude_coaches": set(),
        "current_season": "2026",
        # The Championship's usual slate, and what both tiers are pro-rated to.
        "season_games": 34,
        "k_strength": 0.795,
        # Phoenix Rising took 78 points in 2019, so 75 would be a target the
        # league has already beaten. The game's premise is one point past the
        # record, and every screen reads the number from here -- so USL is a
        # road to 79.
        "target_points": 79,
        # Between the MLS and NWSL floors: seasons are 30-34 games, and the
        # rosters churn harder than either.
        "min_minutes": 400,
        "coach_min_games": 25,
        # No event CSVs exist for USL, so no flanks and no per-90 rates.
        "events_pattern": None,
        "events": False,
        "salaries": False,
        "conferences": False,
    },
}


def asa_leagues(league):
    """The ASA league codes a game league is built from."""
    return LEAGUES[league].get("asa_leagues", [league])


def has_events(league):
    return LEAGUES[league].get("events", True)


def finished_regular(games):
    """Completed regular-season games that actually have a scoreline.

    ASA's USL feed carries the odd fixture marked FullTime with no score --
    one in 624 in 2022. A match with no result cannot contribute points, goals
    or a record, and reading it as 0-0 would invent a draw that never happened,
    so it is dropped rather than defaulted.
    """
    g = games[(games["status"] == "FullTime") & (~games["knockout_game"].astype(bool))]
    return g[g["home_score"].notna() & g["away_score"].notna()]


def cache_name(league, stem):
    """MLS keeps its original unprefixed cache names; NWSL is namespaced."""
    return stem if league == "mls" else f"{league}_{stem}"


def out_name(league, stem):
    return f"{stem}.json" if league == "mls" else f"{league}-{stem}.json"
