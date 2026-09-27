// Provider: Wyscout public soccer-logs dataset (Pappalardo et al., Scientific
// Data 6:236, 2019). figshare collection 4415000, CC BY 4.0. Frozen historical
// data: 2017/18 top-five European leagues, World Cup 2018, Euro 2016.
//
// Attribution required on every surface that uses it:
//   "Event data: Pappalardo et al. (2019), Wyscout public dataset, CC BY 4.0"
//
// Pure parsers only: bytes in, typed records out. No I/O, no canonical ids.
// Identity resolution and writes happen in workers/soccer-ingest.

import { toCanonical } from '../shared/coords.js';
import { footballMinute } from '../shared/clock.js';

export const WYSCOUT_PARSER_VERSION = 'wyscout-figshare/1.1.0';
export const WYSCOUT_COORDS = 'wyscout_pct_v1';
export const ATTRIBUTION = 'Event data: Pappalardo et al. (2019), Wyscout public soccer-logs dataset (figshare 4415000), CC BY 4.0';

export const WYSCOUT_FILES = [
  { key: 'competitions', article: 7765316, fileId: 15073685, name: 'competitions.json' },
  { key: 'teams', article: 7765310, fileId: 15073697, name: 'teams.json' },
  { key: 'players', article: 7765196, fileId: 15073721, name: 'players.json' },
  { key: 'coaches', article: 8082650, fileId: 15073868, name: 'coaches.json' },
  { key: 'referees', article: 8082665, fileId: 15074030, name: 'referees.json' },
  { key: 'matches', article: 7770422, fileId: 14464622, name: 'matches.zip' },
  { key: 'events', article: 7770599, fileId: 14464685, name: 'events.zip' },
  { key: 'eventid2name', article: 11743836, fileId: 21385245, name: 'eventid2name.csv' },
  { key: 'tags2name', article: 11743818, fileId: 21385239, name: 'tags2name.csv' },
];

// Some string fields in this dataset carry literal "é" escape sequences
// (double-escaped at export). Decode them; leave real text alone.
export function fixText(s) {
  if (typeof s !== 'string') return s ?? null;
  const out = s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).trim();
  return out === '' ? null : out;
}

const nullIfEmpty = v => (v === '' || v === undefined || v === null ? null : v);

export function parseCompetitions(json) {
  return json.map(c => ({
    provider: 'wyscout', external_id: String(c.wyId), name: fixText(c.name),
    area_code: nullIfEmpty(c.area?.alpha3code), area_name: fixText(c.area?.name),
    format: nullIfEmpty(c.format), type: nullIfEmpty(c.type),
  }));
}

export function parseTeams(json) {
  return json.map(t => ({
    provider: 'wyscout', external_id: String(t.wyId), name: fixText(t.name), official_name: fixText(t.officialName),
    city: fixText(t.city), area_code: nullIfEmpty(t.area?.alpha3code), team_type: t.type === 'national' ? 'national' : 'club',
  }));
}

const ROLE = { GK: 'goalkeeper', DF: 'defender', MD: 'midfielder', FW: 'forward' };

export function parsePlayers(json) {
  return json.map(p => ({
    provider: 'wyscout', external_id: String(p.wyId),
    short_name: fixText(p.shortName), first_name: fixText(p.firstName), middle_name: fixText(p.middleName), last_name: fixText(p.lastName),
    birth_date: nullIfEmpty(p.birthDate), birth_area_code: nullIfEmpty(p.birthArea?.alpha3code), passport_area_code: nullIfEmpty(p.passportArea?.alpha3code),
    foot: ['left', 'right', 'both'].includes(p.foot) ? p.foot : null,
    height_cm: p.height > 0 ? p.height : null, weight_kg: p.weight > 0 ? p.weight : null,
    primary_role: ROLE[p.role?.code2] || null,
  }));
}

export function parseCoaches(json) {
  return json.map(c => ({
    provider: 'wyscout', external_id: String(c.wyId), short_name: fixText(c.shortName), first_name: fixText(c.firstName),
    last_name: fixText(c.lastName), birth_date: nullIfEmpty(c.birthDate), passport_area_code: nullIfEmpty(c.passportArea?.alpha3code),
  }));
}

// matches_<Area>.json
export function parseMatches(json) {
  return json.map(m => {
    const sides = Object.values(m.teamsData || {});
    const home = sides.find(s => s.side === 'home');
    const away = sides.find(s => s.side === 'away');
    if (!home || !away) throw new Error(`wyscout match ${m.wyId}: missing home/away side`);
    const lineup = side => {
      const f = side.formation || {};
      const arr = v => (Array.isArray(v) ? v : []); // the export writes "null" strings for empty lists
      const starters = arr(f.lineup).map(p => String(p.playerId));
      const bench = arr(f.bench).map(p => String(p.playerId));
      const subs = arr(f.substitutions).filter(s => s.playerIn && s.playerOut)
        .map(s => ({ player_in: String(s.playerIn), player_out: String(s.playerOut), minute: Number.isFinite(s.minute) ? s.minute : null }));
      return { team_external_id: String(side.teamId), coach_external_id: side.coachId ? String(side.coachId) : null, has_formation: side.hasFormation === 1, starters, bench, substitutions: subs };
    };
    return {
      provider: 'wyscout', external_id: String(m.wyId),
      competition_external_id: String(m.competitionId), season_external_id: String(m.seasonId),
      round_external_id: String(m.roundId), gameweek: Number.isFinite(m.gameweek) && m.gameweek > 0 ? m.gameweek : null,
      kickoff_utc: m.dateutc ? new Date(m.dateutc.replace(' ', 'T') + 'Z').toISOString() : null,
      label: fixText(m.label), status: m.status === 'Played' ? 'finished' : 'unknown',
      duration: m.duration === 'Regular' ? 'regular' : m.duration === 'ExtraTime' ? 'extra_time' : m.duration === 'Penalties' ? 'penalties' : null,
      venue_name: fixText(m.venue),
      home: { ...lineup(home), score: home.score, score_ht: home.scoreHT, score_et: home.scoreET, score_p: home.scoreP },
      away: { ...lineup(away), score: away.score, score_ht: away.scoreHT, score_et: away.scoreET, score_p: away.scoreP },
      winner_external_id: m.winner ? String(m.winner) : null,
      referees: (m.referees || []).map(r => ({ referee_external_id: String(r.refereeId), role: r.role })),
    };
  });
}

// ---- events --------------------------------------------------------------

const PERIOD = { '1H': '1H', '2H': '2H', E1: 'E1', E2: 'E2', P: 'PS' };

// Wyscout (eventId, subEventId) -> canonical (event_type, subtype, set_piece).
// Wyscout has no carry events; "Acceleration" is kept as its own type rather
// than dressed up as a carry.
const SUB = {
  10: ['duel', 'aerial'], 11: ['duel', 'ground_attacking'], 12: ['duel', 'ground_defending'], 13: ['duel', 'ground_loose_ball'],
  20: ['foul', 'foul'], 21: ['foul', 'hand_ball'], 22: ['foul', 'late_card'], 23: ['foul', 'out_of_game'], 24: ['foul', 'protest'],
  25: ['foul', 'simulation'], 26: ['foul', 'time_lost'], 27: ['foul', 'violent'],
  30: ['pass', 'corner', 'corner'], 31: ['pass', 'free_kick', 'free_kick'], 32: ['pass', 'cross', 'free_kick'],
  33: ['shot', 'free_kick', 'free_kick'], 34: ['pass', 'goal_kick', 'goal_kick'], 35: ['shot', 'penalty', 'penalty'], 36: ['pass', 'throw_in', 'throw_in'],
  50: ['interruption', 'ball_out'], 51: ['interruption', 'whistle'],
  70: ['acceleration', 'acceleration'], 71: ['clearance', 'clearance'], 72: ['touch', 'touch'],
  80: ['pass', 'cross'], 81: ['pass', 'hand_pass'], 82: ['pass', 'head_pass'], 83: ['pass', 'high_pass'], 84: ['pass', 'launch'], 85: ['pass', 'simple'], 86: ['pass', 'smart'],
  90: ['save', 'reflexes'], 91: ['save', 'save_attempt'],
  100: ['shot', 'open_play'],
};
const EVENT_ONLY = { 6: ['offside', 'offside'], 4: ['keeper_exit', 'keeper_exit'] };

export function mapEventType(eventId, subEventId) {
  const s = SUB[Number(subEventId)];
  if (s) return { event_type: s[0], subtype: s[1], set_piece: s[2] || null };
  const e = EVENT_ONLY[Number(eventId)];
  if (e) return { event_type: e[0], subtype: e[1], set_piece: null };
  return null;
}

const T = {
  GOAL: 101, OWN_GOAL: 102, ASSIST: 301, KEY_PASS: 302, LEFT: 401, RIGHT: 402, HEAD_BODY: 403,
  RED: 1701, YELLOW: 1702, SECOND_YELLOW: 1703, ACCURATE: 1801, NOT_ACCURATE: 1802, WON: 703, LOST: 701, NEUTRAL: 702,
  COUNTER: 1901, BLOCKED: 2101, INTERCEPTION: 1401,
};

function outcomeOf(event_type, tags) {
  if (tags.has(T.GOAL) && event_type === 'shot') return 'goal';
  if (event_type === 'duel') return tags.has(T.WON) ? 'won' : tags.has(T.LOST) ? 'lost' : tags.has(T.NEUTRAL) ? 'neutral' : null;
  if (tags.has(T.ACCURATE)) return event_type === 'shot' ? 'on_target' : 'success';
  if (tags.has(T.NOT_ACCURATE)) return event_type === 'shot' ? (tags.has(T.BLOCKED) ? 'blocked' : 'off_target') : 'fail';
  return null;
}

// events_<Area>.json -> canonical-ready event records, ordered and sequenced
// per match. `sequence` is the event's 1-based position within its match after
// a stable sort on (period, eventSec, source id).
export function parseEvents(json) {
  const byMatch = new Map();
  for (const e of json) {
    const list = byMatch.get(e.matchId) || [];
    list.push(e);
    byMatch.set(e.matchId, list);
  }
  const out = [];
  const unmapped = new Map();
  const PORDER = { '1H': 1, '2H': 2, E1: 3, E2: 4, P: 5 };
  for (const [matchId, list] of byMatch) {
    list.sort((a, b) => (PORDER[a.matchPeriod] - PORDER[b.matchPeriod]) || (a.eventSec - b.eventSec) || (a.id - b.id));
    let seq = 0;
    for (const e of list) {
      seq += 1;
      const mapped = mapEventType(e.eventId, e.subEventId);
      if (!mapped) {
        const k = `${e.eventId}/${e.subEventId}`;
        unmapped.set(k, (unmapped.get(k) || 0) + 1);
      }
      const tags = new Set((e.tags || []).map(t => t.id));
      const [p0, p1] = e.positions || [];
      const period = PERIOD[e.matchPeriod] || null;
      const type = mapped?.event_type || 'unmapped';
      const start = p0 ? toCanonical(WYSCOUT_COORDS, p0.x, p0.y) : { x_m: null, y_m: null };
      // Wyscout shot "end" positions are not goal-mouth locations (they are
      // placeholder 0/100 corners or the next event's origin), so no canonical
      // end point is derived for shots. The source value is still kept.
      const end = p1 && type !== 'shot' ? toCanonical(WYSCOUT_COORDS, p1.x, p1.y) : { x_m: null, y_m: null };
      const card = tags.has(T.RED) ? 'red' : tags.has(T.SECOND_YELLOW) ? 'second_yellow' : tags.has(T.YELLOW) ? 'yellow' : null;
      out.push({
        provider: 'wyscout', source_event_id: String(e.id), match_external_id: String(matchId), sequence: seq,
        team_external_id: String(e.teamId), player_external_id: e.playerId ? String(e.playerId) : null,
        period, clock_seconds: Math.round(e.eventSec * 1000) / 1000,
        minute: period ? footballMinute(period, e.eventSec) : null,
        event_type: type, subtype: mapped?.subtype || `wyscout_${e.eventId}_${e.subEventId}`, set_piece: mapped?.set_piece || null,
        outcome: outcomeOf(type, tags),
        body_part: tags.has(T.HEAD_BODY) ? 'head_or_body' : tags.has(T.LEFT) ? 'left_foot' : tags.has(T.RIGHT) ? 'right_foot' : null,
        under_pressure: null, // not present in this dataset; never inferred
        is_goal: type === 'shot' && tags.has(T.GOAL),
        is_own_goal: tags.has(T.OWN_GOAL),
        is_assist: tags.has(T.ASSIST), is_key_pass: tags.has(T.KEY_PASS), is_counter: tags.has(T.COUNTER),
        card,
        source_x: p0 ? p0.x : null, source_y: p0 ? p0.y : null, source_end_x: p1 ? p1.x : null, source_end_y: p1 ? p1.y : null,
        source_coordinate_system: WYSCOUT_COORDS,
        x_m: start.x_m, y_m: start.y_m, end_x_m: end.x_m, end_y_m: end.y_m,
        tags: [...tags].sort((a, b) => a - b),
        raw: e,
      });
    }
  }
  return { events: out, unmapped: Object.fromEntries(unmapped) };
}
