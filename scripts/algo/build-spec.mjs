#!/usr/bin/env node
// Builds the FROZEN production specification of Soccer Algo V1 (workers/soccer-ingest/src/algo-v1.json) from
// committed evidence only. Never edit the JSON by hand: a change is a new algo_version (v1.1.0 / v2.0.0) and
// records stay attributable to the spec that issued them.
//   node scripts/algo/build-spec.mjs [--check]   (--check: fail if the committed spec differs)
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const sha = b => createHash('sha256').update(b).digest('hex');
const fileSha = p => sha(readFileSync(p));
const shadow = JSON.parse(readFileSync('workers/soccer-ingest/src/shadow-model.json', 'utf8'));
const freeze = JSON.parse(readFileSync('docs/evidence/research/algo-v1_1/select-freeze.json', 'utf8'));
const holdout = JSON.parse(readFileSync('docs/evidence/research/algo-v1_1/holdout-results.json', 'utf8'));
if (holdout.select_freeze_sha256 !== freeze.freeze_sha256) throw new Error('holdout was not evaluated on this SELECT freeze');
const markets = Object.fromEntries(holdout.v1_markets.map(m => [m.market, { threshold: m.threshold, selections: m.market === '1x2' ? ['home', 'draw', 'away'] : m.market === 'over_2_5' ? ['over', 'under'] : ['yes', 'no'] }]));

const spec = {
  algo_version: 'soccer-algo-v1.0.0',
  name: 'Soccer Algo V1 (Bundesliga)',
  model: { id: shadow.model_id, version: shadow.model_version, model_hash: shadow.model_hash, calibration: shadow.calibration_id, rho: shadow.rho, team_strength: shadow.team_strength, home_half_life_days: shadow.home_half_life_days, code: { path: shadow.sources.core, sha256: fileSha(shadow.sources.core) }, card: { path: shadow.sources.card, sha256: fileSha(shadow.sources.card) }, research_prediction_hash: shadow.sources.research_prediction_hash },
  pick_policy: {
    version: 'soccer-algo-pick-policy/1.1', protocol: { path: 'scripts/research/algo-v1_1-protocol.mjs', sha256: fileSha('scripts/research/algo-v1_1-protocol.mjs') },
    select_freeze: { path: 'docs/evidence/research/algo-v1_1/select-freeze.json', freeze_sha256: freeze.freeze_sha256 },
    holdout: { path: 'docs/evidence/research/algo-v1_1/holdout-results.json', sha256: fileSha('docs/evidence/research/algo-v1_1/holdout-results.json') },
    rule: 'Official Pick = the selection of an eligible market whose model probability >= that market\'s frozen threshold; at most ONE per match (largest probability - threshold; ties by market order 1x2, home_to_score). Game Best = the same argmax whether or not it qualifies; a non-qualifying Game Best never enters the record.',
    markets, market_order: Object.keys(markets),
  },
  competition_scope: { competition_slug: 'bundesliga', stage_type: 'league' },
  input_contract: 'finished Bundesliga league results (canonical soccer_matches) that kicked off strictly before issued_at; any earlier league match without a result -> HOLD (never guess). input_hash = sha256 of the ordered input list; the list is archived write-once in R2 (algo_inputs/sha256/...).',
  lead_time: { issue_window_days: 7, lock_minutes_before_kickoff: 60, rule: 'a forecast and its Official Pick are issued once, between kickoff - 7 days and lock_at = kickoff - 60 minutes, and are immutable from issue; nothing is created after lock (enforced by the ledger trigger)' },
  settlement: { finished: 'graded from the canonical final score (soccer_algo_grade)', postponed: 'stays pending; graded when finished if the canonical kickoff moved by <= 48 h, otherwise void', cancelled: 'void', abandoned: 'void (no separate settlement policy exists)', push: 'no V1 market can push' },
  prices: 'none in V1: no sportsbook price is captured, so ROI, units and CLV are unavailable. A price may only ever come from a stored pre-lock quote; there are no default odds.',
};
spec.spec_hash = sha(JSON.stringify(spec));
const out = `${JSON.stringify(spec, null, 2)}\n`;
const path = 'workers/soccer-ingest/src/algo-v1.json';
if (process.argv.includes('--check')) { if (readFileSync(path, 'utf8') !== out) throw new Error('committed algo spec differs from the evidence'); console.log('spec ok', spec.spec_hash); }
else { writeFileSync(path, out); console.log('wrote', path, spec.spec_hash, JSON.stringify(markets)); }
