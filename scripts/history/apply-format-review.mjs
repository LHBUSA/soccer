#!/usr/bin/env node
// Apply a REVIEWED season format manifest (data/history-review/<comp>-<season>.json) to a HELD season.
// Classification is event-level and evidence-based; never a date cutoff (rules: scripts/history/format-review-lib.mjs):
//   playoff  = exactly one canonical match whose (local date, unordered pairing, per-team goals) equals a reviewed fixture
//   excluded = cancelled / postponed / abandoned listings (never counted)
//   regular  = every other finished canonical match, which must then reconcile club by club (W, D, L, GF, GA, played)
//              to the reviewed standings. Anything else stays unresolved and blocks.
// The provider's own classification (ESPN season type -> the stage the lane created) is recorded per match as source
// evidence; the manifest decides only the CANONICAL stage. Raw captures, crosswalks and source results are untouched.
// Dry run by default (writes the classification evidence + a canonical snapshot for the regression test). --apply
// creates the reviewed stages and moves ONLY the proven playoff matches to them, and only when nothing is unresolved.
//   node scripts/history/apply-format-review.mjs mls 2004 [--apply]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { classifyFormatReview, leagueGamesPerTeam } from './format-review-lib.mjs';
const [comp, season] = process.argv.slice(2);
const APPLY = process.argv.includes('--apply');
const manifest = JSON.parse(readFileSync(`data/history-review/${comp}-${season}.json`, 'utf8'));
const env = Object.fromEntries(readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const U = env.SOCCER_MODEL_SUPABASE_URL; if (!/tkmlnhmylqnttmnsnief/.test(U)) throw new Error('target guard');
const h = { apikey: env.SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY}` };
const get = async q => { const r = await fetch(`${U}/rest/v1/${q}`, { headers: h }); if (!r.ok) throw new Error(`${r.status} ${q}`); return r.json(); };
const [c] = await get(`soccer_competitions?select=id&slug=eq.${comp}`);
const [s] = await get(`soccer_seasons?select=id,label,publication_state&competition_id=eq.${c.id}&label=eq.${encodeURIComponent(season)}`);
if (s.publication_state !== 'held') throw new Error(`refused: ${comp} ${season} is ${s.publication_state} (format review applies to held seasons only)`);
const rows = await get(`soccer_matches?select=id,stage_id,kickoff_at,status,home_team_id,away_team_id,home_score,away_score&season_id=eq.${s.id}&order=kickoff_at.asc&limit=1000`);
const stages = await get(`soccer_stages?select=id,name,stage_type,stage_order&season_id=eq.${s.id}`);
const stageName = new Map(stages.map(x => [x.id, x.name]));
const tids = [...new Set(rows.flatMap(m => [m.home_team_id, m.away_team_id]))];
const slugOf = new Map((await get(`soccer_teams?select=id,slug&id=in.(${tids.join(',')})`)).map(t => [t.id, t.slug]));
const xw = new Map((await get(`soccer_match_external_ids?select=external_id,match_id&provider=eq.espn&match_id=in.(${rows.map(m => m.id).join(',')})`)).map(x => [x.match_id, x.external_id]));
const matches = rows.map(m => ({ id: m.id, espn_event: xw.get(m.id) ?? null, kickoff_at: m.kickoff_at, status: m.status, home: slugOf.get(m.home_team_id), away: slugOf.get(m.away_team_id), home_score: m.home_score, away_score: m.away_score, provider_stage: stageName.get(m.stage_id) }));
const r = classifyFormatReview(manifest, matches);
const games = leagueGamesPerTeam(r.assignment, matches, manifest.regular_season.stage);
const out = { at: new Date().toISOString(), competition: comp, season, manifest_sha256: createHash('sha256').update(readFileSync(`data/history-review/${comp}-${season}.json`)).digest('hex'),
  canonical_matches: matches.length, playoff_matched: r.playoff.size, playoff_expected: manifest.playoffs.fixtures.length, regular_finished: r.regular.length, regular_expected: manifest.regular_season.expected_matches,
  league_games_per_team_after_review: games,
  provider_stage_counts: matches.reduce((o, m) => ({ ...o, [m.provider_stage]: (o[m.provider_stage] || 0) + 1 }), {}),
  reviewed_stage_counts: r.assignment.reduce((o, a) => ({ ...o, [a.reviewed_stage ?? 'excluded']: (o[a.reviewed_stage ?? 'excluded'] || 0) + 1 }), {}),
  reclassified: r.reclassified,
  excluded_listings: r.excluded.map(m => ({ match_id: m.id, espn_event: m.espn_event, kickoff_at: m.kickoff_at, status: m.status, home: m.home, away: m.away })),
  unresolved: r.unresolved.map(m => m.id), unknown_teams: r.strangers, fixtures: r.fixtures, standings_differences: r.standings_differences, assignment: r.assignment };
out.provider_date_exceptions = r.fixtures.filter(f => f.outcome === 'matched_reviewed_date_exception').map(f => ({ fixture: f.fixture, stage: f.stage, ...f.exception }));
out.ready = r.ready;
if (APPLY) {
  if (!out.ready) throw new Error(`REFUSED: classification not proven (${JSON.stringify({ playoff: `${out.playoff_matched}/${out.playoff_expected}`, regular: `${out.regular_finished}/${out.regular_expected}`, diffs: r.standings_differences.length })})`);
  const want = [...new Set(manifest.playoffs.fixtures.map(f => f.stage))];
  const ids = {}; let order = Math.max(...stages.map(x => x.stage_order)) + 1;
  for (const name of want) {
    let st = stages.find(x => x.name === name);
    if (!st) { const id = createHash('sha256').update(`${s.id}|reviewed-stage|${name}`).digest('hex').replace(/^(.{8})(.{4})(.{3})(.{3})(.{12}).*$/, '$1-$2-5$3-8$4-$5'); const res = await fetch(`${U}/rest/v1/soccer_stages`, { method: 'POST', headers: { ...h, 'content-type': 'application/json', prefer: 'return=representation' }, body: JSON.stringify({ id, season_id: s.id, name, stage_type: 'knockout', stage_order: order++ }) }); if (!res.ok) throw new Error(`stage ${name} ${res.status} ${await res.text()}`); st = (await res.json())[0]; }
    ids[name] = st.id;
  }
  let moved = 0;
  for (const [mid, p] of r.playoff) { const res = await fetch(`${U}/rest/v1/soccer_matches?id=eq.${mid}`, { method: 'PATCH', headers: { ...h, 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ stage_id: ids[p.stage] }) }); if (!res.ok) throw new Error(`move ${mid} ${res.status} ${await res.text()}`); moved++; }
  out.applied = { stages: ids, playoff_matches_moved: moved };
  const lim = `Stage classification from reviewed format manifest data/history-review/${comp}-${season}.json (ESPN files ${r.reclassified.filter(x => x.reviewed_stage !== manifest.regular_season.stage).length} playoff match(es) inside its regular-season type; ESPN's own classification is kept as source evidence).`;
  await fetch(`${U}/rest/v1/soccer_seasons?id=eq.${s.id}`, { method: 'PATCH', headers: { ...h, 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ limitations: [lim, ...out.provider_date_exceptions.map(x => `ESPN event ${x.event_id} (${x.stage} ${x.fixture}) carries a provider date one day later than the reviewed fixture date; canonical kickoff kept as published by ESPN.`)], publication_note: `format review applied ${out.at.slice(0, 10)} (held until acceptance)` }) });
} else {
  // the canonical input as the provider classified it, frozen for tests/format-review.test.js
  writeFileSync(`docs/evidence/history/review/${comp}-${season}-canonical-snapshot.json`, `${JSON.stringify({ at: out.at, competition: comp, season, note: 'canonical matches before the reviewed manifest is applied; provider_stage = the ESPN season type the lane recorded', matches }, null, 1)}\n`);
}
mkdirSync('docs/evidence/history/review', { recursive: true });
writeFileSync(`docs/evidence/history/review/${comp}-${season}-classification${APPLY ? '-applied' : ''}.json`, `${JSON.stringify(out, null, 1)}\n`);
console.log(JSON.stringify({ ready: out.ready, playoff: `${out.playoff_matched}/${out.playoff_expected}`, regular: `${out.regular_finished}/${out.regular_expected}`, provider_stages: out.provider_stage_counts, reviewed_stages: out.reviewed_stage_counts, league_games_per_team: [...new Set(Object.values(games))], reclassified: r.reclassified.map(x => ({ espn_event: x.espn_event, kickoff_at: x.kickoff_at, result: x.result, provider_stage: x.provider_stage, reviewed_stage: x.reviewed_stage })), excluded: out.excluded_listings.length, unresolved: out.unresolved.length, standings_differences: r.standings_differences, date_exceptions: out.provider_date_exceptions.length, fixtures_not_matched: r.fixtures.filter(f => !f.outcome.startsWith('matched')).map(f => ({ stage: f.stage, date: f.date_local, fixture: f.fixture, outcome: f.outcome, diagnostic: f.diagnostic_same_pairing_and_goals })), applied: out.applied || null }, null, 1));
