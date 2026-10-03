// SEASON PROMOTION WRITES (scripts/history/accept-season.mjs --promote). Pure.
// Limitations are evidence: reviewed notes (format review, provider date exceptions, reviewed-manifest limitations,
// any note a later reconciliation appends) are NEVER dropped. Only the measured coverage lines are recomputed.
// Evidence state and data state are separate writes, evidence FIRST, so a public season never lacks its notes:
//   evidence = { limitations, coverage_tier, source_families }   (season row metadata, may be rewritten any time)
//   state    = { publication_state, published_at, reviewed_at, publication_note }   (the publication decision)
// Re-promoting a published season changes nothing but reviewed_at: same limitations, same published_at.
export const COVERAGE_LINE = /^(lineups|team statistics|event record) for \d+% of finished matches$/;

export function mergeLimitations(existing = [], additions = [], coverage = []) {
  const kept = (existing || []).filter(l => !COVERAGE_LINE.test(l));
  return [...new Set([...kept, ...(additions || []).filter(l => !COVERAGE_LINE.test(l)), ...(coverage || [])])];
}

export function promotionWrites({ current = {}, reviewLimitations = [], coverage = [], tier = null, providers = [], at, note }) {
  const evidence = { limitations: mergeLimitations(current.limitations, reviewLimitations, coverage), coverage_tier: tier, source_families: providers };
  const already = current.publication_state === 'published';
  const state = { publication_state: 'published', published_at: already && current.published_at ? current.published_at : at, reviewed_at: at, publication_note: already && current.publication_note ? current.publication_note : note };
  return { evidence, state };
}
