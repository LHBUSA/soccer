// WORLD-CLASS EDITORIAL DESK (soccer-news). The house newsroom architecture (UFC / PropBetEdge):
//   detection -> FROZEN packet -> deterministic draft (evidence, never the public story)
//   -> desk (the model rewrites and restructures, using the packet and nothing else)
//   -> grounded validation (numbers, names, dates, URLs, scores, winner, banned claims)
//   -> editorial quality gates (no template opening, no stat recitation, depth, no filler)
//   -> PUBLISH, or HOLD. There is no template fallback for public copy: quality over volume.
// One repair attempt: the failed gates are quoted back to the desk once; a second failure holds.
import { packetNumbers2 } from './gates2.js';
import { stripIdentifiers } from './gates.js';
import { PROFILES } from './profiles.js';

export const DESK_VERSION = 'soccer-desk/2.0.0'; // 2.0.0: depth contract (packet v3), evidence-family + repetition gates
export const QUALITY_VERSION = 'soccer-quality/2.0.0';
export const DESK_MODEL = 'gpt-5.6-sol'; // OpenAI Responses API; override with NEWS_DESK_MODEL
export const DESK_API = 'https://api.openai.com/v1/responses';
export const deskRequired = env => env?.NEWS_DESK !== 'off'; // default: required for every new story
export const deskAvailable = env => !!env?.OPENAI_API_KEY;

export const SYSTEM = `You are the senior editor of PropBetEdge Soccer, a premium football intelligence newsroom.
Write like a top-tier sports and data magazine, not a database template.

You receive a FROZEN FACT PACKET (the only source of truth) and a mechanical DRAFT built from it.
Rewrite the story from scratch for readers who love football. Synthesise; never recite.

The packet's "depth" block is structured match texture you should use: phases (goals and shot events by half and
by 15-minute bucket), goal_sequence (opening goal, half-time score, first second-half goal, intervals, goals after
60 and 70 minutes), player_lines (goals, assists, shots, shots on target, shots inside the box per player),
shot_profile (totals, on-target %, share of shots, goals per shot, located shots inside/outside the box, average
located distance), table_move (position before/after, change, points, played), recent_league_results (up to five),
discipline and substitutions (use only when they matter to the story). These are counts and sequences, not
judgements: never call them momentum, dominance, pressure, chance quality or xG.

For a rich match report, cover these editorial objectives in whatever order and structure serves the story:
A. the lead: who won, the main player or match angle, and how the match became that story;
B. how the match developed, told through the actual event sequence (when the goals came, the half-time position,
   what changed after the break);
C. the decisive players, using their sourced contributions (goals, assists, shots, shots on target);
D. the meaningful statistical contrast (shots, on target, corners, saves, shot locations/distance);
E. what the result changed: table movement, recent form, and the next fixture when the packet carries one
   (opponent, competition, date only; no preview analysis).
Do not use A-E as headings. Write 3 to 5 sections with specific, story-led headings (never generic labels such as
"Result", "Goals", "Why it matters", "Shots", "The numbers", "Table and form", "What happened"), normally two or more
paragraphs each. Rich packets usually support 650-950 useful words; write less when the packet is thinner. Never pad.

Synthesis, not recitation. Weak: "Harry Kane scored 2. Michael Olise scored 3. Bayern had 23 shots. Union had 3."
Better: "Olise supplied three of Bayern's seven goals and Kane added two, their finishing turning a 3-0 half-time
lead into a rout, while a 23-3 edge in shots showed how little room Union had to change the scoreline."
- State the final score in the headline or dek and at most once more in the body. Do not restate each player's goal
  total in several sections. Never write "The match produced X goals" or "The winning margin was X goals".
- Lead: not "Team A beat Team B X-Y on DATE." Name the winner, the main angle and why the match became the story.
  The date belongs in metadata unless it matters editorially.
- Dek: add information beyond the headline (player angle, how the match developed, table consequence) in one sentence.
- Headline: the material angle when one exists ("Olise hat-trick powers Bayern past Union Berlin in 7-0 rout"),
  not the bare "Team A beat Team B 7-0".
- Phase buckets are evidence, not copy: write "between the 16th and 30th minutes", never "the 16-30 minute spell".
- Summarise recent form as a pattern ("unbeaten in their opening four", "a draw and two defeats before this trip")
  instead of listing every previous score; name one earlier result only when it adds something.
- Do not stack statistics: no more than two numbers-heavy paragraphs in a row. Interpret, then move on.
- Short, varied paragraphs. Natural transitions.
- Write natural newsroom prose with complete noun phrases: "Bayern's goalkeeper made two saves", never "with Bayern goalkeeper required to make 2 saves". Spell out numbers one to nine in running prose, as a newspaper would ("two goals", "fourth to first"); keep digits for scores, minutes and larger figures.
- No empty verdicts ("clearest statement yet", "sent a message", "a night to remember"); let specific match evidence carry the point.

Hard rules (a violation means the story is not published):
- Use ONLY facts in the packet. Every number, name, date and score you write must be in the packet.
- Never invent: quotes, injuries, suspensions, transfers, rumours, odds or betting, xG or expected goals, possession unless the packet carries it, tactics or formations not in the packet, player or manager intent, emotions or mental state, records or "historic"/"first time"/"all-time" claims.
- Refer to players and teams only by names that appear in the packet (you may use the short team name given in the packet).
- Write out no URLs. Do not mention PropBetEdge's pipeline, packets, hashes or gates; source notes are published separately.
- Keep the final score in the headline or the dek of a match story, and name the winner correctly.

Return JSON only, no prose around it:
{"headline": "...", "dek": "...", "sections": [{"heading": "...", "paragraphs": ["...", "..."]}]}`;

// ---------------------------------------------------------------- model call
// Structured output: the Responses API must return exactly this shape (strict JSON schema).
export const ARTICLE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['headline', 'dek', 'sections'],
  properties: {
    headline: { type: 'string' }, dek: { type: 'string' },
    sections: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['heading', 'paragraphs'], properties: { heading: { type: 'string' }, paragraphs: { type: 'array', items: { type: 'string' } } } } },
  },
};

// Error text that may reach a hold reason or a log: the key, any bearer token and any sk- key are redacted.
export function sanitizeDeskError(s, env) {
  let t = String(s || '');
  const key = env?.OPENAI_API_KEY;
  if (key && key.length >= 4) t = t.split(key).join('[redacted]');
  return t.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/sk-[A-Za-z0-9_*-]{4,}/g, '[redacted]').slice(0, 200);
}

export async function callDesk(env, packet, draft, { fetcher = fetch, feedback = null, model = env?.NEWS_DESK_MODEL || DESK_MODEL } = {}) {
  const user = `FROZEN FACT PACKET (the only source of truth):\n${JSON.stringify(packet)}\n\nMECHANICAL DRAFT (evidence only; do not copy its structure or wording):\n${JSON.stringify({ headline: draft.headline, dek: draft.dek, sections: draft.sections.filter(s => s.key !== 'method') })}${feedback ? `\n\nCORRECTIVE REWRITE REQUIRED:\nThe previous version was rejected by the deterministic publication gates for exactly these reasons:\n${feedback}\nRewrite the entire JSON response from the SAME FACT PACKET. Fix every failure without adding any fact, number, name, date, URL, quote or outside knowledge. The gates will run again unchanged.` : ''}`;
  // No tools, no retrieval, not stored: the packet in this request is all the model sees.
  const res = await fetcher(DESK_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model, store: false, reasoning: { effort: 'medium' }, instructions: SYSTEM, input: user, max_output_tokens: 18000, text: { format: { type: 'json_schema', name: 'soccer_editorial_article', strict: true, schema: ARTICLE_SCHEMA } } }),
    signal: AbortSignal.timeout(120000),
  });
  const clean = s => sanitizeDeskError(s, env);
  if (!res.ok) {
    // The API's own error type + message (never headers or keys), so a hold explains itself.
    let why = ''; try { const e = await res.json(); why = `${e?.error?.type || e?.error?.code || ''} ${e?.error?.message || ''}`.trim(); } catch { /* no body */ }
    throw new Error(clean(`desk HTTP ${res.status}${why ? `: ${why}` : ''}`));
  }
  let j; try { j = await res.json(); } catch { throw new Error('desk invalid_response_body'); }
  if (j?.status === 'incomplete') throw new Error(clean(`desk incomplete: ${j.incomplete_details?.reason || 'unknown'}`));
  if (j?.status === 'failed') throw new Error(clean(`desk failed: ${j.error?.code || ''} ${j.error?.message || ''}`.trim()));
  if (j?.status && j.status !== 'completed') throw new Error(clean(`desk status ${j.status}`));
  const refusals = []; const parts = [];
  for (const item of j?.output || []) for (const c of item?.content || []) {
    if (c?.type === 'refusal') refusals.push(String(c.refusal || ''));
    if (c?.type === 'output_text' && c.text) parts.push(String(c.text));
  }
  if (refusals.length) throw new Error(clean(`desk refusal: ${refusals.join(' ')}`));
  const txt = parts.join('').trim();
  if (!txt) throw new Error('desk empty_output');
  let out; try { out = JSON.parse(txt); } catch { throw new Error('desk invalid_json'); }
  if (!out?.headline || !Array.isArray(out.sections)) throw new Error('desk returned no article');
  return { headline: String(out.headline).trim(), dek: String(out.dek || '').trim(), sections: out.sections.map((s, i) => ({ key: `s${i + 1}`, heading: String(s.heading || '').trim(), paragraphs: (s.paragraphs || []).map(p => String(p).trim()).filter(Boolean) })).filter(s => s.paragraphs.length) };
}

// The public article: the desk's story; the draft's method + attributions become the disclosure.
export function deskArticle(edited, draft) {
  const method = draft.sections.find(s => s.key === 'method');
  return { ...draft, headline: edited.headline, dek: edited.dek, sections: edited.sections, disclosure: method ? method.paragraphs : [], draft: { headline: draft.headline, dek: draft.dek, sections: draft.sections }, composer: `${draft.composer}+${DESK_VERSION}` };
}

// ---------------------------------------------------------------- grounded validation
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ALWAYS_OK = new Set([...MONTHS, 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'MLS', 'Premier', 'League', 'Champions', 'Bundesliga', 'UEFA', 'Europe', 'European', 'Eastern', 'Western', 'Conference', 'Cup', 'FC', 'SC', 'CF', 'AFC', 'The', 'A', 'An', 'In', 'On', 'At', 'For', 'With', 'After', 'Before', 'By', 'From', 'Of', 'And', 'But', 'It', 'Its', 'This', 'That', 'Their', 'They', 'He', 'His', 'When', 'Then', 'Yet', 'Still', 'Only', 'No', 'Not', 'All', 'Both', 'Neither', 'Each', 'Every', 'Half', 'Full', 'Round', 'Matchday', 'Week', 'Table', 'Top',
  // sentence-initial prepositions / connectives before a name ("Against Bayern, ...") are not names
  'Against', 'Despite', 'Without', 'Under', 'Between', 'Behind', 'Beyond', 'Unlike', 'Across', 'Through', 'Since', 'Until', 'During', 'Over', 'Into', 'Inside', 'Outside', 'Among', 'Amid', 'Following', 'Like', 'Beside', 'Versus', 'Once', 'While', 'Where', 'Although', 'Though', 'With', 'Nor', 'Both', 'Neither']);
const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
const BANNED = [
  ['unsupported_quote', /[“”"]|\b(said|says|told reporters|admitted|insisted|according to)\b/i],
  ['unsupported_injury', /\b(injur\w*|hamstring|knock|fitness doubt|ruled out|sidelined|concussion|suspended|suspension)\b/i],
  ['unsupported_transfer', /\b(transfer|rumou?r\w*|linked with|bid for|signing target|contract talks|loan deal)\b/i],
  // "spread" only in its wagering sense (point spread / the spread / against the spread); bare
  // "spread across four scorers" and "the spread of goals" are ordinary English.
  ['unsupported_odds', /\b(odds|bet(s|ting)?|wager|point spreads?|the spread(?! (of|across|throughout|between|among|around)\b)|moneyline|bookmaker|sportsbook|favou?rites? to|underdogs?)\b/i],
  ['unsupported_xg', /\b(xg|expected goals|xt|expected threat|big chances?|chance quality)\b/i],
  ['unsupported_record', /\b(record|first time|all-time|historic\w*|best ever|worst ever|unprecedented|never before|club history)\b/i],
  ['unsupported_mentality', /\b(wanted it more|hungr\w*|desire|mentality|bottled|choked|confiden\w*|frustrat\w*|nervous|belief|determined|pressure mounts|spirit)\b/i],
  ['unsupported_tactics', /\b(formation|high press|pressing|back three|back four|false nine|gegenpress\w*|low block|counter-?press\w*)\b/i],
  ['unsupported_intent', /\b(wanted to|tried to|hoped to|planned to|decided to|chose to|set out to|was desperate)\b/i],
  ['pipeline_leak', /\b(packet|hash|gate|composer|pipeline|template|database)\b/i],
  ['cliche', /\b(game of two halves|at the end of the day|showed their class|statement win|put on a clinic|in style|sent a message)\b/i],
];

const bodyText = a => [a.headline, a.dek, ...a.sections.flatMap(s => [s.heading, ...s.paragraphs])].join('\n');
const sentences = t => t.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);
const words = t => (t.match(/[A-Za-zÀ-ÿ'’-]+|\d+/g) || []).length;

// Every string value in the packet (names, venues, dates rendered as text).
function packetStrings(p) {
  const out = [];
  const walk = v => { if (v === null || v === undefined) return; if (typeof v === 'string') out.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (typeof v === 'object') Object.values(v).forEach(walk); };
  walk(p); return out.join(' \u0001 ');
}

// Scores the text may print: the final, half-time, running scores, and any "a-b" string in the packet.
function packetScores(p) {
  const s = new Set();
  const walk = v => { if (typeof v === 'string' && /^\d{1,2}-\d{1,2}$/.test(v)) s.add(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(p);
  if (p.match?.score) { const sc = p.match.score; s.add(`${sc.home}-${sc.away}`); s.add(`${sc.away}-${sc.home}`); if (sc.home_ht !== null && sc.home_ht !== undefined) { s.add(`${sc.home_ht}-${sc.away_ht}`); s.add(`${sc.away_ht}-${sc.home_ht}`); } }
  for (const r of p.round?.results || []) if (r.score) { s.add(r.score); s.add(r.score.split('-').reverse().join('-')); }
  for (const g of p.trend?.games || []) { s.add(`${g.goals_for}-${g.goals_against}`); s.add(`${g.goals_against}-${g.goals_for}`); }
  if (p.trend) s.add(`${p.trend.goals_for}-${p.trend.goals_against}`); // the run's aggregate goals
  for (const a of p.form?.appearances || []) if (a.score) s.add(a.score);
  for (const x of [...s]) s.add(x.split('-').reverse().join('-'));
  return s;
}

const BUCKET_RANGES = new Set(['0-15', '16-30', '31-45', '46-60', '61-75', '76-90']);

export function validateEditorial(article, packet) {
  const results = []; const gate = (name, pass, detail = null) => results.push({ gate: name, pass, detail });
  const t = bodyText(article);
  const P = packetStrings(packet);
  // numbers (digits and number words), same grounding rule as the fact gates
  const allowed = packetNumbers2(packet);
  for (const v of [...allowed]) if (v.startsWith('-')) allowed.add(v.slice(1)); // "minus 13" for a goal difference of -13
  const ungrounded = [];
  const scrub = stripIdentifiers(t).replace(/\b\d{1,2}-\d{1,2}\b/g, ' ');
  for (const m of scrub.matchAll(/(\d+(?:\.\d+)?)(?:st|nd|rd|th|%)?/g)) if (!allowed.has(String(Number(m[1])))) ungrounded.push(m[0]);
  for (const m of t.toLowerCase().matchAll(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/g)) if (!allowed.has(String(WORD_NUM[m[1]])) && !['one'].includes(m[1])) ungrounded.push(m[1]);
  gate('new_number_not_in_packet', !ungrounded.length, ungrounded.length ? [...new Set(ungrounded)] : null);
  // scores
  const scores = packetScores(packet);
  // a pair next to a stat word ("corners 9-2", "9-2 on shots") is a count pair, grounded by the number gate
  const STAT_NEAR = /\b(corners?|shots?|saves?|fouls?|on target|cards?|offsides?)\b/i;
  const badScores = [...t.matchAll(/\b(\d{1,2})-(\d{1,2})\b/g)]
    .filter(m => !/\d{4}-$/.test(t.slice(Math.max(0, m.index - 5), m.index))) // part of an ISO date, not a score
    .filter(m => !STAT_NEAR.test(t.slice(Math.max(0, m.index - 24), m.index + m[0].length + 40)))
    // a packet phase bucket written as a minute range ("the 16-30 minute spell") is a time span, not a score
    .filter(m => !(BUCKET_RANGES.has(m[0]) && /^\+?(-| )?minutes?\b/i.test(t.slice(m.index + m[0].length, m.index + m[0].length + 10))))
    .map(m => m[0]).filter(x => !scores.has(x));
  gate('wrong_score', !badScores.length, badScores.length ? [...new Set(badScores)] : null);
  // dates: "<day> <Month>" and "<Month> <day>" must be dates the packet carries
  const isoDays = new Set([...JSON.stringify(packet).matchAll(/\b(\d{4})-(\d{2})-(\d{2})/g)].map(m => `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}`));
  const badDates = [...t.matchAll(new RegExp(`\\b(\\d{1,2}) (${MONTHS.join('|')})\\b|\\b(${MONTHS.join('|')}) (\\d{1,2})\\b`, 'g'))].map(m => (m[1] ? `${Number(m[1])} ${m[2]}` : `${Number(m[4])} ${m[3]}`)).filter(d => !isoDays.has(d));
  gate('new_date', !badDates.length, badDates.length ? badDates : null);
  gate('new_url', !/https?:\/\/|www\.|\.(com|org|net|de|uk)\b/i.test(t), (t.match(/https?:\/\/\S+|www\.\S+/) || [null])[0]);
  // names: a capitalised word that is not sentence-initial common English must appear in the packet
  const unknown = new Set();
  for (const s of sentences(t)) {
    const toks = [...s.matchAll(/\b[A-ZÀ-Ý][\p{L}'’.-]+/gu)];
    toks.forEach((m, i) => {
      const w = m[0].replace(/[’'.]s?$/, '').replace(/\.$/, '');
      if (w.length < 3 || ALWAYS_OK.has(w)) return;
      const initial = m.index === 0 || /^["“(]?$/.test(s.slice(0, m.index).trim());
      const nextIsName = toks[i + 1] && toks[i + 1].index === m.index + m[0].length + 1;
      if (initial && !nextIsName) return; // an ordinary sentence opener
      if (!P.includes(w)) unknown.add(w);
    });
  }
  gate('new_player_or_team', !unknown.size, unknown.size ? [...unknown] : null);
  // banned claims (global + competition profile)
  for (const [name, re] of BANNED) {
    if (name === 'unsupported_mentality' || name === 'pipeline_leak') { const m = t.match(re); gate(name, !m, m ? m[0] : null); continue; }
    const m = t.match(re); gate(name, !m, m ? m[0] : null);
  }
  if (/\bpossession\b/i.test(t) && !(packet.stats?.home?.possession_pct !== undefined && packet.stats?.away?.possession_pct !== undefined)) gate('unsupported_possession', false, 'possession');
  for (const [name, re] of PROFILES[packet.event.profile]?.banned || []) { const m = t.match(re); if (m) gate(name, false, m[0]); }
  // match integrity
  if (packet.match) {
    const sc = packet.match.score; const fin = `${Math.max(sc.home, sc.away)}-${Math.min(sc.home, sc.away)}`;
    gate('score_in_headline_or_dek', `${article.headline} ${article.dek}`.includes(fin) || `${article.headline} ${article.dek}`.includes(sc.final), fin);
    if (packet.match.winner !== 'draw') {
      const W = packet.teams[packet.match.winner]; const L = packet.teams[packet.match.winner === 'home' ? 'away' : 'home'];
      // the loser as the text may name it: full name, without its club prefix ("1. FC", "FC", "SV"...), its core
      const core = n => String(n || '').replace(/^(\d+\.\s*)?(FC|SC|SV|VfB|VfL|TSG|FSV|AFC|CF|AC|AS|SS|RB|RC|CD)\s+/i, '').replace(/\s+(FC|SC|CF|AFC)$/i, '').trim();
      const loserNames = [...new Set([L.name, L.short_name, core(L.name), core(L.short_name)].filter(x => x && x.length >= 4))].map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const flipped = new RegExp(`\\b(${loserNames.join('|')}) (beat|beats|won|win|thrash\\w*|rout\\w*|crush\\w*|defeat(ed|s)?|edge[ds]?|overcame|saw off)\\b`, 'i');
      gate('wrong_winner', !flipped.test(t), (t.match(flipped) || [null])[0]);
      void W;
      if (/\b(drew|draw|level at full time)\b/i.test(article.headline)) gate('wrong_result', false, 'draw language for a decided match');
    } else if (/\b(beat|won|win|defeat)\b/i.test(article.headline)) gate('wrong_result', false, 'win language for a draw');
    if (/hat-trick/i.test(t) && !packet.goals?.some(g => !g.own_goal && g.scorer && packet.goals.filter(x => !x.own_goal && x.scorer?.id === g.scorer.id).length === 3)) gate('unsupported_hat_trick', false, 'hat-trick');
    if (/\b(came from behind|comeback|fought back|trailed)\b/i.test(t) && !packet.angles?.some(a => a.key === 'comeback_from_ht')) gate('unsupported_comeback', false, 'comeback');
    const topInPacket = packet.angles?.some(a => /leader_change/.test(a.key)) || [packet.teams?.home, packet.teams?.away].some(tm => tm?.table_after?.position === 1);
    if (/\b(top of the|go top|went top|moved top|lead the table|leaders|first place|summit)\b/i.test(t) && !topInPacket && !packet.table) gate('unsupported_top_claim', false, 'top-of-table');
  }
  return results;
}

// ---------------------------------------------------------------- editorial quality
const GENERIC_HEADINGS = /^(result|results|goals|why it matters|why it mattered|shots|the numbers|table and form|what happened|the match|match report|summary|analysis|decisive players|where it leaves them|context|the run)$/i;

export function packetRichness(p) {
  if (p.event.kind !== 'match_recap') return 'standard';
  const goals = p.goals?.length || 0;
  return goals >= 3 && p.stats && (p.teams?.home?.table_after || p.teams?.home?.group) ? 'rich' : 'standard';
}

// ---- depth: which EVIDENCE FAMILIES the prose actually uses (text evidence of packet facts, not word count)
const ORD = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth'];
const NUMW = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const ordinalRe = n => `(?:${n}(?:st|nd|rd|th)|${ORD[n] || 'x^'})`;
const numRe = n => `(?:${String(n).replace('.', '\\.')}${NUMW[n] ? `|${NUMW[n]}` : ''})`;
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lastName = n => String(n || '').trim().split(/\s+/).pop();

export function evidenceFamilies(article, packet) {
  const t = article.sections.flatMap(s => [s.heading, ...s.paragraphs]).join('\n');
  const lower = t.toLowerCase();
  const ss = sentences(t);
  const d = packet.depth || {};
  const available = new Set(); const used = new Set();
  const goals = packet.goals || [];
  // GOAL_SEQUENCE: at least two goal minutes, or the half-time score with a half-time word
  if (goals.length >= 2 || d.goal_sequence?.halftime_score) available.add('GOAL_SEQUENCE');
  const mins = new Set(goals.map(g => g.minute));
  const minHits = [...t.matchAll(/\b(\d{1,3})(?:st|nd|rd|th)?(?:[- ]minute|')/g)].filter(m => mins.has(Number(m[1]))).length;
  const ht = d.goal_sequence?.halftime_score || (packet.match?.score?.home_ht !== null && packet.match?.score?.home_ht !== undefined ? `${packet.match.score.home_ht}-${packet.match.score.away_ht}` : null);
  if (minHits >= 2 || (ht && /half-?time|interval|the break/i.test(t) && (t.includes(ht) || t.includes(ht.replace('-', '–'))))) used.add('GOAL_SEQUENCE');
  // PLAYER_CONTRIBUTIONS: two or more contributing players named
  const contributors = (d.player_lines?.length ? d.player_lines : packet.decisive || []).filter(r => r.player?.name && (r.goals || r.assists || r.shots_on_target));
  if (contributors.length) available.add('PLAYER_CONTRIBUTIONS');
  if (contributors.filter(r => new RegExp(`\\b${esc(lastName(r.player.name))}\\b`).test(t)).length >= Math.min(2, contributors.length)) used.add('PLAYER_CONTRIBUTIONS');
  // TEAM_STATS: two stat values stated next to their stat word
  const st = packet.stats;
  if (st) {
    available.add('TEAM_STATS');
    const pairs = [['shots', /shots?|attempts?|efforts?/i], ['shots_on_target', /on target|tested|saves?/i], ['corners', /corners?/i], ['saves', /saves?/i], ['fouls_committed', /fouls?/i], ['possession_pct', /possession|of the ball/i]];
    let hits = 0;
    for (const [k, word] of pairs) for (const side of ['home', 'away']) { const v = st[side]?.[k]; if (v === undefined || v === null) continue; const re = new RegExp(`\\b${numRe(Number(v))}\\b`, 'i'); if (ss.some(s => re.test(s) && word.test(s))) { hits += 1; break; } }
    if (hits >= 2) used.add('TEAM_STATS');
  }
  // SHOT_LOCATIONS: located distance / inside-outside the box
  const sp = d.shot_profile; const sl = packet.shots_located;
  if ((sp?.located_total || 0) > 0 || ((sl?.home || 0) + (sl?.away || 0)) > 0) available.add('SHOT_LOCATIONS');
  const dists = [sp?.home?.avg_located_distance_m, sp?.away?.avg_located_distance_m, sl?.avg_distance_m?.home, sl?.avg_distance_m?.away].filter(v => v !== null && v !== undefined).map(String);
  if (dists.some(v => t.includes(v)) || /\b(inside|outside) the (penalty )?(area|box)\b/i.test(t) || /\blocated\b/i.test(t)) used.add('SHOT_LOCATIONS');
  // TABLE_CONTEXT: a table position or points total stated with a table word
  const tm = d.table_move || null; const tA = packet.teams;
  if (tA?.home?.table_after || tA?.home?.group) available.add('TABLE_CONTEXT');
  const posts = [tA?.home?.table_after, tA?.away?.table_after, tA?.home?.group, tA?.away?.group].filter(Boolean);
  if (posts.some(r => ss.some(s => /\b(table|standings|place|position|top|bottom|summit|points|leaders?|conference|league phase)\b/i.test(s) && (new RegExp(`\\b${ordinalRe(r.position)}\\b`, 'i').test(s) || new RegExp(`\\b${numRe(r.points)} points\\b`, 'i').test(s) || (r.position === 1 && /\btop\b/i.test(s)))))) used.add('TABLE_CONTEXT');
  void tm;
  // FORM_CONTEXT
  if ((tA?.home?.form_before?.length || 0) + (tA?.away?.form_before?.length || 0) > 0 || d.recent_league_results?.home?.length) available.add('FORM_CONTEXT');
  if (/\b(unbeaten|without a win|winless|in a row|consecutive|straight (wins|defeats|draws|league)|run of|recent|form|last (two|three|four|five|\d) (league )?(matches|games|outings)|had (won|lost|drawn) (two|three|four|five|\d))\b/i.test(t)) used.add('FORM_CONTEXT');
  // NEXT_FIXTURE
  const nexts = [tA?.home?.next, tA?.away?.next].filter(Boolean);
  if (nexts.length) available.add('NEXT_FIXTURE');
  if (nexts.some(n => n.opponent?.name && ss.some(s => /\b(next|face|faces|host|hosts|visit|visits|travel|travels|meet|meets|trip)\b/i.test(s) && s.includes(lastName(n.opponent.name))))) used.add('NEXT_FIXTURE');
  if (d.discipline?.length) available.add('DISCIPLINE');
  if (/\b(yellow card|red card|booked|booking|sent off)\b/i.test(lower)) used.add('DISCIPLINE');
  if (d.substitutions?.length) available.add('SUBSTITUTIONS');
  if (/\b(substitute|came on|off the bench|replaced|introduced)\b/i.test(lower)) used.add('SUBSTITUTIONS');
  return { available: [...available], used: [...used].filter(f => available.has(f)) };
}

export function qualityGates(article, packet) {
  const results = []; const gate = (name, pass, detail = null) => results.push({ gate: name, pass, detail });
  const body = article.sections.flatMap(s => s.paragraphs).join('\n');
  const n = words(body);
  const rich = packetRichness(packet) === 'rich';
  const min = rich ? 450 : packet.event.kind === 'match_recap' ? 220 : 160;
  gate('thin_output', n >= min, { words: n, min });
  gate('too_long', n <= 1100, { words: n });
  gate('sections', article.sections.length >= (rich ? 3 : 2) && article.sections.length <= (rich ? 5 : 6), article.sections.length);
  // DEPTH (v2): evidence families, repetition, section depth, lead + dek quality
  if (packet.event.kind === 'match_recap') {
    const fam = evidenceFamilies(article, packet);
    const has = f => fam.used.includes(f); const avail = f => fam.available.includes(f);
    const need = rich ? Math.min(fam.available.length, 3) : Math.min(fam.available.length, 2);
    gate('evidence_families', fam.used.length >= need, { used: fam.used, available: fam.available, need });
    if (rich) {
      const missing = [];
      if (avail('GOAL_SEQUENCE') && !has('GOAL_SEQUENCE')) missing.push('match progression (goal sequence / half-time)');
      if (avail('PLAYER_CONTRIBUTIONS') && !has('PLAYER_CONTRIBUTIONS')) missing.push('decisive players');
      if ((avail('TEAM_STATS') || avail('SHOT_LOCATIONS')) && !has('TEAM_STATS') && !has('SHOT_LOCATIONS')) missing.push('match stats / shot profile');
      if (avail('TABLE_CONTEXT') && !has('TABLE_CONTEXT')) missing.push('table / competitive context');
      gate('evidence_coverage', !missing.length, missing.length ? missing : null);
      const thinSections = article.sections.filter(s => s.paragraphs.length < 2);
      gate('section_depth', thinSections.length <= 1, thinSections.map(s => s.heading));
    }
    const sc = packet.match.score; const fin = [`${sc.home}-${sc.away}`, `${sc.home}–${sc.away}`, `${sc.away}-${sc.home}`, `${sc.away}–${sc.home}`];
    const scoreHits = fin.reduce((n, f) => n + body.split(f).length - 1, 0);
    gate('score_repetition', scoreHits <= 2, scoreHits);
    const mech = body.match(/\bthe match produced \w+ goals\b|\bthe winning margin was\b/i);
    gate('mechanical_phrasing', !mech, mech ? mech[0] : null);
    const repeatedTotals = (packet.depth?.player_lines || packet.decisive || []).filter(r => r.goals >= 2).map(r => {
      const re = new RegExp(`\\b${esc(lastName(r.player?.name))}\\b[^.]{0,60}\\b(hat-trick|brace|${NUMW[r.goals]} goals|${r.goals} goals|twice|three times|scored ${NUMW[r.goals]}|scored ${r.goals})\\b`, 'i');
      return { player: r.player?.name, sections: article.sections.filter(s => re.test(s.paragraphs.join(' '))).length };
    }).filter(x => x.sections >= 3);
    gate('goal_totals_repeated', !repeatedTotals.length, repeatedTotals.length ? repeatedTotals : null);
    // three consecutive paragraphs that mainly restate numbers
    const paras = article.sections.flatMap(s => s.paragraphs);
    const dense = p => { const w = words(p); const nums = (p.match(/\b\d+(\.\d+)?\b|\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/gi) || []).length; return w > 0 && nums / w >= 0.12; };
    let runP = 0; let worstP = 0; for (const p of paras) { if (dense(p)) { runP += 1; worstP = Math.max(worstP, runP); } else runP = 0; }
    gate('numeric_paragraph_run', worstP < 3, worstP);
    // lead: winner + an angle (player, half-time or a goal minute); never the bare template sentence
    const lead = article.sections[0]?.paragraphs?.[0] || '';
    if (packet.match.winner !== 'draw') {
      const W = packet.teams[packet.match.winner];
      const winnerNamed = [W.name, W.short_name, lastName(W.name)].filter(x => x && x.length >= 3).some(x => lead.includes(x));
      const angle = (packet.depth?.player_lines || packet.decisive || []).some(r => r.player?.name && lead.includes(lastName(r.player.name))) || /half-?time|interval|\b\d{1,3}(st|nd|rd|th) minute\b/i.test(lead);
      gate('lead_quality', winnerNamed && angle && !/^[^.]+ (beat|defeated|drew with) [^.]+ \d+[-–]\d+ on \d{1,2} \w+\.?$/.test(sentences(lead)[0] || ''), { winner_named: winnerNamed, angle });
    }
    const hw = new Set(article.headline.toLowerCase().match(/[\p{L}\d]+/gu) || []); const dw = article.dek.toLowerCase().match(/[\p{L}\d]+/gu) || [];
    const overlap = dw.length ? dw.filter(w => hw.has(w)).length / dw.length : 1;
    gate('dek_adds_information', overlap < 0.7 && dw.length >= 8, { overlap: Math.round(overlap * 100) / 100 });
  }
  const generic = article.sections.filter(s => GENERIC_HEADINGS.test(s.heading.trim()));
  gate('generic_headings', generic.length === 0, generic.map(s => s.heading));
  gate('why_it_matters_filler', !/\bwhy it matters\b|\bit remains to be seen\b|\bonly time will tell\b/i.test(body));
  // template opening: the draft's opening sentence reused, or the bare "X beat Y a-b." lead
  const first = sentences(article.sections[0]?.paragraphs[0] || '')[0] || '';
  const draftFirst = sentences(article.draft?.sections?.[0]?.paragraphs?.[0] || '')[0] || '';
  gate('template_opening', first !== draftFirst && !/^[\p{L} .'-]+ (beat|drew with|won at) [\p{L} .'-]+ \d+-\d+( at [^.]+)?\.$/u.test(first), first);
  // database recitation: three consecutive short numeric statements
  const ss = sentences(body); let run = 0; let worst = 0;
  for (const s of ss) { if (/\d/.test(s) && words(s) <= 12) { run += 1; worst = Math.max(worst, run); } else run = 0; }
  gate('stat_recitation', worst < 3, worst);
  const scoredLines = ss.filter(s => /^[\p{Lu}][\p{L} .'-]+ (scored|had|made) \d+/u.test(s)).length;
  gate('database_prose', scoredLines < 3, scoredLines);
  // duplicated content
  const seen = new Set(); const dup = [];
  for (const s of ss.map(x => x.toLowerCase())) { if (s.length > 30 && seen.has(s)) dup.push(s); seen.add(s); }
  gate('duplicated_content', !dup.length, dup.slice(0, 2));
  const heads = article.sections.map(s => s.heading.toLowerCase());
  gate('duplicated_headings', new Set(heads).size === heads.length, heads);
  // headline angle: a match with a clear angle must not headline the bare score only
  if (packet.match) {
    const angleNames = (packet.angles || []).flatMap(a => [a.detail?.player?.name, a.detail?.new_leader_team?.name]).filter(Boolean).flatMap(x => [x, x.split(' ').pop()]);
    const bare = /^[\p{L}\d .'-]+ (beat|win|won|draw|drew) [\p{L}\d .'-]+ \d+-\d+$/u.test(article.headline.trim());
    gate('headline_angle', !(bare && angleNames.length && !angleNames.some(x => article.headline.includes(x))), article.headline);
  }
  gate('headline_length', article.headline.length >= 30 && article.headline.length <= 110, article.headline.length);
  gate('dek_present', article.dek.length >= 40 && article.dek.length <= 260, article.dek.length);
  // source limits stated once at most in the prose (the disclosure carries them)
  gate('disclosure_in_prose', (body.match(/\b(source|recorded by|according to the data)\b/gi) || []).length <= 2, (body.match(/\b(source|recorded by)\b/gi) || []).length);
  return results;
}

export function judge(article, packet) {
  const results = [...validateEditorial(article, packet), ...qualityGates(article, packet)];
  const attributions = packet.provenance?.attributions || [];
  const missing = attributions.filter(a => !(article.disclosure || []).includes(a));
  results.push({ gate: 'attribution_disclosed', pass: !missing.length, detail: missing.length ? missing : null });
  const failed = results.filter(r => !r.pass);
  return { version: DESK_VERSION, quality_version: QUALITY_VERSION, packet_version: packet.version, evidence: packet.event.kind === 'match_recap' ? evidenceFamilies(article, packet) : null, pass: !failed.length, failed: failed.map(r => r.gate), results };
}

// Draft -> desk -> judge (-> one repair) -> { article, judgement } or { held }.
export async function runDesk(draft, packet, env, { fetcher = fetch } = {}) {
  if (!deskAvailable(env)) return { held: ['editorial_desk_unavailable'] };
  let feedback = null; let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let edited;
    try { edited = await callDesk(env, packet, draft, { fetcher, feedback }); } catch (e) { last = { held: [`editorial_desk_error: ${sanitizeDeskError(e?.message, env).slice(0, 120)}`] }; continue; }
    const article = deskArticle(edited, draft);
    const j = judge(article, packet);
    if (j.pass) return { article, judgement: { ...j, attempt, model: env?.NEWS_DESK_MODEL || DESK_MODEL } };
    last = { held: j.failed.map(f => `editorial:${f}`), judgement: { ...j, attempt }, rejected: article };
    feedback = j.results.filter(r => !r.pass).map(r => `- ${r.gate}${r.detail ? `: ${JSON.stringify(r.detail).slice(0, 200)}` : ''}`).join('\n');
  }
  return last;
}
