// TEMPORARY operator backlog migration (remove once the legacy backlog is converted).
// Runs ONLY inside this Worker's scheduled handler on MIGRATION_CRON: there is no HTTP route, so it cannot
// be invoked from outside, and it uses the Worker's own env (OpenAI + Supabase secrets); no credential is
// created, read out or rotated. Control plane: KV key `migration:control` = {"mode":"dry"|"apply","only":[slugs]}
// written by an operator with Cloudflare access (wrangler kv). Absent / other mode -> no-op.
// Each tick re-edits a few legacy stories with the EXISTING engine:
//   reeditArticle(store, slug, env, { dry, holdOnFail: false })
// dry: nothing is written to the article tables. apply: passing stories update in place (slug and
// published_at kept, updated_at moves, v3 packet = new append-only evidence row); failing stories are left
// exactly as they are. Results: KV `migration:backlog:<mode>` (+ `...:article:<slug>` for dry articles).
import { storeFromEnv } from '../../shared/postgrest.js';
import { reeditArticle } from './pipeline.js';

export const MIGRATION_CRON = '*/10 * * * *';
const words = a => (a?.sections || []).flatMap(s => s.paragraphs || []).join(' ').split(/\s+/).filter(Boolean).length;

export async function readControl(kv) {
  const c = kv ? await kv.get('migration:control', 'json') : null;
  if (!c || !['dry', 'apply'].includes(c.mode)) return null;
  return { mode: c.mode, only: Array.isArray(c.only) ? c.only.filter(s => typeof s === 'string') : [], per_tick: Math.max(1, Math.min(6, Number(c.per_tick) || 4)) };
}

export async function migrationTick(env, { budgetMs = 11 * 60e3 } = {}) {
  const ctl = await readControl(env.SOCCER_STATE);
  if (!ctl) return { skipped: 'no migration control' };
  const key = `migration:backlog:${ctl.mode}`;
  const state = (await env.SOCCER_STATE.get(key, 'json')) || { mode: ctl.mode, started_at: new Date().toISOString(), results: {} };
  const store = storeFromEnv(env);
  const backlog = (await store.select('soccer_articles', { columns: ['slug', 'story_class', 'composer'], eq: { status: 'published' }, order: 'published_at.asc' }))
    .filter(a => !/soccer-desk/.test(a.composer || ''));
  const scope = ctl.only.length ? backlog.filter(a => ctl.only.includes(a.slug)) : backlog;
  const todo = scope.filter(a => !state.results[a.slug]).slice(0, ctl.per_tick);
  const t0 = Date.now();
  for (const a of todo) {
    if (Date.now() - t0 > budgetMs) break;
    const started = Date.now();
    try {
      const r = await reeditArticle(store, a.slug, { ...env, NEWS_DESK: 'on' }, { dry: ctl.mode === 'dry', holdOnFail: false });
      const j = r.judgement || {};
      state.results[a.slug] = {
        slug: a.slug, story_class: a.story_class, before_composer: a.composer, packet_path: r.packet_path, packet_version: r.packet_version,
        result: r.result === 'published' ? 'PASS' : 'HOLD', holds: r.holds || [], headline: r.headline,
        words: r.article ? words(r.article) : null, sections: r.article ? r.article.sections.map(s => s.heading) : null,
        evidence: j.evidence || null, attempt: j.attempt || null, failed_gates: j.failed || [], applied: ctl.mode === 'apply' && r.result === 'published',
        seconds: Math.round((Date.now() - started) / 1000), at: new Date().toISOString(),
      };
      if (ctl.mode === 'dry' && r.article) await env.SOCCER_STATE.put(`migration:backlog:dry:article:${a.slug}`, JSON.stringify({ headline: r.article.headline, dek: r.article.dek, sections: r.article.sections, judgement: { failed: j.failed, evidence: j.evidence, attempt: j.attempt, version: j.version, quality_version: j.quality_version } }), { expirationTtl: 14 * 86400 });
    } catch (e) {
      state.results[a.slug] = { slug: a.slug, story_class: a.story_class, before_composer: a.composer, result: 'ERROR', holds: [String(e?.message || e).slice(0, 200)], at: new Date().toISOString() };
    }
    state.updated_at = new Date().toISOString();
    await env.SOCCER_STATE.put(key, JSON.stringify(state), { expirationTtl: 30 * 86400 });
  }
  state.remaining = scope.filter(a => !state.results[a.slug]).map(a => a.slug);
  if (!state.remaining.length) state.finished_at = state.finished_at || new Date().toISOString();
  await env.SOCCER_STATE.put(key, JSON.stringify(state), { expirationTtl: 30 * 86400 });
  return { mode: ctl.mode, processed: todo.length, remaining: state.remaining.length };
}
