// PLAYER DNA / TEAM DNA — deterministic descriptive profiles from the canonical graph.
// Time-safe: for as_of = D only matches that kicked off BEFORE D are used, so a DNA
// for a match on D never contains information from D or later. Descriptive, not
// predictive: nothing here is a forecast (see docs/RESEARCH.md for models).
// Percentiles compare against the same competition-season (teams: all; players: those
// with >= MIN_MINUTES nominal minutes). Minutes are NOMINAL (lineups + substitutions),
// never the source's playing time.
import { chunkArr } from '../../soccer-ingest/src/store.js';
import { ownGoalBeneficiary } from '../../shared/own-goals.js';

export const DNA_VERSION = 'soccer-dna/1.0.0';
export const MIN_MINUTES = 450;
const FAMILY = ['wyscout_figshare', 'espn', 'openligadb'];
const r2 = v => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const per = (a, b) => (b > 0 ? a / b : null);

// Percentile (0-100) of v among values; higher = better unless lowerIsBetter.
export function percentile(values, v, lowerIsBetter = false) {
  const xs = values.filter(x => x !== null && Number.isFinite(x));
  if (v === null || !Number.isFinite(v) || xs.length < 2) return null;
  const below = xs.filter(x => (lowerIsBetter ? x > v : x < v)).length;
  const equal = xs.filter(x => x === v).length;
  return Math.round((100 * (below + 0.5 * (equal - 1))) / (xs.length - 1));
}

async function selectIn(store, table, col, vals, opts) {
  const out = [];
  for (const p of chunkArr([...new Set(vals)], 100)) out.push(...await store.select(table, { ...opts, in: { ...(opts.in || {}), [col]: p } }));
  return out;
}

// All canonical data of one competition season before asOf (shared by team + player DNA).
export async function loadSeasonData(store, seasonId, asOf) {
  const cutoff = new Date(asOf).toISOString();
  const matches = (await store.select('soccer_matches', { columns: ['id', 'kickoff_at', 'home_team_id', 'away_team_id', 'home_score', 'away_score', 'status'], eq: { season_id: seasonId, status: 'finished' }, lte: { kickoff_at: cutoff }, order: 'kickoff_at.asc' }))
    .filter(m => m.home_score !== null && m.away_score !== null && Date.parse(m.kickoff_at) < Date.parse(cutoff));
  const ids = matches.map(m => m.id);
  const cols = ['match_id', 'sequence', 'team_id', 'player_id', 'event_type', 'subtype', 'outcome', 'is_goal', 'is_own_goal', 'card', 'source_family'];
  const [goals, own, cards, shots, assists, stats, lineups] = await Promise.all([
    selectIn(store, 'soccer_match_events', 'match_id', ids, { columns: cols, eq: { is_goal: true }, order: 'match_id.asc,sequence.asc' }),
    selectIn(store, 'soccer_match_events', 'match_id', ids, { columns: cols, eq: { is_own_goal: true }, order: 'match_id.asc,sequence.asc' }),
    selectIn(store, 'soccer_match_events', 'match_id', ids, { columns: cols, eq: { event_type: 'card' }, order: 'match_id.asc,sequence.asc' }),
    selectIn(store, 'soccer_match_events', 'match_id', ids, { columns: cols, eq: { event_type: 'shot' }, order: 'match_id.asc,sequence.asc' }),
    selectIn(store, 'soccer_match_events', 'match_id', ids, { columns: cols, in: { subtype: ['espn_assist', 'espn_assists_shot'] }, order: 'match_id.asc,sequence.asc' }),
    selectIn(store, 'soccer_team_match_stats', 'match_id', ids, { columns: ['match_id', 'team_id', 'stat_key', 'value', 'basis'], in: { stat_key: ['shots', 'shots_on_target', 'possession_pct', 'corners'] }, order: 'match_id.asc' }),
    selectIn(store, 'soccer_lineups', 'match_id', ids, { columns: ['id', 'match_id', 'team_id'], order: 'id.asc' }),
  ]);
  // One event family per match (richest first), so a goal reported twice counts once.
  const fam = new Map();
  for (const e of [...goals, ...own, ...shots]) { const f = fam.get(e.match_id); if (f === undefined || FAMILY.indexOf(e.source_family) < FAMILY.indexOf(f)) fam.set(e.match_id, e.source_family); }
  const pick = xs => xs.filter(e => fam.get(e.match_id) === e.source_family || !fam.has(e.match_id));
  return { matches, goals: pick(goals), own: pick(own), cards: pick(cards), shots: pick(shots), assists, stats, lineups, cutoff };
}

// ---------------- TEAM DNA ----------------
const TEAM_METRICS = [
  ['points_per_match', false], ['goals_for_per_match', false], ['goals_against_per_match', true], ['clean_sheet_rate', false], ['failed_to_score_rate', true],
  ['scored_first_rate', false], ['points_per_match_after_conceding_first', false], ['shots_per_match', false], ['shots_against_per_match', true],
  ['shots_on_target_per_match', false], ['shot_conversion', false], ['possession_avg', false], ['cards_per_match', true],
  ['home_points_per_match', false], ['away_points_per_match', false], ['last5_points_per_match', false],
];

export function teamProfiles(D) {
  const byTeam = new Map();
  const T = id => { if (!byTeam.has(id)) byTeam.set(id, { team_id: id, results: [], gf: 0, ga: 0, cs: 0, fts: 0, firstFor: 0, firstAgainst: 0, ptsAfterConceding: 0, conceded1st: 0, comebacks: 0, shots: 0, shotsAg: 0, sot: 0, sotAg: 0, statMatches: 0, poss: [], cards: 0, home: { m: 0, pts: 0 }, away: { m: 0, pts: 0 } }); return byTeam.get(id); };
  const goalsBy = new Map();
  for (const g of D.goals) goalsBy.set(g.match_id, [...(goalsBy.get(g.match_id) || []), { seq: g.sequence, team: g.team_id }]);
  for (const o of D.own) { const m = D.matches.find(x => x.id === o.match_id); if (!m) continue; goalsBy.set(o.match_id, [...(goalsBy.get(o.match_id) || []), { seq: o.sequence, team: ownGoalBeneficiary(o, m.home_team_id, m.away_team_id) }]); }
  const statBy = new Map();
  for (const s of D.stats) { const k = `${s.match_id}|${s.team_id}`; const cur = statBy.get(k) || {}; if (!(s.stat_key in cur) || s.basis === 'source') cur[s.stat_key] = Number(s.value); statBy.set(k, cur); }
  for (const c of D.cards) if (c.team_id) T(c.team_id).cards += c.card === 'red' ? 2 : 1;
  for (const m of D.matches) {
    const first = (goalsBy.get(m.id) || []).sort((a, b) => a.seq - b.seq)[0];
    for (const [tid, oid, gf, ga, venue] of [[m.home_team_id, m.away_team_id, m.home_score, m.away_score, 'home'], [m.away_team_id, m.home_team_id, m.away_score, m.home_score, 'away']]) {
      const t = T(tid); const pts = gf > ga ? 3 : gf === ga ? 1 : 0;
      t.results.push({ pts, r: pts === 3 ? 'W' : pts === 1 ? 'D' : 'L', kickoff: m.kickoff_at });
      t.gf += gf; t.ga += ga; if (ga === 0) t.cs += 1; if (gf === 0) t.fts += 1;
      t[venue].m += 1; t[venue].pts += pts;
      if (first) { if (first.team === tid) t.firstFor += 1; else { t.firstAgainst += 1; t.conceded1st += 1; t.ptsAfterConceding += pts; if (pts === 3) t.comebacks += 1; } }
      const s = statBy.get(`${m.id}|${tid}`); const so = statBy.get(`${m.id}|${oid}`);
      if (s && so && s.shots !== undefined && so.shots !== undefined) { t.statMatches += 1; t.shots += s.shots; t.shotsAg += so.shots; t.sot += s.shots_on_target || 0; t.sotAg += so.shots_on_target || 0; if (s.possession_pct !== undefined) t.poss.push(s.possession_pct); }
    }
  }
  const out = new Map();
  for (const t of byTeam.values()) {
    const n = t.results.length; const last5 = t.results.slice(-5);
    out.set(t.team_id, {
      team_id: t.team_id, matches: n,
      points_per_match: r2(per(t.results.reduce((a, x) => a + x.pts, 0), n)), goals_for_per_match: r2(per(t.gf, n)), goals_against_per_match: r2(per(t.ga, n)),
      clean_sheet_rate: r2(per(t.cs, n)), failed_to_score_rate: r2(per(t.fts, n)),
      scored_first_rate: r2(per(t.firstFor, t.firstFor + t.firstAgainst)), points_per_match_after_conceding_first: r2(per(t.ptsAfterConceding, t.conceded1st)), comeback_wins: t.comebacks, conceded_first: t.conceded1st,
      stats_matches: t.statMatches, shots_per_match: r2(per(t.shots, t.statMatches)), shots_against_per_match: r2(per(t.shotsAg, t.statMatches)),
      shots_on_target_per_match: r2(per(t.sot, t.statMatches)), shot_conversion: t.statMatches ? r2(per(t.gf, t.shots)) : null,
      possession_avg: t.poss.length ? r2(t.poss.reduce((a, x) => a + x, 0) / t.poss.length) : null,
      cards_per_match: r2(per(t.cards, n)),
      home_points_per_match: r2(per(t.home.pts, t.home.m)), away_points_per_match: r2(per(t.away.pts, t.away.m)),
      last5_points_per_match: r2(per(last5.reduce((a, x) => a + x.pts, 0), last5.length)), form: t.results.slice(-10).map(x => x.r).reverse(),
    });
  }
  return out;
}

export function withPercentiles(profiles, metrics, eligible = () => true) {
  const pool = [...profiles.values()].filter(eligible);
  for (const p of profiles.values()) {
    p.percentiles = {};
    for (const [k, lower] of metrics) p.percentiles[k] = eligible(p) ? percentile(pool.map(x => x[k]), p[k], lower) : null;
  }
  return profiles;
}

// ---------------- PLAYER DNA ----------------
const PLAYER_METRICS = [['start_rate', false], ['minutes_per_appearance', false], ['goals_per90', false], ['assists_per90', false], ['goal_contributions_per90', false], ['shots_per90', false], ['shots_on_target_rate', false], ['goals_per_shot', false], ['key_passes_per90', false], ['cards_per90', true]];

export async function playerProfiles(store, D) {
  const lps = await selectIn(store, 'soccer_lineup_players', 'lineup_id', D.lineups.map(l => l.id), { columns: ['lineup_id', 'player_id', 'is_starter'], order: 'lineup_id.asc,player_id.asc' });
  const ids = D.matches.map(m => m.id);
  const [subs, minutes] = await Promise.all([
    selectIn(store, 'soccer_substitutions', 'match_id', ids, { columns: ['match_id', 'player_in_id', 'player_out_id'], order: 'match_id.asc' }),
    selectIn(store, 'soccer_player_match_stats', 'match_id', ids, { columns: ['match_id', 'player_id', 'stat_key', 'value'], in: { stat_key: ['minutes_nominal', 'assists', 'key_passes'] }, eq: { basis: 'derived' }, order: 'match_id.asc' }),
  ]);
  const lu = new Map(D.lineups.map(l => [l.id, l]));
  const home = new Map(D.matches.map(m => [m.id, m.home_team_id]));
  const on = new Set(subs.map(s => `${s.match_id}|${s.player_in_id}`)); const off = new Set(subs.map(s => `${s.match_id}|${s.player_out_id}`));
  const mins = new Map(); const dAssist = new Map(); const dKey = new Map();
  for (const x of minutes) { const k = `${x.match_id}|${x.player_id}`; if (x.stat_key === 'minutes_nominal') mins.set(k, Number(x.value)); if (x.stat_key === 'assists') dAssist.set(k, Number(x.value)); if (x.stat_key === 'key_passes') dKey.set(k, Number(x.value)); }
  const P = new Map();
  const get = pid => { if (!P.has(pid)) P.set(pid, { player_id: pid, apps: 0, starts: 0, sub_on: 0, subbed_off: 0, minutes: 0, goals: 0, assists: 0, shots: 0, sot: 0, key_passes: 0, cards: 0, home_apps: 0, away_apps: 0, home_goals: 0, away_goals: 0, log: [] }); return P.get(pid); };
  for (const x of lps) {
    const l = lu.get(x.lineup_id); const k = `${l.match_id}|${x.player_id}`;
    const appeared = x.is_starter || on.has(k); if (!appeared) continue;
    const p = get(x.player_id); p.apps += 1; if (x.is_starter) p.starts += 1; if (on.has(k)) p.sub_on += 1; if (off.has(k)) p.subbed_off += 1;
    p.minutes += mins.get(k) || 0; p.assists += dAssist.get(k) || 0; p.key_passes += dKey.get(k) || 0;
    const isHome = home.get(l.match_id) === l.team_id; if (isHome) p.home_apps += 1; else p.away_apps += 1;
    p.log.push({ match_id: l.match_id, home: isHome });
  }
  const bump = (pid, mid, k) => { if (!P.has(pid)) return; const p = P.get(pid); p[k] += 1; if (k === 'goals') { const m = p.log.find(x => x.match_id === mid); if (m) { if (m.home) p.home_goals += 1; else p.away_goals += 1; m.goals = (m.goals || 0) + 1; } } if (k === 'shots') { const m = p.log.find(x => x.match_id === mid); if (m) m.shots = (m.shots || 0) + 1; } };
  for (const g of D.goals) if (g.player_id) bump(g.player_id, g.match_id, 'goals');
  for (const s of D.shots) if (s.player_id) { bump(s.player_id, s.match_id, 'shots'); if (s.outcome === 'goal' || s.outcome === 'on_target') bump(s.player_id, s.match_id, 'sot'); }
  for (const a of D.assists) if (a.player_id) bump(a.player_id, a.match_id, a.subtype === 'espn_assist' ? 'assists' : 'key_passes');
  for (const c of D.cards) if (c.player_id && P.has(c.player_id)) P.get(c.player_id).cards += c.card === 'red' ? 2 : 1;
  const out = new Map();
  for (const p of P.values()) {
    const n90 = p.minutes / 90;
    const last5 = p.log.slice(-5);
    out.set(p.player_id, {
      player_id: p.player_id, appearances: p.apps, starts: p.starts, start_rate: r2(per(p.starts, p.apps)), sub_appearances: p.sub_on, subbed_off: p.subbed_off,
      minutes_nominal: p.minutes, minutes_per_appearance: r2(per(p.minutes, p.apps)),
      goals: p.goals, assists: p.assists, shots: p.shots, shots_on_target: p.sot, key_passes: p.key_passes, cards: p.cards,
      goals_per90: r2(per(p.goals, n90)), assists_per90: r2(per(p.assists, n90)), goal_contributions_per90: r2(per(p.goals + p.assists, n90)), shots_per90: r2(per(p.shots, n90)),
      shots_on_target_rate: r2(per(p.sot, p.shots)), goals_per_shot: r2(per(p.goals, p.shots)), key_passes_per90: r2(per(p.key_passes, n90)), cards_per90: r2(per(p.cards, n90)),
      splits: { home: { appearances: p.home_apps, goals: p.home_goals }, away: { appearances: p.away_apps, goals: p.away_goals } },
      last5: { appearances: last5.length, goals: last5.reduce((a, x) => a + (x.goals || 0), 0), shots: last5.reduce((a, x) => a + (x.shots || 0), 0) },
    });
  }
  return withPercentiles(out, PLAYER_METRICS, x => x.minutes_nominal >= MIN_MINUTES);
}

export const TEAM_DNA_METRICS = TEAM_METRICS;
export const PLAYER_DNA_METRICS = PLAYER_METRICS;
export function teamDna(D) { return withPercentiles(teamProfiles(D), TEAM_METRICS); }
