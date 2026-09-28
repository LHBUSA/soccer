#!/usr/bin/env node
// Media coverage BY PRODUCT SURFACE, measured from the production API (what customers get), not
// from database rows. Read-only. Separates MEDIA COVERAGE (approved portrait / crest present) from
// fallback quality (not measured here: the fallback always renders).
//   node scripts/media/coverage-surfaces.mjs [--api https://soccer-api.sales-fd3.workers.dev/v1] [--out docs/evidence/media/coverage-surfaces-<date>.json]
import { writeFileSync } from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const API = arg('--api', 'https://soccer-api.sales-fd3.workers.dev/v1').replace(/\/$/, '');
const get = async p => { const r = await fetch(`${API}/${p}`, { headers: { 'user-agent': 'propbetedge-soccer-coverage (read-only)' } }); if (!r.ok) throw new Error(`${p} ${r.status}`); return (await r.json()).data; };
const frac = (have, total) => ({ with_media: have, total, pct: total ? Math.round((1000 * have) / total) / 10 : null });
const COMPS = ['mls', 'premier-league', 'bundesliga', 'uefa-champions-league'];

// ---- current PBEcast matches: live + the last four days (the hub), lineups from the cast
const live = await get('live');
const current = [...live.live, ...live.recent];
const starters = new Map(); const bench = new Map();
for (const m of current) {
  const d = await get(`matches/${m.id}`);
  for (const side of ['home', 'away']) {
    for (const p of d.lineups?.[side]?.starters || []) if (p?.slug) starters.set(p.slug, !!p.portrait);
    for (const p of d.lineups?.[side]?.bench || []) if (p?.slug) bench.set(p.slug, !!p.portrait);
  }
}
// ---- home key players (featured match: live first, else biggest recent event-mapped result, top 3)
const mapped = live.live.length ? live.live : live.recent.filter(m => m.intel?.event_map && m.score).sort((a, b) => (b.score.home + b.score.away) - (a.score.home + a.score.away) || Date.parse(b.kickoff_at) - Date.parse(a.kickoff_at));
let home = [];
if (mapped[0]) {
  const d = await get(`matches/${mapped[0].id}`);
  const w = r => (r.goals || 0) * 5 + (r.assists || 0) * 3 + (r.shots_on_target || 0) + (r.key_passes || 0) * 0.5 + (r.saves || 0) * 0.4;
  home = (d.players?.rows || []).filter(r => r.player?.slug && w(r) > 0).sort((a, b) => w(b) - w(a)).slice(0, 3).map(r => !!r.player.portrait);
}
// ---- news subjects: people named in current stories (the story's own entities)
const news = await get('news?limit=40');
const subjects = new Map();
for (const a of news) {
  const full = await get(`news/${a.slug}`);
  for (const e of full.entities || []) if (e.type === 'Person' && e.href?.startsWith('/players/')) subjects.set(e.href.split('/').pop(), null);
}
for (const slug of subjects.keys()) { try { const p = await get(`players/${slug}`); subjects.set(slug, !!(p.media || []).some(m => m.media_type === 'portrait')); } catch { subjects.set(slug, false); } }
// ---- Player DNA top 100 active (directory default: most minutes), and per competition
const top = await get('players?limit=100');
const perComp = {};
for (const c of COMPS) {
  let off = 0; let total = 0; let have = 0; let n = 0;
  do { const x = await get(`players?competition=${c}&limit=100&offset=${off}`); total = x.total; for (const p of x.players) { n += 1; if (p.portrait) have += 1; } off += 100; } while (off < total);
  perComp[c] = frac(have, n);
}
// ---- crests by competition (active teams of the latest season, crest on the table / team object)
const crests = {};
for (const c of COMPS) {
  const comp = await get(`competitions/${c}`);
  const teams = comp.current?.teams || [];
  let have = 0;
  for (const t of teams) { const td = await get(`teams/${t.slug}`); if (td.crest) have += 1; }
  crests[c] = frac(have, teams.length);
}
const allTeams = new Set(); let allHave = 0;
for (const c of COMPS) { const comp = await get(`competitions/${c}`); for (const t of comp.current?.teams || []) allTeams.add(t.slug); }
for (const s of allTeams) { const td = await get(`teams/${s}`); if (td.crest) allHave += 1; }

const count = m => frac([...m.values()].filter(Boolean).length, m.size);
const out = {
  at: new Date().toISOString(), api: API, method: 'production API responses (approved media present in the payload the page renders)',
  portraits: {
    home_key_players: frac(home.filter(Boolean).length, home.length),
    current_pbecast_starters: count(starters), current_pbecast_bench: count(bench), current_pbecast_matches: current.length,
    current_news_subjects: count(subjects),
    player_dna_top100_active: frac(top.players.filter(p => p.portrait).length, top.players.length),
    by_competition_active: perComp,
  },
  crests: { by_competition_active: crests, overall_distinct_active_teams: frac(allHave, allTeams.size) },
};
const file = arg('--out', `docs/evidence/media/coverage-surfaces-${out.at.slice(0, 10)}.json`);
writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
console.log('wrote', file);
