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
      teamId: s.t,
      season: s.s,
      projected: s.s === currentSeason,
    })).sort((a, b) => b.score - a.score),
  }));
  return { spins, teams, currentSeason };
}

/**
 * Draw a spin the player can actually use.
 *
 * A spin offering no legal pick (everyone is the wrong position, already
 * drafted, or blocked by the DP cap) is dead: we discard it and draw again for
 * free, so a dead spin can never cost a reroll or soft-lock the draft.
 */
export function drawSpin(pool, squad, pickedIds, rng) {
  const skipped = [];
  for (let i = 0; i < 500; i++) {
    const spin = pick(pool.spins, rng);
    if (hasEligiblePick(spin.roster, squad, pickedIds)) {
      return { spin, skipped };
    }
    skipped.push(spin);
  }
  // Exhaustive fallback: scan the whole pool rather than ever returning null.
  const usable = pool.spins.filter((s) => hasEligiblePick(s.roster, squad, pickedIds));
  return { spin: usable.length ? pick(usable, rng) : null, skipped };
}

/** Annotate a roster with pick eligibility for rendering. */
export function annotate(roster, squad, pickedIds) {
  return roster.map((p) => ({ ...p, blocked: blockReason(p, squad, pickedIds) }));
}
