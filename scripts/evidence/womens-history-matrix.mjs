#!/usr/bin/env node
// Women's history matrix (evidence only): ESPN discovery (catalog) x per-season acceptance files x production
// publication state. Nothing is typed by hand.
//   node scripts/evidence/womens-history-matrix.mjs
// Output: docs/evidence/history/womens-history-matrix-<date>.json + a section in docs/HISTORY_COVERAGE.md
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

const env = Object.fromEntries(readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const U = env.SOCCER_MODEL_SUPABASE_URL; const h = { apikey: env.SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY}` };
const get = async q => { const r = await fetch(`${U}/rest/v1/${q}`, { headers: h }); if (!r.ok) throw new Error(`${r.status} ${q}`); return r.json(); };
const disc = JSON.parse(readFileSync('docs/evidence/history/womens-history-discovery-2026-10-03.json', 'utf8')).competitions;
const COMPS = ['nwsl', 'womens-super-league', 'uefa-womens-champions-league', 'liga-f', 'premiere-ligue', 'fifa-womens-world-cup'];
const label = (slug, y) => {
  const reg = JSON.parse(readFileSync('data/registry/competitions.json', 'utf8')).competitions.find(c => c.slug === slug);
  const cal = !reg || reg.season_format === 'calendar' || (reg.calendar_season_years || []).includes(Number(y));
  return cal ? String(y) : `${y}/${String((Number(y) + 1) % 100).padStart(2, '0')}`;
};
const rows = []; const perSeason = [];
for (const slug of COMPS) {
  const d = disc[slug]; const years = d?.catalog?.years || [];
  const [c] = await get(`soccer_competitions?select=id&slug=eq.${slug}`);
  const seasons = c ? await get(`soccer_seasons?select=id,label,publication_state,coverage_tier&competition_id=eq.${c.id}`) : [];
  let matches = 0; const tiers = {};
  for (const y of years) {
    const l = label(slug, y); const s = seasons.find(x => x.label === l);
    const af = `docs/evidence/history/accept-${slug}-${l.replace('/', '-')}.json`;
    const acc = existsSync(af) ? JSON.parse(readFileSync(af, 'utf8')) : null;
    const n = s ? (await fetch(`${U}/rest/v1/soccer_public_matches?select=id&season_id=eq.${s.id}&limit=1`, { method: 'HEAD', headers: { ...h, prefer: 'count=exact' } }).then(r => Number((r.headers.get('content-range') || '').split('/')[1]) || 0)) : 0;
    if (s?.publication_state === 'published') { matches += n; tiers[s.coverage_tier || acc?.coverage_tier || '?'] = (tiers[s.coverage_tier || acc?.coverage_tier || '?'] || 0) + 1; }
    perSeason.push({ competition: slug, provider_year: y, label: l, state: s?.publication_state || 'DISCOVERED', public_matches: n, accept_file: acc ? af : null, pass: acc?.pass ?? null, failed: acc?.checks_failed?.map(f => f.check) || [], tier: s?.coverage_tier || acc?.coverage_tier || null });
  }
  const pub = perSeason.filter(p => p.competition === slug && p.state === 'published');
  const held = perSeason.filter(p => p.competition === slug && p.state !== 'published');
  rows.push({ competition: slug, earliest: years[0] ?? null, latest: years.at(-1) ?? null, discovered: years.length, published: pub.length, matches,
    tiers: Object.entries(tiers).map(([k, v]) => `${k}:${v}`).join(' '), held: held.map(p => `${p.label} (${p.state === 'DISCOVERED' ? 'not ingested' : p.failed.join('+') || p.state})`).join('; ') });
}
const day = new Date().toISOString().slice(0, 10);
writeFileSync(`docs/evidence/history/womens-history-matrix-${day}.json`, JSON.stringify({ generated_at: new Date().toISOString(), rows, seasons: perSeason }, null, 2) + '\n');
console.log(JSON.stringify(rows, null, 1));
