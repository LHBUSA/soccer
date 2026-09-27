#!/usr/bin/env node
// Drive the ESPN initial fill THROUGH the deployed soccer-ingest Worker (so every
// capture is archived in R2 and the lane cursor lives in production KV).
// Repeats admin runs until the lane stops making progress.
//   node scripts/backfill/espn-fill-prod.mjs espn_bundesliga [budgetPerRun=60] [maxRuns=60]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const [lane, budget = '60', maxRuns = '60'] = process.argv.slice(2);
const base = process.env.SOCCER_INGEST_URL || 'https://soccer-ingest.sales-fd3.workers.dev';
const token = readFileSync('D:/Workers/secrets/soccer-ingest-admin-token', 'utf8').trim();
const log = [];
for (let i = 1; i <= Number(maxRuns); i++) {
  const t = Date.now();
  const r = await fetch(`${base}/v1/runs?lane=${lane}&force=1&budget=${budget}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  const s = j.results?.[0] || {};
  const row = { run: i, http: r.status, ms: Date.now() - t, requests: j.requests, fixtures_new: s.fixtures_new, detailed: s.matches_detailed, exhausted: s.budget_exhausted_at || null, error: j.error || null, team_identity: s.team_identity, athletes: (s.match_results || []).reduce((o, m) => { for (const [k, v] of Object.entries(m.athletes || {})) o[k] = (o[k] || 0) + v; return o; }, {}), bridge: s.openligadb_scorer_bridge };
  log.push(row);
  console.log(JSON.stringify(row));
  if (j.error || r.status >= 500) break;
  if (!s.budget_exhausted_at && !s.fixtures_new && !s.matches_detailed) break;
}
mkdirSync('docs/evidence/espn', { recursive: true });
writeFileSync(`docs/evidence/espn/prod-fill-${lane}-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ lane, base, runs: log }, null, 2) + '\n');
