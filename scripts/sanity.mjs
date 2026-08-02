// Headless calibration + balance check for the sim engine.
//
//   npm run sanity            -- full report
//   npm run sanity -- tune    -- re-solve K_STRENGTH against the fitted line
//
// Imports the same modules the browser runs, so what passes here is what ships.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeSquad, MAX_DPS, SQUAD_SIZE } from '../src/rules.js';
import { loadPool, makeRng, drawSpin } from '../src/pool.js';
import { openSlotsFor, blockReason } from '../src/rules.js';
import {
  simSeason, simMatch, squadStrength, K_STRENGTH, SEASON_GAMES, TARGET_POINTS,
} from '../src/sim.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, '..', 'public', 'data', f)));
const pool = loadPool(read('pool.json'));
const sim = read('sim.json');
const { a, b, sigma } = sim.model;

const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
const sd = (v) => Math.sqrt(mean(v.map((x) => (x - mean(v)) ** 2)));
const quant = (v, q) => [...v].sort((x, y) => x - y)[Math.floor(q * (v.length - 1))];
const FORMATIONS = ['4-3-3', '4-4-2', '4-2-3-1', '3-5-2', '5-3-2'];

// ---------------------------------------------------------------- draft bots

/**
 * Run a full 14-pick draft.
 *   strategy 'random' -- pick a legal player at random (a careless drafter)
 *   strategy 'greedy' -- always take the highest-scoring legal player
 *   strategy 'good'   -- take the best of a random 3 (a decent human)
 */
function draft(strategy, rng, rerolls = 3) {
  const formation = FORMATIONS[Math.floor(rng() * FORMATIONS.length)];
  const squad = makeSquad(formation);
  const picked = new Set();
  let dead = 0;

  for (let n = 0; n < SQUAD_SIZE; n++) {
    const { spin, skipped } = drawSpin(pool, squad, picked, rng);
    dead += skipped.length;
    if (!spin) throw new Error(`draft soft-locked after ${n} picks`);

    const legal = spin.roster.filter((p) => blockReason(p, squad, picked) === null);
    if (!legal.length) throw new Error('drawSpin returned a spin with no legal pick');

    let choice;
    if (strategy === 'greedy') {
      choice = legal[0]; // roster is score-sorted
    } else if (strategy === 'good') {
      const sample = [0, 1, 2].map(() => legal[Math.floor(rng() * legal.length)]);
      choice = sample.sort((x, y) => y.score - x.score)[0];
    } else {
      choice = legal[Math.floor(rng() * legal.length)];
    }

    const slots = openSlotsFor(choice, squad);
    // Prefer a starting slot; only bench a player when nothing else is open.
    const slot = slots.find((s) => s.starter) || slots[0];
    slot.player = choice;
    picked.add(choice.id);
  }
  const dps = squad.filter((s) => s.player.dp).length;
  if (dps > MAX_DPS) throw new Error(`DP cap breached: ${dps}`);
  if (squad.some((s) => !s.player)) throw new Error('squad not filled');
  return { squad, formation, dead };
}

// ------------------------------------------------------- K_STRENGTH tuning

/** Mean season points from match sim for a side of the given per-game edge. */
function pointsFromMatchSim(spg, k, rng, runs = 400) {
  const pts = [];
  for (let r = 0; r < runs; r++) {
    let p = 0;
    for (let g = 0; g < SEASON_GAMES; g++) {
      const home = g % 2 === 0;
      // temporarily swap in the trial k
      const edge = (k * (home ? spg : -spg)) / 2 + 0.2494 / 2;
      const lh = Math.max(0.2, 1.4 * Math.exp(edge));
      const la = Math.max(0.2, 1.4 * Math.exp(-edge));
      const pois = (l) => { const L = Math.exp(-l); let n = 0; let q = 1; do { n++; q *= rng(); } while (q > L); return n - 1; };
      const hg = pois(lh); const ag = pois(la);
      const gf = home ? hg : ag; const ga = home ? ag : hg;
      if (gf > ga) p += 3; else if (gf === ga) p += 1;
    }
    pts.push(p);
  }
  return { mean: mean(pts), sd: sd(pts) };
}

function tune() {
  const rng = makeRng(7);
  const grid = [];
  for (let k = 0.20; k <= 0.80; k += 0.005) {
    let err = 0;
    for (const spg of [-0.6, -0.3, 0, 0.3, 0.6, 0.9, 1.2]) {
      const target = SEASON_GAMES * (a + b * spg);
      err += (pointsFromMatchSim(spg, k, rng, 150).mean - target) ** 2;
    }
    grid.push([k, err]);
  }
  grid.sort((x, y) => x[1] - y[1]);
  console.log(`best K_STRENGTH = ${grid[0][0].toFixed(3)} (sq err ${grid[0][1].toFixed(1)})`);
  return grid[0][0];
}

// ---------------------------------------------------------------- reporting

function checkCalibration(k) {
  console.log('\n== match sim vs fitted line ==');
  console.log('  spg   model pts   sim pts   sim sd');
  const rng = makeRng(11);
  for (const spg of [-0.6, -0.3, 0, 0.3, 0.6, 0.9, 1.2]) {
    const target = SEASON_GAMES * (a + b * spg);
    const got = pointsFromMatchSim(spg, k, rng, 600);
    console.log(`  ${spg.toFixed(2).padStart(5)}   ${target.toFixed(1).padStart(9)}   `
      + `${got.mean.toFixed(1).padStart(7)}   ${got.sd.toFixed(1).padStart(6)}`);
  }
  console.log(`  fitted residual sd = ${(sigma * SEASON_GAMES).toFixed(1)} pts `
    + '(match randomness alone should be close to this)');
}

function runBatch(strategy, runs, seed0) {
  const out = { pts: [], strength: [], cup: 0, playoffs: 0, wins: 0, dead: 0, dps: [] };
  for (let i = 0; i < runs; i++) {
    const rng = makeRng(seed0 + i);
    const { squad, dead } = draft(strategy, rng);
    const res = simSeason({
      squad,
      opponents: sim.opponents,
      conference: i % 2 ? 'East' : 'West',
      teamName: 'Test FC',
      rng,
    });
    out.pts.push(res.points);
    out.strength.push(squadStrength(squad).spg);
    out.dead += dead;
    out.dps.push(squad.filter((s) => s.player.dp).length);
    if (res.madePlayoffs) out.playoffs++;
    if (res.wonCup) out.cup++;
    if (res.won) out.wins++;
  }
  return out;
}

function report(label, r, runs) {
  console.log(`  ${label.padEnd(8)} spg med ${quant(r.strength, 0.5).toFixed(2).padStart(5)}`
    + `  pts med ${quant(r.pts, 0.5).toString().padStart(3)}`
    + `  p90 ${quant(r.pts, 0.9).toString().padStart(3)}`
    + `  max ${Math.max(...r.pts).toString().padStart(3)}`
    + `  playoffs ${((r.playoffs / runs) * 100).toFixed(0).padStart(3)}%`
    + `  cup ${((r.cup / runs) * 100).toFixed(0).padStart(3)}%`
    + `  75+&cup ${((r.wins / runs) * 100).toFixed(1).padStart(4)}%`);
}

function main() {
  if (process.argv.includes('tune')) { tune(); return; }

  console.log(`pool: ${pool.spins.length} team-seasons`);
  console.log(`model: ppg = ${a} + ${b} * spg,  sigma ${sigma}`);
  console.log(`K_STRENGTH = ${K_STRENGTH}`);
  checkCalibration(K_STRENGTH);

  const runs = 500;
  console.log(`\n== ${runs} drafts per strategy ==`);
  const results = {};
  for (const [label, strat, seed] of [
    ['random', 'random', 1000], ['decent', 'good', 5000], ['optimal', 'greedy', 9000],
  ]) {
    results[label] = runBatch(strat, runs, seed);
    report(label, results[label], runs);
  }

  console.log('\n== checks ==');
  const R = results.random; const G = results.optimal; const D = results.decent;
  const medRandom = quant(R.pts, 0.5);
  const ok = [];
  ok.push(['random draft median in 40-50 pts', medRandom >= 40 && medRandom <= 50, medRandom]);
  ok.push(['random draft essentially never wins', R.wins / runs < 0.02, `${((R.wins / runs) * 100).toFixed(1)}%`]);
  ok.push(['optimal draft can reach 75+', Math.max(...G.pts) >= TARGET_POINTS, Math.max(...G.pts)]);
  ok.push(['optimal draft win rate is a real but hard shot',
    G.wins / runs > 0.01 && G.wins / runs < 0.55, `${((G.wins / runs) * 100).toFixed(1)}%`]);
  ok.push(['decent draft sits between the two',
    quant(D.pts, 0.5) >= medRandom && quant(D.pts, 0.5) <= quant(G.pts, 0.5), quant(D.pts, 0.5)]);
  ok.push(['DP cap never breached', [...R.dps, ...G.dps].every((d) => d <= MAX_DPS), Math.max(...G.dps)]);
  ok.push(['no draft soft-locked', true, `${R.dead + G.dead + D.dead} free respins`]);

  let failed = 0;
  for (const [name, pass, val] of ok) {
    if (!pass) failed++;
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}  (${val})`);
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
}

main();
