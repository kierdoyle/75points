"""Per-league configuration shared by the data-building scripts.

MLS and the NWSL differ in more than branding: the NWSL runs a single table
with no conferences, a shorter history, no public salary data (so no
Designated Players and no cap), and a straight top-eight knockout bracket.
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
}


def cache_name(league, stem):
    """MLS keeps its original unprefixed cache names; NWSL is namespaced."""
    return stem if league == "mls" else f"{league}_{stem}"


def out_name(league, stem):
    return f"{stem}.json" if league == "mls" else f"{league}-{stem}.json"
