// Soccer official-video helpers (keyless). Ported from the UFC video layer (LHBUSA/UFC
// scripts/videos/lib.mjs, docs/videos.md): public playlist page + continuation, public watch page,
// oEmbed. Nothing is downloaded or rehosted; only ids and metadata are stored.
export const USER_AGENT = 'Mozilla/5.0 (compatible; PropBetEdgeSoccer/1.0; +https://soccer.propbetedge.ai/sources)';
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const watchUrl = id => `https://www.youtube.com/watch?v=${id}`;
export const uploadsPlaylist = channelId => `UU${channelId.slice(2)}`;

export async function fetchPublic(url, { method = 'GET', body = null, timeoutMs = 25000, attempts = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const headers = { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' };
      if (body) headers['Content-Type'] = 'application/json';
      const res = await fetch(url, { method, headers, body, redirect: 'follow', signal: ctl.signal });
      const text = await res.text();
      if (res.status >= 500 || res.status === 429) { lastErr = new Error(`http ${res.status}`); await sleep(1500 * (i + 1)); continue; }
      return { ok: res.ok, status: res.status, body: text };
    } catch (e) { lastErr = e; await sleep(800 * (i + 1)); } finally { clearTimeout(t); }
  }
  throw lastErr;
}

// String-aware brace matching (titles contain "};").
export function extractPageJson(html, name) {
  const text = String(html || ''); const marker = text.indexOf(`var ${name} = {`);
  if (marker < 0) return null;
  const start = text.indexOf('{', marker); let depth = 0; let inStr = false; let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}
function collect(node, pick, out = []) {
  if (!node || typeof node !== 'object') return out;
  const hit = pick(node); if (hit) { out.push(hit); return out; }
  for (const k of Object.keys(node)) collect(node[k], pick, out);
  return out;
}
function playlistItem(node) {
  const l = node.lockupViewModel;
  if (l && l.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' && l.contentId) {
    const meta = l.metadata?.lockupMetadataViewModel || {};
    return { video_id: l.contentId, title: meta.title?.content || '' };
  }
  const p = node.playlistVideoRenderer;
  if (p && p.videoId) return { video_id: p.videoId, title: p.title?.runs?.map(r => r.text).join('') || p.title?.simpleText || '' };
  return null;
}
const continuationToken = node => collect(node, n => (n.continuationItemRenderer ? (collect(n.continuationItemRenderer, m => m.continuationCommand?.token || null)[0] || null) : null))[0] || null;

export function parsePlaylistPage(html) {
  const data = extractPageJson(html, 'ytInitialData'); if (!data) return null;
  const list = data.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
  const cfg = String(html || '');
  return { items: collect(list, playlistItem), continuation: continuationToken(list),
    innertube: { key: (cfg.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1] || null, client_version: (cfg.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1] || null } };
}
export function parsePlaylistContinuation(json) {
  const actions = [...(json?.onResponseReceivedActions || []), ...(json?.onResponseReceivedEndpoints || [])];
  const batch = actions.flatMap(a => a.appendContinuationItemsAction?.continuationItems || []);
  return { items: collect(batch, playlistItem), continuation: continuationToken(batch) };
}
// The newest items of a public playlist (listing only; no watch pages): up to maxPages x ~100.
export async function listPlaylist(playlistId, { maxPages = 1, delayMs = 1000 } = {}) {
  const base = 'https://www.youtube.com';
  const r = await fetchPublic(`${base}/playlist?list=${encodeURIComponent(playlistId)}&hl=en&gl=US`);
  const page = r.ok ? parsePlaylistPage(r.body) : null;
  if (!page) throw new Error(`playlist page http ${r.status}`);
  const items = [...page.items]; let token = page.continuation; let pages = 1;
  while (token && pages < maxPages && page.innertube.key && page.innertube.client_version) {
    await sleep(delayMs);
    const c = await fetchPublic(`${base}/youtubei/v1/browse?key=${encodeURIComponent(page.innertube.key)}&prettyPrint=false`, { method: 'POST', body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: page.innertube.client_version, hl: 'en', gl: 'US' } }, continuation: token }) });
    if (!c.ok) break;
    let next; try { next = parsePlaylistContinuation(JSON.parse(c.body)); } catch { break; }
    items.push(...next.items); token = next.continuation; pages += 1;
  }
  const seen = new Set();
  return items.filter(it => (seen.has(it.video_id) ? false : seen.add(it.video_id)));
}

// A public watch page -> exact publish time, channel, duration, description, embed + US availability.
export function parseWatchPage(html) {
  const p = extractPageJson(html, 'ytInitialPlayerResponse'); const vd = p?.videoDetails;
  if (!vd?.videoId) return null;
  const mf = p.microformat?.playerMicroformatRenderer || {};
  const thumbs = vd.thumbnail?.thumbnails || [];
  const countries = Array.isArray(mf.availableCountries) ? mf.availableCountries : null;
  return {
    video_id: vd.videoId, channel_id: vd.channelId || mf.externalChannelId || null, channel_title: vd.author || mf.ownerChannelName || null,
    title: vd.title || mf.title?.simpleText || '', description: vd.shortDescription || '', published: mf.publishDate || mf.uploadDate || null,
    duration_sec: Number(vd.lengthSeconds) > 0 ? Number(vd.lengthSeconds) : null,
    thumbnail_url: thumbs.length ? thumbs[thumbs.length - 1].url.split('?')[0] : null,
    is_live: !!vd.isLiveContent, privacy_status: vd.isPrivate ? 'private' : mf.isUnlisted ? 'unlisted' : 'public',
    playability_status: p.playabilityStatus?.status || null,
    playable_in_embed: typeof p.playabilityStatus?.playableInEmbed === 'boolean' ? p.playabilityStatus.playableInEmbed : null,
    available_in_us: countries && countries.length ? countries.includes('US') : null,
    is_short: vd.lengthSeconds && Number(vd.lengthSeconds) <= 60 ? true : null,
  };
}
export async function readWatch(id) {
  const r = await fetchPublic(`https://www.youtube.com/watch?v=${encodeURIComponent(id)}&hl=en&gl=US`);
  const w = r.ok ? parseWatchPage(r.body) : null;
  return w && w.video_id === id ? w : null;
}
// oEmbed 200 proves the embed page exists (not region playability).
export async function checkEmbeddable(id) {
  try {
    const r = await fetchPublic(`https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl(id))}&format=json`, { timeoutMs: 15000, attempts: 2 });
    return { embeddable: r.ok, status: r.status };
  } catch (e) { return { embeddable: null, error: String(e.message) }; }
}
// Channel page: canonical id + title (identity is proven elsewhere: Wikidata P2397).
const decode = s => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
export async function channelPage(channelId) {
  const r = await fetchPublic(`https://www.youtube.com/channel/${channelId}?hl=en&gl=US`);
  const t = r.body || '';
  return { status: r.status, canonical_id: (t.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/) || [])[1] || null,
    title: decode((t.match(/<meta property="og:title" content="([^"]*)"/) || [])[1] || '') || null,
    handle: (t.match(/"canonicalBaseUrl":"\/(@[^"]+)"/) || [])[1] || null };
}
