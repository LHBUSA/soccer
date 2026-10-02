#!/usr/bin/env node
// Apply a REVIEWED season format manifest (data/history-review/<comp>-<season>.json) to a HELD season.
// Classification is event-level and evidence-based; never a date cutoff:
//   playoff  = exactly one canonical match whose (local date, unordered pairing, per-team goals) equals a reviewed
//              fixture. Local date = the ESPN UTC kickoff date or the day before (US evening kick-offs are next-day UTC).
//   excluded = cancelled / postponed / abandoned listings (never counted)
//   regular  = every other finished canonical match, which must then reconcile club by club (W, D, L, GF, GA, played)
//              to the reviewed standings. Anything else stays unresolved and blocks.
// Dry run by default (writes the classification evidence only). --apply creates the reviewed stages and moves ONLY the
// proven playoff matches to them (match UUIDs, crosswalks and captures untouched), and only when nothing is unresolved.
//   node scripts/history/apply-format-review.mjs mls 2001 [--apply]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
const ms = await get(`soccer_matches?select=id,stage_id,kickoff_at,status,home_team_id,away_team_id,home_score,away_score&season_id=eq.${s.id}&order=kickoff_at.asc&limit=1000`);
const tids = [...new Set(ms.flatMap(m => [m.home_team_id, m.away_team_id]))];
const slugOf = new Map((await get(`soccer_teams?select=id,slug&id=in.(${tids.join(',')})`)).map(t => [t.id, t.slug]));
const idOf = new Map([...slugOf].map(([id, sl]) => [sl, id]));
const xw = new Map((await get(`soccer_match_external_ids?select=external_id,match_id&provider=eq.espn&match_id=in.(${ms.map(m => m.id).join(',')})`)).map(x => [x.match_id, x.external_id]));
const localDates = iso => { const d = new Date(iso); const prev = new Date(d.getTime() - 864e5); return [d.toISOString().slice(0, 10), prev.toISOString().slice(0, 10)]; };
const goalsOf = (m, slug) => (slugOf.get(m.home_team_id) === slug ? m.home_score : slugOf.get(m.away_team_id) === slug ? m.away_score : null);

const playoff = new Map(); const fixtureResults = [];
for (const f of manifest.playoffs.fixtures) {
  const cands = ms.filter(m => m.status === 'finished' && new Set([slugOf.get(m.home_team_id), slugOf.get(m.away_team_id)]).has(f.team_a) && new Set([slugOf.get(m.home_team_id), slugOf.get(m.away_team_id)]).has(f.team_b)
    && goalsOf(m, f.team_a) === f.goals_a && goalsOf(m, f.team_b) === f.goals_b && !playoff.has(m.id)
    && (f.provider_date_exception ? xw.get(m.id) === f.provider_date_exception.event_id && localDates(m.kickoff_at).includes(f.provider_date_exception.provider_local_date) : localDates(m.kickoff_at).includes(f.date_local)));
  const res = { stage: f.stage, date_local: f.date_local, fixture: `${f.team_a} ${f.goals_a}-${f.goals_b} ${f.team_b}`, candidates: cands.map(m => ({ match_id: m.id, espn_event: xw.get(m.id), kickoff_at: m.kickoff_at, home: slugOf.get(m.home_team_id) })) };
  if (cands.length === 1) { playoff.set(cands[0].id, f.stage); res.outcome = f.provider_date_exception ? 'matched_reviewed_date_exception' : 'matched'; if (f.provider_date_exception) res.exception = f.provider_date_exception; }
  else {
    res.outcome = cands.length ? 'ambiguous' : 'no_match';
    // diagnose: same pairing + goals on any date (a date disagreement between sources), never used to classify
    res.diagnostic_same_pairing_and_goals = ms.filter(m => new Set([slugOf.get(m.home_team_id), slugOf.get(m.away_team_id)]).has(f.team_a) && new Set([slugOf.get(m.home_team_id), slugOf.get(m.away_team_id)]).has(f.team_b) && goalsOf(m, f.team_a) === f.goals_a && goalsOf(m, f.team_b) === f.goals_b && Math.abs(Date.parse(m.kickoff_at) - Date.parse(`${f.date_local}T12:00:00Z`)) < 5 * 864e5).map(m => ({ match_id: m.id, espn_event: xw.get(m.id), kickoff_at: m.kickoff_at }));
  }
  fixtureResults.push(res);
}
const excluded = ms.filter(m => ['cancelled', 'postponed', 'abandoned'].includes(m.status));
const regular = ms.filter(m => m.status === 'finished' && !playoff.has(m.id));
const unresolved = ms.filter(m => !['finished', 'cancelled', 'postponed', 'abandoned'].includes(m.status));
// reconcile the regular season to the reviewed standings
const table = {}; for (const slug of Object.keys(manifest.regular_season.standings)) table[slug] = { played: 0, won: 0, drawn: 0, lost: 0, goals_for: 0, goals_against: 0 };
for (const m of regular) for (const [me, op, gf, ga] of [[m.home_team_id, m.away_team_id, m.home_score, m.away_score], [m.away_team_id, m.home_team_id, m.away_score, m.home_score]]) {
  const r = table[slugOf.get(me)]; if (!r) continue; r.played++; r.goals_for += gf; r.goals_against += ga; if (gf > ga) r.won++; else if (gf === ga) r.drawn++; else r.lost++;
}
const diffs = Object.entries(manifest.regular_season.standings).map(([slug, want]) => { const got = table[slug]; const d = ['played', 'won', 'drawn', 'lost', 'goals_for', 'goals_against'].filter(k => got[k] !== want[k]); return d.length ? { team: slug, fields: Object.fromEntries(d.map(k => [k, { reviewed: want[k], canonical: got[k] }])) } : null; }).filter(Boolean);
const out = { at: new Date().toISOString(), competition: comp, season, manifest_sha256: createHash('sha256').update(readFileSync(`data/history-review/${comp}-${season}.json`)).digest('hex'),
  canonical_matches: ms.length, playoff_matched: playoff.size, playoff_expected: manifest.playoffs.fixtures.length, regular_finished: regular.length, regular_expected: manifest.regular_season.expected_matches,
  excluded_listings: excluded.map(m => ({ match_id: m.id, espn_event: xw.get(m.id), kickoff_at: m.kickoff_at, status: m.status, home: slugOf.get(m.home_team_id), away: slugOf.get(m.away_team_id) })),
  unresolved: unresolved.map(m => m.id), fixtures: fixtureResults.filter(r => r.outcome !== 'matched'), standings_differences: diffs };
out.provider_date_exceptions = fixtureResults.filter(r => r.outcome === 'matched_reviewed_date_exception').map(r => ({ fixture: r.fixture, stage: r.stage, ...r.exception }));
out.ready = out.playoff_matched === out.playoff_expected && out.fixtures.every(f => f.outcome.startsWith('matched')) && out.regular_finished === out.regular_expected && !out.unresolved.length && !diffs.length;
if (APPLY) {
  if (!out.ready) throw new Error(`REFUSED: classification not proven (${JSON.stringify({ playoff: `${out.playoff_matched}/${out.playoff_expected}`, regular: `${out.regular_finished}/${out.regular_expected}`, diffs: diffs.length })})`);
  const stages = await get(`soccer_stages?select=id,name,stage_type,stage_order&season_id=eq.${s.id}`);
  const want = [...new Set(manifest.playoffs.fixtures.map(f => f.stage))];
  const ids = {}; let order = Math.max(...stages.map(x => x.stage_order)) + 1;
  for (const name of want) {
    let st = stages.find(x => x.name === name);
    if (!st) { const id = createHash('sha256').update(`${s.id}|reviewed-stage|${name}`).digest('hex').replace(/^(.{8})(.{4})(.{3})(.{3})(.{12}).*$/, '$1-$2-5$3-8$4-$5'); const r = await fetch(`${U}/rest/v1/soccer_stages`, { method: 'POST', headers: { ...h, 'content-type': 'application/json', prefer: 'return=representation' }, body: JSON.stringify({ id, season_id: s.id, name, stage_type: 'knockout', stage_order: order++ }) }); if (!r.ok) throw new Error(`stage ${name} ${r.status} ${await r.text()}`); st = (await r.json())[0]; }
    ids[name] = st.id;
  }
  let moved = 0;
  for (const [mid, stage] of playoff) { const r = await fetch(`${U}/rest/v1/soccer_matches?id=eq.${mid}`, { method: 'PATCH', headers: { ...h, 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ stage_id: ids[stage] }) }); if (!r.ok) throw new Error(`move ${mid} ${r.status} ${await r.text()}`); moved++; }
  out.applied = { stages: ids, playoff_matches_moved: moved };
  await fetch(`${U}/rest/v1/soccer_seasons?id=eq.${s.id}`, { method: 'PATCH', headers: { ...h, 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ limitations: [`Stage classification from reviewed format manifest data/history-review/${comp}-${season}.json (ESPN files the playoffs inside its regular-season type).`, ...out.provider_date_exceptions.map(x => `ESPN event ${x.event_id} (${x.stage} ${x.fixture}) carries a provider date one day later than the reviewed fixture date; canonical kickoff kept as published by ESPN.`)], publication_note: `format review applied ${out.at.slice(0, 10)} (held until acceptance)` }) });
}
mkdirSync('docs/evidence/history/review', { recursive: true });
writeFileSync(`docs/evidence/history/review/${comp}-${season}-classification${APPLY ? '-applied' : ''}.json`, `${JSON.stringify(out, null, 1)}\n`);
console.log(JSON.stringify({ ready: out.ready, playoff: `${out.playoff_matched}/${out.playoff_expected}`, regular: `${out.regular_finished}/${out.regular_expected}`, excluded: out.excluded_listings.length, unresolved: out.unresolved.length, standings_differences: diffs, date_exceptions: out.provider_date_exceptions.length, fixtures_not_matched: out.fixtures.filter(f => !f.outcome.startsWith('matched')).map(f => ({ stage: f.stage, date: f.date_local, fixture: f.fixture, outcome: f.outcome, diagnostic: f.diagnostic_same_pairing_and_goals })), applied: out.applied || null }, null, 1));
