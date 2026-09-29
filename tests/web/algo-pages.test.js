// Soccer Algo V1 pages: labelling, separation, empty states, no prices, privacy, discoverability after activation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { picks, trackRecord } from '../../src/pages/algo.js';
import { buildMeta, metaPlan } from '../../src/seo/meta.js';
import { resolve } from '../../src/lib/router.js';
import { summarize, policy } from '../../workers/soccer-api/src/algo.js';
import research from '../../workers/soccer-api/src/algo-research.json' with { type: 'json' };

const meta = { source: 'pbe', coverage: { state: 'unavailable', notes: [] } };
const team = (slug, name) => ({ slug, name, short_name: null, crest: null });
const probs = { home_win: 0.66, draw: 0.2, away_win: 0.14, home_to_score: 0.9, away_to_score: 0.6, over_2_5: 0.55, btts: 0.5 };
const gb = (qualifies, record) => ({ match_id: `m${record || 0}`, kickoff_at: '2026-10-09T18:30:00Z', home: team('a', 'Home FC'), away: team('b', 'Away FC'), forecast_issued_at: '2026-10-02T19:00:00Z', input_hash: 'f'.repeat(64), expected_goals_model: { home: 2, away: 1 }, probabilities: probs,
  game_best: { market: '1x2', market_name: 'Match result', selection: 'home', label: 'Home FC to win', probability: qualifies ? 0.66 : 0.55, threshold: 0.6, qualifies }, official_pick: qualifies ? { record_no: record, status: 'pending' } : null });
const emptyPicks = { live: false, started_at: null, policy: policy(), official_picks: { open: [], recent: [] }, game_best: [], awaiting_forecast: [] };
const emptyRecord = { live: false, started_at: null, policy: policy(), filter: { market: null, last: null }, totals: summarize([]), by_market: {}, windows: {}, prices: { priced_picks: 0, roi: null, units: null, clv: null, reason: 'No stored sportsbook price exists for any Official Pick, so ROI, units and CLV are not reported. No default odds are ever assumed.' }, picks: [] };
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('Game Best below threshold is labelled MODEL FORECAST, never an Official Pick; a qualifying one shows its record number', () => {
  const html = picks.render({ data: { ...emptyPicks, live: true, game_best: [gb(false), gb(true, 1)] }, meta });
  const cards = html.split('<article').slice(1);
  assert.match(cards[0], /MODEL FORECAST/); assert.match(cards[0], /Not an Official Pick: below the 60\.0% threshold/); assert.doesNotMatch(cards[0], /OFFICIAL PICK #/);
  assert.match(cards[1], /OFFICIAL PICK #1/); assert.doesNotMatch(cards[1], /MODEL FORECAST/);
});

test('empty state before go-live is clean: not-live banner, empty ledger, no NaN/undefined, hit rate shown as a dash', () => {
  const p = text(picks.render({ data: emptyPicks, meta }));
  assert.match(p, /Not live yet\. No Official Pick has been issued/);
  const r = text(trackRecord.render({ rec: { data: emptyRecord, meta }, res: { data: research } }));
  assert.match(r, /The record is empty\./); assert.match(r, /No Official Picks yet/); assert.match(r, /Record 0–0/); assert.match(r, /Hit rate —/);
  for (const t of [p, r]) assert.doesNotMatch(t, /NaN|undefined|null/);
});

test('Historical Validation is a separate labelled section after the public record, never inside it', () => {
  const html = trackRecord.render({ rec: { data: emptyRecord, meta }, res: { data: research } });
  const at = html.indexOf('class="algo-research"');
  assert.ok(at > html.indexOf('Every Official Pick'), 'research comes after the ledger');
  assert.match(html.slice(at), /MODEL RESEARCH[\s\S]*HISTORICAL VALIDATION[\s\S]*never counted in the Official Pick record/);
  assert.doesNotMatch(html.slice(0, at), /729|548|75\.6%|75\.7%/, 'no research number inside the public record');
});

test('no ROI, units or CLV value without a stored pre-lock price', () => {
  const r = text(trackRecord.render({ rec: { data: emptyRecord, meta }, res: { data: research } }));
  assert.doesNotMatch(r, /ROI\s*[-+]?\d|[-+]?\d+(\.\d+)?\s*units|CLV\s*[-+]?\d/i);
  assert.match(r, /No default odds are ever assumed/);
  assert.equal(emptyRecord.prices.roi, null);
});

test('the internal model id stays private on every Algo surface', () => {
  const html = picks.render({ data: { ...emptyPicks, game_best: [gb(false)] }, meta }) + trackRecord.render({ rec: { data: emptyRecord, meta }, res: { data: research } });
  for (const s of [html, JSON.stringify(policy()), JSON.stringify(research)]) assert.doesNotMatch(s, /soccer-research-bundesliga|v1\.2-dc|model_id/);
});

test('activated (owner G7 sign-off 2026-09-29): indexable, canonical, in navigation, footer and sitemap', async () => {
  for (const path of ['/picks', '/track-record']) {
    const { page } = resolve(path); assert.ok(page !== 'notfound');
    const m = buildMeta(path, metaPlan(path).page);
    assert.doesNotMatch(m.robots, /noindex/); assert.equal(m.canonical, `https://soccer.propbetedge.ai${path}`);
  }
  const main = readFileSync('src/main.js', 'utf8');
  const nav = main.slice(main.indexOf('const NAV'), main.indexOf('const brandMark'));
  assert.match(nav, /'\/picks', 'PICKS'/); assert.match(nav, /'\/track-record', 'ALGO TRACK RECORD'/);
  assert.match(readFileSync('src/components/footer.js', 'utf8'), /'\/picks', 'Official Picks'\], \['\/track-record', 'Algo Track Record'\]/);
  const { STATIC_PATHS } = await import('../../api/sitemap.js');
  assert.ok(STATIC_PATHS.includes('/picks') && STATIC_PATHS.includes('/track-record'));
});
