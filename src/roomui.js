// Draft rooms: lobby, shared board, coach, and the room's season.
//
// The room is never edited locally. Every action posts to the database and the
// screen re-renders from whatever comes back, so a client that missed a poll,
// slept in a background tab, or reloaded mid-draft converges on the same room
// as everyone else without any reconciliation logic. The one thing kept on
// this side is the countdown, and even that is measured against the server's
// clock (see clockLeft) rather than the device's.

import {
  SQUAD_SIZE, SLOT_LABEL, FORMATIONS, DIFFICULTIES, rulesFor, countDPs,
  openSlotsFor, effectiveScore, blockReason, budget, SALARY_CAP,
} from './rules.js';
import { makeRng, spinKey, currentRosters, annotate } from './pool.js';
import { LEAGUE, squadStrength } from './sim.js';
import { simRoom, roomLeaderboard } from './roomsim.js';
import {
  MAX_SEATS, createRoom, joinRoom, updateMember, startDraft, setBoard, makePick,
  watchRoom, clockLeft, roundOrder,
} from './room.js';
import {
  replay, proposeBoard, boardForPick, bestMove, coachShortlists,
} from './roomdraft.js';
import { clientId } from './supabase.js';
import {
  app, render, toast, on, esc, wait, initials, shortName, avatar, mountAvatars,
  playerRow, pitchSlot, coachCard, BADGE, HEAD, gplus, moneyShort,
} from './ui.js';

// Everything the room flow needs from the game shell, handed in rather than
// imported, so main.js keeps ownership of loading and configuring a league.
let ctx = null;

const R = {
  code: null, room: null, skew: 0, stop: null, rules: null, state: null,
  tab: 'board', sim: null, speed: 1, skip: false, ticking: false,
  // Set while a pick or a board proposal is in flight, so a double tap cannot
  // send two.
  busy: false, lastRendered: null,
};

const me = () => clientId();
const myMember = () => (R.room?.members || []).find((m) => m.client_id === me()) || null;
const mySeat = () => myMember()?.seat ?? null;
const isHost = () => R.room && R.room.host_client === me();
const seats = () => (R.room?.members || []).length;
const isMyTurn = () => R.room?.phase === 'draft' && R.state && R.state.onClock === mySeat();
const hiddenRatings = () => !!(R.rules && R.rules.hideRatings) && R.room?.phase !== 'season';

const CODE_KEY = 'r75:room';
const rememberCode = (code) => { try { localStorage.setItem(CODE_KEY, code || ''); } catch { /* private */ } };
const lastCode = () => { try { return localStorage.getItem(CODE_KEY) || ''; } catch { return ''; } };
const NAME_KEY = 'r75:name';
const myName = () => { try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; } };
const saveName = (n) => { try { localStorage.setItem(NAME_KEY, n); } catch { /* private */ } };

// ---------------------------------------------------------------- entry

/** The multiplayer card on the setup screen. */
export function roomCard() {
  return `
    <div class="card room-card">
      <div class="between">
        <div><div class="eyebrow">Draft with friends</div>
          <b style="font-size:14px">Up to ${MAX_SEATS} in a room</b></div>
        <span class="pill">New</span>
      </div>
      <p class="dim" style="font-size:11.5px;margin:8px 0 10px">
        One shared board each round, snake order. Take a player and he is gone
        from everyone else's squad. All your clubs then play the same season.</p>
      <div class="opts two" style="margin-top:2px">
        <button class="opt room-go" data-mode="create"><b>Create room</b><span>You pick the rules</span></button>
        <button class="opt room-go" data-mode="join"><b>Join room</b><span>With a 4-letter code</span></button>
      </div>
    </div>`;
}

/**
 * Rejoin the room this device was last in, if it is still running.
 *
 * Phones reload, tabs get closed, someone taps the wrong thing. A draft that
 * could not be re-entered would strand the whole room behind a seat that can
 * never pick again, so this runs on boot and is why join_room re-seats a
 * client it already knows rather than refusing it.
 */
export async function resumeRoom(shell) {
  const code = hashCode() || lastCode();
  if (!code) return false;
  ctx = shell;
  try {
    const room = await joinRoom({ code, name: myName() || 'Player' });
    if (room.error || !(room.members || []).some((m) => m.client_id === me())) {
      if (room.error === 'not_found' || room.error === 'expired') rememberCode('');
      return false;
    }
    await ctx.loadLeague(room.league);
    enterRoom(room);
    return true;
  } catch {
    return false;
  }
}

/** Called from the setup screen. `mode` is 'create' or 'join'. */
export function roomEntry(mode, shell) {
  ctx = shell;
  R.code = null;
  R.room = null;
  if (R.stop) { R.stop(); R.stop = null; }
  if (mode === 'join') joinScreen(); else createScreen();
}

const leaveRoom = () => {
  if (R.stop) { R.stop(); R.stop = null; }
  R.code = null;
  R.room = null;
  R.sim = null;
  rememberCode('');
  ctx.back();
};

// ---------------------------------------------------------------- create

const CREATE = { league: 'mls', difficulty: 'normal', formation: '4-3-3', conference: 'East', seconds: 60 };

function createScreen() {
  CREATE.league = ctx.state.league;
  render(`
    <div class="between" style="margin-bottom:12px">
      <div><div class="eyebrow">Draft with friends</div>
        <h2 style="font-size:20px">Create a room</h2></div>
      <button class="btn ghost sm" id="back">Back</button>
    </div>
    <div class="stack">
      <div class="card">
        <div class="eyebrow">Your name</div>
        <input type="text" id="pname" maxlength="20" placeholder="Your name" value="${esc(myName())}" />
      </div>
      <div class="card">
        <div class="eyebrow">League</div>
        <div class="opts two" style="margin-top:8px" data-group="league">
          ${Object.values(ctx.leagues).map((l) => `
            <button class="opt" data-val="${l.key}" aria-pressed="${CREATE.league === l.key}">
              <b>${l.label}</b><span>${l.key === 'mls' ? 'Two conferences' : 'Single table'}</span>
            </button>`).join('')}
        </div>
      </div>
      <div class="card">
        <div class="eyebrow">Difficulty</div>
        <div class="opts" style="margin-top:8px" data-group="difficulty">
          ${Object.keys(DIFFICULTIES).map((k) => {
    const d = rulesFor(k, CREATE.league);
    return `<button class="opt" data-val="${k}" aria-pressed="${CREATE.difficulty === k}">
              <b>${d.label}</b><span>${esc(d.note)}</span></button>`;
  }).join('')}
        </div>
        <p class="dim" style="font-size:11px;margin-top:8px">
          Rerolls do not apply in a room — the board is shared, so there is
          nothing to reroll. Difficulty sets the DP limit and the salary cap.</p>
      </div>
      <div class="card">
        <div class="eyebrow">Seconds per pick</div>
        <div class="opts" style="margin-top:8px" data-group="seconds">
          ${[30, 60, 120].map((s) => `
            <button class="opt" data-val="${s}" aria-pressed="${CREATE.seconds === s}">
              <b>${s}s</b><span>${s === 30 ? 'Brisk' : s === 60 ? 'Standard' : 'Relaxed'}</span>
            </button>`).join('')}
        </div>
        <p class="dim" style="font-size:11px;margin-top:8px">
          Run out of time and the best player left on the board is taken for you.</p>
      </div>
      <button class="btn" id="make">Create room →</button>
    </div>`);

  on('#back', 'click', () => ctx.back());
  on('[data-group] .opt', 'click', async (e) => {
    const btn = e.currentTarget;
    const group = btn.closest('[data-group]').dataset.group;
    CREATE[group] = group === 'seconds' ? Number(btn.dataset.val) : btn.dataset.val;
    if (group === 'league') { await ctx.loadLeague(CREATE.league); createScreen(); return; }
    btn.closest('[data-group]').querySelectorAll('.opt')
      .forEach((o) => o.setAttribute('aria-pressed', String(o === btn)));
  });
  on('#make', 'click', async (e) => {
    const name = (document.getElementById('pname').value || '').trim() || 'Host';
    saveName(name);
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = 'Creating…';
    try {
      await ctx.loadLeague(CREATE.league);
      const room = await createRoom({
        name,
        league: CREATE.league,
        difficulty: CREATE.difficulty,
        pick_seconds: CREATE.seconds,
        formation: CREATE.formation,
        conference: LEAGUE.conferences ? CREATE.conference : 'League',
        data_version: ctx.dataVersion(CREATE.league),
      });
      enterRoom(room);
    } catch (err) {
      toast('Could not create the room');
      createScreen();
    }
  });
}

// ---------------------------------------------------------------- join

const hashCode = () => (/^#room=([A-Za-z]{4})$/.exec(window.location.hash || '') || [])[1] || '';

function joinScreen(prefill = '') {
  render(`
    <div class="between" style="margin-bottom:12px">
      <div><div class="eyebrow">Draft with friends</div>
        <h2 style="font-size:20px">Join a room</h2></div>
      <button class="btn ghost sm" id="back">Back</button>
    </div>
    <div class="stack">
      <div class="card">
        <div class="eyebrow">Room code</div>
        <input type="text" id="code" maxlength="4" autocapitalize="characters"
               autocomplete="off" spellcheck="false" class="codein"
               placeholder="ABCD" value="${esc(prefill || hashCode() || lastCode())}" />
      </div>
      <div class="card">
        <div class="eyebrow">Your name</div>
        <input type="text" id="pname" maxlength="20" placeholder="Your name" value="${esc(myName())}" />
      </div>
      <button class="btn" id="go">Join →</button>
    </div>`);

  on('#back', 'click', () => ctx.back());
  on('#code', 'input', (e) => {
    e.currentTarget.value = e.currentTarget.value.toUpperCase().replace(/[^A-Z]/g, '');
  });
  on('#go', 'click', async (e) => {
    const code = (document.getElementById('code').value || '').trim().toUpperCase();
    const name = (document.getElementById('pname').value || '').trim() || 'Player';
    if (code.length !== 4) { toast('A room code is four letters'); return; }
    saveName(name);
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Joining…';
    try {
      // The room decides the league, so its data has to be loaded before the
      // draft can be rendered -- but which league that is only comes back with
      // the room itself. Join first, then load, then enter.
      const room = await joinRoom({ code, name, formation: '4-3-3' });
      if (room.error) {
        toast({
          not_found: 'No room with that code',
          full: 'That room is full',
          in_progress: 'That draft has already started',
          expired: 'That room has expired',
          version_mismatch: 'That room is on an older version of the game',
        }[room.error] || 'Could not join');
        joinScreen(code);
        return;
      }
      await ctx.loadLeague(room.league);
      enterRoom(room);
    } catch {
      toast('Could not reach the room');
      joinScreen(code);
    }
  });
}

// ---------------------------------------------------------------- sync

/** Adopt a room payload and start polling it. */
function enterRoom(room) {
  R.code = room.code;
  R.room = room;
  R.rules = rulesFor(room.difficulty, room.league);
  rememberCode(room.code);
  if (R.stop) R.stop();
  R.stop = watchRoom(room.code, onRoom, isMyTurn);
  onRoom(room, 0);
}

/**
 * A fresh room from the server.
 *
 * Rendering is keyed on a signature rather than done on every poll: a redraw
 * mid-draft would lose an open pick sheet and fight the countdown, and most
 * polls change nothing.
 */
function onRoom(room, skew) {
  if (!R.code || room.code !== R.code) return;
  R.room = room;
  R.skew = skew || 0;
  R.rules = rulesFor(room.difficulty, room.league);
  R.state = replay(room, ctx.state.pool, R.rules);

  const sig = [room.phase, room.pick_no, room.boards.length, room.members.length,
    room.members.map((m) => `${m.seat}${m.formation || ''}${m.conference || ''}${m.ready ? 1 : 0}`).join(),
  ].join('|');
  const changed = sig !== R.lastRendered;
  R.lastRendered = sig;

  if (room.phase === 'draft') ensureBoard();
  if (room.phase === 'draft') maybeAutoPick();

  if (!changed) return;
  if (room.phase === 'lobby') lobbyScreen();
  else if (room.phase === 'draft') draftScreen();
  else if (room.phase === 'coach') coachScreen();
  else if (room.phase === 'season' && !R.ticking) seasonScreen();
}

/**
 * Make sure the round has a board.
 *
 * The client on the clock proposes immediately because it is the one being
 * held up; everyone else waits a beat and then proposes too, so a room is
 * never stuck behind one person's dead laptop. The proposal is deterministic,
 * so these all agree -- and the server keeps the first one regardless.
 */
async function ensureBoard() {
  const room = R.room;
  const round = R.state.round;
  if (room.boards.length > round || R.busy) return;
  const mine = R.state.onClock === mySeat();
  if (!mine && clockLeft(room, R.skew) > room.pick_seconds - 3) return;
  R.busy = true;
  try {
    const spin = proposeBoard(ctx.state.pool, R.state, round, Number(room.seed));
    if (spin) onRoom(await setBoard(room.code, round, spinKey(spin)), R.skew);
  } catch { /* a later poll will try again */ } finally { R.busy = false; }
}

/**
 * Take the pick for a seat whose clock has run out.
 *
 * The seat itself submits the moment its own clock hits zero. Everyone else
 * waits three more seconds before stepping in, which is what covers a player
 * who has closed the tab without four clients racing to cover them.
 */
async function maybeAutoPick() {
  const room = R.room;
  if (R.busy || !room.turn_started_at) return;
  const left = clockLeft(room, R.skew);
  const mine = R.state.onClock === mySeat();
  if (left > 0 || (!mine && left > -3)) return;
  const board = R.state.boards[R.state.round];
  if (!board) return;
  R.busy = true;
  try {
    const { board: use, personal } = boardForPick(ctx.state.pool, R.state, Number(room.seed));
    const move = bestMove(use, R.state.squads.get(R.state.onClock), R.state.taken, R.rules);
    if (!move) return;
    const next = await makePick({
      code: room.code, pick_no: room.pick_no,
      player_id: move.player.id, slot_id: move.slot.id,
      board_key: personal ? spinKey(use) : null,
    });
    onRoom(next, R.skew);
  } catch { /* the next poll retries */ } finally { R.busy = false; }
}

// ---------------------------------------------------------------- lobby

function lobbyScreen() {
  const room = R.room;
  const mine = myMember();
  const conf = LEAGUE.conferences;
  // Which conferences exist only becomes known once the room's league has
  // loaded, so a seat's default is filled in here rather than at join time.
  if (mine && !mine.conference) {
    updateMember({ code: room.code, conference: conf ? 'East' : 'League' })
      .then((r) => onRoom(r, R.skew)).catch(() => {});
  }
  render(`
    <div class="between" style="margin-bottom:10px">
      <div><div class="eyebrow">${esc(ctx.leagues[room.league].label)} · ${esc(DIFFICULTIES[room.difficulty].label)}</div>
        <h2 style="font-size:20px">Room lobby</h2></div>
      <button class="btn ghost sm" id="leave">Leave</button>
    </div>

    <div class="card roomcode">
      <div class="eyebrow">Room code</div>
      <div class="codebig mono">${esc(room.code)}</div>
      <p class="dim" style="font-size:11.5px">Friends join with this code${navigator.share ? ' — or send them the link' : ''}.</p>
      <div class="opts two" style="margin-top:10px">
        <button class="opt" id="copycode"><b>Copy code</b></button>
        <button class="opt" id="copylink"><b>Copy link</b></button>
      </div>
    </div>

    <div class="card" style="margin-top:12px">
      <div class="between" style="margin-bottom:8px">
        <div class="eyebrow">In the room · ${room.members.length}/${MAX_SEATS}</div>
        <span class="dim" style="font-size:11px">${room.members.length < 2 ? 'Waiting for one more' : 'Ready when you are'}</span>
      </div>
      <div class="seats">
        ${room.members.map((m) => `
          <div class="seatrow ${m.client_id === me() ? 'you' : ''}">
            <span class="seatno">${m.seat + 1}</span>
            <span class="seatname">${esc(m.name)}${m.client_id === room.host_client ? ' <span class="pill">host</span>' : ''}</span>
            <span class="dim" style="font-size:11px">${esc(m.formation || '—')}${conf && m.conference ? ` · ${esc(m.conference)}` : ''}</span>
          </div>`).join('')}
      </div>
    </div>

    <div class="card" style="margin-top:12px">
      <div class="eyebrow">Your formation</div>
      <div class="opts" style="margin-top:8px" data-group="formation">
        ${Object.keys(FORMATIONS).map((f) => `
          <button class="opt" data-val="${f}" aria-pressed="${mine?.formation === f}"><b>${f}</b></button>`).join('')}
      </div>
    </div>

    ${conf ? `<div class="card" style="margin-top:12px">
      <div class="eyebrow">Your conference</div>
      <div class="opts two" style="margin-top:8px" data-group="conference">
        ${['East', 'West'].map((c) => `
          <button class="opt" data-val="${c}" aria-pressed="${mine?.conference === c}"><b>${c}</b></button>`).join('')}
      </div>
      <p class="dim" style="font-size:11px;margin-top:8px">
        Everyone in the room plays the same season. Conference rivals meet twice.</p>
    </div>` : ''}

    ${isHost() ? `<button class="btn" id="start" style="margin-top:14px"
        ${room.members.length < 2 ? 'disabled' : ''}>
        ${room.members.length < 2 ? 'Waiting for another drafter…' : `Start the draft (${room.members.length}) →`}
      </button>`
    : `<div class="card center" style="margin-top:14px">
        <b style="font-size:13px">Waiting for the host to start</b>
        <p class="dim" style="font-size:11.5px;margin-top:4px">Pick your formation while you wait.</p>
      </div>`}
    <p class="dim center" style="font-size:11px;margin-top:10px">
      14 rounds · one shared club-season a round · ${room.pick_seconds}s a pick</p>`);

  on('#leave', 'click', leaveRoom);
  on('#copycode', 'click', () => copy(room.code, 'Code copied'));
  on('#copylink', 'click', () => copy(roomLink(room.code), 'Link copied'));
  on('[data-group] .opt', 'click', async (e) => {
    const btn = e.currentTarget;
    const group = btn.closest('[data-group]').dataset.group;
    btn.closest('[data-group]').querySelectorAll('.opt')
      .forEach((o) => o.setAttribute('aria-pressed', String(o === btn)));
    try {
      onRoom(await updateMember({ code: room.code, [group]: btn.dataset.val }), R.skew);
    } catch { toast('Could not save that'); }
  });
  on('#start', 'click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      const next = await startDraft(room.code);
      if (next.error === 'not_everyone_ready') { toast('Everyone needs a formation first'); return; }
      onRoom(next, R.skew);
    } catch { toast('Could not start'); }
  });
}

const roomLink = (code) => `${window.location.origin}${window.location.pathname}#room=${code}`;

async function copy(text, msg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast(msg);
  }
}

// ---------------------------------------------------------------- draft

function draftScreen() {
  const room = R.room;
  const st = R.state;
  const seat = mySeat();
  const squad = st.squads.get(seat);
  const board = st.boards[st.round];
  const onClockMember = st.members.find((m) => m.seat === st.onClock);
  const dps = countDPs(squad);
  const maxDPs = R.rules.maxDPs;

  render(`
    <div class="topbar">
      <div class="stat"><b>${st.round + 1}<span class="frac">/${SQUAD_SIZE}</span></b><span>Round</span></div>
      <div class="stat"><b>${squad.filter((s) => s.player).length}<span class="frac">/${SQUAD_SIZE}</span></b><span>Your squad</span></div>
      <div class="stat"><b class="mono" id="clock">${Math.ceil(clockLeft(room, R.skew))}</b><span>Seconds</span></div>
      <div class="stat"><b style="color:${dps >= maxDPs ? 'var(--dp)' : 'var(--text)'}">${dps}<span class="frac">/${maxDPs === Infinity ? '∞' : maxDPs}</span></b><span>DPs</span></div>
    </div>

    <div class="turnbar ${isMyTurn() ? 'mine' : ''}" id="turnbar">
      <div class="clockbar"><i id="clockfill" style="width:0%"></i></div>
      <div class="between" style="padding:8px 10px">
        <b style="font-size:13px">${isMyTurn() ? 'You are on the clock' : `${esc(onClockMember?.name || '—')} is picking`}</b>
        <span class="dim" style="font-size:11px">${orderStrip()}</span>
      </div>
    </div>

    ${R.rules.salaryCap ? capBar(squad) : ''}

    <div class="opts three" style="margin:12px 0" data-group="tab">
      <button class="opt" data-val="board" aria-pressed="${R.tab === 'board'}"><b>Board</b></button>
      <button class="opt" data-val="squad" aria-pressed="${R.tab === 'squad'}"><b>Your squad</b></button>
      <button class="opt" data-val="room" aria-pressed="${R.tab === 'room'}"><b>Room</b></button>
    </div>
    <div id="pane">${
  R.tab === 'board' ? boardPane(board, squad)
    : R.tab === 'squad' ? squadPane(squad)
      : roomPane()}</div>`);

  on('[data-group="tab"] .opt', 'click', (e) => {
    R.tab = e.currentTarget.dataset.val;
    draftScreen();
  });
  if (R.tab === 'board') bindBoard(board, squad);
  tickClock();
}

/** Who picks next, in this round's order. */
function orderStrip() {
  const st = R.state;
  const order = roundOrder(st.round, st.seats);
  const idx = order.indexOf(st.onClock);
  return order.map((s, i) => {
    const m = st.members.find((x) => x.seat === s);
    const initial = esc((m?.name || '?').slice(0, 1).toUpperCase());
    const cls = i === idx ? 'now' : i < idx ? 'done' : '';
    return `<span class="ordot ${cls}">${initial}</span>`;
  }).join('');
}

function boardPane(board, squad) {
  if (!board) {
    return '<div class="card center"><b style="font-size:13px">Drawing the next club…</b></div>';
  }
  const roster = annotate(board.roster, squad, R.state.taken, R.rules);
  const order = ['GK', 'CB', 'FB', 'DM', 'CM', 'AM', 'W', 'ST'];
  const groups = order.map((pos) => [pos, roster.filter((p) => p.pos === pos)])
    .filter(([, list]) => list.length);
  const canPick = isMyTurn();

  return `
    <div class="reel">
      ${avatar(BADGE(board.teamId), board.team.abbr)}
      <div>
        <h2>${esc(board.team.name)}</h2>
        <div class="season">${board.season}${board.projected ? ' (projected)' : ''}</div>
      </div>
    </div>
    <div class="between" style="margin:14px 0 6px">
      <div class="eyebrow">${canPick ? 'Pick one player' : 'Everyone drafts from this club'}</div>
      <span class="dim" style="font-size:11.5px">${roster.filter((p) => !p.blocked).length} available to you</span>
    </div>
    <div class="roster ${canPick ? '' : 'watching'}">
      ${groups.map(([pos, list]) => `
        <div class="group-label">${pos}</div>
        ${list.map((p) => playerRow(p, { hidden: hiddenRatings(), showSalary: R.rules.salaryCap })).join('')}`).join('')}
    </div>
    ${recentPicks()}`;
}

function bindBoard(board, squad) {
  if (!isMyTurn() || !board) return;
  on('.pl[data-pid]', 'click', (e) => {
    const p = board.roster.find((x) => x.id === e.currentTarget.dataset.pid);
    if (!p || blockReason(p, squad, R.state.taken, R.rules)) return;
    pickSheet(p, openSlotsFor(p, squad), board);
  });
}

/** The last few picks, so you can see who took whom. */
function recentPicks() {
  const rows = [];
  for (const [seat, picks] of R.state.bySeat) {
    const m = R.state.members.find((x) => x.seat === seat);
    for (const p of picks) rows.push({ ...p, who: m?.name || `Seat ${seat + 1}`, seat });
  }
  rows.sort((a, b) => b.pick_no - a.pick_no);
  const recent = rows.slice(0, 6);
  if (!recent.length) return '';
  return `
    <div class="card" style="margin-top:12px">
      <div class="eyebrow" style="margin-bottom:8px">Latest picks</div>
      ${recent.map((r) => `
        <div class="pickrow">
          <span class="dim mono" style="font-size:10px">${r.pick_no + 1}</span>
          ${r.player ? avatar(HEAD(r.player.id), initials(r.player.name), 'head round tiny') : ''}
          <span class="pickname">${r.player ? esc(shortName(r.player.name)) : 'passed'}</span>
          <span class="dim" style="font-size:11px">${r.seat === mySeat() ? 'you' : esc(r.who)}</span>
          ${r.auto ? '<span class="pill">auto</span>' : ''}
          ${r.board_key ? '<span class="pill">replacement</span>' : ''}
        </div>`).join('')}
    </div>`;
}

/** Confirmation sheet, same shape as the solo game's. */
function pickSheet(player, options, board) {
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.innerHTML = `
    <div class="sheet-inner">
      <button class="sheet-x" id="x" aria-label="Cancel">✕</button>
      <div class="pickhead">
        ${avatar(HEAD(player.id), initials(player.name), 'head round')}
        <div style="min-width:0">
          <div class="cname">${esc(player.name)}</div>
          <div class="dim" style="font-size:11px">
            ${player.pos} · ${board.season}
            ${hiddenRatings() ? '' : ` · ${gplus(player.score)} g+`}
            ${R.rules.salaryCap ? ` · ${moneyShort(player.salary)}` : ''}</div>
        </div>
      </div>
      <div class="eyebrow" style="margin-top:12px">Where do they play?</div>
      <div class="slot-opts">
        ${options.map((o) => `
          <button class="opt slotopt" data-slot="${o.slot.id}">
            <b>${SLOT_LABEL[o.slot.pos]}</b>
            <span>${o.penalty ? `−${(o.penalty * 100).toFixed(0)}%` : (o.slot.starter ? 'Natural' : 'Bench')}</span>
            <i>${hiddenRatings() ? '&nbsp;' : gplus(effectiveScore(player, o.slot.pos))}</i>
          </button>`).join('')}
      </div>
      <button class="btn ghost sm" id="cancel" style="width:100%;margin-top:12px">Pick someone else</button>
    </div>`;
  document.body.appendChild(sheet);
  mountAvatars(sheet);
  const close = () => sheet.remove();
  sheet.querySelectorAll('[data-slot]').forEach((b) => b.addEventListener('click', async () => {
    close();
    await submitPick(player, b.dataset.slot, board);
  }));
  sheet.querySelector('#cancel').addEventListener('click', close);
  sheet.querySelector('#x').addEventListener('click', close);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) close(); });
}

async function submitPick(player, slotId, board) {
  if (R.busy) return;
  R.busy = true;
  try {
    const shared = R.state.boards[R.state.round];
    const personal = !shared || spinKey(shared) !== spinKey(board);
    const next = await makePick({
      code: R.code, pick_no: R.room.pick_no,
      player_id: player.id, slot_id: slotId,
      board_key: personal ? spinKey(board) : null,
    });
    if (next.error === 'not_your_turn') { toast('Not your pick'); return; }
    const got = (next.picks || []).some((p) => p.player_id === player.id && p.seat === mySeat());
    if (!got) toast('Someone took him first');
    onRoom(next, R.skew);
  } catch {
    toast('Could not send that pick');
  } finally { R.busy = false; }
}

/** The countdown, redrawn locally between polls. */
function tickClock() {
  clearInterval(R.timer);
  const paint = () => {
    const el = document.getElementById('clock');
    const fill = document.getElementById('clockfill');
    if (!el || !R.room || R.room.phase !== 'draft') { clearInterval(R.timer); return; }
    const left = clockLeft(R.room, R.skew);
    el.textContent = Math.ceil(left);
    el.style.color = left < 10 ? 'var(--red)' : '';
    if (fill) fill.style.width = `${100 - Math.min(100, (left / R.room.pick_seconds) * 100)}%`;
  };
  paint();
  R.timer = setInterval(paint, 250);
}

function capBar(squad) {
  const b = budget(squad, R.rules.allocation);
  const over = b.charge > SALARY_CAP;
  return `
    <div class="capbar">
      <div class="between" style="margin-bottom:6px">
        <div><span class="eyebrow">Salary budget</span>
          <b class="mono ${over ? 'red' : ''}" style="font-size:15px;display:block">
            $${(b.charge / 1e6).toFixed(2)}M<span class="dim" style="font-size:11px"> / $${(SALARY_CAP / 1e6).toFixed(2)}M</span></b></div>
        <div style="text-align:right"><span class="eyebrow">Allocation left</span>
          <b class="mono ${b.gamLeft < 0 ? 'red' : ''}" style="font-size:15px;display:block">$${(Math.max(0, b.gamLeft) / 1e6).toFixed(2)}M</b></div>
      </div>
      <div class="pace"><i style="width:${Math.min(100, (b.charge / SALARY_CAP) * 100)}%;background:${over ? 'var(--gold)' : 'var(--accent)'}"></i></div>
    </div>`;
}

function squadPane(squad) {
  const starters = squad.filter((s) => s.starter);
  const subs = squad.filter((s) => !s.starter);
  const { total } = squadStrength(squad);
  return `
    <div class="pitch">${starters.map((s) => pitchSlot(s, false, false, null, new Set(), hiddenRatings())).join('')}</div>
    <div class="bench">${subs.map((s) => pitchSlot(s, true, false, null, new Set(), hiddenRatings())).join('')}</div>
    <div class="between card" style="margin-top:10px">
      <div><div class="eyebrow">Squad g+</div>
        <b class="mono" style="font-size:19px">${hiddenRatings() ? '–' : (total > 0 ? '+' : '') + total.toFixed(1)}</b></div>
      <div class="dim" style="font-size:12px;text-align:right">
        ${esc(myMember()?.formation || '')} · ${squad.filter((s) => s.player).length}/${SQUAD_SIZE}<br>
        Starters 91% · subs 30%</div>
    </div>`;
}

/** Everyone else's squads, at a glance. */
function roomPane() {
  const st = R.state;
  return `<div class="stack">
    ${st.members.map((m) => {
    const squad = st.squads.get(m.seat);
    const { total } = squadStrength(squad);
    const filled = squad.filter((s) => s.player);
    return `
      <div class="card ${m.seat === mySeat() ? 'you' : ''}">
        <div class="between">
          <div><b style="font-size:14px">${esc(m.name)}${m.seat === mySeat() ? ' (you)' : ''}</b>
            <div class="dim" style="font-size:11px">${esc(m.formation || '')}${LEAGUE.conferences ? ` · ${esc(m.conference || '')}` : ''} · ${filled.length}/${SQUAD_SIZE}</div></div>
          <b class="mono" style="font-size:15px">${hiddenRatings() ? '–' : `${total > 0 ? '+' : ''}${total.toFixed(1)}`}</b>
        </div>
        <div class="minisquad">
          ${filled.slice(-8).map((s) => `
            <span class="minip" title="${esc(s.player.name)}">
              ${avatar(HEAD(s.player.id), initials(s.player.name), 'head round tiny')}
              <span>${esc(shortName(s.player.name))}</span></span>`).join('') || '<span class="dim" style="font-size:11.5px">No picks yet</span>'}
        </div>
      </div>`;
  }).join('')}
  </div>`;
}

// ---------------------------------------------------------------- coach

function coachScreen() {
  const seat = mySeat();
  const mine = myMember();
  const shortlist = coachShortlists(ctx.state.sim.coaches, R.state.seats, Number(R.room.seed)).get(seat) || [];
  const waiting = R.room.members.filter((m) => !m.ready);

  render(`
    <div style="margin-bottom:12px">
      <div class="eyebrow">Squad complete</div>
      <h2 style="font-size:20px">Appoint a head coach</h2>
      <p class="muted" style="font-size:13px;margin-top:8px">
        Three names off the touchline, yours alone — no two clubs in the room
        are offered the same coach. Ratings are career percentile ranks.</p>
    </div>
    ${mine?.ready ? `
      <div class="card center">
        <b style="font-size:14px">You are ready</b>
        <p class="dim" style="font-size:11.5px;margin-top:6px">
          ${waiting.length ? `Waiting for ${esc(waiting.map((m) => m.name).join(', '))}` : 'Kicking off…'}</p>
      </div>
      <div style="margin-top:12px">${coachCard(currentCoach(), false)}</div>`
    : `<div class="coaches">${shortlist.map((c) => coachCard(c, true)).join('')}</div>`}
    <div class="card" style="margin-top:12px">
      <div class="eyebrow" style="margin-bottom:8px">Room</div>
      ${R.room.members.map((m) => `
        <div class="pickrow">
          <span class="pickname">${esc(m.name)}${m.seat === mySeat() ? ' (you)' : ''}</span>
          <span class="dim" style="font-size:11px">${m.ready ? '✓ ready' : 'choosing…'}</span>
        </div>`).join('')}
    </div>`);

  on('[data-coach]', 'click', async (e) => {
    const id = e.currentTarget.dataset.coach;
    try {
      onRoom(await updateMember({ code: R.code, coach_id: id, ready: true }), R.skew);
    } catch { toast('Could not save that'); }
  });
}

const currentCoach = () => ctx.state.sim.coaches.find((c) => c.id === myMember()?.coach_id) || null;

// ---------------------------------------------------------------- season

/**
 * Run the room's season.
 *
 * Every client computes this locally from the shared seed and the shared
 * picks, so nothing has to be uploaded and everyone still sees the same
 * results, the same table and the same Cup.
 */
function seasonScreen() {
  R.ticking = true;
  // Everything from here is computed locally from the seed and the picks, so
  // the room no longer needs polling -- and the draft is over, so nothing can
  // change on the server anyway.
  if (R.stop) { R.stop(); R.stop = null; }
  const st = R.state;
  const members = st.members.map((m) => ({
    seat: m.seat,
    teamName: `${m.name}${/fc|united|city|sc$/i.test(m.name) ? '' : ' FC'}`,
    squad: st.squads.get(m.seat),
    conference: LEAGUE.conferences ? (m.conference || 'East') : 'League',
    coach: ctx.state.sim.coaches.find((c) => c.id === m.coach_id) || null,
  }));

  R.sim = simRoom({
    members,
    opponents: ctx.state.sim.opponents,
    rosters: ctx.state.rosters || currentRosters(ctx.state.pool),
    rng: makeRng((Number(R.room.seed) ^ 0xabcd) >>> 0),
  });

  R.speed = 1;
  R.skip = false;
  const mine = R.sim.bySeat.get(mySeat());

  render(`
    <div class="between" style="margin-bottom:10px">
      <div><div class="eyebrow">${esc(mine.club.name)}</div>
        <h2 style="font-size:20px">2026 season</h2></div>
    </div>
    <div class="card" style="margin-bottom:10px">
      <div class="between" style="margin-bottom:8px">
        <b class="mono" style="font-size:26px"><span id="pts">0</span>
          <span class="dim" style="font-size:13px">/ ${LEAGUE.target} pts</span></b>
        <div style="text-align:right"><div class="eyebrow">Pace</div>
          <b class="mono" id="pace" style="font-size:13px">—</b></div>
      </div>
      <div class="pace"><i id="bar" style="width:0%"></i><u id="tick" style="left:0%"></u></div>
    </div>
    <div class="controls">
      <button class="btn ghost sm" id="speed">▶ 1×</button>
      <button class="btn ghost sm" id="skip">Skip to end ⏭</button>
    </div>
    <div class="ticker" id="ticker"></div>`);

  on('#speed', 'click', (e) => {
    R.speed = R.speed === 1 ? 2 : R.speed === 2 ? 4 : 1;
    e.currentTarget.textContent = `▶ ${R.speed}×`;
  });
  on('#skip', 'click', () => { R.skip = true; });
  runTicker(mine);
}

async function runTicker(mine) {
  const ticker = document.getElementById('ticker');
  const ptsEl = document.getElementById('pts');
  const paceEl = document.getElementById('pace');
  const bar = document.getElementById('bar');
  const tick = document.getElementById('tick');

  for (const r of mine.results) {
    const row = document.createElement('div');
    row.innerHTML = matchCard(r);
    const card = row.firstElementChild;
    ticker.prepend(card);
    mountAvatars(card);
    ptsEl.textContent = r.pts;
    const pace = (LEAGUE.target * r.matchday) / LEAGUE.games;
    const diff = r.pts - pace;
    paceEl.textContent = `${diff >= 0 ? '+' : ''}${diff.toFixed(1)}`;
    paceEl.style.color = diff >= 0 ? 'var(--accent)' : 'var(--red)';
    bar.style.width = `${Math.min(100, (r.pts / LEAGUE.target) * 100)}%`;
    tick.style.left = `${(r.matchday / LEAGUE.games) * 100}%`;
    if (!R.skip) await wait((700 + r.scorers.length * 180) / R.speed);
  }
  await wait(500);
  resultsScreen();
}

function matchCard(r) {
  const goal = (g, ours) => `
    <div class="goal ${ours ? 'ours' : 'theirs'}">
      <span class="min">${g.minute}'</span>
      <span class="who2">${g.scorer ? esc(shortName(g.scorer)) : 'Own goal'}</span>
      ${g.assister ? `<span class="ast">${esc(shortName(g.assister))}</span>` : ''}
    </div>`;
  const all = [
    ...r.scorers.map((g) => ({ ...g, ours: true })),
    ...r.conceded.map((g) => ({ ...g, ours: false })),
  ].sort((a, b) => a.minute - b.minute);
  const derby = r.opp.isMember;
  return `
    <div class="res ${derby ? 'derby' : ''}">
      <div class="res-top">
        <div class="md">MD${r.matchday}</div>
        <div class="op">${avatar(derby ? '' : BADGE(r.opp.id), r.opp.abbr)}
          <span>${r.home ? 'vs' : '@'} ${esc(derby ? r.opp.name : r.opp.abbr)}</span></div>
        <div class="sc2 mono">${r.gf}–${r.ga}</div>
        <div class="wl ${r.result}">${r.result}</div>
      </div>
      ${all.length ? `<div class="goals">${all.map((g) => goal(g, g.ours)).join('')}</div>` : ''}
    </div>`;
}

// ---------------------------------------------------------------- results

function resultsScreen() {
  R.ticking = false;
  const board = roomLeaderboard(R.sim);
  const mine = R.sim.bySeat.get(mySeat());
  const champ = R.sim.champion;
  const winner = board[0];

  render(`
    <div class="verdict ${mine.won ? 'win' : mine.wonCup ? 'win' : 'lose'}">
      <div class="eyebrow">Room ${esc(R.code)} · 2026</div>
      <div class="big mono">${mine.points}</div>
      <h2>${mine.won ? 'IMMORTAL' : (winner.seat === mySeat() ? 'Best in the room' : `${esc(winner.club.name)} took it`)}</h2>
      <p class="muted" style="margin-top:8px;font-size:13px">
        ${mine.record.w}W–${mine.record.d}D–${mine.record.l}L ·
        ${mine.madePlayoffs ? `#${mine.seed} seed` : 'missed the playoffs'} ·
        ${mine.wonCup ? `🏆 ${esc(LEAGUE.cupName)}` : `${esc(champ.isMember ? champ.name : champ.short)} won it`}</p>
    </div>

    <div class="card" style="margin-top:12px">
      <div class="eyebrow" style="margin-bottom:8px">The room</div>
      <table class="table roomtable">
        <thead><tr><th>#</th><th>Club</th><th>g+</th><th>W-D-L</th><th>Pts</th><th></th></tr></thead>
        <tbody>
          ${board.map((r, i) => `
            <tr class="${r.seat === mySeat() ? 'you' : ''}">
              <td>${i + 1}</td>
              <td><b>${esc(r.club.name)}</b><div class="dim" style="font-size:10px">${esc(r.club.conf)}${r.coach ? ` · ${esc(r.coach.name)}` : ''}</div></td>
              <td class="mono">${r.strength > 0 ? '+' : ''}${r.strength.toFixed(1)}</td>
              <td class="mono">${r.record.w}-${r.record.d}-${r.record.l}</td>
              <td><b>${r.points}</b></td>
              <td>${r.won ? '👑' : r.wonCup ? '🏆' : r.madePlayoffs ? `#${r.seed}` : ''}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      <p class="dim" style="font-size:11px;margin-top:8px">
        👑 = ${LEAGUE.target} points and the ${esc(LEAGUE.cupName)}</p>
    </div>

    ${headToHeadCard()}
    ${bracketCard()}

    <div class="card" style="margin-top:12px">
      <div class="eyebrow" style="margin-bottom:8px">Share</div>
      <div class="share">${esc(shareText())}</div>
      <button class="btn sm" id="copy" style="width:100%;margin-top:12px">Copy result</button>
    </div>
    <div style="margin-top:12px">${squadPane(R.state.squads.get(mySeat()))}</div>
    <button class="btn ghost" id="again" style="margin-top:12px">Back to the menu</button>`);

  on('#copy', 'click', () => copy(shareText(), 'Copied!'));
  on('#again', 'click', leaveRoom);
}

/** Who beat whom, among the room. */
function headToHeadCard() {
  const rows = [];
  for (const [seat, r] of R.sim.bySeat) {
    if (seat !== mySeat()) continue;
    for (const g of r.results) {
      if (g.opp.isMember) rows.push(g);
    }
  }
  if (!rows.length) return '';
  return `
    <div class="card" style="margin-top:12px">
      <div class="eyebrow" style="margin-bottom:8px">Your games against the room</div>
      ${rows.map((g) => `
        <div class="pickrow">
          <span class="pickname">${g.home ? 'vs' : '@'} ${esc(g.opp.name)}</span>
          <b class="mono">${g.gf}–${g.ga}</b>
          <span class="wl ${g.result}">${g.result}</span>
        </div>`).join('')}
    </div>`;
}

/** The ties that had a room club in them, plus the final. */
function bracketCard() {
  const rounds = R.sim.playoffs.rounds.filter((t) => [t.high, t.low, t.host, t.away]
    .some((c) => c && c.isMember));
  const cup = R.sim.playoffs.rounds[R.sim.playoffs.rounds.length - 1];
  if (!rounds.includes(cup)) rounds.push(cup);
  if (!rounds.length) return '';
  const name = (c) => (c.isMember ? c.name : c.short);
  // The full round names crowd out the clubs on a phone, and the clubs are
  // the part worth reading.
  const shortRound = (r) => r
    .replace('Conference Semifinal', 'Conf Semi')
    .replace('Conference Final', 'Conf Final')
    .replace('Round One', 'Round 1')
    .replace('Quarterfinal', 'Quarter')
    .replace('Semifinal', 'Semi');
  return `
    <div class="card" style="margin-top:12px">
      <div class="eyebrow" style="margin-bottom:8px">Playoffs</div>
      ${rounds.map((t) => {
    const a = t.high || t.host;
    const b = t.low || t.away;
    const score = t.series ? `${t.series} series` : `${t.hg}–${t.ag}${t.pens ? ' (pens)' : ''}`;
    return `<div class="pickrow">
          <span class="dim" style="font-size:10.5px;flex:none">${esc(shortRound(t.round))}</span>
          <span class="pickname">${esc(name(t.winner))} <span class="dim">beat</span> ${esc(name(t.winner === a ? b : a))}</span>
          <span class="dim mono" style="font-size:11px">${esc(score)}</span>
        </div>`;
  }).join('')}
    </div>`;
}

function shareText() {
  const board = roomLeaderboard(R.sim);
  const mine = R.sim.bySeat.get(mySeat());
  const place = board.findIndex((r) => r.seat === mySeat()) + 1;
  const marks = mine.results.map((x) => ({ W: '🟩', D: '🟨', L: '🟥' }[x.result]));
  return [
    `Road to ${LEAGUE.target} ⚽ Room draft · ${LEAGUE.name} · ${board.length} drafters`,
    `${place}${['st', 'nd', 'rd'][place - 1] || 'th'} of ${board.length} · ${mine.points} pts`
      + (mine.wonCup ? ` · 🏆 ${LEAGUE.cupName}` : '') + (mine.won ? ' · IMMORTAL 👑' : ''),
    marks.slice(0, 17).join(''),
    marks.slice(17).join(''),
    window.location.origin + window.location.pathname,
  ].filter(Boolean).join('\n');
}
