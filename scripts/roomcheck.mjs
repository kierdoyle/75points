// Headless check for multiplayer draft rooms.
//
//   npm run rooms          -- MLS
//   npm run rooms -- nwsl  -- the other league
//
// Runs whole rooms without a server: the room row is kept in memory and the
// same client modules the browser uses drive the draft. What it is really
// testing is the three properties a shared draft lives or dies by --
// exclusivity, completion, and determinism.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { rulesFor, SQUAD_SIZE, FORMATIONS, swapTargets } from '../src/rules.js';
import { loadPool, makeRng, currentRosters, spinKey } from '../src/pool.js';
import { configureLeague, LEAGUE, squadStrength } from '../src/sim.js';
import { seatAt, positionOnClock, roundOf, draftOrder } from '../src/room.js';
import {
  replay, proposeBoard, bestMove, coachShortlists, boardForPick,
} from '../src/roomdraft.js';
import { simRoom, roomLeaderboard } from '../src/roomsim.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, '..', 'src', 'data', f)));

const LEAGUE_KEY = process.argv.find((a) => a === 'nwsl') ? 'nwsl' : 'mls';
const FILES = LEAGUE_KEY === 'nwsl' ? ['nwsl-pool.json', 'nwsl-sim.json'] : ['pool.json', 'sim.json'];
const pool = loadPool(read(FILES[0]));
const sim = read(FILES[1]);
configureLeague({
  key: sim.league, name: sim.name, games: sim.games, target: sim.target,
  conferences: sim.conferences, cupName: sim.cupName, shieldName: sim.shieldName,
  records: sim.records, baseGoals: sim.baseGoals, homeLog: sim.homeLog,
  kStrength: sim.kStrength,
});

const FORMATION_NAMES = Object.keys(FORMATIONS);
let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failed++;
};

/**
 * Play a whole draft against an in-memory room row.
 *
 * The mock stands in for rooms.sql and enforces the same two invariants the
 * database does: picks land in snake order, and a player can only be claimed
 * once. If the client logic ever tries to violate either, this throws rather
 * than quietly producing a room the real server would have rejected.
 */
function runDraft({ seats, seed, difficulty = 'normal', league = LEAGUE_KEY }) {
  const rules = rulesFor(difficulty, league);
  const rng = makeRng(seed);
  const members = [];
  for (let seat = 0; seat < seats; seat++) {
    members.push({
      seat,
      client_id: `client-${seat}`,
      name: `Player ${seat + 1}`,
      formation: FORMATION_NAMES[Math.floor(rng() * FORMATION_NAMES.length)],
      conference: LEAGUE.conferences ? (rng() < 0.5 ? 'East' : 'West') : 'League',
      coach_id: null,
      ready: false,
    });
  }

  // A fixed shuffle per seed, so a run is reproducible but the first pick is
  // not always seat 0.
  const order = members.map((m) => m.seat);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const room = {
    code: 'TEST', league, difficulty, seed, phase: 'draft',
    pick_no: 0, boards: [], draft_order: order, members, picks: [], pick_seconds: 60,
  };

  const claimed = new Set();
  const total = seats * SQUAD_SIZE;
  let passes = 0;
  let replacements = 0;

  while (room.pick_no < total) {
    const state = replay(room, pool, rules);
    const round = roundOf(room.pick_no, seats);

    if (room.boards.length === round) {
      const spin = proposeBoard(pool, state, round, seed);
      if (!spin) throw new Error(`no board for round ${round}`);
      room.boards.push(spinKey(spin));
    }

    const fresh = replay(room, pool, rules);
    const seat = seatAt(room, room.pick_no);
    if (seat !== fresh.onClock) throw new Error('turn order disagreement');

    const { board, personal } = boardForPick(pool, fresh, seed);
    if (personal) replacements++;
    const move = bestMove(board, fresh.squads.get(seat), fresh.taken, rules);
    let playerId;
    let slotId;
    if (move) {
      playerId = move.player.id;
      slotId = move.slot.id;
    } else {
      passes++;
      playerId = `__pass__${room.pick_no}`;
      slotId = fresh.squads.get(seat).find((s) => !s.player).id;
    }
    if (claimed.has(playerId)) throw new Error(`player claimed twice: ${playerId}`);
    claimed.add(playerId);

    room.picks.push({
      pick_no: room.pick_no, round, seat, player_id: playerId, slot_id: slotId,
      auto: false, board_key: personal && board ? spinKey(board) : null,
    });
    room.pick_no++;
  }

  return { room, rules, passes, replacements };
}

function seasonFor(room, rules, seed) {
  const state = replay(room, pool, rules);
  const shortlists = coachShortlists(sim.coaches, state.seats, seed);
  const members = state.members.map((m) => ({
    seat: m.seat,
    teamName: `${m.name} FC`,
    squad: state.squads.get(m.seat),
    conference: LEAGUE.conferences ? m.conference : 'League',
    // Everyone takes the first name on their own shortlist, so the check
    // exercises the coach path without depending on how a human would choose.
    coach: shortlists.get(m.seat)[0] || null,
  }));
  return simRoom({
    members, opponents: sim.opponents, rosters: currentRosters(pool), rng: makeRng(seed ^ 0xabcd),
  });
}

function main() {
  console.log(`\nRoom check - ${LEAGUE.name}\n`);

  // ------------------------------------------------ exclusivity + completion
  console.log('draft integrity');
  for (const seats of [2, 4, 8]) {
    for (const difficulty of ['normal', 'hard']) {
      const seed = 12345 + seats * 7 + (difficulty === 'hard' ? 991 : 0);
      const { room, rules, passes, replacements } = runDraft({ seats, seed, difficulty });
      const state = replay(room, pool, rules);

      const everyone = [];
      let full = true;
      for (const m of state.members) {
        const squad = state.squads.get(m.seat);
        if (squad.filter((s) => s.player).length !== SQUAD_SIZE) full = false;
        for (const s of squad) if (s.player) everyone.push(s.player.id);
      }
      const unique = new Set(everyone).size === everyone.length;
      check(`${seats} seats / ${difficulty}: every squad full`, full && passes === 0,
        passes ? `${passes} passes` : (replacements ? `${replacements} replacement boards` : ''));
      check(`${seats} seats / ${difficulty}: nobody drafted twice`, unique,
        `${everyone.length} picks, ${new Set(everyone).size} distinct`);
      const allBoards = [...room.boards, ...room.picks.map((p) => p.board_key).filter(Boolean)];
      check(`${seats} seats / ${difficulty}: no club-season repeats`,
        new Set(allBoards).size === allBoards.length,
        `${room.boards.length} shared${replacements ? ` + ${replacements} replacement` : ''}`);
    }
  }

  // ------------------------------------------------------------ draft order
  console.log('\ndraft order');
  {
    const firstSeat = [];
    for (let n = 0; n < 40; n++) {
      const { room } = runDraft({ seats: 4, seed: 900 + n * 17 });
      firstSeat.push(room.picks[0].seat);
    }
    const distinct = new Set(firstSeat).size;
    const hostOpened = firstSeat.filter((s) => s === 0).length;
    check('the host does not open every draft', distinct > 1,
      `${distinct} different seats picked first across 40 rooms`);
    check('seat 0 opens roughly its share', hostOpened < 40 * 0.6,
      `seat 0 picked first ${hostOpened}/40`);
  }

  // ---------------------------------------------------------- snake fairness
  console.log('\nsnake order');
  for (const seats of [3, 5, 8]) {
    const counts = new Array(seats).fill(0);
    const firstOfRound = new Set();
    for (let p = 0; p < seats * SQUAD_SIZE; p++) {
      const seat = positionOnClock(p, seats);
      counts[seat]++;
      if (p % seats === 0) firstOfRound.add(seat);
    }
    check(`${seats} seats: everyone picks ${SQUAD_SIZE} times`,
      counts.every((c) => c === SQUAD_SIZE), counts.join(','));
    check(`${seats} seats: the first pick moves around`, firstOfRound.size > 1,
      `${firstOfRound.size} different seats picked first`);
  }

  // ------------------------------------------------------------ lineups
  console.log('\npost-draft lineup changes');
  {
    const { room, rules } = runDraft({ seats: 3, seed: 8123 });
    const base = replay(room, pool, rules);
    const squad = base.squads.get(0);
    const before = squadStrength(squad).total;
    const ids = squad.filter((s) => s.player).map((s) => s.player.id).sort();

    let swapped = null;
    for (const a of squad.filter((s) => s.player)) {
      for (const b of swapTargets(a, squad)) {
        const t = squad.map((s) => ({ ...s }));
        const A = t.find((s) => s.id === a.id);
        const B = t.find((s) => s.id === b.id);
        [A.player, B.player] = [B.player, A.player];
        if (Math.abs(squadStrength(t).total - before) > 0.05) { swapped = t; break; }
      }
      if (swapped) break;
    }
    const lineup = Object.fromEntries(
      swapped.filter((s) => s.player).map((s) => [s.id, s.player.id]),
    );
    const withLineup = (l) => replay(
      { ...room, members: room.members.map((m) => (m.seat === 0 ? { ...m, lineup: l } : m)) },
      pool, rules,
    ).squads.get(0);

    const after = withLineup(lineup);
    check('a saved arrangement is replayed exactly',
      Math.abs(squadStrength(after).total - squadStrength(swapped).total) < 1e-9);
    check('rearranging keeps the same players',
      JSON.stringify(after.filter((s) => s.player).map((s) => s.player.id).sort()) === JSON.stringify(ids));

    // The arrangement is a permutation of the drafted squad and nothing more.
    const cheat = { ...lineup };
    cheat[Object.keys(cheat)[0]] = 'NOT_DRAFTED';
    const guarded = withLineup(cheat);
    check('a lineup naming an undrafted player is ignored',
      JSON.stringify(guarded.filter((s) => s.player).map((s) => s.player.id).sort()) === JSON.stringify(ids)
      && Math.abs(squadStrength(guarded).total - before) < 1e-9);
  }

  // ------------------------------------------------------------ determinism
  console.log('\ndeterminism');
  const a = runDraft({ seats: 4, seed: 777 });
  const b = runDraft({ seats: 4, seed: 777 });
  check('same seed, same boards', JSON.stringify(a.room.boards) === JSON.stringify(b.room.boards));
  check('same seed, same picks',
    JSON.stringify(a.room.picks) === JSON.stringify(b.room.picks));

  const s1 = seasonFor(a.room, a.rules, 777);
  const s2 = seasonFor(b.room, b.rules, 777);
  const line = (s) => roomLeaderboard(s).map((r) => `${r.seat}:${r.points}:${r.wonCup}`).join('|');
  check('same room, same season on every client', line(s1) === line(s2), line(s1));

  // A member's own card and the shared table have to tell the same story.
  let consistent = true;
  for (const [, r] of s1.bySeat) {
    const w = r.results.filter((x) => x.result === 'W').length;
    const d = r.results.filter((x) => x.result === 'D').length;
    if (w * 3 + d !== r.points || r.results.length !== LEAGUE.games) consistent = false;
  }
  check('每 card matches the table'.replace('每', 'each'), consistent);

  // Head-to-heads must exist and agree from both sides.
  const seats4 = [...s1.bySeat.keys()];
  let mirrored = true;
  let met = 0;
  for (const seatA of seats4) {
    for (const seatB of seats4) {
      if (seatA >= seatB) continue;
      const idB = `__seat${seatB}__`;
      const idA = `__seat${seatA}__`;
      const fromA = s1.bySeat.get(seatA).results.filter((r) => r.opp.id === idB);
      const fromB = s1.bySeat.get(seatB).results.filter((r) => r.opp.id === idA);
      if (fromA.length !== fromB.length || fromA.length === 0) { mirrored = false; continue; }
      met++;
      const sortKey = (r) => `${r.home ? 1 : 0}${r.gf}${r.ga}`;
      const setA = fromA.map(sortKey).sort().join();
      const setB = fromB.map((r) => `${r.home ? 0 : 1}${r.ga}${r.gf}`).sort().join();
      if (setA !== setB) mirrored = false;
    }
  }
  check('every pair of members met, and agree on the score', mirrored && met === 6,
    `${met} pairings`);

  // --------------------------------------------------------------- balance
  console.log('\nbalance (8-seat rooms, best-available bots)');
  const pointsBySeat = new Array(8).fill(0);
  const strengthBySeat = new Array(8).fill(0);
  const RUNS = 12;
  let winners = 0;
  for (let n = 0; n < RUNS; n++) {
    const seed = 4200 + n * 13;
    const { room, rules } = runDraft({ seats: 8, seed });
    const s = seasonFor(room, rules, seed);
    for (const [seat, r] of s.bySeat) {
      pointsBySeat[seat] += r.points / RUNS;
      strengthBySeat[seat] += r.strength / RUNS;
      if (r.won) winners++;
    }
  }
  const spread = Math.max(...pointsBySeat) - Math.min(...pointsBySeat);
  console.log(`  seat points  ${pointsBySeat.map((p) => p.toFixed(0)).join('  ')}`);
  console.log(`  seat g+      ${strengthBySeat.map((p) => p.toFixed(1)).join('  ')}`);
  check('no seat is systematically favoured', spread < 12, `spread ${spread.toFixed(1)} pts`);
  check('the target stays hard for bots', winners <= RUNS,
    `${winners} wins in ${RUNS * 8} club-seasons`);

  console.log(failed ? `\n${failed} check(s) failed\n` : '\nall checks passed\n');
  process.exit(failed ? 1 : 0);
}

main();
