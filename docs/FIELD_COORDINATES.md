# Field coordinates and clock

## One canonical field: 105 m × 68 m

Implementation: `workers/shared/coords.js`. Tests: `tests/core.test.js`.

**Attacking frame.** This frame is stored in `x_m`, `y_m`, `end_x_m` and `end_y_m`:
- The acting team attacks toward **x = 105**. Its own goal line is x = 0.
- **y = 0** is the touchline on the acting team's **left** and y = 68 is on its right. That is screen orientation when the pitch is drawn attacking left to right.
- Units are metres on a nominal 105 × 68 pitch.

**Match frame.** This frame is derived with `toMatchFrame()` and never stored. The home team attacks toward x = 105 in both halves, and away-team events are rotated 180°. It is used to draw both teams on one pitch.

**Source coordinates are never destroyed.** Every event keeps `source_x`,
`source_y`, `source_end_x`, `source_end_y` and `source_coordinate_system`.
`fromCanonical()` inverts the mapping, and round-trip tests reconstruct the
source within 0.02 units.

| System | Units | Frame | Mapping |
|---|---|---|---|
| `wyscout_pct_v1` | 0–100 | team-relative, y 0 = attacking left | x·1.05, y·0.68 |
| `statsbomb_yd_v1` | 120 × 80 yd | team-relative, y 0 = left | x·105/120, y·68/80 |
| `opta_pct_v1` | 0–100 | team-relative, y 0 = **right** | x·1.05, (100−y)·0.68 |

Known limits:
- **Percentage systems are linear scalings.** They assume a standard pitch. Real pitches vary (100–110 × 64–75 m), so box geometry is approximate. For example, the Wyscout box edge at x = 84 maps to 88.2 m against a true 88.5 m.
- **Out-of-range points are not clamped.** They get no canonical value.
- **Wyscout shot end positions are placeholders** (0/100 corners or the next event's origin). Shots get no canonical end point. The source value is kept.
- **These are event coordinates.** They say where an on-ball action happened. They are **not** player tracking, and no surface may imply where the 22 players were. Optical tracking is a separate future data class; the SkillCorner MIT sample is research reference only.

Zones (`zoneOf`):
- length is split into thirds: defensive < 35 m, middle < 70 m, final ≥ 70 m;
- width is split into left, centre and right channels of 22.67 m each.

## Clock

Implementation: `workers/shared/clock.js`.

- **Football minutes are 1-based.** An event at 04:10 of the first half is in the 5th minute (5′). `minute = period_start + floor(seconds/60) + 1`. Period starts are 1H = 0, 2H = 45, E1 = 90, E2 = 105, PS = 120.
- **Stoppage time displays against the period's nominal end.** The 46th minute of the first half is 45+1′.
- **Verified against an independent source.** Wyscout's elapsed clock with this rule reproduces OpenLigaDB's goal minutes exactly for Bayern 6-0 Dortmund: 5, 14, 23, 44, 45(+1), 87.
- **`event_at` (wall-clock time) is null** unless a source states it. The Wyscout dataset has no period kickoff times, so we never invent them. `observed_at` is our capture time.
