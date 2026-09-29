// Official video (read-only API side; docs/VIDEO.md). Only videos from enabled + verified channels,
// never one known to be unembeddable, and article videos only through a 'linked' matcher row.
// The embed URL is the privacy-enhanced youtube-nocookie player, built here, loaded by the page only
// after the reader clicks play. Nothing is hosted by PropBetEdge.
import { chunkArr } from '../../soccer-ingest/src/store.js';

export const VIDEO_ATTRIBUTION = 'Official video · embedded from YouTube · not hosted by PropBetEdge';
const DESK_COMP = { mls: 'mls', 'premier-league': 'premier-league', 'champions-league': 'uefa-champions-league', bundesliga: 'bundesliga', international: 'uefa-nations-league' };
const V_COLS = ['provider_video_id', 'channel_id', 'channel_name', 'title', 'description', 'published_at', 'duration_sec', 'thumbnail_url', 'url', 'embeddable', 'region_restriction', 'video_type', 'is_short', 'source_metadata'];

export function availability(v) {
  if (v.embeddable === false) return 'unembeddable';
  if (v.region_restriction?.blocked?.includes('US')) return 'blocked_us';
  return v.embeddable === true ? 'embeddable' : 'unverified';
}
// The publisher's first description line, unless it is a promo / link line (then the title stands alone).
const cleanLine = d => { const l = String(d || '').split('\n').map(x => x.trim()).find(Boolean) || ''; return !l || /https?:\/\/|www\./i.test(l) ? null : l.slice(0, 280); };
export function shapeVideo(v, extra = {}) {
  return {
    provider: 'youtube', provider_video_id: v.provider_video_id, title: v.title, channel_id: v.channel_id, channel_name: v.channel_name,
    url: `https://www.youtube.com/watch?v=${v.provider_video_id}`, embed_url: `https://www.youtube-nocookie.com/embed/${v.provider_video_id}`,
    thumbnail_url: v.thumbnail_url || `https://i.ytimg.com/vi/${v.provider_video_id}/hqdefault.jpg`, published_at: v.published_at, duration_sec: v.duration_sec || null,
    video_type: v.video_type, description: cleanLine(v.description), availability: availability(v), attribution: VIDEO_ATTRIBUTION, ...extra,
  };
}
async function enabledChannels(store) {
  return new Map((await store.select('soccer_video_channels', { columns: ['channel_id', 'channel_name', 'publisher_type', 'competition_id', 'team_id'], eq: { enabled: true, verified: true } })).map(c => [c.channel_id, c]));
}

// The article's linked videos (strongest first). `validated` marks a matcher-linked record (VideoObject-eligible).
export async function articleVideos(store, articleId, { limit = 2 } = {}) {
  const links = await store.select('soccer_video_links', { columns: ['provider_video_id', 'score', 'reasons', 'matcher_version', 'match_id'], eq: { article_id: articleId, status: 'linked' }, order: 'score.desc', limit: 10 });
  if (!links.length) return [];
  const ch = await enabledChannels(store);
  const vids = new Map((await store.select('soccer_videos', { columns: V_COLS, in: { provider_video_id: links.map(l => l.provider_video_id) } })).map(v => [v.provider_video_id, v]));
  // strongest link first; on a tie: highlights over other types, a full cut (>= 2 min) over a clip, then the
  // shorter of those; never a live-show recording
  const full = v => (v.duration_sec && v.duration_sec >= 120 ? 0 : 1);
  const typeRank = t => (t === 'highlights' ? 0 : t === 'goals' ? 1 : t === 'match_recap' ? 2 : 3);
  return links.map(l => ({ l, v: vids.get(l.provider_video_id) })).filter(x => x.v && ch.has(x.v.channel_id) && x.v.embeddable !== false && !x.v.is_short && !x.v.source_metadata?.is_live)
    .sort((a, b) => b.l.score - a.l.score || typeRank(a.v.video_type) - typeRank(b.v.video_type) || full(a.v) - full(b.v) || (a.v.duration_sec || 1e9) - (b.v.duration_sec || 1e9))
    .slice(0, limit).map(({ l, v }) => shapeVideo(v, { validated: true, link: { score: l.score, matcher_version: l.matcher_version, reasons: (l.reasons || []).map(r => r.why) } }));
}

// Newsroom WATCH module: recent official highlights for a desk (or all desks), linked ones first.
export async function videosFeed(store, { desk = null, limit = 4 } = {}) {
  const ch = await enabledChannels(store);
  const since = new Date(Date.now() - 12 * 86400e3).toISOString();
  const recent = (await store.select('soccer_videos', { columns: V_COLS, gte: { published_at: since }, order: 'published_at.desc', limit: 400 }))
    .filter(v => ch.has(v.channel_id) && v.embeddable !== false && !v.is_short && !v.source_metadata?.is_live && !v.region_restriction?.blocked?.includes('US') && ['highlights', 'goals', 'match_recap'].includes(v.video_type));
  const linkRows = recent.length ? (await Promise.all(chunkArr(recent.map(v => v.provider_video_id), 100).map(part => store.select('soccer_video_links', { columns: ['provider_video_id', 'article_id', 'competition_id', 'score'], eq: { status: 'linked' }, in: { provider_video_id: part } })))).flat() : [];
  const comps = await store.select('soccer_competitions', { columns: ['id', 'slug'] });
  const compId = desk ? comps.find(c => c.slug === DESK_COMP[desk])?.id : null;
  const arts = linkRows.length ? await store.select('soccer_articles', { columns: ['id', 'slug', 'desk', 'headline'], in: { id: [...new Set(linkRows.map(l => l.article_id))] } }) : [];
  const artById = new Map(arts.map(a => [a.id, a]));
  const linkOf = new Map(); for (const l of linkRows.sort((a, b) => b.score - a.score)) if (!linkOf.has(l.provider_video_id)) linkOf.set(l.provider_video_id, l);
  const inDesk = v => { if (!desk) return true; const c = ch.get(v.channel_id); const l = linkOf.get(v.provider_video_id); return (c.competition_id && c.competition_id === compId) || (l && l.competition_id === compId); };
  const pool = recent.filter(inDesk).sort((a, b) => (linkOf.has(b.provider_video_id) - linkOf.has(a.provider_video_id)) || Date.parse(b.published_at) - Date.parse(a.published_at));
  const out = []; const perChannel = new Map();
  for (const v of pool) {
    if (out.length >= limit) break;
    const n = perChannel.get(v.channel_id) || 0; if (n >= 2) continue;
    perChannel.set(v.channel_id, n + 1);
    const l = linkOf.get(v.provider_video_id); const a = l ? artById.get(l.article_id) : null;
    out.push(shapeVideo(v, a ? { story: { slug: a.slug, desk: a.desk, headline: a.headline } } : {}));
  }
  return out;
}
