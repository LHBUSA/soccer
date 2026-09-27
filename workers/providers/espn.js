// Provider: ESPN Core API (sports.core.api.espn.com) — SECONDARY ingestion source
// (owner decision 2026-09-27). Terms remain flagged RESTRICTS_COMMERCIAL_USE in the
// source registry; provenance stays separable (source_family/provider = 'espn').
//
// Access rule: Core API only. site.api.espn.com is Akamai-blocked and is never
// touched or bypassed. Structured facts only: play `text`, headlines, articles and
// any editorial prose are NEVER stored — parsers drop them.
//
// Coordinates (docs/evidence/espn-soccer-coordinates.json, 6 matches, 3 leagues):
// fieldPositionX/Y are 0-100, team-relative, attacking toward x=100, y=0 = the
// attacking team's RIGHT touchline (Opta convention). Slight off-pitch values
// (-2..102) occur for throw-ins/out-of-play and get no canonical point.

import { toCanonical } from '../shared/coords.js';
import { footballMinute } from '../shared/clock.js';

export const ESPN_PARSER_VERSION = 'espn-core/1.0.0';
export const ESPN_COORDS = 'espn_pct_v1';
export const CORE = 'https://sports.core.api.espn.com/v2/sports/soccer/leagues';
export const ATTRIBUTION = 'Structured facts: ESPN (secondary source)';

export const urls = {
  league: lg => `${CORE}/${lg}`,
  seasonEvents: (lg, year, type = 1, page = 1) => `${CORE}/${lg}/seasons/${year}/types/${type}/events?limit=1000&page=${page}`,
  seasonTypes: (lg, year) => `${CORE}/${lg}/seasons/${year}/types`,
  event: (lg, id) => `${CORE}/${lg}/events/${id}`,
  plays: (lg, id, page = 1) => `${CORE}/${lg}/events/${id}/competitions/${id}/plays?limit=1000&page=${page}`,
};

export const https = ref => String(ref || '').replace(/^http:\/\//, 'https://').replace(/[?&]lang=en&region=us$/, '').replace(/\?lang=en&region=us&/, '?');
export const refId = (ref, kind) => (String(ref || '').match(new RegExp(`/${kind}/(\\d+)`)) || [])[1] || null;
export const seasonYearOf = ref => Number((String(ref || '').match(/seasons\/(\d{4})/) || [])[1]) || null;

export class EspnShapeError extends Error {
  constructor(msg) { super(`espn shape drift: ${msg}`); this.name = 'EspnShapeError'; }
}

export function seasonLabel(year, format) {
  return format === 'split' ? `${year}/${String(year + 1).slice(2)}` : String(year);
}

// Season-type role for competitions that model stages by ESPN type (MLS):
// Regular Season -> league stage; playoff rounds -> playoff stage (never in the
// table); All-Star / Combined / anything unrecognised -> excluded entirely.
export function seasonTypeRole(name) {
  const n = String(name || '');
  if (/^Regular Season$/i.test(n)) return 'league';
  if (/playoff|final|cup/i.test(n) && !/all-star/i.test(n)) return 'playoff';
  return 'excluded';
}

export function refsOf(listJson) {
  if (!listJson || !Array.isArray(listJson.items)) throw new EspnShapeError('list without items');
  return { ids: listJson.items.map(i => refId(i.$ref, 'events')).filter(Boolean), pageCount: listJson.pageCount || 1, count: listJson.count ?? listJson.items.length };
}

export function parseEvent(ev, league) {
  if (!ev?.id || !Array.isArray(ev.competitions) || !ev.competitions[0]) throw new EspnShapeError(`event ${ev?.id} without competitions`);
  const c = ev.competitions[0];
  const side = ha => c.competitors.find(x => x.homeAway === ha);
  const home = side('home'); const away = side('away');
  if (!home || !away) throw new EspnShapeError(`event ${ev.id} without home/away`);
  const v = c.venue || null;
  return {
    provider: 'espn', league, external_id: String(ev.id), kickoff_utc: new Date(ev.date).toISOString(), season_year: seasonYearOf(ev.season?.$ref), season_type: refId(ev.seasonType?.$ref, 'types'),
    home: { team_id: String(home.id), winner: home.winner ?? null, score_ref: https(home.score?.$ref), roster_ref: https(home.roster?.$ref), stats_ref: https(home.statistics?.$ref), team_ref: https(home.team?.$ref) },
    away: { team_id: String(away.id), winner: away.winner ?? null, score_ref: https(away.score?.$ref), roster_ref: https(away.roster?.$ref), stats_ref: https(away.statistics?.$ref), team_ref: https(away.team?.$ref) },
    status_ref: https(c.status?.$ref),
    venue: v ? { external_id: v.id ? String(v.id) : null, name: v.fullName || null, city: v.address?.city || null, country: v.address?.country || null } : null,
    attendance: Number.isFinite(c.attendance) && c.attendance > 0 ? c.attendance : null,
    lineup_available: !!c.lineupAvailable, plays_available: !!c.playByPlayAvailable,
  };
}

// ESPN status -> canonical status.
export function parseStatus(st) {
  const t = st?.type || {};
  const name = String(t.name || '');
  if (/POSTPONED/.test(name)) return 'postponed';
  if (/CANCELED|CANCELLED/.test(name)) return 'cancelled';
  if (/ABANDONED|SUSPENDED/.test(name)) return 'abandoned';
  if (t.completed || t.state === 'post') return 'finished';
  if (t.state === 'in') return 'live';
  if (t.state === 'pre') return 'scheduled';
  return 'unknown';
}

export function parseTeam(t) {
  if (!t?.id) throw new EspnShapeError('team without id');
  return {
    provider: 'espn', external_id: String(t.id), name: t.displayName || t.name || null, short_name: t.shortDisplayName || t.abbreviation || null,
    location: t.location || null, uid: t.uid || null, sdr: t.alternateIds?.sdr ? String(t.alternateIds.sdr) : null, is_national: !!t.isNational,
    // All-Star selections are exhibition sides, never league members (ESPN files the
    // MLS All-Star game under Regular Season).
    is_all_star: t.isAllStar === true || /\ball-?stars?\b/i.test(`${t.displayName || ''} ${t.name || ''}`),
  };
}

const POS = { G: 'goalkeeper', D: 'defender', M: 'midfielder', F: 'forward' };
export function parseAthlete(a) {
  if (!a?.id) throw new EspnShapeError('athlete without id');
  return {
    provider: 'espn', external_id: String(a.id), display_name: a.displayName || a.fullName || null, first_name: a.firstName || null, middle_name: a.middleName || null,
    last_name: a.lastName || null, short_name: a.shortName || null, birth_date: a.dateOfBirth ? String(a.dateOfBirth).slice(0, 10) : null,
    citizenship: a.citizenship || null, primary_role: POS[String(a.position?.abbreviation || '').charAt(0)] || null,
    height_cm: a.height > 0 ? Math.round(a.height * 2.54) : null, weight_kg: a.weight > 0 ? Math.round(a.weight * 0.4536) : null,
  };
}

export function parseRoster(r) {
  if (!r || !Array.isArray(r.entries)) throw new EspnShapeError('roster without entries');
  return {
    formation: r.formation?.summary || r.formation?.name || null,
    entries: r.entries.map(e => ({
      athlete_id: String(e.playerId ?? refId(e.athlete?.$ref, 'athletes')), athlete_ref: https(e.athlete?.$ref), starter: !!e.starter,
      jersey: e.jersey && /^\d+$/.test(e.jersey) ? Number(e.jersey) : null, formation_place: e.formationPlace ? Number(e.formationPlace) : null,
      sub_out: e.subbedOut?.didSub ? { replacement_id: refId(e.subbedOut.replacementAthlete?.$ref, 'athletes'), clock_s: e.subbedOut.clock?.value ?? null } : null,
    })),
  };
}

// Whitelisted team statistics (source facts, basis='source', provider='espn').
export const TEAM_STAT_WHITELIST = {
  possessionPct: 'possession_pct', totalShots: 'shots', shotsOnTarget: 'shots_on_target', wonCorners: 'corners', foulsCommitted: 'fouls_committed',
  offsides: 'offsides', yellowCards: 'yellow_cards', redCards: 'red_cards', saves: 'saves', totalPasses: 'passes', accuratePasses: 'passes_completed',
  totalTackles: 'tackles', interceptions: 'interceptions', totalClearance: 'clearances', expectedGoals: 'provider_xg_espn',
};
export function parseTeamStats(s) {
  const out = {};
  for (const cat of s?.splits?.categories || []) for (const st of cat.stats || []) {
    const k = TEAM_STAT_WHITELIST[st.name];
    if (k && Number.isFinite(Number(st.value))) out[k] = Number(st.value);
  }
  return out;
}

// ---- plays -> canonical event records ---------------------------------------
const T = (event_type, subtype, extra = {}) => ({ event_type, subtype, ...extra });
const PLAY_MAP = {
  'Pass': T('pass', 'simple'), 'Cross': T('pass', 'cross'), 'Blocked Pass': T('pass', 'blocked', { outcome: 'fail' }),
  'Throw In': T('pass', 'throw_in', { set_piece: 'throw_in' }), 'Goal Kick': T('pass', 'goal_kick', { set_piece: 'goal_kick' }), 'Kickoff': T('pass', 'kick_off', { set_piece: 'kick_off' }),
  'Shot On Target': T('shot', 'open_play', { outcome: 'on_target' }), 'Shot Off Target': T('shot', 'open_play', { outcome: 'off_target' }), 'Shot Blocked': T('shot', 'open_play', { outcome: 'blocked' }),
  'Goal': T('shot', 'open_play', { outcome: 'goal', goal: true }), 'Goal - Header': T('shot', 'open_play', { outcome: 'goal', goal: true }), 'Goal - Free-kick': T('shot', 'free_kick', { outcome: 'goal', goal: true, set_piece: 'free_kick' }),
  'Goal - Volley': T('shot', 'open_play', { outcome: 'goal', goal: true }),
  'Penalty - Scored': T('shot', 'penalty', { outcome: 'goal', goal: true, set_piece: 'penalty' }), 'Penalty - Saved': T('shot', 'penalty', { outcome: 'on_target', set_piece: 'penalty' }), 'Penalty - Missed': T('shot', 'penalty', { outcome: 'off_target', set_piece: 'penalty' }),
  'Save': T('save', 'save'), 'Punch': T('save', 'punch'), 'Claim': T('keeper_exit', 'claim'), 'Keeper Sweeper': T('keeper_exit', 'sweeper'),
  'Aerial': T('duel', 'aerial'), 'Take On': T('duel', 'take_on'), 'Dispossessed': T('duel', 'dispossessed', { outcome: 'lost' }),
  'Tackle': T('tackle', 'tackle', { outcome: 'success' }), 'Attempted tackle': T('tackle', 'tackle', { outcome: 'fail' }), 'Interception': T('interception', 'interception'),
  'Clear': T('clearance', 'clearance'), 'Ball touch': T('touch', 'touch'), 'Foul': T('foul', 'foul'), 'Offside': T('offside', 'offside'),
  'Yellow Card': T('card', 'yellow', { card: 'yellow' }), 'Red Card': T('card', 'red', { card: 'red' }), 'Substitution': T('substitution', 'substitution'),
  'Out': T('interruption', 'ball_out'), 'Drop of Ball': T('interruption', 'drop_ball'), 'Corner Awarded': T('interruption', 'corner_awarded'),
};
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const BODY = { 'Left Foot': 'left_foot', 'Right Foot': 'right_foot', 'Head': 'head' };

export function mapPlayType(text) {
  if (PLAY_MAP[text]) return PLAY_MAP[text];
  if (/^Goal( - |$)/.test(text)) return T('shot', 'open_play', { outcome: 'goal', goal: true });
  if (/^(Start|End) |Delay|VAR|Deleted After Review|Half|Regular Time|Extra Time/.test(text)) return T('interruption', `espn_${slug(text)}`);
  return null; // unmapped: kept as 'unmapped' with espn_<slug>, never guessed
}

export function periodOf(n) { return { 1: '1H', 2: '2H', 3: 'E1', 4: 'E2', 5: 'PS' }[n] || null; }
const PERIOD_START_S = { '1H': 0, '2H': 2700, E1: 5400, E2: 6300, PS: 7200 };

export function parsePlays(items, { eventId, sideOfTeam }) {
  const plays = [...items].filter(p => p && p.id && p.valid !== false);
  plays.sort((a, b) => (a.period?.number || 0) - (b.period?.number || 0) || (a.clock?.value ?? 0) - (b.clock?.value ?? 0) || Number(a.id) - Number(b.id));
  const unmapped = {};
  return {
    unmapped,
    events: plays.map((p, i) => {
      const text = p.type?.text || '';
      let m = mapPlayType(text);
      if (!m) { unmapped[text] = (unmapped[text] || 0) + 1; m = T('unmapped', `espn_${slug(text)}`); }
      const period = periodOf(p.period?.number);
      const clockTotal = Number.isFinite(p.clock?.value) ? p.clock.value : null;
      const ownGoal = !!p.ownGoal;
      const actor = (p.participants || []).find(x => x.order === 1) || (p.participants || [])[0];
      const hasXY = Number.isFinite(p.fieldPositionX) && Number.isFinite(p.fieldPositionY);
      const start = hasXY ? toCanonical(ESPN_COORDS, p.fieldPositionX, p.fieldPositionY) : { x_m: null, y_m: null };
      const hasEnd = Number.isFinite(p.fieldPosition2X) && Number.isFinite(p.fieldPosition2Y);
      // End points are kept canonically only for passes (the pass destination);
      // for other plays their meaning is not established, so only the source value is stored.
      const end = hasEnd && m.event_type === 'pass' ? toCanonical(ESPN_COORDS, p.fieldPosition2X, p.fieldPosition2Y) : { x_m: null, y_m: null };
      const qualifiers = {
        espn_type: text,
        ...(Number.isFinite(p.expectedGoals) ? { provider_xg: { provider: 'espn', value: p.expectedGoals } } : {}),
        ...(Number.isFinite(p.goalPositionY) ? { goal_mouth: { y: p.goalPositionY, z: p.goalPositionZ ?? null } } : {}),
        ...(text === 'Assist' ? { assist: true } : {}), ...(text === 'Assists Shot' ? { key_pass: true } : {}),
        ...(p.shotInfo?.text ? { shot_situation: p.shotInfo.text } : {}),
        participants: (p.participants || []).map(x => ({ athlete: refId(x.athlete?.$ref, 'athletes'), order: x.order ?? null, type: x.type || null })),
      };
      return {
        provider: 'espn', source_event_id: String(p.id), match_external_id: String(eventId), sequence: i + 1,
        team_external_id: refId(p.team?.$ref, 'teams'), player_external_id: refId(actor?.athlete?.$ref, 'athletes'),
        side: sideOfTeam ? sideOfTeam(refId(p.team?.$ref, 'teams')) : null,
        period, clock_seconds: clockTotal !== null && period ? Math.max(0, clockTotal - PERIOD_START_S[period]) : null,
        minute: clockTotal !== null ? footballMinute('1H', clockTotal) : null,
        event_type: ownGoal ? 'touch' : m.event_type, subtype: ownGoal ? 'own_goal' : m.subtype, set_piece: m.set_piece || null,
        outcome: ownGoal ? 'goal' : m.outcome || null,
        body_part: BODY[p.contactType?.text] || null, under_pressure: null,
        is_goal: !!m.goal && !ownGoal && p.scoringPlay !== false, is_own_goal: ownGoal,
        card: m.card || (p.redCard ? 'red' : p.yellowCard ? 'yellow' : null),
        source_x: hasXY ? p.fieldPositionX : null, source_y: hasXY ? p.fieldPositionY : null,
        source_end_x: hasEnd ? p.fieldPosition2X : null, source_end_y: hasEnd ? p.fieldPosition2Y : null,
        source_coordinate_system: hasXY ? ESPN_COORDS : 'none',
        x_m: start.x_m, y_m: start.y_m, end_x_m: end.x_m, end_y_m: end.y_m,
        qualifiers, sub: text === 'Substitution' ? { in: refId((p.participants || []).find(x => x.order === 1)?.athlete?.$ref, 'athletes'), out: refId((p.participants || []).find(x => x.order === 2)?.athlete?.$ref, 'athletes') } : null,
        // raw is hashed for provenance, but prose fields are stripped first.
        raw: stripProse(p),
      };
    }),
  };
}

export function stripProse(p) {
  const { text, shortText, alternativeText, shortAlternativeText, $ref, ...rest } = p;
  return rest;
}
