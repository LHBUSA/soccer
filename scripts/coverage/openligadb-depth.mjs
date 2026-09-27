#!/usr/bin/env node
// Historical depth of OpenLigaDB for a league: one archived capture per season,
// counting matches, finished matches, goals and goals carrying a scorer id.
// Writes docs/evidence/coverage/openligadb-<league>.json.
//
// Usage: node scripts/coverage/openligadb-depth.mjs [league=bl1] [from=2002] [to=2026]

import { mkdirSync, writeFileSync } from 'node:fs';
import { fsStorage } from '../../workers/shared/archive.js';
import { fetchAndArchive } from '../../workers/soccer-ingest/src/openligadb-lane.js';
import { parseMatchdata } from '../../workers/providers/openligadb.js';

const [league = 'bl1', from = '2002', to = '2026'] = process.argv.slice(2);
const storage = await fsStorage('.raw');
const seasons = [];
for (let s = Number(from); s <= Number(to); s++) {
  try {
    const { rec, bytes } = await fetchAndArchive(storage, league, s);
    const ms = parseMatchdata(JSON.parse(new TextDecoder().decode(bytes)));
    const goals = ms.flatMap(m => m.goals);
    const expectedGoals = ms.filter(m => m.finished && m.score1 !== null).reduce((n, m) => n + m.score1 + m.score2, 0);
    seasons.push({
      season: s, matches: ms.length, finished: ms.filter(m => m.finished).length,
      goals_listed: goals.length, goals_advancing: goals.filter(g => g.advances).length, goals_from_scores: expectedGoals, goals_with_scorer_id: goals.filter(g => g.scorer_external_id).length,
      teams: new Set(ms.flatMap(m => [m.team1.external_id, m.team2.external_id])).size,
      capture_id: rec.capture_id, sha256: rec.content_sha256,
    });
  } catch (err) {
    seasons.push({ season: s, error: String(err.message || err) });
  }
  const last = seasons.at(-1);
  console.log(s, last.error || `${last.matches} matches, ${last.finished} finished, goals ${last.goals_advancing}(+${last.goals_listed - last.goals_advancing} phantom)/${last.goals_from_scores}, scorer ids ${last.goals_with_scorer_id}`);
}
const complete = seasons.filter(x => x.matches === 306 && x.finished === 306 && x.goals_advancing === x.goals_from_scores && x.goals_from_scores > 0).map(x => x.season);
const withScorerIds = seasons.filter(x => complete.includes(x.season) && x.goals_with_scorer_id >= x.goals_advancing).map(x => x.season);
mkdirSync('docs/evidence/coverage', { recursive: true });
writeFileSync(`docs/evidence/coverage/openligadb-${league}.json`, JSON.stringify({ league, generated_at: new Date().toISOString(), complete_seasons: complete, complete_with_scorer_ids: withScorerIds, seasons }, null, 2) + '\n');
console.log('complete seasons (306 finished, advancing goals == scores):', complete.join(', '));
console.log('...and every goal has a scorer id:', withScorerIds.join(', '));
