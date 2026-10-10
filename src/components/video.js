// Official video card: poster-first, privacy-enhanced YouTube embed (port of LHBUSA/UFC
// web/components/OfficialVideo.tsx). No iframe, no YouTube network request before the reader clicks
// play; the frame keeps a fixed 16:9 box so opening the player never shifts layout. If YouTube refuses
// the embed (player errors 100 / 101 / 150: removed, embedding disabled, not in this region) the card
// returns to its poster with a clear message and a Watch on YouTube link: never a dead black box.
// The footage is YouTube-hosted; the card says so and names the publisher.
import { esc, when } from '../lib/html.js';
import { ago } from '../lib/format.js';
import { currentLocale } from '../i18n/current.js';
import { foreignStory, storyLangAttrs, storyLangTag } from '../i18n/news-lang.js';

// The linked story (videos are not localized: its headline is the English original). On a localized page the
// sentence is written in the page language around the English headline, which is marked as English (LHBUSA/soccer#16).
const READ_STORY = { es: 'Leer la noticia', pt: 'Ler a notícia' };
const storyLink = st => (foreignStory(st) && READ_STORY[currentLocale()]
  ? `<span data-i18n-skip>${READ_STORY[currentLocale()]}:</span> <span${storyLangAttrs(st)}>${esc(st.headline)}</span> ${storyLangTag(st)} →`
  : `Read the story: ${esc(st.headline)} →`);

export const BLOCKED_CODES = new Set([100, 101, 150]);
const TYPE_LABEL = { highlights: 'Highlights', match_recap: 'Match recap', goals: 'Goals', interview: 'Interview', press_conference: 'Press conference', preview: 'Preview', analysis: 'Analysis', other: 'Official video' };
export const videoLabel = v => TYPE_LABEL[v?.video_type] || 'Official video';
export function duration(sec) {
  if (!sec) return '';
  const m = Math.floor(sec / 60); const s = sec % 60;
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
const idOk = id => /^[A-Za-z0-9_-]{11}$/.test(String(id || ''));
export const thumbOf = v => (/^https:\/\/i\.ytimg\.com\//.test(v?.thumbnail_url || '') ? v.thumbnail_url : `https://i.ytimg.com/vi/${v.provider_video_id}/hqdefault.jpg`);
// The embed URL the player loads AFTER the click (origin = this page, for the IFrame API error channel).
export const embedSrc = (id, origin) => `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?rel=0&modestbranding=1&autoplay=1&playsinline=1&enablejsapi=1&origin=${encodeURIComponent(origin)}`;

export function officialVideo(v, { feature = false, eager = false } = {}) {
  if (!v || !idOk(v.provider_video_id)) return '';
  const blocked = v.availability === 'blocked_us' || v.availability === 'unembeddable';
  const dur = duration(v.duration_sec);
  const poster = `<img src="${esc(thumbOf(v))}" alt="" width="1280" height="720" loading="${eager ? 'eager' : 'lazy'}" decoding="async"${eager ? ' fetchpriority="high"' : ''} data-ovid-poster>`;
  return `<article class="ovid${feature ? ' feature' : ''}${blocked ? ' failed' : ''}" data-ovid="${esc(v.provider_video_id)}" data-ovid-title="${esc(v.title)}">
    <div class="ovid-frame">
      ${blocked ? fallback(v, poster, 'blocked') : `<button type="button" class="ovid-poster" aria-label="Play ${esc(v.title)} (opens the YouTube player here)">${poster}<span class="ovid-play" aria-hidden="true"><i></i></span><span class="ovid-label">${esc(videoLabel(v))}</span>${dur ? `<span class="ovid-dur">${esc(dur)}</span>` : ''}</button>`}
    </div>
    <div class="ovid-copy">
      <p class="ovid-meta"><b>${esc(videoLabel(v))}</b>${v.published_at ? ` · <time datetime="${esc(v.published_at)}">${esc(ago(v.published_at))}</time>` : ''} · ${esc(v.channel_name)}</p>
      <h3 class="ovid-title">${esc(v.title)}</h3>
      <p class="ovid-src">Official video · embedded from YouTube · not hosted by PropBetEdge · <a href="${esc(v.url)}" target="_blank" rel="noopener">Watch on YouTube ↗</a></p>
      ${when(v.story, () => `<p class="ovid-story"><a href="/news/${esc(v.story.desk)}/${esc(v.story.slug)}" data-link>${storyLink(v.story)}</a></p>`)}
    </div>
  </article>`;
}

function fallback(v, poster, kind) {
  return `<div class="ovid-fallback" role="status">${poster}<div class="ovid-fb-copy"><b>${kind === 'blocked' ? 'Not available for embedded playback in your region.' : 'This video is not available for embedded playback.'}</b><a class="btn gold" href="${esc(v.url)}" target="_blank" rel="noopener">Watch on YouTube ↗</a></div><span class="ovid-label">${esc(videoLabel(v))}</span></div>`;
}

// Click -> iframe in place; IFrame API handshake; 100/101/150 -> poster + message + Watch on YouTube.
export function mountOfficialVideos(root, { origin = (typeof location !== 'undefined' ? location.origin : '') } = {}) {
  const cards = [...root.querySelectorAll('.ovid[data-ovid]')];
  for (const card of cards) {
    const img = card.querySelector('[data-ovid-poster]');
    if (img) { const drop = () => img.remove(); if (img.complete && img.naturalWidth === 0) drop(); else img.addEventListener('error', drop, { once: true }); }
    const btn = card.querySelector('.ovid-poster'); if (!btn) continue;
    btn.addEventListener('click', () => open(card, origin), { once: true });
  }
}

function open(card, origin) {
  const id = card.dataset.ovid; const frame = card.querySelector('.ovid-frame');
  const iframe = document.createElement('iframe');
  iframe.src = embedSrc(id, origin);
  iframe.title = card.dataset.ovidTitle || 'Official video';
  iframe.loading = 'lazy';
  iframe.allow = 'accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; autoplay';
  iframe.allowFullscreen = true;
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  const poster = frame.innerHTML;
  frame.innerHTML = ''; frame.appendChild(iframe); card.classList.add('playing');
  let timer = 0;
  const onMessage = e => {
    if (e.source !== iframe.contentWindow) return;
    let host = ''; try { host = new URL(e.origin).hostname; } catch { return; }
    if (!/(^|\.)youtube(-nocookie)?\.com$/.test(host)) return;
    let data = null; try { data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
    if (!data || typeof data !== 'object') return;
    clearInterval(timer);
    if (data.event !== 'onError') return;
    const code = Number(data.info);
    window.removeEventListener('message', onMessage);
    showFallback(card, frame, poster, BLOCKED_CODES.has(code) ? 'blocked' : 'unavailable');
  };
  window.addEventListener('message', onMessage);
  // handshake until the player answers (a slow player would otherwise never report its error)
  const send = () => iframe.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id, channel: 'widget' }), '*');
  timer = setInterval(send, 400);
  setTimeout(() => clearInterval(timer), 20000);
  card._ovidCleanup = () => { clearInterval(timer); window.removeEventListener('message', onMessage); };
}

function showFallback(card, frame, posterHtml, kind) {
  const url = card.querySelector('.ovid-src a')?.getAttribute('href') || `https://www.youtube.com/watch?v=${card.dataset.ovid}`;
  const tmp = document.createElement('div'); tmp.innerHTML = posterHtml;
  const img = tmp.querySelector('img');
  const label = tmp.querySelector('.ovid-label')?.textContent || 'Official video';
  frame.innerHTML = `<div class="ovid-fallback" role="status">${img ? img.outerHTML : ''}<div class="ovid-fb-copy"><b>${kind === 'blocked' ? 'Not available for embedded playback in your region.' : 'This video is not available for embedded playback.'}</b><a class="btn gold" href="${esc(url)}" target="_blank" rel="noopener">Watch on YouTube ↗</a></div><span class="ovid-label">${esc(label)}</span></div>`;
  card.classList.remove('playing'); card.classList.add('failed');
}

// VideoObject JSON-LD for a matcher-validated article video only.
export function videoObject(v) {
  if (!v?.validated || !idOk(v.provider_video_id)) return null;
  return { '@context': 'https://schema.org', '@type': 'VideoObject', name: v.title, description: v.description || v.title, thumbnailUrl: [thumbOf(v)], uploadDate: v.published_at,
    contentUrl: `https://www.youtube.com/watch?v=${v.provider_video_id}`, embedUrl: `https://www.youtube-nocookie.com/embed/${v.provider_video_id}`,
    ...(v.duration_sec ? { duration: `PT${Math.floor(v.duration_sec / 60)}M${v.duration_sec % 60}S` } : {}),
    publisher: { '@type': 'Organization', name: v.channel_name } };
}
