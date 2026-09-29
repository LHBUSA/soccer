// ESPN published standings -> season groups (MLS conferences, UCL league phase, tournament
// groups such as UEFA Nations League A1..D2 with their League A..D tier),
// membership and the provider's standings rows. Structured facts only (ESPN secondary
// source, owner-approved). Captures are archived before any row references them.
//
// These rows are NOT shown directly: soccer-api publishes a group table only when
// every count (P W D L GF GA PTS) equals the table recomputed from our canonical
// results, so the provider supplies membership, official rank (its tie-breakers) and
// zone notes, and our graph proves the numbers.
import * as espn from '../../providers/espn.js';
import { syncRows } from './store.js';
import { childId } from '../../shared/ids.js';
import { espnClient } from './espn-jobs.js';
import { ensureCompetitionSeason } from './espn-lane.js';
import { queueIdentity } from './identity.js';

export const STANDINGS_LANE = 'espn_standings';
export const STANDINGS_VERSION = 'espn-standings/1.1.0';
const STAT = { gamesPlayed: 'played', wins: 'won', ties: 'drawn', losses: 'lost', pointsFor: 'goals_for', pointsAgainst: 'goals_against', pointDifferential: 'goal_difference', points: 'points', deductions: 'deductions', rank: 'rank' };

export function parseStandingsEntry(e) {
  const teamId = espn.refId(e?.team?.$ref, 'teams');
  if (!teamId) throw new espn.EspnShapeError('standings entry without team');
  const overall = (e.records || []).find(r => r.type === 'total' || r.name === 'overall') || (e.records || [])[0];
  if (!overall) throw new espn.EspnShapeError(`standings entry ${teamId} without overall record`);
  const out = { team_external_id: teamId, note: e.note?.description || null, note_rank: Number.isFinite(Number(e.note?.rank)) ? Number(e.note.rank) : null };
  for (const s of overall.stats || []) if (STAT[s.name]) out[STAT[s.name]] = s.value === '' || s.value === null || s.value === undefined || !Number.isFinite(Number(s.value)) ? null : Number(s.value);
  return out;
}

export function groupKey(group, type) {
  if (type === 'league_phase') return 'league-phase';
  const key = String(group.abbreviation || group.name || group.id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-conference$/, '');
  return type === 'group' ? key.replace(/^group-/, '') : key; // "Group A1" -> a1
}

// Tier parent from the SOURCE group code when the registry says the competition names its
// groups <tier letter><number> (UEFA Nations League: "Group A1" belongs to League A). Used only
// when the provider does not publish the tier as a parent group itself; never from a team name.
export function parentFromCode(group, prefix) {
  if (!prefix) return null;
  const m = String(group.abbreviation || group.name || '').match(/^(?:group\s+)?([A-Z])(\d{1,2})$/i);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  return { key: `${prefix.toLowerCase()}-${letter.toLowerCase()}`, name: `${prefix} ${letter}`, letter, order: letter.charCodeAt(0) * 100 + Number(m[2]) };
}

// ESPN sometimes publishes one combined zone note for every tier ("A: Qualifies for QFs;
// B-D: Promotion playoffs"). For a group whose tier letter is known, keep only the segment
// that names that tier; a note with no tier-scoped segments is returned unchanged; a scoped
// note that does not name this tier gives null (never borrowed from another tier).
export function scopedNote(note, letter) {
  if (!note || !letter) return note || null;
  const segs = String(note).split(';').map(x => x.trim()).filter(Boolean);
  const scoped = segs.map(seg => seg.match(/^([A-Z](?:\s*[-,]\s*[A-Z])*)\s*:\s*(.+)$/));
  if (!scoped.some(Boolean)) return note;
  for (const m of scoped) {
    if (!m) continue;
    const letters = new Set();
    for (const part of m[1].split(',').map(x => x.trim())) {
      const r = part.match(/^([A-Z])\s*-\s*([A-Z])$/);
      if (r) for (let c = r[1].charCodeAt(0); c <= r[2].charCodeAt(0); c++) letters.add(String.fromCharCode(c));
      else letters.add(part);
    }
    if (letters.has(letter)) return m[2].trim();
  }
  return null;
}

export async function runEspnStandings({ store, storage, registry, state, now = Date.now(), fetcher, budget = 40, force = false }) {
  const last = state.last_success_at ? Date.parse(state.last_success_at) : 0;
  if (!force && now - last < 55 * 60e3) return { skipped: 'cadence' };
  const client = espnClient({ storage, store, fetcher, budget, registry });
  const results = [];
  let observed = 0; let changed = 0;
  for (const comp of registry.competitions.filter(c => c.espn?.enabled && c.espn?.standings)) {
    const league = comp.espn.league; const type = comp.espn.standings.group_type; const seasonType = comp.espn.standings.season_type || 1;
    const r = { competition: comp.slug, groups: 0, rows: 0 };
    const { json: lj } = await client.get(espn.urls.league(league));
    const year = espn.seasonYearOf(lj.season?.$ref);
    const { seasonId } = await ensureCompetitionSeason(store, { comp, year });
    const { json: gl } = await client.get(`${espn.CORE}/${league}/seasons/${year}/types/${seasonType}/groups`);
    const groups = []; const members = []; const standings = [];
    if (!Array.isArray(gl.items)) throw new espn.EspnShapeError('group list without items');
    // Walk the provider's real group tree: a group with children is a tier (kept as the
    // parent of its leaves); only leaves carry standings. Flat lists are depth 0.
    const leaves = [];
    const walk = async (ref, parent, depth) => {
      const { json: g, capture: gCap } = await client.get(`${espn.CORE}/${league}/seasons/${year}/types/${seasonType}/groups/${ref}`);
      if (g.children?.$ref && depth < 3) {
        const { json: kids } = await client.get(espn.https(g.children.$ref));
        const tier = { key: groupKey(g, 'conference'), name: g.name || g.abbreviation || String(g.id) };
        for (const k of (kids.items || []).map(i => espn.refId(i.$ref, 'groups')).filter(Boolean)) await walk(k, tier, depth + 1);
        return;
      }
      leaves.push({ ref, g, gCap, parent });
    };
    for (const ref of gl.items.map(i => espn.refId(i.$ref, 'groups')).filter(Boolean)) await walk(ref, null, 0);
    r.groups_in_source = leaves.length;
    if (comp.espn.standings.expected_groups && leaves.length !== comp.espn.standings.expected_groups) r.group_count_note = `source lists ${leaves.length} groups, format expects ${comp.espn.standings.expected_groups}`;
    for (const { ref, g, gCap, parent: treeParent } of leaves) {
      const coded = parentFromCode(g, comp.espn.standings.parent_from_code);
      const parent = treeParent || coded;
      const { json: sj, capture: sCap } = await client.get(`${espn.CORE}/${league}/seasons/${year}/types/${seasonType}/groups/${ref}/standings/0`);
      await client.flush();
      const entries = (sj.standings || []).map(parseStandingsEntry);
      const ext = entries.map(e => e.team_external_id);
      const xw = new Map((await store.select('soccer_team_external_ids', { columns: ['external_id', 'team_id'], eq: { provider: 'espn' }, in: { external_id: ext } })).map(x => [x.external_id, x.team_id]));
      const missing = ext.filter(x => !xw.has(x));
      if (missing.length) {
        // No partial group: an unresolved member means the whole group waits.
        for (const m of missing) await queueIdentity(store, { entity_type: 'team', provider: 'espn', external_id: m, reason: 'standings_member_unresolved', payload: { competition: comp.slug, group: g.name } });
        r.unresolved = (r.unresolved || 0) + missing.length; continue;
      }
      const key = groupKey(g, type);
      const gid = childId('group', seasonId, key);
      groups.push({ id: gid, season_id: seasonId, group_key: key, name: type === 'league_phase' ? 'League phase' : g.name, abbreviation: g.abbreviation || null, group_type: type, provider: 'espn', external_id: String(g.id), capture_id: gCap.capture_id, updated_at: new Date(now).toISOString(),
        ...(type === 'group' ? { parent_group_key: parent?.key || null, parent_name: parent?.name || null, sort_order: coded?.order ?? leaves.findIndex(l => l.ref === ref) } : {}) });
      for (const e of entries) {
        members.push({ group_id: gid, team_id: xw.get(e.team_external_id), provider: 'espn', capture_id: sCap.capture_id, observed_at: sCap.captured_at });
        standings.push({ group_id: gid, team_id: xw.get(e.team_external_id), provider: 'espn', rank: e.rank, played: e.played, won: e.won, drawn: e.drawn, lost: e.lost, goals_for: e.goals_for, goals_against: e.goals_against, goal_difference: e.goal_difference, points: e.points, deductions: e.deductions, note: coded ? scopedNote(e.note, coded.letter) : e.note, note_rank: e.note_rank, capture_id: sCap.capture_id, observed_at: sCap.captured_at });
      }
    }
    const count = s => { changed += (s?.inserted || 0) + (s?.updated || 0); return s; };
    count(await syncRows(store, { table: 'soccer_season_groups', key: ['id'], rows: groups, compare: ['name', 'abbreviation', 'external_id', ...(groups.some(g => 'parent_group_key' in g) ? ['parent_group_key', 'parent_name', 'sort_order'] : [])] }));
    count(await syncRows(store, { table: 'soccer_season_group_members', key: ['group_id', 'team_id'], rows: members, compare: ['provider'] }));
    count(await syncRows(store, { table: 'soccer_source_standings', key: ['group_id', 'team_id', 'provider'], rows: standings, compare: ['rank', 'played', 'won', 'drawn', 'lost', 'goals_for', 'goals_against', 'points', 'note', 'deductions'] }));
    r.groups = groups.length; r.rows = standings.length; observed += standings.length;
    results.push(r);
  }
  await client.flush();
  return { observed, changed, results, requests: client.used, parserVersion: STANDINGS_VERSION };
}
