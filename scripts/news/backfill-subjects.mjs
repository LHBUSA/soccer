#!/usr/bin/env node
// OPERATOR backfill: mark the PRIMARY SUBJECT (workers/shared/news-subject.js) on existing articles.
// For every published / held article: read its frozen evidence packet (packet_hash), derive the
// subject from the packet's material event (primaryFromPacket), and set the single marker on the
// matching entity in soccer_articles.entities. Nothing else changes (headline, body, status, dates
// untouched; updated_at is NOT moved: a subject marker is not an editorial update).
// DRY by default; --apply writes. Evidence: docs/evidence/news/subject-backfill-<date>[-dry].json.
//   node scripts/news/backfill-subjects.mjs [--apply] [--slug <slug>]...
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { markPrimary, primaryFromPacket, selectSubject, SUBJECT_VERSION } from '../../workers/shared/news-subject.js';

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

// jsonb does not keep object key order: compare canonically (sorted keys), never by raw string.
const canon = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : 1))) : x));
const rows = (await store.select('soccer_articles', { columns: ['id', 'slug', 'status', 'story_class', 'headline', 'entities', 'packet_hash'], in: { status: ['published', 'held'] } }))
  .filter(a => !SLUGS.length || SLUGS.includes(a.slug));
const out = [];
for (const a of rows) {
  const [ev] = await store.select('soccer_article_evidence', { columns: ['packet'], eq: { packet_hash: a.packet_hash }, limit: 1 });
  const primary = ev ? primaryFromPacket(ev.packet) : null;
  const before = selectSubject(a);
  const entities = markPrimary(a.entities, primary);
  const after = selectSubject({ ...a, entities });
  const changed = canon(entities) !== canon(a.entities);
  const r = { slug: a.slug, status: a.status, story_class: a.story_class, headline: a.headline, primary, marked: entities.some(e => e.primary), subject_before: before.entity?.name || null, subject_before_reason: before.reason, subject_after: after.entity?.name || null, subject_after_reason: after.reason, changed };
  if (APPLY && changed) {
    await store.update('soccer_articles', { entities }, { eq: { id: a.id } });
    const [check] = await store.select('soccer_articles', { columns: ['entities'], eq: { id: a.id }, limit: 1 });
    r.applied = canon(check.entities) === canon(entities);
  }
  out.push(r);
  console.log(`${r.changed ? (APPLY ? (r.applied ? 'APPLIED' : 'FAILED ') : 'WOULD  ') : 'same   '} ${a.slug.slice(0, 48).padEnd(48)} ${String(r.subject_before).padEnd(24)} -> ${r.subject_after} (${primary?.reason || 'no packet subject'})`);
}
const date = new Date().toISOString().slice(0, 10);
mkdirSync('docs/evidence/news', { recursive: true });
const file = `docs/evidence/news/subject-backfill-${date}${APPLY ? '' : '-dry'}.json`;
writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), subject_version: SUBJECT_VERSION, apply: APPLY, articles: out.length, changed: out.filter(r => r.changed).length, unmarked: out.filter(r => !r.marked).map(r => r.slug), subject_changed: out.filter(r => r.subject_before !== r.subject_after).map(r => ({ slug: r.slug, from: r.subject_before, to: r.subject_after })), results: out }, null, 2)}\n`);
console.log(`\n${out.length} articles, ${out.filter(r => r.changed).length} ${APPLY ? 'updated' : 'would change'}; subject changed on ${out.filter(r => r.subject_before !== r.subject_after).length}. Evidence: ${file}`);
if (APPLY && out.some(r => r.changed && !r.applied)) process.exit(1);
