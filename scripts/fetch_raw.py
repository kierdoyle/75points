"""Fetch raw ASA data once and cache it to scripts/.cache/ as pickles.

Separated from build_data.py so that re-running the (fast) transform/calibration
step doesn't re-hit the API.

    python scripts/fetch_raw.py [mls|nwsl|uslc|usl1] [season ...]

Naming a season refreshes only that one, which is what a mid-season update
actually needs -- the finished years are never going to change, and re-pulling
fourteen of them to update the one in progress is a few hundred needless
requests. The league-wide tables (players, teams, managers) are always
refreshed, since they are how a new signing gets a name.

MLS caches under its original unprefixed names; other leagues are namespaced.
"""

import os
import pickle
import sys

from itscalledsoccer.client import AmericanSoccerAnalysis

import pandas as pd

from leagues import LEAGUES, asa_leagues, cache_name, has_events

CACHE = os.path.join(os.path.dirname(__file__), ".cache")


def main():
    args = [a for a in sys.argv[1:]]
    league = args[0] if args and not args[0].isdigit() else "mls"
    wanted = [a for a in args if a.isdigit()]
    cfg = LEAGUES[league]
    seasons = wanted or cfg["seasons"]
    unknown = [s for s in seasons if s not in cfg["seasons"]]
    if unknown:
        raise SystemExit(f"{league} has no season {', '.join(unknown)}")
    os.makedirs(CACHE, exist_ok=True)
    asa = AmericanSoccerAnalysis()
    codes = asa_leagues(league)

    def fetch(call, **kw):
        """Pull from every ASA league this one is built from, as one frame.

        Player and team ids are unique across ASA, so concatenating tiers is
        safe: a player who appears in both in the same year genuinely played
        for two clubs, and shows up once for each.
        """
        frames = [call(leagues=code, **kw) for code in codes]
        frames = [f for f in frames if len(f)]
        if not frames:
            return pd.DataFrame()
        return pd.concat(frames, ignore_index=True) if len(frames) > 1 else frames[0]

    def dedupe(df, key):
        return df.drop_duplicates(subset=[key]) if len(df) else df

    def dump(stem, obj):
        name = cache_name(league, stem)
        with open(os.path.join(CACHE, name + ".pkl"), "wb") as f:
            pickle.dump(obj, f)
        n = len(obj) if hasattr(obj, "__len__") else "?"
        print(f"  wrote {name}.pkl ({n} rows)")

    print(f"{cfg['name']}: players / teams / managers  ({'+'.join(codes)})")
    dump("players", dedupe(fetch(asa.get_players), "player_id"))
    dump("teams", dedupe(fetch(asa.get_teams), "team_id"))
    dump("managers", dedupe(fetch(asa.get_managers), "manager_id"))

    for season in seasons:
        print(f"season {season}")
        dump(f"pg_{season}", fetch(asa.get_player_goals_added, season_name=season))
        dump(f"gk_{season}", fetch(asa.get_goalkeeper_goals_added, season_name=season))
        dump(f"games_{season}", fetch(asa.get_games, season_name=season))
        dump(f"txg_{season}", fetch(asa.get_team_xgoals, season_name=season))
        if cfg["salaries"]:
            dump(f"sal_{season}", fetch(asa.get_player_salaries, season_name=season))
        if not has_events(league):
            # No event CSVs for this league, so goals and assists come from the
            # xgoals table instead. It cannot give a flank -- that needs
            # touch-level data -- but it is the whole of what the sim uses to
            # decide who scores.
            dump(f"pxg_{season}", fetch(asa.get_player_xgoals, season_name=season))

    print("done")


if __name__ == "__main__":
    main()
