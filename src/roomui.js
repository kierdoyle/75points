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
  openSlotsFor, effectiveScore, blockReason, budget, SALARY_CAP, swapTargets,
} from './rules.js';
import { makeRng, spinKey, currentRosters, annotate } from './pool.js';
import { LEAGUE, squadStrength } from './sim.js';
import { simRoom, roomLeaderboard } from './roomsim.js';
import { achievements } from './achievements.js';
import { buildCard } from './exportcard.js';
import {
  MAX_SEATS, createRoom, joinRoom, updateMember, startDraft, setBoard, makePick,
  watchRoom, clockLeft, startPlayoffs, draftOrder,
} from './room.js';
import {
  replay, proposeBoard, boardForPick, bestMove, coachShortlists,
} from './roomdraft.js';
import { clientId } from './supabase.js';
import {
  app, render, toast, on, esc, wait, initials, shortName, avatar, mountAvatars,
  playerRow, pitchSlot, coachCard, BADGE, HEAD, gplus, moneyShort, runReel,
  idleReel,
} from './ui.js';

// Everything the room flow needs from the game shell, handed in rather than
// imported, so main.js keeps ownership of loading and configuring a league.
let ctx = null;

const R = {
  code: null, room: null, skew: 0, stop: null, rules: null, state: null,
  tab: 'board', sim: null, speed: 1, skip: false, ticking: false,
  // Set while a pick or a board proposal is in flight, so a double tap cannot
  // send two.
  busy: false, lastRendered: null, stage: null, swapFrom: null, achievements: null,
  // The round this client has already played the reveal for. A room re-renders
  // on every pick, and the reel must not replay each time.
  reeled: -1,
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

/** The room this device was last in, if any -- offered on the setup screen. */
export const rememberedRoom = () => hashCode() || lastCode();

/**
 * A card on the setup screen offering the way back into a room.
 *
 * Deliberately an offer rather than an automatic redirect. Resuming used to
 * happen on boot, which meant anyone who had ever been in a room was thrown
 * back into it before the menu had finished painting -- with no way to reach
 * the setup screen again, and so no way to start a different room. One tap is
 * a small price for not trapping people.
 */
export function roomResumeCard() {
  const code = rememberedRoom();
  if (!code) return '';
  return `
    <div class="card room-card">
      <div class="between">
        <div><div class="eyebrow">You were drafting</div>
          <b style="font-size:14px">Room ${esc(code)}</b></div>
        <button class="btn sm" id="resume-room">Rejoin →</button>
      </div>
    </div>`;
}

/** Forget the remembered room without going near the network. */
export function forgetRoom() {
  rememberCode('');
}

/**
 * Go back into a room. Returns false if it is gone, so the caller can say so.
 */
export async function resumeRoom(shell, { quiet = true } = {}) {
  const code = rememberedRoom();
  if (!code) return false;
  ctx = shell;
  try {
    const room = await joinRoom({ code, name: myName() || 'Player' });
    if (room.error || !(room.members || []).some((m) => m.client_id === me())) {
      // A room that has expired, filled up or moved on without this device is
      // not worth remembering.
      rememberCode('');
      if (!quiet) {
        toast({
          not_found: 'That room is gone',
          expired: 'That room has expired',
          in_progress: 'That draft started without you',
          full: 'That room filled up',
        }[room.error] || 'Could not rejoin that room');
        ctx.back();
      }
      return false;
    }
    await ctx.loadLeague(room.league);
    enterRoom(room);
    return true;
  } catch {
    if (!quiet) toast('Could not reach that room');
    return false;
  }
}

/** Called from the setup screen. `mode` is 'create' or 'join'. */
export function roomEntry(mode, shell) {
  ctx = shell;
  R.code = null;
  R.room = null;
  if (R.stop) { R.stop(); R.stop = null; }
  if (mode === 'join') { joinScreen(); return; }
  // Seeded once, on the way in -- createScreen re-renders on every tap and
  // must not overwrite a choice made on the screen itself.
  CREATE.league = shell.state.league;
  createScreen();
}

/**
 * Leaving a draft in progress costs the seat its remaining picks -- the room
 * will auto-pick for it -- so it asks first.
 */
function confirmLeave() {
  if (R.room && R.room.phase === 'draft'
    && !window.confirm('Leave the draft? The room will pick for you from here.')) return;
  leaveRoom();
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

/**
 * What a difficulty actually changes in a room.
 *
 * Not DIFFICULTIES[k].note, which leads on rerolls -- and rerolls do not exist
 * here, because the board is shared. In the NWSL there is no public salary
 * data either, so nothing is left but whether ratings are hidden, and saying
 * so is better than implying a difference that is not there.
 */
function roomNote(key, league) {
  const d = rulesFor(key, league);
  const bits = [];
  if (d.maxDPs !== Infinity) bits.push(`${d.maxDPs} DPs`);
  if (d.salaryCap) bits.push('salary cap');
  if (d.hideRatings) bits.push('ratings hidden');
  return bits.length ? bits.join(' + ') : 'No limits';
}

function createScreen() {
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
    const d = DIFFICULTIES[k];
    return `<button class="opt" data-val="${k}" aria-pressed="${CREATE.difficulty === k}">
              <b>${d.label}</b><span>${esc(roomNote(k, CREATE.league))}</span></button>`;
  }).join('')}
        </div>
        <p class="dim" style="font-size:11px;margin-top:8px">
          Rerolls do not apply in a room — the board is shared, so there is
          nothing to reroll.${CREATE.league === 'mls'
    ? ' Difficulty sets the DP limit and the salary cap.'
    : ' There is no public NWSL salary data, so only Max changes anything here: it hides the ratings.'}</p>
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
  R.reeled = -1;
  R.stage = null;
  R.sim = null;
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
  else if (room.phase === 'coach') reviewScreen();
  // A run in progress owns the screen: re-rendering mid-ticker would restart
  // it. `stage` keeps a finished regular season on the standings rather than
  // replaying it when the next poll lands.
  else if (room.phase === 'season' && !R.ticking && R.stage !== 'standings') seasonScreen();
  else if (room.phase === 'playoffs' && !R.ticking && R.stage !== 'results') playoffScreen();
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
      14 rounds · one shared club-season a round · ${room.pick_seconds}s a pick<br>
      The draft order is drawn at random when the host starts.</p>`);

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
  // Not st.boards[round] directly: the seat on the clock may be drafting from
  // a replacement board, and everyone should be looking at what they are
  // looking at. Deterministic, so every client resolves the same board. Until
  // the round's shared board has been drawn there is nothing to resolve.
  const board = st.boards[st.round]
    ? boardForPick(ctx.state.pool, st, Number(room.seed)).board
    : null;
  const onClockMember = st.members.find((m) => m.seat === st.onClock);
  const dps = countDPs(squad);
  const maxDPs = R.rules.maxDPs;

  render(`
    <div class="between" style="margin-bottom:8px">
      <div class="eyebrow">Room ${esc(room.code)} · ${esc(ctx.leagues[room.league].label)}</div>
      <button class="btn ghost sm" id="leave">Leave</button>
    </div>
    <div class="topbar">
      <div class="stat"><b>${st.round + 1}<span class="frac">/${SQUAD_SIZE}</span></b><span>Round</span></div>
      <div class="stat"><b>${squad.filter((s) => s.player).length}<span class="frac">/${SQUAD_SIZE}</span></b><span>Your squad</span></div>
      <div class="stat"><b class="mono" id="clock">${Math.ceil(clockLeft(room, R.skew))}</b><span>Seconds</span></div>
      <div class="stat"><b style="color:${dps >= maxDPs ? 'var(--dp)' : 'var(--text)'}">${dps}<span class="frac">/${maxDPs === Infinity ? '∞' : maxDPs}</span></b><span>DPs</span></div>
    </div>

    <div class="card" style="margin-bottom:10px;padding:8px 10px">
      <div class="between">
        <span class="eyebrow">Draft order</span>
        <span class="dim" style="font-size:11px">${draftOrder(room).map((seat, i) => {
    const m = st.members.find((x) => x.seat === seat);
    return `${i ? ' · ' : ''}${esc(m ? m.name : `Seat ${seat + 1}`)}`;
  }).join('')}</span>
      </div>
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

  on('#leave', 'click', confirmLeave);
  on('[data-group="tab"] .opt', 'click', (e) => {
    R.tab = e.currentTarget.dataset.val;
    draftScreen();
  });
  if (R.tab === 'board' && !board) idleReel(ctx.state.pool.spins);
  if (R.tab === 'board') {
    // Reveal a new board with the same slot machine the solo game uses --
    // once per round, for everyone, not just whoever is on the clock. Tab
    // switches and the re-render after every pick must not replay it.
    if (board && R.reeled !== st.round) {
      R.reeled = st.round;
      runReel(board, ctx.state.pool.spins, {
        onSettle: () => bindBoard(board, squad),
      });
    } else {
      bindBoard(board, squad);
    }
  }
  tickClock();
}

/** Who picks next, in this round's order. */
function orderStrip() {
  const st = R.state;
  const order = st.roundSeats;
  const idx = order.indexOf(st.onClock);
  return order.map((s, i) => {
    const m = st.members.find((x) => x.seat === s);
    const initial = esc((m?.name || '?').slice(0, 1).toUpperCase());
    const cls = i === idx ? 'now' : i < idx ? 'done' : '';
    return `<span class="ordot ${cls}">${initial}</span>`;
  }).join('');
}

function boardPane(board, squad) {
  // No board yet: show the reel turning rather than a stalled-looking card.
  if (!board) {
    return `
      <div class="reel spinning" id="reel">
        <div class="avatar"></div>
        <div>
          <h2 id="reel-team">&nbsp;</h2>
          <div class="season" id="reel-season">Drawing the next club…</div>
        </div>
      </div>`;
  }
  const roster = annotate(board.roster, squad, R.state.taken, R.rules);
  const order = ['GK', 'CB', 'FB', 'DM', 'CM', 'AM', 'W', 'ST'];
  const groups = order.map((pos) => [pos, roster.filter((p) => p.pos === pos)])
    .filter(([, list]) => list.length);
  const canPick = isMyTurn();

  const animate = R.reeled !== R.state.round;
  return `
    <div class="reel" id="reel">
      ${avatar(BADGE(board.teamId), board.team.abbr)}
      <div>
        <h2 id="reel-team">${esc(board.team.name)}</h2>
        <div class="season" id="reel-season">${board.season}${board.projected ? ' (projected)' : ''}</div>
      </div>
    </div>
    <div class="between" style="margin:14px 0 6px">
      <div class="eyebrow">${canPick ? 'Pick one player' : 'Everyone drafts from this club'}</div>
      <span class="dim" style="font-size:11.5px">${roster.filter((p) => !p.blocked).length} available to you</span>
    </div>
    <div class="roster ${canPick ? '' : 'watching'}${animate ? ' pending' : ''}">
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

// ---------------------------------------------------------------- review

/**
 * Between the draft and the season: rearrange the XI, appoint a coach, ready up.
 *
 * The arrangement has to be shared, not kept locally, because every client
 * simulates every club -- a swap only this device knew about would give each
 * person a different season. It is sent as {slot: player} and re-applied over
 * the pick list on the other side, so it can only ever reorder a squad, never
 * change who is in it.
 */
function reviewScreen() {
  const mine = myMember();
  const seat = mySeat();
  const squad = R.state.squads.get(seat);
  const shortlist = coachShortlists(ctx.state.sim.coaches, R.state.seats, Number(R.room.seed)).get(seat) || [];
  const waiting = R.room.members.filter((m) => !m.ready);
  const { total } = squadStrength(squad);
  const coach = currentCoach();

  render(`
    <div class="between" style="margin-bottom:8px">
      <div class="eyebrow">Room ${esc(R.code)}</div>
      <button class="btn ghost sm" id="leave">Leave</button>
    </div>
    <div style="margin-bottom:12px">
      <div class="eyebrow">Squad complete</div>
      <h2 style="font-size:20px">Pick your XI</h2>
      <p class="muted" style="font-size:13px;margin-top:8px">
        Tap two players to swap them. Anyone who can play the other's position
        is fair game — move someone out of their natural role and they lose
        a fifth of their g+.</p>
    </div>

    <div class="between card" style="margin-bottom:10px">
      <div><div class="eyebrow">Squad g+</div>
        <b class="mono" style="font-size:19px">${(total > 0 ? '+' : '') + total.toFixed(1)}</b></div>
      <div class="dim" style="font-size:12px;text-align:right">${esc(mine?.formation || '')}<br>
        Starters 91% · subs 30%</div>
    </div>

    <div id="pane">${pitchPane(squad, !mine?.ready)}</div>

    <div style="margin-top:14px">
      <div class="eyebrow" style="margin-bottom:8px">Head coach</div>
      ${mine?.ready
    ? (coach ? coachCard(coach, false) : '')
    : `<p class="dim" style="font-size:11.5px;margin-bottom:8px">
         Three names, yours alone — no two clubs in the room are offered the same one.</p>
       <div class="coaches">${shortlist.map((c) => coachCard(c, true)).join('')}</div>`}
    </div>

    ${mine?.ready
    ? `<div class="card center" style="margin-top:14px">
        <b style="font-size:14px">You are ready</b>
        <p class="dim" style="font-size:11.5px;margin-top:6px">
          ${waiting.length ? `Waiting for ${esc(waiting.map((m) => m.name).join(', '))}` : 'Kicking off…'}</p>
        <button class="btn ghost sm" id="unready" style="margin-top:10px">Change my mind</button>
      </div>`
    : ''}

    <div class="card" style="margin-top:12px">
      <div class="eyebrow" style="margin-bottom:8px">Room</div>
      ${R.room.members.map((m) => `
        <div class="pickrow">
          <span class="pickname">${esc(m.name)}${m.seat === mySeat() ? ' (you)' : ''}</span>
          <span class="dim" style="font-size:11px">${m.ready ? '✓ ready' : 'choosing…'}</span>
        </div>`).join('')}
    </div>`);

  on('#leave', 'click', confirmLeave);
  if (!mine?.ready) bindRoomSwap(squad);
  on('[data-coach]', 'click', async (e) => {
    const id = e.currentTarget.dataset.coach;
    try {
      onRoom(await updateMember({
        code: R.code, coach_id: id, ready: true, lineup: lineupOf(squad),
      }), R.skew);
    } catch { toast('Could not save that'); }
  });
  on('#unready', 'click', async () => {
    try { onRoom(await updateMember({ code: R.code, ready: false }), R.skew); }
    catch { toast('Could not save that'); }
  });
}

/** The squad as {slot_id: player_id}, which is all the server keeps of it. */
const lineupOf = (squad) => Object.fromEntries(
  squad.filter((s) => s.player).map((s) => [s.id, s.player.id]),
);

function pitchPane(squad, interactive) {
  const starters = squad.filter((s) => s.starter);
  const subs = squad.filter((s) => !s.starter);
  const from = R.swapFrom ? squad.find((s) => s.id === R.swapFrom) : null;
  const targets = from ? new Set(swapTargets(from, squad).map((s) => s.id)) : new Set();
  return `
    <div class="pitch">${starters.map((s) => pitchSlot(s, false, interactive, from, targets)).join('')}</div>
    <div class="bench">${subs.map((s) => pitchSlot(s, true, interactive, from, targets)).join('')}</div>
    ${interactive ? `<p class="dim center" style="font-size:11.5px;margin-top:10px">
      ${from ? 'Tap a highlighted player to swap — tap again to cancel'
    : 'Tap two players to swap their positions'}</p>` : ''}`;
}

/** Tap one player then another to swap, when each can play the other's slot. */
function bindRoomSwap(squad) {
  const rerender = () => {
    document.getElementById('pane').innerHTML = pitchPane(squad, true);
    mountAvatars(document.getElementById('pane'));
    bindRoomSwap(squad);
  };
  on('#pane .slot[data-slot]', 'click', (e) => {
    const id = e.currentTarget.dataset.slot;
    const slot = squad.find((x) => x.id === id);
    if (slot?.player) {
      toast(`${shortName(slot.player.name)} · ${slot.player.season} · ${gplus(effectiveScore(slot.player, slot.pos))} g+`);
    }
    if (!R.swapFrom) { R.swapFrom = id; rerender(); return; }
    if (R.swapFrom === id) { R.swapFrom = null; rerender(); return; }
    const a = squad.find((x) => x.id === R.swapFrom);
    const b = slot;
    if (!swapTargets(a, squad).some((x) => x.id === id)) { R.swapFrom = id; rerender(); return; }
    const before = squadStrength(squad).total;
    [a.player, b.player] = [b.player, a.player];
    const after = squadStrength(squad).total;
    R.swapFrom = null;
    rerender();
    const d = after - before;
    toast(`Swapped · squad g+ ${d >= 0 ? '+' : ''}${d.toFixed(2)}`);
  });
}

const currentCoach = () => ctx.state.sim.coaches.find((c) => c.id === myMember()?.coach_id) || null;

// ---------------------------------------------------------------- season

/**
 * Run the room's season, once.
 *
 * Every client computes this locally from the shared seed and the shared
 * picks, so nothing is uploaded and everyone still sees the same results, the
 * same table and the same Cup. The playoffs are simulated here too, at the
 * same time -- the host only controls *when* the room watches them, which
 * keeps the whole season one deterministic run rather than two.
 */
function ensureSim() {
  if (R.sim) return R.sim;
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
  return R.sim;
}

const myResult = () => ensureSim().bySeat.get(mySeat());

function seasonScreen() {
  R.ticking = true;
  R.stage = 'ticker';
  const mine = myResult();

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

  R.speed = 1;
  R.skip = false;
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
    if (!document.getElementById('ticker')) return; // left the room mid-run
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
  await wait(400);
  R.ticking = false;
  standingsScreen();
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

// ---------------------------------------------------------- final standings

/** Goal and assist leaders, from the player's own squad. */
function awardsCard(awards, title = 'Season leaders') {
  if (!awards.scorers.length && !awards.assisters.length) return '';
  const list = (rows, key) => (rows.length ? rows.map((t, i) => `
      <div class="lead ${i === 0 ? 'top' : ''}">
        <span class="rank">${i + 1}</span>
        <span class="lname">${esc(t.name)}</span>
        <span class="dim" style="font-size:10px">${t.pos}</span>
        <b class="mono">${t[key]}</b>
      </div>`).join('') : '<div class="dim" style="font-size:12px">None</div>');
  return `
    <div class="card" style="margin-top:12px">
      <div class="eyebrow" style="margin-bottom:8px">${esc(title)}</div>
      <div class="leadgrid">
        <div><div class="dim" style="font-size:11px;margin-bottom:4px">Goals</div>
          ${list(awards.scorers, 'goals')}</div>
        <div><div class="dim" style="font-size:11px;margin-bottom:4px">Assists</div>
          ${list(awards.assisters, 'assists')}</div>
      </div>
    </div>`;
}

/** The full table, with every club in the room marked. */
function leagueTable(conf) {
  const rows = R.sim.standings[conf] || [];
  const seatOf = new Map([...R.sim.bySeat].map(([seat, r]) => [r.club.id, seat]));
  return `
    <div class="card">
      <table class="table">
        <thead><tr><th>#</th><th>Club</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th></tr></thead>
        <tbody>
          ${rows.map((t, i) => {
    const seat = seatOf.get(t.id);
    const isMine = seat === mySeat();
    return `<tr class="${isMine ? 'you' : ''} ${i === 8 ? 'cut' : ''}">
              <td>${t.seed}</td>
              <td><div class="tm">${avatar(seat === undefined ? BADGE(t.id) : '', t.abbr)}
                <span>${esc(seat === undefined ? t.short : t.name)}${seat !== undefined && !isMine ? ' <span class="pill">room</span>' : ''}</span></div></td>
              <td>${t.w}</td><td>${t.d}</td><td>${t.l}</td>
              <td>${t.gf - t.ga > 0 ? '+' : ''}${t.gf - t.ga}</td>
              <td><b>${t.pts}</b></td>
            </tr>`;
  }).join('')}
        </tbody>
      </table>
    </div>`;
}

function standingsScreen() {
  R.stage = 'standings';
  const mine = myResult();
  const conf = mine.club.conf;
  const others = [...R.sim.bySeat.entries()].filter(([seat]) => seat !== mySeat());

  render(`
    <div class="eyebrow">Regular season complete</div>
    <h2 style="font-size:20px;margin-bottom:10px">
      ${LEAGUE.conferences ? `${esc(conf)}ern Conference` : `${esc(LEAGUE.name)} table`}</h2>
    ${leagueTable(conf)}
    <p class="dim center" style="font-size:11px;margin-top:8px">Gold line = playoff cut (top 8)</p>

    <div class="card" style="margin-top:12px">
      <div class="eyebrow" style="margin-bottom:8px">The room after ${LEAGUE.games} games</div>
      ${roomLeaderboard(R.sim).map((r, i) => `
        <div class="pickrow">
          <span class="dim mono" style="font-size:10px">${i + 1}</span>
          <span class="pickname">${esc(r.club.name)}${r.seat === mySeat() ? ' (you)' : ''}</span>
          <span class="dim" style="font-size:11px">${r.madePlayoffs ? `#${r.seed} seed` : 'missed out'}</span>
          <b class="mono">${r.points}</b>
        </div>`).join('')}
    </div>

    ${awardsCard(mine.awards, 'Your season leaders')}
    ${others.length ? `<div class="card" style="margin-top:12px">
      <div class="eyebrow" style="margin-bottom:8px">Golden boots around the room</div>
      ${others.map(([seat, r]) => {
    const top = r.awards.scorers[0];
    return `<div class="pickrow">
          <span class="pickname">${esc(r.club.name)}</span>
          <span class="dim" style="font-size:11px">${top ? esc(shortName(top.name)) : '—'}</span>
          <b class="mono">${top ? top.goals : 0}</b>
        </div>`;
  }).join('')}
    </div>` : ''}

    ${isHost()
    ? `<button class="btn" id="toplayoffs" style="margin-top:14px">Start the playoffs →</button>`
    : `<div class="card center" style="margin-top:14px">
        <b style="font-size:13px">Waiting for the host to start the playoffs</b>
        <p class="dim" style="font-size:11.5px;margin-top:4px">
          ${mine.madePlayoffs ? `You are in as the #${mine.seed} seed.` : 'You did not make it — but you can still watch.'}</p>
      </div>`}`);

  on('#toplayoffs', 'click', async (e) => {
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = 'Starting…';
    try { onRoom(await startPlayoffs(R.code), R.skew); }
    catch { toast('Could not start the playoffs'); standingsScreen(); }
  });
}

// ---------------------------------------------------------------- playoffs

function playoffScreen() {
  R.ticking = true;
  R.stage = 'bracket';
  R.speed = 1;
  R.skip = false;
  render(`
    <div class="eyebrow">${esc(LEAGUE.cupName)} Playoffs</div>
    <h2 style="font-size:20px;margin-bottom:10px">The bracket</h2>
    <div class="controls">
      <button class="btn ghost sm" id="speed">▶ 1×</button>
      <button class="btn ghost sm" id="skip">Skip to end ⏭</button>
    </div>
    <div class="bracket" id="bracket"></div>
    <div id="after"></div>`);
  on('#speed', 'click', (e) => {
    R.speed = R.speed === 1 ? 2 : R.speed === 2 ? 4 : 1;
    e.currentTarget.textContent = `▶ ${R.speed}×`;
  });
  on('#skip', 'click', () => { R.skip = true; });
  runBracket();
}

async function runBracket() {
  const sim = ensureSim();
  const bracket = document.getElementById('bracket');
  // Every tie a room club was in, plus the final whatever happened.
  const ties = sim.playoffs.rounds.filter((t) => [t.high, t.low, t.host, t.away]
    .some((c) => c && c.isMember));
  const cup = sim.playoffs.rounds[sim.playoffs.rounds.length - 1];
  if (!ties.includes(cup)) ties.push(cup);

  for (const t of ties) {
    if (!document.getElementById('bracket')) return;
    const box = document.createElement('div');
    box.innerHTML = tieCard(t);
    const card = box.firstElementChild;
    bracket.appendChild(card);
    mountAvatars(card);
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (!R.skip) await wait(1400 / R.speed);
  }
  R.ticking = false;
  const after = document.getElementById('after');
  if (!after) return;
  after.innerHTML = '<button class="btn" id="go" style="margin-top:14px">Final verdict →</button>';
  after.querySelector('#go').addEventListener('click', resultsScreen);
}

/** One playoff tie, with the goals in it. */
function tieCard(t) {
  const name = (c) => (c.isMember ? c.name : c.short);
  const mineId = R.sim.bySeat.get(mySeat())?.club.id;
  const isMine = (c) => c && c.id === mineId;
  const goals = (list, ours) => (list || []).map((g) => `
    <div class="goal ${ours ? 'ours' : 'theirs'}">
      <span class="min">${g.minute}'</span>
      <span class="who2">${g.scorer ? esc(shortName(g.scorer)) : '—'}</span>
      ${g.assister ? `<span class="ast">${esc(shortName(g.assister))}</span>` : ''}
    </div>`).join('');
  const seedOf = (c) => (c.seed ? (t.conf === 'Cup' ? `${String(c.conf)[0]}${c.seed}` : `#${c.seed}`) : '');
  const side = (c, lost) => `<div class="side ${lost ? 'lost' : ''}">
      ${avatar(c.isMember ? '' : BADGE(c.id), c.abbr)}
      <span>${esc(name(c))}</span><span class="dim" style="font-size:10px">${seedOf(c)}</span>
    </div>`;
  const head = `<div class="eyebrow" style="margin-bottom:4px">${esc(t.round)}${
    LEAGUE.conferences && t.conf && t.conf !== 'Cup' ? ` · ${esc(t.conf)}` : ''}</div>`;
  const involved = [t.high, t.low, t.host, t.away].some(isMine);

  if (t.games) {
    const loser = t.winner === t.high ? t.low : t.high;
    const [a, b] = t.series.split('-').map(Number);
    const legs = t.games.map((g, i) => `
      <div class="leg">
        <div class="leg-head">Game ${i + 1} · ${g.highHosts ? esc(t.high.abbr) : esc(t.low.abbr)}
          <b class="mono">${g.highGoals}–${g.lowGoals}</b>${g.pens ? ' <span class="dim">(pens)</span>' : ''}</div>
        ${goals(g.highScorers, isMine(t.high))}
        ${goals(g.lowScorers, isMine(t.low))}
      </div>`).join('');
    return `<div class="tie ${involved ? 'you' : ''}">
      <div class="tie-top"><div>${head}${side(t.winner, false)}${side(loser, true)}</div>
        <div class="meta">${Math.max(a, b)}–${Math.min(a, b)}<br>series</div></div>
      <div class="legs">${legs}</div></div>`;
  }
  const loser = t.winner === t.host ? t.away : t.host;
  const wg = t.winner === t.host ? t.hg : t.ag;
  const lg = t.winner === t.host ? t.ag : t.hg;
  const lines = goals(t.hostScorers, isMine(t.host)) + goals(t.awayScorers, isMine(t.away));
  return `<div class="tie ${involved ? 'you' : ''}">
    <div class="tie-top"><div>${head}${side(t.winner, false)}${side(loser, true)}</div>
      <div class="meta">${wg}–${lg}<br>${t.pens ? 'on pens' : `at ${esc(t.host.abbr)}`}</div></div>
    ${lines ? `<div class="legs"><div class="leg">${lines}</div></div>` : ''}
  </div>`;
}

// ---------------------------------------------------------------- results

/** Shaped like the solo game's season, so the PNG card and the achievement
 *  rules can be reused unchanged. */
function seasonLike(mine) {
  const champ = R.sim.champion;
  return {
    userRecord: mine.record,
    madePlayoffs: mine.madePlayoffs,
    seed: mine.seed,
    won: mine.won,
    wonCup: mine.wonCup,
    points: mine.points,
    strength: mine.strength,
    results: mine.results,
    awards: mine.awards,
    playoffs: { champion: { short: champ.isMember ? champ.name : champ.short } },
  };
}

function resultsScreen() {
  R.stage = 'results';
  R.ticking = false;
  // The draft is long over and the season is derived, so there is nothing left
  // on the server worth asking about.
  if (R.stop) { R.stop(); R.stop = null; }

  const board = roomLeaderboard(R.sim);
  const mine = myResult();
  const champ = R.sim.champion;
  const winner = board[0];
  const squad = R.state.squads.get(mySeat());
  R.achievements = achievements(seasonLike(mine), squad);

  render(`
    <div class="verdict ${mine.won || mine.wonCup ? 'win' : 'lose'}">
      <div class="eyebrow">Room ${esc(R.code)} · 2026</div>
      <div class="big mono">${mine.points}</div>
      <h2>${mine.won ? 'IMMORTAL'
    : (winner.seat === mySeat() ? 'Best in the room' : `${esc(winner.club.name)} took it`)}</h2>
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
              <td><b>${esc(r.club.name)}</b><div class="dim" style="font-size:10px">${
  LEAGUE.conferences ? `${esc(r.club.conf)}${r.coach ? ' · ' : ''}` : ''}${r.coach ? esc(r.coach.name) : ''}</div></td>
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

    ${achievementsCard()}
    ${headToHeadCard()}
    ${leagueTableCard()}
    ${awardsCard(mine.awards, 'Your regular-season leaders')}
    ${mine.coach ? `<div style="margin-top:12px">${coachCard(mine.coach, false)}</div>` : ''}
    <div style="margin-top:12px" id="finalsquad">${pitchPane(squad, false)}</div>

    <div class="card" style="margin-top:12px">
      <div class="eyebrow" style="margin-bottom:8px">Share</div>
      <div class="share">${esc(shareText())}</div>
      <button class="btn sm" id="copy" style="width:100%;margin-top:12px">Copy result</button>
      <button class="btn ghost sm" id="png" style="width:100%;margin-top:8px">⬇ Export as PNG</button>
    </div>
    <button class="btn ghost" id="again" style="margin-top:12px">Back to the menu</button>`);

  on('#copy', 'click', () => copy(shareText(), 'Copied!'));
  on('#again', 'click', leaveRoom);
  on('#finalsquad .slot[data-slot]', 'click', (e) => {
    const s = squad.find((x) => x.id === e.currentTarget.dataset.slot);
    if (s?.player) toast(`${shortName(s.player.name)} · ${s.player.season} · ${gplus(effectiveScore(s.player, s.pos))} g+`);
  });
  on('#png', 'click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const was = btn.textContent;
    btn.textContent = 'Rendering…';
    try {
      const blob = await buildCard({
        season: seasonLike(mine),
        squad,
        teamName: mine.club.name,
        difficulty: `${DIFFICULTIES[R.room.difficulty].label} · room`,
        coach: mine.coach,
        achievements: R.achievements || [],
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `road-to-${LEAGUE.target}-${mine.club.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast('Saved');
    } catch {
      toast('Export failed');
    }
    btn.disabled = false;
    btn.textContent = was;
  });
}

function achievementsCard() {
  const list = R.achievements || [];
  if (!list.length) return '';
  return `
    <div class="card" style="margin-top:12px">
      <div class="eyebrow" style="margin-bottom:9px">Achievements · ${list.length}</div>
      <div class="achs">
        ${list.map((a) => `
          <div class="ach ${a.tier}">
            <b>${esc(a.name)}</b><span>${esc(a.note)}</span>
          </div>`).join('')}
      </div>
    </div>`;
}

/** The final table, collapsed behind a toggle so it does not dominate. */
function leagueTableCard() {
  const conf = myResult().club.conf;
  return `
    <details class="card" style="margin-top:12px">
      <summary class="eyebrow" style="cursor:pointer">
        Final ${LEAGUE.conferences ? `${esc(conf)}ern Conference` : esc(LEAGUE.name)} table</summary>
      <div style="margin-top:10px">${leagueTable(conf)}</div>
    </details>`;
}

/** Who beat whom, among the room. */
function headToHeadCard() {
  const rows = myResult().results.filter((g) => g.opp.isMember);
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

function shareText() {
  const board = roomLeaderboard(R.sim);
  const mine = myResult();
  const place = board.findIndex((r) => r.seat === mySeat()) + 1;
  const marks = mine.results.map((x) => ({ W: '🟩', D: '🟨', L: '🟥' }[x.result]));
  const top = mine.awards.allScorers[0];
  return [
    `Road to ${LEAGUE.target} ⚽ Room draft · ${LEAGUE.name} · ${board.length} drafters`,
    `${place}${['st', 'nd', 'rd'][place - 1] || 'th'} of ${board.length} · ${mine.points} pts`
      + (mine.wonCup ? ` · 🏆 ${LEAGUE.cupName}` : '') + (mine.won ? ' · IMMORTAL 👑' : ''),
    marks.slice(0, 17).join(''),
    marks.slice(17).join(''),
    top ? `⚽ ${shortName(top.name)} ${top.goals}` : '',
    (R.achievements || []).length ? `🏅 ${R.achievements.slice(0, 3).map((a) => a.name).join(' · ')}` : '',
    window.location.origin + window.location.pathname,
  ].filter(Boolean).join('\n');
}
