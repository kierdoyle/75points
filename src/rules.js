// Draft rules: formations, slot eligibility, penalties, DP cap.
// No DOM in here so the headless sanity test can import the same code the
// game runs.

export const DP_THRESHOLD = 1_700_000;
export const MAX_DPS = 3;
export const SQUAD_SIZE = 14; // 11 starters + 3 subs

// Playing a sided player on their wrong flank, or a midfielder one step out of
// their band, costs them some of their g+.
export const SIDE_SWAP_PENALTY = 0.20;
export const OUT_OF_POSITION_PENALTY = 0.10;

export const DIFFICULTIES = {
  easy: { label: 'Easy', rerolls: 5 },
  normal: { label: 'Normal', rerolls: 3 },
  hard: { label: 'Hard', rerolls: 1 },
};

export const SIDES = { NONE: 0, LEFT: 1, RIGHT: 2 };
export const SIDE_LABEL = { 0: '', 1: 'L', 2: 'R' };

/**
 * Which general_position codes can fill each slot, and what it costs them.
 *
 * Positions are locked to their own role: a centre back only plays centre
 * back, a winger only plays wing, a striker only plays striker. Fullbacks and
 * wingers may switch flanks for a side penalty. Midfielders may move one step
 * along the DM-CM-AM band (and an attacking midfielder can push out to the
 * wing) for an out-of-position penalty -- so a DM can cover CM but never AM.
 *
 * `native` fills the slot at full strength; `off` pays OUT_OF_POSITION_PENALTY.
 * `flank` is the side the slot is played on, if any.
 */
export const SLOTS = {
  GK: { native: ['GK'], off: [], flank: SIDES.NONE },
  CB: { native: ['CB'], off: [], flank: SIDES.NONE },
  LB: { native: ['FB'], off: [], flank: SIDES.LEFT },
  RB: { native: ['FB'], off: [], flank: SIDES.RIGHT },
  DM: { native: ['DM'], off: ['CM'], flank: SIDES.NONE },
  CM: { native: ['CM'], off: ['DM', 'AM'], flank: SIDES.NONE },
  AM: { native: ['AM'], off: ['CM'], flank: SIDES.NONE },
  LW: { native: ['W'], off: ['AM'], flank: SIDES.LEFT },
  RW: { native: ['W'], off: ['AM'], flank: SIDES.RIGHT },
  ST: { native: ['ST'], off: [], flank: SIDES.NONE },
  // Bench slots cover a whole band, so nothing is "out of position" there.
  SUB_D: { native: ['CB', 'FB'], off: [], flank: SIDES.NONE },
  SUB_M: { native: ['DM', 'CM', 'AM'], off: [], flank: SIDES.NONE },
  SUB_A: { native: ['W', 'ST'], off: [], flank: SIDES.NONE },
};

export const SLOT_LABEL = {
  GK: 'GK', CB: 'CB', LB: 'LB', RB: 'RB', DM: 'DM', CM: 'CM', AM: 'AM',
  LW: 'LW', RW: 'RW', ST: 'ST',
  SUB_D: 'SUB D', SUB_M: 'SUB M', SUB_A: 'SUB A',
};

// x/y are percentages on the pitch view: x across, y from own goal (0) to the
// opposition goal (100). A slot card is ~18% of the pitch wide and ~16% tall,
// so slots within 18% of each other horizontally need 17% of vertical
// separation. scripts/sanity.mjs asserts this for every formation.
const F = (pos, x, y) => ({ pos, x, y });

export const FORMATIONS = {
  '4-3-3': [
    F('GK', 50, 8),
    F('LB', 13, 27), F('CB', 37, 25), F('CB', 63, 25), F('RB', 87, 27),
    F('DM', 50, 45), F('CM', 30, 61), F('CM', 70, 61),
    F('LW', 15, 78), F('ST', 50, 91), F('RW', 85, 78),
  ],
  '4-4-2': [
    F('GK', 50, 8),
    F('LB', 13, 27), F('CB', 37, 25), F('CB', 63, 25), F('RB', 87, 27),
    F('LW', 14, 54), F('CM', 38, 52), F('CM', 62, 52), F('RW', 86, 54),
    F('ST', 36, 86), F('ST', 64, 86),
  ],
  '4-2-3-1': [
    F('GK', 50, 8),
    F('LB', 13, 27), F('CB', 37, 25), F('CB', 63, 25), F('RB', 87, 27),
    F('DM', 36, 46), F('DM', 64, 46),
    F('LW', 15, 72), F('AM', 50, 64), F('RW', 85, 72),
    F('ST', 50, 91),
  ],
  '3-5-2': [
    F('GK', 50, 8),
    F('CB', 28, 26), F('CB', 50, 26), F('CB', 72, 26),
    F('LB', 13, 52), F('CM', 34, 48), F('CM', 66, 48), F('RB', 87, 52),
    F('AM', 50, 68),
    F('ST', 36, 88), F('ST', 64, 88),
  ],
  '5-3-2': [
    F('GK', 50, 8),
    F('LB', 10, 34), F('CB', 30, 26), F('CB', 50, 26), F('CB', 70, 26), F('RB', 90, 34),
    F('DM', 50, 48), F('CM', 30, 64), F('CM', 70, 64),
    F('ST', 36, 88), F('ST', 64, 88),
  ],
};

export const SUB_SLOTS = [
  { pos: 'SUB_D', x: 20, y: 50 },
  { pos: 'SUB_M', x: 50, y: 50 },
  { pos: 'SUB_A', x: 80, y: 50 },
];

/** Build the empty 14-slot squad for a formation. */
export function makeSquad(formation) {
  const starters = FORMATIONS[formation].map((s, i) => ({
    id: `s${i}`, pos: s.pos, x: s.x, y: s.y, starter: true, player: null,
  }));
  const subs = SUB_SLOTS.map((s, i) => ({
    id: `b${i}`, pos: s.pos, x: s.x, y: s.y, starter: false, player: null,
  }));
  return [...starters, ...subs];
}

/**
 * What it costs to play this player in this slot, or null if they can't.
 * Returns { penalty, reasons } where penalty is the fraction of g+ lost.
 */
export function fitFor(player, slotPos) {
  const slot = SLOTS[slotPos];
  if (!slot) return null;
  const native = slot.native.includes(player.pos);
  const off = slot.off.includes(player.pos);
  if (!native && !off) return null;

  const reasons = [];
  let penalty = 0;
  if (off) {
    penalty += OUT_OF_POSITION_PENALTY;
    reasons.push('Out of position');
  }
  // Only a player with a known flank pays for switching, and only when the
  // slot itself has a flank. Players who genuinely covered both sides are
  // recorded with no side and move freely.
  if (slot.flank !== SIDES.NONE && native
      && player.side && player.side !== slot.flank) {
    penalty += SIDE_SWAP_PENALTY;
    reasons.push('Wrong flank');
  }
  return { penalty, reasons };
}

/** A player's effective g+ once slot penalties are applied. */
export function effectiveScore(player, slotPos) {
  const fit = fitFor(player, slotPos);
  if (!fit) return 0;
  return player.score * (1 - fit.penalty);
}

export function canPlay(player, slotPos) {
  return fitFor(player, slotPos) !== null;
}

/** Why a player can't be drafted right now, or null if they can. */
export function blockReason(player, squad, pickedIds) {
  if (pickedIds.has(player.id)) return 'Already drafted';
  const fits = squad.some((s) => !s.player && canPlay(player, s.pos));
  if (!fits) return 'No open slot';
  if (player.dp && countDPs(squad) >= MAX_DPS) return 'DP limit reached';
  return null;
}

export function countDPs(squad) {
  return squad.filter((s) => s.player && s.player.dp).length;
}

/** Open slots this player may fill, best (cheapest) first. */
export function openSlotsFor(player, squad) {
  return squad
    .filter((s) => !s.player && canPlay(player, s.pos))
    .map((s) => ({ slot: s, ...fitFor(player, s.pos) }))
    .sort((a, b) => a.penalty - b.penalty || (a.slot.starter === b.slot.starter ? 0 : a.slot.starter ? -1 : 1));
}

/** True if at least one player on this roster can legally be drafted. */
export function hasEligiblePick(roster, squad, pickedIds) {
  return roster.some((p) => blockReason(p, squad, pickedIds) === null);
}

/** Two filled slots may swap only if each player can play the other's slot. */
export function canSwap(slotA, slotB) {
  if (!slotA.player || !slotB.player || slotA.id === slotB.id) return false;
  return canPlay(slotA.player, slotB.pos) && canPlay(slotB.player, slotA.pos);
}

/** Slots the given filled slot could swap with. */
export function swapTargets(slot, squad) {
  return squad.filter((s) => canSwap(slot, s));
}
