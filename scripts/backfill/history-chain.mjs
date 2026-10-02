#!/usr/bin/env node
// Drive ESPN lanes (incl. history lanes espn_<comp>@<year>) one after another THROUGH the deployed soccer-ingest Worker
// (captures in R2, cursors in production KV), each until it stops making progress. A transient upstream/database error
// (e.g. PostgREST 521 during a Supabase incident) pauses 2 minutes and retries the same lane (max 15 times); one writer
// per chain.
//   node scripts/backfill/history-chain.mjs espn_uefa_nations_league@2024 espn_uefa_nations_league@2022 ... [--budget 120]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const budget = argv.includes('--budget') ? argv[argv.indexOf('--budget') + 1] : '120';
const lanes = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--budget');
const base = process.env.SOCCER_INGEST_URL || 'https://soccer-ingest.sales-fd3.workers.dev';
const token = readFileSync('D:/Workers/secrets/soccer-ingest-admin-token', 'utf8').trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
mkdirSync('docs/evidence/espn', { recursive: true });
for (const lane of lanes) {
  const log = []; let errors = 0;
  for (let i = 1; i <= 400; i++) {
    const t = Date.now();
    let r; let j;
    try { r = await fetch(`${base}/v1/runs?lane=${encodeURIComponent(lane)}&force=1&budget=${budget}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(300000) }); j = await r.json().catch(() => ({ error: `HTTP ${r.status}` })); } catch (e) { j = { error: String(e.message || e) }; r = { status: 0 }; }
    const s = j.results?.[0] || {};
    const row = { lane, run: i, http: r.status, ms: Date.now() - t, requests: j.requests, fixtures_new: s.fixtures_new, detailed: s.matches_detailed, exhausted: s.budget_exhausted_at || null, error: j.error || null, teams: s.team_identity ? { espn: s.team_identity.espn_teams, before: s.team_identity.resolved_before, founded: s.team_identity.teams_founded || 0, queued_or_refused: s.team_identity.clubs_refused || 0 } : undefined, athletes: (s.match_results || []).reduce((o, m) => { for (const [k, v] of Object.entries(m.athletes || {})) o[k] = (o[k] || 0) + v; return o; }, {}) };
    log.push(row); console.log(JSON.stringify(row));
    if (j.error || r.status >= 500 || r.status === 0) { if (++errors > 15) break; await sleep(120000); continue; }
    if (!s.budget_exhausted_at && !s.fixtures_new && !s.matches_detailed) break;
  }
  writeFileSync(`docs/evidence/espn/prod-fill-${lane.replace('@', '-').replace(':', '-')}-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ lane, base, runs: log }, null, 2) + '\n');
}
