#!/usr/bin/env node
// FREEZE the Soccer Algo V2 historical input membership (owner decision 2026-10-02, model soccer-algo-v2.1.0).
// Reads production READ-ONLY and writes workers/soccer-ingest/src/algo-v2-dataset.json: every canonical match id of
// the V2 input competitions inside the model's input window at the freeze instant (all statuses: a match still
// unfinished at the freeze joins once it has a result). The live lane then uses exactly
//   frozen ids  ∪  matches that kick off AFTER frozen_at
// so a historical match backfilled later (kickoff before frozen_at, id not frozen) can never enter the model.
//   node scripts/algo/freeze-v2-dataset.mjs [--at 2026-10-02T23:00:00Z]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const spec = JSON.parse(readFileSync('workers/soccer-ingest/src/algo-v2.json', 'utf8'));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const AT = new Date(arg('--at', new Date().toISOString())).toISOString();
const env = Object.fromEntries(readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const U = env.SOCCER_MODEL_SUPABASE_URL; if (!/tkmlnhmylqnttmnsnief/.test(U)) throw new Error('target guard');
const h = { apikey: env.SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY}` };
const get = async q => { const r = await fetch(`${U}/rest/v1/${q}`, { headers: h }); if (!r.ok) throw new Error(`${r.status} ${q}`); return r.json(); };
const WINDOW_DAYS = 5 * spec.model.half_life_days + 2;
const from = new Date(Date.parse(AT) - WINDOW_DAYS * 864e5).toISOString();
const comps = await get(`soccer_competitions?select=id,slug&slug=in.(${spec.input_competitions.join(',')})`);
const rows = [];
for (const c of comps) {
  let off = 0;
  for (;;) { const r = await get(`soccer_matches?select=id,season_id,kickoff_at,status&competition_id=eq.${c.id}&kickoff_at=gte.${from}&kickoff_at=lte.${AT}&order=id.asc&limit=1000&offset=${off}`); rows.push(...r.map(x => ({ ...x, competition: c.slug }))); if (r.length < 1000) break; off += 1000; }
}
const seasons = new Map((await get('soccer_seasons?select=id,label')).map(s => [s.id, s.label]));
const ids = [...new Set(rows.map(r => r.id))].sort();
const by = {}; for (const r of rows) { const k = `${r.competition} ${seasons.get(r.season_id)}`; by[k] = (by[k] || 0) + 1; }
const out = {
  dataset_version: 'soccer-algo-v2-inputs/1.0.0', algo_version: 'soccer-algo-v2.1.0', frozen_at: AT,
  rule: 'inputs = finished canonical matches of input_competitions whose id is in match_ids, plus those kicking off after frozen_at; window and identity rules unchanged',
  input_competitions: spec.input_competitions, window_days: WINDOW_DAYS, window_from: from,
  match_count: ids.length, finished_at_freeze: rows.filter(r => r.status === 'finished').length, by_competition_season: by,
  match_ids_sha256: createHash('sha256').update(ids.join('\n')).digest('hex'), match_ids: ids,
};
writeFileSync('workers/soccer-ingest/src/algo-v2-dataset.json', `${JSON.stringify(out, null, 1)}\n`);
console.log(JSON.stringify({ frozen_at: AT, match_count: out.match_count, finished: out.finished_at_freeze, sha: out.match_ids_sha256, by }, null, 1));
