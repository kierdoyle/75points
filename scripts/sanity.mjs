// Headless calibration + balance check for the sim engine.
//
//   npm run sanity            -- full report
//   npm run sanity -- tune    -- re-solve K_STRENGTH against the fitted line
//
// Imports the same modules the browser runs, so what passes here is what ships.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  makeSquad, MAX_DPS, SQUAD_SIZE, FORMATIONS, SLOTS, DIFFICULTIES, budget,
  SALARY_CAP, ALLOCATION_MONEY, rulesFor,
} from '../src/rules.js';
import { achievements } from '../src/achievements.js';
import { loadPool, makeRng, drawSpin, currentRosters } from '../src/pool.js';
import { openSlotsFor, blockReason, effectiveScore } from '../src/rules.js';
import {
  simSeason, simMatch, squadStrength, LEAGUE, configureLeague,
} from '../src/sim.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, '..', 'public', 'data', f)));

// `npm run sanity -- nwsl` checks the other league.
const LEAGUE_KEY = process.argv.find((a) => a === 'nwsl') ? 'nwsl' : 'mls';
const FILES = LEAGUE_KEY === 'nwsl'
  ? ['nwsl-pool.json', 'nwsl-sim.json'] : ['pool.json', 'sim.json'];
const pool = loadPool(read(FILES[0]));
const sim = read(FILES[1]);
configureLeague({
  key: sim.league, name: sim.name, games: sim.games, target: sim.target,
  conferences: sim.conferences, cupName: sim.cupName, shieldName: sim.shieldName,
  records: sim.records, baseGoals: sim.baseGoals, homeLog: sim.homeLog,
  kStrength: sim.kStrength,
});
const CONF = sim.conferences ? ['East', 'West'] : ['League', 'League'];
const rosters = currentRosters(pool);
const { a, b, sigma } = sim.model;

const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
const sd = (v) => Math.sqrt(mean(v.map((x) => (x - mean(v)) ** 2)));
const quant = (v, q) => [...v].sort((x, y) => x - y)[Math.floor(q * (v.length - 1))];
const FORMATION_NAMES = Object.keys(FORMATIONS);

// ---------------------------------------------------------------- draft bots

// A drafter who is paying attention burns a reroll when the board's best
// option, valued in the slot it would actually fill, is below this.
const REROLL_THRESHOLD = 2.0;

/** The best a spin has to offer, after slot penalties. */
function bestScore(legal, squad) {
  let best = -Infinity;
  for (const p of legal) {
    for (const o of openSlotsFor(p, squad)) {
      const sc = effectiveScore(p, o.slot.pos);
      if (sc > best) best = sc;
    }
  }
  return best;
}

/**
 * Run a full 14-pick draft.
 *   strategy 'random' -- pick a legal player at random, never rerolls
 *   strategy 'greedy' -- always take the highest-scoring legal player
 *   strategy 'good'   -- take the best of a random 3 (a decent human)
 *
 * Anyone but the careless drafter spends rerolls on a weak board, so the
 * difficulty modes are actually exercised.
 */
function draft(strategy, rng, rules = DIFFICULTIES.normal) {
  const formation = FORMATION_NAMES[Math.floor(rng() * FORMATION_NAMES.length)];
  const squad = makeSquad(formation);
  const picked = new Set();
  let dead = 0;
  let rerolls = strategy === 'random' ? 0 : rules.rerolls;

  for (let n = 0; n < SQUAD_SIZE; n++) {
    let { spin, skipped } = drawSpin(pool, squad, picked, rng, rules);
    dead += skipped.length;
    if (!spin) throw new Error(`draft soft-locked after ${n} picks (${rules.label})`);

    let legal = spin.roster.filter((p) => blockReason(p, squad, picked, rules) === null);
    while (rerolls > 0 && bestScore(legal, squad) < REROLL_THRESHOLD) {
      rerolls--;
      ({ spin, skipped } = drawSpin(pool, squad, picked, rng, rules));
      dead += skipped.length;
      legal = spin.roster.filter((p) => blockReason(p, squad, picked, rules) === null);
    }
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

    // openSlotsFor is sorted cheapest-penalty first, starters ahead of bench.
    const options = openSlotsFor(choice, squad);
    const slot = (options.find((o) => o.slot.starter) || options[0]).slot;
    slot.player = choice;
    picked.add(choice.id);
  }
  const dps = squad.filter((s) => s.player.dp).length;
  if (dps > rules.maxDPs) throw new Error(`DP cap breached: ${dps} > ${rules.maxDPs}`);
  if (squad.some((s) => !s.player)) throw new Error('squad not filled');
  if (rules.salaryCap && !budget(squad).compliant) {
    throw new Error(`hard-mode squad is not cap compliant`);
  }
  return { squad, formation, dead, dps };
}

// ------------------------------------------------------- K_STRENGTH tuning

/** Mean season points from match sim for a side of the given per-game edge. */
function pointsFromMatchSim(spg, k, rng, runs = 400) {
  const pts = [];
  for (let r = 0; r < runs; r++) {
    let p = 0;
    for (let g = 0; g < LEAGUE.games; g++) {
      const home = g % 2 === 0;
      // temporarily swap in the trial k
      const edge = (k * (home ? spg : -spg)) / 2 + LEAGUE.homeLog / 2;
      const lh = Math.max(0.2, LEAGUE.baseGoals * Math.exp(edge));
      const la = Math.max(0.2, LEAGUE.baseGoals * Math.exp(-edge));
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
      const target = LEAGUE.games * (a + b * spg);
      err += (pointsFromMatchSim(spg, k, rng, 150).mean - target) ** 2;
    }
    grid.push([k, err]);
  }
  grid.sort((x, y) => x[1] - y[1]);
  console.log(`best kStrength for ${LEAGUE.name} = ${grid[0][0].toFixed(3)} (sq err ${grid[0][1].toFixed(1)})`);
  return grid[0][0];
}

// ---------------------------------------------------------------- reporting

function checkCalibration(k) {
  console.log('\n== match sim vs fitted line ==');
  console.log('  spg   model pts   sim pts   sim sd');
  const rng = makeRng(11);
  for (const spg of [-0.6, -0.3, 0, 0.3, 0.6, 0.9, 1.2]) {
    const target = LEAGUE.games * (a + b * spg);
    const got = pointsFromMatchSim(spg, k, rng, 600);
    console.log(`  ${spg.toFixed(2).padStart(5)}   ${target.toFixed(1).padStart(9)}   `
      + `${got.mean.toFixed(1).padStart(7)}   ${got.sd.toFixed(1).padStart(6)}`);
  }
  console.log(`  fitted residual sd = ${(sigma * LEAGUE.games).toFixed(1)} pts `
    + '(match randomness alone should be close to this)');
}

function runBatch(strategy, runs, seed0, rules = DIFFICULTIES.normal) {
  const out = {
    pts: [], strength: [], cup: 0, playoffs: 0, wins: 0, dead: 0, dps: [],
    topScorer: [], topAssist: [], scorerShare: [], achs: [], gam: [],
  };
  for (let i = 0; i < runs; i++) {
    const rng = makeRng(seed0 + i);
    const { squad, dead } = draft(strategy, rng, rules);
    if (rules.salaryCap) out.gam.push(budget(squad).gamUsed);
    // Players are offered three coaches; the greedy bot takes the best of them,
    // the others take one at random.
    const shortlist = [0, 1, 2].map(() => sim.coaches[Math.floor(rng() * sim.coaches.length)]);
    const coach = strategy === 'greedy'
      ? shortlist.sort((x, y) => (y.off + y.def) - (x.off + x.def))[0]
      : shortlist[0];
    const res = simSeason({
      squad,
      opponents: sim.opponents,
      conference: CONF[i % 2],
      teamName: 'Test FC',
      rng,
      rosters,
      coach,
    });
    const scorer = res.awards.scorers[0];
    const assister = res.awards.assisters[0];
    if (scorer && res.userRecord.gf > 0) {
      out.topScorer.push(scorer.goals);
      out.scorerShare.push(scorer.goals / res.userRecord.gf);
    }
    if (assister) out.topAssist.push(assister.assists);
    out.achs.push(achievements(res, squad).length);
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

/**
 * Pitch cards are ~18% of the pitch wide and ~16% tall, so two slots closer
 * than that horizontally must clear it vertically or their photos and names
 * collide.
 */
function checkFormations() {
  const CARD_W = 18; const CARD_H = 17;
  const problems = [];
  for (const [name, slots] of Object.entries(FORMATIONS)) {
    if (slots.length !== 11) problems.push(`${name}: ${slots.length} slots, expected 11`);
    for (const s of slots) {
      if (!SLOTS[s.pos]) problems.push(`${name}: unknown slot ${s.pos}`);
      if (s.y < 6 || s.y > 94 || s.x < 9 || s.x > 91) {
        problems.push(`${name}: ${s.pos} at (${s.x},${s.y}) runs off the pitch`);
      }
    }
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        const a = slots[i]; const b = slots[j];
        if (Math.abs(a.x - b.x) < CARD_W && Math.abs(a.y - b.y) < CARD_H) {
          problems.push(`${name}: ${a.pos}(${a.x},${a.y}) overlaps ${b.pos}(${b.x},${b.y})`);
        }
      }
    }
  }
  return problems;
}

function main() {
  if (process.argv.includes('tune')) { tune(); return; }

  console.log(`${sim.name}: ${pool.spins.length} team-seasons, target ${sim.target} over ${sim.games} games`);
  console.log(`model: ppg = ${a} + ${b} * spg,  sigma ${sigma}`);
  console.log(`kStrength = ${LEAGUE.kStrength}, baseGoals = ${LEAGUE.baseGoals}, homeLog = ${LEAGUE.homeLog}`);
  checkCalibration(LEAGUE.kStrength);

  const runs = 500;
  console.log(`\n== ${runs} drafts per strategy (normal rules) ==`);
  const results = {};
  for (const [label, strat, seed] of [
    ['random', 'random', 1000], ['decent', 'good', 5000], ['optimal', 'greedy', 9000],
  ]) {
    results[label] = runBatch(strat, runs, seed);
    report(label, results[label], runs);
  }

  console.log('\n== difficulty modes (greedy drafter) ==');
  const modes = {};
  for (const [key, seed] of [['easy', 21000], ['normal', 22000], ['hard', 23000]]) {
    modes[key] = runBatch('greedy', runs, seed, rulesFor(key, LEAGUE_KEY));
    report(key, modes[key], runs);
  }
  const H = modes.hard;
  if (H.gam.length) {
    console.log(`  hard mode: cap ${SALARY_CAP.toLocaleString()}, allocation used median `
      + `${quant(H.gam, 0.5).toLocaleString()} / ${ALLOCATION_MONEY.toLocaleString()} `
      + `(max ${Math.max(...H.gam).toLocaleString()})`);
    console.log(`  DPs carried -- easy median ${quant(modes.easy.dps, 0.5)}, `
      + `hard median ${quant(H.dps, 0.5)}`);
  }

  console.log('\n== checks ==');
  const R = results.random; const G = results.optimal; const D = results.decent;
  const medRandom = quant(R.pts, 0.5);
  const ok = [];
  ok.push(['random draft median in 40-50 pts', medRandom >= 40 && medRandom <= 50, medRandom]);
  ok.push(['random draft essentially never wins', R.wins / runs < 0.02, `${((R.wins / runs) * 100).toFixed(1)}%`]);
  ok.push([`optimal draft can reach ${LEAGUE.target}+`, Math.max(...G.pts) >= LEAGUE.target, Math.max(...G.pts)]);
  ok.push(['optimal draft win rate is a real but hard shot',
    G.wins / runs > 0.01 && G.wins / runs < 0.55, `${((G.wins / runs) * 100).toFixed(1)}%`]);
  ok.push(['decent draft sits between the two',
    quant(D.pts, 0.5) >= medRandom && quant(D.pts, 0.5) <= quant(G.pts, 0.5), quant(D.pts, 0.5)]);
  ok.push(['DP cap never breached', [...R.dps, ...G.dps].every((d) => d <= MAX_DPS), Math.max(...G.dps)]);
  ok.push(['no draft soft-locked', true, `${R.dead + G.dead + D.dead} free respins`]);
  const geom = checkFormations();
  ok.push(['formations fit the pitch without overlap', geom.length === 0,
    geom.length ? geom[0] : 'all 5 clean']);

  // Golden Boot realism: the MLS single-season record is 34, and real winners
  // take roughly a quarter to two fifths of their club's goals.
  const gTop = quant(G.topScorer, 0.5);
  const gMax = Math.max(...G.topScorer);
  const share = mean(G.scorerShare);
  // Beating the league's own single-season record should be a rare thrill for
  // an exceptional squad, so judge the shape of the distribution rather than a
  // single noisy tail sample.
  // Judge against the record projected onto this season's length.
  const REC_G = LEAGUE.records.playerGoalsPace || LEAGUE.records.playerGoals;
  const overRecord = G.topScorer.filter((g) => g > REC_G).length / G.topScorer.length;
  ok.push(['top scorer is a believable Golden Boot',
    gTop >= REC_G * 0.3 && gTop <= REC_G * 0.8, `median ${gTop} vs record ${REC_G}`]);
  ok.push(['the goals record rarely falls', overRecord <= 0.06,
    `${(overRecord * 100).toFixed(1)}% of seasons beat ${REC_G}`]);
  ok.push(['no runaway goal tallies', gMax <= REC_G * 1.4, `max ${gMax} vs record ${REC_G}`]);
  ok.push(['one player does not monopolise the goals', share >= 0.18 && share <= 0.36,
    `${(share * 100).toFixed(0)}% of team goals`]);
  ok.push(['top assister is believable', quant(G.topAssist, 0.5) >= 6 && quant(G.topAssist, 0.5) <= 20,
    `median ${quant(G.topAssist, 0.5)}`]);

  // Difficulty modes must actually differ, and hard must stay completable.
  ok.push(['hard mode is harder than normal', quant(H.pts, 0.5) < quant(modes.normal.pts, 0.5),
    `hard ${quant(H.pts, 0.5)} vs normal ${quant(modes.normal.pts, 0.5)} pts`]);
  ok.push(['easy mode is the easiest', quant(modes.easy.pts, 0.5) >= quant(modes.normal.pts, 0.5),
    `easy ${quant(modes.easy.pts, 0.5)} pts`]);
  if (LEAGUE_KEY === 'mls') {
    ok.push(['every hard-mode squad is cap compliant', H.gam.every((g) => g <= ALLOCATION_MONEY),
      `max ${Math.max(...H.gam).toLocaleString()} / ${ALLOCATION_MONEY.toLocaleString()}`]);
    ok.push(['easy mode really is unlimited DPs', Math.max(...modes.easy.dps) > MAX_DPS,
      `max ${Math.max(...modes.easy.dps)} DPs`]);
  } else {
    ok.push(['no DPs or cap outside MLS',
      modes.hard.gam.length === 0 && rulesFor('hard', 'nwsl').maxDPs === Infinity, 'none']);
  }
  ok.push(['achievements fire but stay selective',
    quant(G.achs, 0.5) >= 1 && quant(G.achs, 0.5) <= 8, `median ${quant(G.achs, 0.5)}`]);

  let failed = 0;
  for (const [name, pass, val] of ok) {
    if (!pass) failed++;
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}  (${val})`);
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
}

main();
