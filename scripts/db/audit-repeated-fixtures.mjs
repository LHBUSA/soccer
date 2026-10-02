#!/usr/bin/env node
// PRE-MIGRATION AUDIT (1500, repeated fixtures). Read-only. Under the current unique key no two canonical matches share
// (season, home, away, stage), so the questions are about what that key may have HIDDEN:
//   1. canonical matches carrying more than one ESPN event id (two provider events merged into one match)
//   2. cross-provider crosswalks whose provider kickoff differs from the canonical kickoff by more than the tolerance
//      (an attachment by pairing alone that could be the wrong leg/date)
//   3. groups that would be affected by the new key: (season, home, away, stage) groups — all size 1 today — and the
//      kickoff spread, for the record
// Output: docs/evidence/storage/repeated-fixtures-audit-<date>.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const U = env.SOCCER_MODEL_SUPABASE_URL; if (!/tkmlnhmylqnttmnsnief/.test(U)) throw new Error('target guard');
const h = { apikey: env.SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY}` };
const get = async q => { const r = await fetch(`${U}/rest/v1/${q}`, { headers: h }); if (!r.ok) throw new Error(`${r.status} ${q}`); return r.json(); };
const pages = async q => { const out = []; for (let o = 0; ; o += 1000) { const r = await get(`${q}&limit=1000&offset=${o}`); out.push(...r); if (r.length < 1000) return out; } };
const TOL_MS = 3 * 864e5;
const matches = await pages('soccer_matches?select=id,season_id,stage_id,home_team_id,away_team_id,kickoff_at,status,result_provider&order=id.asc');
const xw = await pages('soccer_match_external_ids?select=provider,external_id,match_id,method,capture_id&order=provider.asc,external_id.asc');
const byMatch = new Map(); for (const x of xw) byMatch.set(x.match_id, [...(byMatch.get(x.match_id) || []), x]);
const m2 = new Map(matches.map(m => [m.id, m]));
// 1
const multiEspn = [...byMatch].filter(([, xs]) => xs.filter(x => x.provider === 'espn').length > 1).map(([id, xs]) => ({ match_id: id, espn_events: xs.filter(x => x.provider === 'espn').map(x => x.external_id) }));
// 2 (provider kickoff from the ESPN cursor is not in the DB; compare via soccer_match_source_results observed kickoff is not stored either,
// so use the ESPN event capture date only where a crosswalk was made by fixture_graph: report method counts + canonical providers)
const crossProvider = xw.filter(x => x.method === 'fixture_graph');
const byProv = crossProvider.reduce((o, x) => { const k = `${x.provider}->${m2.get(x.match_id)?.result_provider}`; o[k] = (o[k] || 0) + 1; return o; }, {});
// 3
const groups = new Map(); for (const m of matches) { const k = `${m.season_id}|${m.home_team_id}|${m.away_team_id}|${m.stage_id}`; groups.set(k, [...(groups.get(k) || []), m]); }
const repeated = [...groups.values()].filter(g => g.length > 1);
// would the NEW key (… , kickoff_at) be violated by existing rows? (same pairing and same kickoff)
const newKeyClash = repeated.filter(g => new Set(g.map(m => m.kickoff_at)).size < g.length).length;
const out = { at: new Date().toISOString(), matches: matches.length, crosswalks: xw.length,
  q1_matches_with_multiple_espn_events: multiEspn.length, q1_examples: multiEspn.slice(0, 20),
  q2_fixture_graph_attachments_by_provider: byProv, q2_note: 'cross-provider attachments were made by (season, home, away[, stage]); provider kickoffs are not stored on the crosswalk, so tolerance can only be enforced going forward (resolver) — no existing attachment is rewritten',
  q3_repeated_pairing_groups_today: repeated.length, q3_would_clash_with_new_key: newKeyClash,
  tolerance_days: TOL_MS / 864e5 };
mkdirSync('docs/evidence/storage', { recursive: true });
writeFileSync(`docs/evidence/storage/repeated-fixtures-audit-${out.at.slice(0, 10)}.json`, `${JSON.stringify(out, null, 1)}\n`);
console.log(JSON.stringify(out, null, 1));
