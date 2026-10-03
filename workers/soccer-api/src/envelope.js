// Response envelope for every soccer-api response (same contract as the newer
// tennis API): the data plus where it came from, how fresh it is, what it means,
// and whether coverage is complete.

export const COVERAGE = Object.freeze({ OK: 'ok', PARTIAL: 'partial', DEGRADED: 'degraded', UNAVAILABLE: 'unavailable' });

// Licence-required credits only (CC BY / ODbL). Facts from other collection lanes are attributed to PropSports
// (network source standard "DATA · PropSports"); the lane itself stays in internal provenance.
export const ATTRIBUTION = {
  wyscout: 'Event data: Pappalardo et al. (2019), Wyscout public soccer-logs dataset, CC BY 4.0', // source-brand:allow (CC BY licence credit)
  openligadb: 'Fixtures/results: OpenLigaDB (openligadb.de), ODbL 1.0', // source-brand:allow (ODbL licence credit)
};
export const DATA_SOURCE = 'PropSports';
// Legacy public fields kept for compatibility; they name the internal collection lane. Use the neutral fields.
export const DEPRECATED_FIELDS = Object.freeze({
  result_source: 'deprecated compatibility-only lane key; use data_source',
  event_source: 'deprecated compatibility-only lane key; use data_source',
  'stats.provider': 'deprecated compatibility-only lane key; use stats.source',
  'stats.*.provider_xg_espn': 'deprecated alias of stats.*.provider_xg',
  'verification.provider': 'deprecated compatibility-only lane key; use verification.source',
});
const LANE = /\bESPN(?:'s)?\b(?: \(secondary(?: source)?\))?/g;
export const brandText = s => (typeof s === 'string' ? s.replace(LANE, DATA_SOURCE) : s);

export function envelope(data, { source, source_updated_at = null, semantics, coverage = COVERAGE.OK, coverage_notes = [], attribution = [], version, deprecated = null }) {
  return {
    data,
    meta: {
      source, source_updated_at, semantics: brandText(semantics),
      coverage: { state: coverage, notes: coverage_notes.map(brandText) },
      attribution: [...new Set([...new Set(attribution)].map(k => ATTRIBUTION[k] || (k === 'espn' || /ESPN/.test(String(k)) ? null : k)).filter(Boolean))],
      ...(deprecated ? { deprecated_fields: deprecated } : {}),
      generated_at: new Date().toISOString(),
      api_version: version,
    },
  };
}

export const maxTs = (...vals) => {
  const t = vals.flat().filter(Boolean).map(v => Date.parse(v)).filter(Number.isFinite);
  return t.length ? new Date(Math.max(...t)).toISOString() : null;
};
