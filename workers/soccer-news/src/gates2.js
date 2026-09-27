// Publication gates v2 (all story classes). Gates never edit text: pass/fail with
// reasons. The SAME gates run on a template article and on any LLM-edited article.
import { stripIdentifiers } from './gates.js';
import { PROFILES } from './profiles.js';

export const GATE_V2 = 'soccer-gates/2.0.0';
const NUMBER_WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

const GLOBAL_BANNED = [
  ['unsupported_quote', /[“”"]|\b(said|says|told reporters|admitted|insisted|according to)\b/i],
  ['unsupported_medical', /\b(injur\w*|hamstring|knock|fitness doubt|ruled out|sidelined|concussion|suspended|suspension)\b/i],
  ['unsupported_transfer', /\b(transfer|rumou?r\w*|linked with|bid for|signing target|contract talks)\b/i],
  ['unsupported_market', /\b(odds|bet(s|ting)?|wager|spread|moneyline|bookmaker|sportsbook|value pick|lock of)\b/i],
  ['unsupported_record', /\b(record|first time|all-time|historic\w*|best ever|worst ever|unprecedented)\b/i],
  ['unsupported_mentality', /\b(wanted it more|hungr\w*|lacked desire|mentality|bottled|choked|confiden\w*|frustrat\w*|pressure mounts)\b/i],
  ['unpublished_metric', /\b(xg|expected goals|xt|expected threat|possession value|field tilt|ppda)\b/i],
  ['unsupported_possession', /\bpossession\b/i],
  ['cliche', /\b(game of two halves|at the end of the day|showed their class|statement win|put on a clinic)\b/i],
];

// Numbers a story may print. ISO dates contribute only their day-of-month and year
// (so "20 September 2026" is grounded) — never the month number, which would let a
// stray "9" pass. Identifier fields contribute nothing.
const ISO = /\b(\d{4})-(\d{2})-(\d{2})(?:T[\d:.]+Z?)?\b/g;
const SKIP_KEYS = new Set(['id', 'hash', 'event_id', 'capture_id', 'slug', 'key', 'match_id', 'version', 'engine']);
export function packetNumbers2(packet) {
  const out = new Set();
  const add = n => { if (Number.isFinite(n)) { out.add(String(n)); out.add(String(Math.round(n * 10) / 10)); } };
  const walk = (v, key = null) => {
    if (v === null || v === undefined || SKIP_KEYS.has(key)) return;
    if (typeof v === 'number') return add(v);
    if (typeof v === 'string') {
      const rest = stripIdentifiers(v).replace(ISO, (_, y, _m, d) => { add(Number(y)); add(Number(d)); return ' '; });
      for (const m of rest.matchAll(/\d+(?:\.\d+)?/g)) add(Number(m[0]));
      return;
    }
    if (Array.isArray(v)) return v.forEach(x => walk(x));
    if (typeof v === 'object') Object.entries(v).forEach(([k, x]) => walk(x, k));
  };
  walk(packet);
  return out;
}

const text = a => [a.headline, a.dek, ...a.sections.flatMap(s => [s.heading, ...s.paragraphs])].join('\n');
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ORD = s => Number(String(s).replace(/(st|nd|rd|th)$/, ''));

// Every entity id the packet knows, with its exact name.
function packetEntities(p) {
  const known = new Map();
  const walk = v => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach(walk);
    if (v.id && v.name && (v.slug || v.slug === null)) known.set(v.id, v.name);
    Object.values(v).forEach(walk);
  };
  walk(p);
  if (p.match && p.teams) known.set(p.match.id, `${p.teams.home.name} v ${p.teams.away.name}`);
  return known;
}

function claims(t, p) {
  const wrong = [];
  const want = (label, got, exp) => { if (exp === undefined || exp === null || Number(got) !== Number(exp)) wrong.push(`${label}: text ${got}, packet ${exp}`); };
  const teams = p.teams ? [['home', p.teams.home], ['away', p.teams.away]] : [];
  for (const [side, tm] of teams) {
    const T = reEsc(tm.name);
    for (const m of t.matchAll(new RegExp(`${T} (?:stayed (\\d+(?:st|nd|rd|th))|moved from (\\d+(?:st|nd|rd|th)) to (\\d+(?:st|nd|rd|th))) in the [^.]+? on (\\d+) points? from (\\d+) match`, 'g'))) {
      if (m[1]) { want(`${side} position`, ORD(m[1]), tm.table_after?.position); want(`${side} position_before`, ORD(m[1]), tm.table_before?.position); }
      else { want(`${side} position_before`, ORD(m[2]), tm.table_before?.position); want(`${side} position`, ORD(m[3]), tm.table_after?.position); }
      want(`${side} points`, m[4], tm.table_after?.points); want(`${side} played`, m[5], tm.table_after?.played);
    }
    if (p.stats) for (const m of t.matchAll(new RegExp(`(?:^|; )${T} had (\\d+)(?: shots)?(?: \\((\\d+) on target\\))?`, 'gm'))) { want(`${side} shots`, m[1], p.stats[side]?.shots); if (m[2]) want(`${side} on target`, m[2], p.stats[side]?.shots_on_target); }
  }
  if (p.match) {
    const s = p.match.score; const hi = Math.max(s.home, s.away); const lo = Math.min(s.home, s.away);
    for (const m of t.matchAll(/Half-time (\d+)-(\d+)/g)) if (Number(m[1]) !== s.home_ht || Number(m[2]) !== s.away_ht) wrong.push(`half-time ${m[1]}-${m[2]}`);
    if (!p.goals?.length && /\bGoals\b/.test(t) && hi > 0) wrong.push('goal section without goals');
    if (/hat-trick/i.test(t) && !p.goals.some(g => !g.own_goal && g.scorer && p.goals.filter(x => !x.own_goal && x.scorer?.id === g.scorer.id).length === 3)) wrong.push('hat-trick without a three-goal scorer');
    if (/\b(trailed|came from behind|comeback)\b/i.test(t) && !p.angles.some(a => a.key === 'comeback_from_ht')) wrong.push('comeback claim without half-time deficit');
    if (/\btop of the\b/i.test(t) && !p.angles.some(a => /leader_change/.test(a.key))) wrong.push('top-of-table claim without a leader change');
    void lo;
  }
  if (p.trend) {
    for (const m of t.matchAll(/last (\d+) league matches/g)) want('trend matches', m[1], p.trend.matches);
    for (const m of t.matchAll(/scoring (\d+) and conceding (\d+)/g)) { want('trend gf', m[1], p.trend.goals_for); want('trend ga', m[2], p.trend.goals_against); }
  }
  if (p.form) for (const m of t.matchAll(/scored in (\d+) (?:straight|consecutive)/g)) want('scoring run', m[1], p.form.consecutive_scoring_appearances);
  if (p.table) for (const m of t.matchAll(/lead the [^.]+? by (\d+) points?/g)) want('leader gap', m[1], p.table.leader_gap);
  return wrong;
}

export function runGates2(article, packet) {
  const t = text(article);
  const results = [];
  const gate = (name, pass, detail = null) => results.push({ gate: name, pass, detail });
  const allowed = packetNumbers2(packet);
  const ungrounded = [];
  // Version identifiers ("soccer-packet/2.0.0") are not facts: strip before extracting numbers.
  for (const m of stripIdentifiers(t.replace(/[a-z][a-z-]*\/\d+(?:\.\d+)+/gi, ' ').replace(/\b\d{4}-\d{2}-\d{2}\b/g, d => (JSON.stringify(packet).includes(d) ? ' ' : d))).matchAll(/(\d+(?:\.\d+)?)(?:st|nd|rd|th)?/g)) if (!allowed.has(String(Number(m[1])))) ungrounded.push(m[0]);
  for (const m of t.toLowerCase().matchAll(/\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g)) if (!allowed.has(String(NUMBER_WORDS[m[1]])) && !/top four|bottom three/.test(t.toLowerCase().slice(Math.max(0, m.index - 7), m.index + 8))) ungrounded.push(m[1]);
  gate('numeric_grounding', ungrounded.length === 0, ungrounded.length ? [...new Set(ungrounded)] : null);

  const known = packetEntities(packet);
  const bad = article.entities.filter(e => e.id && known.get(e.id) !== e.name).map(e => e.name);
  gate('entity_grounding', bad.length === 0, bad.length ? bad : null);

  const editorial = text({ ...article, sections: article.sections.filter(s => s.key !== 'method') });
  for (const [name, re] of GLOBAL_BANNED) { const m = editorial.match(re); gate(name, !m, m ? m[0] : null); }
  const profile = PROFILES[packet.event.profile];
  for (const [name, re] of profile?.banned || []) { const m = editorial.match(re); gate(name, !m, m ? m[0] : null); }

  const wrong = claims(t, packet);
  gate('claims_consistency', wrong.length === 0, wrong.length ? wrong : null);
  if (packet.match) {
    gate('match_final', packet.match.status === 'finished');
    const s = packet.match.score;
    gate('score_in_headline', article.headline.includes(`${Math.max(s.home, s.away)}-${Math.min(s.home, s.away)}`) || article.headline.includes(s.final), article.headline);
    if (packet.match.winner !== 'draw') { const w = packet.teams[packet.match.winner].name; const l = packet.teams[packet.match.winner === 'home' ? 'away' : 'home'].name; gate('wrong_winner', article.headline.indexOf(w) > -1 && article.headline.indexOf(w) < article.headline.indexOf(l)); }
  }
  const body = article.sections.filter(s => s.key !== 'method');
  gate('too_thin', body.length >= 3, body.length);
  gate('headline_length', article.headline.length >= 20 && article.headline.length <= 110, article.headline.length);
  const missing = packet.provenance.attributions.filter(a => !t.includes(a));
  gate('attribution', missing.length === 0, missing.length ? missing : null);
  gate('render_artifact', !/undefined|\bnull\b|NaN|\[object/.test(t), (t.match(/undefined|\bnull\b|NaN|\[object/) || [null])[0]);
  gate('method_section', article.sections.some(s => s.key === 'method'));
  const failed = results.filter(r => !r.pass).map(r => r.gate);
  return { version: GATE_V2, pass: failed.length === 0, failed, results };
}
