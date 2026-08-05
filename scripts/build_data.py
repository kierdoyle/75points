"""Transform cached ASA data into the compact JSON the game ships with.

Run fetch_raw.py, build_events.py and build_coaches.py for the league first,
then:

    python scripts/build_data.py [mls|nwsl]

Writes src/data/{pool,sim}.json for MLS and nwsl-{pool,sim}.json for the NWSL.
They live under src/ rather than public/ so the Vite build content-hashes
them, which is what makes them cacheable forever. The deployed game makes zero
API calls.
"""

import json
import os
import pickle
import sys

import numpy as np
import pandas as pd

from leagues import LEAGUES, cache_name, out_name

# ---------------------------------------------------------------- constants

LEAGUE = sys.argv[1] if len(sys.argv) > 1 else "mls"
CFG = LEAGUES[LEAGUE]
SEASONS = CFG["seasons"]
CURRENT_SEASON = CFG["current_season"]
FULL_SEASON_GAMES = CFG["season_games"]

# A player counts as a Designated Player if guaranteed compensation in the spun
# season clears this. Deliberately flat across all seasons -- 2013 stars come
# cheap, which is a gameplay quirk, not a bug.
DP_THRESHOLD = 1_700_000

# 2026 MLS roster rules (mlssoccer.com/news/2026-mls-roster-rules-and-regulations),
# used by the hard-mode salary cap.
SALARY_CAP = 6_425_000
MAX_BUDGET_CHARGE = 803_125
SENIOR_MINIMUM = 113_400
U22_CHARGE_YOUNG = 150_000   # age 20 or younger
U22_CHARGE = 200_000         # ages 21-25

# Players below this many minutes in a season are dropped from spin rosters:
# tiny samples make g+ totals noise, and they'd just be filler picks. The NWSL
# plays a shorter season, so its floor is lower.
MIN_MINUTES = CFG["min_minutes"]

# Disrupted seasons are no use for fitting, and the season in progress has no
# final table yet.
CALIB_SEASONS = [s for s in SEASONS
                 if s not in CFG["skip_calibration"] and s != CURRENT_SEASON]

# Seasons the game never shows: not spinnable, and contributing nothing to the
# career positions or flanks that eligibility is judged on. They still count
# for calibration and records unless skip_calibration says otherwise.
POOL_SEASONS = [s for s in SEASONS if s not in CFG["exclude_seasons"]]

POSITIONS = ["GK", "CB", "FB", "DM", "CM", "AM", "W", "ST"]
POS_IDX = {p: i for i, p in enumerate(POSITIONS)}

# Sides come from the mean y of a player's touches in the event feed (see
# scripts/build_events.py). High y is the left, low y the right. Anything
# inside the deadband played both flanks often enough that we let them switch
# freely -- the game only penalises a player who clearly has a side.
SIDE_NONE, SIDE_LEFT, SIDE_RIGHT = 0, 1, 2
SIDE_DEADBAND = 5.0
SIDE_MIN_TOUCHES = 150
SIDED_POSITIONS = {"FB", "W"}

# ASA's teams endpoint has no conference column, so the 2026 alignment is
# hardcoded. 15 clubs a side; the player's expansion club makes 16 in whichever
# conference they choose.
EAST = {"ATL", "CLT", "CHI", "CIN", "CLB", "DCU", "MIA", "MTL", "NSH", "NER",
        "NYC", "NYRB", "ORL", "PHI", "TOR"}
WEST = {"ATX", "COL", "FCD", "HOU", "LAG", "LAFC", "MIN", "POR", "RSL", "SD",
        "SJE", "SEA", "SKC", "STL", "VAN"}

CACHE = os.path.join(os.path.dirname(__file__), ".cache")
OUT = os.path.join(os.path.dirname(__file__), "..", "src", "data")


def load(stem):
    with open(os.path.join(CACHE, cache_name(LEAGUE, stem) + ".pkl"), "rb") as f:
        return pickle.load(f)


def load_events():
    """{season: {player_name: [mean_y, touches, goals, assists]}}."""
    name = cache_name(LEAGUE, "events_summary") + ".json"
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        raise SystemExit(f"missing {name} -- run build_events.py {LEAGUE} first")
    with open(path) as f:
        return json.load(f)


def side_of(position, entry):
    """Which flank a player belongs on, or SIDE_NONE if they covered both."""
    if position not in SIDED_POSITIONS or not entry:
        return SIDE_NONE
    mean_y, touches = entry[0], entry[1]
    if touches < SIDE_MIN_TOUCHES:
        return SIDE_NONE
    if mean_y >= 50 + SIDE_DEADBAND:
        return SIDE_LEFT
    if mean_y <= 50 - SIDE_DEADBAND:
        return SIDE_RIGHT
    return SIDE_NONE


def sum_above_avg(data):
    """Player score = sum of goals_added_above_avg across every action type.

    ASA's above-average figure is already position-adjusted, so this is exactly
    'g+ above an average player at their position' for the season.
    """
    if not isinstance(data, (list, tuple)):
        return 0.0
    return float(sum(d.get("goals_added_above_avg") or 0.0 for d in data))


# ---------------------------------------------------------------- load games

def team_games_played():
    """{season: {team_id: regular-season games played}} plus actual points."""
    gp, pts = {}, {}
    for season in SEASONS:
        g = load(f"games_{season}")
        g = g[(g["status"] == "FullTime") & (~g["knockout_game"].astype(bool))]
        season_gp, season_pts = {}, {}
        for _, row in g.iterrows():
            h, a = row["home_team_id"], row["away_team_id"]
            hs, as_ = int(row["home_score"]), int(row["away_score"])
            for t in (h, a):
                season_gp[t] = season_gp.get(t, 0) + 1
                season_pts.setdefault(t, 0)
            if hs > as_:
                season_pts[h] += 3
            elif as_ > hs:
                season_pts[a] += 3
            else:
                season_pts[h] += 1
                season_pts[a] += 1
        gp[season] = season_gp
        pts[season] = season_pts
    return gp, pts


# ---------------------------------------------------------------- salaries

def salary_lookup(season):
    """{(player_id, team_id): guaranteed_comp} using the latest MLSPA release.

    Salaries are published a few times a season, so there are multiple rows per
    player-season; we keep the most recent release. A player who moved mid-year
    has rows on several teams, so we key by team too and fall back to a
    player-level max when the spun team has no row.
    """
    if not CFG["salaries"]:
        return {}, {}
    sal = load(f"sal_{season}")
    if len(sal) == 0:
        return {}, {}
    sal = sal.copy()
    sal["guaranteed_compensation"] = pd.to_numeric(
        sal["guaranteed_compensation"], errors="coerce"
    )
    sal = sal.dropna(subset=["guaranteed_compensation"])
    sal = sal.sort_values("mlspa_release")

    by_team = {}
    by_player = {}
    for _, r in sal.iterrows():
        by_team[(r["player_id"], r["team_id"])] = float(r["guaranteed_compensation"])
        # last write wins == latest release
        by_player[r["player_id"]] = float(r["guaranteed_compensation"])
    return by_team, by_player


# ---------------------------------------------------------------- main build

def main():
    players = load("players")
    teams = load("teams")
    events = load_events()
    coach_path = os.path.join(CACHE, cache_name(LEAGUE, "coaches") + ".json")
    if not os.path.exists(coach_path):
        raise SystemExit(f"missing coaches json -- run build_coaches.py {LEAGUE} first")
    with open(coach_path) as f:
        coaches = json.load(f)

    name_by_id = dict(zip(players["player_id"], players["player_name"]))
    birth_year = {}
    for pid, bd in zip(players["player_id"], players["birth_date"]):
        if isinstance(bd, str) and len(bd) >= 4 and bd[:4].isdigit():
            birth_year[pid] = int(bd[:4])
    team_rows = {
        r["team_id"]: {
            "name": r["team_name"],
            "short": r.get("team_short_name") or r["team_name"],
            "abbr": r.get("team_abbreviation") or r["team_name"][:3].upper(),
        }
        for _, r in teams.iterrows()
    }

    gp_by_season, pts_by_season = team_games_played()

    # ---- career positions and flanks --------------------------------------
    # A player who has ever been listed at a position plays it at full
    # strength, so a utility man like Dorde Mihailovic (AM, DM and W seasons)
    # covers all three for free. Positions come from every listed season
    # regardless of minutes; a flank only counts once there were enough
    # touches to establish one.
    career_pos = {}
    career_side = {}
    for season in POOL_SEASONS:
        ev_season = events.get(season, {})
        for df, forced in ((load(f"pg_{season}"), None), (load(f"gk_{season}"), "GK")):
            for _, r in df.iterrows():
                pos = forced or r["general_position"]
                if pos not in POS_IDX:
                    continue
                pid = r["player_id"]
                career_pos[pid] = career_pos.get(pid, 0) | (1 << POS_IDX[pos])
                side = side_of(pos, ev_season.get(name_by_id.get(pid, "")))
                if side:
                    career_side[pid] = career_side.get(pid, 0) | (1 << (side - 1))

    # ---- per-season player rows -------------------------------------------
    # rows: season -> team_id -> list of player dicts
    pool = {}
    # unfiltered team-season strength totals, for calibration
    strength = {}

    for season in SEASONS:
        pg = load(f"pg_{season}")
        gk = load(f"gk_{season}")
        sal_team, sal_player = salary_lookup(season)
        gp = gp_by_season.get(season, {})

        ev_season = events.get(season, {})

        def emit(recs, pid, team_id, pos, mins, score):
            # Mid-season transfers come back as one combined row with a list of
            # team_ids. Split minutes and score evenly so club totals stay
            # honest and the spin roster shows the share earned at that club.
            entry = ev_season.get(name_by_id.get(pid, ""))
            side = side_of(pos, entry)
            # Scoring rates come off the player's whole season, so they stay
            # correct whether or not the row gets split across clubs.
            per90 = 90.0 / mins if mins > 0 else 0.0
            goals90 = (entry[2] * per90) if entry else 0.0
            assists90 = (entry[3] * per90) if entry else 0.0

            tids = team_id if isinstance(team_id, list) else [team_id]
            n = len(tids)
            for tid in tids:
                recs.append((pid, tid, pos, mins / n, score / n,
                             side, goals90, assists90))

        recs = []
        for _, r in pg.iterrows():
            pos = r["general_position"]
            if pos not in POS_IDX or pos == "GK":
                continue
            emit(recs, r["player_id"], r["team_id"], pos,
                 int(r["minutes_played"]), sum_above_avg(r["data"]))
        for _, r in gk.iterrows():
            emit(recs, r["player_id"], r["team_id"], "GK",
                 int(r["minutes_played"]), sum_above_avg(r["data"]))

        # 2026 is a partial season: pro-rate each player's total to a full 34
        # games of their club's schedule so partial spins aren't systematically
        # weak against full-season ones.
        for pid, tid, pos, mins, score, side, g90, a90 in recs:
            scale = 1.0
            if season == CURRENT_SEASON:
                played = gp.get(tid, 0)
                if played > 0:
                    scale = FULL_SEASON_GAMES / played
            adj = score * scale
            strength.setdefault((season, tid), 0.0)
            strength[(season, tid)] += adj

            # Excluded seasons still feed the calibration fit above; they just
            # never reach the spin pool below.
            if season in CFG["exclude_seasons"]:
                continue
            if mins < MIN_MINUTES:
                continue
            gc = sal_team.get((pid, tid), sal_player.get(pid))
            is_dp = 1 if (gc is not None and gc > DP_THRESHOLD) else 0
            # Salary in thousands, and age during that season -- both only used
            # by the hard-mode salary cap. A player with no salary on record is
            # charged the senior minimum.
            salary_k = int(round((gc if gc is not None else SENIOR_MINIMUM) / 1000))
            by = birth_year.get(pid)
            age = (int(season) - by) if by else 0
            pool.setdefault(season, {}).setdefault(tid, []).append(
                [pid, POS_IDX[pos], round(adj, 2), int(round(mins * scale)),
                 is_dp, side, round(g90, 3), round(a90, 3), salary_k, age]
            )

    # ---- calibration -------------------------------------------------------
    xs, ys, labels = [], [], []
    for season in CALIB_SEASONS:
        for tid, played in gp_by_season[season].items():
            if played < 20:
                continue
            s = strength.get((season, tid), 0.0)
            xs.append(s / played)
            ys.append(pts_by_season[season][tid] / played)
            labels.append((season, tid))
    xs, ys = np.array(xs), np.array(ys)

    b, a = np.polyfit(xs, ys, 1)
    resid = ys - (a + b * xs)
    sigma = float(resid.std(ddof=2))

    print(f"calibration: n={len(xs)} team-seasons")
    print(f"  ppg = {a:.4f} + {b:.4f} * strength_per_game     sigma={sigma:.4f}")
    print(f"  ppg at strength 0 = {a:.3f}  "
          f"({a * FULL_SEASON_GAMES:.1f} pts over {FULL_SEASON_GAMES})")
    print(f"  strength_per_game: min={xs.min():.3f} med={np.median(xs):.3f} "
          f"p95={np.quantile(xs, 0.95):.3f} max={xs.max():.3f}")
    print(f"  R^2 = {1 - resid.var() / ys.var():.3f}")

    best = np.argsort(-xs)[:5]
    print("  strongest historical team-seasons:")
    for i in best:
        season, tid = labels[i]
        pred = a + b * xs[i]
        # Seasons vary in length, so compare rates and project both onto the
        # current season for readability.
        print(f"    {season} {team_rows[tid]['abbr']:<4} spg={xs[i]:.3f} "
              f"actual={ys[i]:.2f}ppg pred={pred:.2f}ppg "
              f"({ys[i] * FULL_SEASON_GAMES:.0f} vs {pred * FULL_SEASON_GAMES:.0f} "
              f"over {FULL_SEASON_GAMES})")

    target = CFG["target_points"]
    need = target / FULL_SEASON_GAMES
    print(f"  target {target} pts over {FULL_SEASON_GAMES} = {need:.3f} ppg -> needs "
          f"strength_per_game {(need - a) / b:.3f} "
          f"(best ever {xs.max():.3f})")

    # ---- 2026 opponents ----------------------------------------------------
    opponents = []
    for tid, played in gp_by_season[CURRENT_SEASON].items():
        if tid not in team_rows:
            continue
        abbr = team_rows[tid]["abbr"]
        if not CFG["conferences"]:
            # The NWSL runs a single table.
            conference = "League"
        elif abbr in EAST:
            conference = "East"
        elif abbr in WEST:
            conference = "West"
        else:
            raise SystemExit(f"{CURRENT_SEASON} club {abbr} "
                             f"({team_rows[tid]['name']}) is missing from the "
                             "EAST/WEST alignment")
        s = strength.get((CURRENT_SEASON, tid), 0.0)
        opponents.append({
            "id": tid,
            "abbr": abbr,
            "name": team_rows[tid]["name"],
            "short": team_rows[tid]["short"],
            "conf": conference,
            "spg": round(s / played, 4) if played else 0.0,
        })
    opponents.sort(key=lambda o: -o["spg"])
    print(f"\n2026 clubs: {len(opponents)}")
    for o in opponents[:3] + opponents[-2:]:
        print(f"  {o['abbr']:<4} {o['name'][:28]:<28} spg={o['spg']:.3f}")

    # ---- scoring environment -----------------------------------------------
    # Goals per team per game and the home-field edge, measured from the same
    # seasons the model is fitted on. The NWSL scores less and travels better
    # than MLS, so these cannot be shared constants.
    tot_goals = tot_games = home_goals = away_goals = 0
    for season in CALIB_SEASONS:
        g = load(f"games_{season}")
        g = g[(g["status"] == "FullTime") & (~g["knockout_game"].astype(bool))]
        for _, r in g.iterrows():
            hs, as_ = int(r["home_score"]), int(r["away_score"])
            tot_goals += hs + as_
            home_goals += hs
            away_goals += as_
            tot_games += 1
    base_goals = tot_goals / (2 * tot_games)
    home_gd = (home_goals - away_goals) / tot_games
    # lambda_home/away = base * exp(+/- h/2)  =>  GD = 2*base*sinh(h/2)
    home_log = 2 * np.arcsinh(home_gd / (2 * base_goals))
    print(f"\nscoring: {base_goals:.3f} goals/team/game, home edge {home_gd:+.3f} GD "
          f"(home_log {home_log:.4f})")

    # ---- single-season records, for the achievements screen ----------------
    best_pts = best_gf = best_w = 0
    for season in CALIB_SEASONS:
        g = load(f"games_{season}")
        g = g[(g["status"] == "FullTime") & (~g["knockout_game"].astype(bool))]
        gf, wins = {}, {}
        for _, r in g.iterrows():
            ht, at = r["home_team_id"], r["away_team_id"]
            hs, as_ = int(r["home_score"]), int(r["away_score"])
            gf[ht] = gf.get(ht, 0) + hs
            gf[at] = gf.get(at, 0) + as_
            wins.setdefault(ht, 0)
            wins.setdefault(at, 0)
            if hs > as_:
                wins[ht] += 1
            elif as_ > hs:
                wins[at] += 1
        played = gp_by_season[season]
        # Only compare clubs that played a full slate, so short seasons and
        # mid-table expansion sides don't set phoney records.
        full = [t for t, n in played.items() if n >= max(played.values()) - 1]
        for t in full:
            best_pts = max(best_pts, pts_by_season[season].get(t, 0))
            best_gf = max(best_gf, gf.get(t, 0))
            best_w = max(best_w, wins.get(t, 0))
    # Best individual goal haul in a season, for the Golden Boot checks. Also
    # kept as a rate: seasons have not always been the same length, so judging
    # a 30-game sim against a mark set over 26 would be unfair.
    best_player = 0
    best_player_name = "?"
    best_pace = 0.0
    for season, entries in events.items():
        if season in CFG["skip_calibration"]:
            continue
        slate = max(gp_by_season.get(season, {1: FULL_SEASON_GAMES}).values())
        for nm, e in entries.items():
            if e[2] > best_player:
                best_player, best_player_name = e[2], nm
            best_pace = max(best_pace, e[2] * FULL_SEASON_GAMES / max(1, slate))
    records = {"points": best_pts, "goals": best_gf, "wins": best_w,
               "playerGoals": best_player, "playerGoalsPace": round(best_pace)}
    print(f"\nsingle-season records: {best_pts} pts, {best_gf} goals, {best_w} wins, "
          f"{best_player} goals by {best_player_name} "
          f"(= {round(best_pace)} over {FULL_SEASON_GAMES} games)")

    # ---- emit --------------------------------------------------------------
    os.makedirs(OUT, exist_ok=True)

    used_players = set()
    spins = []
    for season, by_team in pool.items():
        for tid, roster in by_team.items():
            if not roster or tid not in team_rows:
                continue
            spins.append({"t": tid, "s": season, "r": roster})
            used_players.update(p[0] for p in roster)

    # ---- side / scoring diagnostics ---------------------------------------
    side_counts = {"FB": [0, 0, 0], "W": [0, 0, 0]}
    scorers = []
    for s in spins:
        for row in s["r"]:
            pos = POSITIONS[row[1]]
            if pos in side_counts:
                side_counts[pos][row[5]] += 1
            if row[6] > 0:
                scorers.append((row[6], name_by_id.get(row[0], "?"), s["s"], row[3]))
    print("\nsides (none/left/right):")
    for pos, c in side_counts.items():
        tot = sum(c)
        print(f"  {pos}: both={c[0]} ({c[0] / tot * 100:.0f}%)  "
              f"left={c[1]}  right={c[2]}")
    scorers.sort(reverse=True)
    print("  best goal rates (per 90, min 1500'):")
    for g90, nm, yr, mins in [s for s in scorers if s[3] >= 1500][:4]:
        print(f"    {nm[:24]:<24} {yr}  {g90:.2f}/90")

    pool_json = {
        "positions": POSITIONS,
        "dpThreshold": DP_THRESHOLD,
        "minMinutes": MIN_MINUTES,
        "currentSeason": CURRENT_SEASON,
        "teams": {t: team_rows[t] for t in {s["t"] for s in spins}},
        "names": {p: name_by_id.get(p, "Unknown") for p in used_players},
        # (position bitmask << 2) | flank bitmask, over the player's whole career
        "careers": {p: (career_pos.get(p, 0) << 2) | career_side.get(p, 0)
                    for p in used_players},
        "spins": spins,
    }
    with open(os.path.join(OUT, out_name(LEAGUE, "pool")), "w") as f:
        json.dump(pool_json, f, separators=(",", ":"))

    sim_json = {
        "league": LEAGUE,
        "name": CFG["name"],
        "model": {"a": round(float(a), 5), "b": round(float(b), 5),
                  "sigma": round(sigma, 5)},
        "games": FULL_SEASON_GAMES,
        "target": CFG["target_points"],
        "baseGoals": round(float(base_goals), 4),
        "homeLog": round(float(home_log), 4),
        "kStrength": CFG["k_strength"],
        "conferences": CFG["conferences"],
        "cupName": CFG["cup_name"],
        "shieldName": CFG["shield_name"],
        "records": records,
        "opponents": opponents,
        "coaches": coaches,
    }
    with open(os.path.join(OUT, out_name(LEAGUE, "sim")), "w") as f:
        json.dump(sim_json, f, separators=(",", ":"))

    for fn in (out_name(LEAGUE, "pool"), out_name(LEAGUE, "sim")):
        size = os.path.getsize(os.path.join(OUT, fn))
        print(f"\nwrote {fn}: {size / 1024:.0f} KB")
    print(f"spin pool: {len(spins)} team-seasons, "
          f"{sum(len(s['r']) for s in spins)} player rows, "
          f"{len(used_players)} unique players")


if __name__ == "__main__":
    main()
