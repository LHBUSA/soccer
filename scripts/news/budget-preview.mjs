#!/usr/bin/env node
// Phase 5 dark evidence (read-only): (1) the budget view /health would show right now (5A policy) from production
// sources, and (2) the real per-competition OpenAI spend distribution over the last N days, attributed through the
// newsroom's own rows (usage ledger news_event_id -> soccer_news_events.competition_id). Nominal standard-rate
// estimates, never billing. Nothing is written (GET-only fetch guard).
//   node scripts/news/budget-preview.mjs [--days 14] [--out docs/evidence/news/budget-preview-<date>.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { NEWS_COMPETITIONS } from '../../workers/soccer-news/src/pipeline.js';
import { budgetView, DEFAULT_POLICY, SPEND_BASIS } from '../../workers/soccer-news/src/budget.js';
import { LEDGER_TABLE } from '../../workers/soccer-news/src/openai-cost.js';

const envText = readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8').replace(/^\uFEFF/, '');
const env = Object.fromEntries(envText.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const restBase = `${env.SOCCER_MODEL_SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/`;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (!String(url).startsWith(restBase) || (init.method || 'GET') !== 'GET') throw new Error(`preview fetch guard: blocked ${init.method || 'GET'} ${String(url).slice(0, 80)}`);
  return realFetch(url, init);
};
const store = storeFromEnv(env);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const days = Number(arg('--days', 14));
const now = Date.now();
// (1) the 5A view: no budget docs exist before the release, so competition spend is 0 and the global numbers are live
const emptyKv = { get: async () => null };
const view = await budgetView({ ...env, SOCCER_STATE: emptyKv }, { competitions: NEWS_COMPETITIONS, now });
// (2) real distribution
const since = new Date(now - days * 86400e3).toISOString().slice(0, 10) + 'T00:00:00Z';
const rows = await store.select(LEDGER_TABLE, { columns: ['occurred_at', 'news_event_id', 'trigger', 'estimated_usd', 'status'], gte: { occurred_at: since }, order: 'occurred_at.asc' });
const ids = [...new Set(rows.map(r => r.news_event_id).filter(Boolean))];
const evComp = new Map();
for (let i = 0; i < ids.length; i += 100) for (const e of await store.select('soccer_news_events', { columns: ['id', 'competition_id', 'story_class'], in: { id: ids.slice(i, i + 100) } })) evComp.set(e.id, e);
const comps = await store.select('soccer_competitions', { columns: ['id', 'slug'], in: { slug: NEWS_COMPETITIONS } });
const slugOf = new Map(comps.map(c => [c.id, c.slug]));
const by = {}; const byDay = {};
for (const r of rows) {
  const e = evComp.get(r.news_event_id); const slug = e ? slugOf.get(e.competition_id) || 'other' : 'unattributed';
  const d = String(r.occurred_at).slice(0, 10);
  const x = (by[slug] ||= { calls: 0, usd: 0, by_trigger: {} }); x.calls += 1; x.usd += Number(r.estimated_usd) || 0; x.by_trigger[r.trigger] = (x.by_trigger[r.trigger] || 0) + 1;
  const y = ((byDay[d] ||= {})[slug] ||= { calls: 0, usd: 0 }); y.calls += 1; y.usd += Number(r.estimated_usd) || 0;
}
const r6 = x => Math.round(x * 1e6) / 1e6;
for (const v of Object.values(by)) v.usd = r6(v.usd);
for (const d of Object.values(byDay)) for (const v of Object.values(d)) v.usd = r6(v.usd);
const total = r6(Object.values(by).reduce((s, v) => s + v.usd, 0));
const dayTotals = Object.entries(byDay).map(([d, v]) => [d, r6(Object.values(v).reduce((s, x) => s + x.usd, 0))]);
const out = { at: new Date(now).toISOString(), note: 'read-only; nothing deployed or written', basis: SPEND_BASIS, policy_5a: DEFAULT_POLICY, view_now: view, distribution: { days, since, calls: rows.length, total_usd: total, by_competition: by, max_day_usd: Math.max(0, ...dayTotals.map(x => x[1])), by_day: byDay } };
console.log('global now:', JSON.stringify(view.global));
for (const c of NEWS_COMPETITIONS) console.log(' ', c.padEnd(24), JSON.stringify(view.competitions[c]));
console.log(`\n${days}-day distribution: ${rows.length} calls, $${total} (max day $${out.distribution.max_day_usd})`);
for (const [s, v] of Object.entries(by).sort((a, b) => b[1].usd - a[1].usd)) console.log(' ', s.padEnd(24), `${v.calls} calls`, `$${v.usd}`, JSON.stringify(v.by_trigger));
if (arg('--out')) { writeFileSync(arg('--out'), JSON.stringify(out, null, 1) + '\n'); console.log('wrote', arg('--out')); }
