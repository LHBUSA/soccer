#!/usr/bin/env node
// World Coverage PRODUCTION acceptance for one competition (read-only). Compares production with the accepted local
// canary report and checks identity + gender integrity, then canaries the public API.
//   node scripts/qa/world-prod-accept.mjs --slug la-liga [--canary docs/evidence/world/canary-la-liga-2026-10-03.json]
// Output: docs/evidence/world/prod-accept-<slug>-<date>.json
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { chunkArr } from '../../workers/soccer-ingest/src/store.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SLUG = arg('--slug');
const canaryFile = arg('--canary', readdirSync('docs/evidence/world').filter(f => f.startsWith(`canary-${SLUG}-`)).sort().map(f => `docs/evidence/world/${f}`).at(-1));
const canary = JSON.parse(readFileSync(canaryFile, 'utf8'));
const BASE = arg('--base', 'https://soccer.propbetedge.ai');
const text = readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8').replace(/^\uFEFF/, '');
const prod = storeFromEnv(Object.fromEntries(text.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])));
const reg = JSON.parse(readFileSync('data/registry/competitions.json', 'utf8')).competitions.find(c => c.slug === SLUG);
const GENDER = reg.gender || 'men';
const selIn = async (t, col, vals, o = {}) => { let r = []; for (const p of chunkArr([...new Set(vals)], 150)) r = r.concat(await prod.select(t, { ...o, in: { ...(o.in || {}), [col]: p } })); return r; };

const [comp] = await prod.select('soccer_competitions', { columns: ['id', 'slug', 'gender'], eq: { slug: SLUG } });
if (!comp) throw new Error(`${SLUG}: no production competition row (backfill not run?)`);
const seasons = await prod.select('soccer_seasons', { columns: ['id', 'label', 'publication_state'], eq: { competition_id: comp.id } });
const season = seasons.find(s => s.label === canary.season.label);
const matches = await prod.select('soccer_matches', { columns: ['id', 'status', 'kickoff_at', 'home_team_id', 'away_team_id', 'home_score', 'away_score', 'winner_team_id', 'stage_id'], eq: { season_id: season.id }, limit: 3000 });
const finished = matches.filter(m => m.status === 'finished');
const enrich = await selIn('soccer_match_enrichment', 'match_id', finished.map(m => m.id), { columns: ['match_id', 'component', 'status'] });
const ok = (m, k) => enrich.some(e => e.match_id === m.id && e.component === k && e.status === 'complete');
const gaps = enrich.filter(e => !['complete', 'not_applicable'].includes(e.status));
const teamIds = [...new Set(matches.flatMap(m => [m.home_team_id, m.away_team_id]))];
const teams = await selIn('soccer_teams', 'id', teamIds, { columns: ['id', 'name', 'gender', 'team_type', 'status'] });
const xw = await selIn('soccer_team_external_ids', 'team_id', teamIds, { columns: ['team_id', 'external_id', 'method'], eq: { provider: 'espn' } });
// duplicate identities: another active team of the same gender with the same name, or an ESPN id on two teams
const all = await prod.select('soccer_teams', { columns: ['id', 'name', 'gender', 'status'], eq: { status: 'active' }, limit: 5000 });
const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const dupNames = teams.filter(t => all.some(o => o.id !== t.id && o.gender === t.gender && norm(o.name) === norm(t.name))).map(t => t.name);
const allXw = await prod.select('soccer_team_external_ids', { columns: ['external_id', 'team_id'], eq: { provider: 'espn' }, limit: 5000 });
const xwCount = allXw.reduce((o, x) => ({ ...o, [x.external_id]: (o[x.external_id] || 0) + 1 }), {});
// GLOBAL gender integrity: no match anywhere joins a team whose gender differs from its competition's
const comps = await prod.select('soccer_competitions', { columns: ['id', 'slug', 'gender'] });
const genderOf = new Map(all.map(t => [t.id, t.gender]));
let crossGender = [];
for (const c of comps) {
  const ss = await prod.select('soccer_seasons', { columns: ['id'], eq: { competition_id: c.id } });
  for (const s of ss) {
    const ms = await prod.select('soccer_matches', { columns: ['id', 'home_team_id', 'away_team_id'], eq: { season_id: s.id }, limit: 3000 });
    crossGender = crossGender.concat(ms.filter(m => [m.home_team_id, m.away_team_id].some(t => genderOf.has(t) && genderOf.get(t) !== (c.gender || 'men'))).map(m => ({ competition: c.slug, match: m.id })));
  }
}
const canaryTeams = canary.identity_gate;
const prodReused = teams.filter(t => xw.find(x => x.team_id === t.id)?.method !== 'founding' || canaryTeams.reused_existing_canonical.includes(t.name));

// public API canary (through the same-origin proxy the browser uses)
const get = async p => { const r = await fetch(`${BASE}/api/soccer/${p}`); return { status: r.status, json: r.ok ? await r.json() : null }; };
const api = {};
api.competition = await get(`competitions/${SLUG}`);
api.table = await get(`table?competition=${SLUG}&season=${encodeURIComponent(season.label)}`);
const deep = finished.sort((a, b) => new Date(b.kickoff_at) - new Date(a.kickoff_at))[0];
if (deep) { api.match = await get(`matches/${deep.id}`); api.cast = await get(`matches/${deep.id}/cast`); }
const t = api.table.json?.data;
const tableOk = api.table.status === 200 && (t?.groups?.length ? t.groups.every(g => g.verified !== false) : (t?.rows?.length || 0) === canary.identity_gate.expected_teams) && (t?.verification ? t.verification.verified !== false : true);

const r = {
  generated_at: new Date().toISOString(), competition: SLUG, gender: GENDER, canary: canaryFile, season: season.label, publication_state: season.publication_state,
  fixtures: { production: matches.length, canary: canary.matches.total, verified: matches.length === canary.matches.total },
  completed_detail: { finished: finished.length, canary_finished: canary.matches.by_status.finished, scored: finished.filter(m => m.home_score !== null && m.away_score !== null).length,
    lineups_both: finished.filter(m => ok(m, 'lineup_home') && ok(m, 'lineup_away')).length, stats_both: finished.filter(m => ok(m, 'stats_home') && ok(m, 'stats_away')).length, plays: finished.filter(m => ok(m, 'plays')).length, gaps: gaps.length,
    unknown_status: matches.filter(m => m.status === 'unknown').length },
  identity: { teams: teams.length, expected: reg.expected_teams, reused_from_production: prodReused.map(t => t.name), duplicate_same_gender_names: dupNames,
    espn_ids_on_more_than_one_team: xw.filter(x => xwCount[x.external_id] > 1).map(x => x.external_id), wrong_gender: teams.filter(t => t.gender !== GENDER).map(t => t.name), wrong_kind: teams.filter(t => t.team_type !== 'club').map(t => t.name) },
  gender_integrity_global: { matches_with_cross_gender_team: crossGender.length, sample: crossGender.slice(0, 5) },
  api: { competition: api.competition.status, table: api.table.status, table_view: t?.view, table_rows: t?.rows?.length ?? null, match: api.match?.status, cast: api.cast?.status, cast_mode: api.cast?.json?.data?.live?.mode ?? null, match_fixture: deep ? `${api.match?.json?.data?.home?.name} ${api.match?.json?.data?.score?.home}-${api.match?.json?.data?.score?.away} ${api.match?.json?.data?.away?.name}` : null },
};
const d = r.completed_detail;
r.checks = {
  backfill_complete: d.finished >= d.canary_finished && d.unknown_status === 0,
  fixtures_verified: r.fixtures.verified,
  completed_detail_verified: d.scored === d.finished && d.lineups_both === d.finished && d.stats_both === d.finished && d.plays === d.finished && d.gaps === 0,
  standings_verified: tableOk,
  identity_dedupe: r.identity.teams === r.identity.expected && !r.identity.duplicate_same_gender_names.length && !r.identity.espn_ids_on_more_than_one_team.length && !r.identity.wrong_kind.length,
  gender_integrity: !r.identity.wrong_gender.length && r.gender_integrity_global.matches_with_cross_gender_team === 0,
  api_canary: [r.api.competition, r.api.table, r.api.match, r.api.cast].every(s => s === 200),
};
r.pass = Object.values(r.checks).every(Boolean);
const out = `docs/evidence/world/prod-accept-${SLUG}-${r.generated_at.slice(0, 10)}.json`;
writeFileSync(out, JSON.stringify(r, null, 2) + '\n');
console.log(JSON.stringify({ out, checks: r.checks, pass: r.pass, fixtures: r.fixtures, detail: r.completed_detail, identity: { teams: r.identity.teams, reused: r.identity.reused_from_production.length, dup: r.identity.duplicate_same_gender_names }, api: r.api }));
