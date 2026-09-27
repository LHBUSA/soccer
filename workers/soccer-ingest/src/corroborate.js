// attribute_corroborated — owner decision 2026-09-27. NOT name matching.
//
// A provider player (ESPN athlete) may crosswalk onto an existing canonical player
// only when ALL are true:
//   1. normalized full name exact match;
//   2. date of birth exact match;
//   3. exactly ONE canonical candidate satisfies 1 + 2;
//   4. the provider and the canonical graph prove membership of the SAME club in an
//      OVERLAPPING season window. The canonical side is the candidate's own lineup
//      appearances (club + season); the provider side is ESPN's SEASON-SCOPED athlete
//      record for that same league/season (never the present-day club);
//   5. no contradictory DOB, club, provider-id, lineup or nationality evidence;
//   6. the evidence is persisted on the crosswalk row;
//   7. otherwise the athlete stays in soccer_identity_queue with the evidence.

import * as espn from '../../providers/espn.js';
import { normName, resolveMany } from './identity.js';
import { chunkArr } from './store.js';

export const RULE = 'attribute_corroborated/1.0.0';

// Store backends differ: PostgREST returns 'YYYY-MM-DD', PGlite a Date at UTC midnight.
export const isoDate = v => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

function normCountry(s, aliases) {
  const n = normName(s || '');
  return aliases[n] || n;
}

// Canonical club windows: { league, year, season_label, teams:Set, matches:n } from lineups.
export async function canonicalWindows(store, playerId, registry) {
  const lp = await store.select('soccer_lineup_players', { columns: ['lineup_id'], eq: { player_id: playerId } });
  if (!lp.length) return [];
  const lineups = [];
  for (const part of chunkArr(lp.map(x => x.lineup_id), store.inChunk || 150)) lineups.push(...await store.select('soccer_lineups', { columns: ['id', 'match_id', 'team_id'], in: { id: part } }));
  const matches = [];
  for (const part of chunkArr([...new Set(lineups.map(l => l.match_id))], store.inChunk || 150)) matches.push(...await store.select('soccer_matches', { columns: ['id', 'season_id', 'competition_id'], in: { id: part } }));
  const seasons = new Map((await store.select('soccer_seasons', { columns: ['id', 'label'], in: { id: [...new Set(matches.map(m => m.season_id))] } })).map(s => [s.id, s.label]));
  const comps = new Map((await store.select('soccer_competitions', { columns: ['id', 'slug'], in: { id: [...new Set(matches.map(m => m.competition_id))] } })).map(c => [c.id, c.slug]));
  const mById = new Map(matches.map(m => [m.id, m]));
  const windows = new Map();
  for (const l of lineups) {
    const m = mById.get(l.match_id);
    const label = seasons.get(m.season_id); const slug = comps.get(m.competition_id);
    const reg = registry.competitions.find(c => c.slug === slug);
    const year = Number(String(label).slice(0, 4));
    const key = `${slug}|${label}`;
    const w = windows.get(key) || { competition: slug, season_label: label, league: reg?.espn?.league || null, year, teams: new Set(), appearances: 0 };
    w.teams.add(l.team_id); w.appearances += 1;
    windows.set(key, w);
  }
  return [...windows.values()];
}

// Decide one athlete against its name+DOB candidates. Pure except for the
// budgeted ESPN season-athlete fetches (client.get) and store reads.
export async function corroborate(store, { athlete, candidates, client, registry, areas, currentMatchTeam = null }) {
  const evidence = { rule: RULE, espn_athlete: athlete.external_id, name: athlete.display_name, birth_date: athlete.birth_date, candidates: candidates.map(c => c.id), corroborating_windows: [], contradictions: [], unverifiable_windows: [] };
  if (candidates.length === 0) return { decision: 'queue', reason: 'no_candidate', evidence };
  if (candidates.length > 1) return { decision: 'queue', reason: 'multiple_canonical_candidates', evidence };
  const cand = candidates[0];
  evidence.canonical_player = cand.id;
  if (currentMatchTeam) evidence.current_club = currentMatchTeam.team_id; // recorded only; never used to prove a historical identity
  // 2. DOB exact (belt and braces: the candidate query already filtered on it)
  if (!athlete.birth_date || !cand.birth_date || isoDate(cand.birth_date) !== athlete.birth_date) {
    evidence.contradictions.push({ kind: 'dob', espn: athlete.birth_date, canonical: cand.birth_date });
    return { decision: 'queue', reason: 'dob_contradiction', evidence };
  }
  // 5a. provider-id contradiction: candidate already carries a different ESPN id
  const existing = await store.select('soccer_player_external_ids', { columns: ['external_id'], eq: { provider: 'espn', player_id: cand.id } });
  const otherIds = existing.map(e => e.external_id).filter(x => x !== athlete.external_id);
  if (otherIds.length) { evidence.contradictions.push({ kind: 'provider_id', other_espn_ids: otherIds }); }
  // 5b. nationality contradiction (only when both sides state one)
  const canonNat = cand.nationality_code ? areas.areas[cand.nationality_code] || null : null;
  if (canonNat && athlete.citizenship && normCountry(canonNat, areas.aliases) !== normCountry(athlete.citizenship, areas.aliases)) {
    evidence.contradictions.push({ kind: 'nationality', espn: athlete.citizenship, canonical: canonNat });
  }
  evidence.nationality = { espn: athlete.citizenship || null, canonical: canonNat, compared: !!(canonNat && athlete.citizenship) };
  // 4. overlapping club windows
  const windows = await canonicalWindows(store, cand.id, registry);
  evidence.canonical_windows = windows.map(w => ({ competition: w.competition, season: w.season_label, teams: [...w.teams], appearances: w.appearances }));
  for (const w of windows) {
    if (!w.league || !Number.isFinite(w.year)) { evidence.unverifiable_windows.push({ season: w.season_label, competition: w.competition, why: 'no_espn_league_for_competition' }); continue; }
    const { json } = await client.get(`${espn.CORE}/${w.league}/seasons/${w.year}/athletes/${athlete.external_id}`);
    const seasonDob = json.dateOfBirth ? String(json.dateOfBirth).slice(0, 10) : null;
    if (seasonDob && seasonDob !== athlete.birth_date) { evidence.contradictions.push({ kind: 'dob_season_record', season: w.season_label, espn: seasonDob }); continue; }
    const espnTeam = espn.refId(json.team?.$ref, 'teams');
    if (!espnTeam) { evidence.unverifiable_windows.push({ season: w.season_label, competition: w.competition, why: 'espn_has_no_club_for_athlete_that_season' }); continue; }
    const mapped = (await resolveMany(store, 'team', 'espn', [espnTeam])).get(espnTeam);
    if (!mapped) { evidence.unverifiable_windows.push({ season: w.season_label, competition: w.competition, why: 'espn_club_not_in_canonical_graph', espn_team: espnTeam }); continue; }
    if (w.teams.has(mapped)) evidence.corroborating_windows.push({ season: w.season_label, competition: w.competition, canonical_team: mapped, espn_team: espnTeam, canonical_appearances: w.appearances });
    else evidence.contradictions.push({ kind: 'club', season: w.season_label, competition: w.competition, espn_club_canonical: mapped, canonical_clubs: [...w.teams] });
  }
  // 5c. lineup contradiction: canonical player in a lineup of another team in the
  // very match where ESPN lists the athlete (only possible when both cover a match).
  if (currentMatchTeam) {
    const lps = await store.select('soccer_lineup_players', { columns: ['lineup_id'], eq: { player_id: cand.id } });
    if (lps.length) {
      const ls = await store.select('soccer_lineups', { columns: ['match_id', 'team_id'], in: { id: lps.map(x => x.lineup_id) }, eq: { match_id: currentMatchTeam.match_id } });
      if (ls.some(l => l.team_id !== currentMatchTeam.team_id)) evidence.contradictions.push({ kind: 'lineup', match_id: currentMatchTeam.match_id });
    }
  }
  if (evidence.contradictions.length) return { decision: 'queue', reason: `contradiction_${evidence.contradictions.map(c => c.kind).sort().join('_')}`, evidence };
  if (!evidence.corroborating_windows.length) return { decision: 'queue', reason: windows.length ? 'no_overlapping_club_corroboration' : 'no_canonical_club_window', evidence };
  return { decision: 'merge', reason: 'attribute_corroborated', evidence };
}
