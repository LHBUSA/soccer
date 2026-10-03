// LEAKAGE GUARD (owner 2026-10-03): prediction-market prices never enter a PBE soccer model.
// Kalshi and Polymarket (and any venue) prices are benchmark/context only. Every model boundary
// (algoForecast = soccer-algo-v1, v2Forecast = soccer-algo-v2.1, predictShadow) calls assertModelInputs()
// before the model sees its inputs, and the Algo lanes read the database through guardModelStore(), which
// refuses any market/venue table. Adapted from propbetedge-workers workers/propsports-markets/src/leakage-guard.js.
// Behaviour-neutral by construction: it only reads key names and throws; it never edits or reorders inputs.
// Today's legitimate input keys (id, kickoff_at, t, home/away_team_id, home/away_score, neutral, competition_id,
// season_id, stage_id, status) match none of the patterns; tests/leakage.test.js pins that.
export const MARKET_KEY_PATTERN = /(kalshi|polymarket|prediction_?market|clob|gamma|market|venue|consensus|yes_bid|yes_ask|no_bid|no_ask|best_bid|best_ask|\bbid\b|\bask\b|_bid|_ask|bid_|ask_|mid_?point|(^|_)mid(_|$)|spread|last_?trade|last_price|order_?book|(^|_)book(_|$)|depth|open_interest|liquidity|implied_prob|resolution_value|traded|volume|outcome_token|token_id|condition_id)/i;

// Tables / endpoints whose rows are market data. A model input read may never touch them.
export const MARKET_TABLE_PATTERN = /(^market_|^algo_market_|^pred_venue_|kalshi|polymarket|prediction_?market|propsports-markets)/i;

export class MarketLeakageError extends Error {
  constructor(path) { super(`market-derived field "${path}" cannot enter a PBE feature vector`); this.name = 'MarketLeakageError'; this.path = path; }
}

export function findMarketKeys(value, path = '$') {
  const hits = [];
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) hits.push(...findMarketKeys(value[i], `${path}[${i}]`)); }
  else if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) {
      const p = `${path}.${k}`;
      if (MARKET_KEY_PATTERN.test(k)) hits.push(p);
      hits.push(...findMarketKeys(value[k], p));
    }
  }
  return hits;
}

export function assertMarketFree(features) {
  const hits = findMarketKeys(features);
  if (hits.length) throw new MarketLeakageError(hits[0]);
  return features;
}

// Model boundary: the input list and the target fixture handed to a frozen model.
export function assertModelInputs(inputs, target) {
  assertMarketFree({ inputs, target });
}

// A table (or 'table?select=...' path) a model lane reads from.
export function assertModelSourceTable(path) {
  const table = String(path).split('?')[0];
  if (MARKET_TABLE_PATTERN.test(table)) throw new MarketLeakageError(`table ${table}`);
  return table;
}

// The lane's store with every select() checked against the market-table denylist; everything else passes through.
export function guardModelStore(store) {
  if (!store) return store;
  return new Proxy(store, {
    get(target, key) {
      if (key === 'select') return async (table, ...rest) => { assertModelSourceTable(table); return target.select(table, ...rest); };
      const v = Reflect.get(target, key, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}
