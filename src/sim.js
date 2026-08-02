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

export const BASE_GOALS = 1.4;      // league goals per team per game
export const HOME_LOG = 0.2494;     // ~ +0.35 expected goal difference at home
export const K_STRENGTH = 0.75;     // per-game g+ edge -> log goals
export const MIN_LAMBDA = 0.2;
export const SEASON_GAMES = 34;
export const TARGET_POINTS = 75;
export const SUB_WEIGHT = 0.3;      // subs contribute at 30% toward strength

/** Squad strength per game: starting XI in full, subs at SUB_WEIGHT. */
export function squadStrength(squad) {
  let total = 0;
  for (const s of squad) {
    if (!s.player) continue;
    total += s.starter ? s.player.score : s.player.score * SUB_WEIGHT;
  }
  return { total, spg: total / SEASON_GAMES };
}

function poisson(lambda, rng) {
  const L = Math.exp(-lambda);
  let k = 0; let p = 1;
  do { k++; p *= rng(); } while (p > L);
  return k - 1;
}

/** Simulate one match. Returns goals for the home and away side. */
export function simMatch(spgHome, spgAway, rng) {
  const edge = (K_STRENGTH * (spgHome - spgAway)) / 2 + HOME_LOG / 2;
  const lh = Math.max(MIN_LAMBDA, BASE_GOALS * Math.exp(edge));
  const la = Math.max(MIN_LAMBDA, BASE_GOALS * Math.exp(-edge));
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
 * Build the player's 34-game fixture list: every conference rival home and
 * away, topped up to 34 with cross-conference trips (17 home / 17 away).
 */
export function buildSchedule(clubs, conference, rng) {
  const rivals = clubs.filter((c) => c.conf === conference && !c.isUser);
  const cross = clubs.filter((c) => c.conf !== conference);
  const fixtures = [];
  for (const r of rivals) {
    fixtures.push({ opp: r, home: true });
    fixtures.push({ opp: r, home: false });
  }
  const shuffled = [...cross].sort(() => rng() - 0.5);
  const need = SEASON_GAMES - fixtures.length;
  for (let i = 0; i < need; i++) {
    fixtures.push({ opp: shuffled[i % shuffled.length], home: i % 2 === 0 });
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
export function simRegularSeason(userClub, opponents, conference, rng) {
  const clubs = [userClub, ...opponents];
  const table = new Map(clubs.map((c) => [c.id, blankRecord(c)]));
  const userRec = table.get(userClub.id);

  const fixtures = buildSchedule(clubs, conference, rng);
  const results = [];
  for (const f of fixtures) {
    const { hg, ag } = f.home
      ? simMatch(userClub.spg, f.opp.spg, rng)
      : simMatch(f.opp.spg, userClub.spg, rng);
    const gf = f.home ? hg : ag;
    const ga = f.home ? ag : hg;
    applyResult(userRec, gf, ga);
    results.push({
      matchday: f.matchday, opp: f.opp, home: f.home, gf, ga,
      pts: userRec.pts,
      result: gf > ga ? 'W' : gf === ga ? 'D' : 'L',
    });
  }

  for (const club of opponents) {
    const rec = table.get(club.id);
    const others = clubs.filter((c) => c.id !== club.id);
    for (let g = 0; g < SEASON_GAMES; g++) {
      const opp = others[Math.floor(rng() * others.length)];
      const home = g % 2 === 0;
      const { hg, ag } = home
        ? simMatch(club.spg, opp.spg, rng)
        : simMatch(opp.spg, club.spg, rng);
      applyResult(rec, home ? hg : ag, home ? ag : hg);
    }
  }

  const standings = {};
  for (const conf of ['East', 'West']) {
    standings[conf] = [...table.values()]
      .filter((c) => c.conf === conf)
      .sort((a, b) => b.pts - a.pts || b.w - a.w || (b.gf - b.ga) - (a.gf - a.ga))
      .map((c, i) => ({ ...c, seed: i + 1 }));
  }
  return { results, standings, userRecord: { ...userRec } };
}

// ------------------------------------------------------------------ playoffs

/** Best-of-3 Round One. Drawn games go straight to a shootout, as in MLS. */
function bestOfThree(high, low, rng) {
  let hw = 0; let lw = 0; const games = [];
  for (let g = 0; g < 3 && hw < 2 && lw < 2; g++) {
    const highHosts = g !== 1; // higher seed hosts games 1 and 3
    const { hg, ag } = highHosts
      ? simMatch(high.spg, low.spg, rng)
      : simMatch(low.spg, high.spg, rng);
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
    games.push({ highGoals, lowGoals, highHosts, pens, winner: winner.id });
  }
  return { winner: hw > lw ? high : low, games, series: `${hw}-${lw}` };
}

/** Single-elimination tie hosted by the better seed; draw => shootout. */
function knockout(a, b, rng) {
  const [host, away] = a.seed <= b.seed ? [a, b] : [b, a];
  const { hg, ag } = simMatch(host.spg, away.spg, rng);
  let winner; let pens = false;
  if (hg === ag) {
    pens = true;
    winner = simShootout(host.spg, away.spg, rng) ? host : away;
  } else {
    winner = hg > ag ? host : away;
  }
  return { winner, host, away, hg, ag, pens };
}

/** Top 8 per conference, Round One best-of-3, then single elimination. */
export function simPlayoffs(standings, userId, rng) {
  const rounds = [];
  const confWinners = {};

  for (const conf of ['East', 'West']) {
    const seeds = standings[conf].slice(0, 8);
    const r1 = [];
    for (const [hi, lo] of [[0, 7], [1, 6], [2, 5], [3, 4]]) {
      const tie = bestOfThree(seeds[hi], seeds[lo], rng);
      r1.push({ conf, round: 'Round One', high: seeds[hi], low: seeds[lo], ...tie });
    }
    let alive = r1.map((t) => t.winner).sort((a, b) => a.seed - b.seed);

    const semis = [
      knockout(alive[0], alive[3], rng),
      knockout(alive[1], alive[2], rng),
    ].map((t) => ({ conf, round: 'Conference Semifinal', ...t }));
    alive = semis.map((t) => t.winner).sort((a, b) => a.seed - b.seed);

    const final = { conf, round: 'Conference Final', ...knockout(alive[0], alive[1], rng) };
    confWinners[conf] = final.winner;
    rounds.push(...r1, ...semis, final);
  }

  const cup = { conf: 'Cup', round: 'MLS Cup', ...knockout(confWinners.East, confWinners.West, rng) };
  rounds.push(cup);

  return {
    rounds,
    champion: cup.winner,
    userTies: rounds.filter((r) => r.high?.id === userId || r.low?.id === userId
      || r.host?.id === userId || r.away?.id === userId),
    wonCup: cup.winner.id === userId,
  };
}

/** Full season: regular season, playoffs (if the player qualifies), verdict. */
export function simSeason({ squad, opponents, conference, teamName, rng }) {
  const { total, spg } = squadStrength(squad);
  const userClub = {
    id: '__user__', abbr: 'YOU', name: teamName || 'Your Club',
    short: teamName || 'Your Club', conf: conference, spg, isUser: true,
  };
  const season = simRegularSeason(userClub, opponents, conference, rng);
  const table = season.standings[conference];
  const userRow = table.find((c) => c.id === userClub.id);
  const madePlayoffs = userRow.seed <= 8;

  const playoffs = simPlayoffs(season.standings, userClub.id, rng);
  const points = season.userRecord.pts;

  return {
    strength: total,
    spg,
    ...season,
    seed: userRow.seed,
    madePlayoffs,
    playoffs,
    points,
    wonCup: madePlayoffs && playoffs.wonCup,
    won: points >= TARGET_POINTS && madePlayoffs && playoffs.wonCup,
  };
}
