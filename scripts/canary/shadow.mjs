#!/usr/bin/env node
// Owner canary for the private Dixon-Coles shadow (13 checks).
//   node scripts/canary/shadow.mjs --phase pre  [--match <uuid>]   before kickoff (checks 1-10)
//   node scripts/canary/shadow.mjs --phase post [--match <uuid>]   after the match is final (11-13)
// Default match: the earliest Bundesliga fixture with a shadow row (pre) / the pre-canary's match (post).
// Writes docs/evidence/shadow/canary-<phase>-<match8>.json. Reads with the service role; the
// public checks go through the public site and the public anon key exactly as a browser would.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { predictShadow, sortInputs, modelMatch, inputHash, SHADOW_SPEC as spec } from '../../workers/soccer-ingest/src/shadow-lane.js';

const arg = k => { const i = process.argv.indexOf(k); return i < 0 ? null : process.argv[i + 1]; };
const PHASE = arg('--phase'); if (!['pre', 'post'].includes(PHASE)) throw new Error('--phase pre|post');
const SITE = 'https://soccer.propbetedge.ai';
const envText = readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8');
const store = storeFromEnv(Object.fromEntries(envText.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])));
const T = 'soccer_model_shadow_predictions';
const checks = []; const check = (n, name, pass, detail = {}) => checks.push({ n, name, pass: !!pass, ...detail });
const sql = text => { const f = 'D:/Temp/shadow-canary.sql'; writeFileSync(f, text); return execFileSync('pwsh', ['-NoProfile', '-File', 'scripts/db/run_sql_file.ps1', '-File', f], { encoding: 'utf8' }); };
mkdirSync('docs/evidence/shadow', { recursive: true });

let matchId = arg('--match');
if (!matchId && PHASE === 'pre') {
  const rows = await store.select(T, { columns: ['match_id', 'kickoff_at'], eq: { model_id: spec.model_id }, gte: { kickoff_at: new Date().toISOString() }, order: 'kickoff_at.asc', limit: 1 });
  if (!rows.length) { console.log(JSON.stringify({ phase: PHASE, status: 'NO ISSUED FIXTURE YET' })); process.exit(2); }
  matchId = rows[0].match_id;
}
if (!matchId && PHASE === 'post') { const pre = JSON.parse(readFileSync('docs/evidence/shadow/canary-pre-latest.json', 'utf8')); matchId = pre.match_id; }
const rows = await store.select(T, { columns: '*', eq: { model_id: spec.model_id, match_id: matchId }, limit: 5 });
const row = rows[0];
const [match] = await store.select('soccer_matches', { columns: ['id', 'status', 'kickoff_at', 'home_score', 'away_score', 'home_team_id', 'away_team_id'], eq: { id: matchId }, limit: 1 });
const out = { phase: PHASE, at: new Date().toISOString(), match_id: matchId, model_id: spec.model_id, model_hash: spec.model_hash };

if (PHASE === 'pre') {
  check(1, 'exactly one prediction row', rows.length === 1, { rows: rows.length });
  const s = row.p_home + row.p_draw + row.p_away;
  check(2, 'probabilities sum to 1', Math.abs(s - 1) < 1e-9, { sum: s });
  check(3, 'predicted_at < kickoff_at', Date.parse(row.predicted_at) < Date.parse(row.kickoff_at), { predicted_at: row.predicted_at, kickoff_at: row.kickoff_at, canonical_kickoff: match.kickoff_at });
  check(4, 'input_as_of < predicted_at', Date.parse(row.input_as_of) < Date.parse(row.predicted_at), { input_as_of: row.input_as_of });
  check(5, 'frozen model id', row.model_id === 'soccer-research-bundesliga-v1.2-dc' && row.model_hash === spec.model_hash, { model_id: row.model_id, model_hash: row.model_hash });
  check(6, 'rho = -0.1099', row.rho === -0.1099, { rho: row.rho });
  check(7, 'calibration_id = none', row.calibration_id === 'none');
  // 8: attempt a change inside a transaction that is always rolled back; the trigger must refuse.
  const upd = sql(`begin;\nupdate public.${T} set p_home = p_home / 2, p_away = p_away + p_home / 2 where id = '${row.id}';\nrollback;\n`);
  check(8, 'prediction cannot be updated', /FAILED/.test(upd) && /frozen/.test(upd), { response: upd.trim().slice(0, 200) });
  // Reproduction: rebuild the input set from the canonical graph as of input_as_of and recompute.
  const [comp] = await store.select('soccer_competitions', { columns: ['id'], eq: { slug: 'bundesliga' }, limit: 1 });
  const seasons = await store.select('soccer_seasons', { columns: ['id'], eq: { competition_id: comp.id }, order: 'id.asc' });
  const league = new Set((await store.select('soccer_stages', { columns: ['id', 'stage_type'], in: { season_id: seasons.map(x => x.id) }, order: 'id.asc' })).filter(x => x.stage_type === 'league').map(x => x.id));
  const hist = await store.select('soccer_matches', { columns: ['id', 'stage_id', 'kickoff_at', 'status', 'home_team_id', 'away_team_id', 'home_score', 'away_score'], eq: { competition_id: comp.id, status: 'finished' }, gte: { kickoff_at: new Date(Date.parse(row.predicted_at) - 2702 * 864e5).toISOString() }, lte: { kickoff_at: row.input_as_of }, order: 'kickoff_at.asc,id.asc' });
  const inputs = sortInputs(hist.filter(m => league.has(m.stage_id) && m.home_score !== null).map(modelMatch));
  const h = inputHash(inputs); const re = predictShadow(inputs, row);
  out.reproduction = { input_hash_matches: h === row.input_hash, recomputed_probabilities_bitwise_equal: h === row.input_hash && re.probs[0] === row.p_home && re.probs[1] === row.p_draw && re.probs[2] === row.p_away, input_count: inputs.length, note: h === row.input_hash ? 'canonical inputs unchanged since issue' : 'canonical inputs changed since issue; the issued input set is archived in R2 under input_hash' };
  // 9: the public API (via the site proxy) exposes nothing about the shadow
  const pub = [];
  for (const p of [`/api/soccer/matches/${matchId}`, '/api/soccer/shadow', '/api/soccer/predictions', `/api/soccer/matches/${matchId}/prediction`]) {
    const r = await fetch(SITE + p); const text = await r.text();
    pub.push({ path: p, status: r.status, leaks: /p_home|p_draw|shadow|soccer-research|lambda_home|input_hash/.test(text) });
  }
  check(9, 'public soccer API cannot read it', pub.every(x => !x.leaks) && pub.filter(x => x.path !== `/api/soccer/matches/${matchId}`).every(x => x.status >= 400), { probes: pub });
  // 10: a browser cannot read it: anon PostgREST refused, and the shipped bundle has no reference
  const anon = JSON.parse(execFileSync('pwsh', ['-NoProfile', '-File', 'scripts/canary/anon-probe.ps1'], { encoding: 'utf8' }).trim().split('\n').at(-1));
  const html = await (await fetch(SITE + '/')).text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map(m => m[1]);
  let bundleLeak = false; for (const a of assets) if (/model_shadow|shadow_predictions|soccer-research|v1\.2-dc/.test(await (await fetch(SITE + a)).text())) bundleLeak = true;
  check(10, 'browser cannot read it', anon.every(x => !x.readable && x.http_status !== 200) && !bundleLeak, { anon, bundle_assets_scanned: assets.length, bundle_reference: bundleLeak });
  Object.assign(out, { predicted_at: row.predicted_at, kickoff_at: row.kickoff_at, probabilities: { home: row.p_home, draw: row.p_draw, away: row.p_away }, lambda: { home: row.lambda_home, away: row.lambda_away }, input_hash: row.input_hash, input_as_of: row.input_as_of, input_count: row.input_count });
} else {
  const pre = JSON.parse(readFileSync(`docs/evidence/shadow/canary-pre-${matchId.slice(0, 8)}.json`, 'utf8'));
  const final = match.status === 'finished' && match.home_score !== null;
  const expect = final ? (match.home_score > match.away_score ? 'home' : match.home_score === match.away_score ? 'draw' : 'away') : null;
  check(11, 'outcome fills (canonical score, once)', final && row.settled_at && row.home_score === match.home_score && row.away_score === match.away_score && row.outcome === expect, { status: match.status, score: [match.home_score, match.away_score], row: [row.home_score, row.away_score, row.outcome, row.settled_at] });
  check(12, 'original probabilities unchanged', row.p_home === pre.probabilities.home && row.p_draw === pre.probabilities.draw && row.p_away === pre.probabilities.away && row.predicted_at === pre.predicted_at && row.input_hash === pre.input_hash);
  const snaps = await store.select('soccer_model_shadow_metrics', { columns: ['settled_count', 'computed_at'], eq: { model_id: spec.model_id }, order: 'settled_count.asc' });
  const settledNow = (await store.select(T, { columns: ['match_id', 'settled_at'], eq: { model_id: spec.model_id }, order: 'match_id.asc' })).filter(r => r.settled_at).length;
  const counts = snaps.map(s => s.settled_count);
  check(13, 'rolling metrics update once', counts.includes(settledNow) && new Set(counts).size === counts.length && snaps.filter(s => s.settled_count === settledNow).every(s => Date.parse(s.computed_at) >= Date.parse(row.settled_at)), { snapshots: snaps, settled_now: settledNow });
}
out.checks = checks; out.pass = checks.every(c => c.pass);
const file = `docs/evidence/shadow/canary-${PHASE}-${matchId.slice(0, 8)}.json`;
writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
if (PHASE === 'pre') writeFileSync('docs/evidence/shadow/canary-pre-latest.json', JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ file, pass: out.pass, checks: checks.map(c => `${c.n} ${c.pass ? 'PASS' : 'FAIL'} ${c.name}`), reproduction: out.reproduction }, null, 1));
process.exit(out.pass ? 0 : 1);
void existsSync;
