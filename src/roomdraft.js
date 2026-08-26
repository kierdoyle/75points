// Shared-board draft logic. No DOM and no network in here, so the sanity test
// can run whole rooms headlessly against the same code the browser runs.
//
// How a room stays in sync
// ------------------------
// The server stores almost nothing: the seed, the club-season drafted in each
// round, and the ordered list of picks. Everything else -- every squad, whose
// turn it is, the coach shortlists, the season itself -- is *derived* from
// those by replaying them here. Two clients holding the same room row
// therefore compute byte-identical state without any of it crossing the wire.
//
// That is also why the season never has to be simulated centrally: once the
// last pick lands, every client already holds everything needed to run it.

import {
  makeSquad, blockReason, openSlotsFor, effectiveScore, countDPs, SQUAD_SIZE,
} from './rules.js';
import { makeRng, spinKey, drawSpin } from './pool.js';
import { seatAt, roundOf, roundOrder, draftOrder } from './room.js';
import { STARTER_WEIGHT, SUB_WEIGHT } from './sim.js';

/** A pick that could not be made: recorded so pick numbering stays even. */
export const PASS_PREFIX = '__pass__';
export const isPass = (id) => String(id).startsWith(PASS_PREFIX);
const passId = (pickNo) => `${PASS_PREFIX}${pickNo}`;

const weightOf = (slot) => (slot.starter ? STARTER_WEIGHT : SUB_WEIGHT);

/** Members in seat order. Seat order is the draft order, so it must be fixed. */
export const seatedMembers = (room) => [...(room.members || [])].sort((a, b) => a.seat - b.seat);

/** The club-seasons this room has drafted from, resolved against the pool. */
export function roomBoards(room, pool) {
  const byKey = new Map(pool.spins.map((s) => [spinKey(s), s]));
  return (room.boards || []).map((k) => byKey.get(k) || null);
}

/**
 * Replay every pick into squads.
 *
 * The only source of truth for a squad is the pick list, so a client that
 * reloads mid-draft rebuilds exactly what it had. `taken` is room-wide: that
 * is the rule that makes this a draft rather than fourteen solo games.
 */
export function replay(room, pool, rules) {
  const members = seatedMembers(room);
  const byKey = new Map(pool.spins.map((s) => [spinKey(s), s]));
  const boards = (room.boards || []).map((k) => byKey.get(k) || null);

  // A pick is resolved against the board it was made from, never against a
  // league-wide index of player ids. The same person turns up on many
  // club-seasons -- Michael Bradley is a $6.5m Designated Player on one board
  // and a $1.5m veteran on another -- and they are different players as far as
  // this game is concerned: different g+, different salary, different age.
  const rosterOf = (spin) => {
    if (!spin) return null;
    if (!spin.byId) spin.byId = new Map(spin.roster.map((p) => [p.id, p]));
    return spin.byId;
  };
  const boardOf = (pick) => (
    pick.board_key ? byKey.get(pick.board_key) : boards[pick.round]
  );

  const squads = new Map();
  for (const m of members) squads.set(m.seat, makeSquad(m.formation || '4-3-3'));

  const taken = new Set();
  const bySeat = new Map(members.map((m) => [m.seat, []]));

  for (const pick of room.picks || []) {
    const squad = squads.get(pick.seat);
    if (!squad) continue;
    if (isPass(pick.player_id)) {
      bySeat.get(pick.seat)?.push({ ...pick, player: null });
      continue;
    }
    const board = boardOf(pick);
    const player = rosterOf(board)?.get(pick.player_id);
    if (!player) continue;
    const slot = squad.find((s) => s.id === pick.slot_id);
    if (slot && !slot.player) slot.player = player;
    // Keyed by person, not by person-season: drafting 2016 Bradley takes
    // Bradley off the board for everyone, in every season.
    taken.add(player.id);
    bySeat.get(pick.seat)?.push({
      ...pick, player, slotPos: slot ? slot.pos : null, board,
    });
  }

  // A squad rearranged after the draft. Only the arrangement moved -- the same
  // players are in it -- so this is applied as a permutation over the slots
  // rather than trusted as a squad in its own right.
  for (const m of members) {
    if (!m.lineup) continue;
    const squad = squads.get(m.seat);
    const drafted = new Map(squad.filter((s) => s.player).map((s) => [s.player.id, s.player]));
    const wanted = Object.entries(m.lineup)
      .filter(([slotId, pid]) => squad.some((s) => s.id === slotId) && drafted.has(pid));
    // Every drafted player must still appear exactly once, or the arrangement
    // is ignored and the drafted one stands.
    const ids = wanted.map(([, pid]) => pid);
    if (ids.length !== drafted.size || new Set(ids).size !== ids.length) continue;
    for (const slot of squad) slot.player = null;
    for (const [slotId, pid] of wanted) {
      const slot = squad.find((s) => s.id === slotId);
      slot.player = drafted.get(pid);
    }
  }

  const seen = new Set(room.boards || []);
  for (const pick of room.picks || []) if (pick.board_key) seen.add(pick.board_key);

  const seats = members.length;
  const pickNo = room.pick_no || 0;
  const round = seats ? roundOf(pickNo, seats) : 0;
  return {
    members,
    seen,
    seats,
    boards,
    squads,
    taken,
    bySeat,
    pickNo,
    round,
    order: draftOrder(room),
    roundSeats: seats ? roundOrder(room, round) : [],
    onClock: seats ? seatAt(room, pickNo) : 0,
    rules,
  };
}

// ------------------------------------------------------- board feasibility

/**
 * Can every seat still to pick this round come away with someone?
 *
 * This is a distinct-representatives problem, not a count: eight seats and
 * twenty legal players still deadlock if all eight only have the one
 * goalkeeper left. Kuhn's algorithm answers it exactly, and at eight seats
 * the cost is nothing.
 */
export function boardFeasible(roster, seatsToPick, squads, taken, rules) {
  const options = seatsToPick.map((seat) => {
    const squad = squads.get(seat);
    return roster.filter((p) => blockReason(p, squad, taken, rules) === null);
  });
  if (options.some((o) => o.length === 0)) return false;

  const assigned = new Map(); // player id -> seat index
  const tryAssign = (i, seen) => {
    for (const p of options[i]) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      const holder = assigned.get(p.id);
      if (holder === undefined || tryAssign(holder, seen)) {
        assigned.set(p.id, i);
        return true;
      }
    }
    return false;
  };

  for (let i = 0; i < options.length; i++) {
    if (!tryAssign(i, new Set())) return false;
  }
  return true;
}

/**
 * Choose the club-season for a round.
 *
 * Deterministic given the room: same seed, same picks, same answer on every
 * client. The server takes the first proposal it is offered anyway, so this
 * only has to be *good* -- but being deterministic too means an honest room
 * never even races.
 *
 * Boards are drawn until one is feasible for everyone picking this round.
 * A club-season is never repeated, so nobody drafts the same team twice.
 */
export function proposeBoard(pool, state, round, seed) {
  const { squads, taken, rules } = state;
  const used = new Set(state.boards.filter(Boolean).map(spinKey));
  const order = state.roundSeats;
  const rng = makeRng((seed ^ (round * 0x9e3779b1)) >>> 0);

  const fresh = pool.spins.filter((s) => !used.has(spinKey(s)));
  const candidates = fresh.length ? fresh : pool.spins;

  // Sample first -- with a few hundred boards in the pool this lands on a
  // feasible one almost immediately.
  for (let i = 0; i < 300; i++) {
    const spin = candidates[Math.floor(rng() * candidates.length)];
    if (boardFeasible(spin.roster, order, squads, taken, rules)) return spin;
  }
  // Then be exhaustive rather than give up, in that order, because scanning
  // every roster against every seat is the expensive path.
  for (const spin of candidates) {
    if (boardFeasible(spin.roster, order, squads, taken, rules)) return spin;
  }
  // Nothing serves everyone. Take whatever serves the most; the seats it
  // cannot serve will pass, exactly as a dead daily board is skipped.
  let best = candidates[0];
  let bestCount = -1;
  for (const spin of candidates) {
    let n = 0;
    for (const seat of order) {
      if (spin.roster.some((p) => blockReason(p, squads.get(seat), taken, rules) === null)) n++;
    }
    if (n > bestCount) { best = spin; bestCount = n; }
  }
  return best;
}

// ------------------------------------------------------------- picking

/** Every legal (player, slot) pair for a seat on this board. */
export function legalMoves(board, squad, taken, rules) {
  const out = [];
  if (!board) return out;
  for (const p of board.roster) {
    if (blockReason(p, squad, taken, rules) !== null) continue;
    for (const o of openSlotsFor(p, squad)) {
      out.push({ player: p, slot: o.slot, penalty: o.penalty, value: effectiveScore(p, o.slot.pos) * weightOf(o.slot) });
    }
  }
  return out;
}

/**
 * The pick a seat would make if it were not paying attention.
 *
 * Used when a clock expires, and by the sanity test's bots. Highest weighted
 * g+ available, which is a decent pick rather than an optimal one -- it takes
 * no view on what the remaining rounds might offer.
 */
export function bestMove(board, squad, taken, rules) {
  const moves = legalMoves(board, squad, taken, rules);
  if (!moves.length) return null;
  return moves.reduce((a, b) => (b.value > a.value ? b : a));
}

/**
 * A board drawn for one seat alone.
 *
 * The shared board is chosen to leave every seat something to take, but in
 * hard mode that is not always possible: a cap-tight squad can need a cheap
 * player at one specific position and watch the last affordable one go to
 * somebody else. Rather than make that seat forfeit a pick -- which would
 * decide a room on a scheduling accident -- it draws a replacement of its own.
 *
 * Deterministic from the seed and the pick number, so every client renders the
 * same replacement, and stored on the pick so it stays settled afterwards.
 */
export function personalBoard(pool, state, seed) {
  const squad = state.squads.get(state.onClock);
  const rng = makeRng((seed ^ (state.pickNo * 0x85ebca6b)) >>> 0);
  const { spin } = drawSpin(pool, squad, state.taken, rng, state.rules, state.seen);
  return spin;
}

/**
 * The board this pick is actually made from: the round's shared board when it
 * still offers this seat something, otherwise a replacement.
 */
export function boardForPick(pool, state, seed) {
  const shared = state.boards[state.round];
  const squad = state.squads.get(state.onClock);
  if (shared && bestMove(shared, squad, state.taken, state.rules)) {
    return { board: shared, personal: false };
  }
  return { board: personalBoard(pool, state, seed), personal: true };
}

/** The payload for a pick, including the pass case when nothing is legal. */
export function pickPayload(code, state, board, personal = false) {
  const seat = state.onClock;
  const squad = state.squads.get(seat);
  const move = bestMove(board, squad, state.taken, state.rules);
  if (move) {
    return {
      code, pick_no: state.pickNo, player_id: move.player.id, slot_id: move.slot.id,
      board_key: personal && board ? spinKey(board) : null,
    };
  }
  // Nothing legal anywhere: burn the pick number so the snake stays in step.
  // With replacement boards this should be unreachable; it stays as a backstop
  // so an unforeseen dead end costs one slot rather than freezing the room.
  const open = squad.find((s) => !s.player);
  return {
    code, pick_no: state.pickNo, player_id: passId(state.pickNo),
    slot_id: open ? open.id : 'none', board_key: null,
  };
}

// -------------------------------------------------------------- coaches

/**
 * Three candidates per seat, drawn from the room's seed.
 *
 * Disjoint by construction -- dealt off one shuffled list -- so no two clubs
 * can appoint the same coach, and derived rather than stored so the shortlists
 * cost no extra round trip.
 */
export function coachShortlists(coaches, seats, seed) {
  const rng = makeRng((seed ^ 0x5bf03635) >>> 0);
  const deck = [...coaches];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const out = new Map();
  for (let seat = 0; seat < seats; seat++) {
    out.set(seat, deck.slice(seat * 3, seat * 3 + 3));
  }
  return out;
}

/** Has every seat filled all 14 slots? */
export const draftComplete = (room, seats) => (room.pick_no || 0) >= seats * SQUAD_SIZE;

/** Progress readout: picks made out of picks needed. */
export const draftProgress = (room, seats) => ({
  made: room.pick_no || 0,
  total: seats * SQUAD_SIZE,
});

export { countDPs };
