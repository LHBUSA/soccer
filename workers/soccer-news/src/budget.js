// Phase 5 (docs/COMPETITION_DESKS.md section 9): COMPETITION BUDGET ISOLATION - control plane.
// The GLOBAL fail-closed breaker (openai-cost.js overCeiling / SOCCER_OPENAI_DAILY_MAX_USD, checked inside desk.js
// runDesk) is untouched and always decides first: this module DEFERS to it whenever global spend is exhausted or
// unreadable, so nothing here can ever let a call through that the global breaker would stop.
// On top of it, each competition may spend while (a) it is inside its protected floor, or (b) the shared pool (the
// ceiling minus every floor) has room at the story's priority tier: recaps may use the whole pool, previews / matchday
// the pool minus the recap reservation, form / trend / table the pool minus both reservations. A competition never
// borrows another competition's floor.
// PHASE 5A POLICY = today's behaviour: floor 0 %, pool 100 %, reservations 0, no daily story cap. Then the pool IS
// the global ceiling and this gate can only ever deny when the global breaker also denies (and then it defers).
//
// Accounting (KV, no migration): `news:budget:<YYYY-MM-DD UTC>:<slug>` = { stories: { <news_event_id>: entry } } + totals
// recomputed from the map on every write. Keyed by the story's event id, so a retried runner OVERWRITES its entry and
// can never double-charge. Each entry's cost is read back from the same source the global breaker reads (the durable
// usage ledger by news_event_id, else the KV call log): nominal standard-rate ESTIMATES, labelled as such.
import { storeFromEnv } from '../../shared/postgrest.js';
import { spentToday, dailyMaxUsd, readCallLog, LEDGER_TABLE } from './openai-cost.js';
import { route, reachesTransport } from './ai-router.js';
import { deskAvailable, packetRichness } from './desk.js';
import registryData from '../../../data/registry/competitions.json' with { type: 'json' };

export const BUDGET_VERSION = 'soccer-news-budget/1.0.0';
export const SPEND_BASIS = 'nominal_standard_rate_estimate'; // never shown as exact billing
// Phase 5A: behaviour-identical policy.
export const DEFAULT_POLICY = Object.freeze({ floor_pct: 0, pool_pct: 100, reserve_pct: Object.freeze({ recap: 0, preview: 0 }), max_stories_day: null });
export const HOLD_ALLOWANCE = 'budget_competition_allowance';
export const HOLD_STORY_CAP = 'budget_competition_story_cap';
export const HOLD_ACCOUNTING = 'budget_competition_accounting_unavailable';

export const dayOf = ms => new Date(ms).toISOString().slice(0, 10);
export const budgetKey = (day, slug) => `news:budget:${day}:${slug}`;

// Priority tier of a story (shared-pool order): final-ready recaps > previews / matchday > form / trend / table.
export function tierOf(packet) {
  const k = packet?.event?.kind;
  if (k === 'match_recap') return 'recap';
  if (k === 'match_preview') return 'preview';
  return 'form';
}

// Per-competition policy: code default + optional registry `news.allowance` { floor_pct, max_stories_day } (no registry
// value exists in phase 5A) + a global override object for tests / later phases.
export function policyFor(slug, { registry = registryData, global = DEFAULT_POLICY } = {}) {
  const a = registry.competitions.find(c => c.slug === slug)?.news?.allowance || {};
  return { floor_pct: Number.isFinite(a.floor_pct) ? a.floor_pct : global.floor_pct, pool_pct: global.pool_pct, reserve_pct: global.reserve_pct, max_stories_day: Number.isInteger(a.max_stories_day) ? a.max_stories_day : global.max_stories_day };
}

// Pure decision. docs = { slug: doc|null } for every enabled competition (today); globalSpend from the breaker's source.
export function decideAllowance({ slug, tier, competitions, docs, globalSpend, max, policies }) {
  const floor = c => (max * (policies[c].floor_pct || 0)) / 100;
  const floorsTotal = competitions.reduce((s, c) => s + floor(c), 0);
  const pool = Math.max(0, Math.min((max * policies[slug].pool_pct) / 100, max - floorsTotal));
  const spend = c => docs[c]?.spend_usd || 0;
  const floorUsed = competitions.reduce((s, c) => s + Math.min(spend(c), floor(c)), 0);
  const poolUsed = Math.max(0, globalSpend - floorUsed); // everything above floors, incl. spend no competition owns
  const r = policies[slug].reserve_pct || {};
  const cap = tier === 'recap' ? pool : tier === 'preview' ? pool * (1 - (r.recap || 0) / 100) : pool * (1 - ((r.recap || 0) + (r.preview || 0)) / 100);
  const nums = { floor_usd: round(floor(slug)), spend_usd: round(spend(slug)), pool_usd: round(pool), pool_used_usd: round(poolUsed), tier, tier_cap_usd: round(cap), global_spend_usd: round(globalSpend), max_usd: max };
  const stories = docs[slug]?.stories_attempted || 0;
  if (Number.isInteger(policies[slug].max_stories_day) && stories >= policies[slug].max_stories_day) return { ok: false, reason: HOLD_STORY_CAP, state: 'story_cap', ...nums, stories_today: stories };
  if (spend(slug) < floor(slug)) return { ok: true, state: 'floor', ...nums };
  if (poolUsed < cap) return { ok: true, state: 'pool', ...nums };
  return { ok: false, reason: HOLD_ALLOWANCE, state: 'exhausted', ...nums };
}
const round = x => Math.round(x * 1e6) / 1e6;

export async function readDocs(kv, day, slugs) {
  if (!kv) throw new Error('no KV');
  const out = {};
  for (const s of slugs) {
    const raw = await kv.get(budgetKey(day, s));
    if (raw == null) { out[s] = null; continue; }
    const d = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!d || d.version?.split('/')[0] !== BUDGET_VERSION.split('/')[0] || typeof d.stories !== 'object') throw new Error(`malformed budget doc ${s}`);
    out[s] = d;
  }
  return out;
}

// The pre-desk gate for one story. Returns { ok, reason?, defer?, ... }. Order: not a paid stage -> pass; global breaker
// exhausted / unreadable -> pass (runDesk holds, fail-closed, exactly as before); accounting unreadable -> HOLD
// (fail closed for this competition); else the allowance decision.
export async function allowanceGate({ env, slug, packet, competitions, clock = Date.now, trigger = 'new_story', policies = null, accountingBroken = false }) {
  const lane = route({ packet, trigger, attempt: 1, env, hasKey: deskAvailable(env), richness: packetRichness(packet) });
  if (!reachesTransport(lane)) return { ok: true, defer: 'not_a_paid_stage' };
  const now = clock();
  const max = dailyMaxUsd(env);
  let globalSpend;
  try { globalSpend = await spentToday(env, now); } catch { return { ok: true, defer: 'global_budget_unreadable' }; }
  if (globalSpend >= max) return { ok: true, defer: 'global_ceiling_reached' };
  if (accountingBroken) return { ok: false, reason: HOLD_ACCOUNTING, state: 'accounting_unavailable', error: 'an earlier story of this run could not be recorded' };
  let docs;
  try { docs = await readDocs(env.SOCCER_STATE, dayOf(now), competitions); } catch (e) { return { ok: false, reason: HOLD_ACCOUNTING, state: 'accounting_unavailable', error: String(e?.message || e).slice(0, 120) }; }
  const pol = policies || Object.fromEntries(competitions.map(c => [c, policyFor(c)]));
  return decideAllowance({ slug, tier: tierOf(packet), competitions, docs, globalSpend, max, policies: pol });
}

// Cost of ONE story today from the breaker's own sources (ledger by news_event_id, else the KV call log).
export async function storyCost(env, eventId, now) {
  const day = dayOf(now);
  const store = (() => { try { return storeFromEnv(env); } catch { return null; } })();
  let rows = null;
  if (store) { try { rows = await store.select(LEDGER_TABLE, { columns: ['estimated_usd', 'status'], eq: { news_event_id: eventId }, gte: { occurred_at: `${day}T00:00:00Z` } }); } catch { rows = null; } }
  if (!rows) rows = (await readCallLog(env.SOCCER_STATE, `${day}T00:00:00Z`)).filter(c => c.news_event_id === eventId); // throws if KV unreadable
  return { calls: rows.length, usd: round(rows.reduce((s, c) => s + (Number(c.estimated_usd) || 0), 0)) };
}

// Record one paid-eligible story in its competition's day doc (read-modify-write; runners are sequential, entries are
// keyed by event id: idempotent). Throws on failure (the runner then fails closed for the rest of its run).
export async function recordStory(env, { slug, eventId, status, holdReasons = [], storyClass, tier, now }) {
  const kv = env.SOCCER_STATE; if (!kv) throw new Error('no KV');
  const day = dayOf(now);
  const cost = await storyCost(env, eventId, now);
  const key = budgetKey(day, slug);
  const raw = await kv.get(key);
  const doc = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : { version: BUDGET_VERSION, slug, day, stories: {} };
  doc.stories[eventId] = { status, hold_reasons: holdReasons, story_class: storyClass, tier, calls: cost.calls, usd: cost.usd, at: new Date(now).toISOString() };
  const vals = Object.values(doc.stories);
  Object.assign(doc, {
    version: BUDGET_VERSION, slug, day, basis: SPEND_BASIS,
    stories_attempted: vals.length, stories_published: vals.filter(v => v.status === 'published').length, stories_held: vals.filter(v => v.status === 'held').length,
    budget_holds: vals.filter(v => (v.hold_reasons || []).some(r => r.startsWith('budget_competition_'))).length,
    desk_calls: vals.reduce((s, v) => s + (v.calls || 0), 0), spend_usd: round(vals.reduce((s, v) => s + (v.usd || 0), 0)), updated_at: new Date(now).toISOString(),
  });
  await kv.put(key, JSON.stringify(doc), { expirationTtl: 40 * 86400 });
  return doc;
}

// Health / reporting view for every enabled competition (no writes).
export async function budgetView(env, { competitions, now = Date.now(), policies = null }) {
  const max = dailyMaxUsd(env); const day = dayOf(now);
  let globalSpend = null; let globalError = null;
  try { globalSpend = await spentToday(env, now); } catch (e) { globalError = String(e?.message || e).slice(0, 120); }
  let docs = null; let docsError = null;
  try { docs = await readDocs(env.SOCCER_STATE, day, competitions); } catch (e) { docsError = String(e?.message || e).slice(0, 120); }
  const pol = policies || Object.fromEntries(competitions.map(c => [c, policyFor(c)]));
  const per = {};
  for (const c of competitions) {
    const d = docs?.[c] || null;
    const dec = docs && globalSpend !== null ? decideAllowance({ slug: c, tier: 'recap', competitions, docs, globalSpend, max, policies: pol }) : null;
    per[c] = {
      spend_today_usd: d ? d.spend_usd : docs ? 0 : null, desk_calls_today: d ? d.desk_calls : docs ? 0 : null, stories_today: d ? d.stories_attempted : docs ? 0 : null,
      budget_holds_today: d ? d.budget_holds : docs ? 0 : null,
      allowance_today_usd: dec ? round(dec.floor_usd + dec.pool_usd) : null, floor_today_usd: dec ? dec.floor_usd : null,
      shared_pool_today_usd: dec ? round(Math.max(0, (d?.spend_usd || 0) - dec.floor_usd)) : null,
      budget_state: docsError ? 'accounting_unavailable' : globalError ? 'global_budget_unreadable' : globalSpend >= max ? 'global_ceiling_reached' : dec.state,
    };
  }
  const attributed = docs ? round(competitions.reduce((s, c) => s + (docs[c]?.spend_usd || 0), 0)) : null;
  return {
    version: BUDGET_VERSION, basis: SPEND_BASIS, day, policy: DEFAULT_POLICY,
    global: { ceiling_usd: max, spend_today_usd: globalSpend, remaining_usd: globalSpend === null ? null : round(Math.max(0, max - globalSpend)), attributed_to_competitions_usd: attributed, unattributed_usd: attributed === null || globalSpend === null ? null : round(Math.max(0, globalSpend - attributed)), shared_pool_used_usd: poolUsed(docs, globalSpend, competitions, max, pol), ...(globalError ? { error: globalError } : {}) },
    ...(docsError ? { accounting_error: docsError } : {}),
    competitions: per,
  };
}
// pool used = every dollar above the floors, including spend no competition owns (admin re-edits, canaries)
const poolUsed = (docs, globalSpend, competitions, max, pol) => (docs && globalSpend !== null && competitions.length ? decideAllowance({ slug: competitions[0], tier: 'recap', competitions, docs, globalSpend, max, policies: pol }).pool_used_usd : null);
