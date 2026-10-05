#!/usr/bin/env node
// Phase 4 dark evidence: the activity plan the scheduler WOULD make right now on production (read-only: the canonical
// activity read through a GET-only fetch guard + the live per-competition states read with `wrangler kv key get`).
//   node scripts/news/schedule-preview.mjs [--out docs/evidence/news/schedule-preview-<date>.json] [--at <iso>]
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { NEWS_COMPETITIONS } from '../../workers/soccer-news/src/pipeline.js';
import { planTick } from '../../workers/soccer-news/src/schedule.js';

const envText = readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8').replace(/^\uFEFF/, '');
const env = Object.fromEntries(envText.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const restBase = `${env.SOCCER_MODEL_SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/`;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (!String(url).startsWith(restBase) || (init.method || 'GET') !== 'GET') throw new Error(`preview fetch guard: blocked ${init.method || 'GET'} ${String(url).slice(0, 80)}`);
  return realFetch(url, init);
};
const NS = '3e665f75414849578249f5aed979b868';
const kv = { get: async k => { try { return execFileSync('npx', ['wrangler', 'kv', 'key', 'get', '--namespace-id', NS, k, '--remote'], { cwd: 'workers/soccer-news', encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; } } };
const i = process.argv.indexOf('--at');
const now = i > 0 ? Date.parse(process.argv[i + 1]) : Date.now();
const plan = await planTick({ kv, store: storeFromEnv(env), now, competitions: NEWS_COMPETITIONS });
for (const [s, d] of Object.entries(plan.competitions)) console.log(s.padEnd(24), d.due ? 'DUE ' : 'skip', String(d.activity).padEnd(12), `${d.cadence_min ?? '-'} min`.padEnd(9), d.reason, d.next_due_at ? `next ${d.next_due_at}` : '');
const o = process.argv.indexOf('--out');
if (o > 0) { writeFileSync(process.argv[o + 1], JSON.stringify({ note: 'read-only preview of the phase 4 plan on production; nothing deployed or written', plan }, null, 1) + '\n'); console.log('wrote', process.argv[o + 1]); }
