#!/usr/bin/env node
// Soccer official-channel allowlist. A channel is verified + enabled only when, LIVE on this run:
//   (1) Wikidata says so by exact id: the competition / governing body / proven club item's P2397
//       (YouTube channel ID) equals the channel id (never a handle guess, never a name search), and
//   (2) the channel page at /channel/<id> is canonical for that id.
// Club QIDs come only from clubs whose Wikidata identity our media pipeline already proved
// (docs/evidence/media/wikimedia-2026-09-28.json proofs). Writes data/video/channels.json and upserts
// soccer_video_channels (a channel that fails is written verified=false, enabled=false; never deleted).
//   node scripts/videos/channels.mjs [--dry]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { channelPage, sleep } from './lib.mjs';

const DRY = process.argv.includes('--dry');
const envText = readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8');
const store = storeFromEnv(Object.fromEntries(envText.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])));
const comps = new Map((await store.select('soccer_competitions', { columns: ['id', 'slug'] })).map(c => [c.slug, c.id]));

const COMPETITIONS = [
  { qid: 'Q18543', label: 'Major League Soccer', publisher_type: 'competition', competition: 'mls' },
  { qid: 'Q9448', label: 'Premier League', publisher_type: 'competition', competition: 'premier-league' },
  { qid: 'Q82595', label: 'Bundesliga', publisher_type: 'competition', competition: 'bundesliga' },
  // A governing body publishes for several competitions: its scope lists them all (the matcher still
  // decides relevance per video and rejects a title naming another competition).
  { qid: 'Q35572', label: 'UEFA', publisher_type: 'governing_body', competition: 'uefa-champions-league', scope: ['uefa-champions-league', 'uefa-nations-league'] },
];
const proofs = JSON.parse(readFileSync('docs/evidence/media/wikimedia-2026-09-28.json', 'utf8')).teams.proofs.filter(p => p.qid && !/several|disagree/.test(p.reason));
const teams = await store.select('soccer_teams', { columns: ['id', 'slug', 'name'], in: { name: proofs.map(p => p.team) } });
const clubs = proofs.map(p => { const t = teams.filter(x => x.name === p.team); return t.length === 1 ? { qid: p.qid, label: p.team, publisher_type: 'club', team: t[0] } : null; }).filter(Boolean);

const all = [...COMPETITIONS, ...clubs];
const q = `SELECT ?i ?yt WHERE { VALUES ?i { ${all.map(x => `wd:${x.qid}`).join(' ')} } ?i wdt:P2397 ?yt }`;
const res = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`, { headers: { 'user-agent': 'PropBetEdgeSoccer/0.1 (+https://soccer.propbetedge.ai/sources)' } });
const byQ = new Map(); for (const b of (await res.json()).results.bindings) { const k = b.i.value.split('/').pop(); byQ.set(k, [...(byQ.get(k) || []), b.yt.value]); }

const out = []; const rejected = [];
for (const c of all) {
  const ids = byQ.get(c.qid) || [];
  if (ids.length !== 1) { rejected.push({ label: c.label, qid: c.qid, reason: ids.length ? 'several_P2397_values' : 'no_P2397_on_wikidata' }); continue; }
  const id = ids[0]; await sleep(1100);
  const page = await channelPage(id);
  const ok = page.status === 200 && page.canonical_id === id;
  const row = {
    channel_id: id, provider: 'youtube', channel_name: page.title || c.label, channel_handle: page.handle || null, publisher_type: c.publisher_type,
    competition_id: c.competition ? comps.get(c.competition) : null, scope_competition_ids: (c.scope || (c.competition ? [c.competition] : [])).map(x => comps.get(x)).filter(Boolean),
    team_id: c.team?.id || null, verified: ok, enabled: ok,
    language: null, region_notes: 'Region availability is per video (watch page availableCountries / player errors 100/101/150).',
    source_url: `https://www.youtube.com/channel/${id}`,
    verification: { method: 'wikidata_P2397_exact + channel_page_canonical', qid: c.qid, label: c.label, team_slug: c.team?.slug || null, competition: c.competition || null, scope: c.scope || null, page_status: page.status, page_canonical: page.canonical_id, page_title: page.title, checked_at: new Date().toISOString() },
    checked_at: new Date().toISOString(),
  };
  out.push(row);
  console.log(`${ok ? 'VERIFIED' : 'FAILED  '} ${c.publisher_type.padEnd(14)} ${id} ${row.channel_name} (${c.label}, ${c.qid})`);
}
mkdirSync('data/video', { recursive: true });
writeFileSync('data/video/channels.json', JSON.stringify({ _policy: 'Exact YouTube channel ids proven by Wikidata P2397 on the competition / governing body / proven club item AND the canonical channel page, re-checked by scripts/videos/channels.mjs. Fan channels, compilations and re-uploads are never added. Broadcaster channels need explicit owner approval.', generated_at: new Date().toISOString(), channels: out.map(({ verification, ...r }) => ({ ...r, verification })), rejected }, null, 2) + '\n');
if (!DRY) await store.upsert('soccer_video_channels', out, ['channel_id']);
console.log(`channels verified ${out.filter(r => r.verified).length}/${out.length}; rejected ${rejected.length}`, JSON.stringify(rejected));
