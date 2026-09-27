// detect -> freeze packet -> compose -> (optional LLM edit) -> gates -> publish | hold.
// Idempotent: the news event id is uuidv5(story key); an existing event is skipped,
// so a story is written once. Evidence rows are append-only (DB trigger).
import { loadSeason, detect, buildPacket, ENGINE_VERSION } from './engine.js';
import { compose } from './compose2.js';
import { runGates2, GATE_V2 } from './gates2.js';
import { editorialPass, llmEnabled } from './editorial.js';
import { uuidv5 } from '../../shared/ids.js';
import { chunkArr } from '../../soccer-ingest/src/store.js';

export const NEWS_COMPETITIONS = ['mls', 'premier-league', 'uefa-champions-league', 'bundesliga'];

export async function runNews(store, { now = Date.now(), env = {}, windowDays = 4, maxPerCompetition = 12, dry = false, competitions = NEWS_COMPETITIONS, cfg = {} } = {}) {
  const summary = { engine: ENGINE_VERSION, gates: GATE_V2, at: new Date(now).toISOString(), llm: llmEnabled(env), competitions: {} };
  for (const slug of competitions) {
    const out = summary.competitions[slug] = { candidates: 0, new: 0, published: 0, held: 0, holds: {}, stories: [] };
    const S = await loadSeason(store, slug);
    if (!S) { out.skipped = 'no season'; continue; }
    const cands = await detect(store, S, { now, windowDays, cfg });
    out.candidates = cands.length;
    const ids = cands.map(c => uuidv5(`news_event:${c.key}`));
    const existing = new Set();
    for (const part of chunkArr(ids, 100)) for (const r of await store.select('soccer_news_events', { columns: ['id'], in: { id: part } })) existing.add(r.id);
    const fresh = cands.filter((c, i) => !existing.has(ids[i])).sort((a, b) => b.materiality.score - a.materiality.score).slice(0, maxPerCompetition);
    out.new = fresh.length;
    for (const cand of fresh) {
      const packet = await buildPacket(store, S, cand);
      const draft = compose(packet);
      let article = draft; let gates = runGates2(draft, packet); let editorial = null;
      const edited = gates.pass ? await editorialPass(draft, packet, env).catch(() => null) : null;
      if (edited) {
        const g2 = runGates2(edited, packet);
        editorial = { used: g2.pass, failed: g2.failed };
        if (g2.pass) { article = edited; gates = g2; }
      }
      const status = gates.pass ? 'published' : 'held';
      out[status] += 1;
      for (const f of gates.failed) out.holds[f] = (out.holds[f] || 0) + 1;
      out.stories.push({ status, story_class: packet.event.kind, headline: article.headline, slug: article.slug, failed: gates.failed });
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
        headline: article.headline, dek: article.dek, body: { sections: article.sections, editorial }, entities: article.entities, composer: article.composer, gate_version: gates.version,
        gate_results: gates.results, status, hold_reasons: gates.failed, hero_media: null, published_at: status === 'published' ? new Date(now).toISOString() : null,
      }]);
    }
  }
  return summary;
}
