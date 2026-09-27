// Publication gates. An article publishes only if every gate passes against its
// frozen packet. Gates never edit text; they return pass/fail with reasons.

export const GATE_VERSION = 'soccer-gates/1.0.0';

const NUMBER_WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

// Every numeric leaf of the packet, plus numbers inside its strings (dates,
// "6-0" scores). Ordinals are checked on their integer.
export function packetNumbers(packet) {
  const out = new Set();
  const add = n => { if (Number.isFinite(n)) { out.add(String(n)); out.add(String(Math.round(n * 10) / 10)); } };
  // Identifiers (uuids, hashes, capture ids, slugs) are not facts: their digits
  // must never make a printed number look grounded.
  const SKIP = new Set(['id', 'hash', 'event_id', 'capture_id', 'slug']);
  const walk = (v, key = null) => {
    if (v === null || v === undefined || SKIP.has(key)) return;
    if (typeof v === 'number') return add(v);
    if (typeof v === 'string') { for (const m of stripIdentifiers(v).matchAll(/\d+(?:\.\d+)?/g)) add(Number(m[0])); return; }
    if (Array.isArray(v)) return v.forEach(x => walk(x));
    if (typeof v === 'object') Object.entries(v).forEach(([k, x]) => walk(x, k));
  };
  walk(packet);
  return out;
}

export function stripIdentifiers(s) {
  return s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ' ').replace(/\b[0-9a-f]{12,}\b/gi, ' ');
}

function articleText(a) {
  return [a.headline, a.dek, ...a.sections.flatMap(s => [s.heading, ...s.paragraphs])].join('\n');
}

const BANNED = [
  ['unsupported_quote', /[“”]|\b(said|told reporters|admitted|insisted|according to (the )?(coach|manager|player))\b/i],
  ['unsupported_medical', /\b(injur|hamstring|knock|fitness doubt|ruled out|sidelined|concussion)/i],
  ['unsupported_market', /\b(odds|bet(s|ting)?|wager|spread|moneyline|bookmaker|value pick|lock of)\b/i],
  ['unsupported_record', /\b(record|first time|all-time|historic|best ever|worst ever|unprecedented)\b/i],
  ['unsupported_mentality', /\b(wanted it more|hungrier|lacked desire|mentality|bottled|choked)\b/i],
  ['unpublished_metric', /\b(xg|expected goals|xt|expected threat|possession value|field tilt|ppda)\b/i],
  ['unsupported_possession', /\bpossession\b/i],
  ['cliche', /\b(game of two halves|at the end of the day|showed their class|statement win|put on a clinic)\b/i],
];

const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ORD = n => Number(String(n).replace(/(st|nd|rd|th)$/, ''));

export function checkClaims(text, packet) {
  const wrong = [];
  const expect = (label, got, want) => { if (Number(got) !== Number(want)) wrong.push(`${label}: text ${got}, packet ${want}`); };
  for (const side of ['home', 'away']) {
    const T = reEsc(packet.teams[side].name);
    const s = packet.stats[side];
    for (const m of text.matchAll(new RegExp(`${T} had (\\d+) shots, (\\d+) on target`, 'g'))) { expect(`${side} shots`, m[1], s.shots); expect(`${side} shots_on_target`, m[2], s.shots_on_target); }
    for (const m of text.matchAll(new RegExp(`; ${T} had (\\d+), (\\d+) on target`, 'g'))) { expect(`${side} shots`, m[1], s.shots); expect(`${side} shots_on_target`, m[2], s.shots_on_target); }
    for (const m of text.matchAll(new RegExp(`${T}(?:'s)? (?:completed )?(\\d+) of (\\d+)(?: passes)? \\((\\d+(?:\\.\\d+)?)%\\)`, 'g'))) {
      expect(`${side} passes_completed`, m[1], s.passes_completed); expect(`${side} passes`, m[2], s.passes); expect(`${side} pass_completion_pct`, m[3], s.pass_completion_pct);
    }
    for (const m of text.matchAll(new RegExp(`(?:Duels: ${T} won|, ${T}) (\\d+) of (\\d+)(?=\\.)`, 'g'))) { expect(`${side} duels_won`, m[1], s.duels_won); expect(`${side} duels`, m[2], s.duels); }
    for (const m of text.matchAll(new RegExp(`${T} (?:stayed (\\d+(?:st|nd|rd|th))|moved from (\\d+(?:st|nd|rd|th)) to (\\d+(?:st|nd|rd|th))) on (\\d+) points after (\\d+) matches`, 'g'))) {
      const t = packet.teams[side];
      if (m[1]) { expect(`${side} position`, ORD(m[1]), t.table_after.position); expect(`${side} position_before`, ORD(m[1]), t.table_before.position); }
      else { expect(`${side} position_before`, ORD(m[2]), t.table_before.position); expect(`${side} position`, ORD(m[3]), t.table_after.position); }
      expect(`${side} points`, m[4], t.table_after.points); expect(`${side} played`, m[5], t.table_after.played);
    }
  }
  const st = packet.stats;
  for (const m of text.matchAll(/Corners (\d+)-(\d+); fouls (\d+)-(\d+)/g)) {
    expect('home corners', m[1], st.home.corners); expect('away corners', m[2], st.away.corners);
    expect('home fouls', m[3], st.home.fouls_committed); expect('away fouls', m[4], st.away.fouls_committed);
  }
  for (const m of text.matchAll(/Half-time (\d+)-(\d+)|led (\d+)-(\d+) at half-time/g)) {
    const [h, a] = m[1] !== undefined ? [m[1], m[2]] : [m[3], m[4]];
    const want = [packet.match.score.home_ht, packet.match.score.away_ht];
    const ok = (Number(h) === want[0] && Number(a) === want[1]) || (m[3] !== undefined && Number(h) === want[1] && Number(a) === want[0]);
    if (!ok) wrong.push(`half-time: text ${h}-${a}, packet ${want.join('-')}`);
  }
  return wrong;
}

export function runGates(article, packet, { requiredAttributions = [] } = {}) {
  const text = articleText(article);
  const results = [];
  const gate = (name, pass, detail = null) => results.push({ gate: name, pass, detail });

  // numeric_grounding: every number in the text is in the packet.
  const allowed = packetNumbers(packet);
  const ungrounded = [];
  for (const m of stripIdentifiers(text).matchAll(/(\d+(?:\.\d+)?)(?:st|nd|rd|th)?/g)) if (!allowed.has(String(Number(m[1])))) ungrounded.push(m[0]);
  for (const m of text.toLowerCase().matchAll(/\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g)) if (!allowed.has(String(NUMBER_WORDS[m[1]]))) ungrounded.push(m[1]);
  gate('numeric_grounding', ungrounded.length === 0, ungrounded.length ? [...new Set(ungrounded)] : null);

  // match_final + score consistency: the headline carries the packet's result.
  gate('match_not_final', packet.match.status === 'finished');
  const hs = packet.match.score;
  const winnerFirst = [hs.home, hs.away].sort((a, b) => b - a).join('-');
  gate('score_in_headline', article.headline.includes(winnerFirst) || article.headline.includes(hs.final), article.headline);
  if (packet.match.winner !== 'draw') {
    const w = packet.teams[packet.match.winner].name;
    const l = packet.teams[packet.match.winner === 'home' ? 'away' : 'home'].name;
    gate('wrong_winner', article.headline.indexOf(w) > -1 && article.headline.indexOf(w) < article.headline.indexOf(l), { winner: w });
  }

  // hat-trick claim needs a 3-goal scorer in the packet.
  if (/hat-trick/i.test(text)) {
    const counts = new Map();
    for (const g of packet.goals) if (!g.own_goal && g.scorer) counts.set(g.scorer.id, (counts.get(g.scorer.id) || 0) + 1);
    gate('hat_trick_grounding', [...counts.values()].some(n => n === 3));
  }

  // entity grounding: every linked entity exists in the packet with the same id and name.
  const known = new Map();
  const put = (id, name) => { if (id) known.set(id, name); };
  put(packet.teams.home.id, packet.teams.home.name); put(packet.teams.away.id, packet.teams.away.name); put(packet.match.id, `${packet.teams.home.name} v ${packet.teams.away.name}`);
  for (const g of packet.goals) { if (g.scorer) put(g.scorer.id, g.scorer.name); if (g.assist) put(g.assist.id, g.assist.name); }
  for (const p of packet.key_performers) put(p.id, p.name);
  const badEntities = article.entities.filter(e => e.id && known.get(e.id) !== e.name).map(e => e.name);
  gate('entity_grounding', badEntities.length === 0, badEntities.length ? badEntities : null);
  gate('entity_headline', article.headline.includes(packet.teams.home.name) && article.headline.includes(packet.teams.away.name));

  // Banned phrases apply to editorial text. The 'method' section is exempt
  // because it must NAME what is unavailable (possession, xG, injuries); it is
  // still numerically grounded above.
  const editorial = articleText({ ...article, sections: article.sections.filter(s => s.key !== 'method') });
  for (const [name, re] of BANNED) { const m = editorial.match(re); gate(name, !m, m ? m[0] : null); }

  // claims_consistency: numbers in known sentence forms must equal the exact
  // packet field they describe — not merely appear somewhere in the packet.
  const wrong = checkClaims(text, packet);
  gate('claims_consistency', wrong.length === 0, wrong.length ? wrong : null);

  gate('too_thin', article.sections.filter(s => s.key !== 'method').length >= 4, article.sections.length);
  gate('headline_length', article.headline.length >= 20 && article.headline.length <= 110, article.headline.length);
  const missingAttr = requiredAttributions.filter(a => !text.includes(a));
  gate('attribution', missingAttr.length === 0, missingAttr.length ? missingAttr : null);
  gate('render_artifact', !/undefined|null|NaN|\[object/.test(text), (text.match(/undefined|null|NaN|\[object/) || [null])[0]);

  const failed = results.filter(r => !r.pass).map(r => r.gate);
  return { version: GATE_VERSION, pass: failed.length === 0, failed, results };
}
