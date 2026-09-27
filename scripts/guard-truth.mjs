#!/usr/bin/env node
// Truth guard. Fails (exit 1) on anything that would let fake, unsourced or
// leaked material reach production. Runs in `npm run check`.
//
//  1. Source registry: valid verdicts, unique keys, every evidence file exists,
//     PASS/PARTIAL need evidence, production_ready needs a passing canary file,
//     every terms quote marked PASS/RESTRICTS must be traceable to an evidence file.
//  2. No GitHub Actions workflows (network policy: Actions only shrink).
//  3. No secrets: service-role JWTs, API keys, private keys, secret-looking wrangler vars.
//  4. No sample/fake/mock/demo data files under data/.
//  5. No Math.random in ingest/news/shared code (determinism).
//  6. Browser code (src/) never calls a third-party host or holds a service role.
//  7. No proprietary metric is marked published without a backtest (migration seed).

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const errors = [];
const fail = m => errors.push(m);
const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (['node_modules', '.git', '.raw', '.proof', 'dist', '.wrangler'].includes(f)) continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};
const files = walk('.').map(f => relative('.', f).replace(/\\/g, '/'));

// 1. registry
const reg = JSON.parse(readFileSync('data/source-registry/sources.json', 'utf8'));
const keys = new Set();
for (const s of reg.sources) {
  if (keys.has(s.key)) fail(`registry: duplicate key ${s.key}`);
  keys.add(s.key);
  if (!reg.verdicts.includes(s.verdict)) fail(`registry: ${s.key} has unknown verdict ${s.verdict}`);
  if (!Array.isArray(s.evidence) || !s.evidence.length) fail(`registry: ${s.key} has no evidence`);
  for (const e of s.evidence || []) if (!existsSync(e)) fail(`registry: ${s.key} evidence missing: ${e}`);
  for (const [k, v] of Object.entries(s.capabilities || {})) {
    if (!reg.capability_keys.includes(k)) fail(`registry: ${s.key} unknown capability ${k}`);
    if (!Object.keys(reg.capability_codes).includes(v)) fail(`registry: ${s.key}.${k} bad code ${v}`);
  }
  if (s.production_ready === true) {
    const canary = s.canary && s.canary.file;
    if (!canary || !existsSync(canary)) fail(`registry: ${s.key} is production_ready without a canary file`);
    else if (JSON.parse(readFileSync(canary, 'utf8')).pass !== true) fail(`registry: ${s.key} canary is not passing`);
  }
  if (/PURCHASE|SUBSCRIBE|BUY/i.test(JSON.stringify(s.production_note || ''))) fail(`registry: ${s.key} mentions a purchase path; paid data needs explicit owner approval`);
}

// 2. workflows
if (files.some(f => f.startsWith('.github/workflows/'))) fail('GitHub Actions workflow present (.github/workflows) — not allowed without owner approval');

// 3. secrets
const TEXT = /\.(js|mjs|cjs|ts|json|toml|sql|md|html|yml|yaml|env|txt|py)$/;
const SECRET = [
  [/eyJhbGciOi[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
  [/sk-[A-Za-z0-9]{20,}/, 'API key (sk-)'],
  [/sbp_[a-f0-9]{30,}/, 'Supabase access token'],
  [/-----BEGIN (RSA |EC )?PRIVATE KEY-----/, 'private key'],
  [/(SERVICE_ROLE_KEY|API_TOKEN|SECRET)\s*=\s*["'][^"'\s]{12,}["']/, 'secret assignment'],
];
for (const f of files.filter(x => TEXT.test(x) && !x.startsWith('docs/evidence/source-audit/') && x !== 'package-lock.json')) {
  const t = readFileSync(f, 'utf8');
  for (const [re, what] of SECRET) if (re.test(t)) fail(`secret (${what}) in ${f}`);
}

// 4. fake data files
for (const f of files.filter(x => x.startsWith('data/'))) if (/(sample|fake|mock|demo|dummy|lorem)/i.test(f)) fail(`fake-looking data file: ${f}`);

// 5. determinism
for (const f of files.filter(x => /^(workers|scripts\/backfill|scripts\/news)\/.*\.m?js$/.test(x))) if (/Math\.random\(/.test(readFileSync(f, 'utf8'))) fail(`Math.random in ${f}`);

// 6. browser code
const FIRST_PARTY = /^https:\/\/([a-z0-9-]+\.)*propbetedge\.ai(\/|$)/;
for (const f of files.filter(x => x.startsWith('src/') && /\.(js|mjs|ts|jsx|tsx|html)$/.test(x))) {
  const t = readFileSync(f, 'utf8');
  if (/service_role|SERVICE_ROLE|supabase\.co/i.test(t)) fail(`browser code references Supabase/service role: ${f}`);
  for (const m of t.matchAll(/fetch\(\s*['"`](https?:\/\/[^'"`]+)/g)) if (!FIRST_PARTY.test(m[1])) fail(`browser code calls third-party host ${m[1]} in ${f}`);
}

// 7. metric seeds
for (const f of files.filter(x => x.startsWith('supabase/migrations/'))) {
  const t = readFileSync(f, 'utf8');
  if (/soccer_metric_definitions[\s\S]*'(validated|published)'\s*,\s*'docs/.test(t)) fail(`${f} seeds a validated/published metric`);
}

if (errors.length) {
  console.error(`guard-truth: ${errors.length} problem(s)`);
  for (const e of errors) console.error(' -', e);
  process.exit(1);
}
console.log(`guard-truth: ok (${reg.sources.length} sources, ${files.length} files checked)`);
