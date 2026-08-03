// End-of-season achievements. Pure functions over a finished season so the
// headless test can check them without a browser.

import { TARGET_POINTS, SEASON_GAMES } from './sim.js';

// Real MLS marks worth chasing.
export const RECORD_POINTS = 74;   // New England, 2021
export const RECORD_GOALS = 85;    // Los Angeles FC, 2019
export const RECORD_WINS = 22;     // shared, several clubs

/**
 * Everything the squad earned this season, best first.
 * Each entry is { id, name, note, tier } where tier drives the styling:
 * 'legendary' > 'gold' > 'silver'.
 */
export function achievements(season, squad) {
  const r = season;
  const rec = r.userRecord;
  const goals = rec.gf;
  const conceded = rec.ga;
  const out = [];
  const add = (id, name, note, tier = 'silver') => out.push({ id, name, note, tier });

  if (r.won) add('immortal', 'Immortal', `${r.points} points and the Cup`, 'legendary');
  if (rec.l === 0) add('invincible', 'Invincible', `Unbeaten all ${SEASON_GAMES} games`, 'legendary');
  if (r.points > RECORD_POINTS) {
    add('record', 'Record Breakers', `${r.points} points beats the MLS record of ${RECORD_POINTS}`, 'legendary');
  } else if (r.points === RECORD_POINTS) {
    add('equalled', 'Equal Best', `Matched the ${RECORD_POINTS}-point record`, 'gold');
  }
  if (goals > RECORD_GOALS) add('goalglut', 'Goal Machine', `${goals} goals beats the record of ${RECORD_GOALS}`, 'legendary');
  else if (goals >= 70) add('freescoring', 'Free Scoring', `${goals} goals`, 'gold');

  if (rec.w > RECORD_WINS) add('winrecord', 'Winning Machine', `${rec.w} wins beats the record of ${RECORD_WINS}`, 'gold');
  if (conceded <= 25) add('fortress', 'Fortress', `Only ${conceded} conceded`, 'gold');
  if (goals - conceded >= 50) add('dominant', 'Dominant', `+${goals - conceded} goal difference`, 'gold');

  if (r.wonCup) add('cup', 'MLS Cup Champions', 'Lifted the trophy', 'gold');
  if (r.seed === 1) add('shield', "Supporters' Shield", 'Best record in the conference', 'gold');
  if (r.points >= TARGET_POINTS && !r.wonCup) add('sotarget', 'So Close', `${r.points} points, no Cup`, 'silver');

  const top = r.awards.scorers[0];
  if (top && top.goals >= 25) add('goldenboot', 'Golden Boot', `${top.name}, ${top.goals} goals`, 'gold');
  else if (top && top.goals >= 18) add('sharpshooter', 'Sharpshooter', `${top.name}, ${top.goals} goals`, 'silver');
  const topA = r.awards.assisters[0];
  if (topA && topA.assists >= 15) add('playmaker', 'Playmaker', `${topA.name}, ${topA.assists} assists`, 'gold');

  const streak = longestUnbeaten(r.results);
  if (streak >= 20) add('unbeaten', 'Untouchable', `${streak} games unbeaten`, 'gold');
  else if (streak >= 14) add('run', 'On a Run', `${streak} games unbeaten`, 'silver');

  if (rec.d >= 14) add('draws', 'Stalemate Specialists', `${rec.d} draws`, 'silver');
  if (!r.madePlayoffs && r.points >= 45) add('unlucky', 'Cruelly Denied', 'Missed the playoffs anyway', 'silver');

  const defenders = squad.filter((s) => s.player && ['CB', 'FB'].includes(s.player.pos));
  if (defenders.length && r.awards.scorers.some((t) => ['CB', 'FB'].includes(t.pos) && t.goals >= 8)) {
    const d = r.awards.scorers.find((t) => ['CB', 'FB'].includes(t.pos));
    add('defgoals', 'Defender on the Scoresheet', `${d.name}, ${d.goals} goals`, 'silver');
  }

  const order = { legendary: 0, gold: 1, silver: 2 };
  return out.sort((a, b) => order[a.tier] - order[b.tier]);
}

/** Longest run without a loss. */
export function longestUnbeaten(results) {
  let best = 0;
  let run = 0;
  for (const r of results) {
    if (r.result === 'L') run = 0;
    else { run++; if (run > best) best = run; }
  }
  return best;
}
