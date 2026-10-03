/* soccer-video-autopilot — scheduled official-video discovery + article resolution.
 *
 * Discovery is keyless by owner decision (2026-09-29, re-ruled 2026-10-03; data/source-registry/sources.json
 * youtube_rss use_status). Every run records the mechanism it ACTUALLY used, and every cron tick leaves a trace
 * (video:last_tick) and, on failure, video:last_error, so health tells "cron not firing" from "run failing".
 * Mirrors the proven UFC pattern:
 *   no YOUTUBE_API_KEY -> public YouTube Atom channel feed + oEmbed verification
 *   YOUTUBE_API_KEY    -> optional Data API enrichment (duration, region/status)
 *
 * No API key is required for the scheduled baseline. The admin token is also
 * optional and applies only to the manual /admin/run endpoint, never cron.
 */
import { storeFromEnv } from '../../shared/postgrest.js';
import {
  buildAliasIndex, classifyVideo, scoreVideo, articleContext,
  MATCHER_VERSION,
} from '../../shared/video-match.js';

const WORKER = 'soccer-video-autopilot';
const VERSION = 'soccer-video-autopilot/1.2.1';
export const discoveryMechanism = env => (env.YOUTUBE_API_KEY ? 'youtube_data_api_v3' : 'youtube_atom_feed_oembed');
const STALE_MS = 2 * 3600e3;
const PROVIDER = 'youtube';
const DEFAULT_SINCE_DAYS = 14;
const MAX_CHANNELS_PER_RUN = 80;
const VIDEO_COLS = [
  'provider_video_id','channel_id','channel_name','title','description','published_at',
  'duration_sec','thumbnail_url','url','embeddable','region_restriction','video_type',
  'is_short','source_metadata',
];

const json = (body, status = 200) => new Response(JSON.stringify(body, null, 2), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

function authorized(req, env) {
  // Manual trigger only. Cron does not need or read this token.
  const expected = String(env.VIDEO_ADMIN_TOKEN || '');
  if (!expected) return false;
  const got = String(req.headers.get('x-pbe-admin-token') || '');
  if (expected.length !== got.length) return false;
  let d = 0;
  for (let i = 0; i < expected.length; i += 1) d |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  return d === 0;
}

function durationSeconds(value) {
  const m = String(value || '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}

function bestThumb(t = {}) {
  return (t.maxres || t.standard || t.high || t.medium || t.default || {}).url || null;
}


function decodeXml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function tagText(block, name) {
  const m = String(block || '').match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + name + '>', 'i'));
  return m ? decodeXml(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim() : null;
}

function tagAttr(block, name, attr) {
  const m = String(block || '').match(new RegExp('<' + name + '\\b[^>]*\\b' + attr + '\\s*=\\s*"([^"]*)"', 'i'));
  return m ? decodeXml(m[1]) : null;
}

function parseAtomFeed(xml) {
  const text = String(xml || '');
  const head = text.split(/<entry[\s>]/i)[0];
  let channelId = tagText(head, 'yt:channelId');
  if (channelId && !/^UC/.test(channelId) && channelId.length === 22) channelId = 'UC' + channelId;
  const entries = [];
  for (const block of text.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || []) {
    const videoId = tagText(block, 'yt:videoId');
    if (!videoId) continue;
    const link = tagAttr(block, 'link', 'href');
    entries.push({
      video_id: videoId,
      channel_id: tagText(block, 'yt:channelId') || channelId,
      title: tagText(block, 'title') || tagText(block, 'media:title') || '',
      description: tagText(block, 'media:description') || '',
      published: tagText(block, 'published'),
      thumbnail_url: tagAttr(block, 'media:thumbnail', 'url'),
      is_short: /\/shorts\//i.test(link || ''),
    });
  }
  return { channel_id: channelId, entries };
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/atom+xml,application/xml,text/xml,*/*' },
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('youtube_feed_' + res.status + ':' + text.slice(0, 120));
  return text;
}

async function checkOEmbed(videoId) {
  const url = 'https://www.youtube.com/oembed?url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + videoId) + '&format=json';
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    const body = res.ok ? await res.json().catch(() => ({})) : {};
    return { embeddable: res.ok, status: res.status, author_name: body.author_name || null };
  } catch (e) {
    return { embeddable: null, status: null, error: String(e.message || e).slice(0, 160) };
  }
}

async function discoverChannelKeyless(channel, { sinceDays = DEFAULT_SINCE_DAYS } = {}) {
  const cutoff = Date.now() - sinceDays * 86400e3;
  const xml = await fetchText('https://www.youtube.com/feeds/videos.xml?channel_id=' + encodeURIComponent(channel.channel_id));
  const feed = parseAtomFeed(xml);
  if (feed.channel_id && feed.channel_id !== channel.channel_id) {
    throw new Error('youtube_feed_channel_mismatch:' + feed.channel_id);
  }
  const rows = [];
  for (const e of feed.entries) {
    if (e.published && Date.parse(e.published) < cutoff) continue;
    const embed = await checkOEmbed(e.video_id);
    rows.push({
      provider_video_id: e.video_id,
      provider: PROVIDER,
      channel_id: e.channel_id || channel.channel_id,
      channel_name: embed.author_name || channel.channel_name,
      title: String(e.title || '').slice(0, 500),
      description: String(e.description || '').slice(0, 4000),
      published_at: e.published,
      duration_sec: null,
      // the public feed serves thumbnails on i1-i4.ytimg.com; store the canonical host the table accepts (same image)
      thumbnail_url: 'https://i.ytimg.com/vi/' + e.video_id + '/hqdefault.jpg',
      url: 'https://www.youtube.com/watch?v=' + e.video_id,
      embeddable: embed.embeddable,
      region_restriction: null,
      language: null,
      video_type: classifyVideo(e.title),
      is_short: e.is_short,
      source_metadata: {
        discovery: 'youtube_atom_feed_oembed',
        oembed_status: embed.status,
        region_check: { method: 'unverified' },
        scope_competition_ids: channel.scope_competition_ids || [],
        retrieved_at: new Date().toISOString(),
      },
      retrieved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }
  return rows;
}

async function yt(env, resource, params) {
  const key = String(env.YOUTUBE_API_KEY || '');
  if (!key) throw new Error('youtube_data_api_key_missing');
  const q = new URLSearchParams({ ...params, key });
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${resource}?${q}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`youtube_data_api_${res.status}:${String(body?.error?.message || 'request failed').slice(0, 180)}`);
  return body;
}

async function enabledChannels(store) {
  const cols = ['channel_id','channel_name','publisher_type','competition_id','scope_competition_ids','team_id','enabled','verified'];
  return store.select('soccer_video_channels', { columns: cols, eq: { enabled: true, verified: true }, order: 'channel_id.asc' });
}

async function discoverChannel(env, channel, { sinceDays = DEFAULT_SINCE_DAYS } = {}) {
  if (!env.YOUTUBE_API_KEY) return discoverChannelKeyless(channel, { sinceDays });
  const cutoff = Date.now() - sinceDays * 86400e3;
  const uploads = `UU${String(channel.channel_id).slice(2)}`;
  const list = await yt(env, 'playlistItems', {
    part: 'snippet,contentDetails',
    playlistId: uploads,
    maxResults: '50',
  });
  const ids = (list.items || [])
    .filter(x => Date.parse(x?.snippet?.publishedAt || '') >= cutoff)
    .map(x => x?.contentDetails?.videoId)
    .filter(Boolean);
  if (!ids.length) return [];

  const rows = [];
  for (let i = 0; i < ids.length; i += 50) {
    const data = await yt(env, 'videos', {
      part: 'snippet,contentDetails,status,liveStreamingDetails',
      id: ids.slice(i, i + 50).join(','),
      maxResults: '50',
    });
    for (const v of data.items || []) {
      const sn = v.snippet || {};
      const cd = v.contentDetails || {};
      const st = v.status || {};
      const sec = durationSeconds(cd.duration);
      const restriction = cd.regionRestriction || null;
      const blocked = Array.isArray(restriction?.blocked) ? restriction.blocked : [];
      const allowed = Array.isArray(restriction?.allowed) ? restriction.allowed : null;
      const usBlocked = blocked.includes('US') || (allowed && !allowed.includes('US'));
      rows.push({
        provider_video_id: v.id,
        provider: PROVIDER,
        channel_id: sn.channelId || channel.channel_id,
        channel_name: sn.channelTitle || channel.channel_name,
        title: String(sn.title || '').slice(0, 500),
        description: String(sn.description || '').slice(0, 4000),
        published_at: sn.publishedAt,
        duration_sec: sec,
        thumbnail_url: bestThumb(sn.thumbnails) || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
        url: `https://www.youtube.com/watch?v=${v.id}`,
        embeddable: st.embeddable === true && st.privacyStatus === 'public',
        region_restriction: restriction ? { ...restriction, blocked_us: usBlocked, source: 'youtube_data_api_v3' } : null,
        language: sn.defaultAudioLanguage || sn.defaultLanguage || null,
        video_type: classifyVideo(sn.title),
        is_short: sec !== null && sec <= 60,
        source_metadata: {
          discovery: 'youtube_data_api_v3',
          privacy_status: st.privacyStatus || null,
          live_broadcast_content: sn.liveBroadcastContent || null,
          actual_start_time: v.liveStreamingDetails?.actualStartTime || null,
          actual_end_time: v.liveStreamingDetails?.actualEndTime || null,
          region_check: { method: 'youtube_data_api_v3', us_blocked: usBlocked },
          scope_competition_ids: channel.scope_competition_ids || [],
          retrieved_at: new Date().toISOString(),
        },
        retrieved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }
  }
  return rows;
}

async function selectIn(store, table, column, values, opts = {}) {
  const uniq = [...new Set(values.filter(Boolean))];
  const out = [];
  for (let i = 0; i < uniq.length; i += 100) {
    out.push(...await store.select(table, { ...opts, in: { ...(opts.in || {}), [column]: uniq.slice(i, i + 100) } }));
  }
  return out;
}

async function relink(store, { now = Date.now() } = {}) {
  const channels = await enabledChannels(store);
  const byChannel = new Map(channels.map(c => [c.channel_id, c]));
  const teams = await store.select('soccer_teams', { columns: ['id','name','short_name','gender'], order: 'id.asc' });
  const aliases = buildAliasIndex(teams);
  const videos = await store.select('soccer_videos', {
    columns: VIDEO_COLS,
    gte: { published_at: new Date(now - 45 * 86400e3).toISOString() },
    order: 'published_at.desc',
    limit: 800,
  });
  const articles = await store.select('soccer_articles', {
    columns: ['id','slug','story_class','packet_hash','status','published_at'],
    eq: { status: 'published' },
    gte: { published_at: new Date(now - 120 * 86400e3).toISOString() },
    order: 'published_at.desc',
    limit: 500,
  });
  if (!articles.length || !videos.length) return { articles: articles.length, videos: videos.length, linked: 0, rejected: 0 };

  const evidence = await selectIn(store, 'soccer_article_evidence', 'packet_hash', articles.map(a => a.packet_hash), {
    columns: ['packet_hash','packet'],
  });
  const packets = new Map(evidence.map(e => [e.packet_hash, e.packet]));
  const links = [];

  for (const a of articles) {
    const p = packets.get(a.packet_hash);
    if (!p) continue;
    const ctx = articleContext(a, p);
    const scored = videos
      .filter(v => !v.is_short)
      .map(v => ({ v, r: scoreVideo({ ...v, video_type: classifyVideo(v.title) }, byChannel.get(v.channel_id) || {}, ctx, aliases) }))
      .sort((x, y) => y.r.score - x.r.score);
    const linked = scored.filter(x => x.r.status === 'linked');
    const keep = [...linked, ...scored.filter(x => x.r.status !== 'linked' && x.r.score >= 30).slice(0, 3)];
    for (const x of keep) {
      links.push({
        provider_video_id: x.v.provider_video_id,
        article_id: a.id,
        match_id: ctx.match?.id || null,
        team_ids: ctx.match ? [ctx.match.home_id, ctx.match.away_id].filter(Boolean) : [],
        player_ids: ctx.player?.id ? [ctx.player.id] : [],
        competition_id: ctx.competition_id || null,
        score: x.r.score,
        reasons: x.r.reasons,
        status: x.r.status,
        matcher_version: MATCHER_VERSION,
        updated_at: new Date().toISOString(),
      });
    }
  }

  for (let i = 0; i < articles.length; i += 100) {
    await store.delete('soccer_video_links', { in: { article_id: articles.slice(i, i + 100).map(a => a.id) } });
  }
  if (links.length) await store.insert('soccer_video_links', links, { chunk: 300 });
  return {
    articles: articles.length,
    videos: videos.length,
    linked: links.filter(x => x.status === 'linked').length,
    rejected: links.filter(x => x.status === 'rejected').length,
  };
}

// Row checks mirroring soccer_videos' own constraints (migration 20260929000900): one invalid row is recorded and
// skipped, never allowed to abort the batch for every other video.
const VIDEO_TYPES = new Set(['highlights', 'match_recap', 'goals', 'interview', 'press_conference', 'preview', 'analysis', 'other']);
export function rowProblem(v) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(v.provider_video_id || '')) return 'provider_video_id';
  if (!v.channel_id || !v.channel_name || !v.title) return 'missing_required';
  if (v.duration_sec !== null && v.duration_sec !== undefined && !(v.duration_sec > 0)) return 'duration_sec';
  if (v.thumbnail_url && !/^https:\/\/i\.ytimg\.com\//.test(v.thumbnail_url)) return 'thumbnail_url';
  if (!/^https:\/\/www\.youtube\.com\/watch\?v=/.test(v.url || '')) return 'url';
  if (!VIDEO_TYPES.has(v.video_type)) return 'video_type';
  return null;
}

export async function run(env, { dry = false, sinceDays = DEFAULT_SINCE_DAYS, onlyChannel = null, invoked = 'manual' } = {}) {
  const store = storeFromEnv(env);
  if (!store) throw new Error('store_not_configured');
  const started = Date.now();
  const channels = (await enabledChannels(store))
    .filter(c => !onlyChannel || c.channel_id === onlyChannel)
    .slice(0, MAX_CHANNELS_PER_RUN);

  const discovered = [];
  const failures = [];
  for (const c of channels) {
    try {
      discovered.push(...await discoverChannel(env, c, { sinceDays }));
    } catch (e) {
      failures.push({ channel_id: c.channel_id, channel_name: c.channel_name, error: String(e.message || e).slice(0, 220) });
    }
  }

  const unique = [...new Map(discovered.map(v => [v.provider_video_id, v])).values()];
  const dedup = unique.filter(v => { const why = rowProblem(v); if (why) failures.push({ channel_id: v.channel_id, video_id: v.provider_video_id, error: `row_rejected:${why}` }); return !why; });
  if (!dry && dedup.length) await store.upsert('soccer_videos', dedup, ['provider_video_id'], { chunk: 200 });
  const links = dry ? null : await relink(store);
  const newest = dedup.map(v => v.published_at).filter(Boolean).sort().at(-1) || null;
  const out = {
    ok: failures.length === 0,
    status: failures.length ? 'partial' : 'ran',
    discovery: discoveryMechanism(env),
    channels: channels.length,
    discovered: dedup.length,
    newest_video_at: newest,
    failures,
    relink: links,
    invoked,
    dry,
    elapsed_ms: Date.now() - started,
  };
  if (env.SOCCER_STATE && !dry) await env.SOCCER_STATE.put('video:last_run', JSON.stringify({ ...out, at: new Date().toISOString() }));
  return out;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      const kv = env.SOCCER_STATE;
      const [last, tick, lastError] = kv ? await Promise.all(['video:last_run', 'video:last_tick', 'video:last_error'].map(k => kv.get(k, 'json'))) : [null, null, null];
      const age = at => (at ? Date.now() - Date.parse(at) : null);
      const runFresh = last && age(last.at) <= STALE_MS; const tickFresh = tick && age(tick.at) <= STALE_MS;
      const failingSinceRun = lastError && (!last || Date.parse(lastError.at) > Date.parse(last.at));
      return json({
        ok: Boolean(runFresh) && !failingSinceRun,
        state: !tickFresh ? 'cron_not_firing' : failingSinceRun ? 'run_failing' : runFresh ? 'healthy' : 'run_stale',
        last_tick: tick, last_error: lastError,
        service: WORKER,
        version: VERSION,
        discovery: discoveryMechanism(env),
        discovery_policy: 'keyless by owner decision 2026-09-29 (re-ruled 2026-10-03); Data API used only if a key is ever configured',
        manual_admin_trigger_configured: Boolean(env.VIDEO_ADMIN_TOKEN),
        cron: '13,43 * * * *',
        last_run: last,
      }, 200);
    }
    if (url.pathname === '/admin/run' && req.method === 'POST') {
      if (!authorized(req, env)) return json({ error: 'not_found' }, 404);
      const days = Math.min(30, Math.max(1, Number(url.searchParams.get('days')) || DEFAULT_SINCE_DAYS));
      const dry = url.searchParams.get('dry') === '1';
      const channel = url.searchParams.get('channel') || null;
      try { return json(await run(env, { dry, sinceDays: days, onlyChannel: channel, invoked: 'admin' })); }
      catch (e) { return json({ error: String(e.message || e).slice(0, 300) }, 500); }
    }
    return json({ error: 'not_found' }, 404);
  },
  async scheduled(event, env, ctx) {
    const at = new Date(event.scheduledTime || Date.now()).toISOString();
    const kv = env.SOCCER_STATE;
    ctx.waitUntil((async () => {
      if (kv) await kv.put('video:last_tick', JSON.stringify({ at, cron: event.cron, discovery: discoveryMechanism(env) }));
      try { await run(env, { sinceDays: DEFAULT_SINCE_DAYS, invoked: `cron:${event.cron}` }); }
      catch (e) {
        const error = String(e?.message || e).slice(0, 400);
        console.error(WORKER, error);
        if (kv) await kv.put('video:last_error', JSON.stringify({ at: new Date().toISOString(), tick_at: at, error, discovery: discoveryMechanism(env) })).catch(() => {});
      }
    })());
  },
};
