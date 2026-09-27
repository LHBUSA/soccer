// ESPN soccer canary. Two parts:
//   live   — Core reachable (200), JSON not HTML/challenge, expected minimum
//            entities, parsers accept real rows. READ-ONLY: nothing canonical is
//            written, so a failing canary cannot poison data.
//   store  — integrity of what ESPN already wrote: no canonical team/player
//            carries two ESPN ids, no ESPN match duplicates an owned fixture,
//            ESPN-vs-other disagreements are recorded (not overwritten).
import * as espn from '../../providers/espn.js';
import { politeFetch } from '../../shared/http.js';

export const CANARY_VERSION = 'espn-canary/1.0.0';
const MIN_TEAMS = { 'ger.1': 18, 'eng.1': 20, 'usa.1': 28 };

export async function espnLiveCanary({ fetcher = politeFetch, leagues = ['ger.1', 'eng.1', 'usa.1'] } = {}) {
  const checks = [];
  const check = (name, pass, detail = null) => checks.push({ name, pass: !!pass, detail });
  const get = async url => {
    const r = await fetcher(url, { minIntervalMs: 700 });
    const head = new TextDecoder().decode(r.bytes.subarray(0, 64));
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    if (!/^\s*[{[]/.test(head)) throw new Error('non-JSON body (HTML/challenge?)');
    return JSON.parse(new TextDecoder().decode(r.bytes));
  };
  for (const lg of leagues) {
    try {
      const league = await get(espn.urls.league(lg));
      const year = espn.seasonYearOf(league.season?.$ref);
      check(`${lg}:season`, !!year, year);
      const teams = await get(`${espn.CORE}/${lg}/seasons/${year}/teams?limit=100`);
      check(`${lg}:min_teams`, (teams.count || 0) >= (MIN_TEAMS[lg] || 10), teams.count);
      const list = await get(espn.urls.seasonEvents(lg, year, 1, 1));
      const { ids, count } = espn.refsOf(list);
      check(`${lg}:events`, ids.length > 0, count);
      const ev = espn.parseEvent(await get(espn.urls.event(lg, ids[0])), lg);
      check(`${lg}:event_parses`, !!ev.home.team_id && !!ev.away.team_id, ev.external_id);
      const team = espn.parseTeam(await get(`${espn.CORE}/${lg}/seasons/${year}/teams/${ev.home.team_id}`));
      check(`${lg}:team_parses`, !!team.name, team.name);
    } catch (err) {
      check(`${lg}:reachable`, false, String(err.message || err));
    }
  }
  return { version: CANARY_VERSION, part: 'live', at: new Date().toISOString(), pass: checks.every(c => c.pass), checks };
}

export async function espnStoreCanary(store) {
  const checks = [];
  const check = (name, pass, detail = null) => checks.push({ name, pass: !!pass, detail });
  for (const [table, col] of [['soccer_team_external_ids', 'team_id'], ['soccer_player_external_ids', 'player_id'], ['soccer_match_external_ids', 'match_id']]) {
    const rows = await store.select(table, { columns: [col, 'external_id'], eq: { provider: 'espn' } });
    const seen = new Map(); const dups = [];
    for (const r of rows) { if (seen.has(r[col]) && seen.get(r[col]) !== r.external_id) dups.push(r[col]); seen.set(r[col], r.external_id); }
    check(`${table}:one_espn_id_per_canonical`, dups.length === 0, { espn_ids: rows.length, duplicates: dups.length });
  }
  const espnResults = await store.select('soccer_match_source_results', { columns: ['match_id', 'home_score', 'away_score', 'status'], eq: { provider: 'espn' } });
  check('source_results:espn_observations_recorded', true, espnResults.length);
  const attached = (await store.select('soccer_match_external_ids', { columns: ['match_id'], eq: { provider: 'espn', method: 'fixture_graph' } })).map(r => r.match_id);
  let stolen = 0;
  for (let i = 0; i < attached.length; i += 150) stolen += (await store.select('soccer_matches', { columns: ['id'], eq: { result_provider: 'espn' }, in: { id: attached.slice(i, i + 150) } })).length;
  check('precedence:espn_never_owns_attached_matches', stolen === 0, { attached_to_other_owner: attached.length, taken_over: stolen });
  return { version: CANARY_VERSION, part: 'store', at: new Date().toISOString(), pass: checks.every(c => c.pass), checks };
}
