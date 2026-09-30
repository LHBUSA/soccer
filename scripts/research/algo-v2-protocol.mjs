// SOCCER ALGO V2 — national-team research + Official Pick protocol. DECLARED 2026-09-30 BEFORE ANY V2 NUMBER
// EXISTED: no national-team dataset had been assembled, no V2 model had been fitted, and no V2 forecast, metric,
// threshold or pick-policy number had been computed on any split. Data only; scripts/research/algo-v2-research.mjs
// records this file's sha256 at the SELECT stage and refuses to run the HOLDOUT stage if it changed.
//
// Soccer Algo V1 (soccer-algo-v1.0.0, workers/soccer-ingest/src/algo-v1.json, Bundesliga league stage) is NOT
// touched by this protocol: its spec, thresholds, ledger rows and public record stay exactly as they are. V2 is a
// separate algo_version with its own record; V1 Bundesliga calibration/thresholds are never applied to national
// teams by default.
//
// Disclosure (what is known when this is written): the V1 Bundesliga results; the 2026/27 Nations League league
// phase and FIFA World Cup 2026 scores are public facts (not model numbers); nobody has computed any model output
// on national-team data.
export const PROTOCOL = {
  id: 'soccer-algo-v2-national-team-protocol',
  algo_version: 'soccer-algo-v2.0.0',
  declared_at: '2026-09-30',
  profiles: {
    domestic_league: 'reserved for a future V2 club profile; V1 (Bundesliga) remains the live club algo and is not re-run under V2',
    national_team_group: 'this protocol: senior men national teams in competitive tournaments; first live target uefa-nations-league league-phase (group) matches',
  },
  data: {
    source: 'ESPN Core (owner-approved secondary structured source) only: uefa.nations seasons 2018, 2020, 2022, 2024, 2026 and fifa.world seasons 2018, 2022, 2026. Every response archived (R2/.raw captures) with its capture_id. No FIFA endpoint. Openfootball CC0 may be used ONLY to cross-check fixture/result identity (never as a model input); the Wyscout 2018 archive is not needed as a model input (ESPN covers 2018).',
    row: '{ match_key, competition_id (slug), season_id (league:year), stage_type (group | knockout | playoff), stage_name, home_team_id, away_team_id (stable ESPN team id; canonical id where production holds the crosswalk), kickoff_at, final score (home_score, away_score as published = after extra time where played), duration, neutral_site (ESPN competition.neutralSite), source capture ids }',
    identity: 'national teams only (ESPN isNational); a club or unresolved side excludes the match. No name-only identity. Competition identity is kept on every row; club and national-team matches are never pooled.',
    excluded: 'unfinished, postponed, cancelled or abandoned matches; matches without both scores',
    labels: '1X2, over 2.5, team-to-score and BTTS are graded on the published final score. SCOPE of Official Picks is group/league-phase matches only, where the final score is the 90-minute score.',
  },
  splits: {
    warmup: 'kickoff < 2020-09-01 (UNL 2018/19 league phase + finals, World Cup 2018): history only, never scored',
    select: '2020-09-01 <= kickoff < 2024-09-01 (UNL 2020/21, 2022/23 incl. finals and play-offs, World Cup 2022): hyper-parameters, rho and thresholds are chosen here',
    holdout: '2024-09-01 <= kickoff <= the research run time (UNL 2024/25 incl. quarter-finals, finals and play-offs, World Cup 2026, UNL 2026/27 matches finished at run time): evaluated ONCE',
    live: 'matches issued after activation: prospective only; never back-filled',
    walk_forward: 'every prediction uses only matches that kicked off strictly before it',
  },
  populations: {
    primary: 'UEFA Nations League group / league-phase matches (stage_type group). All V2 gates are decided on this population.',
    secondary: 'all national-team matches in the dataset (reported, never used to pass a gate)',
  },
  model: {
    id: 'soccer-research-national-v2-maher-dc',
    family: 'time-decayed, opponent-adjusted Poisson strengths (Maher): lambda_home = mu * att_home * def_away * H, lambda_away = mu * att_away * def_home / H, with H = the national-team home factor on non-neutral matches and H = 1 on neutral-site matches; attack/defence fitted by iterative proportional fitting (30 iterations) over every national-team match inside 5 half-lives, each team shrunk toward 1 with k pseudo-matches; Dixon-Coles low-score dependence on the resulting lambdas (structural-core dcGrid)',
    home_effect: 'H estimated inside the same fit from non-neutral matches only (never the Bundesliga value). Reported at SELECT and HOLDOUT together with a likelihood comparison against H = 1 (report only; H stays in the model by design).',
    min_history: 'at least 60 weighted national-team matches in the window, and each side of the target must have >= 1 earlier match; otherwise no forecast (HOLD insufficient_history)',
    grid: { half_life_days: [365, 730, 1460], shrink_k: [2, 5, 10] },
    selection: 'the (half_life, k) with the lowest pooled 1X2 log loss on the SELECT primary population (rho = 0 during this search); then rho fitted once by scoreline likelihood (structural-core fitRho) on SELECT primary rows at the chosen (half_life, k). All three frozen at the SELECT freeze.',
    calibration: 'none',
  },
  baselines: {
    '1x2': 'outcome frequencies conditional on neutral_site, from the window BEFORE the evaluated split (warm-up for SELECT; warm-up + SELECT for HOLDOUT). On a neutral site home and away get the mean of the two frequencies. If fewer than 30 neutral matches exist in the window, neutral uses the symmetrised non-neutral frequencies.',
    binary: 'event rate of the market in the same window (constant prediction)',
  },
  markets: {
    '1x2': { selections: ['home', 'draw', 'away'], selection_rule: 'argmax', eligible: true },
    over_2_5: { selections: ['over', 'under'], selection_rule: 'over if P >= 0.5', eligible: true },
    home_to_score: { selections: ['yes', 'no'], selection_rule: 'yes if P >= 0.5', eligible: true },
    away_to_score: { selections: ['yes', 'no'], selection_rule: 'yes if P >= 0.5', eligible: true },
    btts: { selections: ['yes', 'no'], eligible: false, note: 'reported for research only' },
  },
  market_validation: {
    metrics: ['log loss', 'Brier', 'per-season log loss', 'reliability (10 equal-count bins)', 'expected calibration error'],
    gate_select: 'model beats its baseline on SELECT primary pooled log loss AND Brier, and on log loss in BOTH SELECT UNL seasons (2020/21, 2022/23)',
    gate_holdout: 'model beats its baseline on HOLDOUT primary pooled log loss AND Brier',
    display_gate: 'V2 forecasts (Game Best, labelled MODEL FORECAST — NOT OFFICIAL PICK) may be shown publicly for UNL only if the 1X2 market passes BOTH market-validation gates; otherwise V2 stays a private shadow',
  },
  pick_rule: {
    family: 'ONE rule family (as V1): an Official Pick is the market selection when its model probability >= t_market. No gap, lambda or uncertainty rules.',
    grids: { '1x2': 't in 0.500, 0.525, ..., 0.800', binary: 't in 0.600, 0.625, ..., 0.900' },
    eligibility_on_select: {
      E0_market: 'the market passed gate_select',
      E1_coverage: 'qualifying picks >= 5% of SELECT primary matches',
      E2_calibration: 'ONE-SIDED: pooled hit rate >= mean model probability of the picks - 0.025',
      E3_volume: 'at least 30 qualifying picks on SELECT primary',
      E4_floor: 'Wilson 95% lower bound of the pooled hit rate >= 0.50',
      E5_lift: 'pooled hit rate - baseline rate of the same selections >= 0.10 (baseline rate from the warm-up window, neutral-conditional)',
    },
    selection: 'markets in order 1x2, over_2_5, home_to_score, away_to_score. For each market passing E0: the LOWEST eligible threshold such that the combined one-pick-per-match policy covers <= 20% of SELECT primary matches. No such threshold -> the market carries no V2 Official Picks.',
  },
  per_match_policy: {
    official_pick: 'at most ONE per match: among active markets whose selection meets its frozen threshold, the largest (probability - threshold); ties by market order',
    game_best: 'every forecast UNL match gets a GAME BEST: the selection with the largest (probability - threshold) among the four eligible markets (frozen thresholds; a market with no frozen threshold uses the top of its grid, 0.800 for 1X2 and 0.900 binary, so it can never qualify), shown as "Did not meet Official Pick threshold" when it does not qualify; never enters the record',
  },
  holdout_rule: {
    note: 'evaluated ONCE per selected market and for the combined policy; thresholds, model and rho frozen from SELECT',
    H0_market: 'the market passes gate_holdout',
    H1_calibration: 'ONE-SIDED: pooled hit rate >= mean model probability - 0.04',
    H2_floor: 'Wilson 95% lower bound of the pooled hit rate >= 0.50',
    H3_lift: 'pooled hit rate - baseline rate of the same selections >= 0.08 (baseline from warm-up + SELECT)',
    H4_volume: 'at least 20 qualifying picks on HOLDOUT primary',
    H5_durability: 'every HOLDOUT UNL season with >= 10 picks has hit rate >= its mean model probability - 0.10',
    pass: 'H0-H5 all pass -> the market is active in soccer-algo-v2.0.0 for UNL group matches; otherwise it is dropped (never re-tuned). No market active -> V2 has NO Official Picks.',
  },
  live_contract: {
    scope: 'uefa-nations-league, stage_type league (group / league phase) only. Knockouts, play-offs and the World Cup are out of scope for Official Picks until a later protocol validates them.',
    inputs: 'canonical finished national-team matches (competitions uefa-nations-league, fifa-world-cup) that kicked off strictly before issued_at, with neutral_site from the stored ESPN event capture; the live model must reproduce the frozen research predictions on the holdout rows (reproduction canary) before activation',
    lead_time: 'issued once between kickoff - 7 days and lock_at = kickoff - 60 minutes; immutable from issue (existing soccer_algo_* ledger triggers)',
    record: 'append-only, algo_version soccer-algo-v2.0.0, record separate from V1; never merged into one hit rate',
    grading: 'canonical final score via soccer_algo_grade; postponed stays pending (void if moved > 48 h); cancelled/abandoned void',
    no_backfill: 'no V2 pick is ever created for a match that kicked off before activation; the completed 2026 World Cup is research, replay and intelligence only',
  },
  amendments: [
    {
      at: '2026-09-30T23:45Z',
      before: 'the SELECT stage: no model had been fitted and no V2 metric existed; only the dataset manifest (row counts) had been read',
      facts: [
        'ESPN Core competitions[0].neutralSite is false for all 943 dataset rows, including every World Cup match: the flag carries no information. As declared (unknown/false = not neutral), the home factor H therefore applies to every match as listed. The primary population (UNL group matches) is played at the listed home side, so its gates are unaffected in kind; World Cup rows are secondary only.',
        'ESPN marks team 11678 (Curacao) isNational=false; under data.identity its 3 World Cup 2026 matches are excluded (secondary population only).',
      ],
      changes: 'none to model, grid, splits, populations, gates or code; disclosure only',
    },
  ],
  forbidden: [
    'changing the model family, grid, data, splits or gates after this file is committed',
    'looking at any HOLDOUT number before the SELECT freeze is committed',
    'applying Bundesliga V1 thresholds or calibration to national teams',
    'odds, injuries, player data, rankings or any source not listed in data',
    'retroactive picks for any match that kicked off before activation',
  ],
};
