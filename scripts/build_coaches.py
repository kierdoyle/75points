"""Rate every MLS head coach, and record what they've won.

A coach's **offense** rating is their career-average percentile rank in the
league for expected goals for; **defense** is the same for expected goals
against (fewer is better). Both are weighted by how much of each team-season
they actually managed, so an interim who took eight games doesn't inherit the
whole year.

Trophies come out of the games table: the MLS Cup winner is the last knockout
game of a completed season, and the Supporters' Shield goes to the best
regular-season record league-wide.

    python scripts/build_coaches.py

Writes scripts/.cache/coaches.json (consumed by build_data.py).
"""

import json
import os
import pickle

import pandas as pd

CACHE = os.path.join(os.path.dirname(__file__), ".cache")
SEASONS = [str(y) for y in range(2013, 2027)]
# 2026 is still being played, so it has no trophies to award yet.
COMPLETED = [s for s in SEASONS if s != "2026"]

# A coach needs this many league games before we trust their percentiles.
MIN_GAMES = 30


def load(name):
    with open(os.path.join(CACHE, name + ".pkl"), "rb") as f:
        return pickle.load(f)


def percentile(values, key, higher_is_better):
    """Rank -> percentile in [0,1]. Ties share the midpoint."""
    order = sorted(values, key=lambda t: t[1], reverse=higher_is_better)
    n = len(order)
    out = {}
    for i, (tid, _) in enumerate(order):
        # 0 = worst in the league, 1 = best
        out[tid] = 1.0 - (i / (n - 1)) if n > 1 else 0.5
    return out


def main():
    managers = load("managers")
    teams = load("teams")
    name_by_id = dict(zip(managers["manager_id"], managers["manager_name"]))
    team_name = dict(zip(teams["team_id"], teams["team_abbreviation"]))

    # coach -> accumulated weights and percentile totals
    acc = {}
    cups, shields = {}, {}

    for season in SEASONS:
        games = load(f"games_{season}")
        txg = load(f"txg_{season}")
        if len(txg) == 0:
            continue

        off_pct = percentile(list(zip(txg["team_id"], txg["xgoals_for"])), None, True)
        def_pct = percentile(list(zip(txg["team_id"], txg["xgoals_against"])), None, False)

        reg = games[(games["status"] == "FullTime") & (~games["knockout_game"].astype(bool))]

        # games each manager took charge of, per club
        managed = {}
        points = {}
        for _, g in reg.iterrows():
            for side in ("home", "away"):
                mid = g[f"{side}_manager_id"]
                tid = g[f"{side}_team_id"]
                if isinstance(mid, str) and mid:
                    managed[(mid, tid)] = managed.get((mid, tid), 0) + 1
            h, a = g["home_team_id"], g["away_team_id"]
            hs, as_ = int(g["home_score"]), int(g["away_score"])
            points.setdefault(h, 0)
            points.setdefault(a, 0)
            if hs > as_:
                points[h] += 3
            elif as_ > hs:
                points[a] += 3
            else:
                points[h] += 1
                points[a] += 1

        team_games = {}
        for (mid, tid), n in managed.items():
            team_games[tid] = team_games.get(tid, 0) + n

        for (mid, tid), n in managed.items():
            if tid not in off_pct:
                continue
            share = n / max(1, team_games.get(tid, n))
            a = acc.setdefault(mid, {"w": 0.0, "off": 0.0, "def": 0.0, "games": 0,
                                     "seasons": set(), "clubs": {}})
            a["w"] += share
            a["off"] += off_pct[tid] * share
            a["def"] += def_pct[tid] * share
            a["games"] += n
            a["seasons"].add(season)
            a["clubs"][tid] = a["clubs"].get(tid, 0) + n

        if season not in COMPLETED:
            continue

        # Supporters' Shield: best regular-season record in the league.
        if points:
            shield_team = max(points, key=lambda t: points[t])
            holder = max(((m, n) for (m, t), n in managed.items() if t == shield_team),
                         key=lambda x: x[1], default=(None, 0))[0]
            if holder:
                shields.setdefault(holder, []).append((season, team_name.get(shield_team, "?")))

        # MLS Cup: the last knockout game of the season.
        ko = games[(games["status"] == "FullTime") & (games["knockout_game"].astype(bool))]
        if len(ko):
            final = ko.sort_values("date_time_utc").iloc[-1]
            hs, as_ = int(final["home_score"]), int(final["away_score"])
            if hs == as_:
                hp = final.get("home_penalties")
                ap = final.get("away_penalties")
                win_home = (hp or 0) > (ap or 0)
            else:
                win_home = hs > as_
            side = "home" if win_home else "away"
            mid = final[f"{side}_manager_id"]
            tid = final[f"{side}_team_id"]
            if isinstance(mid, str) and mid:
                cups.setdefault(mid, []).append((season, team_name.get(tid, "?")))

    coaches = []
    for mid, a in acc.items():
        nm = name_by_id.get(mid)
        if not isinstance(nm, str) or not nm or a["games"] < MIN_GAMES or a["w"] <= 0:
            continue
        years = sorted(a["seasons"])
        main_club = max(a["clubs"], key=lambda t: a["clubs"][t])
        coaches.append({
            "id": mid,
            "name": nm,
            "off": round(a["off"] / a["w"], 3),
            "def": round(a["def"] / a["w"], 3),
            "games": a["games"],
            "club": main_club,
            "abbr": team_name.get(main_club, "?"),
            "span": years[0] if len(years) == 1 else f"{years[0]}–{years[-1]}",
            "cups": len(cups.get(mid, [])),
            "shields": len(shields.get(mid, [])),
        })
    coaches.sort(key=lambda c: -(c["off"] + c["def"]))

    print(f"{len(coaches)} coaches with {MIN_GAMES}+ games\n")
    print("best by combined rating:")
    for c in coaches[:8]:
        badge = ("🏆" if c["cups"] else "") + ("🛡" if c["shields"] else "")
        print(f"  {c['name'][:24]:<24} off {c['off']:.2f}  def {c['def']:.2f}  "
              f"{c['games']:>3}g {c['abbr']:<5} {c['span']} {badge}")
    print("\nworst:")
    for c in coaches[-4:]:
        print(f"  {c['name'][:24]:<24} off {c['off']:.2f}  def {c['def']:.2f}  {c['games']:>3}g")

    print("\nMLS Cup winners found:")
    for mid, wins in sorted(cups.items(), key=lambda kv: kv[1][0][0]):
        for season, club in wins:
            print(f"  {season}  {club:<5} {name_by_id.get(mid, '?')}")
    print("\nSupporters' Shield winners found:")
    for mid, wins in sorted(shields.items(), key=lambda kv: kv[1][0][0]):
        for season, club in wins:
            print(f"  {season}  {club:<5} {name_by_id.get(mid, '?')}")

    with open(os.path.join(CACHE, "coaches.json"), "w") as f:
        json.dump(coaches, f)
    print(f"\nwrote coaches.json ({len(coaches)} coaches)")


if __name__ == "__main__":
    main()
