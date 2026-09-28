// detect -> freeze packet -> deterministic draft (evidence) -> fact gates on the draft
//   -> WORLD-CLASS DESK (desk.js) -> grounded validation + quality gates -> publish | HOLD.
// The draft is never the public story when the desk is required (default): a desk that is
// unavailable or fails its gates HOLDS the story (quality over volume).
// Idempotent: the news event id is uuidv5(story key); an existing event is skipped,
// so a story is written once. Evidence rows are append-only (DB trigger).
import { loadSeason, detect, buildPacket, ENGINE_VERSION } from './engine.js';
import { compose } from './compose2.js';
import { runGates2, GATE_V2 } from './gates2.js';
import { editorialPass, llmEnabled } from './editorial.js';
import { runDesk, deskRequired, deskAvailable, DESK_VERSION } from './desk.js';
import { uuidv5 } from '../../shared/ids.js';
import { chunkArr } from '../../soccer-ingest/src/store.js';

export const NEWS_COMPETITIONS = ['mls', 'premier-league', 'uefa-champions-league', 'bundesliga'];

export async function runNews(store, { now = Date.now(), env = {}, windowDays = 4, maxPerCompetition = 12, dry = false, competitions = NEWS_COMPETITIONS, cfg = {} } = {}) {
  const summary = { engine: ENGINE_VERSION, gates: GATE_V2, at: new Date(now).toISOString(), llm: llmEnabled(env), desk: { required: deskRequired(env), available: deskAvailable(env), version: DESK_VERSION }, competitions: {} };
  for (const slug of competitions) {
    const out = summary.competitions[slug] = { candidates: 0, new: 0, published: 0, held: 0, holds: {}, stories: [] };
    const S = await loadSeason(store, slug);
    if (!S) { out.skipped = 'no season'; continue; }
    const cands = await detect(store, S, { now, windowDays, cfg });
    out.candidates = cands.length;
    let ids = cands.map(c => uuidv5(`news_event:${c.key}`));
    const existing = new Set();
    for (const part of chunkArr(ids, 100)) for (const r of await store.select('soccer_news_events', { columns: ['id'], in: { id: part } })) existing.add(r.id);
    // Corrections: a story whose article was WITHDRAWN (and never replaced) is re-issued
    // once under `<key>:correction`, and the new article says what it replaces and why.
    const withdrawn = new Map();
    for (const part of chunkArr(ids.filter(i => existing.has(i)), 100)) for (const a of await store.select('soccer_articles', { columns: ['news_event_id', 'slug', 'status', 'hold_reasons'], in: { news_event_id: part } })) if (a.status === 'withdrawn') withdrawn.set(a.news_event_id, a);
    for (let i = 0; i < cands.length; i++) {
      const w = withdrawn.get(ids[i]); if (!w) continue;
      cands[i] = { ...cands[i], key: `${cands[i].key}:correction`, corrects: { slug: w.slug, reason: (w.hold_reasons || [])[0] || 'withdrawn' } };
      ids[i] = uuidv5(`news_event:${cands[i].key}`);
    }
    for (const part of chunkArr(ids.filter(i => !existing.has(i)), 100)) for (const r of await store.select('soccer_news_events', { columns: ['id'], in: { id: part } })) existing.add(r.id);
    const fresh = cands.filter((c, i) => !existing.has(ids[i])).sort((a, b) => b.materiality.score - a.materiality.score).slice(0, maxPerCompetition);
    out.new = fresh.length;
    for (const cand of fresh) {
      const packet = await buildPacket(store, S, cand);
      const draft = compose(packet);
      const r = await editorialStage(draft, packet, env);
      const { article, status, holdReasons, gates, editorial } = r;
      out[status] += 1;
      for (const f of holdReasons) out.holds[f] = (out.holds[f] || 0) + 1;
      out.stories.push({ status, story_class: packet.event.kind, headline: article.headline, slug: article.slug, failed: holdReasons });
      if (dry) continue;
      const eventId = packet.event.event_id;
      await store.insert('soccer_news_events', [{
        id: eventId, story_class: packet.event.kind, desk: article.desk, match_id: packet.match?.id || null,
        team_ids: article.entities.filter(e => e.type === 'SportsTeam').map(e => e.id), player_ids: article.entities.filter(e => e.type === 'Person').map(e => e.id),
        competition_id: S.comp.id, materiality: Math.min(99, cand.materiality.score), as_of: new Date(cand.as_of).toISOString(), status,
      }]);
      await store.insert('soccer_article_evidence', [{ packet_hash: packet.hash, news_event_id: eventId, packet_version: packet.version, packet, capture_ids: [] }]);
      await store.insert('soccer_articles', [{
        id: uuidv5(`article:${packet.hash}`), slug: article.slug, news_event_id: eventId, packet_hash: packet.hash, story_class: packet.event.kind, desk: article.desk,
        headline: article.headline, dek: article.dek, body: articleBody(article, editorial), entities: article.entities, composer: article.composer, gate_version: editorial?.version ? `${gates.version}+${editorial.version}` : gates.version,
        gate_results: { draft: gates.results, desk: editorial?.results || null }, status, hold_reasons: holdReasons, hero_media: null, published_at: status === 'published' ? new Date(now).toISOString() : null,
      }]);
    }
  }
  return summary;
}

// Stored body: the public story (sections), the disclosure (method + attributions, shown collapsed
// under the story), the deterministic draft kept as evidence for editors, and the desk's judgement.
export function articleBody(article, editorial) {
  return { sections: article.sections, disclosure: article.disclosure || null, draft: article.draft || null, editorial: editorial || null };
}

// Fact gates on the draft (evidence integrity), then the desk. Desk required (default): the
// public story is the desk's or nothing. Desk off (NEWS_DESK=off): legacy behaviour.
export async function editorialStage(draft, packet, env, { fetcher } = {}) {
  const gates = runGates2(draft, packet);
  if (!gates.pass) return { article: draft, status: 'held', holdReasons: gates.failed, gates, editorial: null };
  if (deskRequired(env)) {
    const d = await runDesk(draft, packet, env, fetcher ? { fetcher } : {});
    if (d.article) return { article: d.article, status: 'published', holdReasons: [], gates, editorial: d.judgement };
    return { article: d.rejected ? { ...d.rejected } : draft, status: 'held', holdReasons: d.held, gates, editorial: d.judgement || { version: DESK_VERSION, held: d.held } };
  }
  let article = draft; let editorial = null;
  const edited = await editorialPass(draft, packet, env).catch(() => null);
  if (edited) { const g2 = runGates2(edited, packet); editorial = { used: g2.pass, failed: g2.failed }; if (g2.pass) article = edited; }
  return { article, status: 'published', holdReasons: [], gates, editorial };
}

// Re-edit an existing article through the desk from its frozen evidence packet (held stories, and
// earlier template articles). Pass: the article is replaced by the desk's story (updated_at moves).
// Fail: nothing changes unless `holdOnFail` (then a published template story is held).
export async function reeditArticle(store, slug, env, { dry = false, holdOnFail = false, fetcher } = {}) {
  const [a] = await store.select('soccer_articles', { columns: ['id', 'slug', 'status', 'packet_hash', 'composer', 'desk', 'story_class', 'entities', 'headline', 'dek', 'body'], eq: { slug }, limit: 1 });
  if (!a) return { slug, error: 'not found' };
  const [ev] = await store.select('soccer_article_evidence', { columns: ['packet'], eq: { packet_hash: a.packet_hash }, limit: 1 });
  const packet = ev.packet;
  const draft = compose(packet);
  const r = await editorialStage(draft, packet, { ...env, NEWS_DESK: 'on' }, { fetcher });
  const res = { slug, before: { status: a.status, composer: a.composer, headline: a.headline }, result: r.status, holds: r.holdReasons, headline: r.article.headline };
  if (dry) return { ...res, article: r.article, judgement: r.editorial };
  if (r.status === 'published') {
    await store.update('soccer_articles', { headline: r.article.headline, dek: r.article.dek, body: articleBody(r.article, r.editorial), composer: r.article.composer, gate_version: `${r.gates.version}+${r.editorial.version}`, gate_results: { draft: r.gates.results, desk: r.editorial.results }, status: 'published', hold_reasons: [], published_at: a.status === 'published' ? undefined : new Date().toISOString(), updated_at: new Date().toISOString() }, { eq: { id: a.id } });
  } else if (holdOnFail && a.status === 'published') {
    await store.update('soccer_articles', { status: 'held', hold_reasons: r.holdReasons, published_at: null, updated_at: new Date().toISOString() }, { eq: { id: a.id } });
    res.held_now = true;
  }
  return res;
}
