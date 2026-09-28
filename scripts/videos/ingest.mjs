#!/usr/bin/env node
// Official soccer video ingest + article linking (keyless; docs/VIDEO.md).
//   1. enabled + verified channels (soccer_video_channels; scripts/videos/channels.mjs)
//   2. each channel's public uploads listing (newest first); candidate = a title naming our clubs
//   3. public watch page for candidates (exact publish time, channel, duration, embed + US availability),
//      oEmbed embed check; rows whose watch-page channel differs from the listing channel are dropped
//   4. soccer_videos upsert (ids + metadata only; nothing downloaded)
//   5. every published article is scored against the stored videos (workers/shared/video-match.js);
//      'linked' when the score reaches the threshold, otherwise the best candidates are kept as 'rejected'
//   node scripts/videos/ingest.mjs [--dry] [--days 21] [--league-pages 3] [--club-pages 1] [--link-only]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { chunkArr } from '../../workers/soccer-ingest/src/store.js';
import { listPlaylist, readWatch, checkEmbeddable, uploadsPlaylist, watchUrl, sleep } from './lib.mjs';
import { buildAliasIndex, teamsInTitle, classifyVideo, scoreVideo, articleContext, MATCHER_VERSION, THRESHOLD } from '../../workers/shared/video-match.js';

const argv = process.argv.slice(2); const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const DRY = argv.includes('--dry'); const LINK_ONLY = argv.includes('--link-only');
const DAYS = Number(arg('--days', '21')); const LEAGUE_PAGES = Number(arg('--league-pages', '3')); const CLUB_PAGES = Number(arg('--club-pages', '1'));
const envText = readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8');
const store = storeFromEnv(Object.fromEntries(envText.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])));
async function selectIn(table, col, vals, opts) { const out = []; for (const p of chunkArr([...new Set(vals)], 150)) out.push(...await store.select(table, { ...opts, in: { ...(opts.in || {}), [col]: p } })); return out; }
const t0 = Date.now(); const log = (...a) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s]`, ...a);
const now = Date.now(); const since = now - DAYS * 86400e3;
const report = { at: new Date().toISOString(), matcher: MATCHER_VERSION, threshold: THRESHOLD, dry: DRY, channels: {}, videos: { stored: 0, candidates: 0 }, links: { linked: 0, rejected: 0, articles_with_video: 0, articles: 0 }, per_article: [] };

const channels = await store.select('soccer_video_channels', { columns: ['channel_id', 'channel_name', 'publisher_type', 'competition_id', 'team_id', 'enabled', 'verified'], eq: { enabled: true, verified: true } });
const byChannel = new Map(channels.map(c => [c.channel_id, c]));
const allTeams = await store.select('soccer_teams', { columns: ['id', 'name', 'short_name'] });
// active teams only (the four competitions' latest seasons) keep the alias index precise
const comps = await store.select('soccer_competitions', { columns: ['id', 'slug'] });
const active = new Set();
for (const c of comps) {
  const s = (await store.select('soccer_seasons', { columns: ['id', 'label'], eq: { competition_id: c.id } })).sort((a, b) => (a.label < b.label ? 1 : -1))[0];
  if (!s) continue;
  for (const m of await store.select('soccer_matches', { columns: ['home_team_id', 'away_team_id'], eq: { season_id: s.id } })) { active.add(m.home_team_id); active.add(m.away_team_id); }
}
const index = buildAliasIndex(allTeams.filter(t => active.has(t.id)));

// ---------------- 1-4 ingest
if (!LINK_ONLY) {
  const known = new Set((await store.select('soccer_videos', { columns: ['provider_video_id'] })).map(v => v.provider_video_id));
  const rows = [];
  for (const ch of channels) {
    const stat = report.channels[ch.channel_name] = { listed: 0, candidates: 0, read: 0, stored: 0, skipped_old: 0, wrong_channel: 0 };
    let listed = [];
    try { listed = await listPlaylist(uploadsPlaylist(ch.channel_id), { maxPages: ch.publisher_type === 'club' ? CLUB_PAGES : LEAGUE_PAGES }); } catch (e) { stat.error = String(e.message); log('listing failed', ch.channel_name, stat.error); continue; }
    stat.listed = listed.length;
    // league channels: any title naming one of our clubs; club channels: two clubs or a highlights/goals title
    const cands = listed.filter(it => !known.has(it.video_id)).filter(it => { const n = teamsInTitle(it.title, index).length; const ty = classifyVideo(it.title); return ch.publisher_type === 'club' ? n >= 2 || ((ty === 'highlights' || ty === 'goals') && n >= 1) : n >= 1; });
    stat.candidates = cands.length; let olderRun = 0;
    for (const it of cands) {
      await sleep(900);
      let w = null; try { w = await readWatch(it.video_id); } catch { w = null; }
      if (!w) continue; stat.read += 1;
      if (w.channel_id !== ch.channel_id) { stat.wrong_channel += 1; continue; }
      const pub = Date.parse(w.published || '');
      if (!Number.isFinite(pub) || pub < since) { stat.skipped_old += 1; olderRun += 1; if (olderRun >= 5) break; continue; }
      olderRun = 0;
      const emb = await checkEmbeddable(it.video_id);
      rows.push({
        provider_video_id: w.video_id, provider: 'youtube', channel_id: ch.channel_id, channel_name: ch.channel_name, title: w.title, description: (w.description || '').slice(0, 2000),
        published_at: new Date(pub).toISOString(), duration_sec: w.duration_sec, thumbnail_url: w.thumbnail_url && /^https:\/\/i\.ytimg\.com\//.test(w.thumbnail_url) ? w.thumbnail_url : `https://i.ytimg.com/vi/${w.video_id}/hqdefault.jpg`,
        url: watchUrl(w.video_id), embeddable: emb.embeddable === false || w.playable_in_embed === false ? false : emb.embeddable === true ? true : null,
        region_restriction: w.available_in_us === false ? { blocked: ['US'], source: 'watch_page_available_countries' } : null, language: null, video_type: classifyVideo(w.title), is_short: w.is_short,
        source_metadata: { discovery: 'public_uploads_listing+watch_page', oembed_status: emb.status ?? null, playable_in_embed: w.playable_in_embed, available_in_us: w.available_in_us, privacy_status: w.privacy_status, playability_status: w.playability_status, is_live: w.is_live },
        retrieved_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      stat.stored += 1;
    }
    log(ch.channel_name, JSON.stringify(stat));
  }
  report.videos.candidates = rows.length;
  if (!DRY) for (const part of chunkArr(rows, 200)) await store.upsert('soccer_videos', part, ['provider_video_id']);
}

// ---------------- 5 link articles
const videos = await store.select('soccer_videos', { columns: ['provider_video_id', 'channel_id', 'title', 'published_at', 'video_type', 'embeddable', 'region_restriction', 'is_short'], gte: { published_at: new Date(now - 45 * 86400e3).toISOString() } });
report.videos.stored = videos.length;
const articles = await store.select('soccer_articles', { columns: ['id', 'slug', 'story_class', 'packet_hash', 'status'], eq: { status: 'published' } });
const packets = new Map((await selectIn('soccer_article_evidence', 'packet_hash', articles.map(a => a.packet_hash), { columns: ['packet_hash', 'packet'] })).map(e => [e.packet_hash, e.packet]));
const links = [];
for (const a of articles) {
  const p = packets.get(a.packet_hash); if (!p) continue;
  const ctx = articleContext(a, p);
  if (ctx.match?.id) { const [m] = await store.select('soccer_matches', { columns: ['kickoff_at'], eq: { id: ctx.match.id }, limit: 1 }); if (m) ctx.match.kickoff = new Date(m.kickoff_at).toISOString(); }
  report.links.articles += 1;
  const scored = videos.filter(v => !v.is_short).map(v => ({ v, r: scoreVideo(v, byChannel.get(v.channel_id) || {}, ctx, index) })).sort((x, y) => y.r.score - x.r.score);
  const linked = scored.filter(s => s.r.status === 'linked');
  const keep = [...linked, ...scored.filter(s => s.r.status !== 'linked' && s.r.score >= 30).slice(0, 3)];
  for (const s of keep) links.push({ provider_video_id: s.v.provider_video_id, article_id: a.id, match_id: ctx.match?.id || null, team_ids: ctx.match ? [ctx.match.home_id, ctx.match.away_id].filter(Boolean) : [], player_ids: ctx.player?.id ? [ctx.player.id] : [], competition_id: ctx.competition_id || null, score: s.r.score, reasons: s.r.reasons, status: s.r.status, matcher_version: MATCHER_VERSION, updated_at: new Date().toISOString() });
  if (linked.length) report.links.articles_with_video += 1;
  report.per_article.push({ slug: a.slug, story_class: a.story_class, linked: linked.slice(0, 3).map(s => ({ id: s.v.provider_video_id, title: s.v.title, score: s.r.score })), best_rejected: scored.find(s => s.r.status !== 'linked') ? { title: scored.find(s => s.r.status !== 'linked').v.title, score: scored.find(s => s.r.status !== 'linked').r.score } : null });
}
report.links.linked = links.filter(l => l.status === 'linked').length; report.links.rejected = links.filter(l => l.status === 'rejected').length;
if (!DRY) {
  // replace this matcher version's links for the scored articles (links are derived data, recomputed each run)
  for (const part of chunkArr(articles.map(a => a.id), 100)) await store.delete('soccer_video_links', { in: { article_id: part } });
  for (const part of chunkArr(links, 300)) await store.insert('soccer_video_links', part);
}
mkdirSync('docs/evidence/video', { recursive: true });
writeFileSync(`docs/evidence/video/ingest-${report.at.slice(0, 10)}${DRY ? '-dry' : ''}.json`, JSON.stringify(report, null, 2) + '\n');
log('videos stored (45 d)', report.videos.stored, 'links', JSON.stringify(report.links));
