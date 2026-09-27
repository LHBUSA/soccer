// ESPN -> canonical graph (SECONDARY source). Precedence rules:
//   * ESPN never overwrites a match owned by another provider (result_provider):
//     it attaches its external id and records its own observation in
//     soccer_match_source_results; contradictions stay visible there.
//   * ESPN founds entities only where no other source has them (competitions
//     without an owned fixture graph, athletes with full name + DOB). An athlete
//     whose normalized name AND birth date match an existing canonical player is
//     QUEUED, never merged or duplicated.
//   * Lineups/substitutions are written only where no other provider supplied them.
//   * Plays become ledger events (source_family 'espn') only for matches without
//     a richer ledger (Wyscout).
// Every row carries provider/source_family 'espn' and a capture_id.

import * as espn from '../../providers/espn.js';
import { proveTeamsByFixtureSubset } from '../../shared/fixture-graph.js';
import { childId, mintId, payloadHash } from '../../shared/ids.js';
import { footballMinute } from '../../shared/clock.js';
import { allocateSlugs, normName, queueIdentity, resolveMany, resolveQueued } from './identity.js';
import { chunkArr, syncRows } from './store.js';
import { deriveMatchStats } from './derive.js';
import { minuteClose } from './openligadb-lane.js';
import { RULE, corroborate } from './corroborate.js';

const P = 'espn';
const dateOf = ts => new Date(ts).toISOString().slice(0, 10);
const competitionId = comp => { const f = comp.external_ids.find(x => x.method === 'founding'); return mintId('competition', f.provider, f.external_id); };

async function selectIn(store, table, col, values, opts = {}) {
  const out = [];
  for (const part of chunkArr([...new Set(values)], store.inChunk || 500)) out.push(...await store.select(table, { ...opts, in: { ...(opts.in || {}), [col]: part } }));
  return out;
}

export async function ensureCompetitionSeason(store, { comp, year }) {
  const compId = competitionId(comp);
  if (!(await store.select('soccer_competitions', { columns: ['id'], eq: { id: compId }, limit: 1 })).length) {
    await syncRows(store, { table: 'soccer_competitions', key: ['id'], rows: [{ id: compId, slug: comp.slug, name: comp.name, comp_type: comp.comp_type, gender: comp.gender, country_code: comp.country_code, tier: comp.tier }] });
  }
  await syncRows(store, { table: 'soccer_competition_external_ids', key: ['provider', 'external_id'], compare: ['competition_id'], rows: comp.external_ids.map(x => ({ provider: x.provider, external_id: x.external_id, competition_id: compId, method: x.method, evidence: x.evidence, capture_id: null })) });
  const sExt = `${comp.espn.league}:${year}`;
  let seasonId = (await resolveMany(store, 'season', P, [sExt])).get(sExt);
  if (!seasonId) {
    const label = espn.seasonLabel(year, comp.season_format);
    const rows = await store.select('soccer_seasons', { columns: ['id'], eq: { competition_id: compId, label }, limit: 1 });
    seasonId = rows[0]?.id || mintId('season', P, sExt);
    if (!rows.length) await syncRows(store, { table: 'soccer_seasons', key: ['id'], rows: [{ id: seasonId, competition_id: compId, label, start_date: null, end_date: null }] });
    await syncRows(store, { table: 'soccer_season_external_ids', key: ['provider', 'external_id'], compare: ['season_id'], rows: [{ provider: P, external_id: sExt, season_id: seasonId, method: rows.length ? 'reviewed' : 'founding', evidence: `competition ${comp.slug} season label ${label}`, capture_id: null }] });
  }
  const stageId = childId('stage', seasonId, comp.comp_type === 'league' ? 'regular-season' : 'espn-all');
  await syncRows(store, { table: 'soccer_stages', key: ['id'], rows: [{ id: stageId, season_id: seasonId, name: comp.comp_type === 'league' ? 'Regular Season' : 'All rounds (ESPN)', stage_type: comp.comp_type === 'league' ? 'league' : 'group', stage_order: 1 }] });
  return { compId, seasonId, stageId };
}

// Team identity for the season's ESPN fixtures.
export async function resolveEspnTeams(store, { comp, year, cursor, client }) {
  const { seasonId } = await ensureCompetitionSeason(store, { comp, year });
  const fixtures = Object.entries(cursor.fixtures).map(([id, f]) => ({ id, date: f.d.slice(0, 10), home: f.h, away: f.a }));
  const espnTeams = [...new Set(fixtures.flatMap(f => [f.home, f.away]))];
  const teamMap = await resolveMany(store, 'team', P, espnTeams);
  const summary = { espn_teams: espnTeams.length, resolved_before: teamMap.size };
  const pending = espnTeams.filter(t => !teamMap.has(t));
  if (!pending.length) return { teamMap, summary };
  const canon = (await store.select('soccer_matches', { columns: ['id', 'kickoff_at', 'home_team_id', 'away_team_id', 'result_provider'], eq: { season_id: seasonId } })).filter(m => m.result_provider !== P);
  const xw = [];
  if (canon.length) {
    // Another provider owns this season's fixture graph: prove, never found.
    const proof = proveTeamsByFixtureSubset(canon.map(m => ({ date: dateOf(m.kickoff_at), home: m.home_team_id, away: m.away_team_id })), fixtures.map(f => ({ date: f.date, home: f.home, away: f.away })));
    summary.fixture_subset_proof = { valid: proof.valid, mapped: proof.mapping.size, unresolved: proof.unresolved.length, thin: proof.thin.length, collisions: proof.collisions.length, unmatched: proof.unmatched };
    for (const [t, ct] of proof.mapping) {
      if (teamMap.has(t)) continue;
      const clash = [...teamMap.entries()].find(([, v]) => v === ct);
      if (clash) { await queueIdentity(store, { entity_type: 'team', provider: P, external_id: t, reason: 'fixture_proof_target_already_mapped', candidate_ids: [ct] }); continue; }
      teamMap.set(t, ct);
      xw.push({ provider: P, external_id: t, team_id: ct, method: 'fixture_graph', evidence: `espn ${comp.espn.league} ${year}: ${proof.provider_fixtures} fixtures, subset proof (>=3 appearances, injective, all fixtures reproduced)`, capture_id: null });
    }
    for (const u of proof.unresolved) await queueIdentity(store, { entity_type: 'team', provider: P, external_id: u.provider_team, reason: 'fixture_subset_ambiguous', candidate_ids: u.candidates });
  } else if (comp.espn?.may_found === false) {
    // Another provider owns this competition's fixture graph but has not written
    // this season yet: wait. ESPN never founds here (owner precedence rule).
    summary.waiting_for_owner_fixture_graph = true;
    return { teamMap, summary };
  } else {
    // No other source for this season: ESPN founds teams from their stable ids.
    const existing = await store.select('soccer_teams', { columns: ['id', 'name', 'official_name', 'short_name'] });
    const byName = new Map();
    for (const e of existing) for (const n of [e.name, e.official_name]) if (n) byName.set(normName(n), [...(byName.get(normName(n)) || []), e.id]);
    const found = [];
    for (const t of pending.sort((a, b) => Number(a) - Number(b))) {
      const { json, capture } = await client.get(`${espn.CORE}/${comp.espn.league}/seasons/${year}/teams/${t}`);
      const team = espn.parseTeam(json);
      const clash = byName.get(normName(team.name));
      if (clash) { await client.flush(); await queueIdentity(store, { entity_type: 'team', provider: P, external_id: t, reason: 'same_normalized_name_as_existing_team', candidate_ids: clash, payload: { name: team.name } }); continue; }
      byName.set(normName(team.name), [mintId('team', P, t)]);
      found.push({ ...team, capture_id: capture.capture_id });
    }
    await client.flush();
    const slugs = allocateSlugs(found.map(s => ({ id: mintId('team', P, s.external_id), name: s.name })), found.length ? (await store.select('soccer_teams', { columns: ['slug'] })).map(r => r.slug) : []);
    await syncRows(store, { table: 'soccer_teams', key: ['id'], rows: found.map(s => ({ id: mintId('team', P, s.external_id), slug: slugs.get(mintId('team', P, s.external_id)), name: s.name, short_name: s.short_name, official_name: null, team_type: s.is_national ? 'national' : 'club', gender: 'men', country_code: null, city: s.location, founding_provider: P, founding_external_id: s.external_id })) });
    for (const s of found) { teamMap.set(s.external_id, mintId('team', P, s.external_id)); xw.push({ provider: P, external_id: s.external_id, team_id: mintId('team', P, s.external_id), method: 'founding', evidence: `espn team id${s.sdr ? `; sdr ${s.sdr}` : ''}`, capture_id: s.capture_id }); }
    summary.teams_founded = found.length;
  }
  summary.team_crosswalk = await syncRows(store, { table: 'soccer_team_external_ids', key: ['provider', 'external_id'], compare: ['team_id'], rows: xw });
  // An earlier, thinner run may have queued a team as ambiguous; close it now that it is proven.
  for (const x of xw) await resolveQueued(store, { entity_type: 'team', provider: P, external_id: x.external_id, resolution: { method: x.method, team_id: x.team_id } });
  summary.resolved_after = teamMap.size;
  return { teamMap, summary };
}

// Fixtures -> canonical matches. Attach to an existing canonical match (same
// season, same home/away) instead of creating a duplicate; found only when none.
export async function upsertEspnFixtures(store, { comp, year, cursor, teamMap, now = Date.now() }) {
  const { compId, seasonId, stageId } = await ensureCompetitionSeason(store, { comp, year });
  const ids = Object.keys(cursor.fixtures).filter(id => teamMap.has(cursor.fixtures[id].h) && teamMap.has(cursor.fixtures[id].a));
  const known = await resolveMany(store, 'match', P, ids);
  const canon = await store.select('soccer_matches', { columns: ['id', 'home_team_id', 'away_team_id', 'result_provider'], eq: { season_id: seasonId } });
  const byPair = new Map(canon.map(m => [`${m.home_team_id}|${m.away_team_id}`, m]));
  const venueIds = [...new Set(ids.map(id => cursor.fixtures[id].v?.external_id).filter(Boolean))];
  const venueMap = await resolveMany(store, 'venue', P, venueIds);
  const newVenues = [];
  for (const id of ids) { const v = cursor.fixtures[id].v; if (v?.external_id && v.name && !venueMap.has(v.external_id) && !newVenues.some(x => x.external_id === v.external_id)) newVenues.push(v); }
  if (newVenues.length) {
    const slugs = allocateSlugs(newVenues.map(v => ({ id: mintId('venue', P, v.external_id), name: v.name })), (await store.select('soccer_venues', { columns: ['slug'] })).map(r => r.slug));
    await syncRows(store, { table: 'soccer_venues', key: ['id'], rows: newVenues.map(v => ({ id: mintId('venue', P, v.external_id), slug: slugs.get(mintId('venue', P, v.external_id)), name: v.name, city: v.city })) });
    await syncRows(store, { table: 'soccer_venue_external_ids', key: ['provider', 'external_id'], compare: ['venue_id'], rows: newVenues.map(v => ({ provider: P, external_id: v.external_id, venue_id: mintId('venue', P, v.external_id), method: 'founding', evidence: 'espn venue id', capture_id: null })) });
    for (const v of newVenues) venueMap.set(v.external_id, mintId('venue', P, v.external_id));
  }
  const inserts = []; const xw = []; let attached = 0; let founded = 0; let pairConflicts = 0;
  for (const id of ids) {
    const f = cursor.fixtures[id];
    const home = teamMap.get(f.h); const away = teamMap.get(f.a);
    if (known.has(id)) continue;
    const existing = byPair.get(`${home}|${away}`);
    if (existing) {
      attached += 1;
      xw.push({ provider: P, external_id: id, match_id: existing.id, method: existing.result_provider === P ? 'founding' : 'fixture_graph', evidence: `espn event ${id} = canonical fixture (season, home, away)`, capture_id: f.cap });
      continue;
    }
    if (comp.comp_type !== 'league' && canon.some(m => m.home_team_id === home && m.away_team_id === away)) { pairConflicts += 1; continue; }
    const mid = mintId('match', P, id);
    founded += 1;
    byPair.set(`${home}|${away}`, { id: mid, result_provider: P });
    inserts.push({ id: mid, competition_id: compId, season_id: seasonId, stage_id: stageId, matchday: null, round_label: null, kickoff_at: f.d, venue_id: f.v?.external_id ? venueMap.get(f.v.external_id) || null : null, home_team_id: home, away_team_id: away, status: Date.parse(f.d) > now ? 'scheduled' : 'unknown', home_score: null, away_score: null, home_score_ht: null, away_score_ht: null, home_score_et: null, away_score_et: null, home_pens: null, away_pens: null, duration: null, winner_team_id: null, result_provider: P });
    xw.push({ provider: P, external_id: id, match_id: mid, method: 'founding', evidence: `espn event ${id}`, capture_id: f.cap });
  }
  // A cup/tournament can legitimately repeat a pairing (two legs are home/away
  // swapped; a true repeat needs a stage we do not have): skipped, counted.
  const written = await syncRows(store, { table: 'soccer_matches', key: ['id'], rows: inserts, provider: P });
  const crosswalk = await syncRows(store, { table: 'soccer_match_external_ids', key: ['provider', 'external_id'], compare: ['match_id'], rows: xw });
  return { considered: ids.length, attached_to_existing: attached, founded, repeated_pairs_skipped: pairConflicts, written, crosswalk };
}

export async function resolveAthletes(store, { athleteIds, client, league, year, registry, areas, teamOf = new Map() }) {
  const map = await resolveMany(store, 'player', P, athleteIds);
  const queued = []; const found = []; const corroborated = [];
  for (const aid of athleteIds.filter(a => !map.has(a))) {
    const [q] = await store.select('soccer_identity_queue', { columns: ['status'], eq: { entity_type: 'player', provider: P, external_id: aid }, limit: 1 });
    if (q) { queued.push(aid); continue; } // already queued: do not refetch
    const { json, capture } = await client.get(`${espn.CORE}/${league}/seasons/${year}/athletes/${aid}`);
    const a = espn.parseAthlete(json);
    const fullName = [a.first_name, a.last_name].filter(Boolean).join(' ') || a.display_name;
    if (!a.birth_date || !fullName) { await client.flush(); await queueIdentity(store, { entity_type: 'player', provider: P, external_id: aid, reason: 'athlete_without_dob_or_name', payload: { name: a.display_name } }); queued.push(aid); continue; }
    const hits = await nameDobCandidates(store, a);
    if (hits.length) {
      // Never a name merge: the attribute_corroborated rule decides, else queue.
      const r = await corroborate(store, { athlete: a, candidates: hits, client, registry, areas, currentMatchTeam: teamOf.get(aid) || null });
      await client.flush();
      if (r.decision === 'merge') { corroborated.push({ aid, player_id: hits[0].id, evidence: r.evidence, capture_id: capture.capture_id }); map.set(aid, hits[0].id); continue; }
      await queueIdentity(store, { entity_type: 'player', provider: P, external_id: aid, reason: r.reason, candidate_ids: hits.map(h => h.id), payload: { name: a.display_name, birth_date: a.birth_date, evidence: r.evidence } });
      queued.push(aid); continue;
    }
    found.push({ ...a, capture_id: capture.capture_id });
  }
  await client.flush();
  if (found.length) {
    const slugs = allocateSlugs(found.map(a => ({ id: mintId('player', P, a.external_id), name: a.display_name, year: a.birth_date.slice(0, 4) })), (await store.select('soccer_players', { columns: ['slug'] })).map(r => r.slug));
    await syncRows(store, { table: 'soccer_players', key: ['id'], rows: found.map(a => ({
      id: mintId('player', P, a.external_id), slug: slugs.get(mintId('player', P, a.external_id)), display_name: a.display_name, short_name: a.short_name, first_name: a.first_name, middle_name: a.middle_name, last_name: a.last_name,
      birth_date: a.birth_date, birth_country_code: null, nationality_code: null, foot: null,
      height_cm: a.height_cm && a.height_cm >= 140 && a.height_cm <= 220 ? a.height_cm : null, weight_kg: a.weight_kg && a.weight_kg >= 40 && a.weight_kg <= 130 ? a.weight_kg : null,
      primary_role: a.primary_role, founding_provider: P, founding_external_id: a.external_id })) });
    await syncRows(store, { table: 'soccer_player_external_ids', key: ['provider', 'external_id'], compare: ['player_id'], rows: found.map(a => ({ provider: P, external_id: a.external_id, player_id: mintId('player', P, a.external_id), method: 'founding', evidence: `espn athlete id; dob ${a.birth_date}`, capture_id: a.capture_id })) });
    for (const a of found) map.set(a.external_id, mintId('player', P, a.external_id));
  }
  if (corroborated.length) {
    await syncRows(store, { table: 'soccer_player_external_ids', key: ['provider', 'external_id'], compare: ['player_id'], rows: corroborated.map(c => ({ provider: P, external_id: c.aid, player_id: c.player_id, method: 'attribute_corroborated', evidence: JSON.stringify(c.evidence), capture_id: c.capture_id })) });
    for (const c of corroborated) await resolveQueued(store, { entity_type: 'player', provider: P, external_id: c.aid, resolution: { method: 'attribute_corroborated', rule: RULE, player_id: c.player_id } });
  }
  return { map, queued: queued.length, founded: found.length, corroborated: corroborated.length };
}

// Exact normalized full name + exact DOB (the only candidate filter; never a merge by itself).
export async function nameDobCandidates(store, a) {
  const fullName = [a.first_name, a.last_name].filter(Boolean).join(' ') || a.display_name;
  const sameDob = await store.select('soccer_players', { columns: ['id', 'display_name', 'first_name', 'last_name', 'birth_date', 'nationality_code', 'status'], eq: { birth_date: a.birth_date, status: 'active' } });
  return sameDob.filter(p => normName([p.first_name, p.last_name].filter(Boolean).join(' ') || p.display_name) === normName(fullName) || normName(p.display_name) === normName(a.display_name));
}

// Re-evaluate ESPN athletes queued for a name+DOB match (e.g. before the rule
// existed) under attribute_corroborated. Budgeted; untouched entries stay queued.
export async function reevaluateQueuedEspnAthletes(store, { client, registry, areas, league, year, reasons = ['dob_and_name_match_existing_player', 'no_overlapping_club_corroboration'] }) {
  const out = { evaluated: 0, merged: 0, still_queued: 0, by_reason: {} };
  const rows = [];
  for (const reason of reasons) rows.push(...await store.select('soccer_identity_queue', { columns: ['external_id', 'reason', 'payload'], eq: { entity_type: 'player', provider: P, status: 'open', reason } }));
  for (const q of rows) {
    const { json, capture } = await client.get(`${espn.CORE}/${league}/seasons/${year}/athletes/${q.external_id}`);
    const a = espn.parseAthlete(json);
    const hits = a.birth_date ? await nameDobCandidates(store, a) : [];
    const r = await corroborate(store, { athlete: a, candidates: hits, client, registry, areas });
    await client.flush();
    out.evaluated += 1; out.by_reason[r.reason] = (out.by_reason[r.reason] || 0) + 1;
    if (r.decision === 'merge') {
      await syncRows(store, { table: 'soccer_player_external_ids', key: ['provider', 'external_id'], compare: ['player_id'], rows: [{ provider: P, external_id: q.external_id, player_id: hits[0].id, method: 'attribute_corroborated', evidence: JSON.stringify(r.evidence), capture_id: capture.capture_id }] });
      await resolveQueued(store, { entity_type: 'player', provider: P, external_id: q.external_id, resolution: { method: 'attribute_corroborated', rule: RULE, player_id: hits[0].id } });
      out.merged += 1;
    } else {
      await store.upsert('soccer_identity_queue', [{ entity_type: 'player', provider: P, external_id: q.external_id, reason: q.reason, candidate_ids: hits.map(h => h.id), payload: { ...(q.payload || {}), reevaluated: { rule: RULE, reason: r.reason, evidence: r.evidence } }, status: 'open' }], ['entity_type', 'provider', 'external_id']);
      out.still_queued += 1;
    }
  }
  return out;
}

export async function ingestEspnMatch(store, { comp, league, year, eventId, fixture, teamMap, client, now = Date.now() }) {
  const base = `${espn.CORE}/${league}/events/${eventId}/competitions/${eventId}`;
  const summary = { event: eventId };
  let changed = 0;
  const count = s => { changed += (s?.inserted || 0) + (s?.updated || 0); return s; };
  const [xw] = await store.select('soccer_match_external_ids', { columns: ['match_id'], eq: { provider: P, external_id: eventId }, limit: 1 });
  if (!xw) return { final: false, changed, summary: { ...summary, skipped: 'no canonical match yet' } };
  const matchId = xw.match_id;
  const [match] = await store.select('soccer_matches', { columns: ['id', 'competition_id', 'season_id', 'stage_id', 'matchday', 'round_label', 'venue_id', 'home_team_id', 'away_team_id', 'result_provider'], eq: { id: matchId }, limit: 1 });
  const { json: stJson, capture: stCap } = await client.get(`${base}/status`);
  const status = espn.parseStatus(stJson);
  summary.status = status;
  if (status === 'scheduled' || status === 'live' || status === 'unknown') { await client.flush(); return { final: false, changed, summary }; }
  const scores = {};
  if (status === 'finished') for (const side of ['h', 'a']) { const { json } = await client.get(`${base}/competitors/${fixture[side]}/score`); scores[side] = Number.isFinite(Number(json.value)) ? Number(json.value) : null; }
  await client.flush();
  const home = teamMap.get(fixture.h); const away = teamMap.get(fixture.a);
  const owned = match.result_provider === P;
  if (owned) {
    count(await syncRows(store, { table: 'soccer_matches', key: ['id'], provider: P, captureId: stCap.capture_id, touch: true, rows: [{ ...match, kickoff_at: fixture.d, status, home_score: scores.h ?? null, away_score: scores.a ?? null, home_score_ht: null, away_score_ht: null, home_score_et: null, away_score_et: null, home_pens: null, away_pens: null, duration: status === 'finished' ? 'regular' : null, winner_team_id: status === 'finished' && scores.h !== scores.a ? (scores.h > scores.a ? home : away) : null, result_provider: P }] }));
  }
  count(await syncRows(store, { table: 'soccer_match_source_results', key: ['match_id', 'provider'], compare: ['status', 'home_score', 'away_score'], provider: P, captureId: stCap.capture_id, rows: [{ match_id: matchId, provider: P, status, home_score: scores.h ?? null, away_score: scores.a ?? null, home_score_ht: null, away_score_ht: null, capture_id: stCap.capture_id, observed_at: stCap.captured_at }] }));
  if (status !== 'finished') return { final: true, changed, summary };

  // Rosters -> athletes, lineups, substitutions (where no other provider supplied them)
  const rosters = {};
  for (const side of ['h', 'a']) { const { json, capture } = await client.get(`${base}/competitors/${fixture[side]}/roster`); rosters[side] = { ...espn.parseRoster(json), capture_id: capture.capture_id }; }
  await client.flush();
  const athleteIds = [...new Set(Object.values(rosters).flatMap(r => r.entries.flatMap(e => [e.athlete_id, e.sub_out?.replacement_id].filter(Boolean))))];
  const teamOf = new Map();
  for (const side of ['h', 'a']) for (const e of rosters[side].entries) teamOf.set(e.athlete_id, { match_id: matchId, team_id: side === 'h' ? home : away });
  const ath = await resolveAthletes(store, { athleteIds, client, league, year, registry: client.registry, areas: client.areas, teamOf });
  summary.athletes = { in_rosters: athleteIds.length, founded: ath.founded, corroborated: ath.corroborated, queued: ath.queued };
  const lineups = await store.select('soccer_lineups', { columns: ['id', 'team_id', 'provider'], eq: { match_id: matchId } });
  const lpRows = []; const lineupRows = []; const subRows = []; const lpContext = [];
  for (const side of ['h', 'a']) {
    const teamId = side === 'h' ? home : away;
    if (lineups.some(l => l.team_id === teamId && l.provider !== P)) continue;
    const lineupId = childId('lineup', matchId, teamId);
    lineupRows.push({ id: lineupId, match_id: matchId, team_id: teamId, formation: rosters[side].formation, manager_id: null, provider: P, capture_id: rosters[side].capture_id });
    const seen = new Set();
    for (const e of rosters[side].entries) {
      const pid = ath.map.get(e.athlete_id);
      if (!pid || seen.has(pid)) continue; seen.add(pid);
      lpRows.push({ lineup_id: lineupId, player_id: pid, is_starter: e.starter, shirt_number: e.jersey, position: null, is_captain: null });
      lpContext.push({ match_id: matchId, team_id: teamId, player_id: pid, is_starter: e.starter });
      if (e.sub_out?.replacement_id && ath.map.get(e.sub_out.replacement_id)) {
        const pin = ath.map.get(e.sub_out.replacement_id);
        subRows.push({ id: childId('substitution', matchId, teamId, pid, pin), match_id: matchId, team_id: teamId, player_out_id: pid, player_in_id: pin, minute: e.sub_out.clock_s !== null ? footballMinute('1H', e.sub_out.clock_s) : null, provider: P, capture_id: rosters[side].capture_id });
      }
    }
  }
  count(await syncRows(store, { table: 'soccer_lineups', key: ['id'], rows: lineupRows }));
  count(await syncRows(store, { table: 'soccer_lineup_players', key: ['lineup_id', 'player_id'], rows: lpRows }));
  count(await syncRows(store, { table: 'soccer_substitutions', key: ['id'], rows: subRows }));
  if (lpContext.length) await deriveMatchStats(store, { matches: [{ id: matchId, duration: 'regular' }], events: [], lineupPlayers: lpContext, subs: subRows });

  // Team statistics (source facts)
  const statRows = [];
  for (const side of ['h', 'a']) {
    const { json } = await client.get(`${base}/competitors/${fixture[side]}/statistics`);
    for (const [k, v] of Object.entries(espn.parseTeamStats(json))) statRows.push({ match_id: matchId, team_id: side === 'h' ? home : away, stat_key: k, value: v, basis: 'source', provider: P, derivation_version: null });
  }
  await client.flush();
  count(await syncRows(store, { table: 'soccer_team_match_stats', key: ['match_id', 'team_id', 'stat_key', 'basis'], compare: ['value', 'provider'], rows: statRows }));

  // Plays -> ledger, unless a richer ledger (Wyscout) already covers the match.
  const richer = await store.select('soccer_match_external_ids', { columns: ['provider'], eq: { match_id: matchId, provider: 'wyscout' }, limit: 1 });
  if (!richer.length) {
    const items = []; let capId = null; let page = 1; let pages = 1;
    do { const { json, capture } = await client.get(espn.urls.plays(league, eventId, page)); capId = capId || capture.capture_id; items.push(...(json.items || [])); pages = json.pageCount || 1; page += 1; } while (page <= pages);
    await client.flush();
    const { events, unmapped } = espn.parsePlays(items, { eventId });
    const participantIds = [...new Set(events.map(e => e.player_external_id).filter(Boolean))];
    const pmap = await resolveMany(store, 'player', P, participantIds);
    const obs = new Date(now).toISOString();
    const rows = events.map(e => ({
      id: mintId('event', P, e.source_event_id), match_id: matchId, sequence: e.sequence, period: e.period, clock_seconds: e.clock_seconds, minute: e.minute,
      team_id: teamMap.get(e.team_external_id) || null, player_id: e.player_external_id ? pmap.get(e.player_external_id) || null : null,
      event_type: e.event_type, subtype: e.subtype, outcome: e.outcome, body_part: e.body_part, under_pressure: null, set_piece: e.set_piece,
      is_goal: e.is_goal, is_own_goal: e.is_own_goal, card: e.card, qualifiers: e.qualifiers, possession_id: null,
      source_x: e.source_x, source_y: e.source_y, source_end_x: e.source_end_x, source_end_y: e.source_end_y, source_coordinate_system: e.source_coordinate_system,
      x_m: e.x_m, y_m: e.y_m, end_x_m: e.end_x_m, end_y_m: e.end_y_m, source_family: P, source_event_id: e.source_event_id,
      observed_at: obs, event_at: null, raw_payload_hash: payloadHash(e.raw), capture_id: capId, parser_version: espn.ESPN_PARSER_VERSION,
    }));
    summary.plays = { events: rows.length, with_coordinates: rows.filter(r => r.x_m !== null).length, unmapped_types: unmapped, goals: rows.filter(r => r.is_goal).length };
    count(await syncRows(store, { table: 'soccer_match_events', key: ['source_family', 'source_event_id'], rows, compare: ['raw_payload_hash', 'match_id', 'player_id', 'team_id', 'sequence'], provider: P, captureId: capId, chunk: 1000 }));
  }
  return { final: true, changed, summary };
}

// Bridge OpenLigaDB scorer ids (queued: abbreviated names, no DOB) to canonical
// players through ESPN goal events in the same matches. Same rule as the Wyscout
// bridge: every aligned goal of a scorer id must point at ONE canonical player,
// with zero conflicts.
export async function alignOpenLigaScorersToEspn(store, { seasonId }) {
  const matches = await store.select('soccer_matches', { columns: ['id'], eq: { season_id: seasonId } });
  const ids = matches.map(m => m.id);
  const oldb = await selectIn(store, 'soccer_match_events', 'match_id', ids, { columns: ['id', 'match_id', 'team_id', 'minute', 'qualifiers', 'player_id'], eq: { source_family: 'openligadb', is_goal: true } });
  const espnGoals = await selectIn(store, 'soccer_match_events', 'match_id', [...new Set(oldb.map(g => g.match_id))], { columns: ['match_id', 'team_id', 'player_id', 'minute'], eq: { source_family: P, is_goal: true } });
  const byMatch = new Map();
  for (const g of espnGoals) if (g.player_id) byMatch.set(g.match_id, [...(byMatch.get(g.match_id) || []), g]);
  const votes = new Map();
  for (const g of oldb) {
    const sid = g.qualifiers?.source_player?.id;
    if (!sid || !byMatch.has(g.match_id)) continue;
    const cands = new Set(byMatch.get(g.match_id).filter(e => e.team_id === g.team_id && minuteClose(e.minute, g.minute)).map(e => e.player_id));
    const v = votes.get(sid) || { players: new Set(), aligned: 0, none: 0, ambiguous: 0 };
    if (cands.size === 1) { v.players.add([...cands][0]); v.aligned += 1; } else if (!cands.size) v.none += 1; else v.ambiguous += 1;
    votes.set(sid, v);
  }
  const already = await resolveMany(store, 'player', 'openligadb', [...votes.keys()]);
  const xw = []; let conflicts = 0;
  for (const [sid, v] of votes) {
    if (already.has(sid)) continue;
    if (v.players.size === 1 && v.aligned >= 1) {
      const pid = [...v.players][0];
      xw.push({ provider: 'openligadb', external_id: sid, player_id: pid, method: 'event_alignment', evidence: `${v.aligned} goal(s) aligned to one canonical scorer via ESPN goal events; ${v.none} unaligned; ${v.ambiguous} ambiguous; 0 conflicting`, capture_id: null });
    } else if (v.players.size > 1) {
      conflicts += 1;
      await queueIdentity(store, { entity_type: 'player', provider: 'openligadb', external_id: sid, reason: 'event_alignment_conflict', candidate_ids: [...v.players] });
    }
  }
  const written = await syncRows(store, { table: 'soccer_player_external_ids', key: ['provider', 'external_id'], compare: ['player_id'], rows: xw });
  for (const x of xw) await resolveQueued(store, { entity_type: 'player', provider: 'openligadb', external_id: x.external_id, resolution: { method: 'event_alignment', via: 'espn', player_id: x.player_id } });
  // Attach the now-resolved scorer to the OpenLigaDB goal events.
  const resolved = new Map([...already, ...xw.map(x => [x.external_id, x.player_id])]);
  const updates = oldb.filter(g => !g.player_id && resolved.has(g.qualifiers?.source_player?.id)).map(g => g.id);
  if (updates.length) {
    const full = await selectIn(store, 'soccer_match_events', 'id', updates, { columns: '*', order: 'id.asc' });
    await syncRows(store, { table: 'soccer_match_events', key: ['id'], compare: ['player_id'], provider: 'openligadb', rows: full.map(r => ({ ...r, player_id: resolved.get(r.qualifiers.source_player.id) })) });
  }
  return { scorer_ids_seen: votes.size, crosswalked: xw.length, conflicts, goal_events_resolved: updates.length, written };
}
