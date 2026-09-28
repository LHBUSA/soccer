// Prospective shadow metrics (pure). Observational only: nothing here recalibrates the model or
// promotes it. The benchmark is the baseline declared in Phase 1 (train frequencies), fixed in
// shadow-model.json.

const CLASSES = ['home', 'draw', 'away'];
const IDX = { home: 0, draw: 1, away: 2 };
const r4 = x => (x === null || x === undefined || !Number.isFinite(x) ? null : +x.toFixed(4));
const probs = r => [Number(r.p_home), Number(r.p_draw), Number(r.p_away)];

function eceClass(xs, c, bins = 10) {
  let e = 0;
  for (let b = 0; b < bins; b++) {
    const g = xs.filter(x => Math.min(bins - 1, Math.floor(x.p[c] * bins)) === b);
    if (!g.length) continue;
    e += (g.length / xs.length) * Math.abs(g.reduce((a, x) => a + x.p[c], 0) / g.length - g.filter(x => x.y === c).length / g.length);
  }
  return e;
}

export function summary(xs, base) {
  const n = xs.length;
  if (!n) return { n: 0 };
  const ll = p => -Math.log(Math.max(1e-12, p));
  const brier = (p, y) => p.reduce((a, v, i) => a + (v - (i === y ? 1 : 0)) ** 2, 0);
  const argmax = p => p.indexOf(Math.max(...p));
  const classwise = CLASSES.map((name, c) => {
    const pred = xs.reduce((a, x) => a + x.p[c], 0) / n; const obs = xs.filter(x => x.y === c).length / n;
    return { class: name, mean_predicted: r4(pred), observed: r4(obs), bias_pts: +((pred - obs) * 100).toFixed(2), ece: r4(eceClass(xs, c)) };
  });
  return {
    n,
    log_loss: r4(xs.reduce((a, x) => a + ll(x.p[x.y]), 0) / n),
    brier: r4(xs.reduce((a, x) => a + brier(x.p, x.y), 0) / n),
    ece: r4(classwise.reduce((a, c) => a + c.ece, 0) / 3),
    favourite_accuracy: r4(xs.filter(x => argmax(x.p) === x.y).length / n),
    classwise,
    baseline: { log_loss: r4(xs.reduce((a, x) => a + ll(base[x.y]), 0) / n), brier: r4(xs.reduce((a, x) => a + brier(base, x.y), 0) / n) },
  };
}

function rates(xs) {
  const n = xs.length;
  return { n, ...Object.fromEntries(CLASSES.map((name, c) => [name, { predicted: r4(xs.reduce((a, x) => a + x.p[c], 0) / n), observed: r4(xs.filter(x => x.y === c).length / n) }])) };
}

// rows: every shadow prediction row of the model; seasonLabel: season_id -> label;
// missed: matches that kicked off without a prediction; lateHours: lead-time threshold.
export function shadowMetrics({ rows, seasonLabel = {}, missed = 0, baseline, now = Date.now(), lateHours = 24 }) {
  const base = [baseline.p_home, baseline.p_draw, baseline.p_away];
  const settled = rows.filter(r => r.settled_at).sort((a, b) => Date.parse(a.kickoff_at) - Date.parse(b.kickoff_at) || (a.match_id < b.match_id ? -1 : 1))
    .map(r => ({ p: probs(r), y: IDX[r.outcome], season: seasonLabel[r.season_id] || r.season_id, month: new Date(r.kickoff_at).toISOString().slice(0, 7) }));
  const lead = rows.map(r => (Date.parse(r.kickoff_at) - Date.parse(r.predicted_at)) / 3600e3).sort((a, b) => a - b);
  const rolling = Object.fromEntries([30, 60, 100].map(w => [`last_${w}`, settled.length >= w ? summary(settled.slice(-w), base) : { n: settled.length, window: w, complete: false }]));
  const group = key => Object.fromEntries([...new Set(settled.map(x => x[key]))].sort().map(k => [k, rates(settled.filter(x => x[key] === k))]));
  return {
    computed_at: new Date(now).toISOString(),
    counts: {
      predictions: rows.length, settled: settled.length, pending: rows.length - settled.length, missed,
      late_issues: lead.filter(h => h < lateHours).length, late_threshold_hours: lateHours,
      lead_time_hours: lead.length ? { min: r4(lead[0]), median: r4(lead[Math.floor(lead.length / 2)]), max: r4(lead.at(-1)) } : null,
    },
    overall: summary(settled, base),
    rolling,
    by_season: group('season'),
    by_month: group('month'),
    policy: 'observational shadow: no automatic recalibration, no automatic promotion; manual owner review only; small samples are not evidence of production readiness',
  };
}
