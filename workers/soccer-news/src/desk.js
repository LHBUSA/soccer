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

export const DESK_VERSION = 'soccer-desk/1.0.0';
export const DESK_MODEL = 'claude-opus-5'; // current generally available Opus; override with NEWS_DESK_MODEL
export const deskRequired = env => env?.NEWS_DESK !== 'off'; // default: required for every new story
export const deskAvailable = env => !!env?.ANTHROPIC_API_KEY;

export const SYSTEM = `You are the senior editor of PropBetEdge Soccer, a premium football intelligence newsroom.
Write like a top-tier sports and data magazine, not a database template.

You receive a FROZEN FACT PACKET (the only source of truth) and a mechanical DRAFT built from it.
Rewrite the story from scratch for readers who love football:
- Open with what actually defined the match or the story, in a direct lead sentence.
- Turn evidence into football meaning: connect the numbers to what happened. Do not recite numbers one after another.
- Choose your own structure: 3 to 5 sections with specific, story-led headings (never generic labels such as "Result", "Goals", "Why it matters", "Shots", "The numbers", "Table and form", "What happened").
- Short, varied paragraphs. Natural transitions. A concise sharp story beats padded copy.
- Match reports with a rich packet (several goals, shots, table movement, form) should run roughly 550-900 words; thin packets can be shorter. Never pad.

Hard rules (a violation means the story is not published):
- Use ONLY facts in the packet. Every number, name, date and score you write must be in the packet.
- Never invent: quotes, injuries, suspensions, transfers, rumours, odds or betting, xG or expected goals, possession unless the packet carries it, tactics or formations not in the packet, player or manager intent, emotions or mental state, records or "historic"/"first time"/"all-time" claims.
- Refer to players and teams only by names that appear in the packet (you may use the short team name given in the packet).
- Write out no URLs. Do not mention PropBetEdge's pipeline, packets, hashes or gates; source notes are published separately.
- Keep the final score in the headline or the dek of a match story, and name the winner correctly.

Return JSON only, no prose around it:
{"headline": "...", "dek": "...", "sections": [{"heading": "...", "paragraphs": ["...", "..."]}]}`;

// ---------------------------------------------------------------- model call
export async function callDesk(env, packet, draft, { fetcher = fetch, feedback = null, model = env?.NEWS_DESK_MODEL || DESK_MODEL } = {}) {
  const user = `FROZEN FACT PACKET (the only source of truth):\n${JSON.stringify(packet)}\n\nMECHANICAL DRAFT (evidence only; do not copy its structure or wording):\n${JSON.stringify({ headline: draft.headline, dek: draft.dek, sections: draft.sections.filter(s => s.key !== 'method') })}${feedback ? `\n\nCORRECTIVE REWRITE REQUIRED:\nThe previous version was rejected by the deterministic publication gates for exactly these reasons:\n${feedback}\nRewrite the entire JSON response from the SAME FACT PACKET. Fix every failure without adding any fact, number, name, date, URL, quote or outside knowledge. The gates will run again unchanged.` : ''}`;
  const res = await fetcher('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 16000, thinking: { type: 'adaptive' }, system: SYSTEM, messages: [{ role: 'user', content: user }] }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    // The API's own error message (never headers or keys), so a hold explains itself.
    let why = ''; try { const e = await res.json(); why = `${e?.error?.type || ''} ${e?.error?.message || ''}`.trim().slice(0, 160); } catch { /* no body */ }
    throw new Error(`desk HTTP ${res.status}${why ? `: ${why}` : ''}`);
  }
  const j = await res.json();
  if (j.stop_reason === 'refusal' || j.stop_reason === 'max_tokens') throw new Error(`desk stop_reason ${j.stop_reason}`);
  const txt = (j.content || []).map(c => c.text || '').join('');
  const out = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
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
const ALWAYS_OK = new Set([...MONTHS, 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'MLS', 'Premier', 'League', 'Champions', 'Bundesliga', 'UEFA', 'Europe', 'European', 'Eastern', 'Western', 'Conference', 'Cup', 'FC', 'SC', 'CF', 'AFC', 'The', 'A', 'An', 'In', 'On', 'At', 'For', 'With', 'After', 'Before', 'By', 'From', 'Of', 'And', 'But', 'It', 'Its', 'This', 'That', 'Their', 'They', 'He', 'His', 'When', 'Then', 'Yet', 'Still', 'Only', 'No', 'Not', 'All', 'Both', 'Neither', 'Each', 'Every', 'Half', 'Full', 'Round', 'Matchday', 'Week', 'Table', 'Top']);
const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
const BANNED = [
  ['unsupported_quote', /[“”"]|\b(said|says|told reporters|admitted|insisted|according to)\b/i],
  ['unsupported_injury', /\b(injur\w*|hamstring|knock|fitness doubt|ruled out|sidelined|concussion|suspended|suspension)\b/i],
  ['unsupported_transfer', /\b(transfer|rumou?r\w*|linked with|bid for|signing target|contract talks|loan deal)\b/i],
  ['unsupported_odds', /\b(odds|bet(s|ting)?|wager|spread|moneyline|bookmaker|sportsbook|favou?rites? to|underdogs?)\b/i],
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
    .filter(m => !STAT_NEAR.test(t.slice(Math.max(0, m.index - 24), m.index + m[0].length + 24))).map(m => m[0]).filter(x => !scores.has(x));
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

export function qualityGates(article, packet) {
  const results = []; const gate = (name, pass, detail = null) => results.push({ gate: name, pass, detail });
  const body = article.sections.flatMap(s => s.paragraphs).join('\n');
  const n = words(body);
  const rich = packetRichness(packet) === 'rich';
  const min = rich ? 450 : packet.event.kind === 'match_recap' ? 220 : 160;
  gate('thin_output', n >= min, { words: n, min });
  gate('too_long', n <= 1100, { words: n });
  gate('sections', article.sections.length >= (rich ? 3 : 2) && article.sections.length <= 6, article.sections.length);
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
  return { version: DESK_VERSION, pass: !failed.length, failed: failed.map(r => r.gate), results };
}

// Draft -> desk -> judge (-> one repair) -> { article, judgement } or { held }.
export async function runDesk(draft, packet, env, { fetcher = fetch } = {}) {
  if (!deskAvailable(env)) return { held: ['editorial_desk_unavailable'] };
  let feedback = null; let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let edited;
    try { edited = await callDesk(env, packet, draft, { fetcher, feedback }); } catch (e) { last = { held: [`editorial_desk_error: ${String(e.message).slice(0, 80)}`] }; continue; }
    const article = deskArticle(edited, draft);
    const j = judge(article, packet);
    if (j.pass) return { article, judgement: { ...j, attempt, model: env?.NEWS_DESK_MODEL || DESK_MODEL } };
    last = { held: j.failed.map(f => `editorial:${f}`), judgement: { ...j, attempt }, rejected: article };
    feedback = j.results.filter(r => !r.pass).map(r => `- ${r.gate}${r.detail ? `: ${JSON.stringify(r.detail).slice(0, 200)}` : ''}`).join('\n');
  }
  return last;
}
