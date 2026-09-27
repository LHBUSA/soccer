// Certification of the canonical soccer graph through the store primitives
// (PostgREST in production, PGlite locally). Reports EXPECTED vs OBSERVED with
// reasons; never forces a number to match.

import { chunkArr } from '../../workers/soccer-ingest/src/store.js';

export const TABLES = ['soccer_competitions', 'soccer_seasons', 'soccer_stages', 'soccer_teams', 'soccer_players', 'soccer_managers', 'soccer_venues',
  'soccer_matches', 'soccer_lineups', 'soccer_lineup_players', 'soccer_substitutions', 'soccer_match_events', 'soccer_team_match_stats', 'soccer_player_match_stats',
  'soccer_team_external_ids', 'soccer_player_external_ids', 'soccer_match_external_ids', 'soccer_match_source_results', 'soccer_source_captures', 'soccer_identity_queue', 'soccer_source_changes'];

// Expected values come from the local proof (docs/evidence/proof/bundesliga-2017-18.json).
export const EXPECTED = {
  wyscout_2017_matches: 306, wyscout_2017_events: 519407, wyscout_2017_players: 535, wyscout_2017_teams: 18,
  score_reconciliation: '306/306', cross_source_final: '306/306', cross_source_half_time: '304/306',
  scorer_alignment_crosswalks: 285, run2_writes: 0,
};

async function selectIn(store, table, col, vals, opts) {
  const out = [];
  for (const part of chunkArr(vals, store.inChunk || 500)) out.push(...await store.select(table, { ...opts, in: { ...(opts.in || {}), [col]: part } }));
  return out;
}

export async function certify(store, { run1 = null, run2 = null } = {}) {
  const counts = {};
  for (const t of TABLES) counts[t] = await store.count(t);
  const [bl] = await store.select('soccer_competitions', { columns: ['id', 'slug'], eq: { slug: 'bundesliga' }, limit: 1 });
  const seasons = bl ? await store.select('soccer_seasons', { columns: ['id', 'label'], eq: { competition_id: bl.id } }) : [];
  const perSeason = {};
  for (const s of seasons.sort((a, b) => (a.label < b.label ? -1 : 1))) {
    perSeason[s.label] = {
      matches: await store.count('soccer_matches', { eq: { season_id: s.id } }),
      league_stage: await (async () => { const st = await store.select('soccer_stages', { columns: ['id', 'stage_type'], eq: { season_id: s.id } }); const lg = st.filter(x => x.stage_type === 'league').map(x => x.id); return lg.length ? store.count('soccer_matches', { eq: { season_id: s.id }, in: { stage_id: lg } }) : 0; })(),
      finished: await store.count('soccer_matches', { eq: { season_id: s.id, status: 'finished' } }),
    };
  }
  // 2017/18 event-rich season
  const s17 = seasons.find(s => s.label === '2017/18');
  let recon = null; let xs = null; let wyEvents = null;
  if (s17) {
    const ms = await store.select('soccer_matches', { columns: ['id', 'home_team_id', 'away_team_id', 'home_score', 'away_score'], eq: { season_id: s17.id } });
    const ids = ms.map(m => m.id);
    const goals = [...await selectIn(store, 'soccer_match_events', 'match_id', ids, { columns: ['match_id', 'team_id'], eq: { source_family: 'wyscout_figshare', is_goal: true } }).then(r => r.map(x => ({ ...x, og: false }))),
      ...await selectIn(store, 'soccer_match_events', 'match_id', ids, { columns: ['match_id', 'team_id'], eq: { source_family: 'wyscout_figshare', is_own_goal: true } }).then(r => r.map(x => ({ ...x, og: true })))];
    const agree = ms.filter(m => {
      const g = goals.filter(x => x.match_id === m.id);
      const h = g.filter(x => (!x.og && x.team_id === m.home_team_id) || (x.og && x.team_id === m.away_team_id)).length;
      const a = g.filter(x => (!x.og && x.team_id === m.away_team_id) || (x.og && x.team_id === m.home_team_id)).length;
      return h === m.home_score && a === m.away_score;
    });
    recon = { matches: ms.length, agree: agree.length, mismatches: ms.length - agree.length };
    const sr = await selectIn(store, 'soccer_match_source_results', 'match_id', ids, { columns: ['match_id', 'provider', 'home_score', 'away_score', 'home_score_ht', 'away_score_ht'] });
    const by = new Map();
    for (const r of sr) by.set(r.match_id, { ...(by.get(r.match_id) || {}), [r.provider]: r });
    const pairs = [...by.values()].filter(v => v.wyscout && v.openligadb);
    xs = {
      compared: pairs.length,
      final_agree: pairs.filter(v => v.wyscout.home_score === v.openligadb.home_score && v.wyscout.away_score === v.openligadb.away_score).length,
      half_time_agree: pairs.filter(v => v.wyscout.home_score_ht === v.openligadb.home_score_ht && v.wyscout.away_score_ht === v.openligadb.away_score_ht).length,
      half_time_disagreements_preserved: pairs.filter(v => v.wyscout.home_score_ht !== v.openligadb.home_score_ht || v.wyscout.away_score_ht !== v.openligadb.away_score_ht).map(v => ({ match_id: v.wyscout.match_id, wyscout: `${v.wyscout.home_score_ht}-${v.wyscout.away_score_ht}`, openligadb: `${v.openligadb.home_score_ht}-${v.openligadb.away_score_ht}` })),
    };
    wyEvents = await store.count('soccer_match_events', { eq: { source_family: 'wyscout_figshare' } });
  }
  const xwMethods = {};
  for (const m of ['founding', 'fixture_graph', 'event_alignment', 'reviewed', 'exact_id']) {
    xwMethods[m] = {
      team: await store.count('soccer_team_external_ids', { eq: { method: m } }),
      player: await store.count('soccer_player_external_ids', { eq: { method: m } }),
      match: await store.count('soccer_match_external_ids', { eq: { method: m } }),
    };
  }
  const queue = await store.select('soccer_identity_queue', { columns: ['entity_type', 'provider', 'reason'], eq: { status: 'open' } });
  const queueBy = {};
  for (const q of queue) { const k = `${q.entity_type}/${q.provider}/${q.reason}`; queueBy[k] = (queueBy[k] || 0) + 1; }
  const run2Writes = run2 ? JSON.stringify(run2).match(/"(inserted|updated)":[1-9]\d*/g)?.length || 0 : null;
  const observed = {
    wyscout_2017_matches: perSeason['2017/18']?.matches ?? null,
    wyscout_2017_events: wyEvents,
    score_reconciliation: recon ? `${recon.agree}/${recon.matches}` : null,
    cross_source_final: xs ? `${xs.final_agree}/${xs.compared}` : null,
    cross_source_half_time: xs ? `${xs.half_time_agree}/${xs.compared}` : null,
    scorer_alignment_crosswalks: xwMethods.event_alignment.player,
    run2_writes: run2Writes,
  };
  const checks = Object.fromEntries(Object.keys(observed).map(k => [k, { expected: EXPECTED[k], observed: observed[k], match: String(EXPECTED[k]) === String(observed[k]) }]));
  return {
    counts, bundesliga_seasons: perSeason, reconciliation_2017: recon, cross_source_2017: xs, crosswalk_methods: xwMethods,
    identity_queue_open: { total: queue.length, by_reason: queueBy },
    duplicate_guards: 'unique(source_family, source_event_id), unique(match_id, source_family, sequence), unique(season, home, away, stage) enforced by schema',
    checks,
    verdict: { all_expected_match: Object.values(checks).every(c => c.match), mismatched: Object.entries(checks).filter(([, c]) => !c.match).map(([k]) => k) },
  };
}
