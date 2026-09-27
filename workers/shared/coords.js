// One canonical field: 105 m x 68 m.  See docs/FIELD_COORDINATES.md.
//
// Canonical frame ("attacking frame"), used for x_m / y_m / end_x_m / end_y_m:
//   * the acting team attacks toward x = 105 (own goal line x = 0);
//   * y = 0 is the touchline on the acting team's LEFT, y = 68 on its right,
//     i.e. screen orientation (y grows downward) when drawn attacking left->right;
//   * units are metres on a nominal 105 x 68 pitch.
// The original source coordinates are always stored alongside, untouched.
//
// The "match frame" (for drawing both teams on one pitch) is derived, never
// stored: the home team attacks toward x = 105 in both halves, so away-team
// events are rotated 180 degrees (see toMatchFrame).

export const PITCH_LENGTH_M = 105;
export const PITCH_WIDTH_M = 68;

// Source coordinate systems we understand. `teamRelative` = source already
// expresses each event from the acting team's attacking perspective.
export const COORDINATE_SYSTEMS = Object.freeze({
  // Wyscout public dataset (Pappalardo et al. 2019): percentages 0..100,
  // x from own goal to opponent goal, y 0 = attacking team's left touchline.
  wyscout_pct_v1: { xMax: 100, yMax: 100, teamRelative: true, yDownIsRight: true },
  // StatsBomb: 120 x 80 yards, team-relative, y 0 = left touchline.
  statsbomb_yd_v1: { xMax: 120, yMax: 80, teamRelative: true, yDownIsRight: true },
  // Opta-style: 0..100 team-relative with y 0 = RIGHT touchline (y grows to the left).
  opta_pct_v1: { xMax: 100, yMax: 100, teamRelative: true, yDownIsRight: false },
  // ESPN Core plays (fieldPositionX/Y): 0..100 team-relative, attacking toward
  // x=100, y=0 = attacking team's RIGHT (verified: docs/evidence/espn-soccer-coordinates.json).
  espn_pct_v1: { xMax: 100, yMax: 100, teamRelative: true, yDownIsRight: false },
});

const round = (v, dp = 2) => (v === null || v === undefined ? null : Math.round(v * 10 ** dp) / 10 ** dp);

// Convert one source point into the canonical attacking frame.
// Returns { x_m, y_m } or nulls if the source point is absent/invalid.
export function toCanonical(system, x, y) {
  const spec = COORDINATE_SYSTEMS[system];
  if (!spec) throw new Error(`unknown coordinate system: ${system}`);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { x_m: null, y_m: null };
  if (x < 0 || x > spec.xMax || y < 0 || y > spec.yMax) {
    // Out-of-range is a source defect; keep the source value, refuse to invent a canonical one.
    return { x_m: null, y_m: null };
  }
  if (!spec.teamRelative) throw new Error(`${system}: absolute-frame sources need a direction-of-play input`);
  const xm = (x / spec.xMax) * PITCH_LENGTH_M;
  const yFrac = spec.yDownIsRight ? y / spec.yMax : 1 - y / spec.yMax;
  return { x_m: round(xm), y_m: round(yFrac * PITCH_WIDTH_M) };
}

// Canonical attacking frame -> match frame (home attacks toward x = 105).
export function toMatchFrame(point, { isHomeTeam }) {
  if (point.x_m === null || point.y_m === null) return { x: null, y: null };
  return isHomeTeam
    ? { x: point.x_m, y: point.y_m }
    : { x: round(PITCH_LENGTH_M - point.x_m), y: round(PITCH_WIDTH_M - point.y_m) };
}

// Inverse of toCanonical, for reconstruction tests: canonical -> source units.
export function fromCanonical(system, x_m, y_m) {
  const spec = COORDINATE_SYSTEMS[system];
  if (!spec) throw new Error(`unknown coordinate system: ${system}`);
  if (x_m === null || y_m === null) return { x: null, y: null };
  const x = (x_m / PITCH_LENGTH_M) * spec.xMax;
  const yFrac = y_m / PITCH_WIDTH_M;
  return { x: round(x, 4), y: round((spec.yDownIsRight ? yFrac : 1 - yFrac) * spec.yMax, 4) };
}

// Zones used by descriptive analytics. Thirds on length, channels on width.
export function zoneOf(x_m, y_m) {
  if (x_m === null || y_m === null) return null;
  const third = x_m < 35 ? 'defensive' : x_m < 70 ? 'middle' : 'final';
  const channel = y_m < 68 / 3 ? 'left' : y_m < (2 * 68) / 3 ? 'center' : 'right';
  return { third, channel };
}
