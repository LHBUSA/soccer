#!/usr/bin/env node
// Capture a FROZEN production parity fixture for the competition-runner refactor (read-only).
// Runs the frozen RC2.1 pipeline (tests/fixtures/news/legacy-pipeline.js = production c0ec2b50) against PRODUCTION
// Supabase through a recording store, at several tick instants and in three variants per instant:
//   natural          dry=1 (exactly what /v1/run?dry=1 does: real dedupe against existing stories, zero writes)
//   new_desk_req     every candidate treated as NEW (hideExisting), desk required but no key -> HOLD path, writes logged
//   new_desk_off     every candidate treated as NEW, NEWS_DESK=off -> gated template publish path, writes logged
// Nothing can be written to production: the store forwards only selects, and global fetch is trapped to GET requests
// on the Supabase REST endpoint (no OpenAI, no other host). Output: tests/fixtures/news/runner-parity-prod.json.gz
//   node scripts/news/runner-parity-capture.mjs [--now <iso>]...
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { leaguePhaseCfg } from '../../workers/soccer-news/src/profiles.js';
import { runNews as legacyRunNews, NEWS_COMPETITIONS } from '../../tests/fixtures/news/legacy-pipeline.js';
import { recordingStore, packReads } from './replay-store.mjs';

const envText = readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8').replace(/^\uFEFF/, '');
const env = Object.fromEntries(envText.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const restBase = `${env.SOCCER_MODEL_SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/`;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (!String(url).startsWith(restBase) || (init.method || 'GET') !== 'GET') throw new Error(`capture fetch guard: blocked ${init.method || 'GET'} ${String(url).slice(0, 80)}`);
  return realFetch(url, init);
};
const prod = storeFromEnv(env);
if (!prod) throw new Error('store not configured');

// Worker vars as deployed (wrangler.toml): the league-phase boundaries.
const toml = readFileSync(new URL('../../workers/soccer-news/wrangler.toml', import.meta.url), 'utf8');
const vars = Object.fromEntries([...toml.matchAll(/^([A-Z_]+) = "([^"]*)"/gm)].map(m => [m[1], m[2]]));
const cfg = leaguePhaseCfg(vars);

const args = process.argv.slice(2);
const nows = args.flatMap((a, i) => (a === '--now' ? [args[i + 1]] : []));
const tick = Date.now() - ((Date.now() / 6e4) % 30) * 6e4; // the latest :07/:37-aligned half hour is close enough
const instants = nows.length ? nows : [new Date(Math.floor(tick / 6e4) * 6e4).toISOString(), '2026-09-21T10:07:00Z', '2026-09-11T10:07:00Z'];
const VARIANTS = {
  natural: { hideExisting: false, opts: { dry: true }, env: { NEWS_ENABLED: 'on' } },
  new_desk_req: { hideExisting: true, opts: {}, env: { NEWS_ENABLED: 'on' } },
  new_desk_off: { hideExisting: true, opts: {}, env: { NEWS_ENABLED: 'on', NEWS_DESK: 'off' } },
};

const blobs = {}; const runs = [];
for (const at of instants) {
  for (const [name, v] of Object.entries(VARIANTS)) {
    const rec = recordingStore(prod, { hideExisting: v.hideExisting });
    const opts = { now: Date.parse(at), competitions: NEWS_COMPETITIONS, cfg, ...v.opts };
    const t0 = Date.now();
    const summary = await legacyRunNews(rec, { ...opts, env: v.env });
    runs.push({ at, variant: name, opts, env: v.env, reads: packReads(rec.reads, blobs), writes: rec.writes, summary });
    const c = Object.entries(summary.competitions).map(([s, x]) => `${s}:${x.candidates}/${x.new}/${x.published}p/${x.held}h`).join(' ');
    console.log(at, name.padEnd(13), `${rec.reads.length} reads, ${rec.writes.length} writes, ${Date.now() - t0} ms |`, c);
  }
}
const fixture = { kind: 'soccer-news runner parity (production replay)', captured_at: new Date().toISOString(), reference: 'legacy-pipeline.js = RC2.1 2e24eb9 (production c0ec2b50)', competitions: NEWS_COMPETITIONS, cfg, runs, blobs };
const gz = gzipSync(JSON.stringify(fixture), { level: 9 });
writeFileSync(new URL('../../tests/fixtures/news/runner-parity-prod.json.gz', import.meta.url), gz);
console.log('fixture', (gz.length / 1024).toFixed(0), 'KiB gz,', Object.keys(blobs).length, 'distinct row sets');
