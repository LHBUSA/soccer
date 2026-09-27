#!/usr/bin/env node
// Health canary + endpoint timings for soccer-api (cold = first request, warm = edge cache).
//   SOCCER_API_URL=https://soccer-api.<acct>.workers.dev node scripts/qa/api-timings.mjs
import { mkdirSync, writeFileSync } from 'node:fs';

const base = process.env.SOCCER_API_URL;
if (!base) throw new Error('set SOCCER_API_URL');
const paths = ['/v1/health', '/v1/competitions', '/v1/competitions/bundesliga', '/v1/matches?competition=bundesliga&limit=20',
  '/v1/table?competition=bundesliga', '/v1/table?competition=bundesliga&season=2017/18', '/v1/teams/bayern-munchen', '/v1/players/robert-lewandowski', '/v1/news'];
const out = { base, at: new Date().toISOString(), results: [] };
const time = async p => {
  const t = Date.now();
  const r = await fetch(base + p);
  const j = await r.json().catch(() => null);
  return { status: r.status, ms: Date.now() - t, cache: r.headers.get('x-cache'), coverage: j?.meta?.coverage?.state, envelope: !!(j?.meta?.source && j?.meta?.semantics && 'source_updated_at' in (j?.meta || {})), j };
};
const list = await time('/v1/matches?competition=bundesliga&season=2017/18&limit=1');
if (list.j?.data?.[0]) paths.push(`/v1/matches/${list.j.data[0].id}`);
for (const p of paths) {
  const cold = await time(p); const warm = await time(p);
  out.results.push({ path: p, status: cold.status, cold_ms: cold.ms, warm_ms: warm.ms, warm_cache: warm.cache, coverage: cold.coverage, envelope: cold.envelope });
  console.log(cold.status, String(cold.ms).padStart(5), String(warm.ms).padStart(5), warm.cache || '-', p);
}
out.pass = out.results.every(r => r.status === 200 && r.envelope);
mkdirSync('docs/evidence/api', { recursive: true });
writeFileSync(`docs/evidence/api/timings-${out.at.slice(0, 10)}.json`, JSON.stringify(out, null, 2) + '\n');
console.log('pass:', out.pass);
