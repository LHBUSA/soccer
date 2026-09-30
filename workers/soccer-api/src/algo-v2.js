// Soccer Algo V2 (International, national teams) public API. SEPARATE from V1: its own algo_version, its own
// ledger rows, its own record. Never merged with V1 into one hit rate.
//   /v1/algo/v2/picks     V2 GAME BEST (model forecasts, labelled) + V2 OFFICIAL PICKS (only if its gate passed)
//   /v1/algo/v2/record    the V2 public record (Official Picks issued after V2 activation only)
//   /v1/algo/v2/research  the pre-registered national-team research (committed evidence; never part of a record)
// status (from the frozen spec, decided by the committed research, never by this code):
//   'shadow'   the model did not pass its display gate: nothing is public but the research
//   'forecast' Game Best forecasts are public, labelled MODEL FORECAST — NOT OFFICIAL PICK; no Official Picks
//   'official' Game Best + Official Picks for the markets that passed the holdout gate
import spec from '../../soccer-ingest/src/algo-v2.json' with { type: 'json' };
import research from './algo-v2-research.json' with { type: 'json' };
import { envelope, COVERAGE } from './envelope.js';
import { API_VERSION, teamsById } from './routes.js';
import { selectionLabel, summarize } from './algo.js';

const V = spec.algo_version;
const E = (data, o) => envelope(data, { version: API_VERSION, source: 'pbe', ...o });
const r4 = x => (x === null || x === undefined ? null : Math.round(x * 1e4) / 1e4);
const MARKET_NAME = { '1x2': 'Match result', home_to_score: 'Home team to score', away_to_score: 'Away team to score', over_2_5: 'Total goals 2.5' };
const OFFICIAL_MARKETS = Object.keys(spec.pick_policy.markets);
const teamOut = t => (t ? { slug: t.slug, name: t.name, short_name: t.short_name || null } : null);
const PICK_COLS = ['id', 'record_no', 'match_id', 'market', 'selection', 'model_probability', 'threshold', 'issued_at', 'lock_at', 'kickoff_at', 'status', 'final_home_score', 'final_away_score', 'settled_at', 'settlement_reason', 'input_hash', 'algo_version'];

export function policyV2() {
  return {
    algo_version: V, status: spec.status, spec_hash: spec.spec_hash, model_hash: spec.model.model_hash, pick_policy_version: spec.pick_policy.version,
    competition: 'UEFA Nations League (group / league-phase matches)', profile: spec.profile,
    official_markets: OFFICIAL_MARKETS.map(m => ({ market: m, name: MARKET_NAME[m], threshold: spec.pick_policy.markets[m].threshold })),
    rule: spec.pick_policy.rule, lead_time: spec.lead_time.rule, settlement: spec.settlement, prices: spec.prices, status_reason: spec.status_reason,
  };
}

async function started(store) {
  const [s] = await store.select('soccer_algo_events', { columns: ['at'], eq: { algo_version: V, event: 'started' }, order: 'at.asc', limit: 1 });
  return s?.at || null;
}
async function withTeams(store, rows) {
  const ms = rows.length ? await store.select('soccer_matches', { columns: ['id', 'home_team_id', 'away_team_id'], in: { id: [...new Set(rows.map(r => r.match_id))] } }) : [];
  const by = new Map(ms.map(m => [m.id, m]));
  const joined = rows.map(r => ({ ...r, home_team_id: by.get(r.match_id)?.home_team_id, away_team_id: by.get(r.match_id)?.away_team_id }));
  return { joined, teams: await teamsById(store, joined.flatMap(r => [r.home_team_id, r.away_team_id])) };
}
const pickOut = (p, teams) => {
  const h = teams.get(p.home_team_id); const a = teams.get(p.away_team_id);
  return { record_no: Number(p.record_no), match_id: p.match_id, home: teamOut(h), away: teamOut(a), market: p.market, market_name: MARKET_NAME[p.market], selection: p.selection, label: selectionLabel(p.market, p.selection, h?.name || 'Home', a?.name || 'Away'), model_probability: r4(p.model_probability), threshold: p.threshold, issued_at: p.issued_at, lock_at: p.lock_at, kickoff_at: p.kickoff_at, status: p.status, final_score: p.final_home_score == null ? null : `${p.final_home_score}-${p.final_away_score}`, settlement_reason: p.settlement_reason, algo_version: p.algo_version };
};

export async function picksV2(store, now = Date.now()) {
  if (spec.status === 'shadow') {
    return E({ algo_version: V, status: 'shadow', live: false, policy: policyV2(), official_picks: { open: [], recent: [] }, game_best: [] }, {
      semantics: 'Soccer Algo V2 (International) did not pass its pre-registered display gate, so no V2 forecast is public. The research is published at /v1/algo/v2/research.',
      coverage: COVERAGE.UNAVAILABLE, coverage_notes: [spec.status_reason],
    });
  }
  const startedAt = await started(store);
  const nowIso = new Date(now).toISOString();
  const forecasts = await store.select('soccer_algo_forecasts', { columns: ['match_id', 'issued_at', 'kickoff_at', 'lambda_home', 'lambda_away', 'probabilities', 'game_best', 'input_hash'], eq: { algo_version: V }, gte: { kickoff_at: nowIso }, order: 'kickoff_at.asc', limit: 60 });
  const open = spec.status === 'official' ? await store.select('soccer_algo_picks', { columns: PICK_COLS, eq: { algo_version: V, status: 'pending' }, order: 'kickoff_at.asc' }) : [];
  const recent = spec.status === 'official' ? await store.select('soccer_algo_picks', { columns: PICK_COLS, eq: { algo_version: V }, neq: { status: 'pending' }, order: 'record_no.desc', limit: 10 }) : [];
  const { joined: fj, teams: t1 } = await withTeams(store, forecasts);
  const { joined: pj, teams: t2 } = await withTeams(store, [...open, ...recent]);
  const teams = new Map([...t1, ...t2]);
  const pickBy = new Map(pj.map(p => [p.match_id, p]));
  const gameBest = fj.map(f => {
    const h = teams.get(f.home_team_id); const a = teams.get(f.away_team_id); const g = f.game_best; const off = pickBy.get(f.match_id);
    return {
      match_id: f.match_id, kickoff_at: f.kickoff_at, home: teamOut(h), away: teamOut(a), forecast_issued_at: f.issued_at, input_hash: f.input_hash,
      expected_goals_model: { home: r4(f.lambda_home), away: r4(f.lambda_away) },
      probabilities: { home_win: r4(f.probabilities['1x2'].home), draw: r4(f.probabilities['1x2'].draw), away_win: r4(f.probabilities['1x2'].away), home_to_score: r4(f.probabilities.home_to_score), away_to_score: r4(f.probabilities.away_to_score), over_2_5: r4(f.probabilities.over_2_5) },
      game_best: { market: g.market, market_name: MARKET_NAME[g.market], selection: g.selection, label: selectionLabel(g.market, g.selection, h?.name || 'Home', a?.name || 'Away'), probability: r4(g.probability), threshold: g.threshold, qualifies: !!(g.qualifies && off) },
      label: off ? `OFFICIAL PICK #${Number(off.record_no)}` : 'MODEL FORECAST — NOT OFFICIAL PICK',
      official_pick: off ? { record_no: Number(off.record_no), status: off.status } : null,
    };
  });
  return E({
    algo_version: V, status: spec.status, live: Boolean(startedAt), started_at: startedAt, policy: policyV2(),
    official_picks: { open: pj.filter(p => p.status === 'pending').map(p => pickOut(p, teams)), recent: pj.filter(p => p.status !== 'pending').map(p => pickOut(p, teams)) },
    game_best: gameBest,
  }, {
    semantics: `Soccer Algo V2 (International): frozen national-team model for UEFA Nations League group matches. GAME BEST is the model's strongest selection for every forecast match and is a MODEL FORECAST, NOT AN OFFICIAL PICK${spec.status === 'official' ? ' unless it also meets a frozen Official Pick threshold' : '; V2 has no Official Picks because no market passed the pre-registered holdout gate'}. Separate from Soccer Algo V1 (Bundesliga): records are never merged.`,
    coverage: startedAt ? COVERAGE.OK : COVERAGE.UNAVAILABLE, coverage_notes: startedAt ? [] : ['V2 forecasts have not started: none has been issued.'],
  });
}

export const RECORD_QUERY_V2 = ['last'];
export async function recordV2(store, q = {}) {
  const last = q.last ? Number(q.last) : null;
  if (q.last && ![30, 60, 100].includes(last)) throw Object.assign(new Error('last must be 30, 60 or 100'), { status: 400 });
  const startedAt = await started(store);
  const all = await store.select('soccer_algo_picks', { columns: PICK_COLS, eq: { algo_version: V }, order: 'record_no.desc' });
  const settled = all.filter(r => r.status !== 'pending');
  const { joined, teams } = await withTeams(store, all.slice(0, 200));
  return E({ algo_version: V, status: spec.status, live: Boolean(startedAt), started_at: startedAt, policy: policyV2(), totals: summarize(last ? settled.slice(0, last) : all), picks: joined.map(p => pickOut(p, teams)) }, {
    semantics: 'Every Soccer Algo V2 Official Pick from the append-only ledger (algo_version soccer-algo-v2.0.0). Separate from the V1 Bundesliga record. Game Best forecasts and research are never in it.',
    coverage: all.length ? COVERAGE.OK : COVERAGE.UNAVAILABLE, coverage_notes: all.length ? [] : [spec.status === 'official' ? 'No V2 Official Pick has been issued yet.' : 'V2 has no Official Picks: no market passed the pre-registered holdout gate.'],
  });
}

export function researchV2() {
  return E(research, { semantics: 'Pre-registered national-team research for Soccer Algo V2 (protocol committed before any number; holdout evaluated once). Research, not a track record.', coverage: COVERAGE.OK });
}
