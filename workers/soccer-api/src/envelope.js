// Response envelope for every soccer-api response (same contract as the newer
// tennis API): the data plus where it came from, how fresh it is, what it means,
// and whether coverage is complete.

export const COVERAGE = Object.freeze({ OK: 'ok', PARTIAL: 'partial', DEGRADED: 'degraded', UNAVAILABLE: 'unavailable' });

export const ATTRIBUTION = {
  wyscout: 'Event data: Pappalardo et al. (2019), Wyscout public soccer-logs dataset, CC BY 4.0',
  openligadb: 'Fixtures/results: OpenLigaDB (openligadb.de), ODbL 1.0',
  espn: 'Structured facts: ESPN (secondary source)',
};

export function envelope(data, { source, source_updated_at = null, semantics, coverage = COVERAGE.OK, coverage_notes = [], attribution = [], version }) {
  return {
    data,
    meta: {
      source, source_updated_at, semantics,
      coverage: { state: coverage, notes: coverage_notes },
      attribution: [...new Set(attribution)].map(k => ATTRIBUTION[k] || k),
      generated_at: new Date().toISOString(),
      api_version: version,
    },
  };
}

export const maxTs = (...vals) => {
  const t = vals.flat().filter(Boolean).map(v => Date.parse(v)).filter(Number.isFinite);
  return t.length ? new Date(Math.max(...t)).toISOString() : null;
};
