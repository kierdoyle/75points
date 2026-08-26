// Draft-room transport: the seven calls the client makes, and the poll loop
// that keeps a room in sync.
//
// There is no websocket. Supabase Realtime would mean shipping supabase-js for
// one subscription, and a draft only has to feel live for the handful of
// seconds around a pick -- polling get_room() covers that at a fraction of the
// bytes. The interval is adaptive (see pollInterval) so a room sitting in the
// lobby costs almost nothing while a running clock stays responsive.

import { rpc, clientId } from './supabase.js';

export const MAX_SEATS = 8;
export const ROUNDS = 14;

const call = (fn, payload) => rpc(fn, { payload });

export const createRoom = (opts) => call('create_room', { ...opts, client_id: clientId() });
export const joinRoom = (opts) => call('join_room', { ...opts, client_id: clientId() });
export const updateMember = (opts) => call('update_member', { ...opts, client_id: clientId() });
export const startDraft = (code) => call('start_draft', { code, client_id: clientId() });
export const startPlayoffs = (code) => call('start_playoffs', { code, client_id: clientId() });
export const setBoard = (code, round, spinKey) => call('set_board', { code, round, spin_key: spinKey });
export const makePick = (opts) => call('make_pick', { ...opts, client_id: clientId() });
export const fetchRoom = (code) => rpc('get_room', { p_code: code });

/**
 * Which *position* in the draft order is on the clock. Snake order, so odd
 * rounds run backwards and nobody compounds an early pick over 14 rounds.
 *
 * A position is not a seat: seats are handed out in join order, so using them
 * directly would give the host first pick of every draft. draftOrder() is the
 * shuffle in between.
 */
export function positionOnClock(pickNo, seats) {
  const round = Math.floor(pickNo / seats);
  const idx = pickNo % seats;
  return round % 2 === 0 ? idx : seats - 1 - idx;
}

export const roundOf = (pickNo, seats) => Math.floor(pickNo / seats);

/**
 * Seats in the order they draft.
 *
 * The server shuffles this when the draft starts. Rooms opened before that
 * existed, and lobbies that have not started yet, fall back to seat order.
 */
export function draftOrder(room) {
  const seats = (room.members || []).length;
  const order = room.draft_order;
  if (Array.isArray(order) && order.length === seats) return order;
  return [...Array(seats).keys()];
}

/** The seat on the clock at a given pick number. */
export function seatAt(room, pickNo) {
  const order = draftOrder(room);
  if (!order.length) return 0;
  return order[positionOnClock(pickNo, order.length)];
}

/** The seats picking in one round, in order. */
export function roundOrder(room, round) {
  const order = draftOrder(room);
  return round % 2 === 0 ? order : [...order].reverse();
}

/**
 * Seconds left on the current pick, measured against the server's clock.
 *
 * The offset matters: a device whose clock is a minute fast would otherwise
 * believe every pick had already timed out and start auto-picking for people
 * who are still deciding.
 */
export function clockLeft(room, skewMs = 0) {
  if (!room.turn_started_at) return room.pick_seconds;
  const started = Date.parse(room.turn_started_at);
  const elapsed = (Date.now() - skewMs - started) / 1000;
  return Math.max(0, room.pick_seconds - elapsed);
}

/** How far this device's clock is ahead of the server's, in milliseconds. */
export const clockSkew = (room, receivedAt = Date.now()) => (
  room.server_time ? receivedAt - Date.parse(room.server_time) : 0
);

/**
 * How long to wait before asking again.
 *
 * Waiting on someone else's pick is the only time the answer can change from
 * one second to the next, so that is the only time worth polling hard.
 */
export function pollInterval(room, isMyTurn) {
  if (!room) return 2500;
  if (room.phase === 'lobby') return 2500;
  if (room.phase === 'draft') return isMyTurn ? 6000 : 1500;
  if (room.phase === 'coach') return 2000;
  return 5000;
}

/** How slowly a backgrounded tab keeps checking in. */
export const HIDDEN_INTERVAL = 10000;

/**
 * Poll a room until stopped, calling onUpdate with each fresh state.
 *
 * Errors are swallowed and retried: a dropped request on a phone that changed
 * cell tower should show a stale board for a second, not evict someone from
 * their draft.
 *
 * A hidden tab slows down to HIDDEN_INTERVAL rather than stopping. Stopping
 * would be cheaper, but someone who switches apps mid-draft is exactly the
 * person the room is waiting on: their tab still has to notice its own clock
 * expiring and submit the auto-pick. Coming back into view polls immediately,
 * so the catch-up is instant either way.
 */
export function watchRoom(code, onUpdate, isMyTurn = () => false) {
  let stopped = false;
  let timer = null;
  let failures = 0;

  const tick = async () => {
    if (stopped) return;
    let room = null;
    try {
      const t0 = Date.now();
      room = await fetchRoom(code);
      failures = 0;
      if (room && !room.error) onUpdate(room, clockSkew(room, (t0 + Date.now()) / 2));
    } catch {
      failures++;
    }
    if (stopped) return;
    // Back off after repeated failures so a paused project or a dead network
    // is not hammered, but never so far that recovery is slow.
    const base = document.hidden ? HIDDEN_INTERVAL : pollInterval(room, isMyTurn());
    timer = setTimeout(tick, Math.min(20000, base * (failures ? 2 ** failures : 1)));
  };

  const onVisible = () => {
    if (!document.hidden && !stopped) { clearTimeout(timer); tick(); }
  };
  document.addEventListener('visibilitychange', onVisible);
  tick();

  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
