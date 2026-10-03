// PBEcast live match feed: deterministic event descriptions, shot geometry and rolling match
// context (pure; tested in tests/web/pbecast-feed.test.js).
//
// Truth rules:
// - A detail is shown only when the API carries it for THAT event (body part, assist, penalty,
//   provider xG, source situation). Missing fields are omitted, never guessed.
// - Shot distance / "in the box" are PBE derived from the source's event location (canonical
//   105 x 68 m pitch), and say so. Event locations are not tracking.
// - Provider xG keeps its provider's name (ESPN xG), never PBE xG.
// - Context (shot counts, runs, windows, xG totals) uses ONLY the events passed in, which the
//   caller limits to events at or before the moment described: nothing can leak from the future.
// - No possession, momentum, pressure, intent, injury or reason is ever stated.
import { clockAt, isLocated, periodOf, PERIOD_END } from './cast.js';

export const PITCH_L = 105;
export const PITCH_W = 68;
const BOX_DEPTH = 16.5;
const BOX_HALF_WIDTH = 20.16;

export const BODY = { left_foot: 'Left foot', right_foot: 'Right foot', head: 'Header' };
const BODY_FINISH = { left_foot: 'left-footed', right_foot: 'right-footed', head: 'headed' };
// ESPN shotInfo labels, reworded only for case; 'Regular Play' says nothing and is omitted.
export const SITUATION = { 'Fast Break': 'Fast break', 'From Corner': 'From a corner', 'Set Piece': 'Set piece', 'Free Kick': 'Free kick', 'Throw-in Set Piece': 'From a throw-in' };
export const OUTCOME = { goal: 'goal', on_target: 'on target', off_target: 'off target', blocked: 'blocked', post: 'woodwork' };

const isShotRecord = x => x && Object.prototype.hasOwnProperty.call(x, 'outcome') && (x.type === 'shot' || x.type === 'goal');
const isGoal = x => x?.type === 'goal' || x?.type === 'own_goal';
const isCard = x => x?.type === 'card_yellow' || x?.type === 'card_red';
const sideOf = x => (x?.team === 'away' ? 'away' : x?.team === 'home' ? 'home' : null);
const other = s => (s === 'home' ? 'away' : 'home');
const teamOf = (m, s) => (s === 'away' ? m?.away : m?.home);
export const teamName = (m, s) => { const t = teamOf(m, s); return t?.short_name || t?.name || (s === 'away' ? 'Away' : 'Home'); };
const surname = p => { const n = String(p?.name || '').trim(); return n ? n.split(/\s+/).slice(-1)[0] : ''; };
const ord = n => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')}`;
const NUM_WORD = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const words = n => NUM_WORD[n] || String(n);

// ---- source detail joins -------------------------------------------------------------------

// The API's shot_timeline carries the source situation for every shot record, in the same
// source order as the sequence's shot records. Joined only where minute, side and player all
// agree item by item; any disagreement and nothing is joined (no guessing).
export function withShotDetail(sequence = [], shotTimeline = []) {
  const shots = (sequence || []).filter(isShotRecord);
  const st = shotTimeline || [];
  const aligned = shots.length === st.length && shots.every((x, i) => st[i] && st[i].minute === x.minute && st[i].team === x.team && (st[i].player?.id || null) === (x.player?.id || null));
  if (!aligned) return sequence || [];
  let k = 0;
  return sequence.map(x => {
    if (!isShotRecord(x)) return x;
    const s = st[k++];
    return s.situation && !x.situation ? { ...x, situation: s.situation } : x;
  });
}

// ---- geometry (PBE derived from the source location) ---------------------------------------

// Distance from the centre of the goal the shooting side attacks, in the match frame the API
// ships (home attacks x = 105, away attacks x = 0). Shots and goals from shots only: an own goal's
// location is the defender's touch, not an attempt on goal.
export function shotGeometry(x) {
  if (!isShotRecord(x) || !isLocated(x)) return null;
  const s = sideOf(x); if (!s) return null;
  if (x.x < 0 || x.x > PITCH_L || x.y < 0 || x.y > PITCH_W) return null;
  const dx = s === 'home' ? PITCH_L - x.x : x.x;
  const dy = Math.abs(x.y - PITCH_W / 2);
  return { distance_m: Math.round(Math.hypot(dx, dy) * 10) / 10, in_box: dx <= BOX_DEPTH && dy <= BOX_HALF_WIDTH };
}

export function xgOf(x) {
  const g = x?.provider_xg;
  const v = Number(g?.value);
  if (!g || g.value === null || g.value === undefined || !Number.isFinite(v) || !g.provider) return null;
  return { value: v, provider: g.provider, label: g.provider === 'espn' ? 'Supplied xG' : `${String(g.provider).toUpperCase()} xG` };
}

// ---- description -----------------------------------------------------------------------------

// The score immediately before an event: the previous item's running score (0-0 for the first).
export function scoreBefore(x, seen) {
  const at = seen.indexOf(x);
  const prev = at > 0 ? seen[at - 1] : null;
  return prev?.score ? { ...prev.score } : { home: 0, away: 0 };
}

// What a goal did to the score, from the score itself (never a claim about play).
export function scoreSwing(x, seen) {
  if (!isGoal(x) || !x.score) return null;
  const s = sideOf(x); if (!s) return null;
  const b = scoreBefore(x, seen); const a = x.score;
  const before = b[s] - b[other(s)]; const after = a[s] - a[other(s)];
  if (before === 0 && b.home === 0 && b.away === 0) return 'opener';
  if (after === 0) return 'equaliser';
  if (before === 0 && after > 0) return 'lead';
  if (before > 0) return 'extends';
  if (after < 0) return 'pulls_back';
  return null;
}
const SWING_LINE = {
  opener: t => `${t} open the scoring`, equaliser: () => 'Level again', lead: t => `${t} in front`,
  extends: t => `${t} extend the lead`, pulls_back: t => `${t} pull one back`,
};

// Headline, factual detail rows and derived context for one event, given the events seen up to
// and including it (seen must not contain anything later).
export function describe(x, m, seen = [x]) {
  const s = sideOf(x); const T = teamName(m, s); const TU = T.toUpperCase();
  const score = x.score ? `${x.score.home}–${x.score.away}` : '';
  const hn = teamName(m, 'home'); const an = teamName(m, 'away');
  const geo = shotGeometry(x); const xg = xgOf(x);
  const facts = []; const derived = []; let headline; let tone;
  if (x.type === 'goal') {
    tone = 'goal';
    headline = `${x.penalty ? 'PENALTY GOAL' : 'GOAL'} — ${TU} ${score}`;
    if (x.body_part && BODY[x.body_part]) facts.push(BODY[x.body_part]);
    if (x.situation && SITUATION[x.situation]) facts.push(SITUATION[x.situation]);
  } else if (x.type === 'own_goal') {
    tone = 'goal';
    headline = `OWN GOAL — ${TU} ${score}`;
    facts.push(`Own goal · ${teamName(m, other(s))} player`);
  } else if (x.type === 'shot') {
    tone = 'shot';
    headline = x.penalty ? `${TU} PENALTY` : x.outcome === 'on_target' ? `${TU} SHOT ON TARGET` : `${TU} SHOT`;
    if (x.body_part && BODY[x.body_part]) facts.push(BODY[x.body_part]);
    if (OUTCOME[x.outcome]) facts.push(x.penalty && x.outcome === 'on_target' ? 'on target, not scored' : OUTCOME[x.outcome]);
    if (x.situation && SITUATION[x.situation]) facts.push(SITUATION[x.situation]);
  } else if (x.type === 'card_yellow') { tone = 'card'; headline = 'YELLOW CARD'; }
  else if (x.type === 'card_red') {
    tone = 'red'; headline = 'RED CARD';
    const pid = x.player?.id || null;
    const earlier = pid ? seen.find(y => y !== x && y.type === 'card_yellow' && y.player?.id === pid && seen.indexOf(y) < seen.indexOf(x)) : null;
    if (earlier) facts.push(`Booked earlier at ${earlier.display_minute || `${earlier.minute}'`}`);
  } else if (x.type === 'sub') { tone = 'sub'; headline = `${TU} SUBSTITUTION`; }
  else { tone = 'other'; headline = 'EVENT'; }

  const geoText = geo ? `${geo.distance_m.toFixed(1)} m from goal${geo.in_box ? ' · in the box' : ''}` : null;

  // ---- PBE derived context (from `seen` only)
  if (isShotRecord(x) && s) {
    const mine = seen.filter(y => isShotRecord(y) && sideOf(y) === s);
    const n = mine.indexOf(x) + 1;
    const on = mine.slice(0, n).filter(y => y.outcome === 'on_target' || y.outcome === 'goal').length;
    const goals = mine.slice(0, n).filter(y => y.outcome === 'goal').length;
    if (x.outcome === 'goal' && n > 0) derived.push(`${T}: ${goals} ${goals === 1 ? 'goal' : 'goals'} from ${n} recorded ${n === 1 ? 'shot' : 'shots'}`);
    else if (n > 0) derived.push(`${T}'s ${ord(n)} recorded shot · ${on} on target`);
    const run = shotRun(x, seen);
    if (run >= 3) derived.push(`${words(run)} straight recorded shots by ${T}`.replace(/^./, c => c.toUpperCase()));
  }
  const swing = scoreSwing(x, seen);
  if (swing) derived.unshift(SWING_LINE[swing](T));
  return { tone, headline, facts, geo, geoText, xg, derived, score, home: hn, away: an, team: T, side: s };
}

// Consecutive shot records by the same side ending at x (cards and substitutions do not break it).
export function shotRun(x, seen) {
  if (!isShotRecord(x)) return 0;
  const s = sideOf(x); let n = 0;
  for (let i = seen.indexOf(x); i >= 0; i--) {
    const y = seen[i];
    if (!isShotRecord(y)) continue;
    if (sideOf(y) !== s) break;
    n += 1;
  }
  return n;
}

// One deterministic sentence from the event and the ledger before it. No quotes, no intent.
export function callLine(x, m, seen = [x]) {
  const d = describe(x, m, seen);
  const who = surname(x.player) || 'Unidentified player';
  const T = d.team;
  if (x.type === 'goal') {
    const finish = x.penalty ? ' from the penalty spot' : x.body_part && BODY_FINISH[x.body_part] ? ` with a ${BODY_FINISH[x.body_part]} finish` : '';
    const set = x.assist ? `, set up by ${surname(x.assist)}` : '';
    const swing = scoreSwing(x, seen);
    return `${who} scores${finish}${set}.${swing ? ` ${SWING_LINE[swing](T)}, ${d.score}.` : ` ${d.score}.`}`;
  }
  if (x.type === 'own_goal') {
    const swing = scoreSwing(x, seen);
    return `Own goal${x.player?.name ? ` by ${x.player.name}` : ''}, counted for ${T}.${swing ? ` ${SWING_LINE[swing](T)}, ${d.score}.` : ` ${d.score}.`}`;
  }
  if (x.type === 'shot') {
    const what = x.penalty ? (x.outcome === 'on_target' ? 'penalty is on target but not scored' : x.outcome === 'off_target' ? 'penalty misses the target' : 'penalty is not scored')
      : x.outcome === 'on_target' ? 'hits the target' : x.outcome === 'blocked' ? 'has a shot blocked' : x.outcome === 'post' ? 'hits the woodwork' : x.outcome === 'off_target' ? 'misses the target' : 'shoots';
    const subject = x.penalty ? `${who}'s` : who;
    const recent = windowCount(seen, x, 10);
    const tail = recent.shots >= 3 ? ` ${T}: ${words(recent.shots)} shots in the last ${recent.span} ${recent.span === 1 ? 'minute' : 'minutes'}.` : '';
    return `${subject} ${what}${d.geo ? ` from ${Math.round(d.geo.distance_m)} m` : ''}.${tail}`;
  }
  if (x.type === 'card_yellow') return `${x.player?.name || 'A player'} is booked.`;
  if (x.type === 'card_red') return `${x.player?.name || 'A player'} is sent off.`;
  if (x.type === 'sub') return `${T} change: ${x.player_in?.name || 'unidentified'} on, ${x.player_out?.name || 'unidentified'} off.`;
  return '';
}

// Shots by x's side in the `minutes` before x (virtual axis, inclusive), and the span they cover.
function windowCount(seen, x, minutes) {
  const s = sideOf(x);
  if (x.v === null || x.v === undefined) return { shots: 0, span: 0 };
  const inWin = seen.filter(y => isShotRecord(y) && sideOf(y) === s && y.v !== null && y.v !== undefined && y.v <= x.v && y.v >= x.v - minutes);
  const span = inWin.length ? Math.max(1, Math.round(x.v - Math.min(...inWin.map(y => y.v)))) : 0;
  return { shots: inWin.length, span };
}

// ---- match pulse ------------------------------------------------------------------------------

// Rolling and cumulative counts from the recorded events seen at cursor v. `hasShotRecord` says
// whether this match's event source records shots at all (a goals-only source gets no pulse).
export function matchPulse(seen, v, tl, { window = 10 } = {}) {
  const shots = seen.filter(isShotRecord);
  const hasShotRecord = (tl?.items || seen).some(isShotRecord);
  const from = Math.max(0, v - window);
  const side = s => {
    const all = shots.filter(y => sideOf(y) === s);
    const win = all.filter(y => y.v !== null && y.v !== undefined && y.v > from && y.v <= v);
    const located = all.map(shotGeometry).filter(Boolean);
    const xgs = all.map(xgOf);
    const xgComplete = all.length > 0 && xgs.every(Boolean);
    return {
      window: { shots: win.length, on_target: win.filter(y => y.outcome === 'on_target' || y.outcome === 'goal').length },
      match: { shots: all.length, on_target: all.filter(y => y.outcome === 'on_target' || y.outcome === 'goal').length, goals: seen.filter(y => isGoal(y) && sideOf(y) === s).length },
      avg_distance_m: located.length ? Math.round(10 * located.reduce((a, g) => a + g.distance_m, 0) / located.length) / 10 : null,
      located: located.length,
      xg: xgComplete ? { total: Math.round(1000 * xgs.reduce((a, g) => a + g.value, 0)) / 1000, label: xgs[0].label } : null,
      xg_partial: !xgComplete && xgs.some(Boolean) ? xgs.filter(Boolean).length : 0,
    };
  };
  return {
    hasShotRecord, window, from, to: v,
    label: tl ? `${clockAt(from, tl)}–${clockAt(v, tl)}` : '',
    home: side('home'), away: side('away'),
    cards: { home: seen.filter(y => isCard(y) && sideOf(y) === 'home').length, away: seen.filter(y => isCard(y) && sideOf(y) === 'away').length },
  };
}

// ---- live cursor ------------------------------------------------------------------------------

// The virtual-axis position of the provider's live clock ("63'", "45'+2'", "90+4'"), never behind
// the latest recorded event. Unparseable clocks (HT, FT, none) fall back to the latest event.
export function liveCursor(tl, displayClock) {
  // tl.total is at least the period's nominal end (90'), so live uses the latest PLACED event instead.
  const placed = tl.items.filter(x => x.v !== null && x.v !== undefined).map(x => x.v);
  const last = placed.length ? Math.max(...placed) : 0;
  const mm = /^\s*(\d{1,3})'?\s*(?:\+\s*(\d{1,2})'?)?/.exec(String(displayClock || ''));
  if (!mm) return last;
  const base = Number(mm[1]); const extra = mm[2] ? Number(mm[2]) : 0;
  const ends = Object.entries(PERIOD_END).filter(([p]) => p !== 'PS');
  const period = extra ? (ends.find(([, e]) => e === base)?.[0] || periodOf({ minute: base })) : periodOf({ minute: base });
  const seg = tl.segments.find(s => s.period === period);
  if (!seg) return last;
  return Math.max(last, base + extra + seg.shift);
}

// ---- feed filters ---------------------------------------------------------------------------------

export const FEED_FILTERS = [
  ['all', 'All events', () => true],
  ['shots', 'Shots', x => isShotRecord(x)],
  ['goals', 'Goals', x => isGoal(x)],
  ['cards', 'Cards', x => isCard(x)],
  ['subs', 'Subs', x => x.type === 'sub'],
];
export const filterFn = key => (FEED_FILTERS.find(f => f[0] === key) || FEED_FILTERS[0])[2];
export const feedCounts = items => Object.fromEntries(FEED_FILTERS.map(([k, , f]) => [k, items.filter(f).length]));
