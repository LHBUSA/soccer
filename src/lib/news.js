// Homepage news curation (deterministic; tested in tests/web/news-desk.test.js).
//   Latest News : chronological (newest first).
//   Top Story   : selectHomepageLead() = freshest populated bucket (12 / 24 / 48 h), then materiality x
//                 freshness inside it; no randomness, no rotation.
// Materiality uses only what the published article states: its story class and the facts the
// composer writes into the headline from its fixed templates (a margin, a hat-trick, a table lead,
// a streak length). Nothing is inferred beyond the article; ties break by recency, then slug.

const CLASS_WEIGHT = { match_recap: 3, competition_intelligence: 3, player_form: 2.2, team_trend: 1.6, match_preview: 2.4 };
const HALF_LIFE_H = 30; // a story's pull halves every 30 hours

export function materiality(a) {
  const h = String(a?.headline || '');
  let s = CLASS_WEIGHT[a?.story_class] ?? 1.5;
  const score = h.match(/\b(\d{1,2})-(\d{1,2})\b/);
  if (score) { const margin = Math.abs(Number(score[1]) - Number(score[2])); const goals = Number(score[1]) + Number(score[2]); if (margin >= 3) s += 1; if (goals >= 6) s += 0.6; }
  if (/hat-trick/i.test(h)) s += 1.4;
  else if (/scores \d/i.test(h)) s += 0.5;
  if (/\b(go top|lead the|top of the)\b/i.test(h)) s += 1.2;
  const streak = h.match(/\b(\d{1,2}) (straight|[A-Za-z ]*?(wins|matches|defeats|games))/);
  if (streak && Number(streak[1]) >= 6) s += 0.6;
  if (a?.image?.url) s += 0.4; // a lead should carry a real image when two stories are otherwise close
  return Math.round(s * 100) / 100;
}

export function freshness(a, now = Date.now()) {
  const ageH = Math.max(0, (now - Date.parse(a?.published_at || 0)) / 3600e3);
  return Math.pow(0.5, ageH / HALF_LIFE_H);
}

export const leadScore = (a, now = Date.now()) => materiality(a) * freshness(a, now);

// Freshness buckets: the lead comes from the FRESHEST populated bucket (<= 12 h, else <= 24 h, else
// <= 48 h, else everything), then materiality x freshness decides inside that bucket. A spectacular
// result from yesterday cannot hold the lead over a solid story from this morning; with nothing
// fresh, the best older story still leads.
export const LEAD_BUCKETS_H = [12, 24, 48];
export function leadPool(items, now = Date.now()) {
  const age = a => (now - Date.parse(a.published_at)) / 3600e3;
  return LEAD_BUCKETS_H.map(h => items.filter(a => age(a) <= h)).find(b => b.length) || items;
}

export function selectHomepageLead(items, now = Date.now()) {
  if (!items?.length) return null;
  return [...leadPool(items, now)].sort((x, y) => leadScore(y, now) - leadScore(x, now) || Date.parse(y.published_at) - Date.parse(x.published_at) || String(x.slug).localeCompare(String(y.slug)))[0];
}

export const latestNews = (items, exclude = null) => [...(items || [])].filter(a => !exclude || a.slug !== exclude.slug).sort((x, y) => Date.parse(y.published_at) - Date.parse(x.published_at) || String(x.slug).localeCompare(String(y.slug)));

export const STORY_LABEL = { match_recap: 'Match report', competition_intelligence: 'Table watch', player_form: 'Player form', team_trend: 'Team trend', match_preview: 'Preview' };
export const storyLabel = c => STORY_LABEL[c] || String(c || 'Story').replace(/_/g, ' ');
