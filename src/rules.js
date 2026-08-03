// Draft rules: formations, slot eligibility, penalties, DP cap.
// No DOM in here so the headless sanity test can import the same code the
// game runs.

export const DP_THRESHOLD = 1_700_000;
export const MAX_DPS = 3;
export const SQUAD_SIZE = 14; // 11 starters + 3 subs

// ------------------------------------------------------- 2026 roster rules
// Figures from the published 2026 MLS Roster Rules and Regulations. Used only
// by hard mode, where the squad has to come in cap-compliant.
const LEAGUE_SALARY_CAP = 6_425_000;
// The real allocation pools are General ($3.28m), additional U22 GAM (up to
// $2m) and Targeted ($2.125m); this game folds them into one pot.
const LEAGUE_ALLOCATION = 6_000_000;
// Those cover a 20-man senior roster. This squad is 14, so both are scaled to
// the same money-per-player a real club works with.
const SENIOR_ROSTER = 20;
const SQUAD_RATIO = SQUAD_SIZE / SENIOR_ROSTER;

export const SALARY_CAP = Math.round(LEAGUE_SALARY_CAP * SQUAD_RATIO);       // 4,497,500
export const ALLOCATION_MONEY = Math.round(LEAGUE_ALLOCATION * SQUAD_RATIO); // 4,200,000
// Per-player figures are not scaled -- they apply to individuals, not rosters.
export const MAX_BUDGET_CHARGE = 803_125;
export const SENIOR_MINIMUM = 113_400;
// Up to three young players can be carried at U22 Initiative rates.
export const MAX_U22 = 3;
export const U22_MAX_AGE = 22;
export const U22_CHARGE_YOUNG = 150_000; // age 20 or younger
export const U22_CHARGE = 200_000;       // ages 21-22

// A player is only at full strength in the exact role they filled in the
// season they were spun from -- same position, same flank. Anywhere else they
// can play, whether that comes from another season of their career or from
// covering an adjacent role, costs them a fifth of their g+.
export const ALT_POSITION_PENALTY = 0.20;

export const DIFFICULTIES = {
  easy: { label: 'Easy', rerolls: 5, maxDPs: Infinity, salaryCap: false, note: 'Unlimited DPs' },
  normal: { label: 'Normal', rerolls: 3, maxDPs: MAX_DPS, salaryCap: false, note: '3 DPs' },
  hard: {
    label: 'Hard',
    rerolls: 0,
    maxDPs: MAX_DPS,
    salaryCap: true,
    allocation: ALLOCATION_MONEY,
    note: '3 DPs + salary cap',
  },
};

/**
 * The rules for a difficulty in a given league.
 *
 * There is no public NWSL salary data, so that league has no Designated
 * Players and no cap -- its difficulties differ only in rerolls.
 */
export function rulesFor(difficulty, league = 'mls') {
  const base = DIFFICULTIES[difficulty];
  if (league === 'mls') return base;
  return {
    ...base,
    maxDPs: Infinity,
    salaryCap: false,
    note: base.rerolls === 0 ? 'No rerolls' : `${base.rerolls} rerolls`,
  };
}

// Everyone gets one look at a fresh set of coaching candidates.
export const COACH_REROLLS = 1;

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
 *
 * Eligibility is generous: the role they filled in the spun season, any role
 * they have held in another season of their career, or an adjacent one their
 * position can cover. Full strength is not. Only the exact role from the spun
 * season -- same position and, where the slot has one, same flank -- comes
 * free. Everything else is a single flat ALT_POSITION_PENALTY; being both out
 * of position and on the wrong flank does not double up.
 */
export function fitFor(player, slotPos) {
  const slot = SLOTS[slotPos];
  if (!slot) return null;

  const careerPos = player.positions && player.positions.length
    ? player.positions : [player.pos];
  const eligible = careerPos.some((p) => slot.native.includes(p) || slot.off.includes(p))
    || slot.native.includes(player.pos) || slot.off.includes(player.pos);
  if (!eligible) return null;

  // A flank has to have been earned. A player with an established side can
  // only appear on one they have actually played at some point in their
  // career -- Kai Wagner has never lined up at right back, so he cannot.
  // Players who never established a side move freely.
  const careerSides = player.sides || [];
  if (slot.flank !== SIDES.NONE && careerSides.length
      && !careerSides.includes(slot.flank)) {
    return null;
  }

  // What they actually did in the season they were spun from.
  const samePosition = slot.native.includes(player.pos);
  const sameFlank = slot.flank === SIDES.NONE || !player.side || player.side === slot.flank;
  if (samePosition && sameFlank) return { penalty: 0, reasons: [] };

  const reasons = [];
  if (!samePosition) reasons.push('Off their listed position');
  if (!sameFlank) reasons.push('Wrong flank');
  return { penalty: ALT_POSITION_PENALTY, reasons };
}

/**
 * A player's effective g+ once slot penalties are applied.
 *
 * The penalty is taken off the magnitude, not scaled through the sign --
 * otherwise a below-average player would get *better* by being shoved out of
 * position, since shrinking a negative number moves it toward zero.
 */
export function effectiveScore(player, slotPos) {
  const fit = fitFor(player, slotPos);
  if (!fit) return 0;
  return player.score - Math.abs(player.score) * fit.penalty;
}

export function canPlay(player, slotPos) {
  return fitFor(player, slotPos) !== null;
}

/**
 * Why a player can't be drafted right now, or null if they can.
 * `rules` is the chosen difficulty; it decides the DP limit and whether the
 * salary cap is in force.
 */
export function blockReason(player, squad, pickedIds, rules = DIFFICULTIES.normal) {
  if (pickedIds.has(player.id)) return 'Already drafted';
  const fits = squad.some((s) => !s.player && canPlay(player, s.pos));
  if (!fits) return 'No open slot';
  if (player.dp && countDPs(squad) >= rules.maxDPs) return 'DP limit reached';
  if (rules.salaryCap && !capAllows(player, squad, rules.allocation)) return 'No cap space';
  return null;
}

export function countDPs(squad) {
  return squad.filter((s) => s.player && s.player.dp).length;
}

// ------------------------------------------------------------ salary cap

const isU22 = (p) => p.age > 0 && p.age <= U22_MAX_AGE;
const u22Charge = (p) => (p.age <= 20 ? U22_CHARGE_YOUNG : U22_CHARGE);

/**
 * Work out a squad's budget under the 2026 rules.
 *
 * A Designated Player carries the maximum budget charge no matter what they
 * actually earn -- that is the whole point of the tag. Anyone else earning
 * more than the maximum charge has to be bought down to it with allocation
 * money. Up to three players aged 22 or under can be carried at U22
 * Initiative rates instead, and those slots go to whoever saves the most.
 * Whatever the squad is still over the cap by comes out of the same
 * allocation pot.
 */
export function budget(squad, allocation = ALLOCATION_MONEY) {
  const players = squad.filter((s) => s.player).map((s) => s.player);

  // Award the U22 slots where they save the most money.
  const savings = players
    .filter((p) => !p.dp && isU22(p) && p.salary > u22Charge(p))
    .map((p) => ({ p, save: Math.min(p.salary, MAX_BUDGET_CHARGE) - u22Charge(p) }))
    .sort((a, b) => b.save - a.save)
    .slice(0, MAX_U22);
  const u22 = new Set(savings.map((s) => s.p));

  let charge = 0;
  let buydown = 0;
  for (const p of players) {
    if (p.dp) {
      charge += MAX_BUDGET_CHARGE;
    } else if (u22.has(p)) {
      charge += u22Charge(p);
    } else {
      charge += Math.min(p.salary, MAX_BUDGET_CHARGE);
      // Above the maximum charge and not a DP => buy them down.
      buydown += Math.max(0, p.salary - MAX_BUDGET_CHARGE);
    }
  }
  const over = Math.max(0, charge - SALARY_CAP);
  const gamUsed = buydown + over;
  return {
    charge,
    buydown,
    over,
    gamUsed,
    gamLeft: allocation - gamUsed,
    u22: u22.size,
    compliant: gamUsed <= allocation,
    u22Ids: new Set([...u22].map((p) => p.id)),
  };
}

/**
 * Could this squad still be completed legally if we added `player`?
 *
 * Every slot still empty afterwards is costed at the senior minimum, which is
 * the cheapest anyone can be. If even that overshoots the allocation pot the
 * pick is refused, so the draft can never be spent into a dead end.
 */
export function capAllows(player, squad, allocation = ALLOCATION_MONEY) {
  const filled = squad.filter((s) => s.player).length;
  const remaining = SQUAD_SIZE - filled - 1;
  const b = budget([...squad.filter((s) => s.player), { player }], allocation);
  // Cost the empty slots at the senior minimum -- nobody can be cheaper.
  const charge = b.charge + remaining * SENIOR_MINIMUM;
  const needed = b.buydown + Math.max(0, charge - SALARY_CAP);
  return needed <= allocation;
}

/** Open slots this player may fill, best (cheapest) first. */
export function openSlotsFor(player, squad) {
  return squad
    .filter((s) => !s.player && canPlay(player, s.pos))
    .map((s) => ({ slot: s, ...fitFor(player, s.pos) }))
    .sort((a, b) => a.penalty - b.penalty || (a.slot.starter === b.slot.starter ? 0 : a.slot.starter ? -1 : 1));
}

/** True if at least one player on this roster can legally be drafted. */
export function hasEligiblePick(roster, squad, pickedIds, rules = DIFFICULTIES.normal) {
  return roster.some((p) => blockReason(p, squad, pickedIds, rules) === null);
}

/** A player who has been listed at more than one position in their career. */
export const isVersatile = (p) => (p.positions || []).length > 1;

/** Two filled slots may swap only if each player can play the other's slot. */
export function canSwap(slotA, slotB) {
  if (!slotA.player || !slotB.player || slotA.id === slotB.id) return false;
  return canPlay(slotA.player, slotB.pos) && canPlay(slotB.player, slotA.pos);
}

/** Slots the given filled slot could swap with. */
export function swapTargets(slot, squad) {
  return squad.filter((s) => canSwap(slot, s));
}
