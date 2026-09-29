#!/usr/bin/env node
// READ-ONLY Shot Lab coverage audit over canonical soccer_match_events (event_type = 'shot').
// Per competition (every season, current season flagged) and per source family:
//   finished matches, matches with an event ledger (>= 1 event), matches with >= 1 shot, shots, located shots,
//   and the presence of each shot field (player_id, outcome, body_part, set_piece, under_pressure, provider xG,
//   end coordinates). Missing data is reported as missing (null / not present), never as zero.
// Also: qualifier keys seen on shots (to find provider xG / assist / situation fields without guessing) and the
// PBE xG research inputs (location, body part, set piece, assist linkage, goal outcome).
//   node scripts/shot-lab/coverage.mjs   -> docs/evidence/shot-lab/coverage-<date>.json
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { chunkArr } from '../../workers/soccer-ingest/src/store.js';

const env = Object.fromEntries(readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const store = storeFromEnv(env);
const COMPS = ['mls', 'premier-league', 'uefa-champions-league', 'bundesliga', 'uefa-nations-league'];
const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
const t0 = Date.now(); const log = (...a) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s]`, ...a);

const out = { at: new Date().toISOString(), table: 'soccer_match_events', scope: 'event_type = shot (goals reported without shot detail are event_type goal and are counted separately)', competitions: [], by_source_family: {}, qualifier_keys_on_shots: {}, research: null };
const fam = {};
const allShots = [];
for (const slug of COMPS) {
  const [c] = await store.select('soccer_competitions', { columns: ['id', 'slug', 'name'], eq: { slug } });
  if (!c) { out.competitions.push({ competition: slug, missing: true }); continue; }
  const seasons = (await store.select('soccer_seasons', { columns: ['id', 'label'], eq: { competition_id: c.id } })).sort((a, b) => (a.label < b.label ? 1 : -1));
  for (const [si, s] of seasons.entries()) {
    const ms = await store.select('soccer_matches', { columns: ['id', 'status'], eq: { season_id: s.id } });
    const fin = ms.filter(m => m.status === 'finished').map(m => m.id);
    if (!fin.length) continue;
    const shots = [];
    for (const part of chunkArr(fin, 60)) shots.push(...await store.select('soccer_match_events', { columns: ['match_id', 'player_id', 'outcome', 'body_part', 'set_piece', 'under_pressure', 'is_goal', 'x_m', 'end_x_m', 'source_family', 'qualifiers'], eq: { event_type: 'shot' }, in: { match_id: part } }));
    const reported = []; // goals reported without shot detail
    for (const part of chunkArr(fin, 100)) reported.push(...await store.select('soccer_match_events', { columns: ['match_id'], eq: { event_type: 'goal' }, in: { match_id: part } }));
    // event ledger presence: one HEAD count per match (current season only; historical seasons use the shot count)
    let ledger = null;
    if (si === 0) { ledger = 0; for (const id of fin) if ((await store.count('soccer_match_events', { eq: { match_id: id } })) > 0) ledger++; }
    const n = shots.length;
    const has = f => shots.filter(f).length;
    const row = {
      competition: slug, season: s.label, current: si === 0, finished_matches: fin.length,
      matches_with_event_ledger: ledger, matches_with_shot: new Set(shots.map(x => x.match_id)).size,
      goals_reported_without_shot_detail: reported.length,
      shots: n, located: has(x => x.x_m !== null), located_pct: pct(has(x => x.x_m !== null), n),
      with_player_id: has(x => x.player_id), with_outcome: has(x => x.outcome), with_body_part: has(x => x.body_part),
      with_set_piece: has(x => x.set_piece), with_under_pressure: has(x => x.under_pressure !== null && x.under_pressure !== undefined),
      with_provider_xg: has(x => x.qualifiers?.provider_xg !== undefined && x.qualifiers?.provider_xg !== null),
      with_end_coordinates: has(x => x.end_x_m !== null), goals: has(x => x.is_goal),
      source_families: Object.fromEntries([...new Set(shots.map(x => x.source_family))].map(f => [f, shots.filter(x => x.source_family === f).length])),
    };
    out.competitions.push(row);
    log(slug, s.label, JSON.stringify({ shots: n, located: row.located, xg: row.with_provider_xg }));
    for (const x of shots) {
      const F = (fam[x.source_family] ||= { shots: 0, located: 0, player_id: 0, outcome: 0, body_part: 0, set_piece: 0, under_pressure: 0, provider_xg: 0, end_coordinates: 0, goals: 0, competitions: new Set() });
      F.shots++; if (x.x_m !== null) F.located++; if (x.player_id) F.player_id++; if (x.outcome) F.outcome++; if (x.body_part) F.body_part++; if (x.set_piece) F.set_piece++;
      if (x.under_pressure !== null && x.under_pressure !== undefined) F.under_pressure++; if (x.qualifiers?.provider_xg != null) F.provider_xg++; if (x.end_x_m !== null) F.end_coordinates++; if (x.is_goal) F.goals++;
      F.competitions.add(`${slug} ${s.label}`);
      for (const k of Object.keys(x.qualifiers || {})) { const q = (out.qualifier_keys_on_shots[`${x.source_family}.${k}`] ||= 0); out.qualifier_keys_on_shots[`${x.source_family}.${k}`] = q + 1; }
      allShots.push({ ...x, comp: slug, season: s.label });
    }
  }
}
for (const [k, F] of Object.entries(fam)) out.by_source_family[k] = { ...F, competitions: [...F.competitions], located_pct: pct(F.located, F.shots), body_part_pct: pct(F.body_part, F.shots), set_piece_pct: pct(F.set_piece, F.shots), provider_xg_pct: pct(F.provider_xg, F.shots) };

// PBE xG research inputs (metric registry: pbe_xg status design, target 50,000 training shots). A shot is
// eligible only with a location and a known outcome; the other inputs are reported as missingness.
const eligible = allShots.filter(x => x.x_m !== null && (x.outcome || x.is_goal));
const miss = f => ({ present: eligible.filter(f).length, missing: eligible.length - eligible.filter(f).length, missing_pct: pct(eligible.length - eligible.filter(f).length, eligible.length) });
out.research = {
  design_target_training_shots: 50000,
  eligible_training_shots: eligible.length, goals: eligible.filter(x => x.is_goal).length,
  competitions_seasons: [...new Set(eligible.map(x => `${x.comp} ${x.season}`))],
  by_source_family: Object.fromEntries([...new Set(eligible.map(x => x.source_family))].map(f => [f, eligible.filter(x => x.source_family === f).length])),
  missingness: { location: { present: eligible.length, missing: 0, note: 'location is an eligibility condition' }, body_part: miss(x => x.body_part), set_piece_or_open_play: { note: 'set_piece is null for open play AND for unknown; the source family decides whether null means open play', ...miss(x => x.set_piece) }, under_pressure: miss(x => x.under_pressure !== null && x.under_pressure !== undefined), assist_linkage: { note: 'not a shot column: ESPN links assists as separate espn_assist events; Wyscout carries key-pass tags in qualifiers. Measured separately if the research proceeds.' }, goal_outcome: miss(x => x.outcome || x.is_goal) },
  verdict: eligible.length >= 50000 ? 'READY FOR RESEARCH' : 'NOT READY',
};
mkdirSync('docs/evidence/shot-lab', { recursive: true });
const file = `docs/evidence/shot-lab/coverage-${out.at.slice(0, 10)}.json`;
writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
log('wrote', file, 'eligible research shots', eligible.length, out.research.verdict);
