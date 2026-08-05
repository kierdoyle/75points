// Turns the compact pool.json payload into game objects, and drives spins.

import { blockReason, hasEligiblePick } from './rules.js';

/** Small seedable PRNG so a season can be replayed / tested deterministically. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];

/**
 * Expand pool.json. Each spin is a (team, season) pair with its roster;
 * roster rows are [player_id, posIdx, score, minutes, isDP].
 */
export function loadPool(raw) {
  const { positions, names, teams, currentSeason } = raw;
  const careers = raw.careers || {};
  // careers[id] packs (position bitmask << 2) | flank bitmask.
  const careerPos = (id) => {
    const bits = (careers[id] || 0) >> 2;
    return positions.filter((_, i) => bits & (1 << i));
  };
  const careerSides = (id) => {
    const bits = (careers[id] || 0) & 3;
    return [1, 2].filter((s) => bits & (1 << (s - 1)));
  };

  const spins = raw.spins.map((s) => ({
    teamId: s.t,
    season: s.s,
    projected: s.s === currentSeason,
    team: teams[s.t],
    roster: s.r.map((p) => ({
      id: p[0],
      name: names[p[0]] || 'Unknown',
      pos: positions[p[1]],
      score: p[2],
      minutes: p[3],
      dp: p[4] === 1,
      side: p[5],   // 0 both/unknown, 1 left, 2 right
      g90: p[6],
      a90: p[7],
      salary: p[8] * 1000,
      age: p[9],
      positions: careerPos(p[0]),
      sides: careerSides(p[0]),
      teamId: s.t,
      season: s.s,
      projected: s.s === currentSeason,
    })).sort((a, b) => b.score - a.score),
  }));
  return { spins, teams, currentSeason };
}

/** Current-season squads keyed by club, used to name opposition scorers. */
export function currentRosters(pool) {
  const by = {};
  for (const s of pool.spins) {
    if (s.season === pool.currentSeason) by[s.teamId] = s.roster;
  }
  return by;
}

/** Identity of a spin: one club's one season, the thing that can't repeat. */
export const spinKey = (spin) => `${spin.teamId}|${spin.season}`;

/**
 * Draw a spin the player can actually use.
 *
 * A spin offering no legal pick (everyone is the wrong position, already
 * drafted, or blocked by the DP cap) is dead: we discard it and draw again for
 * free, so a dead spin can never cost a reroll or soft-lock the draft.
 *
 * `seen` holds the spinKey of every board already shown this run, rerolled
 * ones included, so no club-season comes up twice. Repeats are passed over
 * silently rather than counted as dead spins.
 */
export function drawSpin(pool, squad, pickedIds, rng, rules, seen = null) {
  const fresh = (s) => !seen || !seen.has(spinKey(s));
  const usable = (s) => hasEligiblePick(s.roster, squad, pickedIds, rules);
  const skipped = [];
  for (let i = 0; i < 500; i++) {
    const spin = pick(pool.spins, rng);
    if (!fresh(spin)) continue;
    if (usable(spin)) return { spin, skipped };
    skipped.push(spin);
  }
  // Exhaustive fallback: scan the whole pool rather than ever returning null.
  // A pool too small to keep every board unique gives up the no-repeat rule
  // before it gives up the draft.
  const pickable = pool.spins.filter((s) => fresh(s) && usable(s));
  const any = pickable.length ? pickable : pool.spins.filter(usable);
  return { spin: any.length ? pick(any, rng) : null, skipped };
}

/** Annotate a roster with pick eligibility for rendering. */
export function annotate(roster, squad, pickedIds, rules) {
  return roster.map((p) => ({ ...p, blocked: blockReason(p, squad, pickedIds, rules) }));
}
