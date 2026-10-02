#!/usr/bin/env node
// RESET a HELD Pass A season so it can be rebuilt (e.g. after a resolver fix). Refuses unless the season is 'held' AND
// carries nothing beyond the Pass A skeleton (no lineups, events, statistics, news, algo, shadow or video rows on any of
// its matches). Deletes, children first: enrichment ledger, source results, ESPN crosswalks, then the matches, and the
// season's identity-queue entries for ESPN match events. The season row, stages and team identities stay.
// Raw captures (R2 + soccer_source_captures) are never touched. Dry run by default.
//   node scripts/history/reset-held-season.mjs <competition-slug> <season-label> [--apply]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const [slug, label] = process.argv.slice(2); const APPLY = process.argv.includes('--apply');
const env = Object.fromEntries(readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const U = env.SOCCER_MODEL_SUPABASE_URL; if (!/tkmlnhmylqnttmnsnief/.test(U)) throw new Error('target guard');
const h = { apikey: env.SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY}` };
const get = async q => { const r = await fetch(`${U}/rest/v1/${q}`, { headers: h }); if (!r.ok) throw new Error(`${r.status} ${q}`); return r.json(); };
const cnt = async q => Number(((await fetch(`${U}/rest/v1/${q}`, { method: 'HEAD', headers: { ...h, prefer: 'count=exact' } })).headers.get('content-range') || '').split('/')[1]);
const del = async q => { const r = await fetch(`${U}/rest/v1/${q}`, { method: 'DELETE', headers: { ...h, prefer: 'return=minimal,count=exact' } }); if (!r.ok) throw new Error(`DELETE ${r.status} ${q.slice(0, 80)} ${await r.text()}`); return Number((r.headers.get('content-range') || '').split('/')[1]) || 0; };
const [c] = await get(`soccer_competitions?select=id&slug=eq.${slug}`);
const [s] = await get(`soccer_seasons?select=id,label,publication_state&competition_id=eq.${c.id}&label=eq.${encodeURIComponent(label)}`);
if (!s) throw new Error('no such season');
if (s.publication_state !== 'held') throw new Error(`REFUSED: ${slug} ${label} is ${s.publication_state}`);
const ids = (await get(`soccer_matches?select=id&season_id=eq.${s.id}&limit=2000`)).map(m => m.id);
const chunks = []; for (let i = 0; i < ids.length; i += 80) chunks.push(ids.slice(i, i + 80));
const deep = ['soccer_lineups', 'soccer_match_events', 'soccer_match_stats', 'soccer_team_match_stats', 'soccer_player_match_stats', 'soccer_substitutions', 'soccer_possessions', 'soccer_news_events', 'soccer_algo_events', 'soccer_algo_forecasts', 'soccer_algo_picks', 'soccer_model_shadow_events', 'soccer_model_shadow_predictions', 'soccer_video_links'];
const blocking = {}; for (const t of deep) { let n = 0; for (const ch of chunks) n += await cnt(`${t}?select=match_id&match_id=in.(${ch.join(',')})`); if (n) blocking[t] = n; }
if (Object.keys(blocking).length) throw new Error(`REFUSED: beyond the Pass A skeleton: ${JSON.stringify(blocking)}`);
const espnIds = []; for (const ch of chunks) espnIds.push(...(await get(`soccer_match_external_ids?select=external_id&provider=eq.espn&match_id=in.(${ch.join(',')})`)).map(x => x.external_id));
const queued = (await get(`soccer_identity_queue?select=external_id,payload&entity_type=eq.match&provider=eq.espn`)).filter(q => q.payload?.competition === slug && String(q.payload?.year) === label.slice(0, 4));
const out = { at: new Date().toISOString(), mode: APPLY ? 'apply' : 'dry_run', competition: slug, season: label, matches: ids.length, espn_crosswalks: espnIds.length, queued_match_events: queued.length };
if (APPLY) {
  const n = { enrichment: 0, source_results: 0, crosswalks: 0, matches: 0, queue: 0 };
  for (const ch of chunks) { const inn = `in.(${ch.join(',')})`; n.enrichment += await del(`soccer_match_enrichment?match_id=${inn}`); n.source_results += await del(`soccer_match_source_results?match_id=${inn}`); n.crosswalks += await del(`soccer_match_external_ids?match_id=${inn}`); n.matches += await del(`soccer_matches?id=${inn}`); }
  for (const q of queued) n.queue += await del(`soccer_identity_queue?entity_type=eq.match&provider=eq.espn&external_id=eq.${q.external_id}`);
  out.deleted = n; out.remaining_matches = await cnt(`soccer_matches?select=id&season_id=eq.${s.id}`);
}
mkdirSync('docs/evidence/history', { recursive: true });
writeFileSync(`docs/evidence/history/reset-${slug}-${label.replace('/', '-')}-${out.at.slice(0, 10)}-${out.mode}.json`, `${JSON.stringify({ ...out, espn_event_ids: espnIds }, null, 1)}\n`);
console.log(JSON.stringify(out));
