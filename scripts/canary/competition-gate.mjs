// Gate of the generic competition canary (scripts/canary/competition.mjs): a pure function of the report, so a report
// can be re-gated after a gate fix without re-fetching the source (`node scripts/canary/competition-gate.mjs <file>`
// records regated_at + the reason in the file; the source data in the report is untouched).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 1.1.0: grouped tables pass on per-group verification. 1.2.0: separate acceptance labels (owner decision 2026-10-03:
// missing spatial data does not block a league; unreliable identity / status / detail does). `pass` = match data only.
export const GATE_VERSION = 'competition-canary-gate/1.2.0';
export function acceptanceOf(report, gate) {
  const e = report.enrichment || {};
  const spatial = (e.located_events || 0) > 0 ? 'SPATIAL_DATA_AVAILABLE'
    : (e.coord_systems?.espn_unit_unverified || 0) > 0 ? 'SPATIAL_DATA_UNVERIFIED' // 0-1 scale, frame not proven
      : 'SPATIAL_DATA_UNAVAILABLE';
  return { match_data: gate.pass ? 'MATCH_DATA_PASS' : 'MATCH_DATA_FAIL', spatial, located_events: e.located_events || 0 };
}
export function gateOf(report) {
  const e = report.enrichment || {}; const m = report.matches || {}; const t = report.table || {};
  // grouped views (league phase, groups): every group verified by our canonical recomputation, none withheld
  const groupsOk = Array.isArray(t.groups) && t.groups.length > 0 && t.groups.every(g => g.verified === true) && !(t.withheld_groups > 0);
  const g = {
    lane_completed_without_abort: !report.aborted && !report.budget_exhausted,
    fixtures_complete: report.espn.fixtures_seen > 0 && report.espn.fixtures_seen === (m.total || 0),
    every_finished_match_scored: (m.finished_without_score ?? 1) === 0,
    no_unknown_status: !(m.by_status?.unknown > 0), // 1.2.0: a fixture whose status the lane could not read is not accepted
    every_finished_match_detailed: (e.finished ?? 0) === (e.detailed ?? -1),
    no_enrichment_gaps: (e.gaps?.length ?? 1) === 0,
    identity: !!report.identity_gate?.pass,
    table: !t.error && (t.groups ? groupsOk : (t.rows || 0) > 0),
    knockout_winners_known: (m.knockout_without_winner ?? 1) === 0,
  };
  g.pass = Object.values(g).every(Boolean);
  return g;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.argv[2];
  const r = JSON.parse(readFileSync(file, 'utf8'));
  const before = r.gate;
  r.gate = gateOf(r);
  r.acceptance = acceptanceOf(r, r.gate);
  r.gate_version = GATE_VERSION;
  r.regated = { at: new Date().toISOString(), previous_gate: before, reason: process.argv[3] || 'gate logic fix; source data unchanged' };
  writeFileSync(file, JSON.stringify(r, null, 2) + '\n');
  console.log(file, JSON.stringify(r.gate));
}
