// Health report split: CANONICAL source health vs LIVE-ENRICHMENT health. A failing secondary
// enrichment source never makes canonical health unhealthy: `ok` is computed from the canonical
// lanes only (see index.js), the enrichment block is reported beside it.
export const CANONICAL = [{ lane: 'openligadb_bl1_current', source: 'openligadb', competition: 'bundesliga' }];

const pct = (xs, p) => { if (xs.length < 5) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; };

export function canonicalHealth(lanes, coverage = {}) {
  return CANONICAL.map(c => {
    const l = lanes.find(x => x.lane === c.lane) || {};
    return { source: c.source, competition: c.competition, lane: c.lane, health: l.health || 'unknown', last_success_at: l.last_success_at || null, result_freshness: l.last_change_at || null, consecutive_failures: l.consecutive_failures || 0, fixture_coverage: coverage[c.competition] || null };
  });
}

export function enrichmentHealth({ registry, lane = {}, metrics = [], breaker = null, disagreements = [], glitches = [], corrections = [], now = Date.now() }) {
  const modes = registry.competitions.filter(c => c.espn?.enabled && (c.espn.live_enrichment === 'shadow' || c.espn.live_enrichment === 'public')).map(c => ({ competition: c.slug, mode: c.espn.live_enrichment }));
  const last = metrics[metrics.length - 1] || null;
  const ages = metrics.map(m => m.max_age_s).filter(Number.isFinite);
  const lags = metrics.map(m => m.started_lag_ms).filter(Number.isFinite);
  const durs = metrics.map(m => m.duration_ms).filter(Number.isFinite);
  const open = !!(breaker?.open_until && now < Date.parse(breaker.open_until));
  return {
    source: 'espn', role: 'secondary_enrichment', competitions: modes,
    public: modes.some(m => m.mode === 'public'),
    lane_health: lane.health || 'unknown', last_tick_at: last?.at || lane.last_success_at || null,
    ticks_sampled: metrics.length,
    successful_polls: metrics.reduce((a, m) => a + (m.ok || 0), 0), failed_polls: metrics.reduce((a, m) => a + (m.failed || 0), 0),
    active_matches: last?.polled ?? 0,
    breaker: { state: open ? 'open' : breaker?.failed_ticks ? 'degraded' : 'closed', failed_ticks: breaker?.failed_ticks || 0, open_until: open ? breaker.open_until : null, reason: open ? breaker.reason || null : null },
    poll_age_seconds: { median: pct(ages, 0.5), p95: pct(ages, 0.95) },
    cron_start_lag_ms: { median: pct(lags, 0.5), p95: pct(lags, 0.95) },
    tick_duration_ms: { median: pct(durs, 0.5), p95: pct(durs, 0.95) },
    score_disagreements: disagreements.length, provider_glitches: glitches.length,
    event_retractions: corrections.reduce((a, c) => a + (c.retracted?.length || 0), 0),
    note: 'Enrichment health never affects `ok` (canonical lanes only). Percentiles need at least 5 ticks.',
  };
}
