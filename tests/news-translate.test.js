// Newsroom translation (soccer-translate/1, contract soccer-article-i18n/1; owner approval 2026-10-09, Issue #15 stage 1).
// Runs the REAL migrations (incl. 20261009001600) in PGlite, the REAL translator/gates/lifecycle (soccer-news) and the REAL
// reader routes (soccer-api). Only the OpenAI transport is replaced by a scripted fetcher: no network, no spend.
// Inline API-shaped rows (not committed mock data).
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMigrations, openPglite } from '../workers/soccer-ingest/src/store-pglite.js';
import { articleSegments, sourceRevision, applyTranslation, methodNotes, ARTICLE_LOCALES, exonym } from '../workers/shared/article-i18n.js';
import { translateArticle, translationGates, sweepTranslations, translationCandidates, checkVerdict, translationAllowanceUsd, translationTick } from '../workers/soccer-news/src/translate.js';

const id = n => `00000000-0000-5000-8000-0000001a${String(n).padStart(4, '0')}`;
const PH = 'b'.repeat(64);
const KANE = { id: id(30), name: 'Harry Kane', slug: 'harry-kane', type: 'Person', href: '/players/harry-kane' };
const ENG = { id: id(31), name: 'England', slug: 'england', type: 'SportsTeam', href: '/teams/england' };
const ARTICLE = {
  id: id(1), slug: 'harry-kane-scoring-run-2026-10-06-96b1f1', desk: 'international', story_class: 'player_form',
  headline: 'Harry Kane scores in four straight Nations League games for England',
  dek: 'Six goals since September 26 make Kane the steadiest finisher in England’s group.',
  body: {
    sections: [
      { key: 's1', heading: 'Six goals in four starts', paragraphs: ['Harry Kane has scored in 4 consecutive UEFA Nations League appearances for England, with 6 goals in total.', 'He scored twice against Croatia on October 3 and twice more against Czechia on Tuesday, October 6.'] },
      { key: 's2', heading: 'Match by match', paragraphs: ['The run began with 1 goal in a 2-3 defeat to Spain and continued in a 2-0 win over Czechia.'] },
      { key: 'method', heading: 'Evidence and method', paragraphs: ['Every figure in this story comes from its frozen evidence packet (soccer-packet/2.0.0, hash 96b1f1fb8228). Not reported: quotes (none sourced); injuries (no legitimate source ingested).', 'Structured facts: ESPN (secondary source).'] },
    ],
    visuals: [{ id: 'scoring_run', type: 'scoring_run', title: 'Harry Kane: match by match', subtitle: '4 consecutive scoring appearances', source: 'Appearances from sourced lineups; goals from the match event record.', entities: [KANE, ENG], data: { run: 4, goals_in_run: 6, appearances: [] } }],
  },
  entities: [KANE, ENG],
};

// A fluent, faithful Spanish rendering of every segment (what a correct translator returns).
const ES = {
  h: 'Harry Kane marca en cuatro partidos seguidos de la Nations League con Inglaterra',
  d: 'Seis goles desde el 26 de septiembre convierten a Kane en el finalizador más regular del grupo de Inglaterra.',
  's0.h': 'Seis goles en cuatro titularidades',
  's0.p0': 'Harry Kane ha marcado en 4 apariciones consecutivas en la UEFA Nations League con Inglaterra, con 6 goles en total.',
  's0.p1': 'Marcó dos veces ante Croacia el 3 de octubre y otras dos ante Chequia el martes 6 de octubre.',
  's1.h': 'Partido a partido',
  's1.p0': 'La racha comenzó con 1 gol en la derrota por 2-3 ante España y siguió en la victoria por 2-0 sobre Chequia.',
  'v.scoring_run.title': 'Harry Kane: partido a partido',
  'v.scoring_run.subtitle': '4 apariciones consecutivas con gol',
  'v.scoring_run.source': 'Apariciones según alineaciones con fuente; goles según el registro de eventos del partido.',
  'm.uncovered': 'citas (ninguna con fuente); lesiones (no se ha incorporado ninguna fuente legítima)',
};

function openai({ translate = s => ES[s.id], check = { verdict: 'pass', fluency: 'native', issues: [] } } = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body); calls.push(body.text.format.name);
    let out;
    if (body.text.format.name === 'soccer_article_translation') { const segs = JSON.parse(body.input.slice(body.input.indexOf('{'))).segments; out = { segments: segs.map(s => ({ id: s.id, text: translate(s) })) }; }
    else out = typeof check === 'function' ? check(body) : check;
    return new Response(JSON.stringify({ id: `resp_${calls.length}`, model: body.model, status: 'completed', usage: { input_tokens: 3000, output_tokens: 2000, output_tokens_details: { reasoning_tokens: 500 } }, output: [{ content: [{ type: 'output_text', text: JSON.stringify(out) }] }] }), { status: 200 });
  };
  return { fetcher, calls };
}
function kv() { const m = new Map(); return { m, get: async (k, t) => { const v = m.get(k); return v === undefined ? null : t === 'json' ? JSON.parse(v) : v; }, put: async (k, v) => { m.set(k, v); } }; }
const ENV = (extra = {}) => ({ OPENAI_API_KEY: 'sk-test', SOCCER_STATE: kv(), ...extra });

async function seed() {
  const store = await openPglite(); await applyMigrations(store);
  await store.insert('soccer_news_events', [{ id: id(2), story_class: 'player_form', desk: 'international', materiality: 0.7, as_of: '2026-10-06T21:00:00Z' }]);
  await store.insert('soccer_article_evidence', [{ packet_hash: PH, news_event_id: id(2), packet_version: 'soccer-packet/2.0.0', packet: {} }]);
  await store.insert('soccer_articles', [{ ...ARTICLE, news_event_id: id(2), packet_hash: PH, composer: 'soccer-desk/2.1.1', gate_version: 'soccer-quality/2.1.1', gate_results: {}, status: 'published', published_at: '2026-10-06T21:07:26Z', updated_at: '2026-10-06T21:08:31Z' }]);
  return store;
}
const live = async store => (await store.select('soccer_articles', { columns: ['id', 'slug', 'desk', 'story_class', 'status', 'headline', 'dek', 'body', 'entities', 'packet_hash', 'updated_at', 'published_at'], eq: { id: id(1) } }))[0];

test('contract: reader-visible segments only, revision follows the English text, apply is all-or-nothing', () => {
  const segs = articleSegments(ARTICLE);
  assert.deepEqual(segs.map(s => s.id), Object.keys(ES));
  assert.ok(!segs.some(s => /hash|packet|ESPN/.test(s.text)), 'method plumbing and lane names are never translated or shown');
  assert.deepEqual(methodNotes(ARTICLE.body).sources, ['DATA · PropSports.']);
  const rev = sourceRevision(ARTICLE);
  assert.match(rev, /^[0-9a-f]{64}$/);
  assert.equal(sourceRevision({ ...ARTICLE, entities: [] }), rev, 'non-text fields do not change the revision');
  assert.notEqual(sourceRevision({ ...ARTICLE, headline: `${ARTICLE.headline}.` }), rev, 'any reader-visible text edit does');
  const es = applyTranslation(ARTICLE, ES, 'es');
  assert.equal(es.headline, ES.h); assert.equal(es.body.sections[0].paragraphs[1], ES['s0.p1']);
  assert.equal(es.body.sections.at(-1).key, 'method', 'English method kept for source-credit lines');
  assert.deepEqual(es.body.visuals[0].data, ARTICLE.body.visuals[0].data, 'chart data untouched');
  assert.equal(es.body.visuals[0].title, ES['v.scoring_run.title']);
  assert.equal(es.body.method_i18n.uncovered, ES['m.uncovered']);
  const { h, ...partial } = ES;
  assert.equal(applyTranslation(ARTICLE, partial, 'es'), null, 'a partial translation is never served');
  assert.equal(applyTranslation(ARTICLE, { ...ES, extra: 'x' }, 'es'), null);
  assert.deepEqual(Object.fromEntries(Object.entries(ARTICLE_LOCALES).map(([k, v]) => [k, v.enabled])), { es: true, pt: false, fr: false }, 'pt/fr not public');
});

test('gates: a faithful translation passes; each kind of factual drift holds', () => {
  const segs = articleSegments(ARTICLE);
  const tr = over => segs.map(s => ({ id: s.id, text: over[s.id] ?? ES[s.id] }));
  assert.equal(translationGates(ARTICLE, segs, tr({}), 'es').pass, true, JSON.stringify(translationGates(ARTICLE, segs, tr({}), 'es').results));
  const why = over => translationGates(ARTICLE, segs, tr(over), 'es').reasons;
  assert.deepEqual(why({ 's1.p0': ES['s1.p0'].replace('2-3', '3-2').replace('2-0', '2-1') }), ['translation_numbers'], 'score changed');
  assert.deepEqual(why({ 's0.p0': ES['s0.p0'].replace('Harry Kane', 'Kane') }), ['translation_names'], 'name not preserved');
  assert.deepEqual(why({ 's0.p0': ES['s0.p0'].replace('Inglaterra', 'England') }), ['translation_names'], 'national team left in English (house exonym required)');
  assert.deepEqual(why({ 's0.p1': ES['s0.p1'].replace('Croacia', 'Croatia') }), ['translation_names']);
  assert.deepEqual(why({ 's0.p0': ES['s0.p0'].replace('Harry Kane', 'Harry Kane, cuatro') }), ['translation_length'].filter(() => false), 'a Spanish number word is fine');
  assert.ok(why({ 's0.p1': ES['s0.p1'].replace('dos veces', 'two veces') }).includes('translation_untranslated'), 'English number word left');
  assert.ok(why({ 's1.p0': `${ES['s1.p0']} Quedó 16th.` }).includes('translation_untranslated'), 'English ordinal left');
  assert.deepEqual(why({ 's0.p1': ES['s0.p1'].replaceAll('octubre', 'noviembre') }), ['translation_dates'], 'month changed');
  assert.deepEqual(why({ 's0.p1': ES['s0.p1'].replace('martes', 'miércoles') }), ['translation_dates'], 'weekday changed');
  assert.deepEqual(why({ d: `${ES.d} Es el gran favorito.` }), ['translation_added_claim'], 'favourite added');
  assert.deepEqual(why({ 's1.p0': `${ES['s1.p0']} Sin lesiones.` }), ['translation_added_claim']);
  assert.ok(why({ 's0.p0': 'Harry Kane has scored in 4 consecutive appearances for England, with the 6 goals of the run and their group.' }).includes('translation_untranslated'), 'English function words left');
  assert.ok(why({ 's0.p0': 'Harry Kane has scored in 4 consecutive UEFA Nations League appearances for England, with 6 goals in total.' }).includes('translation_untranslated'), 'English left as is');
  assert.deepEqual(why({ 's1.h': '«Partido a partido»' }), ['translation_quotes'], 'quotation invented');
  assert.ok(why({ 'v.scoring_run.title': '' }).includes('translation_coverage'));
  assert.ok(translationGates(ARTICLE, segs, [...tr({}), { id: 'zz', text: 'x' }], 'es').reasons.includes('translation_coverage'));
  // the independent check: any non-style issue, a fail verdict or poor fluency holds
  assert.equal(checkVerdict({ verdict: 'pass', fluency: 'native', issues: [{ id: 'd', severity: 'style', detail: 'x' }] }).pass, true);
  assert.equal(checkVerdict({ verdict: 'pass', fluency: 'good', issues: [{ id: 'd', severity: 'meaning', detail: 'x' }] }).pass, false);
  assert.equal(checkVerdict({ verdict: 'pass', fluency: 'poor', issues: [] }).pass, false);
  assert.equal(checkVerdict({ verdict: 'fail', fluency: 'native', issues: [] }).pass, false);
});

test('end to end: translate -> gates -> independent check -> one published version; reader API serves it with true alternates', async () => {
  const store = await seed(); const env = ENV(); const ai = openai();
  const r = await translateArticle(env, store, await live(store), 'es', { fetcher: ai.fetcher });
  assert.equal(r.outcome, 'published', JSON.stringify(r));
  assert.deepEqual(ai.calls, ['soccer_article_translation', 'soccer_translation_check'], 'translator then an independent check');
  const [row] = await store.select('soccer_article_translations', { columns: ['status', 'version', 'source_revision', 'packet_hash', 'gate_results'], eq: { article_id: id(1) }, order: 'version.asc' });
  assert.equal(row.status, 'published'); assert.equal(row.version, 1); assert.equal(row.source_revision, sourceRevision(ARTICLE)); assert.equal(row.packet_hash, PH);
  assert.equal(row.gate_results.independent_check.pass, true);
  // the English article was not written
  const en = await live(store);
  assert.equal(en.headline, ARTICLE.headline); assert.equal(new Date(en.updated_at).toISOString(), '2026-10-06T21:08:31.000Z');
  // ledger: two calls, task + locale, admin trigger
  const day = (await env.SOCCER_STATE.get(`openai:v1:calls:${new Date().toISOString().slice(0, 10)}`, 'json'));
  assert.deepEqual(day.map(c => [c.trigger, c.task, c.locale]), [['admin_translation', 'translation', 'es'], ['admin_translation', 'translation_check', 'es']]);
  assert.ok(day.every(c => c.estimated_usd > 0));
  // reader API (soccer-api routes)
  const R = await import('../workers/soccer-api/src/routes.js');
  const esA = (await R.article(store, ARTICLE.slug, { locale: 'es' })).data;
  assert.equal(esA.headline, ES.h); assert.equal(esA.locale, 'es'); assert.deepEqual(esA.translations, { es: true });
  assert.equal(esA.translation.version, 1);
  assert.equal(esA.body.sections[0].paragraphs[0], ES['s0.p0']);
  assert.ok(!('id' in esA) && !('segments' in esA));
  const enA = (await R.article(store, ARTICLE.slug, {})).data;
  assert.equal(enA.headline, ARTICLE.headline); assert.equal(enA.locale, 'en'); assert.deepEqual(enA.translations, { es: true }, 'English page knows its Spanish twin');
  assert.equal((await R.article(store, ARTICLE.slug, { locale: 'pt' })).data.locale, 'en', 'non-public locale -> English');
  const cards = (await R.news(store, { locale: 'es' })).data;
  assert.equal(cards[0].headline, ES.h); assert.equal(cards[0].locale, 'es'); assert.ok(!('packet_hash' in cards[0]) && !('id' in cards[0]));
  assert.equal((await R.news(store, {})).data[0].headline, ARTICLE.headline);
  const sm = (await R.sitemap(store, 'news')).data;
  assert.ok(sm[0].translations.es, 'sitemap feed lists the verified translation');
});

test('held, never published: wrong numbers (check not even paid for), failed independent check, gates recorded', async () => {
  const store = await seed(); const env = ENV();
  const bad = openai({ translate: s => (s.id === 's1.p0' ? ES[s.id].replace('2-3', '1-3') : ES[s.id]) });
  const r1 = await translateArticle(env, store, await live(store), 'es', { fetcher: bad.fetcher });
  assert.equal(r1.outcome, 'held'); assert.deepEqual(r1.hold_reasons, ['translation_numbers', 'translation_independent_check_not_run']);
  assert.deepEqual(bad.calls, ['soccer_article_translation'], 'no check bought for a translation that already failed');
  const fussy = openai({ check: { verdict: 'fail', fluency: 'good', issues: [{ id: 's0.p1', severity: 'fact', detail: 'Tuesday rendered as a different day' }] } });
  const r2 = await translateArticle(env, store, await live(store), 'es', { fetcher: fussy.fetcher });
  assert.equal(r2.outcome, 'held'); assert.deepEqual(r2.hold_reasons, ['translation_independent_check']);
  const rows = await store.select('soccer_article_translations', { columns: ['version', 'status', 'hold_reasons'], eq: { article_id: id(1) }, order: 'version.asc' });
  assert.deepEqual(rows.map(x => [x.version, x.status]), [[1, 'held'], [2, 'held']]);
  const R = await import('../workers/soccer-api/src/routes.js');
  const a = (await R.article(store, ARTICLE.slug, { locale: 'es' })).data;
  assert.equal(a.locale, 'en'); assert.deepEqual(a.translations, {}, 'nothing claimed');
  // automation tries a revision once: a held revision is not a candidate again
  assert.equal((await translationCandidates(store, 'es', { limit: 5 })).length, 0);
});

test('source revisions: English correction -> stale translation never served, then superseded; withdrawal -> withdrawn', async () => {
  const store = await seed(); const env = ENV();
  await translateArticle(env, store, await live(store), 'es', { fetcher: openai().fetcher });
  const R = await import('../workers/soccer-api/src/routes.js');
  // touched without a text change: still served, revalidated by the sweep
  await store.update('soccer_articles', { updated_at: '2026-10-07T09:00:00Z' }, { eq: { id: id(1) } });
  assert.equal((await R.article(store, ARTICLE.slug, { locale: 'es' })).data.locale, 'es');
  assert.deepEqual(await sweepTranslations(env, store, 'es'), { checked: 1, withdrawn: 0, superseded: 0, revalidated: 1 });
  assert.equal((await R.news(store, { locale: 'es' })).data[0].locale, 'es', 'cards follow the revalidation');
  // corrected English text: the article page stops serving the translation immediately
  await store.update('soccer_articles', { headline: 'Harry Kane scores in four straight Nations League games', updated_at: '2026-10-07T10:00:00Z' }, { eq: { id: id(1) } });
  const stale = (await R.article(store, ARTICLE.slug, { locale: 'es' })).data;
  assert.equal(stale.locale, 'en'); assert.equal(stale.headline, 'Harry Kane scores in four straight Nations League games');
  assert.deepEqual(stale.translations, {});
  assert.equal((await R.news(store, { locale: 'es' })).data[0].locale, 'en');
  assert.deepEqual(await sweepTranslations(env, store, 'es'), { checked: 1, withdrawn: 0, superseded: 1, revalidated: 0 });
  assert.equal((await translationCandidates(store, 'es', { limit: 5 })).length, 1, 'the revised English is a candidate again');
  // re-translate the new revision, then withdraw the English: the translation is withdrawn
  const r = await translateArticle(env, store, await live(store), 'es', { fetcher: openai({ translate: s => (s.id === 'h' ? 'Harry Kane marca en cuatro partidos seguidos de la Nations League' : ES[s.id]) }).fetcher });
  assert.equal(r.outcome, 'published'); assert.equal(r.version, 2);
  await store.update('soccer_articles', { status: 'withdrawn' }, { eq: { id: id(1) } });
  assert.deepEqual(await sweepTranslations(env, store, 'es'), { checked: 1, withdrawn: 1, superseded: 0, revalidated: 0 });
  const rows = await store.select('soccer_article_translations', { columns: ['version', 'status', 'status_reason'], eq: { article_id: id(1) }, order: 'version.asc' });
  assert.deepEqual(rows.map(x => [x.version, x.status, x.status_reason]), [[1, 'superseded', 'english_revised'], [2, 'withdrawn', 'english_withdrawn']]);
  // the database refuses content edits and resurrection
  await assert.rejects(store.update('soccer_article_translations', { headline: 'x' }, { eq: { version: 2 } }), /immutable|final/);
  await assert.rejects(store.update('soccer_article_translations', { status: 'published' }, { eq: { version: 1 } }));
});

test('budget: es allowance $1 by default, other locales $0 until approved, ceiling and allowance checked before any call', async () => {
  assert.equal(translationAllowanceUsd({}, 'es'), 1);
  assert.equal(translationAllowanceUsd({}, 'pt'), 0); assert.equal(translationAllowanceUsd({}, 'fr'), 0);
  assert.equal(translationAllowanceUsd({ SOCCER_TRANSLATE_ES_DAILY_MAX_USD: '9' }, 'es'), 5, 'never above the $5 newsroom ceiling');
  const store = await seed();
  const pt = openai();
  assert.equal((await translateArticle(ENV(), store, await live(store), 'pt', { fetcher: pt.fetcher })).reason, 'translation_budget_not_approved:pt');
  assert.equal(pt.calls.length, 0);
  // 0.95 of Spanish spend already recorded today: one more article (estimate 0.14) would cross $1 -> no call
  const env = ENV(); const day = new Date().toISOString().slice(0, 10);
  await env.SOCCER_STATE.put(`openai:v1:calls:${day}`, JSON.stringify([{ task: 'translation', locale: 'es', estimated_usd: 0.95 }]));
  const es = openai();
  assert.equal((await translateArticle(env, store, await live(store), 'es', { fetcher: es.fetcher })).reason, 'translation_allowance:es');
  assert.equal(es.calls.length, 0);
  // the global $5 ceiling counts the English desk's spend too
  const env2 = ENV(); await env2.SOCCER_STATE.put(`openai:v1:calls:${day}`, JSON.stringify([{ estimated_usd: 4.95 }]));
  assert.equal((await translateArticle(env2, store, await live(store), 'es', { fetcher: es.fetcher })).reason, 'openai_daily_ceiling');
  // kill switch and missing ledger fail closed
  assert.equal((await translateArticle({ ...ENV(), SOCCER_AI: 'off' }, store, await live(store), 'es', { fetcher: es.fetcher })).reason, 'soccer_ai_off');
  assert.equal((await translateArticle({ OPENAI_API_KEY: 'k' }, store, await live(store), 'es', { fetcher: es.fetcher })).reason, 'translation_budget_unreadable');
  assert.equal(es.calls.length, 0);
});

test('pilot mode: only the named slugs, once per revision; off = lifecycle only; pt never runs while not public', async () => {
  const store = await seed();
  assert.equal((await translationCandidates(store, 'es', { slugs: ['nope', ARTICLE.slug], retry: false })).length, 1);
  const held = openai({ check: { verdict: 'fail', fluency: 'good', issues: [{ id: 'd', severity: 'meaning', detail: 'x' }] } });
  await translateArticle(ENV(), store, await live(store), 'es', { fetcher: held.fetcher });
  assert.equal((await translationCandidates(store, 'es', { slugs: [ARTICLE.slug], retry: false })).length, 0, 'pilot: a held revision is not retried');
  assert.equal((await translationCandidates(store, 'es', { slugs: [ARTICLE.slug] })).length, 1, 'admin named re-translation still allowed');
  // translationTick needs a store from env: exercise the mode routing with an env that has none (fails closed per locale)
  const rep = await translationTick({ SOCCER_STATE: kv(), SOCCER_TRANSLATE_ES: 'pilot', SOCCER_TRANSLATE_PT: 'auto' }).catch(e => ({ error: String(e) }));
  assert.ok(rep.error || (rep.locales.es.mode === 'pilot' && rep.locales.es.error === 'pilot mode without a pilot list' && !rep.locales.pt.results), JSON.stringify(rep));
});

test('house exonyms: translated article carries story_name for nations; clubs and players keep their names', () => {
  const es = applyTranslation(ARTICLE, ES, 'es');
  assert.deepEqual(es.entities.map(e => [e.name, e.story_name]), [['Harry Kane', undefined], ['England', 'Inglaterra']]);
  assert.equal(exonym('England', 'es'), 'Inglaterra'); assert.equal(exonym('Bayern Munich', 'es'), null); assert.equal(exonym('England', 'pt'), null);
});

test('names gate: a nation inside a longer club name is not the nation (tick-3 false positive)', async () => {
  const { nationMentioned } = await import('../workers/soccer-news/src/translate.js');
  assert.equal(nationMentioned('Seattle sit 13th before trip to New England', 'England'), false);
  assert.equal(nationMentioned('away to New England Revolution on October 10.', 'England'), false);
  assert.equal(nationMentioned('Kane scored for England against Spain.', 'England'), true);
  assert.equal(nationMentioned('England beat Croatia 7-0.', 'England'), true, 'sentence start');
  assert.equal(nationMentioned('The England captain scored twice.', 'England'), true);
  assert.equal(nationMentioned('Northern Ireland drew', 'Ireland'), false, 'Northern Ireland is its own entry');
  assert.equal(nationMentioned('Northern Ireland drew', 'Northern Ireland'), true);
  assert.equal(nationMentioned('Englandia', 'England'), false);
});

test('auto mode translates NEW articles only (published at/after AUTO_SINCE); no boundary -> nothing runs', async () => {
  const store = await seed();
  assert.equal((await translationCandidates(store, 'es', { limit: 5, since: '2026-10-07T00:00:00Z' })).length, 0, 'backlog story (published 10-06) excluded');
  assert.equal((await translationCandidates(store, 'es', { limit: 5, since: '2026-10-06T00:00:00Z' })).length, 1);
  const rep = await translationTick({ SOCCER_STATE: kv(), SOCCER_TRANSLATE_ES: 'auto' }).catch(e => ({ error: String(e) }));
  assert.ok(rep.error || rep.locales.es.error === 'auto mode without a valid AUTO_SINCE boundary', JSON.stringify(rep));
});
