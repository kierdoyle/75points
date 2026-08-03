// Draws the finished season as a shareable PNG.
//
// Everything is painted by hand rather than screenshotting the DOM: ASA's
// image buckets send no Access-Control-Allow-Origin header, so any badge or
// headshot drawn onto a canvas would taint it and make toBlob throw. A
// purpose-built card avoids that entirely, needs no dependency, and reads
// better than a page capture anyway.

import { SLOT_LABEL, effectiveScore } from './rules.js';
import { LEAGUE } from './sim.js';

const C = {
  bg: '#ffffff',
  panel: '#f2f7fa',
  line: '#d7e3ea',
  text: '#0a0a0a',
  muted: '#4a5b66',
  dim: '#7d8f9b',
  accent: '#20b0e0',
  accentDim: '#1789b0',
  red: '#c02030',
  gold: '#e8a317',
};
const FONT = '"proxima-nova", "Proxima Nova", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const W = 1000;
const PAD = 48;

const font = (size, weight = 400) => `${weight} ${size}px ${FONT}`;

/**
 * Render the season to a PNG blob.
 * `state` is the live game state; `season` the finished simulation.
 */
export async function buildCard(data) {
  const dpr = 2;
  // Two passes: the first measures how tall the content actually is, the
  // second paints it at exactly that height. Guessing leaves dead space at
  // the bottom, which looks broken when the card is shared.
  const probe = document.createElement('canvas').getContext('2d');
  const height = paint(probe, data, 4000) + FOOTER;

  const canvas = document.createElement('canvas');
  canvas.width = W * dpr;
  canvas.height = height * dpr;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  paint(g, data, height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

const FOOTER = 76;

/** Paint the card; returns the y the content ended at. */
function paint(g, { season, squad, teamName, difficulty, coach, achievements }, height) {
  const rows = squad.filter((s) => s.player);
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';

  g.fillStyle = C.bg;
  g.fillRect(0, 0, W, height);

  let y = 0;

  // ---- header band
  g.fillStyle = C.panel;
  g.fillRect(0, 0, W, 190);
  g.fillStyle = C.accent;
  g.fillRect(0, 0, W, 8);

  g.fillStyle = C.dim;
  g.font = font(20, 700);
  g.fillText(`${LEAGUE.name.toUpperCase()} · ${difficulty.toUpperCase()}`, PAD, 62);

  g.fillStyle = C.text;
  g.font = font(50, 900);
  g.fillText(teamName, PAD, 116);

  g.fillStyle = C.muted;
  g.font = font(22, 500);
  const rec = season.userRecord;
  g.fillText(`${rec.w}W–${rec.d}D–${rec.l}L · ${rec.gf}:${rec.ga} · ${season.madePlayoffs ? `#${season.seed} seed` : 'missed the playoffs'}`,
    PAD, 154);

  // big points figure, right-aligned
  g.textAlign = 'right';
  g.fillStyle = season.won ? C.gold : C.accent;
  g.font = font(84, 900);
  g.fillText(String(season.points), W - PAD, 128);
  g.fillStyle = C.dim;
  g.font = font(20, 700);
  g.fillText(`of ${LEAGUE.target}`, W - PAD, 156);
  g.textAlign = 'left';

  y = 240;

  // ---- verdict
  g.fillStyle = season.won ? C.gold : C.text;
  g.font = font(34, 900);
  g.fillText(verdict(season), PAD, y);
  y += 26;
  g.fillStyle = C.muted;
  g.font = font(20, 500);
  g.fillText(season.wonCup ? `${LEAGUE.cupName} champions`
    : `${season.playoffs.champion.short} won the ${LEAGUE.cupName}`, PAD, y + 8);
  y += 54;

  // ---- the season, one square per match
  const box = (W - PAD * 2 - (season.results.length - 1) * 4) / season.results.length;
  season.results.forEach((r, i) => {
    g.fillStyle = r.result === 'W' ? C.accent : r.result === 'D' ? C.gold : C.red;
    g.globalAlpha = r.result === 'L' ? 0.55 : 1;
    g.fillRect(PAD + i * (box + 4), y, box, 22);
  });
  g.globalAlpha = 1;
  y += 58;

  // ---- squad
  y = section(g, 'SQUAD', y);
  g.font = font(19, 500);
  for (const slot of rows) {
    const p = slot.player;
    const eff = effectiveScore(p, slot.pos);
    g.fillStyle = C.dim;
    g.font = font(16, 800);
    g.fillText(SLOT_LABEL[slot.pos], PAD, y);
    g.fillStyle = slot.starter ? C.text : C.muted;
    g.font = font(20, slot.starter ? 700 : 500);
    g.fillText(p.name, PAD + 92, y);
    g.fillStyle = C.dim;
    g.font = font(18, 500);
    g.fillText(String(p.season), PAD + 560, y);
    g.textAlign = 'right';
    g.fillStyle = eff >= 0 ? C.accentDim : C.red;
    g.font = font(20, 800);
    g.fillText(`${eff > 0 ? '+' : ''}${eff.toFixed(2)}`, W - PAD, y);
    g.textAlign = 'left';
    y += 38;
  }
  y += 14;

  // ---- coach
  if (coach) {
    y = section(g, 'HEAD COACH', y);
    g.fillStyle = C.text;
    g.font = font(22, 700);
    g.fillText(coach.name, PAD, y);
    g.fillStyle = C.muted;
    g.font = font(18, 500);
    g.fillText(`attack ${Math.round(coach.off * 100)} · defence ${Math.round(coach.def * 100)}`
      + (coach.cups ? ' · 🏆' : '') + (coach.shields ? ' · 🛡' : ''), PAD + 320, y);
    y += 48;
  }

  // ---- achievements
  if (achievements.length) {
    y = section(g, `ACHIEVEMENTS · ${achievements.length}`, y);
    for (const a of achievements) {
      g.fillStyle = a.tier === 'legendary' ? C.gold : a.tier === 'gold' ? C.accentDim : C.text;
      g.font = font(20, 800);
      g.fillText(a.name, PAD, y);
      g.fillStyle = C.dim;
      g.font = font(17, 500);
      g.textAlign = 'right';
      g.fillText(a.note, W - PAD, y);
      g.textAlign = 'left';
      y += 34;
    }
    y += 14;
  }

  // ---- leaders
  const top = season.awards.scorers[0];
  const topA = season.awards.assisters[0];
  if (top || topA) {
    y = section(g, 'LEADERS', y);
    g.font = font(20, 500);
    g.fillStyle = C.text;
    if (top) g.fillText(`${top.name} — ${top.goals} goals`, PAD, y);
    if (topA) g.fillText(`${topA.name} — ${topA.assists} assists`, PAD + 480, y);
    y += 46;
  }

  // ---- footer
  g.fillStyle = C.panel;
  g.fillRect(0, height - FOOTER, W, FOOTER);
  g.fillStyle = C.dim;
  g.font = font(17, 500);
  g.fillText(`Road to ${LEAGUE.target} · data from American Soccer Analysis`, PAD, height - 30);
  g.textAlign = 'right';
  g.fillStyle = C.accent;
  g.font = font(17, 800);
  g.fillText('americansocceranalysis.com', W - PAD, height - 30);
  g.textAlign = 'left';

  return y;
}

function section(g, label, y) {
  g.fillStyle = C.line;
  g.fillRect(PAD, y - 4, W - PAD * 2, 1);
  g.fillStyle = C.dim;
  g.font = font(15, 800);
  g.fillText(label, PAD, y + 26);
  return y + 62;
}

function verdict(r) {
  if (r.won) return 'IMMORTAL';
  if (r.wonCup) return `Champions — short of ${LEAGUE.target}`;
  if (r.points >= LEAGUE.target) return `${r.points} points, no trophy`;
  return r.madePlayoffs ? 'Not this time' : 'Missed the playoffs';
}
