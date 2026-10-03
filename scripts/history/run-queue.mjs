#!/usr/bin/env node
// HISTORY QUEUE RUNNER (owner policy 2026-10-02): per season
//   ingest HELD (PASS A lane through the deployed soccer-ingest) -> acceptance -> PASS: promote + smoke -> next
//                                                                            -> FAIL: stay held, log, next
// Stops the lane ONLY for: a structural parser failure (ESPN shape drift), canonical identity corruption (unknown team,
// club/national contamination), unexplained fixture duplication (repeated league pair), or a chain that cannot reach the
// Worker/database after its own retries. One process per lane; run at most 3 in parallel (tkmln write ceiling).
//   node scripts/history/run-queue.mjs --comp premier-league --lane espn_premier_league --years 2001-2025 [--skip 2010] [--expect-teams 20]
//   node scripts/history/run-queue.mjs --comp bundesliga --lane espn_bundesliga --years 2004-2025 --mode reconcile
// Log: docs/evidence/history/queue-<comp>.jsonl (one line per season).
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const COMP = arg('--comp'); const LANE = arg('--lane'); const MODE = arg('--mode', 'promote');
const [y0, y1] = arg('--years').split('-').map(Number);
const SKIP = new Set((arg('--skip', '') || '').split(',').filter(Boolean).map(Number));
const EXPECT = arg('--expect-teams', null);
const split = !['mls', 'fifa-world-cup'].includes(COMP);
const labelOf = y => (split ? `${y}/${String((y + 1) % 100).padStart(2, '0')}` : String(y));
const LOG = `docs/evidence/history/queue-${COMP}.jsonl`;
mkdirSync('docs/evidence/history', { recursive: true });
const env = Object.fromEntries(readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const U = env.SOCCER_MODEL_SUPABASE_URL; const h = { apikey: env.SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY}` };
// the runner's own database reads retry transient network/5xx failures (a dropped socket must not kill a lane)
const retry = async fn => { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= 5) throw e; await new Promise(r => setTimeout(r, 5000 * (i + 1))); } } };
const get = q => retry(async () => { const r = await fetch(`${U}/rest/v1/${q}`, { headers: h }); if (r.status >= 500) throw new Error(`HTTP ${r.status}`); return r.json(); });
const cnt = q => retry(async () => { const r = await fetch(`${U}/rest/v1/${q}`, { method: 'HEAD', headers: { ...h, prefer: 'count=exact' } }); if (r.status >= 500) throw new Error(`HTTP ${r.status}`); return Number((r.headers.get('content-range') || '').split('/')[1]); });
const node = args => spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' }, maxBuffer: 64 * 1024 * 1024 });
// lane cursor (KV, read-only) -> events minus the extra listings of every repeated pairing
const cursorFloor = laneName => {
  const kv = spawnSync('npx', ['wrangler', 'kv', 'key', 'get', `lane:${laneName}`, '--namespace-id', '3e665f75414849578249f5aed979b868', '--remote'], { cwd: 'workers/soccer-ingest', encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_OPTIONS: '--require D:/Workers/exfat-readlink.cjs' } });
  let st = null; try { st = JSON.parse(kv.stdout); } catch { return 1; }
  const fx = Object.values(st?.cursor?.fixtures || {}); const groups = {};
  for (const f of fx) { const k = `${f.stype}|${f.h}|${f.a}`; groups[k] = (groups[k] || 0) + 1; }
  return fx.length - Object.values(groups).reduce((a, n) => a + (n - 1), 0);
};
const log = row => { appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), comp: COMP, ...row })}\n`); console.log(JSON.stringify(row)); };
const HOLD_FOR_REVIEW = new Set((arg('--hold', '') || '').split(',').filter(Boolean).map(Number)); // ingest, never promote
const STOP_CHECKS = new Set(['unknown_team', 'club_national_contamination', 'repeated_home_away_pair', 'two_valid_sides_and_stage']);

for (let y = y0; y <= y1; y++) {
  if (SKIP.has(y)) continue;
  const label = labelOf(y); const lane = `${LANE}@${y}:results`; const t0 = Date.now();
  const chain = node(['scripts/backfill/history-chain.mjs', lane, '--budget', '120']);
  const runs = chain.stdout.split('\n').filter(l => l.startsWith('{')).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const requests = runs.reduce((a, r) => a + (r.requests || 0), 0); const errors = runs.filter(r => r.error);
  const minutes = Math.round((Date.now() - t0) / 6e3) / 10;
  // A parser failure stops the lane only if it PERSISTS (the chain's final run still fails). ESPN intermittently serves a
  // non-JSON body for a resource that is valid JSON on the next read; the chain retries, and the cleared error is logged.
  const last = runs[runs.length - 1];
  if (last?.error && /shape drift|EspnShapeError/i.test(last.error)) { log({ season: label, lane, outcome: 'STOP_parser', requests, minutes, errors: errors.slice(-3) }); process.exit(2); }
  const transient = errors.filter(e => /shape drift|EspnShapeError/i.test(e.error)).map(e => e.error.replace(/^.*for /, ''));
  if (errors.length > 15) { log({ season: label, lane, outcome: 'STOP_unreachable', requests, minutes, errors: errors.slice(-3) }); process.exit(3); }
  const fixtures = runs.reduce((a, r) => a + (r.fixtures_new || 0), 0); const detailed = runs.reduce((a, r) => a + (r.detailed || 0), 0);
  if (MODE === 'reconcile') {
    // OpenLigaDB owns the season: ESPN only attaches; report disagreements, never overwrite.
    const [c] = await get(`soccer_competitions?select=id&slug=eq.${COMP}`);
    const [s] = await get(`soccer_seasons?select=id,publication_state&competition_id=eq.${c.id}&label=eq.${encodeURIComponent(label)}`);
    if (!s) { log({ season: label, lane, outcome: 'NO_CANONICAL_SEASON', requests, minutes }); continue; }
    const ms = await get(`soccer_matches?select=id,home_score,away_score,result_provider&season_id=eq.${s.id}&limit=1000`);
    const src = []; for (let i = 0; i < ms.length; i += 100) src.push(...await get(`soccer_match_source_results?select=match_id,home_score,away_score&provider=eq.espn&match_id=in.(${ms.slice(i, i + 100).map(m => m.id).join(',')})`));
    const by = new Map(ms.map(m => [m.id, m]));
    const dis = src.filter(x => { const m = by.get(x.match_id); return m && Number.isInteger(x.home_score) && (x.home_score !== m.home_score || x.away_score !== m.away_score); });
    log({ season: label, lane, outcome: 'RECONCILED', requests, minutes, transient_non_json_cleared: transient, fixtures_seen: fixtures, results_read: detailed, canonical_matches: ms.length, espn_observations: src.length, disagreements: dis.length, disagreement_ids: dis.slice(0, 10).map(d => d.match_id), state: s.publication_state });
    continue;
  }
  // floor: the lane cursor's events minus the EXTRA listings of every repeated pairing (sum of group size - 1): each
  // pairing founds at least one match. (Subtracting the number of repeated pairings overshot when a pairing was listed
  // three or more times; Premier League 2003/04 held on a perfect 380.) No cursor -> 1.
  const floor = String(Math.max(1, cursorFloor(lane)));
  const acc = node(['scripts/history/accept-season.mjs', COMP, label, '--min-matches', floor, ...(EXPECT ? ['--expect-teams', EXPECT] : [])]);
  let res = null; try { res = JSON.parse(acc.stdout.trim().split('\n').pop()); } catch { /* below */ }
  if (!res) { log({ season: label, lane, outcome: 'HELD_acceptance_error', requests, minutes, stderr: acc.stderr.slice(-400) }); continue; }
  if (res.failed.some(f => STOP_CHECKS.has(f))) { log({ season: label, lane, outcome: 'STOP_integrity', requests, minutes, failed: res.failed, matches: res.matches }); process.exit(4); }
  if (res.pass && HOLD_FOR_REVIEW.has(y)) { log({ season: label, lane, outcome: 'HELD_for_review', requests, minutes, matches: res.matches, note: 'format needs review before publication' }); continue; }
  if (!res.pass) { log({ season: label, lane, outcome: 'HELD', requests, minutes, failed: res.failed, matches: res.matches, finished: res.finished, teams: res.teams, format: res.format }); continue; }
  const pro = node(['scripts/history/accept-season.mjs', COMP, label, '--min-matches', floor, ...(EXPECT ? ['--expect-teams', EXPECT] : []), '--promote']);
  let p = null; try { p = JSON.parse(pro.stdout.trim().split('\n').pop()); } catch { /* below */ }
  if (!p?.promoted) { log({ season: label, lane, outcome: 'HELD_promote_refused', requests, minutes, stderr: pro.stderr.slice(-400) }); continue; }
  // smoke: the season is public with exactly its canonical matches and complete results; no newsroom event on it
  const [c] = await get(`soccer_competitions?select=id&slug=eq.${COMP}`);
  const [s] = await get(`soccer_public_seasons?select=id,published_at&competition_id=eq.${c.id}&label=eq.${encodeURIComponent(label)}`);
  const pub = await cnt(`soccer_public_matches?select=id&season_id=eq.${s.id}`); const base = await cnt(`soccer_matches?select=id&season_id=eq.${s.id}`);
  const ids = (await get(`soccer_matches?select=id&season_id=eq.${s.id}&limit=1000`)).map(m => m.id);
  let news = 0; for (let i = 0; i < ids.length; i += 100) news += await cnt(`soccer_news_events?select=id&match_id=in.(${ids.slice(i, i + 100).join(',')})`);
  const smoke = { public_matches: pub, base_matches: base, news_events: news, ok: pub === base && news === 0 };
  log({ season: label, lane, outcome: smoke.ok ? 'PROMOTED' : 'PROMOTED_SMOKE_FAIL', published_at: s.published_at, requests, minutes, transient_non_json_cleared: transient, matches: p.matches, finished: p.finished, teams: p.teams, tier: p.tier, notes: p.notes, smoke, rollback: `PATCH soccer_seasons?id=eq.${s.id} {publication_state:'held'}` });
  if (!smoke.ok) process.exit(5);
}
console.log(`QUEUE DONE ${COMP} ${y0}-${y1}`);
