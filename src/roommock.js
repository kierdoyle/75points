// A stand-in for rooms.sql that runs in the browser.
//
// Development only: main.js never imports this, and every call site is behind
// `import.meta.env.DEV`, so Rollup drops the whole module from a production
// build. Its job is to make a draft room playable with no database at all --
// open the game in two tabs with ?client=a and ?client=b and they draft
// against each other through localStorage.
//
// It mirrors the SQL's rules rather than approximating them: snake turn order
// from pick_no, one claim per player, first-write-wins on boards, and the same
// error strings. If the mock lets something through that the database would
// reject, this file is wrong.

const DB_KEY = 'r75:mockdb';
const ALPHA = 'ABCDEFGHJKLMNPRSTVWXYZ';
const MAX_SEATS = 8;
const ROUNDS = 14;

const load = () => { try { return JSON.parse(localStorage.getItem(DB_KEY) || '{}'); } catch { return {}; } };
const save = (db) => localStorage.setItem(DB_KEY, JSON.stringify(db));

const seatOnClock = (pickNo, seats) => (Math.floor(pickNo / seats) % 2 === 0
  ? pickNo % seats
  : seats - 1 - (pickNo % seats));

function view(room) {
  if (!room) return { error: 'not_found' };
  return {
    ...room,
    server_time: new Date().toISOString(),
    members: [...room.members].sort((a, b) => a.seat - b.seat),
    picks: [...room.picks].sort((a, b) => a.pick_no - b.pick_no),
  };
}

const handlers = {
  create_room({ payload }) {
    const db = load();
    let code = '';
    do {
      code = Array.from({ length: 4 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');
    } while (db[code]);
    db[code] = {
      code,
      host_client: payload.client_id,
      league: payload.league || 'mls',
      difficulty: payload.difficulty || 'normal',
      seed: payload.seed ?? Math.floor(Math.random() * 2147483647),
      phase: 'lobby',
      pick_no: 0,
      boards: [],
      pick_seconds: payload.pick_seconds || 60,
      data_version: payload.data_version || null,
      turn_started_at: null,
      members: [{
        seat: 0, client_id: payload.client_id, name: (payload.name || 'Host').slice(0, 20),
        formation: payload.formation || null, conference: payload.conference || null,
        coach_id: null, ready: false,
      }],
      picks: [],
    };
    save(db);
    return view(db[code]);
  },

  join_room({ payload }) {
    const db = load();
    const room = db[(payload.code || '').toUpperCase()];
    if (!room) return { error: 'not_found' };
    if (room.members.some((m) => m.client_id === payload.client_id)) return view(room);
    if (room.phase !== 'lobby') return { error: 'in_progress' };
    if (room.members.length >= MAX_SEATS) return { error: 'full' };
    const taken = new Set(room.members.map((m) => m.seat));
    const seat = [...Array(MAX_SEATS).keys()].find((s) => !taken.has(s));
    room.members.push({
      seat, client_id: payload.client_id, name: (payload.name || 'Player').slice(0, 20),
      formation: payload.formation || null, conference: payload.conference || null,
      coach_id: null, ready: false,
    });
    save(db);
    return view(room);
  },

  update_member({ payload }) {
    const db = load();
    const room = db[(payload.code || '').toUpperCase()];
    if (!room) return { error: 'not_found' };
    const m = room.members.find((x) => x.client_id === payload.client_id);
    if (!m) return { error: 'not_seated' };
    for (const k of ['name', 'formation', 'conference', 'coach_id']) {
      if (payload[k] != null) m[k] = payload[k];
    }
    if (payload.ready != null) m.ready = payload.ready;
    if (room.phase === 'coach' && room.members.every((x) => x.ready)) room.phase = 'season';
    save(db);
    return view(room);
  },

  start_draft({ payload }) {
    const db = load();
    const room = db[(payload.code || '').toUpperCase()];
    if (!room) return { error: 'not_found' };
    if (room.host_client !== payload.client_id) return { error: 'not_host' };
    if (room.phase !== 'lobby') return view(room);
    if (room.members.some((m) => !m.formation)) return { error: 'not_everyone_ready' };
    room.phase = 'draft';
    room.turn_started_at = new Date().toISOString();
    save(db);
    return view(room);
  },

  set_board({ payload }) {
    const db = load();
    const room = db[(payload.code || '').toUpperCase()];
    if (!room) return { error: 'not_found' };
    if (room.phase === 'draft' && room.boards.length === payload.round) {
      room.boards.push(payload.spin_key);
      save(db);
    }
    return view(room);
  },

  make_pick({ payload }) {
    const db = load();
    const room = db[(payload.code || '').toUpperCase()];
    if (!room) return { error: 'not_found' };
    if (room.phase !== 'draft') return { error: 'not_drafting' };
    if (payload.pick_no != null && payload.pick_no !== room.pick_no) return view(room);

    const seats = room.members.length;
    const seat = seatOnClock(room.pick_no, seats);
    const owner = room.members.find((m) => m.seat === seat);
    const expired = room.turn_started_at
      && Date.now() > Date.parse(room.turn_started_at) + room.pick_seconds * 1000;
    if (owner.client_id !== payload.client_id && !expired) return { error: 'not_your_turn' };

    // The unique indexes, by hand.
    if (room.picks.some((p) => p.player_id === payload.player_id)) return view(room);
    if (room.picks.some((p) => p.seat === seat && p.slot_id === payload.slot_id)) return view(room);

    room.picks.push({
      pick_no: room.pick_no, round: Math.floor(room.pick_no / seats), seat,
      player_id: payload.player_id, slot_id: payload.slot_id,
      auto: owner.client_id !== payload.client_id, board_key: payload.board_key || null,
    });
    room.pick_no++;
    room.turn_started_at = new Date().toISOString();
    if (room.pick_no >= seats * ROUNDS) room.phase = 'coach';
    save(db);
    return view(room);
  },

  get_room(body) {
    return view(load()[(body.p_code || '').toUpperCase()]);
  },
};

/** True when the dev mock should stand in for the database. */
export const mockEnabled = () => {
  try {
    return new URLSearchParams(window.location.search).has('mock')
      || localStorage.getItem('r75:mock') === '1';
  } catch { return false; }
};

export async function mockRpc(fn, body) {
  const h = handlers[fn];
  if (!h) throw new Error(`mock: no such function ${fn}`);
  // A touch of latency, so the UI is exercised the way a real round trip
  // exercises it rather than resolving inside the same tick.
  await new Promise((r) => setTimeout(r, 40));
  return h(body);
}
