"""Summarise the raw MLS event feeds into the per-player facts the game needs.

Two things come out of the event data that the ASA aggregate endpoints don't
expose:

  * **which side of the pitch a player actually played on** -- the y coordinate
    of their touches. Verified against known 2024 fullbacks: Nouhou 82, Kai
    Wagner 80 and Marco Farfan 77 on the left; Alex Roldan 18, Dylan Nealis 19
    and DeAndre Yedlin 22 on the right. So high y = left, low y = right.
  * **goals and assists**, used to decide who scores in the match sim.

The event CSVs live outside this repo (they are large), so the path is
configurable. 2020 has no event file, and those player-seasons simply fall back
to no side and no goal record.

    python scripts/build_events.py [path/to/csv/dir]

Writes scripts/.cache/events_summary.json.
"""

import json
import os
import sys

import pandas as pd

from leagues import LEAGUES, cache_name

DEFAULT_DIR = "/Users/kierdoyle/Toronto/Data/MLSData"
CACHE = os.path.join(os.path.dirname(__file__), ".cache")

# Touches must clear this before a side is assigned -- a handful of events
# average out to noise.
MIN_TOUCHES = 150


def summarise(path):
    """{player_name: [mean_y, touches, goals, assists]} for one season file."""
    cols = ["player_name", "y", "goal", "primary_assist"]
    have = pd.read_csv(path, nrows=0).columns
    use = [c for c in cols if c in have]
    ev = pd.read_csv(path, usecols=use, low_memory=False)

    out = {}
    pos = ev.dropna(subset=["player_name", "y"]) if "y" in use else ev.iloc[0:0]
    if len(pos):
        g = pos.groupby("player_name")["y"].agg(["mean", "count"])
        for name, row in g.iterrows():
            out[name] = [round(float(row["mean"]), 1), int(row["count"]), 0, 0]

    def tally(col, slot):
        if col not in use:
            return
        hits = ev[ev[col] == True]  # noqa: E712 -- the column is object dtype
        for name, n in hits["player_name"].value_counts().items():
            if name not in out:
                out[name] = [50.0, 0, 0, 0]
            out[name][slot] = int(n)

    tally("goal", 2)
    tally("primary_assist", 3)
    return out


def main():
    league = sys.argv[1] if len(sys.argv) > 1 else "mls"
    cfg = LEAGUES[league]
    src = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_DIR
    os.makedirs(CACHE, exist_ok=True)
    summary = {}
    for season in cfg["seasons"]:
        path = os.path.join(src, cfg["events_pattern"].format(season=season))
        if not os.path.exists(path):
            print(f"{season}: no event file -- players get no side or goal data")
            continue
        s = summarise(path)
        summary[season] = s
        sided = sum(1 for v in s.values() if v[1] >= MIN_TOUCHES)
        goals = sum(v[2] for v in s.values())
        assists = sum(v[3] for v in s.values())
        print(f"{season}: {len(s)} players, {sided} with enough touches, "
              f"{goals} goals, {assists} assists")

    name = cache_name(league, "events_summary") + ".json"
    with open(os.path.join(CACHE, name), "w") as f:
        json.dump(summary, f, separators=(",", ":"))
    size = os.path.getsize(os.path.join(CACHE, name))
    print(f"\nwrote {name} ({size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
