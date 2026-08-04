// How close a draft came to the best squad those particular spins allowed.
//
// The spins a player is dealt are fixed once they happen, so "optimal" has a
// precise meaning: over the same 14 boards, the assignment of one player per
// spin to one slot each that maximises squad strength. With 14 of each that is
// small enough to solve exactly -- a DP over which slots are filled, 2^14
// states -- rather than approximated with a greedy pass, which can be beaten
// and would make the percentage meaningless.

import { canPlay, effectiveScore } from './rules.js';
import { STARTER_WEIGHT, SUB_WEIGHT } from './sim.js';

const weightOf = (slot) => (slot.starter ? STARTER_WEIGHT : SUB_WEIGHT);

const NEG = -Infinity;

/**
 * Best value available in each (board, slot) pair, split by whether taking it
 * spends a Designated Player slot. Keeping the two apart lets the solver
 * respect the same DP limit the player was drafting under, so the benchmark
 * is a squad they could actually have built.
 */
function valueTable(spins, slots, sign) {
  return spins.map((spin) => slots.map((slot) => {
    let plain = NEG;
    let dp = NEG;
    for (const p of spin.roster) {
      if (!canPlay(p, slot.pos)) continue;
      const v = sign * effectiveScore(p, slot.pos) * weightOf(slot);
      if (p.dp) { if (v > dp) dp = v; } else if (v > plain) plain = v;
    }
    return { plain, dp };
  }));
}

/**
 * Solve the assignment: one player per board, one per slot, maximising
 * (or with sign -1, minimising) squad strength within the DP limit.
 *
 * dp[mask][d] = best total having used the first popcount(mask) boards to
 * fill exactly the slots in mask, having spent d Designated Player slots.
 */
function solve(spins, squad, maxDPs, sign) {
  const slots = squad;
  const n = slots.length;
  if (spins.length !== n || n === 0 || n > 20) return null;
  const caps = Number.isFinite(maxDPs) ? Math.min(maxDPs, n) : n;
  const lanes = caps + 1;

  const value = valueTable(spins, slots, sign);
  const size = 1 << n;
  const best = new Float64Array(size * lanes).fill(NEG);
  best[0] = 0;

  for (let mask = 0; mask < size; mask++) {
    let i = 0;
    for (let m = mask; m; m >>= 1) i += m & 1;
    if (i >= n) continue;
    const row = value[i];
    for (let d = 0; d < lanes; d++) {
      const here = best[mask * lanes + d];
      if (here === NEG) continue;
      for (let j = 0; j < n; j++) {
        if (mask & (1 << j)) continue;
        const cell = row[j];
        const next = (mask | (1 << j)) * lanes;
        if (cell.plain !== NEG) {
          const t = here + cell.plain;
          if (t > best[next + d]) best[next + d] = t;
        }
        if (cell.dp !== NEG && d + 1 < lanes) {
          const t = here + cell.dp;
          if (t > best[next + d + 1]) best[next + d + 1] = t;
        }
      }
    }
  }
  let out = NEG;
  for (let d = 0; d < lanes; d++) {
    const v = best[(size - 1) * lanes + d];
    if (v > out) out = v;
  }
  return out === NEG ? null : sign * out;
}

/** Best squad strength obtainable from `spins` across `squad`'s slots. */
export function optimalStrength(spins, squad, maxDPs = Infinity) {
  return solve(spins, squad, maxDPs, 1);
}

/**
 * How close the drafted squad came, as a percentage.
 *
 * Measured against the worst assignment as well as the best, so the number
 * says where the draft landed in the range those boards actually offered.
 * A straight actual/best ratio breaks down whenever either figure is negative,
 * which a poor draft easily manages.
 */
export function draftEfficiency(spins, squad, actual, maxDPs = Infinity) {
  const best = optimalStrength(spins, squad, maxDPs);
  if (best === null) return null;
  const worst = solve(spins, squad, maxDPs, -1);
  if (worst === null || best - worst < 1e-9) return { pct: 100, best, worst };
  const pct = ((actual - worst) / (best - worst)) * 100;
  return { pct: Math.max(0, Math.min(100, pct)), best, worst };
}
