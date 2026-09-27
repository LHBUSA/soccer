// OpenLigaDB -> canonical graph.
//   * Season with canonical fixtures already present (e.g. Wyscout 2017/18):
//     team identity is PROVEN by the fixture graph; matches crosswalk onto the
//     existing canonical matches; results are recorded side by side; goal
//     scorers are crosswalked to canonical players by event alignment.
//   * Season with no canonical fixtures (current season): known teams resolve
//     through the crosswalk (OpenLigaDB team ids are stable across seasons); new
//     teams are founded from their stable id unless an existing canonical team
//     carries the same normalized name (queued — possible duplicate, fail closed).
//     Matches are founded; reported goals become 'goal' events without
//     coordinates. Scorers resolve through the crosswalk or are QUEUED —
//     OpenLigaDB gives abbreviated names and no birth dates, which is not enough
//     to found a person.

import { archiveCapture } from '../../shared/archive.js';
import { politeFetch } from '../../shared/http.js';
import { childId, mintId, payloadHash } from '../../shared/ids.js';
import { OPENLIGA_PARSER_VERSION, matchdataUrl, parseMatchdata, proveTeamsByFixtureGraph } from '../../providers/openligadb.js';
import { allocateSlugs, normName, queueIdentity, resolveMany } from './identity.js';
import { syncRows } from './store.js';

const P = 'openligadb';
export const RESULT_PRECEDENCE = ['wyscout', 'openligadb'];

export async function fetchAndArchive(storage, league, season) {
  const url = matchdataUrl(league, season);
  const res = await politeFetch(url);
  return archiveCapture(storage, {
    family: 'openligadb', sourceKey: `openligadb.matchdata.${league}`, url, status: res.status, contentType: res.contentType,
    bytes: res.bytes, parserVersion: OPENLIGA_PARSER_VERSION,
  }).then(rec => ({ rec, bytes: res.bytes }));
}

function seasonLabelFor(season) { return `${season}/${String(season + 1).slice(2)}`; }

export async function ingestOpenLigaSeason(store, { registry, league, season, storage, log = () => {}, capture = null }) {
  const { rec, bytes } = capture || await fetchAndArchive(storage, league, season);
  await syncRows(store, { table: 'soccer_source_captures', key: ['capture_id'], rows: [{ capture_id: rec.capture_id, source_key: rec.source_key, family: rec.family, request_method: rec.request_method, request_url: rec.request_url, captured_at: rec.captured_at, http_status: rec.http_status, content_type: rec.content_type, content_sha256: rec.content_sha256, bytes: rec.bytes, raw_key: rec.raw_key, parser_version: rec.parser_version, notes: rec.notes }] });
  const matches = parseMatchdata(JSON.parse(new TextDecoder().decode(bytes)));
  const summary = { capture_id: rec.capture_id, sha256: rec.content_sha256, matches: matches.length, finished: matches.filter(m => m.finished).length };

  const regComp = registry.competitions.find(c => c.external_ids.some(x => x.provider === P && x.external_id === league));
  if (!regComp) throw new Error(`openligadb league ${league} not in registry`);
  const founding = regComp.external_ids.find(x => x.method === 'founding');
  const compId = mintId('competition', founding.provider, founding.external_id);
  const { rows: compRows } = await store.query('select id from public.soccer_competitions where id = $1', [compId]);
  if (!compRows.length) {
    await syncRows(store, { table: 'soccer_competitions', key: ['id'], rows: [{ id: compId, slug: regComp.slug, name: regComp.name, comp_type: regComp.comp_type, gender: regComp.gender, country_code: regComp.country_code, tier: regComp.tier }] });
    await syncRows(store, { table: 'soccer_competition_external_ids', key: ['provider', 'external_id'], compare: ['competition_id'], rows: regComp.external_ids.map(x => ({ provider: x.provider, external_id: x.external_id, competition_id: compId, method: x.method, evidence: x.evidence, capture_id: null })) });
  }

  // --- season: crosswalk, else the competition's season with the same label, else found.
  const sExt = `${league}:${season}`;
  let seasonId = (await resolveMany(store, 'season', P, [sExt])).get(sExt);
  const label = seasonLabelFor(season);
  if (!seasonId) {
    const { rows } = await store.query('select id from public.soccer_seasons where competition_id = $1 and label = $2', [compId, label]);
    seasonId = rows[0]?.id || mintId('season', P, sExt);
    if (!rows.length) {
      const ds = matches.map(m => m.kickoff_utc).filter(Boolean).sort();
      await syncRows(store, { table: 'soccer_seasons', key: ['id'], rows: [{ id: seasonId, competition_id: compId, label, start_date: ds[0]?.slice(0, 10) || null, end_date: ds[ds.length - 1]?.slice(0, 10) || null }] });
    }
    await syncRows(store, { table: 'soccer_season_external_ids', key: ['provider', 'external_id'], compare: ['season_id'], rows: [{ provider: P, external_id: sExt, season_id: seasonId, method: rows.length ? 'reviewed' : 'founding', evidence: `competition ${regComp.slug} season label ${label}`, capture_id: rec.capture_id }] });
  }
  const stageId = childId('stage', seasonId, 'regular-season');
  await syncRows(store, { table: 'soccer_stages', key: ['id'], rows: [{ id: stageId, season_id: seasonId, name: 'Regular Season', stage_type: 'league', stage_order: 1 }] });

  // --- teams
  const provTeams = new Map();
  for (const m of matches) for (const t of [m.team1, m.team2]) provTeams.set(t.external_id, t);
  const teamMap = await resolveMany(store, 'team', P, [...provTeams.keys()]);
  const { rows: canonFixtures } = await store.query(
    `select to_char(kickoff_at at time zone 'UTC','YYYY-MM-DD') as date, home_team_id as home, away_team_id as away, id from public.soccer_matches where season_id = $1`, [seasonId]);
  let fixtureProof = null;
  const teamXw = [];
  if (canonFixtures.length) {
    fixtureProof = proveTeamsByFixtureGraph(
      canonFixtures.map(f => ({ date: f.date, home: f.home, away: f.away })),
      matches.map(m => ({ date: m.kickoff_utc.slice(0, 10), home: m.team1.external_id, away: m.team2.external_id })),
    );
    summary.fixture_graph = { proven: fixtureProof.proven, mapped: fixtureProof.mapping.size, unresolved: fixtureProof.unresolved.length, collisions: fixtureProof.collisions.length, unmatched_fixtures: fixtureProof.unmatched_fixtures };
    for (const [pt, ct] of fixtureProof.mapping) {
      const prior = teamMap.get(pt);
      if (prior && prior !== ct) {
        await queueIdentity(store, { entity_type: 'team', provider: P, external_id: pt, reason: 'fixture_graph_contradicts_crosswalk', candidate_ids: [prior, ct] });
        continue;
      }
      if (!fixtureProof.proven) continue; // partial proofs never write
      teamMap.set(pt, ct);
      teamXw.push({ provider: P, external_id: pt, team_id: ct, method: 'fixture_graph', evidence: `${league} ${season}: ${fixtureProof.provider_fixtures}/${fixtureProof.canonical_fixtures} fixtures reproduced`, capture_id: rec.capture_id });
    }
    if (!fixtureProof.proven) {
      for (const u of fixtureProof.unresolved) await queueIdentity(store, { entity_type: 'team', provider: P, external_id: u.provider_team, reason: 'fixture_graph_ambiguous', candidate_ids: u.candidates });
      summary.halted = 'fixture graph not proven; nothing written for this season beyond the capture';
      return { summary };
    }
  } else {
    const newTeams = [...provTeams.keys()].filter(t => !teamMap.has(t)).sort();
    const { rows: existing } = await store.query('select id, name, official_name from public.soccer_teams');
    const byName = new Map();
    for (const e of existing) for (const n of [e.name, e.official_name]) if (n) byName.set(normName(n), [...(byName.get(normName(n)) || []), e.id]);
    const found = [];
    for (const t of newTeams) {
      const src = provTeams.get(t);
      const clash = byName.get(normName(src.name));
      if (clash) {
        await queueIdentity(store, { entity_type: 'team', provider: P, external_id: t, reason: 'same_normalized_name_as_existing_team', candidate_ids: clash, payload: src });
        continue;
      }
      found.push(src);
    }
    const slugs = allocateSlugs(found.map(s => ({ id: mintId('team', P, s.external_id), name: s.name })), (await store.query('select slug from public.soccer_teams')).rows.map(r => r.slug));
    await syncRows(store, { table: 'soccer_teams', key: ['id'], rows: found.map(s => ({ id: mintId('team', P, s.external_id), slug: slugs.get(mintId('team', P, s.external_id)), name: s.name, short_name: s.short_name, official_name: null, team_type: 'club', gender: 'men', country_code: 'DEU', city: null, founding_provider: P, founding_external_id: s.external_id })) });
    for (const s of found) { teamMap.set(s.external_id, mintId('team', P, s.external_id)); teamXw.push({ provider: P, external_id: s.external_id, team_id: mintId('team', P, s.external_id), method: 'founding', evidence: 'openligadb teamId', capture_id: rec.capture_id }); }
    summary.teams_founded = found.length;
  }
  summary.team_crosswalk = await syncRows(store, { table: 'soccer_team_external_ids', key: ['provider', 'external_id'], compare: ['team_id'], rows: teamXw });

  // --- matches
  const canonByPair = new Map(canonFixtures.map(f => [`${f.home}|${f.away}`, f.id]));
  const matchMap = await resolveMany(store, 'match', P, matches.map(m => m.external_id));
  const matchRows = []; const xw = []; const results = []; let skipped = 0;
  for (const m of matches) {
    const home = teamMap.get(m.team1.external_id); const away = teamMap.get(m.team2.external_id);
    if (!home || !away) { skipped += 1; continue; }
    const existingId = matchMap.get(m.external_id) || canonByPair.get(`${home}|${away}`);
    const id = existingId || mintId('match', P, m.external_id);
    matchMap.set(m.external_id, id);
    xw.push({ provider: P, external_id: m.external_id, match_id: id, method: canonByPair.has(`${home}|${away}`) ? 'fixture_graph' : 'founding', evidence: `openligadb matchID ${m.external_id}`, capture_id: rec.capture_id });
    const status = m.finished ? 'finished' : (Date.parse(m.kickoff_utc) > Date.now() ? 'scheduled' : 'unknown');
    results.push({ match_id: id, provider: P, status, home_score: m.score1, away_score: m.score2, home_score_ht: m.score1_ht, away_score_ht: m.score2_ht, capture_id: rec.capture_id, observed_at: rec.captured_at });
    if (!canonByPair.has(`${home}|${away}`)) {
      matchRows.push({ id, competition_id: compId, season_id: seasonId, stage_id: stageId, matchday: m.matchday, round_label: m.matchday ? `Matchday ${m.matchday}` : null, kickoff_at: m.kickoff_utc, venue_id: null, home_team_id: home, away_team_id: away, status, home_score: m.score1, away_score: m.score2, home_score_ht: m.score1_ht, away_score_ht: m.score2_ht, home_score_et: null, away_score_et: null, home_pens: null, away_pens: null, duration: m.finished ? 'regular' : null, winner_team_id: m.finished ? (m.score1 > m.score2 ? home : m.score2 > m.score1 ? away : null) : null, result_provider: P });
    }
  }
  summary.matches_skipped_unresolved_team = skipped;
  summary.matches_written = await syncRows(store, { table: 'soccer_matches', key: ['id'], rows: matchRows, provider: P, captureId: rec.capture_id });
  summary.match_crosswalk = await syncRows(store, { table: 'soccer_match_external_ids', key: ['provider', 'external_id'], compare: ['match_id'], rows: xw });
  summary.source_results = await syncRows(store, { table: 'soccer_match_source_results', key: ['match_id', 'provider'], compare: ['status', 'home_score', 'away_score', 'home_score_ht', 'away_score_ht'], rows: results, provider: P, captureId: rec.capture_id });

  // Cross-source agreement on final + half-time score where two providers report.
  const { rows: agree } = await store.query(`
    select a.match_id, a.home_score a_h, a.away_score a_a, b.home_score b_h, b.away_score b_a, a.home_score_ht a_hh, a.away_score_ht a_ah, b.home_score_ht b_hh, b.away_score_ht b_ah
      from public.soccer_match_source_results a join public.soccer_match_source_results b on a.match_id = b.match_id and a.provider = 'wyscout' and b.provider = $1
      join public.soccer_matches m on m.id = a.match_id where m.season_id = $2`, [P, seasonId]);
  if (agree.length) {
    const ft = agree.filter(r => r.a_h === r.b_h && r.a_a === r.b_a).length;
    const ht = agree.filter(r => r.a_hh === r.b_hh && r.a_ah === r.b_ah).length;
    summary.cross_source = {
      compared: agree.length, final_score_agree: ft, half_time_agree: ht,
      final_disagreements: agree.filter(r => r.a_h !== r.b_h || r.a_a !== r.b_a).map(r => ({ match_id: r.match_id, wyscout: `${r.a_h}-${r.a_a}`, openligadb: `${r.b_h}-${r.b_a}` })),
      half_time_disagreements: agree.filter(r => r.a_hh !== r.b_hh || r.a_ah !== r.b_ah).map(r => ({ match_id: r.match_id, wyscout: `${r.a_hh}-${r.a_ah}`, openligadb: `${r.b_hh}-${r.b_ah}` })),
    };
  }

  // --- goal scorers: event alignment (seasons with canonical events), else crosswalk or queue.
  const scorerIds = [...new Set(matches.flatMap(m => m.goals.filter(g => !g.is_own_goal && g.scorer_external_id).map(g => g.scorer_external_id)))];
  const scorerMap = await resolveMany(store, 'player', P, scorerIds);
  const { rows: evGoals } = await store.query(
    `select e.match_id, e.team_id, e.player_id, e.minute, e.period from public.soccer_match_events e join public.soccer_matches m on m.id = e.match_id
      where m.season_id = $1 and e.is_goal and e.player_id is not null`, [seasonId]);
  const votes = new Map(); // scorer -> { players:Set, aligned:n, no_candidate:n, ambiguous:n }
  if (evGoals.length) {
    const byMatch = new Map();
    for (const g of evGoals) byMatch.set(g.match_id, [...(byMatch.get(g.match_id) || []), g]);
    for (const m of matches) {
      const matchId = matchMap.get(m.external_id);
      for (const g of m.goals) {
        if (g.is_own_goal || !g.scorer_external_id || !g.side || g.minute === null) continue;
        const teamId = teamMap.get(g.side === 'team1' ? m.team1.external_id : m.team2.external_id);
        const v = votes.get(g.scorer_external_id) || { players: new Set(), aligned: 0, no_candidate: 0, ambiguous: 0 };
        const cands = new Set((byMatch.get(matchId) || []).filter(e => e.team_id === teamId && minuteClose(e.minute, g.minute)).map(e => e.player_id));
        if (cands.size === 1) { v.players.add([...cands][0]); v.aligned += 1; } else if (cands.size === 0) v.no_candidate += 1; else v.ambiguous += 1;
        votes.set(g.scorer_external_id, v);
      }
    }
  }
  // OpenLigaDB is community-entered and carries several ids for one person
  // (e.g. three ids for Timo Werner in 2017/18). Many provider ids -> one
  // canonical player is therefore allowed; each id must independently align
  // with zero conflicts. One provider id -> two canonical players is a conflict.
  const finalXw = []; let queued = 0; let conflicts = 0;
  const perPlayer = new Map();
  for (const [sid, v] of votes) {
    if (scorerMap.has(sid)) continue;
    if (v.players.size === 1 && v.aligned >= 1) {
      const pid = [...v.players][0];
      perPlayer.set(pid, [...(perPlayer.get(pid) || []), sid]);
      finalXw.push({ provider: P, external_id: sid, player_id: pid, method: 'event_alignment', evidence: `${v.aligned} goal(s) aligned to one canonical scorer; ${v.no_candidate} unaligned; ${v.ambiguous} ambiguous; 0 conflicting`, capture_id: rec.capture_id });
    } else {
      if (v.players.size > 1) conflicts += 1;
      await queueIdentity(store, { entity_type: 'player', provider: P, external_id: sid, reason: v.players.size > 1 ? 'event_alignment_conflict' : 'event_alignment_no_unique_candidate', candidate_ids: [...v.players], payload: { aligned: v.aligned, no_candidate: v.no_candidate, ambiguous: v.ambiguous } });
      queued += 1;
    }
  }
  const dupPlayers = [...perPlayer.values()].filter(ids => ids.length > 1);
  summary.scorer_alignment = {
    scorers: scorerIds.length, already_crosswalked: scorerIds.filter(s => scorerMap.has(s)).length, aligned: finalXw.length, queued, conflicts,
    provider_duplicate_ids: { canonical_players: dupPlayers.length, provider_ids: dupPlayers.reduce((n, a) => n + a.length, 0) },
  };
  summary.player_crosswalk = await syncRows(store, { table: 'soccer_player_external_ids', key: ['provider', 'external_id'], compare: ['player_id'], rows: finalXw });
  for (const x of finalXw) scorerMap.set(x.external_id, x.player_id);

  // --- reported goals as ledger events, only for matches without a richer event source.
  const { rows: withEvents } = await store.query(`select distinct match_id from public.soccer_match_events where source_family <> 'openligadb' and match_id = any($1::uuid[])`, [[...new Set(matchMap.values())]]);
  const richer = new Set(withEvents.map(r => r.match_id));
  const goalRows = []; let unresolvedScorers = 0;
  for (const m of matches) {
    const matchId = matchMap.get(m.external_id);
    if (!matchId || richer.has(matchId)) continue;
    for (const g of m.goals) {
      const benefiting = g.side === 'team1' ? m.team1.external_id : g.side === 'team2' ? m.team2.external_id : null;
      const benefitingTeam = benefiting ? teamMap.get(benefiting) : null;
      const otherTeam = benefiting ? teamMap.get(benefiting === m.team1.external_id ? m.team2.external_id : m.team1.external_id) : null;
      const pid = g.scorer_external_id ? scorerMap.get(g.scorer_external_id) || null : null;
      if (g.scorer_external_id && !pid) {
        unresolvedScorers += 1;
        if (!g.is_own_goal) await queueIdentity(store, { entity_type: 'player', provider: P, external_id: g.scorer_external_id, reason: 'scorer_without_canonical_identity', payload: { name: g.scorer_name } });
      }
      const period = g.is_overtime ? 'E1' : g.minute !== null && g.minute <= 45 ? '1H' : '2H';
      goalRows.push({
        id: mintId('event', P, g.external_id), match_id: matchId, sequence: g.order, period, clock_seconds: null, minute: g.minute,
        team_id: g.is_own_goal ? otherTeam : benefitingTeam, player_id: pid, event_type: 'goal', subtype: g.is_penalty ? 'penalty' : g.is_own_goal ? 'own_goal' : 'goal',
        outcome: 'goal', body_part: null, under_pressure: null, set_piece: g.is_penalty ? 'penalty' : null, is_goal: !g.is_own_goal, is_own_goal: g.is_own_goal, card: null,
        qualifiers: { source_player: g.scorer_external_id ? { provider: P, id: g.scorer_external_id, name: g.scorer_name } : null, running_score: `${g.score1}-${g.score2}` },
        possession_id: null, source_x: null, source_y: null, source_end_x: null, source_end_y: null, source_coordinate_system: 'none',
        x_m: null, y_m: null, end_x_m: null, end_y_m: null, source_family: 'openligadb', source_event_id: g.external_id,
        observed_at: rec.captured_at, event_at: null, raw_payload_hash: payloadHash(g.raw), capture_id: rec.capture_id, parser_version: OPENLIGA_PARSER_VERSION,
      });
    }
  }
  summary.goal_events = await syncRows(store, { table: 'soccer_match_events', key: ['source_family', 'source_event_id'], rows: goalRows, compare: ['raw_payload_hash', 'match_id', 'player_id', 'team_id', 'sequence'], provider: P, captureId: rec.capture_id });
  summary.goal_scorers_unresolved = unresolvedScorers;
  return { summary, fixture_proof: fixtureProof && { proven: fixtureProof.proven, unresolved: fixtureProof.unresolved, collisions: fixtureProof.collisions } };
}

// OpenLigaDB stores stoppage-time goals at the regulation minute (45, 90);
// the event ledger has the elapsed minute (e.g. 47 in 1H, 93 in 2H).
function minuteClose(eventMinute, reported) {
  const e = Number(eventMinute);
  if (reported === 45 && e >= 44 && e <= 52) return true;
  if (reported === 90 && e >= 89) return true;
  return Math.abs(e - reported) <= 2;
}
