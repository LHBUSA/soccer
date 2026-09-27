// Provider: OpenLigaDB (api.openligadb.de). Community-maintained German football
// database. Data licence: Open Database License (ODbL) — stated on
// https://www.openligadb.de/ ("Die über diese API bereitgestellten Daten stehen
// unter der Open Database License (ODbL)").
//
// Obligations: attribute OpenLigaDB on surfaces that use it; a *derivative
// database* of OpenLigaDB data that we publicly use must itself be offered under
// ODbL (share-alike). Produced works (pages, articles) need attribution only.
// We keep OpenLigaDB-derived rows identifiable by provider so that obligation
// stays scoped. See docs/SOURCE_MATRIX.md.
//
// Stable ids: matchID, team.teamId, goal.goalID, goal.goalGetterID.

export const OPENLIGA_PARSER_VERSION = 'openligadb/1.1.0';
export const ATTRIBUTION = 'Fixtures/results: OpenLigaDB (openligadb.de), ODbL';

export function matchdataUrl(league, season) {
  if (!/^[a-z0-9]+$/.test(league) || !Number.isInteger(season)) throw new Error('bad league/season');
  return `https://api.openligadb.de/getmatchdata/${league}/${season}`;
}

export class ShapeDriftError extends Error {
  constructor(msg) { super(`openligadb shape drift: ${msg}`); this.name = 'ShapeDriftError'; }
}

const REQUIRED = ['matchID', 'matchDateTimeUTC', 'team1', 'team2', 'matchIsFinished', 'matchResults', 'goals', 'group'];

export function parseMatchdata(json) {
  if (!Array.isArray(json)) throw new ShapeDriftError('top level is not an array');
  return json.map(m => {
    for (const k of REQUIRED) if (!(k in m)) throw new ShapeDriftError(`match missing ${k}`);
    if (!m.team1?.teamId || !m.team2?.teamId) throw new ShapeDriftError(`match ${m.matchID} missing team ids`);
    const results = m.matchResults || [];
    // Final score: resultTypeID 2 in current seasons; older seasons (2004-07)
    // carry it as resultTypeID 0 named "Endergebnis".
    const final = results.find(r => r.resultTypeID === 2) || results.find(r => r.resultName === 'Endergebnis') || null;
    const half = results.find(r => r.resultTypeID === 1) || results.find(r => r.resultName === 'Halbzeit') || null;
    let prev1 = 0;
    let prev2 = 0;
    const goals = [...(m.goals || [])].sort((a, b) => (a.scoreTeam1 + a.scoreTeam2) - (b.scoreTeam1 + b.scoreTeam2) || a.goalID - b.goalID).map((g, i) => {
      // Scoring side from the running score, which every season carries;
      // scoringTeamId is only present in newer seasons.
      const side = g.scoreTeam1 > prev1 ? 'team1' : g.scoreTeam2 > prev2 ? 'team2' : null;
      prev1 = g.scoreTeam1; prev2 = g.scoreTeam2;
      return {
        external_id: String(g.goalID), order: i + 1, minute: Number.isFinite(g.matchMinute) ? g.matchMinute : null,
        // A row that does not advance the running score (e.g. "0-0" entries left
        // behind by disallowed goals) is not a goal and is never written as one.
        advances: side !== null,
        side, scorer_external_id: g.goalGetterID ? String(g.goalGetterID) : null, scorer_name: g.goalGetterName || null,
        is_penalty: !!g.isPenalty, is_own_goal: !!g.isOwnGoal, is_overtime: !!g.isOvertime,
        score1: g.scoreTeam1, score2: g.scoreTeam2, raw: g,
      };
    });
    return {
      provider: 'openligadb', external_id: String(m.matchID), league_id: m.leagueId, season: m.leagueSeason, league: m.leagueShortcut,
      matchday: m.group?.groupOrderID ?? null, kickoff_utc: m.matchDateTimeUTC ? new Date(m.matchDateTimeUTC).toISOString() : null,
      team1: { external_id: String(m.team1.teamId), name: m.team1.teamName, short_name: m.team1.shortName || null },
      team2: { external_id: String(m.team2.teamId), name: m.team2.teamName, short_name: m.team2.shortName || null },
      finished: !!m.matchIsFinished,
      score1: final ? final.pointsTeam1 : null, score2: final ? final.pointsTeam2 : null,
      score1_ht: half ? half.pointsTeam1 : null, score2_ht: half ? half.pointsTeam2 : null,
      goals, last_update: m.lastUpdateDateTime || null, raw: m,
    };
  });
}

// Team identity by FIXTURE GRAPH, never by name.
// canonical: [{ date:'YYYY-MM-DD', home, away }] (canonical team ids)
// provider:  [{ date, home, away }] (provider team ids)
// A provider team maps to canonical team T iff T is the only canonical team whose
// home fixtures cover every one of the provider team's home dates (±1 day for
// UTC/local boundaries). Then the whole mapping must reproduce every fixture.
export function proveTeamsByFixtureGraph(canonical, provider, { toleranceDays = 1 } = {}) {
  const dayMs = 86400000;
  const near = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) <= toleranceDays * dayMs;
  const canonTeams = [...new Set(canonical.flatMap(f => [f.home, f.away]))];
  const provTeams = [...new Set(provider.flatMap(f => [f.home, f.away]))];
  const candidates = new Map(provTeams.map(t => [t, new Set(canonTeams)]));
  for (const pf of provider) {
    const homesThatDay = new Set(canonical.filter(cf => near(cf.date, pf.date)).map(cf => cf.home));
    const awaysThatDay = new Set(canonical.filter(cf => near(cf.date, pf.date)).map(cf => cf.away));
    for (const c of [...candidates.get(pf.home)]) if (!homesThatDay.has(c)) candidates.get(pf.home).delete(c);
    for (const c of [...candidates.get(pf.away)]) if (!awaysThatDay.has(c)) candidates.get(pf.away).delete(c);
  }
  const mapping = new Map();
  const unresolved = [];
  for (const [t, set] of candidates) {
    if (set.size === 1) mapping.set(t, [...set][0]);
    else unresolved.push({ provider_team: t, candidates: [...set] });
  }
  const targets = [...mapping.values()];
  const collisions = targets.filter((v, i) => targets.indexOf(v) !== i);
  const key = f => `${f.home}|${f.away}`;
  const canonKeys = new Set(canonical.map(key));
  const unmatchedFixtures = provider.filter(pf => !(mapping.has(pf.home) && mapping.has(pf.away) && canonKeys.has(`${mapping.get(pf.home)}|${mapping.get(pf.away)}`)));
  const proven = unresolved.length === 0 && collisions.length === 0 && unmatchedFixtures.length === 0 && provider.length === canonical.length;
  return { proven, mapping, unresolved, collisions, unmatched_fixtures: unmatchedFixtures.length, provider_fixtures: provider.length, canonical_fixtures: canonical.length };
}
