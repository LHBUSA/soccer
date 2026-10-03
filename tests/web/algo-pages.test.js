// Soccer Algo V1 pages: labelling, separation, empty states, no prices, privacy, discoverability after activation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { picks, trackRecord, MODELS } from '../../src/pages/algo.js';
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
const V1 = MODELS.find(m => m.key === 'bundesliga'); const V2 = MODELS.find(m => m.key === 'nations-league');
const one = data => ({ models: data.live ? [{ model: V1, res: { data, meta } }] : [], tab: 'all' });
const rec = (data, extra = {}) => ({ rec: { data, meta }, res: { data: research }, model: V1, live: data.live ? [V1] : [], markets: policy().markets, ...extra });
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('Game Best below threshold is labelled MODEL FORECAST, never an Official Pick; a qualifying one shows its record number', () => {
  const html = picks.render(one({ ...emptyPicks, live: true, game_best: [gb(false), gb(true, 1)] }));
  const cards = html.split('<article').slice(1);
  assert.match(cards[0], /MODEL FORECAST/); assert.match(cards[0], /Not an Official Pick: below the 60\.0% threshold/); assert.doesNotMatch(cards[0], /OFFICIAL PICK #/);
  assert.match(cards[1], /OFFICIAL PICK #1/); assert.doesNotMatch(cards[1], /MODEL FORECAST/);
});

test('empty state before go-live is clean: not-live banner, empty ledger, no NaN/undefined, hit rate shown as a dash', () => {
  const p = text(picks.render(one(emptyPicks)));
  assert.match(p, /Not live yet\. No PBE Picks model has issued an Official Pick/);
  const r = text(trackRecord.render(rec(emptyRecord)));
  assert.match(r, /The record is empty\./); assert.match(r, /No Official Picks yet/); assert.match(r, /Record 0–0/); assert.match(r, /Hit rate —/);
  for (const t of [p, r]) assert.doesNotMatch(t, /NaN|undefined|null/);
});

test('Historical Validation is a separate labelled section after the public record, never inside it', () => {
  const html = trackRecord.render(rec(emptyRecord));
  const at = html.indexOf('class="algo-research"');
  assert.ok(at > html.indexOf('Every Official Pick'), 'research comes after the ledger');
  assert.match(html.slice(at), /MODEL RESEARCH[\s\S]*HISTORICAL VALIDATION[\s\S]*never counted in the Official Pick record/);
  assert.doesNotMatch(html.slice(0, at), /729|548|75\.6%|75\.7%/, 'no research number inside the public record');
});

test('no ROI, units or CLV value without a stored pre-lock price', () => {
  const r = text(trackRecord.render(rec(emptyRecord)));
  assert.doesNotMatch(r, /ROI\s*[-+]?\d|[-+]?\d+(\.\d+)?\s*units|CLV\s*[-+]?\d/i);
  assert.match(r, /No default odds are ever assumed/);
  assert.equal(emptyRecord.prices.roi, null);
});

test('the internal model id stays private on every Algo surface', () => {
  const html = picks.render(one({ ...emptyPicks, live: true, game_best: [gb(false)] })) + trackRecord.render(rec(emptyRecord));
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

// ---- Soccer PBE Picks: several independent models -------------------------------------------------------------
const v2Policy = { algo_version: 'soccer-algo-v2.1.0', status: 'official', spec_hash: '5'.repeat(64), model_hash: '4'.repeat(64), pick_policy_version: 'soccer-algo-v2-pick-policy/1.0', competition: 'UEFA Nations League (group / league-phase matches)', official_markets: [{ market: 'away_to_score', name: 'Away team to score', threshold: 0.8 }] };
const v2gb = { ...gb(false), match_id: 'nl1', kickoff_at: '2026-10-10T18:45:00Z', home: team('x', 'Nation X'), away: team('y', 'Nation Y'), game_best: { market: 'away_to_score', market_name: 'Away team to score', selection: 'yes', label: 'Nation Y to score', probability: 0.71, threshold: 0.8, qualifies: false } };
const pick = (n, kickoff) => ({ record_no: n, match_id: `p${n}`, home: team('a', 'Home FC'), away: team('b', 'Away FC'), market: '1x2', market_name: 'Match result', selection: 'home', label: 'Home FC to win', model_probability: 0.7, threshold: 0.6, issued_at: '2026-10-02T19:00:00Z', lock_at: '2026-10-09T17:30:00Z', kickoff_at: kickoff, status: 'pending' });
const both = (tab = 'all', v2Live = true) => ({ tab, models: [{ model: V1, res: { data: { ...emptyPicks, live: true, official_picks: { open: [pick(1, '2026-10-09T18:30:00Z')], recent: [] }, game_best: [gb(true, 1)] }, meta } }, ...(v2Live ? [{ model: V2, res: { data: { live: true, policy: v2Policy, official_picks: { open: [], recent: [] }, game_best: [v2gb] }, meta } }] : [])] });

test('page is Soccer PBE Picks, not a Bundesliga V1 page; tabs list only live models', () => {
  const t = text(picks.render(both()));
  assert.match(t, /SOCCER PBE PICKS/); assert.doesNotMatch(t, /SOCCER ALGO V1 · BUNDESLIGA/);
  assert.match(t, /ALL BUNDESLIGA NATIONS LEAGUE/);
  const v1only = text(picks.render(both('all', false)));
  assert.doesNotMatch(v1only, /NATIONS LEAGUE|Soccer Algo V2/, 'a model that is not live is not shown at all');
});

test('every card names its competition, algo version, market, probability, threshold, issue and lock time', () => {
  const html = picks.render(both());
  const cards = html.split('<article').slice(1);
  assert.equal(cards.length, 2);
  for (const [c, comp, ver] of [[cards.find(x => /Home FC/.test(x)), 'Bundesliga', 'Soccer Algo V1'], [cards.find(x => /Nation X/.test(x)), 'UEFA Nations League', 'Soccer Algo V2']]) {
    const t = text(c);
    assert.match(t, new RegExp(`${comp} · ${ver}`)); assert.match(t, /threshold \d+\.\d%/); assert.match(t, /issued /); assert.match(t, /locks /); assert.match(t, /GAME BEST/);
  }
  assert.match(text(cards.find(x => /Nation X/.test(x))), /Away team to score · threshold 80\.0%/);
  const table = text(html.slice(html.indexOf('Open Official Picks'), html.indexOf('</table>')));
  assert.match(table, /Bundesliga · Soccer Algo V1/); assert.match(table, /threshold 60\.0%/);
});

test('a competition tab shows only that model; each policy is shown separately', () => {
  const nl = text(picks.render(both('nations-league')));
  assert.doesNotMatch(nl, /Home FC|Soccer Algo V1/); assert.match(nl, /Nation X/);
  const all = picks.render(both());
  assert.equal((all.match(/class="algo-policy"/g) || []).length, 2, 'two frozen policies, never merged');
});

test('no combined record: the track record shows one model with its own tabs, never a pooled hit rate', () => {
  const r = text(trackRecord.render(rec({ ...emptyRecord, live: true }, { live: [V1, V2] })));
  assert.match(r, /SOCCER ALGO V1 · BUNDESLIGA · PUBLIC RECORD/); assert.match(r, /BUNDESLIGA NATIONS LEAGUE/);
  assert.doesNotMatch(r, /ALL(?! markets)/, 'no ALL tab on the record');
  const page = readFileSync('src/pages/algo.js', 'utf8');
  assert.doesNotMatch(page.slice(page.indexOf('export const trackRecord')), /flatMap|concat\(/, 'the record view never pools models');
});

test('models load independently: one failing API never hides the other', async () => {
  const mod = await import('../../src/lib/api.js');
  assert.equal(typeof mod.api, 'function');
  const src = readFileSync('src/pages/algo.js', 'utf8');
  assert.match(src, /Promise\.allSettled\(MODELS\.map/);
  assert.match(src, /\.filter\(x => x\.res\?\.data\?\.live === true\)/);
});
