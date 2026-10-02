#!/usr/bin/env node
// REPAIR: ESPN matches whose plays were published on the 0-1 coordinate scale (frame unverified) were
// mapped as if 0-100, putting every located event ~0.3 m from a corner flag. This clears ONLY the derived
// canonical columns (x_m, y_m, end_x_m, end_y_m) of those matches and relabels their system
// 'espn_unit_unverified'. Source values (source_x/y/end) are never touched, so a later verified mapping
// can rebuild the canonical points. Detection matches the parser (espn-core/1.1.0): every located ESPN
// play of the match has |x| <= 1 and |y| <= 1, at least 5 located plays.
//   node scripts/db/repair-espn-unit-coords.mjs            # DRY RUN: counts only (default)
//   node scripts/db/repair-espn-unit-coords.mjs --apply    # writes (owner-approved data repair only)
// Env: D:\Workers\secrets\soccer-supabase.env (values never printed). Output: docs/evidence/storage/espn-unit-coords-<date>.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const APPLY = process.argv.includes('--apply');
const env = Object.fromEntries(readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const U = env.SOCCER_MODEL_SUPABASE_URL; const K = env.SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY;
if (!/tkmlnhmylqnttmnsnief/.test(U)) throw new Error('target guard: not the sports project');
const h = { apikey: K, authorization: `Bearer ${K}` };
const get = async q => { const r = await fetch(`${U}/rest/v1/${q}`, { headers: h }); if (!r.ok) throw new Error(`GET ${r.status}`); return r.json(); };
const count = async q => Number(((await fetch(`${U}/rest/v1/${q}`, { method: 'HEAD', headers: { ...h, prefer: 'count=exact' } })).headers.get('content-range') || '').split('/')[1]);

const stats = new Map(); let off = 0;
for (;;) {
  const rows = await get(`soccer_match_events?select=match_id,source_x,source_y&source_family=eq.espn&source_x=not.is.null&order=id.asc&limit=1000&offset=${off}`);
  for (const r of rows) { if (Number(r.source_x) === 0 && Number(r.source_y) === 0) continue; const s = stats.get(r.match_id) || { n: 0, unit: true }; s.n += 1; if (Math.abs(r.source_x) > 1 || Math.abs(r.source_y) > 1) s.unit = false; stats.set(r.match_id, s); }
  if (rows.length < 1000) break; off += 1000;
}
const ids = [...stats].filter(([, s]) => s.unit && s.n >= 5).map(([k]) => k).sort();
const comps = new Map((await get('soccer_competitions?select=id,slug')).map(c => [c.id, c.slug]));
const seasons = new Map((await get('soccer_seasons?select=id,label')).map(s => [s.id, s.label]));
const matches = []; for (let i = 0; i < ids.length; i += 100) matches.push(...await get(`soccer_matches?select=id,kickoff_at,competition_id,season_id&id=in.(${ids.slice(i, i + 100).join(',')})`));
const bySeason = {}; for (const m of matches) { const k = `${comps.get(m.competition_id)} ${seasons.get(m.season_id)}`; bySeason[k] = (bySeason[k] || 0) + 1; }
let rowsWithPoint = 0; for (let i = 0; i < ids.length; i += 40) rowsWithPoint += await count(`soccer_match_events?select=id&source_family=eq.espn&x_m=not.is.null&match_id=in.(${ids.slice(i, i + 40).join(',')})`);
// published articles about these matches (frozen visuals may carry shot locations: reported, not rewritten here)
const arts = []; for (let i = 0; i < ids.length; i += 100) arts.push(...await get(`soccer_news_events?select=id,match_id,story_class,status&match_id=in.(${ids.slice(i, i + 100).join(',')})`));
const out = { at: new Date().toISOString(), mode: APPLY ? 'apply' : 'dry_run', matches: ids.length, by_season: bySeason, kickoff_range: [matches.map(m => m.kickoff_at).sort()[0], matches.map(m => m.kickoff_at).sort().at(-1)], event_rows_with_canonical_point: rowsWithPoint, news_events_on_these_matches: arts.length, news_by_status: arts.reduce((o, a) => ({ ...o, [a.status]: (o[a.status] || 0) + 1 }), {}) };
if (APPLY) {
  let patched = 0;
  for (const id of ids) {
    const r = await fetch(`${U}/rest/v1/soccer_match_events?match_id=eq.${id}&source_family=eq.espn&source_coordinate_system=eq.espn_pct_v1`, { method: 'PATCH', headers: { ...h, 'content-type': 'application/json', prefer: 'return=minimal,count=exact' }, body: JSON.stringify({ x_m: null, y_m: null, end_x_m: null, end_y_m: null, source_coordinate_system: 'espn_unit_unverified' }) });
    if (!r.ok) throw new Error(`PATCH ${id} ${r.status} ${await r.text()}`);
    patched += Number((r.headers.get('content-range') || '').split('/')[1]) || 0;
  }
  out.rows_patched = patched;
  let left = 0; for (let i = 0; i < ids.length; i += 40) left += await count(`soccer_match_events?select=id&source_family=eq.espn&x_m=not.is.null&match_id=in.(${ids.slice(i, i + 40).join(',')})`);
  out.rows_with_canonical_point_after = left;
}
mkdirSync('docs/evidence/storage', { recursive: true });
writeFileSync(`docs/evidence/storage/espn-unit-coords-${out.at.slice(0, 10)}-${out.mode}.json`, JSON.stringify({ ...out, match_ids: ids }, null, 1) + '\n');
console.log(JSON.stringify(out, null, 1));
