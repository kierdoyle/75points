import './style.css';
import {
  DIFFICULTIES, FORMATIONS, MAX_DPS, SQUAD_SIZE, SLOT_LABEL,
  makeSquad, countDPs, openSlotsFor,
} from './rules.js';
import { loadPool, makeRng, drawSpin, annotate, pick } from './pool.js';
import { simSeason, squadStrength, TARGET_POINTS, SEASON_GAMES } from './sim.js';

const app = document.getElementById('app');

// ASA's public image buckets. Never bundled -- hotlinked, with a monogram
// fallback for the occasional 404 (see avatar()/mountAvatars()).
const BADGE = (id) => `https://american-soccer-analysis-headshots.s3.amazonaws.com/club_logos/${id}.png`;
const HEAD = (id) => `https://american-soccer-analysis-headshots.s3.us-east-1.amazonaws.com/player_headshots/${id}.png`;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const initials = (name) => name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

// Particles that belong with the surname on the pitch label ("St. Clair",
// "van der Water") rather than being stripped off with the given name.
const PARTICLES = new Set(['st.', 'st', 'de', 'del', 'della', 'di', 'da', 'dos', 'du',
  'van', 'von', 'der', 'den', 'la', 'le', 'mc', 'o', "o'"]);

function shortName(name) {
  const parts = name.split(/\s+/);
  if (parts.length < 2) return name;
  let i = parts.length - 1;
  while (i > 1 && PARTICLES.has(parts[i - 1].toLowerCase())) i--;
  return parts.slice(i).join(' ');
}

/**
 * An avatar renders its monogram immediately and swaps in the remote image
 * only once it has actually loaded, so a missing badge or headshot degrades to
 * initials instead of a broken-image icon.
 */
function avatar(url, fallback, cls = '') {
  let hue = 0;
  for (const ch of fallback) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  // No url (the player's own club has no badge) => monogram only.
  const src = url ? ` data-img="${esc(url)}"` : '';
  return `<div class="avatar ${cls}"${src} style="background:hsl(${hue} 32% 26%)">${esc(fallback)}</div>`;
}

/**
 * Point an avatar at a new image. The monogram shows immediately and is only
 * replaced once the image loads; a sequence number means that when the reel
 * flicks through badges, a slow earlier load can't overwrite a later frame.
 */
function setAvatar(node, url, fallback) {
  const seq = String(Number(node.dataset.seq || 0) + 1);
  node.dataset.seq = seq;
  node.textContent = fallback;
  let hue = 0;
  for (const ch of fallback) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  node.style.background = `hsl(${hue} 32% 26%)`;
  if (!url) return;
  const img = new Image();
  img.alt = '';
  img.addEventListener('load', () => {
    if (node.dataset.seq !== seq) return;
    node.textContent = '';
    node.appendChild(img);
  });
  img.addEventListener('error', () => { /* keep the monogram */ });
  img.src = url;
}

function mountAvatars(root = app) {
  root.querySelectorAll('.avatar[data-img]').forEach((node) => {
    const url = node.dataset.img;
    delete node.dataset.img;
    setAvatar(node, url, node.textContent.trim());
  });
}

function render(html) {
  app.innerHTML = html;
  mountAvatars();
  window.scrollTo({ top: 0 });
}

function toast(msg) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}

const on = (sel, ev, fn) => app.querySelectorAll(sel).forEach((n) => n.addEventListener(ev, fn));

// ---------------------------------------------------------------- state

const S = {
  pool: null, sim: null,
  difficulty: 'normal', formation: '4-3-3', conference: 'East', teamName: '',
  squad: null, picked: null, rerolls: 0, spin: null, tab: 'spin',
  rng: null, seed: 0, season: null,
};

async function boot() {
  render(`<div class="hero"><div class="badge-75">75</div><p class="muted">Loading 14 seasons of MLS…</p></div>`);
  const [pool, sim] = await Promise.all([
    fetch('./data/pool.json').then((r) => r.json()),
    fetch('./data/sim.json').then((r) => r.json()),
  ]);
  S.pool = loadPool(pool);
  S.sim = sim;
  // Only ~31 clubs appear across all 14 seasons, so warming every badge is
  // cheap and keeps the spin reel showing real crests instead of monograms.
  for (const id of new Set(S.pool.spins.map((s) => s.teamId))) {
    new Image().src = BADGE(id);
  }
  setupScreen();
}

// ---------------------------------------------------------------- setup

function setupScreen() {
  render(`
    <div class="hero">
      <div class="badge-75">75</div>
      <h1>Road to 75</h1>
      <p>Spin your way through every MLS team-season since 2013. Draft 14 players.
         Then win <b>75 points</b> — one more than the all-time record — <b>and</b> MLS Cup.</p>
    </div>
    <div class="stack">
      <div class="card">
        <div class="eyebrow">Difficulty</div>
        <div class="opts" style="margin-top:8px" data-group="difficulty">
          ${Object.entries(DIFFICULTIES).map(([k, d]) => `
            <button class="opt" data-val="${k}" aria-pressed="${S.difficulty === k}">
              <b>${d.label}</b><span>${d.rerolls} reroll${d.rerolls > 1 ? 's' : ''}</span>
            </button>`).join('')}
        </div>
      </div>

      <div class="card">
        <div class="eyebrow">Formation</div>
        <div class="opts" style="margin-top:8px" data-group="formation">
          ${Object.keys(FORMATIONS).map((f) => `
            <button class="opt" data-val="${f}" aria-pressed="${S.formation === f}">
              <b>${f}</b><span>${shape(f)}</span>
            </button>`).join('')}
        </div>
      </div>

      <div class="card">
        <div class="eyebrow">Conference</div>
        <div class="opts two" style="margin-top:8px" data-group="conference">
          ${['East', 'West'].map((c) => `
            <button class="opt" data-val="${c}" aria-pressed="${S.conference === c}">
              <b>${c}</b><span>${S.sim.opponents.filter((o) => o.conf === c).length} rivals</span>
            </button>`).join('')}
        </div>
      </div>

      <div class="card">
        <div class="eyebrow">Club name</div>
        <input type="text" id="tname" maxlength="22" placeholder="Your Club FC" value="${esc(S.teamName)}" />
      </div>

      <button class="btn" id="start">Start drafting →</button>
      <p class="dim center" style="font-size:12px">
        Every player is rated by their real g+ above average that season (American Soccer Analysis).
      </p>
    </div>`);

  on('[data-group] .opt', 'click', (e) => {
    const btn = e.currentTarget;
    const group = btn.closest('[data-group]').dataset.group;
    S[group] = btn.dataset.val;
    btn.closest('[data-group]').querySelectorAll('.opt')
      .forEach((o) => o.setAttribute('aria-pressed', String(o === btn)));
  });
  on('#start', 'click', () => {
    S.teamName = (document.getElementById('tname').value || '').trim() || 'Your Club FC';
    startDraft();
  });
}

const shape = (f) => ({
  '4-3-3': 'Wide + a 9', '4-4-2': 'Two banks', '4-2-3-1': 'Double pivot',
  '3-5-2': 'Wing-backs', '5-3-2': 'Back five',
}[f] || '');

// ---------------------------------------------------------------- draft

function startDraft() {
  S.seed = (Math.random() * 2 ** 32) >>> 0;
  S.rng = makeRng(S.seed);
  S.squad = makeSquad(S.formation);
  S.picked = new Set();
  S.rerolls = DIFFICULTIES[S.difficulty].rerolls;
  S.tab = 'spin';
  nextSpin();
}

function nextSpin(animate = true) {
  const { spin } = drawSpin(S.pool, S.squad, S.picked, S.rng);
  S.spin = spin;
  draftScreen(animate);
}

function draftScreen(animate = false) {
  const filled = S.squad.filter((s) => s.player).length;
  const dps = countDPs(S.squad);
  const spin = S.spin;

  render(`
    <div class="topbar">
      <div class="stat"><b>${filled}<span style="font-size:12px;color:var(--dim)">/${SQUAD_SIZE}</span></b><span>Drafted</span></div>
      <div class="stat"><b style="color:${S.rerolls ? 'var(--text)' : 'var(--dim)'}">${S.rerolls}</b><span>Rerolls</span></div>
      <div class="stat"><b style="color:${dps >= MAX_DPS ? 'var(--dp)' : 'var(--text)'}">${dps}<span style="font-size:12px;color:var(--dim)">/${MAX_DPS}</span></b><span>DPs</span></div>
    </div>

    <div class="opts two" style="margin-bottom:12px" data-group="tab">
      <button class="opt" data-val="spin" aria-pressed="${S.tab === 'spin'}"><b>Spin</b></button>
      <button class="opt" data-val="squad" aria-pressed="${S.tab === 'squad'}"><b>Squad</b></button>
    </div>

    <div id="pane">${S.tab === 'spin' ? spinPane(spin) : squadPane()}</div>`);

  on('[data-group="tab"] .opt', 'click', (e) => {
    S.tab = e.currentTarget.dataset.val;
    draftScreen(false);
  });

  if (S.tab === 'spin') {
    if (animate) runReel(spin);
    bindSpinPane();
  }
}

function spinPane(spin) {
  const roster = annotate(spin.roster, S.squad, S.picked);
  const order = ['GK', 'CB', 'FB', 'DM', 'CM', 'AM', 'W', 'ST'];
  const groups = order
    .map((pos) => [pos, roster.filter((p) => p.pos === pos)])
    .filter(([, list]) => list.length);

  return `
    <div class="reel" id="reel">
      ${avatar(BADGE(spin.teamId), spin.team.abbr)}
      <div>
        <h2 id="reel-team">${esc(spin.team.name)}</h2>
        <div class="season" id="reel-season">${spin.season}${spin.projected ? ' (projected)' : ''}</div>
      </div>
    </div>

    <div class="between" style="margin:14px 0 6px">
      <div class="eyebrow">Pick one player</div>
      <button class="btn ghost sm" id="reroll" ${S.rerolls ? '' : 'disabled'}>
        ↻ Reroll (${S.rerolls})
      </button>
    </div>

    <div class="roster">
      ${groups.map(([pos, list]) => `
        <div class="group-label">${pos}</div>
        ${list.map((p) => playerRow(p)).join('')}`).join('')}
    </div>`;
}

function playerRow(p) {
  const cls = p.blocked ? 'blocked' : (p.score >= 0 ? 'pos-score' : 'neg-score');
  return `
    <button class="pl ${cls}" data-pid="${p.id}" ${p.blocked ? 'disabled' : ''}>
      ${avatar(HEAD(p.id), initials(p.name), 'head round')}
      <div class="who">
        <div class="nm">${esc(p.name)}</div>
        <div class="sub">
          <span>${p.pos}</span>
          <span>·</span>
          <span>${p.minutes.toLocaleString()}′</span>
          ${p.dp ? '<span class="pill dp">DP</span>' : ''}
          ${p.blocked ? `<span class="pill">${esc(p.blocked)}</span>` : ''}
        </div>
      </div>
      <div class="sc">${p.score > 0 ? '+' : ''}${p.score.toFixed(2)}<small>g+</small></div>
    </button>`;
}

/** Slot-machine reveal: flick through random badges, then settle on the spin. */
async function runReel(spin) {
  const reel = document.getElementById('reel');
  const team = document.getElementById('reel-team');
  const season = document.getElementById('reel-season');
  if (!reel) return;
  const box = reel.querySelector('.avatar');
  // Keep the roster and reroll out of the way until the reel settles --
  // otherwise the player list gives away the answer mid-spin.
  const roster = app.querySelector('.roster');
  const reroll = document.getElementById('reroll');
  roster?.classList.add('pending');
  if (reroll) reroll.disabled = true;
  reel.classList.add('spinning');

  let delay = 50;
  for (let i = 0; i < 14; i++) {
    const r = pick(S.pool.spins, Math.random);
    setAvatar(box, BADGE(r.teamId), r.team.abbr);
    team.textContent = r.team.name;
    season.textContent = r.season;
    await wait(delay);
    delay *= 1.16;
  }
  reel.classList.remove('spinning');
  setAvatar(box, BADGE(spin.teamId), spin.team.abbr);
  team.textContent = spin.team.name;
  season.textContent = spin.season + (spin.projected ? ' (projected)' : '');
  roster?.classList.remove('pending');
  if (reroll) reroll.disabled = !S.rerolls;
}

function bindSpinPane() {
  on('#reroll', 'click', () => {
    if (!S.rerolls) return;
    S.rerolls--;
    nextSpin();
  });
  on('.pl[data-pid]', 'click', (e) => {
    const p = S.spin.roster.find((x) => x.id === e.currentTarget.dataset.pid);
    const slots = openSlotsFor(p, S.squad);
    if (!slots.length) return;
    if (slots.length === 1) commitPick(p, slots[0]);
    else chooseSlot(p, slots);
  });
}

function chooseSlot(player, slots) {
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.innerHTML = `
    <div class="sheet-inner">
      <div class="eyebrow">Where does ${esc(player.name)} play?</div>
      <div class="slot-opts">
        ${slots.map((s) => `
          <button class="opt" data-slot="${s.id}">
            <b>${SLOT_LABEL[s.pos]}</b><span>${s.starter ? 'Starter' : 'Bench'}</span>
          </button>`).join('')}
      </div>
      <button class="btn ghost sm" id="cancel" style="width:100%;margin-top:12px">Cancel</button>
    </div>`;
  document.body.appendChild(sheet);
  sheet.querySelectorAll('[data-slot]').forEach((b) => b.addEventListener('click', () => {
    const slot = slots.find((s) => s.id === b.dataset.slot);
    sheet.remove();
    commitPick(player, slot);
  }));
  sheet.querySelector('#cancel').addEventListener('click', () => sheet.remove());
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
}

async function commitPick(player, slot) {
  slot.player = player;
  slot.justFilled = true;
  S.picked.add(player.id);

  // Flip to the pitch so the new signing pops into place, then spin again.
  S.tab = 'squad';
  draftScreen(false);
  await wait(950);
  slot.justFilled = false;

  if (S.squad.every((s) => s.player)) { seasonScreen(); return; }
  S.tab = 'spin';
  nextSpin();
}

function squadPane() {
  const starters = S.squad.filter((s) => s.starter);
  const subs = S.squad.filter((s) => !s.starter);
  const { total } = squadStrength(S.squad);
  const filled = S.squad.filter((s) => s.player).length;

  return `
    <div class="pitch">
      ${starters.map((s) => pitchSlot(s)).join('')}
    </div>
    <div class="bench">${subs.map((s) => pitchSlot(s, true)).join('')}</div>
    <div class="between card" style="margin-top:12px">
      <div><div class="eyebrow">Squad g+</div><b class="mono" style="font-size:19px">${total > 0 ? '+' : ''}${total.toFixed(1)}</b></div>
      <div class="dim" style="font-size:12px;text-align:right">${S.formation} · ${filled}/${SQUAD_SIZE} filled<br>Subs count ${'30%'} toward strength</div>
    </div>`;
}

function pitchSlot(s, bench = false) {
  const style = bench ? '' : `style="left:${s.x}%;bottom:${s.y}%"`;
  if (!s.player) {
    return `<div class="slot empty" ${style}>
      <div class="avatar round"></div><div class="lbl">${SLOT_LABEL[s.pos]}</div></div>`;
  }
  const p = s.player;
  return `<div class="slot ${s.justFilled ? 'filling' : ''}" ${style}>
    ${avatar(HEAD(p.id), initials(p.name), 'head round')}
    <div class="lbl">${SLOT_LABEL[s.pos]}</div>
    <div class="nm2">${esc(shortName(p.name))}</div>
  </div>`;
}

// ---------------------------------------------------------------- season

function seasonScreen() {
  S.season = simSeason({
    squad: S.squad,
    opponents: S.sim.opponents,
    conference: S.conference,
    teamName: S.teamName,
    rng: S.rng,
  });

  render(`
    <div class="between" style="margin-bottom:10px">
      <div><div class="eyebrow">${esc(S.teamName)} · ${S.conference}</div>
        <h2 style="font-size:20px">2026 season</h2></div>
      <button class="btn ghost sm" id="skip">Skip →</button>
    </div>

    <div class="card" style="margin-bottom:12px">
      <div class="between" style="margin-bottom:8px">
        <b class="mono" style="font-size:26px"><span id="pts">0</span> <span class="dim" style="font-size:13px">/ ${TARGET_POINTS} pts</span></b>
        <div style="text-align:right"><div class="eyebrow">Pace</div>
          <b class="mono" id="pace" style="font-size:13px">—</b></div>
      </div>
      <div class="pace"><i id="bar" style="width:0%"></i><u id="tick" style="left:0%"></u></div>
      <div class="dim" style="font-size:11px;margin-top:6px">Gold tick = the 75-point pace line</div>
    </div>

    <div class="ticker" id="ticker"></div>`);

  on('#skip', 'click', () => { S.skip = true; });
  S.skip = false;
  runTicker();
}

async function runTicker() {
  const ticker = document.getElementById('ticker');
  const ptsEl = document.getElementById('pts');
  const paceEl = document.getElementById('pace');
  const bar = document.getElementById('bar');
  const tick = document.getElementById('tick');

  for (const r of S.season.results) {
    const row = document.createElement('div');
    row.className = 'res';
    row.innerHTML = `
      <div class="md">MD${r.matchday}</div>
      <div class="op">${avatar(BADGE(r.opp.id), r.opp.abbr)}
        <span>${r.home ? 'vs' : '@'} ${esc(r.opp.abbr)}</span></div>
      <div class="sc2 mono">${r.gf}–${r.ga}</div>
      <div class="wl ${r.result}">${r.result}</div>`;
    ticker.prepend(row);
    mountAvatars(row);

    ptsEl.textContent = r.pts;
    const pace = (TARGET_POINTS * r.matchday) / SEASON_GAMES;
    const diff = r.pts - pace;
    paceEl.textContent = `${diff >= 0 ? '+' : ''}${diff.toFixed(1)}`;
    paceEl.style.color = diff >= 0 ? 'var(--accent)' : 'var(--red)';
    bar.style.width = `${Math.min(100, (r.pts / TARGET_POINTS) * 100)}%`;
    tick.style.left = `${(r.matchday / SEASON_GAMES) * 100}%`;

    if (!S.skip) await wait(r.matchday < 3 ? 260 : 130);
  }
  await wait(500);
  standingsScreen();
}

function standingsScreen() {
  const table = S.season.standings[S.conference];
  render(`
    <div class="eyebrow">Final standings</div>
    <h2 style="font-size:20px;margin-bottom:10px">${S.conference}ern Conference</h2>
    <div class="card">
      <table class="table">
        <thead><tr><th>#</th><th>Club</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th></tr></thead>
        <tbody>
          ${table.map((t, i) => `
            <tr class="${t.isUser ? 'you' : ''} ${i === 8 ? 'cut' : ''}">
              <td>${t.seed}</td>
              <td><div class="tm">${avatar(t.isUser ? '' : BADGE(t.id), t.abbr)}<span>${esc(t.isUser ? S.teamName : t.short)}</span></div></td>
              <td>${t.w}</td><td>${t.d}</td><td>${t.l}</td>
              <td>${t.gf - t.ga > 0 ? '+' : ''}${t.gf - t.ga}</td>
              <td><b>${t.pts}</b></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <p class="dim center" style="font-size:11px;margin-top:8px">Gold line = playoff cut (top 8)</p>
    <button class="btn" id="go" style="margin-top:14px">
      ${S.season.madePlayoffs ? 'Into the playoffs →' : 'See how it ended →'}
    </button>`);
  on('#go', 'click', () => (S.season.madePlayoffs ? playoffScreen() : endScreen()));
}

function playoffScreen() {
  const { playoffs } = S.season;
  const ties = [...playoffs.userTies];
  const cup = playoffs.rounds[playoffs.rounds.length - 1];
  if (!ties.includes(cup)) ties.push(cup);

  render(`
    <div class="eyebrow">MLS Cup Playoffs</div>
    <h2 style="font-size:20px;margin-bottom:12px">Your run</h2>
    <div class="bracket">${ties.map((t) => tieCard(t)).join('')}</div>
    <button class="btn" id="go" style="margin-top:16px">Final verdict →</button>`);
  on('#go', 'click', endScreen);
}

function tieCard(t) {
  const isUser = (c) => c && c.isUser;
  const name = (c) => (c.isUser ? S.teamName : c.short);
  // Seeds are per-conference, so in the Cup final tag them E/W to tell two
  // #3 seeds apart.
  const seedOf = (c) => (c.seed ? (t.conf === 'Cup' ? `${c.conf[0]}${c.seed}` : `#${c.seed}`) : '');
  const side = (c, lost) => `<div class="side ${lost ? 'lost' : ''}">
      ${avatar(c.isUser ? '' : BADGE(c.id), c.abbr)}
      <span>${esc(name(c))}</span><span class="dim" style="font-size:10px">${seedOf(c)}</span>
    </div>`;

  const head = (round, conf) => `<div class="eyebrow" style="margin-bottom:4px">`
    + `${round}${conf && conf !== 'Cup' ? ` · ${conf}` : ''}</div>`;

  if (t.games) { // best-of-three
    const loser = t.winner === t.high ? t.low : t.high;
    // Always read the series from the winner's side: "2-1", never "1-2".
    const [a, b] = t.series.split('-').map(Number);
    return `<div class="tie ${isUser(t.high) || isUser(t.low) ? 'you' : ''}">
      <div>${head(t.round, t.conf)}${side(t.winner, false)}${side(loser, true)}</div>
      <div class="meta">${Math.max(a, b)}–${Math.min(a, b)}<br>series</div>
    </div>`;
  }
  const loser = t.winner === t.host ? t.away : t.host;
  const wg = t.winner === t.host ? t.hg : t.ag;
  const lg = t.winner === t.host ? t.ag : t.hg;
  return `<div class="tie ${isUser(t.host) || isUser(t.away) ? 'you' : ''}">
    <div>${head(t.round, t.conf)}${side(t.winner, false)}${side(loser, true)}</div>
    <div class="meta">${wg}–${lg}<br>${t.pens ? 'on pens' : `at ${esc(t.host.abbr)}`}</div>
  </div>`;
}

// ---------------------------------------------------------------- end

function endScreen() {
  const r = S.season;
  const champ = r.playoffs.champion;
  const verdict = r.won ? 'win' : 'lose';
  let headline;
  if (r.won) headline = 'IMMORTAL';
  else if (r.wonCup) headline = 'Champions — but short of 75';
  else if (r.points >= TARGET_POINTS) headline = `${r.points} points… no Cup`;
  else if (r.madePlayoffs) headline = 'Not this time';
  else headline = 'Missed the playoffs';

  const best = [...S.squad].sort((a, b) => b.player.score - a.player.score)[0].player;

  render(`
    <div class="verdict ${verdict}">
      <div class="eyebrow">${esc(S.teamName)} · 2026</div>
      <div class="big mono">${r.points}</div>
      <h2>${esc(headline)}</h2>
      <p class="muted" style="margin-top:8px;font-size:13px">
        ${r.userRecord.w}W–${r.userRecord.d}D–${r.userRecord.l}L ·
        ${r.madePlayoffs ? `#${r.seed} seed` : 'missed the playoffs'} ·
        ${r.wonCup ? '🏆 MLS Cup champions' : `${esc(champ.isUser ? S.teamName : champ.short)} won the Cup`}
      </p>
      <p class="dim" style="margin-top:10px;font-size:12px">
        Needed ${TARGET_POINTS}+ points and MLS Cup.
        ${r.won ? 'You broke the record and lifted the trophy.'
    : `You were ${Math.max(0, TARGET_POINTS - r.points)} point${TARGET_POINTS - r.points === 1 ? '' : 's'} short${r.wonCup ? '.' : ' and fell in the playoffs.'}`}
      </p>
    </div>

    <div class="card" style="margin-top:12px">
      <div class="between">
        <div><div class="eyebrow">Squad g+</div><b class="mono" style="font-size:18px">${r.strength > 0 ? '+' : ''}${r.strength.toFixed(1)}</b></div>
        <div style="text-align:right"><div class="eyebrow">Best pick</div>
          <b style="font-size:14px">${esc(best.name)}</b>
          <div class="dim" style="font-size:11px">${best.season} · +${best.score.toFixed(2)}</div></div>
      </div>
    </div>

    <div style="margin-top:12px">${squadPane()}</div>

    <div class="card" style="margin-top:12px">
      <div class="eyebrow" style="margin-bottom:8px">Share</div>
      <div class="share">${esc(shareText())}</div>
      <button class="btn sm" id="copy" style="width:100%;margin-top:12px">Copy result</button>
    </div>

    <button class="btn ghost" id="again" style="margin-top:12px">Play again</button>`);

  on('#copy', 'click', async () => {
    const text = shareText(true);
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied!');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('Copied!');
    }
  });
  on('#again', 'click', setupScreen);
}

function shareText(withLink = false) {
  const r = S.season;
  const marks = r.results.map((x) => ({ W: '🟩', D: '🟨', L: '🟥' }[x.result]));
  const rows = [marks.slice(0, 17).join(''), marks.slice(17).join('')];
  const cup = r.wonCup ? '🏆 MLS Cup' : (r.madePlayoffs ? `Out in ${lastRound()}` : 'No playoffs');
  return [
    `Road to 75 ⚽ ${DIFFICULTIES[S.difficulty].label} · ${S.formation}`,
    `${r.points} pts · ${cup}${r.won ? ' · IMMORTAL 👑' : ''}`,
    ...rows,
    withLink ? window.location.origin + window.location.pathname : '',
  ].filter(Boolean).join('\n');
}

function lastRound() {
  const ties = S.season.playoffs.userTies;
  if (!ties.length) return 'the playoffs';
  const round = ties[ties.length - 1].round;
  return round.startsWith('Conference') ? `the ${round}` : round;
}

boot();
