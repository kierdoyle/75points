"""Fetch raw ASA data once and cache it to scripts/.cache/ as pickles.

Separated from build_data.py so that re-running the (fast) transform/calibration
step doesn't re-hit the API.

    python scripts/fetch_raw.py [mls|nwsl]

MLS caches under its original unprefixed names; other leagues are namespaced.
"""

import os
import pickle
import sys

from itscalledsoccer.client import AmericanSoccerAnalysis

from leagues import LEAGUES, cache_name

CACHE = os.path.join(os.path.dirname(__file__), ".cache")


def main():
    league = sys.argv[1] if len(sys.argv) > 1 else "mls"
    cfg = LEAGUES[league]
    os.makedirs(CACHE, exist_ok=True)
    asa = AmericanSoccerAnalysis()

    def dump(stem, obj):
        name = cache_name(league, stem)
        with open(os.path.join(CACHE, name + ".pkl"), "wb") as f:
            pickle.dump(obj, f)
        n = len(obj) if hasattr(obj, "__len__") else "?"
        print(f"  wrote {name}.pkl ({n} rows)")

    print(f"{cfg['name']}: players / teams / managers")
    dump("players", asa.get_players(leagues=league))
    dump("teams", asa.get_teams(leagues=league))
    dump("managers", asa.get_managers(leagues=league))

    for season in cfg["seasons"]:
        print(f"season {season}")
        dump(f"pg_{season}", asa.get_player_goals_added(leagues=league, season_name=season))
        dump(f"gk_{season}", asa.get_goalkeeper_goals_added(leagues=league, season_name=season))
        dump(f"games_{season}", asa.get_games(leagues=league, season_name=season))
        dump(f"txg_{season}", asa.get_team_xgoals(leagues=league, season_name=season))
        if cfg["salaries"]:
            dump(f"sal_{season}", asa.get_player_salaries(leagues=league, season_name=season))

    print("done")


if __name__ == "__main__":
    main()
