#!/usr/bin/env node
// OPERATOR backfill: give existing articles their data visuals (soccer-visuals) from their OWN frozen evidence
// packet (soccer_articles.packet_hash) plus, for recaps, the match's canonical located shot events. Visuals are
// frozen into body.visuals with observed_at = now. An article that already has visuals is NEVER touched (a
// published chart is a historical record). Headline, prose, status and dates are unchanged; updated_at is not
// moved. DRY by default; --apply writes. Evidence: docs/evidence/news/visual-backfill-<date>[-dry].json.
//   node scripts/news/backfill-visuals.mjs [--apply] [--slug <slug>]...
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { articleVisuals } from '../../workers/soccer-news/src/pipeline.js';
import { VISUALS_VERSION } from '../../workers/soccer-news/src/visuals.js';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const SLUGS = argv.flatMap((a, i) => (a === '--slug' && argv[i + 1] ? [argv[i + 1]] : []));
const fileEnv = existsSync('D:/Workers/secrets/soccer-supabase.env')
  ? Object.fromEntries(readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
  : {};
const store = storeFromEnv({
  SOCCER_MODEL_SUPABASE_URL: process.env.SOCCER_MODEL_SUPABASE_URL || fileEnv.SOCCER_MODEL_SUPABASE_URL,
  SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY: process.env.SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY || fileEnv.SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY,
});
if (!store) throw new Error('SOCCER_MODEL_SUPABASE_URL / SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY not set');

const rows = (await store.select('soccer_articles', { columns: ['id', 'slug', 'status', 'story_class', 'packet_hash', 'body'], in: { status: ['published', 'held'] } }))
  .filter(a => !SLUGS.length || SLUGS.includes(a.slug));
const out = [];
const now = Date.now();
for (const a of rows) {
  if (Array.isArray(a.body?.visuals)) { out.push({ slug: a.slug, skipped: 'already has frozen visuals', visuals: a.body.visuals.map(v => v.type) }); continue; }
  const [ev] = await store.select('soccer_article_evidence', { columns: ['packet'], eq: { packet_hash: a.packet_hash }, limit: 1 });
  if (!ev) { out.push({ slug: a.slug, skipped: 'no evidence packet' }); continue; }
  const vis = await articleVisuals(store, ev.packet, now);
  const body = { ...a.body, visuals_version: VISUALS_VERSION, visuals: vis.visuals, visual_emphasis: [], ...(vis.rejected.length ? { visuals_rejected: vis.rejected } : {}) };
  const r = { slug: a.slug, status: a.status, story_class: a.story_class, packet_version: ev.packet.version, visuals: vis.visuals.map(v => `${v.type}:${v.values_hash.slice(0, 10)}`), rejected: vis.rejected };
  if (APPLY) {
    await store.update('soccer_articles', { body }, { eq: { id: a.id } });
    const [check] = await store.select('soccer_articles', { columns: ['body'], eq: { id: a.id }, limit: 1 });
    r.applied = JSON.stringify((check.body.visuals || []).map(v => v.values_hash)) === JSON.stringify(vis.visuals.map(v => v.values_hash));
  }
  out.push(r);
  console.log(`${APPLY ? (r.applied ? 'APPLIED' : 'FAILED ') : 'WOULD  '} ${a.slug.slice(0, 50).padEnd(50)} ${r.visuals.map(x => x.split(':')[0]).join(',')}${vis.rejected.length ? ` REJECTED ${vis.rejected.map(x => x.id).join(',')}` : ''}`);
}
const date = new Date(now).toISOString().slice(0, 10);
mkdirSync('docs/evidence/news', { recursive: true });
const file = `docs/evidence/news/visual-backfill-${date}${APPLY ? '' : '-dry'}.json`;
writeFileSync(file, `${JSON.stringify({ at: new Date(now).toISOString(), visuals_version: VISUALS_VERSION, apply: APPLY, articles: out.length, built: out.filter(r => r.visuals && !r.skipped).length, skipped: out.filter(r => r.skipped).length, rejected: out.filter(r => r.rejected?.length).map(r => ({ slug: r.slug, rejected: r.rejected })), results: out }, null, 2)}\n`);
console.log(`\n${out.length} articles; ${out.filter(r => !r.skipped).length} ${APPLY ? 'written' : 'would be written'}; ${out.filter(r => r.skipped).length} skipped. Evidence: ${file}`);
if (APPLY && out.some(r => !r.skipped && !r.applied)) process.exit(1);
