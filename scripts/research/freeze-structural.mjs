#!/usr/bin/env node
// Freeze the Phase 3 structural candidate selected by the protocol (reads the committed DEV freeze
// and holdout results; changes nothing about them). Output: frozen/model-card-v1.2-dc.json
//   node scripts/research/freeze-structural.mjs
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const DEVF = 'docs/evidence/research/phase3/dev-selection.json'; const HOLDF = 'docs/evidence/research/phase3/holdout-results.json';
const dev = JSON.parse(readFileSync(DEVF, 'utf8')); const hold = JSON.parse(readFileSync(HOLDF, 'utf8'));
if (hold.final_candidate !== 'B' || hold.overall !== 'STRUCTURAL MODEL READY FOR CALIBRATION') throw new Error(`protocol outcome is ${hold.final_candidate}/${hold.overall}; this card describes B only`);
const card = {
  model_id: 'soccer-research-bundesliga-v1.2-dc',
  status: 'research only; frozen structural candidate awaiting a separate calibration phase; not in production; no shadow',
  parent: 'soccer-research-bundesliga-v1-frozen (strict v1.1 Poisson lambdas, unchanged)',
  change: 'Dixon-Coles low-score dependence on the v1.1 lambdas: tau(0,0) = 1 - lh*la*rho, tau(0,1) = 1 + lh*rho, tau(1,0) = 1 + la*rho, tau(1,1) = 1 - rho; 0..10 grid renormalised',
  rho: dev.selection.B.rho, rho_selected_by: 'maximum DEV (2014/15-2018/19) scoreline log-likelihood, A lambdas fixed',
  home_half_life_days: 540, team_strength: { half_life_days: 540, shrink: 10, window_half_lives: 5, min_weight: 50 },
  protocol: { id: dev.protocol_id, sha256: dev.protocol_sha256 },
  evidence: { dev_selection: DEVF, dev_selection_sha256: sha(DEVF), holdout_results: HOLDF, holdout_results_sha256: sha(HOLDF) },
  data_sha256: dev.data_sha256,
  code_sha256: dev.script_sha256,
  prediction_hash: dev.prediction_hashes.B, rows: dev.prediction_hashes.rows,
  holdout: { log_loss: hold.pooled.B.log_loss, brier: hold.pooled.B.brier, ece: hold.pooled.B.ece, ece_class: hold.pooled.B.ece_class, bias_pts: hold.pooled.B.bias_pts },
  known_residuals: ['home win over-predicted +1.28 pts pooled and season-dependent (sd 3.27 pts)', 'away win under-predicted -0.78 pts (away ECE 0.0137 -> 0.0178)', 'draws still under-predicted in mid-strength home teams (-2.19 pts) and the 0.21-0.24 draw band (-2.57 pts)'],
};
writeFileSync('docs/evidence/research/frozen/model-card-v1.2-dc.json', JSON.stringify(card, null, 2) + '\n');
console.log(JSON.stringify(card, null, 1));
