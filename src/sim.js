// Season + playoff simulation.
//
// Calibration (scripts/build_data.py, 290 team-seasons 2013-25 excl. 2020):
//   ppg = a + b * strength_per_game,  a = 1.374, b = 0.700, residual s = 0.244
// so a league-average side (strength 0) takes ~47 points and the strongest
// team-season on record (2019 LAFC, spg 1.084) projects to ~73. 75 is meant to
// sit past that.
//
// Matches are Poisson. K_STRENGTH converts a per-game g+ edge into a log-goals
// edge and is tuned (scripts/sanity.mjs) so that season points from match sim
// reproduce the fitted line -- the match randomness alone then generates
// close to the observed residual spread, so no extra season noise is added.

import { effectiveScore } from './rules.js';

export const MIN_LAMBDA = 0.2;

/**
 * Whichever league is being played. MLS runs two conferences, a 34-game
 * season and a best-of-three opening playoff round; the NWSL runs a single
 * table, 30 games and straight knockout. configureLeague() is called once
 * when the league's data loads.
 */
export const LEAGUE = {
  key: 'mls',
  name: 'MLS',
  games: 34,
  target: 75,
  conferences: true,
  // Scoring environment, measured per league in build_data.py: goals per team
  // per game, the home edge in log-goals, and the tuned strength coefficient.
  baseGoals: 1.46,
  homeLog: 0.3532,
  kStrength: 0.75,
  cupName: 'MLS Cup',
  shieldName: "Supporters' Shield",
  records: { points: 74, goals: 85, wins: 22 },
};

export function configureLeague(cfg) {
  Object.assign(LEAGUE, cfg);
}

// Kept as live getters so existing call sites follow the configured league.
export const seasonGames = () => LEAGUE.games;
export const targetPoints = () => LEAGUE.target;
// Nobody plays every minute of every game: starters carry most of a season,
// substitutes chip in from the bench.
export const STARTER_WEIGHT = 0.91;
export const SUB_WEIGHT = 0.30;

/**
 * Squad strength per game: starters at STARTER_WEIGHT, subs at SUB_WEIGHT.
 * Scores are the post-penalty ones, so playing a left back on the right or a
 * DM in midfield costs the team real strength.
 */
export function squadStrength(squad) {
  let total = 0;
  for (const s of squad) {
    if (!s.player) continue;
    const score = effectiveScore(s.player, s.pos);
    total += score * (s.starter ? STARTER_WEIGHT : SUB_WEIGHT);
  }
  return { total, spg: total / LEAGUE.games };
}

// ------------------------------------------------------- goals and assists

// Roughly how goals and assists split across positions, before a player's own
// record is taken into account. Keeps defenders scoring occasionally and stops
// anyone with no event data (2020 has no event feed) from being unscoreable.
//
// Tuned so a lone striker takes about a quarter of his team's goals rather
// than half: real Golden Boot winners land near 20-25% of their club's total,
// and the weights are deliberately flat enough that midfielders and defenders
// still turn up on the scoresheet.
const GOAL_BASE = { GK: 0.002, CB: 0.05, FB: 0.04, DM: 0.07, CM: 0.11, AM: 0.17, W: 0.21, ST: 0.30 };
const ASSIST_BASE = { GK: 0.004, CB: 0.05, FB: 0.13, DM: 0.09, CM: 0.16, AM: 0.22, W: 0.22, ST: 0.15 };
// How hard a player's own scoring record pulls against the positional prior.
// Kept modest so a prolific forward stands out without monopolising the team.
const RECORD_WEIGHT = 0.5;
const ASSISTED_SHARE = 0.72; // share of goals that get an assist credited

/**
 * Build weighted goal/assist tables for a set of players.
 * `minutesWeighted` scales by playing time, for opposition squads where the
 * whole roster is in the pool rather than a chosen XI.
 */
export function scorerPool(players, minutesWeighted = false) {
  return players.map((p) => {
    const share = minutesWeighted ? Math.min(1, (p.minutes || 0) / 2600) : 1;
    return {
      id: p.id,
      name: p.name,
      pos: p.pos,
      goal: ((GOAL_BASE[p.pos] || 0.05) + RECORD_WEIGHT * (p.g90 || 0)) * share,
      assist: ((ASSIST_BASE[p.pos] || 0.05) + RECORD_WEIGHT * (p.a90 || 0)) * share,
    };
  }).filter((p) => p.goal > 0 || p.assist > 0);
}

function weightedPick(pool, key, rng, exclude) {
  let total = 0;
  for (const p of pool) if (p !== exclude) total += p[key];
  if (total <= 0) return null;
  let r = rng() * total;
  for (const p of pool) {
    if (p === exclude) continue;
    r -= p[key];
    if (r <= 0) return p;
  }
  return null;
}

/** Who scored, who assisted, and when -- for one team's goals in a match. */
function attribute(pool, goals, rng, tally) {
  const out = [];
  for (let i = 0; i < goals; i++) {
    const minute = 1 + Math.floor(rng() * 90);
    const scorer = pool && pool.length ? weightedPick(pool, 'goal', rng, null) : null;
    let assister = null;
    if (scorer && pool.length > 1 && rng() < ASSISTED_SHARE) {
      assister = weightedPick(pool, 'assist', rng, scorer);
    }
    if (tally && scorer) {
      const t = tally[scorer.id] || (tally[scorer.id] = { name: scorer.name, pos: scorer.pos, goals: 0, assists: 0 });
      t.goals++;
    }
    if (tally && assister) {
      const t = tally[assister.id] || (tally[assister.id] = { name: assister.name, pos: assister.pos, goals: 0, assists: 0 });
      t.assists++;
    }
    out.push({
      minute,
      scorer: scorer ? scorer.name : null,
      assister: assister ? assister.name : null,
    });
  }
  return out.sort((a, b) => a.minute - b.minute);
}

function poisson(lambda, rng) {
  const L = Math.exp(-lambda);
  let k = 0; let p = 1;
  do { k++; p *= rng(); } while (p > L);
  return k - 1;
}

// ---------------------------------------------------------------- coaches

// A coach's percentile ranks swing the team by up to 2.5% either way; a
// median (50th percentile) coach changes nothing, which keeps the league
// calibration intact since a randomly drawn coach averages out to neutral.
export const COACH_SWING = 0.05;      // 1 + 0.05 * (pct - 0.5)  =>  0.975 .. 1.025
export const TROPHY_BONUS = 0.025;    // Shield in the league, Cup in the playoffs

const NEUTRAL = { atk: 1, def: 1 };

/**
 * A coach's multipliers for one phase of the season.
 * `atk` scales the goals the team scores, `def` divides the goals it concedes.
 */
export function coachMods(coach, phase) {
  if (!coach) return NEUTRAL;
  let atk = 1 + COACH_SWING * (coach.off - 0.5);
  let def = 1 + COACH_SWING * (coach.def - 0.5);
  const bonus = (phase === 'playoffs' && coach.cups > 0)
    || (phase === 'regular' && coach.shields > 0);
  if (bonus) {
    atk *= 1 + TROPHY_BONUS;
    def *= 1 + TROPHY_BONUS;
  }
  return { atk, def };
}

const modsFor = (club, phase) => (club && club.mods ? club.mods[phase] : NEUTRAL) || NEUTRAL;

/** Simulate one match. Returns goals for the home and away side. */
export function simMatch(spgHome, spgAway, rng, mHome = NEUTRAL, mAway = NEUTRAL) {
  const edge = (LEAGUE.kStrength * (spgHome - spgAway)) / 2 + LEAGUE.homeLog / 2;
  // A side's attack lifts its own goals; the opponent's defence suppresses them.
  const lh = Math.max(MIN_LAMBDA, (LEAGUE.baseGoals * Math.exp(edge) * mHome.atk) / mAway.def);
  const la = Math.max(MIN_LAMBDA, (LEAGUE.baseGoals * Math.exp(-edge) * mAway.atk) / mHome.def);
  return { hg: poisson(lh, rng), ag: poisson(la, rng) };
}

/** Penalty shootout: near coin-flip, small edge to the stronger side. */
export function simShootout(spgA, spgB, rng) {
  const p = Math.min(0.65, Math.max(0.35, 0.5 + 0.08 * (spgA - spgB)));
  return rng() < p; // true => A advances
}

const blankRecord = (club) => ({
  ...club, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0,
});

function applyResult(rec, gf, ga) {
  rec.gf += gf; rec.ga += ga;
  if (gf > ga) { rec.w++; rec.pts += 3; } else if (gf === ga) { rec.d++; rec.pts++; } else rec.l++;
}

/**
 * Build the player's fixture list.
 *
 * In MLS that is every conference rival home and away, topped up to 34 with
 * cross-conference trips. In the NWSL's single table it is a straight double
 * round-robin; with the player's club making an odd number of teams it comes
 * to more fixtures than the season is long, so whole home-and-away pairs are
 * dropped from the end to keep the split even.
 */
export function buildSchedule(clubs, conference, rng) {
  const others = clubs.filter((c) => !c.isUser);
  const rivals = LEAGUE.conferences
    ? others.filter((c) => c.conf === conference) : others;
  const cross = LEAGUE.conferences ? others.filter((c) => c.conf !== conference) : [];

  const order = [...rivals].sort(() => rng() - 0.5);
  let fixtures = [];
  for (const r of order) {
    fixtures.push({ opp: r, home: true });
    fixtures.push({ opp: r, home: false });
  }
  if (fixtures.length > LEAGUE.games) {
    // Trimming in pairs keeps home and away balanced.
    fixtures = fixtures.slice(0, LEAGUE.games - (LEAGUE.games % 2));
  }
  const shuffled = [...cross].sort(() => rng() - 0.5);
  const need = LEAGUE.games - fixtures.length;
  for (let i = 0; i < need; i++) {
    const opp = shuffled.length ? shuffled[i % shuffled.length] : order[i % order.length];
    fixtures.push({ opp, home: i % 2 === 0 });
  }
  // Spread across matchdays.
  for (let i = fixtures.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [fixtures[i], fixtures[j]] = [fixtures[j], fixtures[i]];
  }
  return fixtures.map((f, i) => ({ ...f, matchday: i + 1 }));
}

/**
 * Simulate the full regular season.
 *
 * The player's 34 fixtures are simulated match by match (that is what the
 * ticker replays). The other 30 clubs play their own 34 games against
 * opponents drawn from the league, which produces coherent tables and
 * realistic strength-of-schedule variety.
 */
export function simRegularSeason(userClub, opponents, conference, rng, ctx = {}) {
  const clubs = [userClub, ...opponents];
  const table = new Map(clubs.map((c) => [c.id, blankRecord(c)]));
  const userRec = table.get(userClub.id);
  const { squadPool, oppPools = {}, tally } = ctx;

  const fixtures = buildSchedule(clubs, conference, rng);
  const userMods = modsFor(userClub, 'regular');
  const results = [];
  for (const f of fixtures) {
    const { hg, ag } = f.home
      ? simMatch(userClub.spg, f.opp.spg, rng, userMods, NEUTRAL)
      : simMatch(f.opp.spg, userClub.spg, rng, NEUTRAL, userMods);
    const gf = f.home ? hg : ag;
    const ga = f.home ? ag : hg;
    applyResult(userRec, gf, ga);
    results.push({
      matchday: f.matchday, opp: f.opp, home: f.home, gf, ga,
      pts: userRec.pts,
      result: gf > ga ? 'W' : gf === ga ? 'D' : 'L',
      scorers: attribute(squadPool, gf, rng, tally),
      conceded: attribute(oppPools[f.opp.id], ga, rng, null),
    });
  }

  for (const club of opponents) {
    const rec = table.get(club.id);
    const others = clubs.filter((c) => c.id !== club.id);
    for (let g = 0; g < LEAGUE.games; g++) {
      const opp = others[Math.floor(rng() * others.length)];
      const home = g % 2 === 0;
      const { hg, ag } = home
        ? simMatch(club.spg, opp.spg, rng)
        : simMatch(opp.spg, club.spg, rng);
      applyResult(rec, home ? hg : ag, home ? ag : hg);
    }
  }

  const standings = {};
  for (const conf of conferenceNames()) {
    standings[conf] = [...table.values()]
      .filter((c) => !LEAGUE.conferences || c.conf === conf)
      .sort((a, b) => b.pts - a.pts || b.w - a.w || (b.gf - b.ga) - (a.gf - a.ga))
      .map((c, i) => ({ ...c, seed: i + 1 }));
  }
  return { results, standings, userRecord: { ...userRec } };
}

/** The tables a league keeps: two conferences, or one league-wide table. */
export const conferenceNames = () => (LEAGUE.conferences ? ['East', 'West'] : ['League']);

// ------------------------------------------------------------------ playoffs

/**
 * Name the scorers for one club's goals in a playoff tie. The player's own
 * goals are tallied toward their squad awards; opposition goals are named
 * from that club's current roster but not tallied.
 */
function goalsFor(club, n, rng, ctx) {
  if (!n) return [];
  const pool = club.isUser ? ctx.squadPool : (ctx.oppPools || {})[club.id];
  return attribute(pool, n, rng, club.isUser ? ctx.tally : null);
}

/** Best-of-3 Round One. Drawn games go straight to a shootout, as in MLS. */
function bestOfThree(high, low, rng, ctx = {}) {
  let hw = 0; let lw = 0; const games = [];
  for (let g = 0; g < 3 && hw < 2 && lw < 2; g++) {
    const highHosts = g !== 1; // higher seed hosts games 1 and 3
    const mh = modsFor(high, 'playoffs');
    const ml = modsFor(low, 'playoffs');
    const { hg, ag } = highHosts
      ? simMatch(high.spg, low.spg, rng, mh, ml)
      : simMatch(low.spg, high.spg, rng, ml, mh);
    const highGoals = highHosts ? hg : ag;
    const lowGoals = highHosts ? ag : hg;
    let winner;
    let pens = null;
    if (highGoals === lowGoals) {
      const highWins = simShootout(high.spg, low.spg, rng);
      winner = highWins ? high : low;
      pens = highWins ? 'high' : 'low';
    } else {
      winner = highGoals > lowGoals ? high : low;
    }
    if (winner === high) hw++; else lw++;
    games.push({
      highGoals, lowGoals, highHosts, pens, winner: winner.id,
      highScorers: goalsFor(high, highGoals, rng, ctx),
      lowScorers: goalsFor(low, lowGoals, rng, ctx),
    });
  }
  return { winner: hw > lw ? high : low, games, series: `${hw}-${lw}` };
}

/** Single-elimination tie hosted by the better seed; draw => shootout. */
function knockout(a, b, rng, ctx = {}) {
  const [host, away] = a.seed <= b.seed ? [a, b] : [b, a];
  const { hg, ag } = simMatch(host.spg, away.spg, rng,
    modsFor(host, 'playoffs'), modsFor(away, 'playoffs'));
  let winner; let pens = false;
  if (hg === ag) {
    pens = true;
    winner = simShootout(host.spg, away.spg, rng) ? host : away;
  } else {
    winner = hg > ag ? host : away;
  }
  return {
    winner, host, away, hg, ag, pens,
    hostScorers: goalsFor(host, hg, rng, ctx),
    awayScorers: goalsFor(away, ag, rng, ctx),
  };
}

/**
 * The NWSL's bracket: the top eight of a single table, straight knockout the
 * whole way, higher seed at home. The bracket is fixed rather than reseeded,
 * so the winners of 1v8 and 4v5 meet in one semifinal and 2v7 and 3v6 in the
 * other.
 */
function simSingleTablePlayoffs(standings, userId, rng, ctx) {
  const seeds = standings.League.slice(0, 8);
  const quarters = [[0, 7], [3, 4], [1, 6], [2, 5]].map(([hi, lo]) => ({
    conf: 'League', round: 'Quarterfinal', ...knockout(seeds[hi], seeds[lo], rng, ctx),
  }));
  const semis = [
    { conf: 'League', round: 'Semifinal', ...knockout(quarters[0].winner, quarters[1].winner, rng, ctx) },
    { conf: 'League', round: 'Semifinal', ...knockout(quarters[2].winner, quarters[3].winner, rng, ctx) },
  ];
  const final = {
    conf: 'Cup', round: LEAGUE.cupName,
    ...knockout(semis[0].winner, semis[1].winner, rng, ctx),
  };
  const rounds = [...quarters, ...semis, final];
  return {
    rounds,
    champion: final.winner,
    userTies: rounds.filter((r) => r.host?.id === userId || r.away?.id === userId),
    wonCup: final.winner.id === userId,
  };
}

/** Top 8 per conference, Round One best-of-3, then single elimination. */
export function simPlayoffs(standings, userId, rng, ctx = {}) {
  if (!LEAGUE.conferences) return simSingleTablePlayoffs(standings, userId, rng, ctx);
  const rounds = [];
  const confWinners = {};

  for (const conf of ['East', 'West']) {
    const seeds = standings[conf].slice(0, 8);
    const r1 = [];
    for (const [hi, lo] of [[0, 7], [1, 6], [2, 5], [3, 4]]) {
      const tie = bestOfThree(seeds[hi], seeds[lo], rng, ctx);
      r1.push({ conf, round: 'Round One', high: seeds[hi], low: seeds[lo], ...tie });
    }
    let alive = r1.map((t) => t.winner).sort((a, b) => a.seed - b.seed);

    const semis = [
      knockout(alive[0], alive[3], rng, ctx),
      knockout(alive[1], alive[2], rng, ctx),
    ].map((t) => ({ conf, round: 'Conference Semifinal', ...t }));
    alive = semis.map((t) => t.winner).sort((a, b) => a.seed - b.seed);

    const final = { conf, round: 'Conference Final', ...knockout(alive[0], alive[1], rng, ctx) };
    confWinners[conf] = final.winner;
    rounds.push(...r1, ...semis, final);
  }

  const cup = { conf: 'Cup', round: LEAGUE.cupName, ...knockout(confWinners.East, confWinners.West, rng, ctx) };
  rounds.push(cup);

  return {
    rounds,
    champion: cup.winner,
    userTies: rounds.filter((r) => r.high?.id === userId || r.low?.id === userId
      || r.host?.id === userId || r.away?.id === userId),
    wonCup: cup.winner.id === userId,
  };
}

/** Rank a goal/assist tally into a leaderboard. */
function leaderboard(tally, key) {
  return Object.entries(tally)
    .map(([id, t]) => ({ id, ...t }))
    .filter((t) => t[key] > 0)
    .sort((a, b) => b[key] - a[key] || b.goals - a.goals)
    .slice(0, 5);
}

/**
 * Full season: regular season, playoffs (if the player qualifies), verdict.
 *
 * `rosters` maps club id -> current squad, used to name opposition scorers.
 * Goals and assists are tallied for the player's own squad across both the
 * regular season and the playoff run.
 */
export function simSeason({ squad, opponents, conference, teamName, rng, rosters = {}, coach = null }) {
  const { total, spg } = squadStrength(squad);
  const userClub = {
    id: '__user__', abbr: 'YOU', name: teamName || 'Your Club',
    short: teamName || 'Your Club', conf: conference, spg, isUser: true,
    mods: { regular: coachMods(coach, 'regular'), playoffs: coachMods(coach, 'playoffs') },
  };

  const tally = {};
  const ctx = {
    tally,
    squadPool: scorerPool(squad.filter((s) => s.starter && s.player).map((s) => s.player)),
    oppPools: Object.fromEntries(
      Object.entries(rosters).map(([id, r]) => [id, scorerPool(r, true)]),
    ),
  };

  const season = simRegularSeason(userClub, opponents, conference, rng, ctx);
  const table = season.standings[conference];
  const userRow = table.find((c) => c.id === userClub.id);
  const madePlayoffs = userRow.seed <= 8;

  const regularTally = JSON.parse(JSON.stringify(tally));
  const playoffs = simPlayoffs(season.standings, userClub.id, rng, ctx);
  const points = season.userRecord.pts;

  return {
    strength: total,
    spg,
    coach,
    ...season,
    seed: userRow.seed,
    madePlayoffs,
    playoffs,
    points,
    awards: {
      scorers: leaderboard(regularTally, 'goals'),
      assisters: leaderboard(regularTally, 'assists'),
      allScorers: leaderboard(tally, 'goals'),
    },
    wonCup: madePlayoffs && playoffs.wonCup,
    won: points >= LEAGUE.target && madePlayoffs && playoffs.wonCup,
  };
}
