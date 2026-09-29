// News primary subject + media: one rule for cards and article pages; never another person's face.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headlineNamesPerson, markPrimary, primaryFromPacket, selectSubject, subjectMedia } from '../workers/shared/news-subject.js';

const T = (id, name) => ({ type: 'SportsTeam', id, name, slug: name.toLowerCase().replace(/\W+/g, '-') });
const P = (id, name) => ({ type: 'Person', id, name, slug: name.toLowerCase().replace(/\W+/g, '-') });
const bayern = T('t-bay', 'Bayern München'); const union = T('t-uni', '1. FC Union Berlin');
const olise = P('p-oli', 'Michael Olise'); const kane = P('p-kan', 'Harry Kane'); const musiala = P('p-mus', 'Jamal Musiala');
// The production Olise article's entity order: the teammates come BEFORE Olise.
const oliseEnts = [bayern, union, { type: 'SportsEvent', id: 'm1', name: 'Bayern München v 1. FC Union Berlin' }, { type: 'SportsOrganization', name: 'Bundesliga', slug: 'bundesliga' }, musiala, kane, olise];
const portraits = (...ps) => new Map(ps.map(p => [p.id, { url: `/img/${p.id}`, attribution: 'x' }]));
const crests = (...ts) => new Map(ts.map(t => [t.id, [{ url: `/crest/${t.id}`, attribution: 'y' }]]));

test('surname headline selects the named player (Olise), never a teammate listed first', () => {
  const s = selectSubject({ headline: 'Olise hat-trick drives Bayern München to 7-0 rout of 1. FC Union Berlin', story_class: 'match_recap', entities: oliseEnts });
  assert.equal(s.entity.id, olise.id); assert.equal(s.reason, 'headline_surname');
  assert.equal(subjectMedia(s, portraits(musiala, kane, olise), crests(bayern), oliseEnts).url, '/img/p-oli');
});

test('no approved portrait for the subject: own team crest, never a teammate with a photo', () => {
  const ents = markPrimary(oliseEnts, { id: olise.id, type: 'Person', reason: 'hat_trick', team_id: bayern.id });
  const s = selectSubject({ headline: 'Olise hat-trick drives Bayern München to 7-0 rout', entities: ents });
  const m = subjectMedia(s, portraits(musiala, kane), crests(bayern, union), ents);
  assert.equal(m.kind, 'crest'); assert.equal(m.url, '/crest/t-bay'); assert.equal(m.fallback, 'subject_team');
  assert.equal(subjectMedia(s, portraits(musiala, kane), new Map(), ents), null, 'nothing -> competition graphic, not Kane');
});

test('full-name headline (Kane) and accents/punctuation normalisation', () => {
  assert.equal(selectSubject({ headline: 'Harry Kane scores twice as Bayern win', entities: oliseEnts }).entity.id, kane.id);
  assert.equal(selectSubject({ headline: 'Kane scores twice', entities: oliseEnts }).entity.id, kane.id);
  const ramirez = P('p-ram', 'Christian Ramírez');
  assert.equal(headlineNamesPerson('Ramirez double lifts Austin', ramirez, [ramirez]), 'surname');
  assert.equal(headlineNamesPerson('Kaneda strikes late', kane, [kane]), null, 'no substring match');
});

test('explicit primary subject wins over the headline', () => {
  const ents = markPrimary(oliseEnts, { id: kane.id, type: 'Person', reason: 'player_form', team_id: bayern.id });
  assert.equal(ents.filter(e => e.primary).length, 1);
  const s = selectSubject({ headline: 'Olise hat-trick drives Bayern', entities: ents });
  assert.equal(s.entity.id, kane.id); assert.equal(s.reason, 'primary:player_form');
  assert.equal(markPrimary(ents, { id: olise.id, type: 'Person', reason: 'hat_trick' }).filter(e => e.primary).map(e => e.id).join(), olise.id, 'remarking moves the single marker');
  assert.equal(markPrimary(oliseEnts, { id: 'unknown', type: 'Person' }).some(e => e.primary), false, 'never invents an entity');
});

test('duplicate surnames are ambiguous: no surname match, falls back to the headline team', () => {
  const a = P('p-s1', 'Bernardo Silva'); const b = P('p-s2', 'Rúben Silva'); const city = T('t-mci', 'Manchester City');
  const ents = [city, a, b];
  const s = selectSubject({ headline: 'Silva strike sends Manchester City top', entities: ents });
  assert.equal(s.entity.id, city.id); assert.equal(s.reason, 'headline_team');
  assert.equal(subjectMedia(s, portraits(a, b), crests(city), ents).kind, 'crest');
});

test('team subject and a story with no person subject', () => {
  const ents = [bayern, union, musiala];
  const s = selectSubject({ headline: 'Bayern München make it 6 Bundesliga wins in a row', story_class: 'team_trend', entities: ents });
  assert.equal(s.entity.id, bayern.id);
  assert.equal(subjectMedia(s, portraits(musiala), crests(bayern), ents).url, '/crest/t-bay', 'a team story never borrows a player face');
  assert.equal(subjectMedia(selectSubject({ headline: 'Matchday', entities: [{ type: 'SportsOrganization', name: 'Bundesliga' }] }), new Map(), new Map()), null);
});

test('multiple players in the headline: the leftmost full-name match', () => {
  const s = selectSubject({ headline: 'Jamal Musiala and Harry Kane lead Bayern past Union', entities: oliseEnts });
  assert.equal(s.entity.id, musiala.id);
});

test('primaryFromPacket: hat-trick scorer > leader change > brace > winner; form/trend/table subjects', () => {
  const teams = { home: { id: bayern.id, name: bayern.name }, away: { id: union.id, name: union.name } };
  const g = (pl, team) => ({ scorer: { id: pl.id, name: pl.name }, team, own_goal: false });
  const recap = { event: { kind: 'match_recap' }, teams, match: { winner: 'home' }, goals: [g(olise, 'home'), g(kane, 'home'), g(olise, 'home'), g(kane, 'home'), g(olise, 'home')], angles: [] };
  assert.deepEqual(primaryFromPacket(recap), { id: olise.id, type: 'Person', reason: 'hat_trick', team_id: bayern.id });
  assert.equal(primaryFromPacket({ ...recap, goals: recap.goals.slice(0, 4), angles: [{ key: 'leader_change', detail: { new_leader: bayern.id } }] }).reason, 'leader_change');
  assert.equal(primaryFromPacket({ ...recap, goals: recap.goals.slice(0, 2).concat([g(olise, 'home')]).slice(0, 2) }).reason, 'match_winner');
  assert.equal(primaryFromPacket({ event: { kind: 'player_form' }, player: { id: kane.id }, team: { id: bayern.id } }).id, kane.id);
  assert.equal(primaryFromPacket({ event: { kind: 'team_trend' }, team: { id: bayern.id } }).type, 'SportsTeam');
  assert.equal(primaryFromPacket({ event: { kind: 'competition_intelligence' }, table: { top: [{ team: { id: bayern.id } }] } }).id, bayern.id);
});
