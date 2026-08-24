// One league, several drafted clubs.
//
// The solo game simulates a single club against the real 2026 field. A draft
// room puts every member's squad into that same league at once, which adds one
// requirement the solo sim never had: a match between two members has to exist
// exactly once. If each member simulated their own season independently, two
// people would come away with different accounts of the same fixture -- the
// one result in the room anyone actually argues about.
//
// So member-versus-member fixtures are simulated first, once, and both records
// take the same scoreline. Everything after that follows the solo game: the
// rest of each member's card is drawn against the real clubs, and the real
// clubs play out their own seasons to furnish a table.
//
// Determinism matters more here than anywhere else in the game. Every client
// runs this locally off the room's shared seed and must land on the same
// season, so every loop below runs in a fixed order -- seat order, then
// fixture order -- and never over a Map's insertion order or an object's keys.

import { squadStrength } from './sim.js';
import {
  LEAGUE, simMatch, simPlayoffs, coachMods, scorerPool, attribute,
  blankRecord, applyResult, modsFor, NEUTRAL, conferenceNames,
} from './sim.js';

export const clubIdFor = (seat) => `__seat${seat}__`;

/** A short, table-friendly tag for a club name. */
export function abbrOf(name, seat) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1
    ? words.map((w) => w[0]).join('')
    : (words[0] || `P${seat + 1}`).slice(0, 3);
  return letters.slice(0, 3).toUpperCase() || `P${seat + 1}`;
}

/** Build the club object a member's squad plays as. */
function memberClub(m) {
  const { total, spg } = squadStrength(m.squad);
  return {
    id: clubIdFor(m.seat),
    seat: m.seat,
    abbr: abbrOf(m.teamName, m.seat),
    name: m.teamName,
    short: m.teamName,
    conf: LEAGUE.conferences ? m.conference : 'League',
    spg,
    strength: total,
    isUser: true,
    isMember: true,
    coach: m.coach || null,
    mods: {
      regular: coachMods(m.coach, 'regular'),
      playoffs: coachMods(m.coach, 'playoffs'),
    },
    pool: scorerPool(m.squad.filter((s) => s.starter && s.player).map((s) => s.player)),
    tally: {},
  };
}

/**
 * Every meeting between two members.
 *
 * Conference rivals meet home and away; clubs in opposite conferences meet
 * once. Either way everyone in the room plays everyone else at least once,
 * which is the point -- a room where two friends never met would be a poor
 * argument settler.
 */
function memberFixtures(clubs) {
  const out = [];
  for (let i = 0; i < clubs.length; i++) {
    for (let j = i + 1; j < clubs.length; j++) {
      const a = clubs[i];
      const b = clubs[j];
      if (!LEAGUE.conferences || a.conf === b.conf) {
        out.push({ home: a, away: b });
        out.push({ home: b, away: a });
      } else {
        // Alternate who hosts so no seat collects every neutral-ish home tie.
        const aHosts = (i + j) % 2 === 0;
        out.push(aHosts ? { home: a, away: b } : { home: b, away: a });
      }
    }
  }
  return out;
}

/** Top up a member's card with real clubs until the season is the right length. */
function fillWithRealClubs(club, opponents, need, rng) {
  if (need <= 0) return [];
  const rivals = LEAGUE.conferences
    ? opponents.filter((o) => o.conf === club.conf) : opponents;
  const cross = LEAGUE.conferences
    ? opponents.filter((o) => o.conf !== club.conf) : [];

  const shuffled = (list) => {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const fixtures = [];
  for (const r of shuffled(rivals)) {
    fixtures.push({ opp: r, home: true });
    fixtures.push({ opp: r, home: false });
    if (fixtures.length >= need) break;
  }
  const pool = shuffled(cross.length ? cross : rivals);
  for (let i = 0; fixtures.length < need; i++) {
    fixtures.push({ opp: pool[i % pool.length], home: i % 2 === 0 });
  }
  return fixtures.slice(0, need);
}

/**
 * Simulate the whole room's season.
 *
 * `members` is [{ seat, teamName, squad, conference, coach }] and must already
 * be in seat order.
 */
export function simRoom({ members, opponents, rosters = {}, rng }) {
  const clubs = members.map(memberClub);
  const byId = new Map(clubs.map((c) => [c.id, c]));
  const all = [...clubs, ...opponents];
  const table = new Map(all.map((c) => [c.id, blankRecord(c)]));

  const oppPools = Object.fromEntries(
    Object.entries(rosters).map(([id, r]) => [id, scorerPool(r, true)]),
  );
  const poolFor = (club) => club.pool || oppPools[club.id];

  // Cards are collected per club and only sorted into matchdays at the end,
  // so a member's ticker reads as one season however its fixtures were drawn.
  const cards = new Map(clubs.map((c) => [c.id, []]));

  /**
   * Play one fixture.
   *
   * Only members' records move here. A real club's season is its own 34-game
   * card in step 3, exactly as in the solo game -- if its games against the
   * room counted too it would bank points from a schedule half again as long
   * as everyone else's, and the table would stop meaning anything.
   */
  const playMatch = (home, away) => {
    const { hg, ag } = simMatch(home.spg, away.spg, rng,
      modsFor(home, 'regular'), modsFor(away, 'regular'));
    const homeGoals = attribute(poolFor(home), hg, rng, home.tally || null);
    const awayGoals = attribute(poolFor(away), ag, rng, away.tally || null);
    if (cards.has(home.id)) {
      applyResult(table.get(home.id), hg, ag);
      cards.get(home.id).push({
        opp: away, home: true, gf: hg, ga: ag, scorers: homeGoals, conceded: awayGoals,
      });
    }
    if (cards.has(away.id)) {
      applyResult(table.get(away.id), ag, hg);
      cards.get(away.id).push({
        opp: home, home: false, gf: ag, ga: hg, scorers: awayGoals, conceded: homeGoals,
      });
    }
  };

  // 1. Member against member, once each, both records from the same scoreline.
  const derbies = memberFixtures(clubs);
  for (const f of derbies) playMatch(f.home, f.away);

  // 2. The rest of each member's season, against the real clubs.
  for (const club of clubs) {
    const played = cards.get(club.id).length;
    for (const f of fillWithRealClubs(club, opponents, LEAGUE.games - played, rng)) {
      if (f.home) playMatch(club, f.opp); else playMatch(f.opp, club);
    }
  }

  // 3. The real clubs' own seasons, as in the solo game: each plays a full
  //    card against opponents drawn from the league, and only its own record
  //    is touched. Their games against members above are extra fixtures in a
  //    league that was never going to balance to a real calendar anyway.
  for (const club of opponents) {
    const rec = table.get(club.id);
    const others = all.filter((c) => c.id !== club.id);
    for (let g = 0; g < LEAGUE.games; g++) {
      const opp = others[Math.floor(rng() * others.length)];
      const home = g % 2 === 0;
      const { hg, ag } = home
        ? simMatch(club.spg, opp.spg, rng)
        : simMatch(opp.spg, club.spg, rng);
      applyResult(rec, home ? hg : ag, home ? ag : hg);
    }
  }

  // Every club in the table has now played exactly LEAGUE.games, members and
  // real clubs alike, so points rank them directly.
  const standings = {};
  for (const conf of conferenceNames()) {
    standings[conf] = [...table.values()]
      .filter((c) => !LEAGUE.conferences || c.conf === conf)
      .sort((a, b) => b.pts - a.pts || b.w - a.w || (b.gf - b.ga) - (a.gf - a.ga))
      .map((c, i) => ({ ...c, seed: i + 1 }));
  }

  // Seed the clubs for the bracket from where they finished.
  const seedOf = new Map();
  for (const conf of conferenceNames()) {
    for (const row of standings[conf]) seedOf.set(row.id, row.seed);
  }
  for (const c of all) c.seed = seedOf.get(c.id);

  const bracketStandings = {};
  for (const conf of conferenceNames()) {
    bracketStandings[conf] = standings[conf].map((row) => byId.get(row.id) || row);
  }

  const regularTallies = new Map(
    clubs.map((c) => [c.id, JSON.parse(JSON.stringify(c.tally))]),
  );
  const playoffs = simPlayoffs(bracketStandings, '__none__', rng, { oppPools });

  // Per-member view of the shared season.
  const bySeat = new Map();
  for (const club of clubs) {
    const row = standings[club.conf].find((c) => c.id === club.id);
    const results = cards.get(club.id).map((r, i) => ({ ...r, matchday: i + 1 }));
    let pts = 0;
    for (const r of results) {
      pts += r.gf > r.ga ? 3 : r.gf === r.ga ? 1 : 0;
      r.pts = pts;
      r.result = r.gf > r.ga ? 'W' : r.gf === r.ga ? 'D' : 'L';
    }
    const ties = playoffs.rounds.filter((t) => [t.high, t.low, t.host, t.away]
      .some((c) => c && c.id === club.id));
    bySeat.set(club.seat, {
      club,
      results,
      record: { w: row.w, d: row.d, l: row.l, gf: row.gf, ga: row.ga, pts: row.pts },
      points: row.pts,
      seed: row.seed,
      madePlayoffs: row.seed <= 8,
      strength: club.strength,
      spg: club.spg,
      coach: club.coach,
      ties,
      wonCup: playoffs.champion.id === club.id,
      awards: {
        scorers: leaderboard(regularTallies.get(club.id), 'goals'),
        assisters: leaderboard(regularTallies.get(club.id), 'assists'),
        allScorers: leaderboard(club.tally, 'goals'),
      },
      won: row.pts >= LEAGUE.target && row.seed <= 8 && playoffs.champion.id === club.id,
    });
  }

  return {
    clubs, standings, playoffs, bySeat,
    champion: playoffs.champion,
    derbies: derbies.length,
  };
}

/** Rank a goal/assist tally into a leaderboard. Mirrors the solo game's. */
function leaderboard(tally, key) {
  return Object.entries(tally || {})
    .map(([id, t]) => ({ id, ...t }))
    .filter((t) => t[key] > 0)
    .sort((a, b) => b[key] - a[key] || b.goals - a.goals)
    .slice(0, 5);
}

/** The room's final ordering: the win condition first, then points. */
export function roomLeaderboard(sim) {
  return [...sim.bySeat.entries()]
    .map(([seat, r]) => ({ seat, ...r }))
    .sort((a, b) => (b.won - a.won) || (b.wonCup - a.wonCup)
      || (b.points - a.points) || (b.strength - a.strength));
}
