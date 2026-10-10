// Lineup readiness (Market Disagreement Radar V1, soccer#17): is a confirmed starting XI known BEFORE kickoff, and from
// a source whose pregame lineups we may publish? Counts + provenance only (no player names, never a guessed identity).
// Lineups are independent context: they are never an input to the frozen Soccer Algo forecasts or Official Picks.
//
//   CONFIRMED            both sides exactly 11 starters, captured before kickoff, by a provider whose pregame lineups are
//                        public for this competition (registry: espn.live_enrichment === 'public' for the ESPN lane).
//   PARTIAL              a rights-cleared pregame capture exists but is not 11 + 11 (reason PARTIAL_XI).
//   POST_KICKOFF_RECORD  the stored lineup was captured at or after kickoff (e.g. the post-final detail fill): a record of
//                        who played, never presented as a pregame XI.
//   UNAVAILABLE          nothing usable before kickoff: NO_RIGHTS_CLEARED_PREGAME_SOURCE (no provider is public for this
//                        competition; Bundesliga's ESPN enrichment is SHADOW), NOT_YET_PUBLISHED, or PROVIDER_ERROR.
// Read-only: only select() is ever called.
import registryData from '../../../data/registry/competitions.json' with { type: 'json' };
import { chunkArr } from '../../soccer-ingest/src/store.js';
import { envelope } from './envelope.js';
import { API_VERSION } from './routes.js';

const E = (data, o) => envelope(data, { version: API_VERSION, source: 'pbe', ...o });

export const LINEUP_STATES = Object.freeze(['CONFIRMED', 'PARTIAL', 'POST_KICKOFF_RECORD', 'UNAVAILABLE']);
const NEUTRAL_SOURCE = 'PropSports'; // network source-brand standard: no upstream brand on public payloads
const iso = v => (v === null || v === undefined ? null : new Date(v).toISOString());

/** Lineup providers whose PREGAME lineups are public for a competition, and the competition's rights label. */
export function lineupRights(slug, registry = registryData) {
  const rc = registry.competitions.find(c => c.slug === slug);
  const mode = rc?.espn?.enabled ? rc.espn.live_enrichment : undefined;
  const publicProviders = new Set(mode === 'public' ? ['espn'] : []);
  return { publicProviders, source_rights: publicProviders.size ? 'pregame_public' : mode === 'shadow' ? 'shadow_only' : 'none' };
}

const NOTES = {
  CONFIRMED: 'Both starting XIs (11 + 11) were captured before kickoff from a rights-cleared source.',
  PARTIAL_XI: 'A rights-cleared pregame lineup was captured, but not a complete 11 + 11 starting XI.',
  POST_KICKOFF_RECORD: 'The stored lineups were captured after kickoff. They record who played and are not a pregame XI.',
  NO_RIGHTS_CLEARED_PREGAME_SOURCE: 'No rights-cleared pregame lineup source exists for this competition. The only lineup source is held for internal validation until source rights are cleared, so the starting XI is unknown before kickoff.',
  NOT_YET_PUBLISHED: 'No starting XI has been published by a rights-cleared source yet.',
  PROVIDER_ERROR: 'The lineup source could not be read for this match; the starting XI is unknown.',
};

/** Pure decision from the stored rows (exported for tests). */
export function decideReadiness({ match, slug, lineups = [], players = [], captures = new Map(), enrichment = [], now = Date.now(), registry = registryData }) {
  const { publicProviders, source_rights } = lineupRights(slug, registry);
  const kickoff = Date.parse(match.kickoff_at);
  const sideOf = l => (l.team_id === match.home_team_id ? 'home' : l.team_id === match.away_team_id ? 'away' : null);
  const built = {};
  for (const l of lineups) {
    const side = sideOf(l); if (!side) continue;
    const mine = players.filter(p => p.lineup_id === l.id);
    const capturedAt = captures.get(l.capture_id) ?? null;
    built[side] = {
      starters: mine.filter(p => p.is_starter).length, bench: mine.filter(p => !p.is_starter).length,
      provider: NEUTRAL_SOURCE, captured_at: iso(capturedAt), team_id: l.team_id,
      pregame: capturedAt !== null && Date.parse(iso(capturedAt)) < kickoff,
      cleared: publicProviders.has(l.provider),
    };
  }
  const present = ['home', 'away'].filter(s => built[s]);
  const pregamePublic = present.filter(s => built[s].pregame && built[s].cleared);
  const out = (state, reason, sidesVisible = true) => ({
    state, reason, kickoff_at: iso(match.kickoff_at), checked_at: new Date(now).toISOString(),
    sides: Object.fromEntries(['home', 'away'].map(s => [s, sidesVisible && built[s] ? (({ pregame, cleared, ...rest }) => rest)(built[s]) : null])),
    source_rights, note: NOTES[reason || state],
  });
  if (pregamePublic.length === 2 && pregamePublic.every(s => built[s].starters === 11)) return out('CONFIRMED', null);
  if (pregamePublic.length) return out('PARTIAL', 'PARTIAL_XI');
  // Captured after kickoff (or at an unprovable time once kickoff has passed): a record, never a pregame XI.
  if (present.length && present.every(s => !built[s].pregame) && now >= kickoff) return out('POST_KICKOFF_RECORD', null);
  // Anything else stored is not publishable as pregame (a non-cleared pregame capture is never surfaced).
  if (source_rights !== 'pregame_public') return out('UNAVAILABLE', 'NO_RIGHTS_CLEARED_PREGAME_SOURCE', false);
  if (enrichment.some(e => e.component.startsWith('lineup') && publicProviders.has(e.provider) && e.status === 'unavailable')) return out('UNAVAILABLE', 'PROVIDER_ERROR', false);
  return out('UNAVAILABLE', 'NOT_YET_PUBLISHED', false);
}

/** Readiness for many matches with bounded reads (lineup players chunked well under the PostgREST 1000-row cap). */
export async function readinessFor(store, matches, { now = Date.now(), slugByCompetition, registry = registryData } = {}) {
  const ids = [...new Set(matches.map(m => m.id))];
  const lineups = []; const enrichment = [];
  for (const part of chunkArr(ids, 60)) {
    lineups.push(...await store.select('soccer_lineups', { columns: ['id', 'match_id', 'team_id', 'provider', 'capture_id'], in: { match_id: part }, order: 'id.asc' }));
    enrichment.push(...await store.select('soccer_match_enrichment', { columns: ['match_id', 'component', 'provider', 'status'], in: { match_id: part }, order: 'match_id.asc' }));
  }
  const players = [];
  for (const part of chunkArr(lineups.map(l => l.id), 20)) players.push(...await store.select('soccer_lineup_players', { columns: ['lineup_id', 'is_starter'], in: { lineup_id: part }, order: 'lineup_id.asc,player_id.asc' }));
  const captures = new Map();
  for (const part of chunkArr([...new Set(lineups.map(l => l.capture_id).filter(Boolean))], 100)) for (const c of await store.select('soccer_source_captures', { columns: ['capture_id', 'captured_at'], in: { capture_id: part } })) captures.set(c.capture_id, c.captured_at);
  const out = new Map();
  for (const m of matches) {
    const ls = lineups.filter(l => l.match_id === m.id);
    const lids = new Set(ls.map(l => l.id));
    out.set(m.id, decideReadiness({ match: m, slug: slugByCompetition.get(m.competition_id), lineups: ls, players: players.filter(p => lids.has(p.lineup_id)), captures, enrichment: enrichment.filter(e => e.match_id === m.id), now, registry }));
  }
  return out;
}

export async function competitionSlugs(store, ids) {
  const rows = ids.length ? await store.select('soccer_competitions', { columns: ['id', 'slug', 'name'], in: { id: [...new Set(ids)] } }) : [];
  return new Map(rows.map(c => [c.id, c]));
}

/** GET /v1/matches/:id/lineup-readiness */
export async function lineupReadiness(store, id, { now = Date.now(), registry = registryData } = {}) {
  const [m] = await store.select('soccer_public_matches', { columns: ['id', 'competition_id', 'kickoff_at', 'home_team_id', 'away_team_id', 'status'], eq: { id }, limit: 1 });
  if (!m) throw Object.assign(new Error('match not found'), { status: 404 });
  const comps = await competitionSlugs(store, [m.competition_id]);
  const r = (await readinessFor(store, [m], { now, registry, slugByCompetition: new Map([...comps].map(([k, c]) => [k, c.slug])) })).get(m.id);
  return E({ match_id: m.id, status: m.status, competition: comps.get(m.competition_id)?.slug || null, ...r }, {
    semantics: 'Lineup readiness: whether both starting XIs (11 + 11) were captured before kickoff from a rights-cleared source. Counts and provenance only, no player names. Independent context; never an input to Soccer Algo forecasts or Official Picks.',
  });
}
