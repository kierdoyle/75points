// Shared rendering: the DOM helpers and the three pieces of markup that both
// the solo game and the draft rooms draw -- a player row, a pitch slot, and a
// coach card.
//
// Everything here takes what it needs as arguments. Nothing reaches for game
// state, which is what lets a room render another member's squad next to your
// own without the two fighting over whose turn it is to be "the" squad.

import {
  SLOT_LABEL, SIDE_LABEL, fitFor, effectiveScore, isVersatile,
} from './rules.js';

// ASA's public image buckets. Never bundled -- hotlinked, with a monogram
// fallback for the occasional 404 (see avatar()/setAvatar()).
export const BADGE = (id) => `https://american-soccer-analysis-headshots.s3.amazonaws.com/club_logos/${id}.png`;
export const HEAD = (id) => `https://american-soccer-analysis-headshots.s3.us-east-1.amazonaws.com/player_headshots/${id}.png`;
// American Soccer Analysis: the source of every rating in the game, and the
// livery it borrows. Hotlinked like the badges and headshots.
export const ASA_SITE = 'https://www.americansocceranalysis.com/';
export const ASA_LOGO = 'https://images.squarespace-cdn.com/content/v1/5352fb7ce4b0bf79997bfc81/1435180609079-51SLX979FJ44N8A4R9PG/banner-03.png?format=750w';
export const ASA_CREST = 'https://images.squarespace-cdn.com/content/v1/5352fb7ce4b0bf79997bfc81/1519766680781-9RQ0CQXJH5H4JBRNBBQ3/asa-logo.png?format=300w';

export const app = document.getElementById('app');

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export const initials = (name) => name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

// Particles that belong with the surname on the pitch label ("St. Clair",
// "van der Water") rather than being stripped off with the given name.
const PARTICLES = new Set(['st.', 'st', 'de', 'del', 'della', 'di', 'da', 'dos', 'du',
  'van', 'von', 'der', 'den', 'la', 'le', 'mc', 'o', "o'"]);

export function shortName(name) {
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
export function nameSize(label) {
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
export function setAvatar(node, url, fallback) {
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

export function avatar(url, fallback, cls = '') {
  let hue = 0;
  for (const ch of fallback) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  const src = url ? ` data-img="${esc(url)}"` : '';
  return `<div class="avatar ${cls}"${src} style="background:hsl(${hue} 32% 26%)">${esc(fallback)}</div>`;
}

export function mountAvatars(root = app) {
  root.querySelectorAll('.avatar[data-img]').forEach((node) => {
    const url = node.dataset.img;
    delete node.dataset.img;
    setAvatar(node, url, node.textContent.trim());
  });
}

export function render(html, keepScroll = false) {
  app.innerHTML = html;
  mountAvatars();
  if (!keepScroll) window.scrollTo({ top: 0 });
}

export function toast(msg) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}

export const on = (sel, ev, fn) => app.querySelectorAll(sel).forEach((n) => n.addEventListener(ev, fn));


// ---------------------------------------------------------------- markup

export const sideTag = (p) => (p.side ? `<span class="pill side">${SIDE_LABEL[p.side]}</span>` : '');

export function playerRow(p, { hidden = false, showSalary = false } = {}) {
  const cls = p.blocked ? 'blocked' : (p.score >= 0 ? 'pos-score' : 'neg-score');
  return `
    <button class="pl ${cls}" data-pid="${p.id}" ${p.blocked ? 'disabled' : ''}>
      ${avatar(HEAD(p.id), initials(p.name), 'head round')}
      <div class="who">
        <div class="nm">${esc(p.name)}</div>
        <div class="sub">
          <span>${p.pos}</span>${sideTag(p)}
          <span>·</span><span>${p.minutes.toLocaleString()}′</span>
          ${showSalary ? `<span>· ${moneyShort(p.salary)}</span>` : ''}
          ${p.dp ? '<span class="pill dp">DP</span>' : ''}
          ${isVersatile(p) ? `<span class="pill versatile" title="${esc(p.positions.join(' / '))}">Versatile</span>` : ''}
          ${p.blocked ? `<span class="pill">${esc(p.blocked)}</span>` : ''}
        </div>
      </div>
      <div class="sc">${hidden ? '<span class="dim">–</span>' : gplus(p.score)}<small>g+</small></div>
    </button>`;
}

export function pitchSlot(s, bench, interactive, from, targets, hidden = false) {
  const style = bench ? '' : `style="left:${s.x}%;bottom:${s.y}%"`;
  if (!s.player) {
    return `<div class="slot empty" ${style}>
      <div class="avatar round"></div><div class="lbl">${SLOT_LABEL[s.pos]}</div></div>`;
  }
  const p = s.player;
  const fit = fitFor(p, s.pos);
  const pen = fit && fit.penalty ? `<span class="pen">−${(fit.penalty * 100).toFixed(0)}%</span>` : '';
  const eff = effectiveScore(p, s.pos);
  const tip = hidden ? `${p.name} · ${p.season}`
    : `${p.name} · ${p.season} · ${gplus(eff)} g+`;
  const cls = [
    'slot',
    s.justFilled ? 'filling' : '',
    interactive ? 'tappable' : '',
    from && from.id === s.id ? 'picked' : '',
    from && targets.has(s.id) ? 'target' : '',
    from && from.id !== s.id && !targets.has(s.id) ? 'faded' : '',
  ].filter(Boolean).join(' ');
  return `<div class="${cls}" ${style} data-slot="${s.id}" title="${esc(tip)}">
    ${avatar(HEAD(p.id), initials(p.name), 'head round')}
    <div class="lbl">${SLOT_LABEL[s.pos]}${pen}</div>
    <div class="nm2 ${nameSize(shortName(p.name))}">${esc(shortName(p.name))}</div>
    <div class="yr">${p.season}${hidden ? '' : ` · ${gplus(eff)}`}</div>
  </div>`;
}

export function coachCard(c, selectable, hidden = false) {
  // Shown as a plain 0-100 percentile rank rather than the resulting boost.
  const bar = (label, v) => `
    <div class="crow">
      <span class="clab">${label}</span>
      <span class="cbar"><i style="width:${hidden ? 100 : Math.max(3, v * 100)}%;
        background:${hidden ? 'var(--line)' : (v >= 0.5 ? 'var(--accent)' : 'var(--red)')}"></i></span>
      <b class="mono ${v >= 0.5 ? 'up' : 'down'}">${hidden ? '?' : Math.round(v * 100)}</b>
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


// Formatting shared by every screen that shows a rating or a salary.
export const gplus = (v) => (v > 0 ? '+' : '') + v.toFixed(2);
export const money = (n) => `$${(n / 1e6).toFixed(2)}M`;
export const moneyShort = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1000)}k`);
