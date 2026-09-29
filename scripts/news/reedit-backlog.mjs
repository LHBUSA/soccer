#!/usr/bin/env node
// OPERATOR backlog re-edit (not a production route). Calls the existing engine directly:
//   reeditArticle(store, slug, env, { dry, holdOnFail: false }) from workers/soccer-news/src/pipeline.js
// Backlog = published soccer_articles whose composer does not contain "soccer-desk".
// DRY by default: nothing is written. --apply writes PASSING stories in place (slug + published_at kept,
// updated_at moves; a v3 derived packet becomes a new append-only evidence row); failing stories stay
// exactly as they are (never unpublished).
//
// Credentials come from the operator environment only (never printed, never committed):
//   SOCCER_MODEL_SUPABASE_URL, SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY  (D:/Workers/secrets/soccer-supabase.env)
//   OPENAI_API_KEY                                                    (process environment; e.g. from the User-scope
//     variable: PowerShell  $env:OPENAI_API_KEY = [Environment]::GetEnvironmentVariable('OPENAI_API_KEY','User'))
//   NEWS_DESK_MODEL (optional)
//
//   node scripts/news/reedit-backlog.mjs [--slug <slug>]... [--apply] [--concurrency 1|2] [--list]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { reeditArticle } from '../../workers/soccer-news/src/pipeline.js';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply'); const LIST = argv.includes('--list');
const SLUGS = argv.flatMap((a, i) => (a === '--slug' && argv[i + 1] ? [argv[i + 1]] : []));
const CONC = Math.max(1, Math.min(2, Number((argv[argv.indexOf('--concurrency') + 1]) || 1) || 1));

const fileEnv = existsSync('D:/Workers/secrets/soccer-supabase.env')
  ? Object.fromEntries(readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
  : {};
const env = {
  SOCCER_MODEL_SUPABASE_URL: process.env.SOCCER_MODEL_SUPABASE_URL || fileEnv.SOCCER_MODEL_SUPABASE_URL,
  SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY: process.env.SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY || fileEnv.SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  ...(process.env.NEWS_DESK_MODEL ? { NEWS_DESK_MODEL: process.env.NEWS_DESK_MODEL } : {}),
  NEWS_DESK: 'on',
};
const missing = ['SOCCER_MODEL_SUPABASE_URL', 'SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY', ...(LIST ? [] : ['OPENAI_API_KEY'])].filter(k => !env[k]);
if (missing.length) { console.error(`ABSENT environment variable(s): ${missing.join(', ')}. Nothing was run.`); process.exit(2); }
const store = storeFromEnv(env);

const words = a => (a?.sections || []).flatMap(s => s.paragraphs || []).join(' ').split(/\s+/).filter(Boolean).length;
const backlog = (await store.select('soccer_articles', { columns: ['slug', 'story_class', 'composer', 'status', 'published_at'], eq: { status: 'published' }, order: 'published_at.asc' }))
  .filter(a => !/soccer-desk/.test(a.composer || ''));
const todo = SLUGS.length ? backlog.filter(a => SLUGS.includes(a.slug)) : backlog;
console.log(`legacy backlog: ${backlog.length} published template articles; this run: ${todo.length} (${APPLY ? 'APPLY' : LIST ? 'LIST' : 'DRY'})`);
if (SLUGS.length && todo.length !== SLUGS.length) console.log('not in the backlog (already desk or not published):', SLUGS.filter(s => !todo.some(a => a.slug === s)).join(', '));
if (LIST) { for (const a of todo) console.log(`  ${a.story_class.padEnd(24)} ${a.composer.padEnd(28)} ${a.slug}`); await new Promise(r => setTimeout(r, 50)); process.exit(0); }

const results = [];
async function one(a) {
  const t0 = Date.now();
  try {
    // Operator backlog = a legacy backfill: DETERMINISTIC under the router (owner spec 2026-09-29), no model call. A paid
    // re-edit of a named story is the admin route (POST /v1/admin/reedit?slug=).
    const r = await reeditArticle(store, a.slug, env, { dry: !APPLY, holdOnFail: false, trigger: 'backfill' });
    const j = r.judgement || {};
    const row = {
      slug: a.slug, story_class: a.story_class, packet_path: r.packet_path, packet_version: r.packet_version, before_composer: a.composer,
      result: r.result === 'published' ? 'PASS' : 'HOLD', holds: r.holds || [], new_headline: r.headline,
      word_count: APPLY ? null : words(r.article), section_count: APPLY ? null : (r.article?.sections || []).length,
      evidence_available: j.evidence?.available || null, evidence_used: j.evidence?.used || null, attempt: j.attempt || null,
      failed_gates: j.failed || [], applied: APPLY && r.result === 'published', seconds: Math.round((Date.now() - t0) / 1000),
      ...(APPLY ? {} : { article: r.article ? { headline: r.article.headline, dek: r.article.dek, sections: r.article.sections } : null, judgement: { version: j.version, quality_version: j.quality_version, pass: j.pass, failed: j.failed, results: j.results } }),
    };
    results.push(row);
    console.log(`${row.result} ${a.story_class.padEnd(24)} ${String(row.word_count ?? '-').padStart(4)}w ${String(row.section_count ?? '-').padStart(1)}s att${row.attempt ?? '-'} ${a.slug}${row.holds.length ? ` · ${row.holds.join(', ')}` : ''}`);
  } catch (e) {
    results.push({ slug: a.slug, story_class: a.story_class, before_composer: a.composer, result: 'ERROR', holds: [String(e.message).slice(0, 200)] });
    console.log(`ERROR ${a.slug} · ${String(e.message).slice(0, 160)}`);
  }
}
const queue = [...todo];
await Promise.all(Array.from({ length: CONC }, async () => { while (queue.length) await one(queue.shift()); }));

const ws = results.map(r => r.word_count).filter(n => Number.isFinite(n)).sort((x, y) => x - y);
const by = cls => results.filter(r => r.story_class === cls);
const summary = {
  at: new Date().toISOString(), mode: APPLY ? 'apply' : 'dry', total: results.length,
  pass: results.filter(r => r.result === 'PASS').length, hold: results.filter(r => r.result === 'HOLD').length, error: results.filter(r => r.result === 'ERROR').length,
  by_class: Object.fromEntries(['match_recap', 'player_form', 'team_trend', 'competition_intelligence'].map(c => [c, { pass: by(c).filter(r => r.result === 'PASS').length, hold: by(c).filter(r => r.result !== 'PASS').length }])),
  words: ws.length ? { min: ws[0], median: ws[Math.floor(ws.length / 2)], max: ws[ws.length - 1] } : null,
};
mkdirSync('docs/evidence/news', { recursive: true });
const file = `docs/evidence/news/backlog-${APPLY ? 'apply' : 'dry'}${SLUGS.length === 1 ? `-${SLUGS[0].slice(0, 40)}` : ''}.json`;
writeFileSync(file, JSON.stringify({ summary, results }, null, 2) + '\n');
console.log(JSON.stringify(summary), '\nwrote', file);
