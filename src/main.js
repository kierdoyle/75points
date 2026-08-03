import './style.css';
import {
  DIFFICULTIES, FORMATIONS, MAX_DPS, SQUAD_SIZE, SLOT_LABEL, SIDE_LABEL,
  makeSquad, countDPs, openSlotsFor, fitFor, effectiveScore, swapTargets,
} from './rules.js';
import { loadPool, makeRng, drawSpin, annotate, pick, currentRosters } from './pool.js';
import { simSeason, squadStrength, TARGET_POINTS, SEASON_GAMES } from './sim.js';

const app = document.getElementById('app');

// ASA's public image buckets. Never bundled -- hotlinked, with a monogram
// fallback for the occasional 404 (see avatar()/setAvatar()).
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
 * Shrink the pitch label for long surnames. A name only wraps between words,
 * so a single long word ("Hollingshead") has to get smaller rather than break.
 */
function nameSize(label) {
  const longest = Math.max(...label.split(/\s+/).map((w) => w.length));
  if (longest >= 12) return 'xlong';
  if (longest >= 10) return 'long';
  return '';
}

/**
 * Point an avatar at a new image. The monogram shows immediately and is only
 * replaced once the image loads, so a missing badge or headshot degrades to
 * initials rather than a broken-image icon. The sequence number stops a slow
 * earlier load from overwriting a later reel frame.
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

function avatar(url, fallback, cls = '') {
  let hue = 0;
  for (const ch of fallback) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  const src = url ? ` data-img="${esc(url)}"` : '';
  return `<div class="avatar ${cls}"${src} style="background:hsl(${hue} 32% 26%)">${esc(fallback)}</div>`;
}

function mountAvatars(root = app) {
  root.querySelectorAll('.avatar[data-img]').forEach((node) => {
    const url = node.dataset.img;
    delete node.dataset.img;
    setAvatar(node, url, node.textContent.trim());
  });
}

function render(html, keepScroll = false) {
  app.innerHTML = html;
  mountAvatars();
  if (!keepScroll) window.scrollTo({ top: 0 });
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
  pool: null, sim: null, rosters: null,
  difficulty: 'normal', formation: '4-3-3', conference: 'East', teamName: '',
  squad: null, picked: null, rerolls: 0, spin: null, tab: 'spin',
  rng: null, season: null, swapFrom: null, speed: 1, skip: false,
};

async function boot() {
  render('<div class="hero"><div class="badge-75">75</div><p class="muted">Loading 14 seasons of MLS…</p></div>');
  const [pool, sim] = await Promise.all([
    fetch('./data/pool.json').then((r) => r.json()),
    fetch('./data/sim.json').then((r) => r.json()),
  ]);
  S.pool = loadPool(pool);
  S.sim = sim;
  S.rosters = currentRosters(S.pool);
  // Only ~31 clubs appear across all 14 seasons, so warming every badge is
  // cheap and keeps the spin reel showing real crests instead of monograms.
  for (const id of new Set(S.pool.spins.map((s) => s.teamId))) new Image().src = BADGE(id);
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
        Players are rated by their real g+ above average that season, and locked to the
        flank they actually played. Playing them elsewhere costs you.
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
  S.rng = makeRng((Math.random() * 2 ** 32) >>> 0);
  S.squad = makeSquad(S.formation);
  S.coach = null;
  S.picked = new Set();
  S.rerolls = DIFFICULTIES[S.difficulty].rerolls;
  S.tab = 'spin';
  S.swapFrom = null;
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

  render(`
    <div class="topbar">
      <div class="stat"><b>${filled}<span class="frac">/${SQUAD_SIZE}</span></b><span>Drafted</span></div>
      <div class="stat"><b style="color:${S.rerolls ? 'var(--text)' : 'var(--dim)'}">${S.rerolls}</b><span>Rerolls</span></div>
      <div class="stat"><b style="color:${dps >= MAX_DPS ? 'var(--dp)' : 'var(--text)'}">${dps}<span class="frac">/${MAX_DPS}</span></b><span>DPs</span></div>
    </div>
    <div class="opts two" style="margin-bottom:12px" data-group="tab">
      <button class="opt" data-val="spin" aria-pressed="${S.tab === 'spin'}"><b>Spin</b></button>
      <button class="opt" data-val="squad" aria-pressed="${S.tab === 'squad'}"><b>Squad</b></button>
    </div>
    <div id="pane">${S.tab === 'spin' ? spinPane(S.spin, animate) : squadPane(true)}</div>`);

  on('[data-group="tab"] .opt', 'click', (e) => {
    S.tab = e.currentTarget.dataset.val;
    S.swapFrom = null;
    draftScreen(false);
  });

  if (S.tab === 'spin') {
    if (animate) runReel(S.spin);
    bindSpinPane();
  } else {
    bindSwap(() => draftScreen(false));
  }
}

function spinPane(spin, animate = false) {
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
      <button class="btn ghost sm" id="reroll" ${!S.rerolls || animate ? 'disabled' : ''}>↻ Reroll (${S.rerolls})</button>
    </div>
    <div class="roster${animate ? ' pending' : ''}">
      ${groups.map(([pos, list]) => `
        <div class="group-label">${pos}</div>
        ${list.map((p) => playerRow(p)).join('')}`).join('')}
    </div>`;
}

const sideTag = (p) => (p.side ? `<span class="pill side">${SIDE_LABEL[p.side]}</span>` : '');

function playerRow(p) {
  const cls = p.blocked ? 'blocked' : (p.score >= 0 ? 'pos-score' : 'neg-score');
  return `
    <button class="pl ${cls}" data-pid="${p.id}" ${p.blocked ? 'disabled' : ''}>
      ${avatar(HEAD(p.id), initials(p.name), 'head round')}
      <div class="who">
        <div class="nm">${esc(p.name)}</div>
        <div class="sub">
          <span>${p.pos}</span>${sideTag(p)}
          <span>·</span><span>${p.minutes.toLocaleString()}′</span>
          ${p.g90 > 0 ? `<span>· ${(p.g90 * 34).toFixed(0)}g</span>` : ''}
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
  // The roster ships already hidden (spinPane adds .pending when animating),
  // so it can never paint the answer for a frame before the reel starts.
  const roster = app.querySelector('.roster');
  const reroll = document.getElementById('reroll');
  reel.classList.add('spinning');

  // Tapping the reel cuts the animation short for anyone who doesn't want to
  // sit through it.
  S.reelSkip = false;
  reel.addEventListener('click', () => { S.reelSkip = true; }, { once: true });

  let delay = 50;
  for (let i = 0; i < 14 && !S.reelSkip; i++) {
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
    const options = openSlotsFor(p, S.squad);
    if (!options.length) return;
    if (options.length === 1) commitPick(p, options[0].slot);
    else chooseSlot(p, options);
  });
}

/** Sheet listing every slot the player can fill, with what each would cost. */
function chooseSlot(player, options) {
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.innerHTML = `
    <div class="sheet-inner">
      <div class="eyebrow">Where does ${esc(player.name)} play?</div>
      <div class="dim" style="font-size:11px;margin-top:4px">
        ${player.pos}${player.side ? ` · ${SIDE_LABEL[player.side] === 'L' ? 'left' : 'right'} side` : ''} · ${player.score.toFixed(2)} g+
      </div>
      <div class="slot-opts">
        ${options.map((o) => `
          <button class="opt slotopt" data-slot="${o.slot.id}">
            <b>${SLOT_LABEL[o.slot.pos]}</b>
            <span>${o.penalty ? `−${(o.penalty * 100).toFixed(0)}%` : (o.slot.starter ? 'Natural' : 'Bench')}</span>
            <i>${effectiveScore(player, o.slot.pos) > 0 ? '+' : ''}${effectiveScore(player, o.slot.pos).toFixed(2)}</i>
          </button>`).join('')}
      </div>
      ${options.some((o) => o.penalty) ? `<p class="dim" style="font-size:11px;margin-top:10px">
        ${esc(options.find((o) => o.penalty).reasons.join(' + '))} costs g+.</p>` : ''}
      <button class="btn ghost sm" id="cancel" style="width:100%;margin-top:12px">Cancel</button>
    </div>`;
  document.body.appendChild(sheet);
  sheet.querySelectorAll('[data-slot]').forEach((b) => b.addEventListener('click', () => {
    const opt = options.find((o) => o.slot.id === b.dataset.slot);
    sheet.remove();
    commitPick(player, opt.slot);
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

  if (S.squad.every((s) => s.player)) { coachScreen(); return; }
  S.tab = 'spin';
  nextSpin();
}

// ---------------------------------------------------------------- coach

const pct = (v) => `${Math.round(v * 100)}`;
const swing = (v) => {
  const p = (v - 0.5) * 20; // COACH_SWING, as a percentage
  return `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`;
};

function coachCard(c, selectable) {
  const bar = (label, v) => `
    <div class="crow">
      <span class="clab">${label}</span>
      <span class="cbar"><i style="width:${Math.max(3, v * 100)}%;
        background:${v >= 0.5 ? 'var(--accent)' : 'var(--red)'}"></i></span>
      <b class="mono ${v >= 0.5 ? 'up' : 'down'}">${swing(v)}</b>
    </div>`;
  return `
    <${selectable ? 'button' : 'div'} class="coach" ${selectable ? `data-coach="${c.id}"` : ''}>
      <div class="chead">
        ${avatar(BADGE(c.club), c.abbr)}
        <div style="min-width:0">
          <div class="cname">${esc(c.name)}</div>
          <div class="dim" style="font-size:11px">${esc(c.abbr)} · ${c.span} · ${c.games} games</div>
        </div>
      </div>
      ${bar('ATT', c.off)}
      ${bar('DEF', c.def)}
      ${(c.cups || c.shields) ? `<div class="cbadges">
        ${c.cups ? '<span class="pill gold">🏆 Playoff Proven</span>' : ''}
        ${c.shields ? '<span class="pill shield">🛡 Proven Winner</span>' : ''}
      </div>` : ''}
    </${selectable ? 'button' : 'div'}>`;
}

function coachScreen() {
  // Three names off the touchline; take one.
  const all = [...S.sim.coaches];
  const picks = [];
  while (picks.length < 3 && all.length) {
    picks.push(all.splice(Math.floor(S.rng() * all.length), 1)[0]);
  }
  S.coachOptions = picks;

  render(`
    <div style="margin-bottom:12px">
      <div class="eyebrow">Squad complete</div>
      <h2 style="font-size:20px">Appoint a head coach</h2>
      <p class="muted" style="font-size:13px;margin-top:6px">
        Ratings are career percentile ranks for expected goals for and against.
        A median coach changes nothing; the best and worst swing your attack and
        defence by a tenth.</p>
    </div>
    <div class="coaches">${picks.map((c) => coachCard(c, true)).join('')}</div>
    <p class="dim center" style="font-size:11.5px;margin-top:10px">
      🏆 an MLS Cup winner adds 5% in the playoffs · 🛡 a Shield winner adds 5% in the league</p>`);

  on('[data-coach]', 'click', (e) => {
    S.coach = S.sim.coaches.find((c) => c.id === e.currentTarget.dataset.coach);
    reviewScreen();
  });
}

// ---------------------------------------------------------------- squad

function squadPane(interactive = false) {
  const starters = S.squad.filter((s) => s.starter);
  const subs = S.squad.filter((s) => !s.starter);
  const { total } = squadStrength(S.squad);
  const filled = S.squad.filter((s) => s.player).length;
  const from = S.swapFrom ? S.squad.find((s) => s.id === S.swapFrom) : null;
  const targets = from ? new Set(swapTargets(from, S.squad).map((s) => s.id)) : new Set();

  return `
    <div class="pitch">${starters.map((s) => pitchSlot(s, false, interactive, from, targets)).join('')}</div>
    <div class="bench">${subs.map((s) => pitchSlot(s, true, interactive, from, targets)).join('')}</div>
    ${interactive ? `<p class="dim center swap-hint" style="font-size:11.5px;margin-top:10px">
      ${from ? 'Tap a highlighted player to swap — tap again to cancel'
    : 'Tap two players to swap their positions'}</p>` : ''}
    <div class="between card" style="margin-top:10px">
      <div><div class="eyebrow">Squad g+</div>
        <b class="mono" style="font-size:19px">${total > 0 ? '+' : ''}${total.toFixed(1)}</b></div>
      <div class="dim" style="font-size:12px;text-align:right">${S.formation} · ${filled}/${SQUAD_SIZE} filled<br>
        After position penalties · subs at 30%</div>
    </div>`;
}

function pitchSlot(s, bench, interactive, from, targets) {
  const style = bench ? '' : `style="left:${s.x}%;bottom:${s.y}%"`;
  if (!s.player) {
    return `<div class="slot empty" ${style}>
      <div class="avatar round"></div><div class="lbl">${SLOT_LABEL[s.pos]}</div></div>`;
  }
  const p = s.player;
  const fit = fitFor(p, s.pos);
  const pen = fit && fit.penalty ? `<span class="pen">−${(fit.penalty * 100).toFixed(0)}%</span>` : '';
  const cls = [
    'slot',
    s.justFilled ? 'filling' : '',
    interactive ? 'tappable' : '',
    from && from.id === s.id ? 'picked' : '',
    from && targets.has(s.id) ? 'target' : '',
    from && from.id !== s.id && !targets.has(s.id) ? 'faded' : '',
  ].filter(Boolean).join(' ');
  return `<div class="${cls}" ${style} data-slot="${s.id}">
    ${avatar(HEAD(p.id), initials(p.name), 'head round')}
    <div class="lbl">${SLOT_LABEL[s.pos]}${pen}</div>
    <div class="nm2 ${nameSize(shortName(p.name))}">${esc(shortName(p.name))}</div>
  </div>`;
}

/** Tap one player then another to swap them, when both can play the other's slot. */
function bindSwap(rerender) {
  on('.slot.tappable[data-slot]', 'click', (e) => {
    const id = e.currentTarget.dataset.slot;
    if (!S.swapFrom) { S.swapFrom = id; rerender(); return; }
    if (S.swapFrom === id) { S.swapFrom = null; rerender(); return; }
    const a = S.squad.find((s) => s.id === S.swapFrom);
    const b = S.squad.find((s) => s.id === id);
    if (!swapTargets(a, S.squad).some((s) => s.id === id)) {
      // Not a legal pair -- treat the tap as picking a new starting player.
      S.swapFrom = id;
      rerender();
      return;
    }
    const before = squadStrength(S.squad).total;
    [a.player, b.player] = [b.player, a.player];
    const after = squadStrength(S.squad).total;
    S.swapFrom = null;
    rerender();
    const d = after - before;
    toast(`Swapped · squad g+ ${d >= 0 ? '+' : ''}${d.toFixed(2)}`);
  });
}

/** Final look at the XI, with swaps, before committing to the season. */
function reviewScreen() {
  S.swapFrom = null;
  drawReview();
}

function drawReview() {
  const { total } = squadStrength(S.squad);
  const projected = S.sim.model.a + S.sim.model.b * (total / SEASON_GAMES);
  render(`
    <div class="between" style="margin-bottom:10px">
      <div><div class="eyebrow">Squad complete</div>
        <h2 style="font-size:20px">${esc(S.teamName)}</h2></div>
      <div style="text-align:right"><div class="eyebrow">Projected</div>
        <b class="mono" style="font-size:17px">${(projected * SEASON_GAMES).toFixed(0)} pts</b></div>
    </div>
    <div id="pane">${squadPane(true)}</div>
    ${S.coach ? `<div style="margin-top:12px">${coachCard(S.coach, false)}</div>` : ''}
    <button class="btn" id="play" style="margin-top:14px">Play the 2026 season →</button>
    <p class="dim center" style="font-size:11.5px;margin-top:8px">
      Last chance to rearrange. You need ${TARGET_POINTS} points and MLS Cup.</p>`, true);
  bindSwap(drawReview);
  on('#play', 'click', seasonScreen);
}

// ---------------------------------------------------------------- season

function seasonScreen() {
  S.season = simSeason({
    squad: S.squad,
    opponents: S.sim.opponents,
    conference: S.conference,
    teamName: S.teamName,
    rng: S.rng,
    rosters: S.rosters,
    coach: S.coach,
  });
  S.speed = 1;
  S.skip = false;

  render(`
    <div class="between" style="margin-bottom:10px">
      <div><div class="eyebrow">${esc(S.teamName)} · ${S.conference}</div>
        <h2 style="font-size:20px">2026 season</h2></div>
    </div>
    <div class="card" style="margin-bottom:10px">
      <div class="between" style="margin-bottom:8px">
        <b class="mono" style="font-size:26px"><span id="pts">0</span>
          <span class="dim" style="font-size:13px">/ ${TARGET_POINTS} pts</span></b>
        <div style="text-align:right"><div class="eyebrow">Pace</div>
          <b class="mono" id="pace" style="font-size:13px">—</b></div>
      </div>
      <div class="pace"><i id="bar" style="width:0%"></i><u id="tick" style="left:0%"></u></div>
      <div class="dim" style="font-size:11px;margin-top:6px">Gold tick = the 75-point pace line</div>
    </div>
    <div class="controls">
      <button class="btn ghost sm" id="speed">▶ 1×</button>
      <button class="btn ghost sm" id="skip">Skip to end ⏭</button>
    </div>
    <div class="ticker" id="ticker"></div>`);

  on('#speed', 'click', (e) => {
    S.speed = S.speed === 1 ? 2 : S.speed === 2 ? 4 : 1;
    e.currentTarget.textContent = `▶ ${S.speed}×`;
  });
  on('#skip', 'click', () => { S.skip = true; });
  runTicker();
}

/** One match card: score line plus every goal, with scorer and assist. */
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

  return `
    <div class="res">
      <div class="res-top">
        <div class="md">MD${r.matchday}</div>
        <div class="op">${avatar(BADGE(r.opp.id), r.opp.abbr)}
          <span>${r.home ? 'vs' : '@'} ${esc(r.opp.abbr)}</span></div>
        <div class="sc2 mono">${r.gf}–${r.ga}</div>
        <div class="wl ${r.result}">${r.result}</div>
      </div>
      ${all.length ? `<div class="goals">${all.map((g) => goal(g, g.ours)).join('')}</div>` : ''}
    </div>`;
}

async function runTicker() {
  const ticker = document.getElementById('ticker');
  const ptsEl = document.getElementById('pts');
  const paceEl = document.getElementById('pace');
  const bar = document.getElementById('bar');
  const tick = document.getElementById('tick');

  for (const r of S.season.results) {
    const row = document.createElement('div');
    row.innerHTML = matchCard(r);
    const card = row.firstElementChild;
    ticker.prepend(card);
    mountAvatars(card);

    ptsEl.textContent = r.pts;
    const pace = (TARGET_POINTS * r.matchday) / SEASON_GAMES;
    const diff = r.pts - pace;
    paceEl.textContent = `${diff >= 0 ? '+' : ''}${diff.toFixed(1)}`;
    paceEl.style.color = diff >= 0 ? 'var(--accent)' : 'var(--red)';
    bar.style.width = `${Math.min(100, (r.pts / TARGET_POINTS) * 100)}%`;
    tick.style.left = `${(r.matchday / SEASON_GAMES) * 100}%`;

    if (!S.skip) await wait((900 + r.scorers.length * 220) / S.speed);
  }
  await wait(600);
  standingsScreen();
}

function awardsCard(awards, title = 'Season leaders') {
  if (!awards.scorers.length && !awards.assisters.length) return '';
  const list = (rows, key, unit) => (rows.length ? rows.map((t, i) => `
      <div class="lead ${i === 0 ? 'top' : ''}">
        <span class="rank">${i + 1}</span>
        <span class="lname">${esc(t.name)}</span>
        <span class="dim" style="font-size:10px">${t.pos}</span>
        <b class="mono">${t[key]}${unit}</b>
      </div>`).join('') : '<div class="dim" style="font-size:12px">None</div>');
  return `
    <div class="card" style="margin-top:12px">
      <div class="eyebrow" style="margin-bottom:8px">${esc(title)}</div>
      <div class="leadgrid">
        <div>
          <div class="dim" style="font-size:11px;margin-bottom:4px">Goals</div>
          ${list(awards.scorers, 'goals', '')}
        </div>
        <div>
          <div class="dim" style="font-size:11px;margin-bottom:4px">Assists</div>
          ${list(awards.assisters, 'assists', '')}
        </div>
      </div>
    </div>`;
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
    ${awardsCard(S.season.awards)}
    <button class="btn" id="go" style="margin-top:14px">
      ${S.season.madePlayoffs ? 'Into the playoffs →' : 'See how it ended →'}
    </button>`);
  on('#go', 'click', () => (S.season.madePlayoffs ? playoffScreen() : endScreen()));
}

// ---------------------------------------------------------------- playoffs

function playoffScreen() {
  S.speed = 1;
  S.skip = false;
  render(`
    <div class="eyebrow">MLS Cup Playoffs</div>
    <h2 style="font-size:20px;margin-bottom:10px">Your run</h2>
    <div class="controls">
      <button class="btn ghost sm" id="speed">▶ 1×</button>
      <button class="btn ghost sm" id="skip">Skip to end ⏭</button>
    </div>
    <div class="bracket" id="bracket"></div>
    <div id="after"></div>`);
  on('#speed', 'click', (e) => {
    S.speed = S.speed === 1 ? 2 : S.speed === 2 ? 4 : 1;
    e.currentTarget.textContent = `▶ ${S.speed}×`;
  });
  on('#skip', 'click', () => { S.skip = true; });
  runPlayoffs();
}

async function runPlayoffs() {
  const { playoffs } = S.season;
  const bracket = document.getElementById('bracket');
  const ties = [...playoffs.userTies];
  const cup = playoffs.rounds[playoffs.rounds.length - 1];
  if (!ties.includes(cup)) ties.push(cup);

  for (const t of ties) {
    const box = document.createElement('div');
    box.innerHTML = tieCard(t);
    const card = box.firstElementChild;
    bracket.appendChild(card);
    mountAvatars(card);
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (!S.skip) await wait(1500 / S.speed);
  }

  const after = document.getElementById('after');
  after.innerHTML = `${awardsCard(S.season.awards, 'Regular-season leaders')}
    <button class="btn" id="go" style="margin-top:14px">Final verdict →</button>`;
  after.querySelector('#go').addEventListener('click', endScreen);
}

/** Goal lines for one playoff game, from the winner-agnostic scorer lists. */
function gameGoals(list, ours) {
  if (!list || !list.length) return '';
  return list.map((g) => `
    <div class="goal ${ours ? 'ours' : 'theirs'}">
      <span class="min">${g.minute}'</span>
      <span class="who2">${g.scorer ? esc(shortName(g.scorer)) : '—'}</span>
      ${g.assister ? `<span class="ast">${esc(shortName(g.assister))}</span>` : ''}
    </div>`).join('');
}

function tieCard(t) {
  const isUser = (c) => c && c.isUser;
  const name = (c) => (c.isUser ? S.teamName : c.short);
  const seedOf = (c) => (c.seed ? (t.conf === 'Cup' ? `${c.conf[0]}${c.seed}` : `#${c.seed}`) : '');
  const side = (c, lost) => `<div class="side ${lost ? 'lost' : ''}">
      ${avatar(c.isUser ? '' : BADGE(c.id), c.abbr)}
      <span>${esc(name(c))}</span><span class="dim" style="font-size:10px">${seedOf(c)}</span>
    </div>`;
  const head = (round, conf) => `<div class="eyebrow" style="margin-bottom:4px">`
    + `${round}${conf && conf !== 'Cup' ? ` · ${conf}` : ''}</div>`;
  const involved = isUser(t.high) || isUser(t.low) || isUser(t.host) || isUser(t.away);

  if (t.games) { // best-of-three
    const loser = t.winner === t.high ? t.low : t.high;
    const [a, b] = t.series.split('-').map(Number);
    const legs = t.games.map((g, i) => `
      <div class="leg">
        <div class="leg-head">Game ${i + 1} · ${g.highHosts ? esc(t.high.abbr) : esc(t.low.abbr)}
          <b class="mono">${g.highGoals}–${g.lowGoals}</b>${g.pens ? ' <span class="dim">(pens)</span>' : ''}</div>
        ${gameGoals(g.highScorers, isUser(t.high))}
        ${gameGoals(g.lowScorers, isUser(t.low))}
      </div>`).join('');
    return `<div class="tie ${involved ? 'you' : ''}">
      <div class="tie-top">
        <div>${head(t.round, t.conf)}${side(t.winner, false)}${side(loser, true)}</div>
        <div class="meta">${Math.max(a, b)}–${Math.min(a, b)}<br>series</div>
      </div>
      <div class="legs">${legs}</div>
    </div>`;
  }
  const loser = t.winner === t.host ? t.away : t.host;
  const wg = t.winner === t.host ? t.hg : t.ag;
  const lg = t.winner === t.host ? t.ag : t.hg;
  // A goalless tie has nothing to list -- skip the block rather than draw an
  // empty divider.
  const goals = gameGoals(t.hostScorers, isUser(t.host))
    + gameGoals(t.awayScorers, isUser(t.away));
  return `<div class="tie ${involved ? 'you' : ''}">
    <div class="tie-top">
      <div>${head(t.round, t.conf)}${side(t.winner, false)}${side(loser, true)}</div>
      <div class="meta">${wg}–${lg}<br>${t.pens ? 'on pens' : `at ${esc(t.host.abbr)}`}</div>
    </div>
    ${goals ? `<div class="legs"><div class="leg">${goals}</div></div>` : ''}
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
        <div><div class="eyebrow">Squad g+</div>
          <b class="mono" style="font-size:18px">${r.strength > 0 ? '+' : ''}${r.strength.toFixed(1)}</b></div>
        <div style="text-align:right"><div class="eyebrow">Best pick</div>
          <b style="font-size:14px">${esc(best.name)}</b>
          <div class="dim" style="font-size:11px">${best.season} · +${best.score.toFixed(2)}</div></div>
      </div>
    </div>

    ${awardsCard(r.awards, 'Regular-season leaders')}
    ${S.coach ? `<div style="margin-top:12px">${coachCard(S.coach, false)}</div>` : ''}
    <div style="margin-top:12px">${squadPane(false)}</div>

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
  const top = r.awards.allScorers[0];
  return [
    `Road to 75 ⚽ ${DIFFICULTIES[S.difficulty].label} · ${S.formation}`
      + (S.coach ? ` · ${S.coach.name}` : ''),
    `${r.points} pts · ${cup}${r.won ? ' · IMMORTAL 👑' : ''}`,
    ...rows,
    top ? `⚽ ${shortName(top.name)} ${top.goals}` : '',
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
