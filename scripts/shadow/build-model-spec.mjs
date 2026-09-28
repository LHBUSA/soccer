#!/usr/bin/env node
// Generates workers/soccer-ingest/src/shadow-model.json: the frozen constants the shadow lane uses,
// read from the committed v1.2-dc model card (and the v1 card for the declared baseline), plus
// the sha256 of the frozen structural core the Worker imports. tests/shadow.test.js fails if the
// committed file differs from a fresh build (so the Worker can never drift from the card).
//   node scripts/shadow/build-model-spec.mjs [--check]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { stableStringify } from '../../workers/shared/ids.js';

const sha = b => createHash('sha256').update(b).digest('hex');
const CARD = 'docs/evidence/research/frozen/model-card-v1.2-dc.json';
const CARD_V1 = 'docs/evidence/research/frozen/model-card-v1.json';
const CORE = 'scripts/research/structural-core.mjs';
const OUT = 'workers/soccer-ingest/src/shadow-model.json';
const card = JSON.parse(readFileSync(CARD, 'utf8'));
const v1 = JSON.parse(readFileSync(CARD_V1, 'utf8'));
const [bh, bd, ba] = v1.coefficients.baseline_train_frequencies;
const spec = {
  model_id: card.model_id,
  model_version: '1.2.0',
  calibration_id: 'none',
  scope: { competition_slug: 'bundesliga', stage_type: 'league' },
  rho: card.rho,
  team_strength: card.team_strength,
  home_half_life_days: card.home_half_life_days,
  baseline: { name: 'train-set result frequencies 2004/05-2013/14 (declared in Phase 1; unchanged)', p_home: bh, p_draw: bd, p_away: ba },
  eligibility: { window_days: 7, statuses: ['scheduled'] },
  sources: { card: CARD, card_sha256: sha(readFileSync(CARD)), core: CORE, core_sha256: sha(readFileSync(CORE)), research_prediction_hash: card.prediction_hash },
};
spec.model_hash = sha(stableStringify(spec));
const text = JSON.stringify(spec, null, 2) + '\n';
if (process.argv.includes('--check')) {
  const cur = readFileSync(OUT, 'utf8');
  if (cur !== text) { console.error('shadow-model.json is stale'); process.exit(1); }
  console.log('shadow-model.json up to date', spec.model_hash);
} else { writeFileSync(OUT, text); console.log(text); }
