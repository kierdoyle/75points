// The daily challenge: one fixed puzzle per league per day.
//
// Everything here is derived from the date, in the browser. No build runs, no
// API call, no stored state -- two people opening the game on the same UTC day
// generate byte-identical challenges from the same pool.json.
//
// A daily board set cannot be drawn the way a normal draft draws: drawSpin
// filters on hasEligiblePick, which depends on the squad so far, so two
// players making different picks would diverge onto different boards. The 14
// boards are therefore drawn up front from the seed alone.
//
// That fixes the boards, which introduces the opposite problem: a fixed set
// can be drafted into a corner, and the daily has no forfeit. The fix is not
// to sample for safety but to make the corner unreachable -- buildDaily only
// ships sets that can be finished from empty, and safeSlots then refuses any
// pick that would leave the rest unfinishable. Together those give an actual
// guarantee that a legal pick exists on every board, not a low probability of
// getting stuck.

import { makeRng, pick, spinKey } from './pool.js';
import {
  FORMATIONS, SQUAD_SIZE, rulesFor, makeSquad, blockReason, openSlotsFor,
  effectiveScore, canPlay,
} from './rules.js';
import { optimalStrength } from './optimal.js';
import { STARTER_WEIGHT, SUB_WEIGHT } from './sim.js';

const FORMATION_NAMES = Object.keys(FORMATIONS);

/** The current challenge date, in UTC so the world plays the same puzzle. */
export function todayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** Yesterday's key, for "you missed it" copy and streak checks. */
export function shiftKey(key, days) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return todayKey(d);
}

/** FNV-1a. Any stable string -> uint32 seed. */
function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Is the rest of the draft still finishable from this state?
 *
 * Answered constructively, by playing the remaining boards out cheapest-first
 * under the real rules. Cheapest-first is the strategy least likely to strand:
 * it hoards cap space, and it only ever fails on position. Finding one
 * completion proves a completion exists, which is all that is being asked.
 *
 * Sufficient, not necessary -- a state it rejects might still be finishable
 * some other way. Erring that direction is the safe one: the worst case is
 * that a pick is disallowed slightly early, never that a player gets stuck.
 */
export function completable(boards, fromIx, squad, picked, rules) {
  const state = squad.map((s) => ({ ...s }));
  const taken = new Set(picked);

  for (let i = fromIx; i < boards.length; i++) {
    let cheapest = null;
    for (const p of boards[i].roster) {
      if (blockReason(p, state, taken, rules) !== null) continue;
      if (!cheapest || p.salary < cheapest.salary) cheapest = p;
    }
    if (!cheapest) return false;
    const opt = openSlotsFor(cheapest, state)[0];
    if (!opt) return false;
    opt.slot.player = cheapest;
    taken.add(cheapest.id);
  }
  return true;
}

/**
 * The slots this player may take without stranding the rest of the draft.
 *
 * This is what makes the daily forfeit-free. buildDaily only ships board sets
 * that are completable from empty; every pick is then filtered to those that
 * keep them completable. By induction a legal pick always exists on every
 * board, so the player can never be asked to pass.
 */
export function safeSlots(player, squad, picked, boards, boardIx, rules) {
  return openSlotsFor(player, squad).filter((opt) => {
    const trial = squad.map((s) => (s.id === opt.slot.id ? { ...s, player } : { ...s }));
    const taken = new Set(picked);
    taken.add(player.id);
    return completable(boards, boardIx + 1, trial, taken, rules);
  });
}

/**
 * Is this board set worth handing out? It must admit a complete assignment at
 * all, and be finishable from the empty squad -- the base case the no-strand
 * guarantee above is built on.
 */
function playable(boards, formation, rules) {
  const squad = makeSquad(formation);
  if (optimalStrength(boards, squad, rules.maxDPs) === null) return false;
  return completable(boards, 0, squad, new Set(), rules);
}

/**
 * Build the challenge for a date and league.
 *
 * The attempt counter is part of the seed, so an unplayable draw advances
 * everyone to the same next candidate rather than to a machine-specific one.
 */
export function buildDaily(pool, league, dateKey, difficulty = 'max') {
  // Max mode, minus the rerolls it already lacks. rulesFor strips the DP limit
  // and cap outside MLS, exactly as the normal game does.
  const rules = rulesFor(difficulty, league);

  for (let attempt = 0; attempt < 200; attempt++) {
    const rng = makeRng(hashSeed(`${dateKey}|${league}|${attempt}`));
    const formation = FORMATION_NAMES[Math.floor(rng() * FORMATION_NAMES.length)];
    // Drawn for every league so the rng sequence stays identical; only leagues
    // with conferences actually use it.
    const conference = rng() < 0.5 ? 'East' : 'West';

    const boards = [];
    const seen = new Set();
    for (let guard = 0; guard < 5000 && boards.length < SQUAD_SIZE; guard++) {
      const spin = pick(pool.spins, rng);
      const key = spinKey(spin);
      if (seen.has(key)) continue;
      seen.add(key);
      boards.push(spin);
    }
    if (boards.length < SQUAD_SIZE) continue;

    if (playable(boards, formation, rules)) {
      return { dateKey, league, formation, conference, boards, attempt, rules };
    }
  }
  return null;
}

/** A separate rng for the season, so match luck doesn't depend on the draft. */
export function dailySimRng(dateKey, league) {
  return makeRng(hashSeed(`${dateKey}|${league}|season`));
}

// ---------------------------------------------------------------- metrics

const weightOf = (slot) => (slot.starter ? STARTER_WEIGHT : SUB_WEIGHT);

/**
 * What each board was worth, and what it actually returned.
 *
 * "Best available" is measured against the squad as it stood when that board
 * came up, not against the empty squad -- the question is what the player
 * could have done at the time, not in hindsight. For the same reason it is
 * restricted to safe slots: naming a pick the draft screen refused to allow
 * would be scoring them against a move they were never offered.
 */
export function boardReport(boards, picks, formation, rules, constrained = true) {
  const squad = makeSquad(formation);
  const picked = new Set();
  const rows = [];

  boards.forEach((board, i) => {
    const taken = picks[i] || null;

    let best = null;
    for (const p of board.roster) {
      if (blockReason(p, squad, picked, rules) !== null) continue;
      // Free play has no no-strand rule, so every open slot was genuinely on
      // offer there. Only the daily restricts the comparison.
      const options = constrained
        ? safeSlots(p, squad, picked, boards, i, rules)
        : openSlotsFor(p, squad);
      for (const opt of options) {
        const v = effectiveScore(p, opt.slot.pos) * weightOf(opt.slot);
        if (!best || v > best.value) best = { player: p, slot: opt.slot.pos, value: v };
      }
    }

    let got = null;
    if (taken) {
      got = {
        player: taken.player,
        slot: taken.slotPos,
        value: effectiveScore(taken.player, taken.slotPos) * weightOf({ starter: taken.starter }),
      };
      const slot = squad.find((s) => s.id === taken.slotId);
      if (slot) slot.player = taken.player;
      picked.add(taken.player.id);
    }

    rows.push({
      board, took: got, best,
      left: best && got ? best.value - got.value : (best ? best.value : 0),
      forfeited: !taken,
    });
  });

  return rows;
}

/**
 * Where the player's squad lands against a field of random legal drafts over
 * the same boards. Gives the score a reference point without a leaderboard.
 */
export function fieldDistribution(boards, formation, rules, runs = 500, seed = 1) {
  const rng = makeRng(seed);
  const totals = [];

  for (let n = 0; n < runs; n++) {
    const squad = makeSquad(formation);
    const picked = new Set();
    let total = 0;
    for (const board of boards) {
      const legal = board.roster.filter((p) => blockReason(p, squad, picked, rules) === null);
      if (!legal.length) continue;
      const p = legal[Math.floor(rng() * legal.length)];
      const opts = openSlotsFor(p, squad);
      if (!opts.length) continue;
      const opt = opts[Math.floor(rng() * opts.length)];
      opt.slot.player = p;
      picked.add(p.id);
      total += effectiveScore(p, opt.slot.pos) * weightOf(opt.slot);
    }
    totals.push(total);
  }

  totals.sort((a, b) => a - b);
  return totals;
}

/** Percentage of the field this total beats. */
export function percentileOf(totals, value) {
  if (!totals.length) return null;
  let below = 0;
  while (below < totals.length && totals[below] < value) below++;
  return (below / totals.length) * 100;
}
