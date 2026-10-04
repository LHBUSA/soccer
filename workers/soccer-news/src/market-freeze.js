// Writer-side freeze of the FINAL article market packet (network contract article-market/1, propbetedge-workers
// workers/propsports-markets/docs/POST_EVENT_MARKET_RESULT.md, newsroom rule 3): when the shared API answers
// freeze = EMBED_THIS_PACKET for a published article, the sealed post_event_market_result/1 packet + its sha256 are
// stored ONCE in the article's own evidence (soccer_article_evidence, append-only by DB trigger). No migration: the
// row is keyed by the article's news_event_id and carries packet_version MARKET_FREEZE_VERSION.
//
// - Prospective only: articles first published at/after ARTICLE_MARKET_ACTIVATED_AT (never move it; no backfill).
// - Link = the article's SportsEvent entity (our match UUID = the canonical event id). Never a title match.
// - published_at = the ORIGINAL first publication (the column is never moved by a correction).
// - The packet's sha256 is re-verified here (canonical sorted-key JSON without the hash) before anything is stored;
//   a packet that does not verify, is not FINAL, or names another event is never frozen.
// - Read through the MARKETS service binding (a workers.dev -> workers.dev fetch fails with CF 1042).
// - The article's prose is never touched; only the evidence table gains a row.

export const MARKET_FREEZE_VERSION = 'soccer-article-market-freeze/1';
export const MARKET_PACKET_SCHEMA = 'post_event_market_result/1';
export const ARTICLE_MARKET_ACTIVATED_AT = '2026-10-04T14:31:40Z';
export const FREEZE_LOOKBACK_DAYS = 30; // a market that never settles stops being polled after this
export const FREEZE_MAX_READS_PER_RUN = 25;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The same canonical JSON propsports-markets seals with (sorted keys, undefined dropped, null for missing). */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
export async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function packetVerifies(packet) {
  if (!packet || typeof packet !== 'object' || !/^[0-9a-f]{64}$/.test(packet.sha256 || '')) return false;
  const { sha256: _drop, ...body } = packet;
  return (await sha256Hex(canonicalJson(body))) === packet.sha256;
}

/** Canonical match id of an article (its SportsEvent entity), else null. */
export function articleEventId(a) {
  const e = (a?.entities || []).find(x => x?.type === 'SportsEvent');
  const id = e ? String(e.id || (e.href || '').split('/').pop() || '') : '';
  return UUID.test(id) ? id : null;
}

/** Decide whether an article-market/1 response may be frozen for this article. Returns a reason or null (= freeze). */
export async function freezeRefusal(body, eventId) {
  if (!body?.eligible) return 'not_eligible';
  if (body.freeze !== 'EMBED_THIS_PACKET') return 'not_final_yet';
  const p = body.packet;
  if (p?.schema !== MARKET_PACKET_SCHEMA) return 'unknown_packet_schema';
  if (p.packet_state !== 'FINAL') return 'packet_not_final';
  if (String(p.canonical_event_id) !== eventId) return 'packet_for_another_event';
  if (!(await packetVerifies(p))) return 'packet_sha256_mismatch';
  return null;
}

/** The evidence record (article-specific wrapper, so two articles on one match never collide on packet_hash). */
export async function freezeRecord(article, eventId, packet) {
  const record = {
    schema: MARKET_FREEZE_VERSION, article_id: article.id, slug: article.slug, canonical_event_id: eventId,
    published_at: new Date(article.published_at).toISOString(), market_packet_sha256: packet.sha256, packet,
  };
  return { packet_hash: await sha256Hex(canonicalJson(record)), news_event_id: article.news_event_id, packet_version: MARKET_FREEZE_VERSION, packet: record, capture_ids: [`article-market:${packet.sha256}`] };
}

/**
 * One pass: every published, eligible, linked article without a frozen market packet is read once; FINAL packets are
 * stored. `fetcher(url)` defaults to the MARKETS service binding. Never throws into the news run (errors are counted).
 */
export async function freezeMarketPackets(store, env = {}, { now = Date.now(), fetcher } = {}) {
  const out = { version: MARKET_FREEZE_VERSION, checked: 0, frozen: 0, already_frozen: 0, waiting: {}, errors: 0, frozen_articles: [] };
  const read = fetcher || (env.MARKETS?.fetch ? url => env.MARKETS.fetch(url) : null);
  if (!read) return { ...out, skipped: 'no_markets_binding' };
  const since = new Date(Math.max(Date.parse(ARTICLE_MARKET_ACTIVATED_AT), now - FREEZE_LOOKBACK_DAYS * 86400e3)).toISOString();
  const arts = (await store.select('soccer_articles', { columns: ['id', 'slug', 'news_event_id', 'published_at', 'entities'], eq: { status: 'published' }, gte: { published_at: since }, order: 'published_at.asc', limit: 500 }))
    .filter(a => Date.parse(a.published_at) >= Date.parse(ARTICLE_MARKET_ACTIVATED_AT) && articleEventId(a));
  if (!arts.length) return out;
  const have = new Set((await store.select('soccer_article_evidence', { columns: ['news_event_id'], eq: { packet_version: MARKET_FREEZE_VERSION }, in: { news_event_id: [...new Set(arts.map(a => a.news_event_id))] } })).map(r => r.news_event_id));
  for (const a of arts) {
    if (have.has(a.news_event_id)) { out.already_frozen += 1; continue; }
    if (out.checked >= FREEZE_MAX_READS_PER_RUN) break;
    const eventId = articleEventId(a);
    out.checked += 1;
    try {
      const r = await read(`https://propsports-markets/v1/article-market/soccer/${encodeURIComponent(eventId)}?published_at=${encodeURIComponent(new Date(a.published_at).toISOString())}`);
      if (!r.ok) { out.waiting[`http_${r.status}`] = (out.waiting[`http_${r.status}`] || 0) + 1; continue; }
      const body = await r.json();
      const refusal = await freezeRefusal(body, eventId);
      if (refusal) { out.waiting[refusal] = (out.waiting[refusal] || 0) + 1; continue; }
      const row = await freezeRecord(a, eventId, body.packet);
      await store.insert('soccer_article_evidence', [row]);
      have.add(a.news_event_id);
      out.frozen += 1;
      out.frozen_articles.push({ slug: a.slug, canonical_event_id: eventId, market_packet_sha256: body.packet.sha256, evidence_packet_hash: row.packet_hash });
    } catch (e) { out.errors += 1; out.last_error = String(e?.message || e).slice(0, 160); }
  }
  return out;
}
