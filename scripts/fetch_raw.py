"""Fetch raw ASA data once and cache it to scripts/.cache/ as pickles.

Separated from build_data.py so that re-running the (fast) transform/calibration
step doesn't re-hit the API. Run this first:

    /Users/kierdoyle/Toronto/Data/MLSData/.venv/bin/python scripts/fetch_raw.py
"""

import os
import pickle

import pandas as pd
from itscalledsoccer.client import AmericanSoccerAnalysis

SEASONS = [str(y) for y in range(2013, 2027)]
CACHE = os.path.join(os.path.dirname(__file__), ".cache")


def main():
    os.makedirs(CACHE, exist_ok=True)
    asa = AmericanSoccerAnalysis()

    def dump(name, obj):
        with open(os.path.join(CACHE, name + ".pkl"), "wb") as f:
            pickle.dump(obj, f)
        n = len(obj) if hasattr(obj, "__len__") else "?"
        print(f"  wrote {name}.pkl ({n} rows)")

    print("players / teams / managers")
    dump("players", asa.get_players(leagues="mls"))
    dump("teams", asa.get_teams(leagues="mls"))
    dump("managers", asa.get_managers(leagues="mls"))

    for season in SEASONS:
        print(f"season {season}")
        dump(f"pg_{season}", asa.get_player_goals_added(leagues="mls", season_name=season))
        dump(f"gk_{season}", asa.get_goalkeeper_goals_added(leagues="mls", season_name=season))
        dump(f"sal_{season}", asa.get_player_salaries(leagues="mls", season_name=season))
        dump(f"games_{season}", asa.get_games(leagues="mls", season_name=season))
        dump(f"txg_{season}", asa.get_team_xgoals(leagues="mls", season_name=season))

    print("done")


if __name__ == "__main__":
    main()
