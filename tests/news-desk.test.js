// World-class editorial desk: fail-closed publication, grounded validation, quality gates.
// Uses REAL frozen packets from production evidence (tests/fixtures/news/*-packet.json, copied from
// the append-only soccer_article_evidence table); the model is a fake transport in the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compose } from '../workers/soccer-news/src/compose2.js';
import { judge, deskArticle, runDesk, validateEditorial, qualityGates, packetRichness } from '../workers/soccer-news/src/desk.js';
import { editorialStage, articleBody } from '../workers/soccer-news/src/pipeline.js';

const packet = name => JSON.parse(readFileSync(`tests/fixtures/news/${name}-packet.json`, 'utf8'));
const B = packet('bayern');
const draft = compose(B);

// A publication-grade story written only from the Bayern packet (the shape the desk must produce).
const GOOD = {
  headline: 'Olise hat-trick powers Bayern past Union Berlin in 7-0 rout',
  dek: 'Michael Olise scored three and Harry Kane added two as Bayern München turned a 3-0 half-time lead into a 7-0 Bundesliga win that lifted them from fourth to first.',
  sections: [
    { heading: 'A first half that settled everything', paragraphs: [
      'Bayern München did not need long to make this a one-sided evening. Jamal Musiala opened the scoring in the 18th minute, and by the interval the gap had grown to three goals.',
      'Harry Kane made it 2-0 in the 39th minute and Michael Olise added a third in the 43rd, so 1. FC Union Berlin went in at half-time needing a response they never found.',
      'The pattern was already clear. Bayern kept arriving in the penalty area, and Union Berlin could barely get the ball near the other end.',
    ] },
    { heading: 'Olise and Kane turn control into a rout', paragraphs: [
      'The second half removed any doubt. Kane scored again in the 54th minute for 4-0, and Ismael Saibari made it 5-0 in the 70th.',
      'Then Olise took over. He scored in the 73rd and 76th minutes, completing a hat-trick inside a spell of barely half an hour after the break and finishing the scoring at 7-0.',
      'Kane’s brace and Olise’s three goals gave Bayern two different sources of finishing on the same night, with Musiala and Saibari also on the scoresheet. Four players scored, and none of the seven goals came from the visitors’ mistakes being gifted back to them: every one was a Bayern finish.',
    ] },
    { heading: 'Pressure that never eased', paragraphs: [
      'The shot count explains why the scoreline climbed so steadily. Bayern finished with 23 shots, 15 of them on target, while Union Berlin managed three attempts and only two that tested the goalkeeper.',
      'That imbalance meant the visiting goalkeeper was busy all night, with six saves, and still conceded seven. At the other end Bayern were asked to make just two.',
      'Bayern also won nine corners to Union Berlin’s two. The average distance of Bayern’s located shots was 17.9 metres, so this was not a night of speculative efforts from range but of repeated chances close enough to trouble the goal.',
    ] },
    { heading: 'Seven goals take Bayern to the top', paragraphs: [
      'The margin mattered in the standings as much as on the pitch. Bayern started the day fourth and finished it top of the Bundesliga table on 10 points from four matches.',
      'Their goal difference swung from plus five to plus 12, which reflects how decisive the evening was. They arrived unbeaten from three league matches, with two wins and a draw, and left with three wins from four.',
      'For Union Berlin the night deepened a difficult start. They stayed 16th of 18 on one point, now without a win in four league matches, and their goal difference fell to minus 13.',
      'It is still early in the 2026/27 season, and one result does not decide a title race. But a 7-0 win with this balance of shots and finishing is the kind of evening that moves a team from the chasing pack to the head of it, and on 18 September that is exactly what Bayern did.',
    ] },
  ],
};

test('packet richness: the Bayern recap is rich (depth target applies)', () => {
  assert.equal(packetRichness(B), 'rich');
});

test('a grounded, well-built story passes every fact and quality gate', () => {
  const a = deskArticle({ ...GOOD, sections: GOOD.sections.map((s, i) => ({ key: `s${i + 1}`, ...s })) }, draft);
  const j = judge(a, B);
  assert.deepEqual(j.failed, [], JSON.stringify(j.results.filter(r => !r.pass)));
  assert.ok(a.disclosure.some(p => /OpenLigaDB/.test(p)), 'method + attributions move to the disclosure');
  assert.ok(!a.sections.some(s => /method/i.test(s.heading)), 'no method section in the prose');
});

const variant = (mut) => { const a = deskArticle({ ...GOOD, sections: GOOD.sections.map((s, i) => ({ key: `s${i + 1}`, ...s, paragraphs: [...s.paragraphs] })) }, draft); mut(a); return judge(a, B).failed; };

test('grounding holds: new number, player, date, URL, quote, xG, injury, odds, record, wrong score / winner', () => {
  assert.ok(variant(a => { a.sections[0].paragraphs[0] += ' Bayern had 31 shots in the first half.'; }).includes('new_number_not_in_packet'));
  assert.ok(variant(a => { a.sections[1].paragraphs[0] += ' Thomas Müller came off the bench.'; }).includes('new_player_or_team'));
  assert.ok(variant(a => { a.sections[3].paragraphs[3] = a.sections[3].paragraphs[3].replace('18 September', '21 September'); }).includes('new_date'));
  assert.ok(variant(a => { a.sections[0].paragraphs[1] += ' Watch the goals at https://example.com.'; }).includes('new_url'));
  assert.ok(variant(a => { a.sections[0].paragraphs[1] += ' “We were brilliant,” Kane said.'; }).includes('unsupported_quote'));
  assert.ok(variant(a => { a.sections[2].paragraphs[0] += ' Their expected goals told the same story.'; }).includes('unsupported_xg'));
  assert.ok(variant(a => { a.sections[2].paragraphs[1] += ' Union Berlin were without an injured defender.'; }).includes('unsupported_injury'));
  assert.ok(variant(a => { a.sections[3].paragraphs[3] += ' The odds on Bayern shortened.'; }).includes('unsupported_odds'));
  assert.ok(variant(a => { a.sections[3].paragraphs[0] += ' It was a club record.'; }).includes('unsupported_record'));
  assert.ok(variant(a => { a.dek = a.dek.replace('7-0 Bundesliga', '6-0 Bundesliga'); a.sections[1].paragraphs[1] += ' The final whistle came at 8-0.'; }).includes('wrong_score'));
  assert.ok(variant(a => { a.sections[0].paragraphs[2] += ' Union Berlin beat Bayern on the break once.'; }).includes('wrong_winner'));
  assert.ok(variant(a => { a.sections[1].paragraphs[2] += ' Bayern wanted it more.'; }).includes('unsupported_mentality'));
  assert.ok(variant(a => { a.sections[0].paragraphs[2] += ' Their formation left no gaps.'; }).includes('unsupported_tactics'));
});

test('quality holds: template opening, stat recitation, generic headings, thin copy, filler, pipeline leak', () => {
  assert.ok(variant(a => { a.sections[0].paragraphs[0] = draft.sections[0].paragraphs[0]; }).includes('template_opening'));
  assert.ok(variant(a => { a.sections[2].paragraphs[0] = 'Bayern had 23 shots. Union Berlin had 3. Bayern had 15 on target. Union Berlin had 2.'; }).some(f => f === 'stat_recitation' || f === 'database_prose'));
  assert.ok(variant(a => { a.sections[0].heading = 'Result'; a.sections[1].heading = 'Goals'; }).includes('generic_headings'));
  assert.ok(variant(a => { a.sections = a.sections.slice(0, 2).map(s => ({ ...s, paragraphs: s.paragraphs.slice(0, 1) })); }).includes('thin_output'));
  assert.ok(variant(a => { a.sections[3].paragraphs[3] += ' Only time will tell.'; }).includes('why_it_matters_filler'));
  assert.ok(variant(a => { a.sections[3].paragraphs[3] += ' The evidence packet confirms this.'; }).includes('pipeline_leak'));
  assert.ok(variant(a => { a.headline = 'Bayern München beat 1. FC Union Berlin 7-0'; }).includes('headline_angle'), 'a bare score headline when a hat-trick angle exists');
});

// ---- fail-closed publication path with a fake model transport
const reply = obj => async () => ({ ok: true, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }] }) });

test('no desk key: a NEW story HOLDS (never the template)', async () => {
  const r = await editorialStage(draft, B, {});
  assert.equal(r.status, 'held'); assert.deepEqual(r.holdReasons, ['editorial_desk_unavailable']);
});

test('desk passes: the desk story is published; draft and disclosure stay stored', async () => {
  const r = await editorialStage(draft, B, { ANTHROPIC_API_KEY: 'test' }, { fetcher: reply(GOOD) });
  assert.equal(r.status, 'published', JSON.stringify(r.holdReasons));
  assert.equal(r.article.headline, GOOD.headline);
  const body = articleBody(r.article, r.editorial);
  assert.equal(body.draft.headline, draft.headline); assert.ok(body.disclosure.length); assert.equal(body.editorial.attempt, 1);
  assert.match(r.article.composer, /soccer-desk/);
});

test('desk fails twice: HOLD with the gate reasons; one repair attempt quotes the failures', async () => {
  const bad = { ...GOOD, sections: GOOD.sections.map(s => ({ ...s, paragraphs: [...s.paragraphs] })) };
  bad.sections[0].paragraphs[0] += ' Bayern had 31 shots before half-time.';
  const seen = [];
  const fetcher = async (_u, init) => { seen.push(JSON.parse(init.body).messages[0].content); return reply(bad)(); };
  const r = await editorialStage(draft, B, { ANTHROPIC_API_KEY: 'test' }, { fetcher });
  assert.equal(r.status, 'held'); assert.ok(r.holdReasons.includes('editorial:new_number_not_in_packet'));
  assert.equal(seen.length, 2); assert.match(seen[1], /CORRECTIVE REWRITE REQUIRED[\s\S]*new_number_not_in_packet/);
});

test('desk repairs on the second attempt: published with attempt 2', async () => {
  const bad = { ...GOOD, sections: GOOD.sections.map(s => ({ ...s, paragraphs: [...s.paragraphs] })) };
  bad.sections[0].paragraphs[0] += ' Bayern had 31 shots before half-time.';
  let n = 0;
  const r = await runDesk(draft, B, { ANTHROPIC_API_KEY: 'test' }, { fetcher: async () => (n++ === 0 ? reply(bad)() : reply(GOOD)()) });
  assert.ok(r.article); assert.equal(r.judgement.attempt, 2);
});

test('refusal / truncation / HTTP failure is a hold, never a template', async () => {
  const r1 = await runDesk(draft, B, { ANTHROPIC_API_KEY: 'test' }, { fetcher: async () => ({ ok: true, json: async () => ({ stop_reason: 'max_tokens', content: [] }) }) });
  assert.ok(r1.held[0].startsWith('editorial_desk_error'));
  const r2 = await runDesk(draft, B, { ANTHROPIC_API_KEY: 'test' }, { fetcher: async () => ({ ok: false, status: 529 }) });
  assert.ok(r2.held[0].startsWith('editorial_desk_error'));
});

test('the fact gates on the deterministic draft are unchanged (template output itself is not publishable copy)', () => {
  const q = qualityGates({ ...draft, sections: draft.sections.filter(s => s.key !== 'method'), draft }, B);
  const failed = q.filter(r => !r.pass).map(r => r.gate);
  assert.ok(failed.includes('generic_headings') || failed.includes('thin_output') || failed.includes('template_opening'), `the template would not pass the desk's quality bar: ${failed}`);
  assert.equal(validateEditorial({ ...draft, sections: draft.sections.filter(s => s.key !== 'method') }, B).filter(r => !r.pass && /new_|wrong_/.test(r.gate)).length, 0, 'the draft is factually grounded');
});
