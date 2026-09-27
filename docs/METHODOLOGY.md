# Methodology

Proprietary metrics are **designed now and not published**. Each one has a row
in `soccer_metric_definitions` with status `design`. A metric moves forward only
through the gates in `docs/MODEL_READINESS.md`.

## Shipped today: descriptive counts (`pbe-counts/1.0.0`)

These are derived from the event ledger (`workers/soccer-ingest/src/derive.js`).
They are counts and ratios, not models:
- shots and shots on target
- goals and own goals
- passes and passes completed, completed final-third passes (end x ≥ 70 m), crosses
- duels and duels won
- fouls, corners, offsides, cards
- events in the final third
- player assists and key passes (as tagged by the source)
- `minutes_nominal`

`minutes_nominal` is 90 or 120, cut at a substitution or a dismissal. The dataset
has no stoppage-time clock end, and the stat is labelled as such.

**Shot distance** is the euclidean distance from the shot location to the goal
centre (105, 34). It is pure geometry.

**Share of completed passes** is the fraction of the match's completed passes
that belong to one team. It is **not** possession percentage. The source has no
possession clock, so we never print a possession %.

## Designed, not built

**PBE xG** — probability that a shot is scored.
- Inputs: location (distance, angle), body part, set piece, assist type, game state.
- Training needs at least 50k shots. The legitimate pool today is 45,945 (Wyscout, 7 competitions, incl. free-kick shots and penalties). StatsBomb shots are research-only.
- Validation: log-loss and calibration on held-out competitions, compared against a distance/angle baseline.

**PBE xT** — expected threat added by passes and carries, from a grid Markov model (move and shoot probabilities per zone).
- Needs possession chains and at least 500k actions.
- Wyscout has no carries, so xT v0 is pass-only and labelled as such.

**Possession value** — value created or lost within a possession chain.
- Needs versioned possession derivation (`soccer_possessions`) and PBE xG.

**Field tilt** — share of final-third on-ball actions.
- The descriptive version already exists as `attacking_third_event_share` in packets.
- The metric version needs event-type weighting and a published definition.

**Pressing intensity** — a PPDA-like measure: opponent passes in their own 60% of the pitch per defensive action there.
- A proprietary variant weights actions by location and time-to-regain.

**Transition threat** — value generated within N seconds after a recovery or turnover.

**Progressive action** — a pass or carry that moves the ball at least 25% closer to goal, or into the box.

**Set piece threat** — shots, xG and second-ball wins from corners and free kicks.

**Finishing delta** — goals minus PBE xG. This is noisy; publish it only with an interval and a sample floor.

**Goalkeeper impact** — goals prevented. It needs post-shot information (shot placement), which the Wyscout public data lacks: its end locations are placeholders. It stays blocked until a legitimate source provides placement.

## Soccer DNA (architecture)

Profile axes:
- ball progression
- chance creation
- final-third passing
- line-breaking passing (needs player positions, which event data does not have; blocked)
- carry value (Wyscout has no carries; blocked)
- pressure resistance (no pressure flag in the source; blocked)
- defensive recoveries
- duels
- transition creation
- finishing
- aerial ability
- possession value
- set pieces

Context splits:
- competition, season, opponent strength, home/away, game state
- position (a sourced match position; the Wyscout role is only a bio attribute)
- formation (when sourced)
- zones
- rolling 5, 10, season and career

Publication follows the tennis contract:
- **L1:** individual measurements with their sample.
- **L2:** a per-metric percentile only with 10 or more qualified peers at the same position.
- **L3:** radar, leaderboards and traits only once a population of 30 or more is qualified.
- No percentile from a population of 8.
