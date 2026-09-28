#!/usr/bin/env node
// FIRST-LIVE PROOF capture for the per-minute live lane (and, for a Bundesliga match, the shadow
// enrichment). Run it from ~20 minutes before kick-off; it stops after the final is reconciled or at
// --until. It never fabricates evidence: it refuses a match that is already finished (replay traffic
// is not a live proof), and every number it reports is a timestamp it observed.
//
//   node scripts/canary/first-live.mjs --match <canonical uuid> [--until 2026-10-01T02:30:00Z] [--site https://soccer.propbetedge.ai]
//
// Vantage points (all timestamps UTC ms):
//   reference   read-only poll of the provider (ESPN Core status + score) every 10 s: when the
//               provider's state changed, bounded by the poll interval (+ the request's own time)
//   ingest      soccer-ingest /v1/admin/live (admin token): tick metrics (scheduled vs actual cron
//               start, duration, requests), the KV live state (observed_at = provider response
//               captured by the lane, changed_at), breaker, disagreements, corrections, glitches
//   api         the public cast through the web proxy /api/soccer/matches/:id/cast every 10 s
//   browser     a real Chrome on /pbecast/:id reading the scoreboard every 5 s; screenshots at
//               pregame, every observed score change, half time, every 15 min and final
//   ledger      read-only: duplicate (source_family, source_event_id) and sequence gaps for the match
// Output: docs/evidence/live/first-live-<match>-<date>.jsonl (every sample) + -summary.json,
//         screenshots in docs/evidence/live/shots/<match>/.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { storeFromEnv } from '../../workers/shared/postgrest.js';

const require = createRequire(import.meta.url);
const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const MATCH = arg('--match'); if (!/^[0-9a-f-]{36}$/.test(MATCH || '')) throw new Error('--match <canonical uuid> required');
const SITE = arg('--site', 'https://soccer.propbetedge.ai').replace(/\/$/, '');
const INGEST = arg('--ingest', 'https://soccer-ingest.sales-fd3.workers.dev');
const TOKEN = readFileSync(arg('--token-file', 'D:/Workers/secrets/soccer-ingest-admin-token'), 'utf8').trim();
const envText = readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8').replace(/^\uFEFF/, '');
const store = storeFromEnv(Object.fromEntries(envText.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])));
const registry = JSON.parse(readFileSync('data/registry/competitions.json', 'utf8'));

const [m] = await store.select('soccer_matches', { columns: ['id', 'competition_id', 'kickoff_at', 'status', 'result_provider', 'home_team_id', 'away_team_id'], eq: { id: MATCH }, limit: 1 });
if (!m) throw new Error('match not found');
if (m.status === 'finished') throw new Error('match already finished: a replay is not a live proof');
const [comp] = await store.select('soccer_competitions', { columns: ['slug'], eq: { id: m.competition_id }, limit: 1 });
const lg = registry.competitions.find(c => c.slug === comp.slug)?.espn?.league;
const [x] = await store.select('soccer_match_external_ids', { columns: ['external_id'], eq: { match_id: MATCH, provider: 'espn' }, limit: 1 });
const teamExt = new Map((await store.select('soccer_team_external_ids', { columns: ['team_id', 'external_id'], eq: { provider: 'espn' }, in: { team_id: [m.home_team_id, m.away_team_id] } })).map(r => [r.team_id, r.external_id]));
if (!lg || !x) throw new Error('no proven ESPN crosswalk for this match: nothing to measure');
const EV = x.external_id; const BASE = `https://sports.core.api.espn.com/v2/sports/soccer/leagues/${lg}/events/${EV}/competitions/${EV}`;
const UNTIL = Date.parse(arg('--until', new Date(Date.parse(m.kickoff_at) + 4 * 3600e3).toISOString()));

const day = new Date().toISOString().slice(0, 10);
const dir = 'docs/evidence/live'; const shots = `${dir}/shots/${MATCH}`; mkdirSync(shots, { recursive: true });
const LOG = `${dir}/first-live-${MATCH}-${day}.jsonl`;
const log = (kind, data) => appendFileSync(LOG, JSON.stringify({ t: Date.now(), kind, ...data }) + '\n');
const UA = { 'user-agent': 'propbetedge-soccer-first-live-proof (read-only; contact via propbetedge.ai)' };
const getJson = async (url, headers = {}) => { const t0 = Date.now(); const r = await fetch(url, { headers: { ...UA, ...headers } }); const t1 = Date.now(); return { req_at: t0, res_at: t1, status: r.status, json: r.ok ? await r.json().catch(() => null) : null }; };

log('start', { match: MATCH, competition: comp.slug, role: m.result_provider === 'espn' ? 'owner' : 'enrichment', espn_event: EV, kickoff_at: m.kickoff_at, until: new Date(UNTIL).toISOString(), site: SITE });
const S = { ref: null, api: null, dom: null, ingest: null, changes: [], ticks: new Map(), lastShot: 0, done: false };
const keyOf = (a, b, st) => `${st}|${a}-${b}`;

async function reference() {
  const st = await getJson(`${BASE}/status`);
  const [h, a] = await Promise.all([m.home_team_id, m.away_team_id].map(t => getJson(`${BASE}/competitors/${teamExt.get(t)}/score`)));
  const state = st.json?.type?.state; const clock = st.json?.displayClock || null; const k = keyOf(h.json?.value, a.json?.value, state);
  if (S.ref?.k !== k) { S.changes.push({ key: k, provider_seen_at: st.res_at, provider_prev_seen_at: S.ref?.at || null, clock }); log('reference_change', { key: k, clock, req_at: st.req_at, res_at: st.res_at, prev: S.ref?.k || null }); }
  S.ref = { k, at: st.res_at, clock };
}
async function ingest() {
  const [one, all] = await Promise.all([getJson(`${INGEST}/v1/admin/live?match=${MATCH}`, { authorization: `Bearer ${TOKEN}` }), getJson(`${INGEST}/v1/admin/live`, { authorization: `Bearer ${TOKEN}` })]);
  const ls = one.json?.live_state || null;
  if (ls) { const k = keyOf(ls.score?.home, ls.score?.away, ls.status === 'live' ? 'in' : ls.status === 'finished' ? 'post' : 'pre'); if (S.ingest?.k !== k) log('ingest_change', { key: k, observed_at: ls.observed_at, changed_at: ls.changed_at, clock: ls.display_clock, role: ls.role, mode: ls.mode }); S.ingest = { k, ls }; }
  for (const t of all.json?.metrics || []) if (!S.ticks.has(t.at)) { S.ticks.set(t.at, t); log('tick', t); }
  log('ingest_state', { canonical: one.json?.canonical, breaker: all.json?.breaker, disagreements: (all.json?.disagreements || []).filter(d => d.match_id === MATCH).length, corrections: (all.json?.corrections || []).filter(c => c.match_id === MATCH), glitches: (all.json?.glitches || []).filter(g => g.match_id === MATCH).length });
  if (ls?.reconciled || (ls?.role !== 'enrichment' && ls?.final_done)) S.done = true;
}
async function api() {
  const r = await getJson(`${SITE}/api/soccer/matches/${MATCH}/cast`);
  const d = r.json?.data; if (!d) return;
  const sc = d.live?.enrichment?.score || d.score; const k = keyOf(sc?.home, sc?.away, d.status === 'live' ? 'in' : d.status === 'finished' ? 'post' : 'pre');
  if (S.api?.k !== k) log('api_change', { key: k, res_at: r.res_at, clock: d.live?.display_clock || d.live?.enrichment?.clock?.display || null, stale: d.live?.stale, mode: d.live?.mode, enrichment_served: !!d.live?.enrichment });
  // Duplicate check on the served sequence (same minute + type + player twice).
  const seen = new Set(); const dups = [];
  for (const it of d.sequence || []) { const s = `${it.minute}|${it.type}|${it.player?.id || it.player_in?.id || ''}`; if (seen.has(s) && it.type !== 'shot') dups.push(s); seen.add(s); }
  if (dups.length) log('api_duplicates', { dups });
  S.api = { k, at: r.res_at };
}
async function ledgerCheck() {
  const ev = await store.select('soccer_match_events', { columns: ['source_event_id', 'sequence'], eq: { match_id: MATCH, source_family: 'espn' }, order: 'sequence.asc' });
  const ids = ev.map(e => e.source_event_id); const dupIds = ids.filter((v, i) => ids.indexOf(v) !== i);
  const gaps = ev.filter((e, i) => e.sequence !== i + 1).length;
  log('ledger', { events: ev.length, duplicate_source_ids: dupIds.length, sequence_gaps: gaps });
}

const puppeteer = require('puppeteer-core');
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: 'D:/Temp/soccer-first-live-chrome', args: ['--no-first-run', '--disable-extensions'] });
const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 900 });
await page.goto(`${SITE}/pbecast/${MATCH}`, { waitUntil: 'networkidle0', timeout: 60000 });
const shot = async label => { await page.bringToFront(); await page.screenshot({ path: `${shots}/${Date.now()}-${label}.png` }); log('screenshot', { label }); };
await shot('pregame');
async function dom() {
  const v = await page.evaluate(() => ({ score: [...document.querySelectorAll('.ct-score span')].map(s => s.textContent).join('-'), status: document.querySelector('.ct-status')?.innerText || '', mode: document.querySelector('.cast-top')?.className || '' })).catch(() => null);
  if (!v) return;
  const k = `${/live/.test(v.mode) ? 'in' : /replay/.test(v.mode) ? 'post' : 'pre'}|${v.score.replace(/–/g, '-')}`;
  if (S.dom?.k !== k) { log('browser_change', { key: k, status: v.status.slice(0, 120) }); await shot(`change-${k.replace(/[^a-z0-9-]/gi, '_')}`); }
  if (Date.now() - S.lastShot > 15 * 60e3) { S.lastShot = Date.now(); await shot('periodic'); }
  S.dom = { k };
}

let n = 0;
while (Date.now() < UNTIL && !S.done) {
  const loop = [reference(), api()];
  if (n % 2 === 0) loop.push(dom());
  if (n % 3 === 0) loop.push(ingest());
  if (n % 18 === 0) loop.push(ledgerCheck());
  await Promise.allSettled(loop).then(rs => rs.filter(r => r.status === 'rejected').forEach(r => log('error', { message: String(r.reason?.message || r.reason).slice(0, 200) })));
  n += 1; await new Promise(r => setTimeout(r, 10000));
}
await shot('final'); await ledgerCheck(); await ingest();
await browser.close();

// Summary: provider change -> ingest -> API -> browser, per observed score/status change.
const rows = readFileSync(LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const first = (kind, key) => rows.find(r => r.kind === kind && r.key === key);
const chain = S.changes.map(c => {
  const ing = first('ingest_change', c.key); const ap = first('api_change', c.key);
  const br = rows.find(r => r.kind === 'browser_change' && r.key.split('|')[1] === c.key.split('|')[1]);
  const p = c.provider_seen_at;
  return { key: c.key, provider_seen_at: new Date(p).toISOString(), provider_change_bound_ms: c.provider_prev_seen_at ? p - c.provider_prev_seen_at : null,
    ingest_ms: ing?.observed_at ? Date.parse(ing.observed_at) - p : null, api_ms: ap ? ap.res_at - p : null, browser_ms: br ? br.t - p : null };
});
const ticks = [...S.ticks.values()];
const q = (xs, p) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))] : null; };
const summary = {
  match: MATCH, competition: comp.slug, kickoff_at: m.kickoff_at, finished_capture_at: new Date().toISOString(), completed: S.done,
  ticks: ticks.length, cron_start_lag_ms: { median: q(ticks.map(t => t.started_lag_ms), 0.5), p95: q(ticks.map(t => t.started_lag_ms), 0.95) },
  tick_duration_ms: { median: q(ticks.map(t => t.duration_ms), 0.5), p95: q(ticks.map(t => t.duration_ms), 0.95) },
  provider_to_ingest_ms: { median: q(chain.map(c => c.ingest_ms), 0.5), p95: q(chain.map(c => c.ingest_ms), 0.95) },
  provider_to_api_ms: { median: q(chain.map(c => c.api_ms), 0.5), p95: q(chain.map(c => c.api_ms), 0.95) },
  provider_to_browser_ms: { median: q(chain.map(c => c.browser_ms), 0.5), p95: q(chain.map(c => c.browser_ms), 0.95) },
  changes: chain,
  api_duplicates: rows.filter(r => r.kind === 'api_duplicates').length,
  ledger_last: rows.filter(r => r.kind === 'ledger').at(-1) || null,
  errors: rows.filter(r => r.kind === 'error').length,
  note: 'Provider change times are bounded by the 10 s reference poll; latency is proven only by a completed real match.',
};
writeFileSync(`${dir}/first-live-${MATCH}-${day}-summary.json`, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
