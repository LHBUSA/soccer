// OpenLigaDB -> canonical graph. Every OpenLigaDB-derived observation keeps
// source_family/provider='openligadb', its capture_id, the provider external id and
// observed_at (ODbL provenance stays separable from PBE-derived data).
//
//   * Season whose canonical fixtures are owned by ANOTHER provider (e.g. Wyscout
//     2017/18): team identity is PROVEN by the fixture graph; matches crosswalk onto
//     the existing canonical matches (never rewritten); results are recorded side by
//     side; goal scorers are crosswalked to canonical players by event alignment.
//   * Otherwise (history 2004/05+ and the current season): known teams resolve
//     through the crosswalk (OpenLigaDB team ids are stable across seasons); new teams
//     are founded from their stable id unless a canonical team carries the same
//     normalized name (queued — possible duplicate, fail closed). OpenLigaDB owns
//     these matches (result_provider='openligadb'): they are founded and UPDATED as
//     the source changes. Reported goals become 'goal' events without coordinates.
//     Scorers resolve through the crosswalk or are QUEUED — abbreviated names and no
//     birth dates are not enough to found a person.

import { archiveCapture } from '../../shared/archive.js';
import { politeFetch } from '../../shared/http.js';
import { childId, mintId, payloadHash } from '../../shared/ids.js';
import { OPENLIGA_PARSER_VERSION, matchdataUrl, parseMatchdata, proveTeamsByFixtureGraph } from '../../providers/openligadb.js';
import { allocateSlugs, normName, queueIdentity, resolveMany, resolveQueued } from './identity.js';
import { chunkArr, syncRows } from './store.js';

const P = 'openligadb';
const EVENT_SOURCE_PROVIDERS = ['wyscout']; // providers whose matches carry a richer event ledger

export async function fetchAndArchive(storage, league, season, group = null, fetcher = politeFetch) {
  const url = matchdataUrl(league, season) + (group ? `/${group}` : '');
  const res = await fetcher(url);
  const rec = await archiveCapture(storage, {
    family: 'openligadb', sourceKey: `openligadb.matchdata.${league}`, url, status: res.status, contentType: res.contentType,
    bytes: res.bytes, parserVersion: OPENLIGA_PARSER_VERSION,
  });
  return { rec, bytes: res.bytes };
}

function seasonLabelFor(season) { return `${season}/${String(season + 1).slice(2)}`; }
const dateOf = ts => new Date(ts).toISOString().slice(0, 10);

export function captureRow(rec) {
  return { capture_id: rec.capture_id, source_key: rec.source_key, family: rec.family, request_method: rec.request_method, request_url: rec.request_url, captured_at: rec.captured_at, http_status: rec.http_status, content_type: rec.content_type, content_sha256: rec.content_sha256, bytes: rec.bytes, raw_key: rec.raw_key, parser_version: rec.parser_version, notes: rec.notes };
}

async function selectIn(store, table, col, values, opts = {}) {
  const out = [];
  for (const part of chunkArr([...new Set(values)], store.inChunk || 500)) out.push(...await store.select(table, { ...opts, in: { ...(opts.in || {}), [col]: part } }));
  return out;
}

export async function ingestOpenLigaSeason(store, { registry, league, season, storage, capture = null, now = Date.now(), reviewed = { entries: [] } }) {
  const { rec, bytes } = capture || await fetchAndArchive(storage, league, season);
  await syncRows(store, { table: 'soccer_source_captures', key: ['capture_id'], rows: [captureRow(rec)] });
  const matchesRaw = parseMatchdata(JSON.parse(new TextDecoder().decode(bytes)));
  const summary = { capture_id: rec.capture_id, sha256: rec.content_sha256, matches: matchesRaw.length, finished: matchesRaw.filter(m => m.finished).length };

  // A pairing may appear twice in the source (duplicate/replayed rows). Keep one
  // deterministically (finished first, then latest kickoff, then highest id); report the rest.
  const byPair = new Map();
  for (const m of matchesRaw) { const k = `${m.team1.external_id}|${m.team2.external_id}`; byPair.set(k, [...(byPair.get(k) || []), m]); }
  const matches = []; const dupDropped = [];
  for (const list of byPair.values()) {
    list.sort((a, b) => Number(b.finished) - Number(a.finished) || Date.parse(b.kickoff_utc) - Date.parse(a.kickoff_utc) || Number(b.external_id) - Number(a.external_id));
    matches.push(list[0]);
    dupDropped.push(...list.slice(1).map(x => x.external_id));
  }
  if (dupDropped.length) summary.duplicate_pair_rows_skipped = dupDropped;

  const regComp = registry.competitions.find(c => c.external_ids.some(x => x.provider === P && x.external_id === league));
  if (!regComp) throw new Error(`openligadb league ${league} not in registry`);
  const founding = regComp.external_ids.find(x => x.method === 'founding');
  const compId = mintId('competition', founding.provider, founding.external_id);
  if (!(await store.select('soccer_competitions', { columns: ['id'], eq: { id: compId }, limit: 1 })).length) {
    await syncRows(store, { table: 'soccer_competitions', key: ['id'], rows: [{ id: compId, slug: regComp.slug, name: regComp.name, comp_type: regComp.comp_type, gender: regComp.gender, country_code: regComp.country_code, tier: regComp.tier }] });
  }
  await syncRows(store, { table: 'soccer_competition_external_ids', key: ['provider', 'external_id'], compare: ['competition_id'], rows: regComp.external_ids.map(x => ({ provider: x.provider, external_id: x.external_id, competition_id: compId, method: x.method, evidence: x.evidence, capture_id: null })) });

  // --- season: crosswalk, else the competition's season with the same label, else found.
  const sExt = `${league}:${season}`;
  let seasonId = (await resolveMany(store, 'season', P, [sExt])).get(sExt);
  const label = seasonLabelFor(season);
  if (!seasonId) {
    const rows = await store.select('soccer_seasons', { columns: ['id'], eq: { competition_id: compId, label }, limit: 1 });
    seasonId = rows[0]?.id || mintId('season', P, sExt);
    if (!rows.length) {
      const ds = matches.map(m => m.kickoff_utc).filter(Boolean).sort();
      await syncRows(store, { table: 'soccer_seasons', key: ['id'], rows: [{ id: seasonId, competition_id: compId, label, start_date: ds[0]?.slice(0, 10) || null, end_date: ds[ds.length - 1]?.slice(0, 10) || null }] });
    }
    await syncRows(store, { table: 'soccer_season_external_ids', key: ['provider', 'external_id'], compare: ['season_id'], rows: [{ provider: P, external_id: sExt, season_id: seasonId, method: rows.length ? 'reviewed' : 'founding', evidence: `competition ${regComp.slug} season label ${label}`, capture_id: rec.capture_id }] });
  }
  // Rounds beyond the league's regular rounds (e.g. 2008/09 groups 35-36
  // "Relegation") are a play-off stage and never enter the league table.
  const regularRounds = regComp.regular_rounds || Infinity;
  const stageId = childId('stage', seasonId, 'regular-season');
  const playoffStageId = childId('stage', seasonId, 'relegation-playoff');
  const stageRows = [{ id: stageId, season_id: seasonId, name: 'Regular Season', stage_type: 'league', stage_order: 1 }];
  if (matches.some(m => m.matchday > regularRounds)) stageRows.push({ id: playoffStageId, season_id: seasonId, name: 'Relegation Play-off', stage_type: 'playoff', stage_order: 2 });
  await syncRows(store, { table: 'soccer_stages', key: ['id'], rows: stageRows });
  const stageOf = m => (m.matchday > regularRounds ? playoffStageId : stageId);

  // --- teams
  const provTeams = new Map();
  for (const m of matches) for (const t of [m.team1, m.team2]) provTeams.set(t.external_id, t);
  const teamMap = await resolveMany(store, 'team', P, [...provTeams.keys()]);
  const canonFixtures = (await store.select('soccer_matches', { columns: ['id', 'kickoff_at', 'home_team_id', 'away_team_id', 'result_provider'], eq: { season_id: seasonId } }))
    .map(f => ({ ...f, date: dateOf(f.kickoff_at) }));
  const foreign = canonFixtures.filter(f => f.result_provider !== P);
  const teamXw = [];
  if (foreign.length) {
    const proof = proveTeamsByFixtureGraph(
      foreign.map(f => ({ date: f.date, home: f.home_team_id, away: f.away_team_id })),
      matches.map(m => ({ date: m.kickoff_utc.slice(0, 10), home: m.team1.external_id, away: m.team2.external_id })),
    );
    summary.fixture_graph = { proven: proof.proven, mapped: proof.mapping.size, unresolved: proof.unresolved.length, collisions: proof.collisions.length, unmatched_fixtures: proof.unmatched_fixtures };
    for (const [pt, ct] of proof.mapping) {
      const prior = teamMap.get(pt);
      if (prior && prior !== ct) {
        await queueIdentity(store, { entity_type: 'team', provider: P, external_id: pt, reason: 'fixture_graph_contradicts_crosswalk', candidate_ids: [prior, ct] });
        continue;
      }
      if (!proof.proven) continue; // partial proofs never write
      teamMap.set(pt, ct);
      teamXw.push({ provider: P, external_id: pt, team_id: ct, method: 'fixture_graph', evidence: `${league} ${season}: ${proof.provider_fixtures}/${proof.canonical_fixtures} fixtures reproduced`, capture_id: rec.capture_id });
    }
    if (!proof.proven) {
      for (const u of proof.unresolved) await queueIdentity(store, { entity_type: 'team', provider: P, external_id: u.provider_team, reason: 'fixture_graph_ambiguous', candidate_ids: u.candidates });
      summary.halted = 'fixture graph not proven; nothing written for this season beyond the capture';
      return { summary };
    }
  } else {
    // Reviewed crosswalks (data/registry/team-crosswalk-reviewed.json) first.
    for (const r of reviewed.entries.filter(e => e.provider === P && provTeams.has(e.external_id) && !teamMap.has(e.external_id))) {
      const target = (await resolveMany(store, 'team', r.same_as.provider, [r.same_as.external_id])).get(r.same_as.external_id);
      if (!target) continue; // the proven id is not in the graph yet: normal rules apply (queue)
      teamMap.set(r.external_id, target);
      teamXw.push({ provider: P, external_id: r.external_id, team_id: target, method: 'reviewed', evidence: r.evidence.join(' | ').slice(0, 2000), capture_id: rec.capture_id });
      await resolveQueued(store, { entity_type: 'team', provider: P, external_id: r.external_id, resolution: { method: 'reviewed', team_id: target, reviewer: r.reviewer } });
    }
    const newTeams = [...provTeams.keys()].filter(t => !teamMap.has(t)).sort((a, b) => Number(a) - Number(b));
    const existing = newTeams.length ? await store.select('soccer_teams', { columns: ['id', 'name', 'official_name'] }) : [];
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
      byName.set(normName(src.name), [mintId('team', P, t)]); // a second id with the same name in this batch queues too
      found.push(src);
    }
    const slugs = allocateSlugs(found.map(s => ({ id: mintId('team', P, s.external_id), name: s.name })), found.length ? (await store.select('soccer_teams', { columns: ['slug'] })).map(r => r.slug) : []);
    await syncRows(store, { table: 'soccer_teams', key: ['id'], rows: found.map(s => ({ id: mintId('team', P, s.external_id), slug: slugs.get(mintId('team', P, s.external_id)), name: s.name, short_name: s.short_name, official_name: null, team_type: 'club', gender: 'men', country_code: 'DEU', city: null, founding_provider: P, founding_external_id: s.external_id })) });
    for (const s of found) { teamMap.set(s.external_id, mintId('team', P, s.external_id)); teamXw.push({ provider: P, external_id: s.external_id, team_id: mintId('team', P, s.external_id), method: 'founding', evidence: 'openligadb teamId', capture_id: rec.capture_id }); }
    summary.teams_founded = found.length;
  }
  summary.team_crosswalk = await syncRows(store, { table: 'soccer_team_external_ids', key: ['provider', 'external_id'], compare: ['team_id'], rows: teamXw });

  // --- matches
  const canonByPair = new Map(canonFixtures.map(f => [`${f.home_team_id}|${f.away_team_id}`, f]));
  const matchMap = await resolveMany(store, 'match', P, matches.map(m => m.external_id));
  const matchRows = []; const xw = []; const results = []; let skipped = 0;
  for (const m of matches) {
    const home = teamMap.get(m.team1.external_id); const away = teamMap.get(m.team2.external_id);
    if (!home || !away) { skipped += 1; continue; }
    const canon = canonByPair.get(`${home}|${away}`);
    const owned = !canon || canon.result_provider === P;
    const id = matchMap.get(m.external_id) || canon?.id || mintId('match', P, m.external_id);
    matchMap.set(m.external_id, id);
    xw.push({ provider: P, external_id: m.external_id, match_id: id, method: owned ? 'founding' : 'fixture_graph', evidence: `openligadb matchID ${m.external_id}`, capture_id: rec.capture_id });
    // OpenLigaDB has no live flag: kicked off, not finished and within 3 h = live.
    const ko = Date.parse(m.kickoff_utc);
    const status = m.finished ? 'finished' : ko > now ? 'scheduled' : now - ko < 3 * 3600e3 ? 'live' : 'unknown';
    results.push({ match_id: id, provider: P, status, home_score: m.score1, away_score: m.score2, home_score_ht: m.score1_ht, away_score_ht: m.score2_ht, capture_id: rec.capture_id, observed_at: rec.captured_at });
    if (owned) {
      matchRows.push({ id, competition_id: compId, season_id: seasonId, stage_id: stageOf(m), matchday: m.matchday, round_label: m.matchday > regularRounds ? `Relegation play-off, leg ${m.matchday - regularRounds}` : m.matchday ? `Matchday ${m.matchday}` : null, kickoff_at: m.kickoff_utc, venue_id: null, home_team_id: home, away_team_id: away, status, home_score: m.score1, away_score: m.score2, home_score_ht: m.score1_ht, away_score_ht: m.score2_ht, home_score_et: null, away_score_et: null, home_pens: null, away_pens: null, duration: m.finished ? 'regular' : null, winner_team_id: m.finished && m.score1 !== null ? (m.score1 > m.score2 ? home : m.score2 > m.score1 ? away : null) : null, result_provider: P });
    }
  }
  summary.matches_skipped_unresolved_team = skipped;
  summary.matches_written = await syncRows(store, { table: 'soccer_matches', key: ['id'], rows: matchRows, provider: P, captureId: rec.capture_id, touch: true });
  summary.match_crosswalk = await syncRows(store, { table: 'soccer_match_external_ids', key: ['provider', 'external_id'], compare: ['match_id'], rows: xw });
  summary.source_results = await syncRows(store, { table: 'soccer_match_source_results', key: ['match_id', 'provider'], compare: ['status', 'home_score', 'away_score', 'home_score_ht', 'away_score_ht'], rows: results, provider: P, captureId: rec.capture_id });

  // Cross-source agreement where another provider also reports this season.
  const matchIds = [...new Set(matchMap.values())];
  const sr = await selectIn(store, 'soccer_match_source_results', 'match_id', matchIds, { columns: ['match_id', 'provider', 'home_score', 'away_score', 'home_score_ht', 'away_score_ht'] });
  const byMatch = new Map();
  for (const r of sr) byMatch.set(r.match_id, { ...(byMatch.get(r.match_id) || {}), [r.provider]: r });
  const pairs = [...byMatch.values()].filter(v => v.wyscout && v.openligadb);
  if (pairs.length) {
    const ft = v => v.wyscout.home_score === v.openligadb.home_score && v.wyscout.away_score === v.openligadb.away_score;
    const ht = v => v.wyscout.home_score_ht === v.openligadb.home_score_ht && v.wyscout.away_score_ht === v.openligadb.away_score_ht;
    summary.cross_source = {
      compared: pairs.length, final_score_agree: pairs.filter(ft).length, half_time_agree: pairs.filter(ht).length,
      final_disagreements: pairs.filter(v => !ft(v)).map(v => ({ match_id: v.wyscout.match_id, wyscout: `${v.wyscout.home_score}-${v.wyscout.away_score}`, openligadb: `${v.openligadb.home_score}-${v.openligadb.away_score}` })),
      half_time_disagreements: pairs.filter(v => !ht(v)).map(v => ({ match_id: v.wyscout.match_id, wyscout: `${v.wyscout.home_score_ht}-${v.wyscout.away_score_ht}`, openligadb: `${v.openligadb.home_score_ht}-${v.openligadb.away_score_ht}` })),
    };
  }

  // --- goal scorers: event alignment where a richer ledger exists, else crosswalk or queue.
  const scorerIds = [...new Set(matches.flatMap(m => m.goals.filter(g => g.advances && !g.is_own_goal && g.scorer_external_id).map(g => g.scorer_external_id)))];
  const scorerMap = await resolveMany(store, 'player', P, scorerIds);
  const richer = new Set((await selectIn(store, 'soccer_match_external_ids', 'match_id', matchIds, { columns: ['match_id'], in: { provider: EVENT_SOURCE_PROVIDERS } })).map(r => r.match_id));
  const evGoals = richer.size ? await selectIn(store, 'soccer_match_events', 'match_id', [...richer], { columns: ['match_id', 'team_id', 'player_id', 'minute'], eq: { is_goal: true } }) : [];
  const votes = new Map();
  if (evGoals.length) {
    const goalsByMatch = new Map();
    for (const g of evGoals) if (g.player_id) goalsByMatch.set(g.match_id, [...(goalsByMatch.get(g.match_id) || []), g]);
    for (const m of matches) {
      const matchId = matchMap.get(m.external_id);
      if (!richer.has(matchId)) continue;
      for (const g of m.goals) {
        if (!g.advances || g.is_own_goal || !g.scorer_external_id || g.minute === null) continue;
        const teamId = teamMap.get(g.side === 'team1' ? m.team1.external_id : m.team2.external_id);
        const v = votes.get(g.scorer_external_id) || { players: new Set(), aligned: 0, no_candidate: 0, ambiguous: 0 };
        const cands = new Set((goalsByMatch.get(matchId) || []).filter(e => e.team_id === teamId && minuteClose(e.minute, g.minute)).map(e => e.player_id));
        if (cands.size === 1) { v.players.add([...cands][0]); v.aligned += 1; } else if (cands.size === 0) v.no_candidate += 1; else v.ambiguous += 1;
        votes.set(g.scorer_external_id, v);
      }
    }
  }
  // OpenLigaDB is community-entered and carries several ids for one person
  // (e.g. three ids for Timo Werner in 2017/18). Many provider ids -> one canonical
  // player is allowed; each id must independently align with zero conflicts.
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

  // --- reported goals as ledger events, only for matches without a richer ledger.
  const goalRows = []; const unresolvedScorers = new Map();
  for (const m of matches) {
    const matchId = matchMap.get(m.external_id);
    if (!matchId || richer.has(matchId)) continue;
    let order = 0;
    for (const g of m.goals.filter(x => x.advances)) {
      order += 1;
      const benefiting = g.side === 'team1' ? m.team1.external_id : m.team2.external_id;
      const benefitingTeam = teamMap.get(benefiting) || null;
      const otherTeam = teamMap.get(benefiting === m.team1.external_id ? m.team2.external_id : m.team1.external_id) || null;
      const pid = g.scorer_external_id ? scorerMap.get(g.scorer_external_id) || null : null;
      if (g.scorer_external_id && !pid && !g.is_own_goal) unresolvedScorers.set(g.scorer_external_id, g.scorer_name);
      const period = g.is_overtime ? 'E1' : g.minute !== null && g.minute <= 45 ? '1H' : '2H';
      goalRows.push({
        id: mintId('event', P, g.external_id), match_id: matchId, sequence: order, period, clock_seconds: null, minute: g.minute,
        team_id: g.is_own_goal ? otherTeam : benefitingTeam, player_id: pid, event_type: 'goal', subtype: g.is_penalty ? 'penalty' : g.is_own_goal ? 'own_goal' : 'goal',
        outcome: 'goal', body_part: null, under_pressure: null, set_piece: g.is_penalty ? 'penalty' : null, is_goal: !g.is_own_goal, is_own_goal: g.is_own_goal, card: null,
        qualifiers: { source_player: g.scorer_external_id ? { provider: P, id: g.scorer_external_id, name: g.scorer_name } : null, running_score: `${g.score1}-${g.score2}` },
        possession_id: null, source_x: null, source_y: null, source_end_x: null, source_end_y: null, source_coordinate_system: 'none',
        x_m: null, y_m: null, end_x_m: null, end_y_m: null, source_family: 'openligadb', source_event_id: g.external_id,
        observed_at: rec.captured_at, event_at: null, raw_payload_hash: payloadHash(g.raw), capture_id: rec.capture_id, parser_version: OPENLIGA_PARSER_VERSION,
      });
    }
  }
  for (const [sid, name] of unresolvedScorers) await queueIdentity(store, { entity_type: 'player', provider: P, external_id: sid, reason: 'scorer_without_canonical_identity', payload: { name } });
  summary.goal_events = await syncRows(store, { table: 'soccer_match_events', key: ['source_family', 'source_event_id'], rows: goalRows, compare: ['raw_payload_hash', 'match_id', 'player_id', 'team_id', 'sequence', 'minute'], provider: P, captureId: rec.capture_id });
  summary.goal_scorers_unresolved = unresolvedScorers.size;
  return { summary };
}

// OpenLigaDB stores stoppage-time goals at the regulation minute (45, 90);
// the event ledger has the football minute (e.g. 47 in 1H, 93 in 2H).
export function minuteClose(eventMinute, reported) {
  const e = Number(eventMinute);
  if (reported === 45 && e >= 44 && e <= 52) return true;
  if (reported === 90 && e >= 89) return true;
  return Math.abs(e - reported) <= 2;
}
