// Match clock conventions.
// Football minutes are 1-based: an event at 04:10 of the first half is in the
// 5th minute ("5'"). Stoppage time is shown against the period's nominal end:
// 46th minute of the first half = "45+1'". Verified against OpenLigaDB goal
// minutes for Bundesliga 2017/18 (docs/FIELD_COORDINATES.md#clock).

export const PERIOD_START_MIN = Object.freeze({ '1H': 0, '2H': 45, E1: 90, E2: 105, PS: 120 });
export const PERIOD_END_MIN = Object.freeze({ '1H': 45, '2H': 90, E1: 105, E2: 120, PS: 120 });

export function footballMinute(period, secondsIntoPeriod) {
  if (!(period in PERIOD_START_MIN) || !Number.isFinite(secondsIntoPeriod) || secondsIntoPeriod < 0) return null;
  return PERIOD_START_MIN[period] + Math.floor(secondsIntoPeriod / 60) + 1;
}

export function displayMinute(period, minute) {
  if (minute === null || minute === undefined) return null;
  const end = PERIOD_END_MIN[period];
  if (end !== undefined && period !== 'PS' && minute > end) return `${end}+${minute - end}'`;
  return `${minute}'`;
}
