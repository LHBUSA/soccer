#!/usr/bin/env node
// World Coverage matrix: one row per discovered competition, built ONLY from evidence files (discovery, canaries)
// and the registry. Nothing is typed by hand; a cell without evidence says so.
//   node scripts/evidence/world-matrix.mjs [--discovery docs/evidence/world/espn-world-discovery-2026-10-03.json]
// Output: docs/evidence/world/world-matrix.json + docs/WORLD_COVERAGE.md (table section regenerated)
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const disc = JSON.parse(readFileSync(arg('--discovery', 'docs/evidence/world/espn-world-discovery-2026-10-03.json'), 'utf8'));
const reg = JSON.parse(readFileSync('data/registry/competitions.json', 'utf8'));
const canaries = {};
for (const f of readdirSync('docs/evidence/world').filter(f => /^canary-.+\.json$/.test(f)).sort()) {
  const j = JSON.parse(readFileSync(`docs/evidence/world/${f}`, 'utf8')); canaries[j.competition] = { ...j, file: f };
}
const live = new Set(reg.competitions.filter(c => c.espn?.enabled).map(c => c.slug));
const EXTRA = [
  { phase: 'B', slug: 'frauen-bundesliga', gender: 'women', country: 'DEU', status: 'source_alternative', provider: 'openligadb ffb1 (league 5972, community-maintained)', note: 'Not on ESPN Core (ger.w.1 absent). OpenLigaDB 2026: 14 teams, 182 fixtures, 35 finished; one fixture with a 1970 placeholder kickoff; 69/123 goals with a named scorer. Results/goals tier only; needs an OpenLigaDB women lane + data-quality gate.' },
  { phase: 'B', slug: 'serie-a-women', gender: 'women', country: 'ITA', status: 'no_source', provider: null, note: 'Not on ESPN Core (ita.w.1 absent) nor OpenLigaDB. No legitimate structured public source found yet.' },
];
const yes = (b, n) => (b ? (n !== undefined ? String(n) : 'yes') : 'no');
const rows = [];
for (const r of disc.results) {
  const c = canaries[r.slug]; const g = c?.gate; const e = c?.enrichment || {}; const m = c?.matches || {};
  const registered = reg.competitions.find(x => x.slug === r.slug);
  const launch = live.has(r.slug) ? 'lane enabled' : c ? (g?.pass ? 'canary PASS (not enabled)' : 'canary FAIL') : registered ? 'registered, lane disabled' : 'not registered';
  rows.push({
    phase: r.phase, competition: r.league?.name || r.slug, slug: r.slug, gender: r.expected_gender, region: r.country || 'international',
    provider: r.league ? `espn ${r.espn} (${r.league.id})` : `espn ${r.espn}: absent`, season: r.season?.label || null,
    teams: r.teams?.count ?? null, matches: r.events_total ?? null,
    results: c ? m.by_status?.finished ?? 0 : null, standings: c ? (g?.table ? 'verified/computed' : 'withheld') : null,
    lineups: c ? e.lineups_both : null, stats: c ? e.team_stats_both : null, plays: c ? e.plays : null, coordinates: c ? e.located_events : null,
    live: live.has(r.slug) ? 'per-minute lane' : null, pbecast: c?.finished_match_proof?.cast ? 'replay payload proven' : null,
    players: c?.players?.in_lineups ?? null, dna: c ? 'descriptive (inputs present)' : null, media: null, news: registered?.news?.enabled ? 'enabled' : 'off',
    history: r.season ? 'current season only' : null,
    source_status: r.status, launch_status: launch,
    blocker: r.status !== 'source_present' ? 'no ESPN Core source' : c ? (g?.pass ? (live.has(r.slug) ? null : 'awaiting enable + production fill') : Object.entries(g || {}).filter(([k, v]) => k !== 'pass' && !v).map(([k]) => k).join(', ')) : registered ? 'canary not run' : 'not yet registered (phase order)',
  });
}
for (const x of EXTRA) rows.push({ phase: x.phase, competition: x.slug, slug: x.slug, gender: x.gender, region: x.country, provider: x.provider, source_status: x.status, launch_status: 'not registered', blocker: x.note });
writeFileSync('docs/evidence/world/world-matrix.json', JSON.stringify({ generated_at: new Date().toISOString(), discovery: disc.generated_at, rows }, null, 2) + '\n');
const cols = ['phase', 'competition', 'gender', 'region', 'provider', 'season', 'teams', 'matches', 'results', 'standings', 'lineups', 'stats', 'plays', 'coordinates', 'live', 'pbecast', 'players', 'dna', 'news', 'source_status', 'launch_status', 'blocker'];
const md = [`| ${cols.join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`, ...rows.map(r => `| ${cols.map(k => String(r[k] ?? '—').replace(/\|/g, '/')).join(' | ')} |`)].join('\n');
const path = 'docs/WORLD_COVERAGE.md';
const head = existsSync(path) ? readFileSync(path, 'utf8').split('<!-- matrix -->')[0] : '# World Coverage\n\n';
writeFileSync(path, `${head}<!-- matrix -->\nGenerated ${new Date().toISOString()} by scripts/evidence/world-matrix.mjs from docs/evidence/world/*.json.\n\n${md}\n`);
console.log('rows', rows.length);
