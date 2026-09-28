#!/usr/bin/env node
// PBEcast portrait audit (read-only), in the order people see players: every player the cast payload
// draws (feed, starting XIs, benches, player impact) for the current replay / live matches. For every
// silhouette: NO APPROVED PHOTO (database has none) vs API BUG (database has a displayable primary, the
// payload lacks it) vs UI BUG (payload has it, the bytes do not load). Also: why no photo exists.
//   node scripts/media/pbecast-portraits.mjs [--matches id,id]
import { readFileSync, writeFileSync } from 'node:fs';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { chunkArr } from '../../workers/soccer-ingest/src/store.js';
const SITE = 'https://soccer.propbetedge.ai'; const API = `${SITE}/api/soccer`;
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const envText = readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8');
const store = storeFromEnv(Object.fromEntries(envText.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])));
const get = async p => (await (await fetch(`${API}/${p}`)).json()).data;
async function selectIn(table, col, vals, opts) { const out = []; for (const p of chunkArr([...new Set(vals)], 150)) out.push(...await store.select(table, { ...opts, in: { ...(opts.in || {}), [col]: p } })); return out; }

const live = await get('live');
const ids = arg('--matches', '') ? arg('--matches').split(',') : [...new Set(['d4ad8521-0307-54bc-b612-ca070741c9ac', ...(live.live || []).map(m => m.id), ...(live.recent || []).map(m => m.id)])];
const perMatch = []; const players = new Map(); // slug -> { name, has_portrait_in_api, url, surfaces:Set, matches:Set }
const note = (p, surface, mid) => { if (!p?.slug) return; const r = players.get(p.slug) || { slug: p.slug, name: p.name, api_url: null, surfaces: new Set(), matches: new Set() }; if (p.portrait?.url) r.api_url = p.portrait.url; r.surfaces.add(surface); r.matches.add(mid); players.set(p.slug, r); };
for (const id of ids) {
  const c = await get(`matches/${id}/cast`);
  const seen = new Set();
  const add = (p, surface) => { note(p, surface, id); if (p?.slug) seen.add(p.slug); };
  for (const x of c.sequence || []) { add(x.player, 'feed'); add(x.assist, 'feed'); add(x.player_in, 'feed'); add(x.player_out, 'feed'); }
  for (const k of ['home', 'away']) { for (const p of c.lineups?.[k]?.starters || []) add(p, 'starting_xi'); for (const p of c.lineups?.[k]?.bench || []) add(p, 'bench'); }
  for (const r of c.players?.rows || []) add(r.player, 'player_impact');
  const withPic = [...seen].filter(s => players.get(s).api_url).length;
  perMatch.push({ id, match: `${c.home?.short_name || c.home?.name} v ${c.away?.short_name || c.away?.name}`, competition: c.competition?.slug, visible_players: seen.size, real_portraits: withPic, fallbacks: seen.size - withPic });
}
// database truth for every silhouette
const slugs = [...players.keys()];
const rows = await selectIn('soccer_players', 'slug', slugs, { columns: ['id', 'slug', 'display_name', 'birth_date'] });
const idOf = new Map(rows.map(r => [r.slug, r.id]));
const media = await selectIn('soccer_entity_media', 'entity_id', rows.map(r => r.id), { columns: ['entity_id', 'rights_status', 'is_primary', 'cached_url'], eq: { entity_type: 'player', media_type: 'portrait' } });
const ledger = await selectIn('soccer_media_discovery', 'entity_id', rows.map(r => r.id), { columns: ['entity_id', 'outcome', 'method', 'reason'], eq: { entity_type: 'player', media_type: 'portrait' } });
const espn = await selectIn('soccer_player_external_ids', 'player_id', rows.map(r => r.id), { columns: ['player_id', 'external_id'], eq: { provider: 'espn' } });
const out = { NO_APPROVED_PHOTO: [], API_BUG: [], UI_BUG: [], REAL: 0 };
for (const p of players.values()) {
  const pid = idOf.get(p.slug);
  const prim = media.find(m => m.entity_id === pid && m.is_primary && ['approved', 'owner_approved_identification'].includes(m.rights_status) && m.cached_url);
  if (p.api_url) {
    const r = await fetch(SITE + p.api_url); const ok = r.status === 200 && /^image\//.test(r.headers.get('content-type') || '') && (await r.arrayBuffer()).byteLength > 0;
    if (ok) out.REAL++; else out.UI_BUG.push({ slug: p.slug, url: p.api_url, status: r.status });
    continue;
  }
  if (prim) { out.API_BUG.push({ slug: p.slug, name: p.name, db_url: prim.cached_url, surfaces: [...p.surfaces] }); continue; }
  const l = ledger.find(x => x.entity_id === pid);
  out.NO_APPROVED_PHOTO.push({ slug: p.slug, name: p.name, surfaces: [...p.surfaces], espn_id: espn.find(e => e.player_id === pid)?.external_id || null, ledger: l ? `${l.outcome}: ${l.method} / ${l.reason}` : 'never checked' });
}
const reasons = {}; for (const x of out.NO_APPROVED_PHOTO) { const k = x.espn_id ? (x.ledger.split(': ').slice(1).join(': ') || x.ledger) : 'no ESPN athlete id in crosswalk'; reasons[k] = (reasons[k] || 0) + 1; }
const res = { at: new Date().toISOString(), matches: perMatch, distinct_players: players.size, real: out.REAL, silhouettes: out.NO_APPROVED_PHOTO.length + out.API_BUG.length + out.UI_BUG.length, no_approved_photo: out.NO_APPROVED_PHOTO.length, api_bugs: out.API_BUG, ui_bugs: out.UI_BUG, no_photo_reasons: reasons, no_photo: out.NO_APPROVED_PHOTO };
writeFileSync(`docs/evidence/media/pbecast-portraits-${res.at.slice(0, 10)}.json`, JSON.stringify(res, null, 2) + '\n');
for (const m of perMatch) console.log(`${m.match.padEnd(34)} ${m.competition.padEnd(22)} visible ${m.visible_players} real ${m.real_portraits} fallbacks ${m.fallbacks}`);
console.log(JSON.stringify({ distinct_players: res.distinct_players, real: res.real, silhouettes: res.silhouettes, no_approved_photo: res.no_approved_photo, api_bugs: out.API_BUG.length, ui_bugs: out.UI_BUG.length, no_photo_reasons: reasons }, null, 1));
