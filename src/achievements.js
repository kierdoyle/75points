// End-of-season achievements. Pure functions over a finished season so the
// headless test can check them without a browser.

import { LEAGUE } from './sim.js';

// The real single-season marks worth chasing, computed per league in
// scripts/build_data.py. MLS: 74 points, 85 goals, 22 wins. NWSL: 65, 58, 21.

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

  const REC = LEAGUE.records;
  // Thresholds that aren't records scale with the season length, so a 30-game
  // NWSL year isn't judged against 34-game MLS marks.
  const per = (n) => Math.round((n / 34) * LEAGUE.games);

  if (r.won) add('immortal', 'Immortal', `${r.points} points and the Cup`, 'legendary');
  if (rec.l === 0) add('invincible', 'Invincible', `Unbeaten all ${LEAGUE.games} games`, 'legendary');
  if (r.points > REC.points) {
    add('record', 'Record Breakers', `${r.points} points beats the ${LEAGUE.name} record of ${REC.points}`, 'legendary');
  } else if (r.points === REC.points) {
    add('equalled', 'Equal Best', `Matched the ${REC.points}-point record`, 'gold');
  }
  if (goals > REC.goals) add('goalglut', 'Goal Machine', `${goals} goals beats the record of ${REC.goals}`, 'legendary');
  else if (goals >= per(70)) add('freescoring', 'Free Scoring', `${goals} goals`, 'gold');

  if (rec.w > REC.wins) add('winrecord', 'Winning Machine', `${rec.w} wins beats the record of ${REC.wins}`, 'gold');
  if (conceded <= per(25)) add('fortress', 'Fortress', `Only ${conceded} conceded`, 'gold');
  if (goals - conceded >= per(50)) add('dominant', 'Dominant', `+${goals - conceded} goal difference`, 'gold');

  if (r.wonCup) add('cup', `${LEAGUE.cupName} Champions`, 'Lifted the trophy', 'gold');
  if (r.seed === 1) {
    add('shield', LEAGUE.shieldName,
      LEAGUE.conferences ? 'Best record in the conference' : 'Best record in the league', 'gold');
  }
  if (r.points >= LEAGUE.target && !r.wonCup) add('sotarget', 'So Close', `${r.points} points, no Cup`, 'silver');

  // Scaled off the league's own record haul rather than a fixed number.
  const recG = REC.playerGoals || 36;
  const top = r.awards.scorers[0];
  if (top && top.goals >= recG * 0.7) add('goldenboot', 'Golden Boot', `${top.name}, ${top.goals} goals`, 'gold');
  else if (top && top.goals >= recG * 0.5) add('sharpshooter', 'Sharpshooter', `${top.name}, ${top.goals} goals`, 'silver');
  const topA = r.awards.assisters[0];
  if (topA && topA.assists >= per(15)) add('playmaker', 'Playmaker', `${topA.name}, ${topA.assists} assists`, 'gold');

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
