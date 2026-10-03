// Group tournaments on the web (UEFA Nations League): International navigation, tier -> group tables,
// no overall table, nation language on national-team surfaces, club pages unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CLUB_COMPS, INTERNATIONAL_COMPS, compMeta, isNationalComp } from '../../src/lib/competitions.js';
import { groupTables, tableView } from '../../src/components/table.js';
import { tables } from '../../src/pages/lists.js';
import { team } from '../../src/pages/people.js';
import { upstreamUrl } from '../../api/soccer.js';

const nation = (slug, name) => ({ slug, name, short_name: name, type: 'national' });
const row = (pos, t, pts) => ({ position: pos, team: t, played: 2, won: pts / 3, drawn: 0, lost: 2 - pts / 3, points: pts, goals_for: 2, goals_against: 1, goal_difference: 1, form: [] });
const ENV = { data: { view: 'groups', season: '2026/27', rows: [], verified_groups: 2, withheld_groups: 1,
  tiers: [{ key: 'league-a', name: 'League A', groups: ['a1', 'a2'] }, { key: 'league-d', name: 'League D', groups: ['d1'] }],
  groups: [
    { key: 'a1', name: 'Group A1', abbreviation: 'Group A1', parent: { key: 'league-a', name: 'League A' }, verified: true, rows: [row(1, nation('france', 'France'), 6), row(2, nation('italy', 'Italy'), 3)] },
    { key: 'a2', name: 'Group A2', abbreviation: 'Group A2', parent: { key: 'league-a', name: 'League A' }, verified: true, rows: [row(1, nation('spain', 'Spain'), 6)] },
    { key: 'd1', name: 'Group D1', abbreviation: 'Group D1', parent: { key: 'league-d', name: 'League D' }, verified: false, withheld_reason: 'published standings disagree with canonical results', rows: [] },
  ] }, meta: { semantics: 'x', coverage: { state: 'partial', notes: [] } } };

test('registry: club chips vs the INTERNATIONAL menu; groups format; national teams', () => {
  assert.deepEqual(CLUB_COMPS.map(c => c.slug), ['mls', 'premier-league', 'la-liga', 'serie-a', 'ligue-1', 'bundesliga', 'uefa-champions-league', 'uefa-europa-league']);
  assert.deepEqual(INTERNATIONAL_COMPS.map(c => c.slug), ['uefa-nations-league', 'fifa-world-cup']);
  assert.deepEqual([compMeta('uefa-nations-league').format, compMeta('uefa-nations-league').mono, compMeta('uefa-nations-league').desk], ['groups', 'UNL', 'international']);
  assert.equal(compMeta('uefa-champions-league').format, 'ucl'); // UCL format not overloaded
  assert.ok(isNationalComp('uefa-nations-league') && !isNationalComp('mls'));
});

test('group tables: tier tabs, one card per group, withheld group explained, never an overall table', () => {
  const h = groupTables(ENV);
  assert.ok(h.includes('League A') && h.includes('League D'));
  assert.equal((h.match(/data-gcard=/g) || []).length, 3);
  assert.ok(h.includes('Table withheld') && h.includes('WITHHELD') && h.includes('VERIFIED'));
  assert.ok(h.includes('>Nation<') && !h.includes('>Club<'));
  assert.ok(h.includes('data-gpick="a1"') && h.includes('data-gpick="a2"')); // phone group picker
  assert.ok(!/overall/i.test(h));
  assert.ok(groupTables({ data: { groups: [] } }).includes('never computes an overall table'));
  // /tables renders the same group tables for a group competition
  const tb = tables.render({ comp: 'uefa-nations-league', comps: { status: 'fulfilled', value: { data: [{ slug: 'mls' }, { slug: 'uefa-nations-league' }] } }, table: { status: 'fulfilled', value: ENV }, confs: [] });
  assert.ok(tb.includes('UEFA Nations League') && tb.includes('data-gcard="a1"') && tb.includes('HOW GROUP TABLES ARE VERIFIED'));
});

test('club tables keep the Club column', () => {
  const h = tableView({ data: { rows: [row(1, { slug: 'a', name: 'A FC' }, 3)] }, meta: {} });
  assert.ok(h.includes('>Club<') && !h.includes('>Nation<'));
});

test('national team page: nation language, group position only, no club wording', () => {
  const env = { data: { name: 'France', type: 'national', form: ['W'], recent: [], upcoming: [],
    records: [{ competition: { slug: 'uefa-nations-league', name: 'UEFA Nations League' }, season: '2026/27', position: 1, teams_in_table: 4, group: { key: 'a1', name: 'Group A1', abbreviation: 'Group A1' }, record: { played: 2, won: 2, drawn: 0, lost: 0, goal_difference: 2, points: 6, form: ['W', 'W'] } },
      { competition: { slug: 'uefa-nations-league', name: 'UEFA Nations League' }, season: '2026/27', position: null, teams_in_table: null, group: { key: 'd1', name: 'Group D1', abbreviation: 'Group D1' }, record: { played: 1, won: 1, drawn: 0, lost: 0, goal_difference: 1, points: 3, form: ['W'] } }],
    players_observed: { lineups_counted: 2, players: [{ slug: 'p', name: 'P', role: 'forward', appearances: 2, starts: 2, named: 2 }] } }, meta: { source: 'pbe', coverage: { state: 'ok', notes: [] } } };
  const h = team.render({ env });
  assert.ok(h.includes('NATIONAL TEAM') && h.includes('SQUAD') && h.includes('of 4 · Group A1') && h.includes('Group D1 · table withheld'));
  assert.ok(!/\bclubs?\b/i.test(h.replace(/club football|club-league/gi, '')), 'no club wording on a national team page');
});

test('the same-origin proxy forwards expand=groups (group rows reach the page in production)', () => {
  const u = upstreamUrl('https://soccer.propbetedge.ai/api/soccer/table?competition=uefa-nations-league&expand=groups&evil=1');
  assert.equal(u.searchParams.get('expand'), 'groups');
  assert.equal(u.searchParams.get('evil'), null);
});

test('WOMEN menu group: only enabled women\'s competitions, never in the club rail', async () => {
  const { WOMEN_COMPS } = await import('../../src/lib/competitions.js');
  assert.deepEqual(WOMEN_COMPS.map(c => c.slug), ['womens-super-league', 'uefa-womens-champions-league', 'liga-f']);
  assert.ok(WOMEN_COMPS.every(c => c.gender === 'women'));
  assert.ok(!CLUB_COMPS.some(c => c.gender === 'women'));
});
