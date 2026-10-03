// Soccer Algo V1 public API. Three strictly separate surfaces:
//   /v1/algo/picks     OFFICIAL PICKS (the ledger) + GAME BEST for every forecast match (model forecast, not a pick)
//   /v1/algo/record    the public track record: Official Picks issued after go-live ONLY, straight from the ledger
//   /v1/algo/research  HISTORICAL VALIDATION (committed research evidence; never part of the record)
// Read-only. No price is ever defaulted: ROI / units / CLV are null unless a stored pre-lock price exists.
import spec from '../../soccer-ingest/src/algo-v1.json' with { type: 'json' };
import research from './algo-research.json' with { type: 'json' };
import { envelope, COVERAGE } from './envelope.js';
import { API_VERSION, teamsById } from './routes.js';

const V = spec.algo_version;
const E = (data, o) => envelope(data, { version: API_VERSION, source: 'pbe', ...o });
export const ALGO_MARKETS = Object.keys(spec.pick_policy.markets);
const LOCK_MS = spec.lead_time.lock_minutes_before_kickoff * 60e3;
const WINDOW_MS = spec.lead_time.issue_window_days * 864e5;
const r4 = x => (x === null || x === undefined ? null : Math.round(x * 1e4) / 1e4);

const SEL_WORD = { draw: 'Draw', over: 'Over 2.5 goals', under: 'Under 2.5 goals' };
export function selectionLabel(market, selection, home, away) {
  if (market === '1x2') return selection === 'draw' ? 'Draw' : `${selection === 'home' ? home : away} to win`;
  if (market === 'home_to_score') return `${home} to score: ${selection === 'yes' ? 'Yes' : 'No'}`;
  if (market === 'away_to_score') return `${away} to score: ${selection === 'yes' ? 'Yes' : 'No'}`;
  return SEL_WORD[selection] || selection;
}
const MARKET_NAME = { '1x2': 'Match result', home_to_score: 'Home team to score', away_to_score: 'Away team to score', over_2_5: 'Total goals 2.5' };

export function policy() {
  return {
    algo_version: V, spec_hash: spec.spec_hash, model_hash: spec.model.model_hash, pick_policy_version: spec.pick_policy.version,
    competition: 'Bundesliga (league matches)',
    markets: ALGO_MARKETS.map(m => ({ market: m, name: MARKET_NAME[m], threshold: spec.pick_policy.markets[m].threshold })),
    rule: spec.pick_policy.rule, lead_time: spec.lead_time.rule, settlement: spec.settlement, prices: spec.prices,
  };
}

async function started(store) {
  const [s] = await store.select('soccer_algo_events', { columns: ['at'], eq: { algo_version: V, event: 'started' }, order: 'at.asc', limit: 1 });
  return s?.at || null;
}

const teamOut = t => (t ? { slug: t.slug, name: t.name, short_name: t.short_name || null, crest: t.crest ? { url: t.crest.cached_url, attribution: t.crest.attribution } : null } : null);

// PUBLIC RECORD NUMBERS are per model (owner decision 2026-10-03): a pick's position in its own algo_version's ledger,
// in issue order. soccer_algo_picks.record_no is ONE identity shared by every model (and rolled-back ledger-guard
// proofs consume identity values), so it is exposed only as ledger_id, the immutable internal key. No row changes.
export async function modelRecordNumbers(store, version) {
  const ids = [];
  for (let off = 0; ; off += 1000) { const part = await store.select('soccer_algo_picks', { columns: ['record_no'], eq: { algo_version: version }, order: 'record_no.asc', limit: 1000, offset: off }); ids.push(...part.map(r => Number(r.record_no))); if (part.length < 1000) break; }
  return new Map(ids.map((id, i) => [id, i + 1]));
}
export const renumber = (rows, numbers) => rows.map(r => ({ ...r, ledger_id: Number(r.record_no), record_no: numbers.get(Number(r.record_no)) }));

function pickOut(p, teams) {
  const h = teams.get(p.home_team_id); const a = teams.get(p.away_team_id);
  return {
    record_no: Number(p.record_no), ledger_id: p.ledger_id ?? null, match_id: p.match_id, home: teamOut(h), away: teamOut(a),
    market: p.market, market_name: MARKET_NAME[p.market], selection: p.selection, label: selectionLabel(p.market, p.selection, h?.name || 'Home', a?.name || 'Away'),
    model_probability: r4(p.model_probability), threshold: p.threshold,
    issued_at: p.issued_at, lock_at: p.lock_at, kickoff_at: p.kickoff_at, locked: Date.parse(p.lock_at) <= Date.now(),
    status: p.status, final_score: p.final_home_score === null || p.final_home_score === undefined ? null : `${p.final_home_score}-${p.final_away_score}`, settled_at: p.settled_at, settlement_reason: p.settlement_reason,
    input_hash: p.input_hash, input_as_of: p.input_as_of, algo_version: p.algo_version, pick_policy_version: p.pick_policy_version,
    price: p.price_decimal ? { sportsbook: p.sportsbook, decimal: Number(p.price_decimal), american: p.price_american, captured_at: p.price_captured_at } : null,
  };
}

const PICK_COLS = ['id', 'record_no', 'match_id', 'market', 'selection', 'model_probability', 'threshold', 'issued_at', 'lock_at', 'kickoff_at', 'status', 'final_home_score', 'final_away_score', 'settled_at', 'settlement_reason', 'input_hash', 'input_as_of', 'algo_version', 'pick_policy_version', 'sportsbook', 'price_decimal', 'price_american', 'price_captured_at', 'units', 'profit_units'];

async function withTeams(store, rows) {
  const ms = rows.length ? await store.select('soccer_public_matches', { columns: ['id', 'home_team_id', 'away_team_id', 'status'], in: { id: [...new Set(rows.map(r => r.match_id))] } }) : [];
  const byMatch = new Map(ms.map(m => [m.id, m]));
  const joined = rows.map(r => ({ ...r, home_team_id: byMatch.get(r.match_id)?.home_team_id, away_team_id: byMatch.get(r.match_id)?.away_team_id, match_status: byMatch.get(r.match_id)?.status }));
  return { joined, teams: await teamsById(store, joined.flatMap(r => [r.home_team_id, r.away_team_id])) };
}

/** OFFICIAL PICKS + GAME BEST (upcoming) + the next fixtures whose forecast window has not opened yet. */
export async function picks(store, now = Date.now()) {
  const startedAt = await started(store);
  const nowIso = new Date(now).toISOString();
  const numbers = await modelRecordNumbers(store, V);
  const openRows = renumber(await store.select('soccer_algo_picks', { columns: PICK_COLS, eq: { algo_version: V, status: 'pending' }, order: 'kickoff_at.asc' }), numbers);
  const recentRows = renumber(await store.select('soccer_algo_picks', { columns: PICK_COLS, eq: { algo_version: V }, neq: { status: 'pending' }, order: 'record_no.desc', limit: 10 }), numbers);
  const forecasts = await store.select('soccer_algo_forecasts', { columns: ['id', 'match_id', 'issued_at', 'kickoff_at', 'lambda_home', 'lambda_away', 'probabilities', 'game_best', 'input_hash'], eq: { algo_version: V }, gte: { kickoff_at: nowIso }, order: 'kickoff_at.asc', limit: 40 });
  const [comp] = await store.select('soccer_competitions', { columns: ['id'], eq: { slug: spec.competition_scope.competition_slug }, limit: 1 });
  const upcoming = comp ? await store.select('soccer_public_matches', { columns: ['id', 'kickoff_at', 'home_team_id', 'away_team_id', 'status', 'stage_id'], eq: { competition_id: comp.id, status: 'scheduled' }, gte: { kickoff_at: nowIso }, order: 'kickoff_at.asc', limit: 30 }) : [];
  const stageIds = [...new Set(upcoming.map(m => m.stage_id).filter(Boolean))];
  const league = new Set(stageIds.length ? (await store.select('soccer_stages', { columns: ['id', 'stage_type'], in: { id: stageIds } })).filter(s => s.stage_type === spec.competition_scope.stage_type).map(s => s.id) : []);
  const fcIds = new Set(forecasts.map(f => f.match_id));
  const pending = upcoming.filter(m => league.has(m.stage_id) && !fcIds.has(m.id)).slice(0, 10);

  const { joined: pj, teams: t1 } = await withTeams(store, [...openRows, ...recentRows]);
  const { joined: fj, teams: t2 } = await withTeams(store, forecasts);
  const t3 = await teamsById(store, pending.flatMap(m => [m.home_team_id, m.away_team_id]));
  const teams = new Map([...t1, ...t2, ...t3]);
  const pickByMatch = new Map(pj.map(p => [p.match_id, p]));

  const gameBest = fj.map(f => {
    const h = teams.get(f.home_team_id); const a = teams.get(f.away_team_id); const g = f.game_best;
    const official = pickByMatch.get(f.match_id);
    return {
      match_id: f.match_id, kickoff_at: f.kickoff_at, home: teamOut(h), away: teamOut(a), forecast_issued_at: f.issued_at, input_hash: f.input_hash,
      expected_goals_model: { home: r4(f.lambda_home), away: r4(f.lambda_away) },
      probabilities: { home_win: r4(f.probabilities['1x2'].home), draw: r4(f.probabilities['1x2'].draw), away_win: r4(f.probabilities['1x2'].away), home_to_score: r4(f.probabilities.home_to_score), away_to_score: r4(f.probabilities.away_to_score), over_2_5: r4(f.probabilities.over_2_5), btts: r4(f.probabilities.btts) },
      game_best: { market: g.market, market_name: MARKET_NAME[g.market], selection: g.selection, label: selectionLabel(g.market, g.selection, h?.name || 'Home', a?.name || 'Away'), probability: r4(g.probability), threshold: g.threshold, qualifies: g.qualifies },
      official_pick: official ? { record_no: Number(official.record_no), status: official.status } : null,
    };
  });

  return E({
    live: Boolean(startedAt), started_at: startedAt, policy: policy(),
    official_picks: { open: pj.filter(p => p.status === 'pending').map(p => pickOut(p, teams)), recent: pj.filter(p => p.status !== 'pending').map(p => pickOut(p, teams)) },
    game_best: gameBest,
    awaiting_forecast: pending.map(m => ({ match_id: m.id, kickoff_at: m.kickoff_at, home: teamOut(teams.get(m.home_team_id)), away: teamOut(teams.get(m.away_team_id)), forecast_window_opens_at: new Date(Date.parse(m.kickoff_at) - WINDOW_MS).toISOString(), lock_at: new Date(Date.parse(m.kickoff_at) - LOCK_MS).toISOString() })),
  }, {
    semantics: 'OFFICIAL PICKS are the frozen policy\'s qualifying selections, written to an append-only ledger before lock (kickoff - 60 min) and never edited. GAME BEST is the model\'s strongest selection for every forecast match; it is a model forecast and only enters the record when it is also an Official Pick.',
    coverage: startedAt ? COVERAGE.OK : COVERAGE.UNAVAILABLE, coverage_notes: startedAt ? [] : ['Official Picks have not gone live: the record is empty and no pick has been issued.'],
  });
}

const BANDS = [[0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.0001]];
export function summarize(rows) {
  const c = s => rows.filter(r => r.status === s).length;
  const graded = rows.filter(r => r.status === 'win' || r.status === 'loss');
  const wins = c('win'); const losses = c('loss');
  const mean = graded.length ? graded.reduce((s, r) => s + Number(r.model_probability), 0) / graded.length : null;
  return {
    picks: rows.length, wins, losses, voids: c('void'), pushes: c('push'), pending: c('pending'), graded: graded.length,
    hit_rate: graded.length ? r4(wins / graded.length) : null,
    average_model_probability: r4(mean), expected_wins: graded.length ? r4(graded.reduce((s, r) => s + Number(r.model_probability), 0)) : null,
    calibration: BANDS.map(([lo, hi]) => { const b = graded.filter(r => r.model_probability >= lo && r.model_probability < hi); return { band: `${Math.round(lo * 100)}-${Math.min(100, Math.round(hi * 100))}%`, picks: b.length, mean_probability: b.length ? r4(b.reduce((s, r) => s + Number(r.model_probability), 0) / b.length) : null, hit_rate: b.length ? r4(b.filter(r => r.status === 'win').length / b.length) : null }; }),
  };
}

export const RECORD_QUERY = ['market', 'last'];
/** The public track record: every Official Pick in the ledger for this algo version (never research rows). */
export async function record(store, q = {}) {
  const market = q.market && ALGO_MARKETS.includes(q.market) ? q.market : null;
  if (q.market && !market) throw Object.assign(new Error('unknown market'), { status: 400 });
  const last = q.last ? Number(q.last) : null;
  if (q.last && ![30, 60, 100].includes(last)) throw Object.assign(new Error('last must be 30, 60 or 100'), { status: 400 });
  const startedAt = await started(store);
  const all = renumber(await store.select('soccer_algo_picks', { columns: PICK_COLS, eq: { algo_version: V, ...(market ? { market } : {}) }, order: 'record_no.desc' }), await modelRecordNumbers(store, V));
  const settledDesc = all.filter(r => r.status !== 'pending');
  const scope = last ? settledDesc.slice(0, last) : all;
  const { joined, teams } = await withTeams(store, all.slice(0, 200));
  const priced = all.filter(r => r.price_decimal);
  return E({
    live: Boolean(startedAt), started_at: startedAt, policy: policy(), filter: { market, last },
    totals: summarize(scope),
    by_market: Object.fromEntries(ALGO_MARKETS.map(m => [m, summarize(scope.filter(r => r.market === m))])),
    windows: Object.fromEntries([30, 60, 100].map(n => [`last_${n}`, summarize(settledDesc.slice(0, n))])),
    prices: { priced_picks: priced.length, roi: null, units: null, clv: null, reason: priced.length ? 'ROI, units and CLV are not reported in V1.' : 'No stored sportsbook price exists for any Official Pick, so ROI, units and CLV are not reported. No default odds are ever assumed.' },
    picks: joined.map(p => pickOut(p, teams)),
  }, {
    semantics: 'Every Official Pick issued by the frozen policy after go-live, from the append-only ledger. Hit rate = wins / (wins + losses); void and pending picks are excluded from it. Historical validation is NOT included.',
    coverage: startedAt ? COVERAGE.OK : COVERAGE.UNAVAILABLE, coverage_notes: startedAt ? [] : ['The record starts with the first Official Pick after go-live. Nothing has been issued yet.'],
  });
}

/** HISTORICAL VALIDATION: model research on past seasons (committed evidence), labelled and separate. */
export function researchSummary() {
  return E(research, { semantics: 'HISTORICAL VALIDATION of the frozen model and pick policy on past Bundesliga seasons (SELECT 2006/07-2018/19, holdout 2019/20-2025/26 evaluated once). Research, not a track record.', coverage: COVERAGE.OK });
}
