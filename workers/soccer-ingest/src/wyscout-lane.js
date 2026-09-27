// Wyscout public dataset -> canonical graph, one competition-season at a time.
// Wyscout is the FOUNDING lane for the historical seasons it covers: entities it
// sees for the first time are minted from its ids (unless a strong-attribute
// collision with another provider's entity exists, which queues instead).

import { childId, mintId, payloadHash } from '../../shared/ids.js';
import { ATTRIBUTION, WYSCOUT_PARSER_VERSION } from '../../providers/wyscout-figshare.js';
import { allocateSlugs, normName, queueIdentity, resolveMany } from './identity.js';
import { syncRows } from './store.js';
import { deriveMatchStats } from './derive.js';

const P = 'wyscout';

function seasonLabel(dates) {
  const ds = dates.filter(Boolean).sort();
  const first = new Date(ds[0]);
  const last = new Date(ds[ds.length - 1]);
  const y1 = first.getUTCFullYear();
  const y2 = last.getUTCFullYear();
  return {
    label: y1 === y2 ? String(y1) : `${y1}/${String(y2).slice(2)}`,
    start_date: ds[0].slice(0, 10),
    end_date: ds[ds.length - 1].slice(0, 10),
  };
}

export function playerDisplayName(p) {
  // Wyscout shortName is either the known name ("Thiago") or an initial form
  // ("J. Rodríguez"). Initial forms expand to the first given name + the
  // shortName surname ("James Rodríguez"), not the full legal name
  // ("James David Rodríguez Rubio"), which stays in first_name/last_name.
  const short = p.short_name;
  const m = short && short.match(/^[A-ZÀ-ɏ][a-zÀ-ɏ]?\.\s*(.+)$/);
  if (short && !m) return short;
  const given = (p.first_name || '').split(/\s+/)[0];
  if (m && given) return `${given} ${m[1]}`;
  const full = [p.first_name, p.last_name].filter(Boolean).join(' ');
  return full || short || `Player ${p.external_id}`;
}

async function takenSlugs(store, table) {
  return (await store.select(table, { columns: ['slug'] })).map(r => r.slug);
}

export async function ingestWyscoutSeason(store, { registry, competitionExternalId, parsed, captures, log = () => {} }) {
  const report = { competition: null, season: null, counts: {}, queued: [], unmapped_event_types: parsed.unmapped || {} };
  const regComp = registry.competitions.find(c => c.external_ids.some(x => x.provider === P && x.external_id === String(competitionExternalId)));
  if (!regComp) throw new Error(`competition wyscout:${competitionExternalId} is not in data/registry/competitions.json`);
  const matches = parsed.matches.filter(m => m.competition_external_id === String(competitionExternalId));
  if (!matches.length) throw new Error(`no wyscout matches for competition ${competitionExternalId}`);
  const seasonExt = [...new Set(matches.map(m => m.season_external_id))];
  if (seasonExt.length !== 1) throw new Error(`expected one season, got ${seasonExt.join(',')}`);

  // --- competition (registry-reviewed metadata) + crosswalks
  const founding = regComp.external_ids.find(x => x.method === 'founding');
  const compId = mintId('competition', founding.provider, founding.external_id);
  const c1 = await syncRows(store, {
    table: 'soccer_competitions', key: ['id'],
    rows: [{ id: compId, slug: regComp.slug, name: regComp.name, comp_type: regComp.comp_type, gender: regComp.gender, country_code: regComp.country_code, tier: regComp.tier }],
    provider: 'registry',
  });
  await syncRows(store, {
    table: 'soccer_competition_external_ids', key: ['provider', 'external_id'],
    rows: regComp.external_ids.map(x => ({ provider: x.provider, external_id: x.external_id, competition_id: compId, method: x.method, evidence: x.evidence, capture_id: x.provider === P ? captures.competitions : null })),
    compare: ['competition_id'],
  });
  report.competition = { id: compId, slug: regComp.slug, written: c1 };

  // --- season + stage
  const sExt = seasonExt[0];
  const [existingSeason] = [...(await resolveMany(store, 'season', P, [sExt])).values()];
  const seasonId = existingSeason || mintId('season', P, sExt);
  const sl = seasonLabel(matches.map(m => m.kickoff_utc));
  await syncRows(store, { table: 'soccer_seasons', key: ['id'], rows: [{ id: seasonId, competition_id: compId, label: sl.label, start_date: sl.start_date, end_date: sl.end_date }] });
  await syncRows(store, { table: 'soccer_season_external_ids', key: ['provider', 'external_id'], rows: [{ provider: P, external_id: sExt, season_id: seasonId, method: 'founding', evidence: `wyscout seasonId ${sExt}`, capture_id: captures.matches }], compare: ['season_id'] });
  const stageId = childId('stage', seasonId, 'regular-season');
  await syncRows(store, { table: 'soccer_stages', key: ['id'], rows: [{ id: stageId, season_id: seasonId, name: 'Regular Season', stage_type: regComp.comp_type === 'league' ? 'league' : 'group', stage_order: 1 }] });
  report.season = { id: seasonId, label: sl.label, matches: matches.length };

  // --- teams
  const teamById = new Map(parsed.teams.map(t => [t.external_id, t]));
  const teamExt = [...new Set(matches.flatMap(m => [m.home.team_external_id, m.away.team_external_id]))].sort();
  const teamMap = await resolveMany(store, 'team', P, teamExt);
  const newTeams = teamExt.filter(t => !teamMap.has(t));
  const teamSlugs = allocateSlugs(newTeams.map(t => ({ id: mintId('team', P, t), name: teamById.get(t)?.name || `team-${t}` })), await takenSlugs(store, 'soccer_teams'));
  const teamRows = [];
  for (const t of newTeams) {
    const src = teamById.get(t);
    if (!src) throw new Error(`wyscout team ${t} referenced by a match but absent from teams.json`);
    const id = mintId('team', P, t);
    teamMap.set(t, id);
    teamRows.push({ id, slug: teamSlugs.get(id), name: src.name, short_name: null, official_name: src.official_name, team_type: src.team_type, gender: 'men', country_code: src.area_code, city: src.city, founding_provider: P, founding_external_id: t });
  }
  report.counts.teams = await syncRows(store, { table: 'soccer_teams', key: ['id'], rows: teamRows });
  report.counts.team_crosswalk = await syncRows(store, {
    table: 'soccer_team_external_ids', key: ['provider', 'external_id'], compare: ['team_id'],
    rows: teamExt.map(t => ({ provider: P, external_id: t, team_id: teamMap.get(t), method: 'founding', evidence: 'wyscout teams.json wyId', capture_id: captures.teams })),
  });

  // --- players (everyone in a lineup, on a bench, in a substitution or an event)
  const playerById = new Map(parsed.players.map(p => [p.external_id, p]));
  const matchIds = new Set(matches.map(m => m.external_id));
  const events = parsed.events.filter(e => matchIds.has(e.match_external_id));
  const pSet = new Set();
  for (const m of matches) for (const s of [m.home, m.away]) {
    s.starters.forEach(p => pSet.add(p)); s.bench.forEach(p => pSet.add(p));
    s.substitutions.forEach(x => { pSet.add(x.player_in); pSet.add(x.player_out); });
  }
  for (const e of events) if (e.player_external_id && e.player_external_id !== '0') pSet.add(e.player_external_id);
  const playerExt = [...pSet].filter(p => p !== '0').sort();
  const playerMap = await resolveMany(store, 'player', P, playerExt);
  const unresolved = playerExt.filter(p => !playerMap.has(p));
  // Strong-attribute collision check against entities founded by OTHER providers.
  const others = await store.select('soccer_players', { columns: ['id', 'display_name', 'first_name', 'last_name', 'birth_date'], neq: { founding_provider: P } });
  const otherKey = new Map();
  for (const o of others) {
    if (!o.birth_date) continue;
    const k = `${normName([o.first_name, o.last_name].filter(Boolean).join(' ') || o.display_name)}|${new Date(o.birth_date).toISOString().slice(0, 10)}`;
    otherKey.set(k, [...(otherKey.get(k) || []), o.id]);
  }
  const toFound = [];
  for (const p of unresolved) {
    const src = playerById.get(p);
    if (!src) { await queueIdentity(store, { entity_type: 'player', provider: P, external_id: p, reason: 'referenced_but_absent_from_players_json' }); report.queued.push({ player: p, reason: 'absent' }); continue; }
    const k = src.birth_date ? `${normName([src.first_name, src.last_name].filter(Boolean).join(' '))}|${src.birth_date}` : null;
    if (k && otherKey.has(k)) {
      await queueIdentity(store, { entity_type: 'player', provider: P, external_id: p, reason: 'strong_attribute_collision_with_other_provider', candidate_ids: otherKey.get(k), payload: src });
      report.queued.push({ player: p, reason: 'collision' });
      continue;
    }
    toFound.push(src);
  }
  const pSlugs = allocateSlugs(toFound.map(s => ({ id: mintId('player', P, s.external_id), name: playerDisplayName(s), year: s.birth_date?.slice(0, 4) })), await takenSlugs(store, 'soccer_players'));
  const playerRows = toFound.map(s => {
    const id = mintId('player', P, s.external_id);
    playerMap.set(s.external_id, id);
    return {
      id, slug: pSlugs.get(id), display_name: playerDisplayName(s), short_name: s.short_name, first_name: s.first_name, middle_name: s.middle_name, last_name: s.last_name,
      birth_date: s.birth_date, birth_country_code: s.birth_area_code, nationality_code: s.passport_area_code, foot: s.foot,
      height_cm: s.height_cm && s.height_cm >= 140 && s.height_cm <= 220 ? s.height_cm : null,
      weight_kg: s.weight_kg && s.weight_kg >= 40 && s.weight_kg <= 130 ? s.weight_kg : null,
      primary_role: s.primary_role, founding_provider: P, founding_external_id: s.external_id,
    };
  });
  report.counts.players = await syncRows(store, { table: 'soccer_players', key: ['id'], rows: playerRows });
  report.counts.player_crosswalk = await syncRows(store, {
    table: 'soccer_player_external_ids', key: ['provider', 'external_id'], compare: ['player_id'],
    rows: [...playerMap.entries()].map(([ext, id]) => ({ provider: P, external_id: ext, player_id: id, method: 'founding', evidence: 'wyscout players.json wyId', capture_id: captures.players })),
  });

  // --- managers
  const coachById = new Map(parsed.coaches.map(c => [c.external_id, c]));
  const coachExt = [...new Set(matches.flatMap(m => [m.home.coach_external_id, m.away.coach_external_id]).filter(Boolean))].filter(c => coachById.has(c)).sort();
  const coachMap = await resolveMany(store, 'manager', P, coachExt);
  const newCoaches = coachExt.filter(c => !coachMap.has(c));
  const cName = c => [c.first_name, c.last_name].filter(Boolean).join(' ') || c.short_name || `Coach ${c.external_id}`;
  const cSlugs = allocateSlugs(newCoaches.map(c => ({ id: mintId('manager', P, c), name: cName(coachById.get(c)) })), await takenSlugs(store, 'soccer_managers'));
  const coachRows = newCoaches.map(c => {
    const s = coachById.get(c); const id = mintId('manager', P, c); coachMap.set(c, id);
    return { id, slug: cSlugs.get(id), display_name: cName(s), first_name: s.first_name, last_name: s.last_name, birth_date: s.birth_date, nationality_code: s.passport_area_code, founding_provider: P, founding_external_id: c };
  });
  report.counts.managers = await syncRows(store, { table: 'soccer_managers', key: ['id'], rows: coachRows });
  await syncRows(store, { table: 'soccer_manager_external_ids', key: ['provider', 'external_id'], compare: ['manager_id'], rows: [...coachMap.entries()].map(([ext, id]) => ({ provider: P, external_id: ext, manager_id: id, method: 'founding', evidence: 'wyscout coaches.json wyId', capture_id: captures.coaches })) });

  // --- venues. Wyscout gives only a venue NAME. The crosswalk key is the exact
  // source string under a distinct provider tag; it is never matched across providers.
  const VP = 'wyscout_venue_name';
  const venueNames = [...new Set(matches.map(m => m.venue_name).filter(Boolean))].sort();
  const venueMap = await resolveMany(store, 'venue', VP, venueNames);
  const newVenues = venueNames.filter(v => !venueMap.has(v));
  const vSlugs = allocateSlugs(newVenues.map(v => ({ id: mintId('venue', VP, v), name: v })), await takenSlugs(store, 'soccer_venues'));
  const venueRows = newVenues.map(v => { const id = mintId('venue', VP, v); venueMap.set(v, id); return { id, slug: vSlugs.get(id), name: v }; });
  report.counts.venues = await syncRows(store, { table: 'soccer_venues', key: ['id'], rows: venueRows });
  await syncRows(store, { table: 'soccer_venue_external_ids', key: ['provider', 'external_id'], compare: ['venue_id'], rows: [...venueMap.entries()].map(([ext, id]) => ({ provider: VP, external_id: ext, venue_id: id, method: 'founding', evidence: 'exact wyscout venue string', capture_id: captures.matches })) });

  // --- matches
  const matchMap = await resolveMany(store, 'match', P, [...matchIds]);
  const matchRows = [];
  const resultRows = [];
  for (const m of matches) {
    const id = matchMap.get(m.external_id) || mintId('match', P, m.external_id);
    matchMap.set(m.external_id, id);
    const home = teamMap.get(m.home.team_external_id);
    const away = teamMap.get(m.away.team_external_id);
    matchRows.push({
      id, competition_id: compId, season_id: seasonId, stage_id: stageId, matchday: m.gameweek, round_label: m.gameweek ? `Matchday ${m.gameweek}` : null,
      kickoff_at: m.kickoff_utc, venue_id: m.venue_name ? venueMap.get(m.venue_name) : null, home_team_id: home, away_team_id: away,
      status: m.status, home_score: m.home.score, away_score: m.away.score, home_score_ht: m.home.score_ht, away_score_ht: m.away.score_ht,
      home_score_et: m.duration === 'regular' ? null : m.home.score_et, away_score_et: m.duration === 'regular' ? null : m.away.score_et,
      home_pens: m.duration === 'penalties' ? m.home.score_p : null, away_pens: m.duration === 'penalties' ? m.away.score_p : null,
      duration: m.duration, winner_team_id: m.winner_external_id ? teamMap.get(m.winner_external_id) || null : null, result_provider: P,
    });
    resultRows.push({ match_id: id, provider: P, status: m.status, home_score: m.home.score, away_score: m.away.score, home_score_ht: m.home.score_ht, away_score_ht: m.away.score_ht, capture_id: captures.matches, observed_at: captures.matches_at });
  }
  report.counts.matches = await syncRows(store, { table: 'soccer_matches', key: ['id'], rows: matchRows, provider: P, captureId: captures.matches });
  report.counts.match_crosswalk = await syncRows(store, { table: 'soccer_match_external_ids', key: ['provider', 'external_id'], compare: ['match_id'], rows: [...matchMap.entries()].map(([ext, id]) => ({ provider: P, external_id: ext, match_id: id, method: 'founding', evidence: 'wyscout matches wyId', capture_id: captures.matches })) });
  report.counts.match_source_results = await syncRows(store, { table: 'soccer_match_source_results', key: ['match_id', 'provider'], compare: ['status', 'home_score', 'away_score', 'home_score_ht', 'away_score_ht'], rows: resultRows, provider: P, captureId: captures.matches });

  // --- lineups, lineup players, substitutions
  const lineupRows = []; const lpRows = []; const lpContext = []; const subRows = []; let missingPlayers = 0;
  for (const m of matches) {
    const matchId = matchMap.get(m.external_id);
    for (const side of [m.home, m.away]) {
      const teamId = teamMap.get(side.team_external_id);
      const lineupId = childId('lineup', matchId, teamId);
      lineupRows.push({ id: lineupId, match_id: matchId, team_id: teamId, formation: null, manager_id: side.coach_external_id ? coachMap.get(side.coach_external_id) || null : null, provider: P, capture_id: captures.matches });
      const seen = new Set();
      for (const [list, starter] of [[side.starters, true], [side.bench, false]]) for (const pe of list) {
        const pid = playerMap.get(pe);
        if (!pid) { missingPlayers += 1; continue; }
        if (seen.has(pid)) continue; seen.add(pid);
        lpRows.push({ lineup_id: lineupId, player_id: pid, is_starter: starter, shirt_number: null, position: null, is_captain: null });
        lpContext.push({ match_id: matchId, team_id: teamId, player_id: pid, is_starter: starter });
      }
      for (const s of side.substitutions) {
        const pin = playerMap.get(s.player_in); const pout = playerMap.get(s.player_out);
        if (!pin || !pout) { missingPlayers += 1; continue; }
        subRows.push({ id: childId('substitution', matchId, teamId, pout, pin), match_id: matchId, team_id: teamId, player_out_id: pout, player_in_id: pin, minute: s.minute, provider: P, capture_id: captures.matches });
      }
    }
  }
  report.counts.lineups = await syncRows(store, { table: 'soccer_lineups', key: ['id'], rows: lineupRows });
  report.counts.lineup_players = await syncRows(store, { table: 'soccer_lineup_players', key: ['lineup_id', 'player_id'], rows: lpRows });
  report.counts.substitutions = await syncRows(store, { table: 'soccer_substitutions', key: ['id'], rows: subRows });
  report.lineup_refs_unresolved = missingPlayers;

  // --- events
  const eventRows = [];
  let unresolvedEventPlayers = 0;
  for (const e of events) {
    const pid = e.player_external_id && e.player_external_id !== '0' ? playerMap.get(e.player_external_id) || null : null;
    if (e.player_external_id && e.player_external_id !== '0' && !pid) unresolvedEventPlayers += 1;
    eventRows.push({
      id: mintId('event', P, e.source_event_id), match_id: matchMap.get(e.match_external_id), sequence: e.sequence, period: e.period,
      clock_seconds: e.clock_seconds, minute: e.minute, team_id: teamMap.get(e.team_external_id) || null, player_id: pid,
      event_type: e.event_type, subtype: e.subtype, outcome: e.outcome, body_part: e.body_part, under_pressure: e.under_pressure,
      set_piece: e.set_piece, is_goal: e.is_goal, is_own_goal: e.is_own_goal, card: e.card,
      qualifiers: { assist: e.is_assist, key_pass: e.is_key_pass, counter: e.is_counter, wyscout_tags: e.tags },
      possession_id: null,
      source_x: e.source_x, source_y: e.source_y, source_end_x: e.source_end_x, source_end_y: e.source_end_y, source_coordinate_system: e.source_coordinate_system,
      x_m: e.x_m, y_m: e.y_m, end_x_m: e.end_x_m, end_y_m: e.end_y_m,
      source_family: 'wyscout_figshare', source_event_id: e.source_event_id,
      observed_at: captures.events_at, event_at: null, raw_payload_hash: payloadHash(e.raw), capture_id: captures.events, parser_version: WYSCOUT_PARSER_VERSION,
    });
  }
  log(`events: writing ${eventRows.length}`);
  report.counts.events = await syncRows(store, {
    table: 'soccer_match_events', key: ['source_family', 'source_event_id'], rows: eventRows,
    compare: ['raw_payload_hash', 'parser_version', 'match_id', 'team_id', 'player_id', 'sequence'], provider: P, captureId: captures.events, chunk: 4000,
  });
  report.event_players_unresolved = unresolvedEventPlayers;

  // --- derived per-match stats from the ledger
  report.counts.derived = await deriveMatchStats(store, { matches: matchRows, events: eventRows, lineupPlayers: lpContext, subs: subRows });
  report.attribution = ATTRIBUTION;
  return report;
}
