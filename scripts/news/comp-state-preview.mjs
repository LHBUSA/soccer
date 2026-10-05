#!/usr/bin/env node
// Phase 2 dark evidence: what the per-competition state + health WOULD say on production data right now, without
// deploying anything. Runs the current newsroom DRY (zero model calls, zero writes) against production Supabase through
// a read-only recording store (global fetch trapped to GET on the Supabase REST endpoint), records per-competition state
// in memory, and evaluates competitionsHealth for those states.
//   node scripts/news/comp-state-preview.mjs [--out docs/evidence/news/comp-state-preview-<date>.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { leaguePhaseCfg } from '../../workers/soccer-news/src/profiles.js';
import { runNews, NEWS_COMPETITIONS } from '../../workers/soccer-news/src/pipeline.js';
import { stateRecorder, competitionsHealth } from '../../workers/soccer-news/src/index.js';
import { recordingStore } from './replay-store.mjs';

const envText = readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8').replace(/^\uFEFF/, '');
const env = Object.fromEntries(envText.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const restBase = `${env.SOCCER_MODEL_SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/`;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (!String(url).startsWith(restBase) || (init.method || 'GET') !== 'GET') throw new Error(`preview fetch guard: blocked ${init.method || 'GET'} ${String(url).slice(0, 80)}`);
  return realFetch(url, init);
};
const prod = storeFromEnv(env);
const toml = readFileSync(new URL('../../workers/soccer-news/wrangler.toml', import.meta.url), 'utf8');
const vars = Object.fromEntries([...toml.matchAll(/^([A-Z_]+) = "([^"]*)"/gm)].map(m => [m[1], m[2]]));
const cfg = leaguePhaseCfg(vars);
const now = Date.now();
const mem = new Map(); const kv = { get: async k => mem.get(k) ?? null, put: async (k, v) => { mem.set(k, v); } };
const rec = stateRecorder(kv, { now, cfg });
const store = recordingStore(prod);
const summary = await runNews(store, { now, cfg, dry: true, env: { NEWS_ENABLED: 'on' }, onCompetition: rec.hook });
const tick = { at: new Date(now).toISOString(), outcome: 'ran', news_enabled: true };
const health = await competitionsHealth({ SOCCER_STATE: kv }, { tick, store: prod, now });
if (store.writes.length) throw new Error('a dry run wrote');
const out = { at: tick.at, note: 'DRY preview of phase 2 state/health on production data; nothing deployed or written', reads: store.reads.length, competitions: NEWS_COMPETITIONS, health, run: Object.fromEntries(Object.entries(summary.competitions).map(([s, c]) => [s, { candidates: c.candidates, new: c.new, duplicates: c.duplicates }])) };
for (const [s, c] of Object.entries(health.competitions)) console.log(s.padEnd(24), c.state.padEnd(34), 'activity', c.detail?.activity, '| next', c.detail?.fixtures?.next_fixture_at, '| newest', c.newest_published_at);
console.log('off:', health.off.map(c => `${c.slug}(${c.publishing_profile})`).join(' '));
const i = process.argv.indexOf('--out');
if (i > 0) { writeFileSync(process.argv[i + 1], JSON.stringify(out, null, 1) + '\n'); console.log('wrote', process.argv[i + 1]); }
