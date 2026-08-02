// Draft rules: formations, slot eligibility, DP cap. No DOM in here so the
// headless sanity test can import the same code the game runs.

export const DP_THRESHOLD = 1_700_000;
export const MAX_DPS = 3;
export const SQUAD_SIZE = 14; // 11 starters + 3 subs

export const DIFFICULTIES = {
  easy: { label: 'Easy', rerolls: 5 },
  normal: { label: 'Normal', rerolls: 3 },
  hard: { label: 'Hard', rerolls: 1 },
};

// Which ASA general_position codes may fill each slot.
export const ELIGIBLE = {
  GK: ['GK'],
  CB: ['CB'],
  FB: ['FB'],
  DM: ['DM', 'CM'],
  CM: ['CM', 'DM', 'AM'],
  AM: ['AM', 'CM'],
  W: ['W', 'AM'],
  ST: ['ST', 'W'],
  SUB_D: ['CB', 'FB'],
  SUB_M: ['DM', 'CM', 'AM'],
  SUB_A: ['W', 'ST'],
};

export const SLOT_LABEL = {
  GK: 'GK', CB: 'CB', FB: 'FB', DM: 'DM', CM: 'CM', AM: 'AM', W: 'W', ST: 'ST',
  SUB_D: 'SUB D', SUB_M: 'SUB M', SUB_A: 'SUB A',
};

// x/y are percentages on the pitch view: x across, y from own goal (0) to the
// opposition goal (100).
const F = (pos, x, y) => ({ pos, x, y });

// A slot card is roughly 13-14% of the pitch height, so any two slots sharing
// a column need ~15% of vertical separation to avoid overlapping.
export const FORMATIONS = {
  '4-3-3': [
    F('GK', 50, 9),
    F('FB', 13, 28), F('CB', 37, 24), F('CB', 63, 24), F('FB', 87, 28),
    F('DM', 50, 45), F('CM', 30, 59), F('CM', 70, 59),
    F('W', 15, 77), F('ST', 50, 88), F('W', 85, 77),
  ],
  '4-4-2': [
    F('GK', 50, 9),
    F('FB', 13, 28), F('CB', 37, 24), F('CB', 63, 24), F('FB', 87, 28),
    F('W', 14, 52), F('CM', 38, 50), F('CM', 62, 50), F('W', 86, 52),
    F('ST', 36, 85), F('ST', 64, 85),
  ],
  '4-2-3-1': [
    F('GK', 50, 9),
    F('FB', 13, 28), F('CB', 37, 24), F('CB', 63, 24), F('FB', 87, 28),
    F('DM', 36, 45), F('DM', 64, 45),
    F('W', 15, 70), F('AM', 50, 62), F('W', 85, 70),
    F('ST', 50, 88),
  ],
  '3-5-2': [
    F('GK', 50, 8),
    F('CB', 28, 24), F('CB', 50, 25), F('CB', 72, 24),
    F('FB', 10, 50), F('CM', 34, 46), F('CM', 66, 46), F('FB', 90, 50),
    F('AM', 50, 66),
    F('ST', 36, 87), F('ST', 64, 87),
  ],
  '5-3-2': [
    F('GK', 50, 8),
    F('FB', 10, 32), F('CB', 30, 24), F('CB', 50, 24), F('CB', 70, 24), F('FB', 90, 32),
    F('DM', 50, 46), F('CM', 30, 58), F('CM', 70, 58),
    F('ST', 36, 85), F('ST', 64, 85),
  ],
};

export const SUB_SLOTS = [
  { pos: 'SUB_D', x: 20, y: 50 },
  { pos: 'SUB_M', x: 50, y: 50 },
  { pos: 'SUB_A', x: 80, y: 50 },
];

/** Build the empty 14-slot squad for a formation. */
export function makeSquad(formation) {
  const slots = FORMATIONS[formation].map((s, i) => ({
    id: `s${i}`, pos: s.pos, x: s.x, y: s.y, starter: true, player: null,
  }));
  const subs = SUB_SLOTS.map((s, i) => ({
    id: `b${i}`, pos: s.pos, x: s.x, y: s.y, starter: false, player: null,
  }));
  return [...slots, ...subs];
}

/** Why a player can't be picked right now, or null if they can. */
export function blockReason(player, squad, pickedIds) {
  if (pickedIds.has(player.id)) return 'Already drafted';
  const openFor = squad.some((s) => !s.player && ELIGIBLE[s.pos].includes(player.pos));
  if (!openFor) return 'No open slot';
  if (player.dp && countDPs(squad) >= MAX_DPS) return 'DP limit reached';
  return null;
}

export function countDPs(squad) {
  return squad.filter((s) => s.player && s.player.dp).length;
}

/** Slots this player is currently eligible to fill. */
export function openSlotsFor(player, squad) {
  return squad.filter((s) => !s.player && ELIGIBLE[s.pos].includes(player.pos));
}

/** True if at least one player on this roster can legally be drafted. */
export function hasEligiblePick(roster, squad, pickedIds) {
  return roster.some((p) => blockReason(p, squad, pickedIds) === null);
}
