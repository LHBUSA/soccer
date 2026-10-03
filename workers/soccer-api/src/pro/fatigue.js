// FATIGUE INTELLIGENCE v1 (Soccer Pro) — WORKLOAD intelligence from canonical data only.
// Pure functions over rows the route loads; no I/O. Every index is the weighted sum of named
// components and ships with them (value, weight, contribution), so a score is always explainable.
//
// This is NOT a medical or fitness assessment: nothing here says a player is injured, tired,
// exhausted or at risk. It measures schedule congestion, minutes played and squad usage.
// Extra time is counted only where a source recorded it (duration 'extra_time'); ESPN results
// carry no extra-time flag, so for those matches it is never assumed.
export const FATIGUE_VERSION = 'soccer-fatigue/1.0.0';

const DAY = 864e5;
const clamp01 = x => Math.max(0, Math.min(1, x));
const r2 = x => Math.round(x * 100) / 100;
const ms = iso => Date.parse(iso);

// Weighted index: [{ key, label, value (0..1), weight, detail }] -> { score 0..100, components }
export function weighted(components) {
  const total = components.reduce((s, c) => s + c.weight, 0) || 1;
  const out = components.map(c => ({ ...c, value: r2(clamp01(c.value)), contribution: r2((100 * c.weight * clamp01(c.value)) / total) }));
  return { score: Math.round(out.reduce((s, c) => s + c.contribution, 0)), components: out };
}

// ---- TEAM LOAD --------------------------------------------------------------------------------
// matches: canonical matches of the team (any competition), each { id, kickoff_at, status,
// home_team_id, away_team_id, competition_slug, duration }. asOf: ISO instant (default now).
export function teamLoad(matches, teamId, asOf = new Date().toISOString()) {
  const t = ms(asOf);
  const past = matches.filter(m => m.status === 'finished' && ms(m.kickoff_at) < t).sort((a, b) => ms(b.kickoff_at) - ms(a.kickoff_at));
  const within = d => past.filter(m => t - ms(m.kickoff_at) <= d * DAY);
  const last = past[0] || null;
  const days = last ? Math.floor((t - ms(last.kickoff_at)) / DAY) : null;
  // rest gaps between consecutive matches in the last 21 days (< 4 full days = short rest)
  const w21 = within(21).slice().reverse();
  const gaps = w21.slice(1).map((m, i) => (ms(m.kickoff_at) - ms(w21[i].kickoff_at)) / DAY);
  const shortRest = gaps.filter(g => g < 4).length;
  const recent5 = past.slice(0, 5);
  const venue = recent5.map(m => (m.home_team_id === teamId ? 'H' : 'A'));
  let switches = 0;
  for (let i = 1; i < recent5.length; i++) if (recent5[i].competition_slug !== recent5[i - 1].competition_slug) switches += 1;
  const extraTime = within(21).filter(m => m.duration === 'extra_time' || m.duration === 'penalties').length;
  const next = matches.filter(m => m.status === 'scheduled' && ms(m.kickoff_at) >= t).sort((a, b) => ms(a.kickoff_at) - ms(b.kickoff_at))[0] || null;
  return {
    days_since_last: days, last_match_id: last?.id || null,
    matches_7: within(7).length, matches_14: within(14).length, matches_21: within(21).length,
    short_rest_sequences_21: shortRest, rest_gaps_21_days: gaps.map(g => r2(g)),
    home_away_last5: venue.join(''), away_share_last5: venue.length ? r2(venue.filter(v => v === 'A').length / venue.length) : null,
    competition_switches_last5: switches, competitions_last5: recent5.map(m => m.competition_slug),
    extra_time_21: extraTime, extra_time_basis: 'counted only where the source recorded extra time; some observed results carry no extra-time flag',
    next_match: next ? { id: next.id, kickoff_at: next.kickoff_at, rest_days_before: last ? r2((ms(next.kickoff_at) - ms(last.kickoff_at)) / DAY) : null } : null,
  };
}

export function teamFatigueIndex(load) {
  const rest = load.next_match?.rest_days_before ?? load.days_since_last;
  return weighted([
    { key: 'congestion_14', label: 'Matches in the last 14 days', value: load.matches_14 / 5, weight: 0.35, detail: `${load.matches_14} in 14 days (5 = maximum load)` },
    { key: 'short_rest', label: 'Short-rest turnarounds (< 4 days) in 21 days', value: load.short_rest_sequences_21 / 3, weight: 0.25, detail: `${load.short_rest_sequences_21} short turnaround(s)` },
    { key: 'rest', label: 'Rest before the next match (or since the last)', value: rest === null || rest === undefined ? 0 : (6 - rest) / 4, weight: 0.25, detail: rest === null || rest === undefined ? 'no recent match' : `${rest} day(s)` },
    { key: 'travel_sequence', label: 'Away share of the last five', value: load.away_share_last5 ?? 0, weight: 0.1, detail: load.home_away_last5 || 'none' },
    { key: 'competition_switching', label: 'Competition switches in the last five', value: load.competition_switches_last5 / 3, weight: 0.05, detail: `${load.competition_switches_last5} switch(es)` },
  ]);
}

// ---- PLAYER LOAD ------------------------------------------------------------------------------
// apps: one row per match the player was NAMED in: { match_id, kickoff_at, minutes (nominal,
// null when not derivable), started, came_on, sub_on_minute, sub_off_minute, team_kind
// ('club' | 'national'), competition_slug }.
export function playerLoad(apps, asOf = new Date().toISOString()) {
  const t = ms(asOf);
  const past = apps.filter(a => ms(a.kickoff_at) < t).sort((a, b) => ms(b.kickoff_at) - ms(a.kickoff_at));
  const within = d => past.filter(a => t - ms(a.kickoff_at) <= d * DAY);
  const mins = d => within(d).reduce((s, a) => s + (a.minutes || 0), 0);
  let consecutive = 0;
  for (const a of past) { if (a.started) consecutive += 1; else break; }
  const played = within(21).filter(a => a.started || a.came_on);
  const subOff = within(21).filter(a => a.started && Number.isFinite(a.sub_off_minute)).map(a => a.sub_off_minute);
  // International return load: the club / national-team sequence over the last 21 days.
  const seq = within(21).slice().reverse().map(a => a.team_kind === 'national' ? 'national' : 'club');
  const collapsed = seq.filter((k, i) => i === 0 || k !== seq[i - 1]);
  return {
    minutes_7: mins(7), minutes_14: mins(14), minutes_21: mins(21),
    starts_21: within(21).filter(a => a.started).length, appearances_21: played.length,
    consecutive_starts: consecutive,
    apps_75_plus_21: within(21).filter(a => (a.minutes || 0) >= 75).length,
    apps_90_plus_21: within(21).filter(a => (a.minutes || 0) >= 90).length,
    avg_sub_off_minute_21: subOff.length ? Math.round(subOff.reduce((s, x) => s + x, 0) / subOff.length) : null,
    bench_unused_21: within(21).filter(a => !a.started && !a.came_on).length,
    national_team_apps_21: within(21).filter(a => a.team_kind === 'national' && (a.started || a.came_on)).length,
    international_sequence_21: collapsed.join(' → ') || null,
    international_return: collapsed.length >= 3 && collapsed[collapsed.length - 1] === 'club' && collapsed.includes('national'),
  };
}

// ---- SQUAD STRUCTURE --------------------------------------------------------------------------
// xis: the team's last matches, newest first: { match_id, kickoff_at, starters: [player_id],
// minutes: { player_id: minutes } }.
export function squadStructure(xis) {
  const recent = xis.slice(0, 5);
  const overlaps = recent.slice(1).map((x, i) => recent[i].starters.filter(p => x.starters.includes(p)).length);
  const minutes = new Map();
  for (const x of recent) for (const [p, m] of Object.entries(x.minutes || {})) minutes.set(p, (minutes.get(p) || 0) + (m || 0));
  const sorted = [...minutes.values()].sort((a, b) => b - a);
  const total = sorted.reduce((s, x) => s + x, 0) || 0;
  const share = n => (total ? r2(sorted.slice(0, n).reduce((s, x) => s + x, 0) / total) : null);
  const starters = new Set(recent.flatMap(x => x.starters));
  return {
    matches_considered: recent.length,
    xi_continuity: overlaps.length ? r2(overlaps.reduce((s, x) => s + x, 0) / (overlaps.length * 11)) : null,
    lineup_changes_avg: overlaps.length ? r2(overlaps.reduce((s, x) => s + (11 - x), 0) / overlaps.length) : null,
    top11_minute_share: share(11), top14_minute_share: share(14),
    players_started: starters.size, rotation_depth: starters.size,
    last_xi: recent[0]?.starters || [],
  };
}

// XI LOAD: minutes the most recent XI carried over the last 14 days, as a share of the minutes
// its team played in that window (90 per match). Components per player are returned.
export function xiLoad(lastXi, playerLoads, teamMatches14) {
  const cap = 90 * Math.max(1, teamMatches14);
  const per = lastXi.map(p => ({ player_id: p, minutes_14: playerLoads.get(p)?.minutes_14 ?? 0, share: r2(clamp01((playerLoads.get(p)?.minutes_14 ?? 0) / cap)) }));
  const avg = per.length ? per.reduce((s, x) => s + x.share, 0) / per.length : 0;
  const intl = lastXi.filter(p => playerLoads.get(p)?.international_return).length;
  const w = weighted([
    { key: 'xi_minutes_share_14', label: 'Share of available minutes the last XI played (14 days)', value: avg, weight: 0.8, detail: `${Math.round(avg * 100)}% of ${cap} team minutes per player` },
    { key: 'international_return', label: 'Players in the last XI returning from national-team duty', value: intl / 4, weight: 0.2, detail: `${intl} player(s)` },
  ]);
  return { ...w, players: per };
}

export function rotationPressure(teamIndex, squad) {
  return weighted([
    { key: 'schedule', label: 'Team fatigue index (schedule)', value: teamIndex.score / 100, weight: 0.5, detail: `${teamIndex.score}/100` },
    { key: 'concentration', label: 'Minutes concentrated in the top 11', value: squad.top11_minute_share === null ? 0 : (squad.top11_minute_share - 0.6) / 0.3, weight: 0.3, detail: squad.top11_minute_share === null ? 'no sourced lineups' : `${Math.round(squad.top11_minute_share * 100)}% of minutes` },
    { key: 'continuity', label: 'Starting-XI continuity', value: squad.xi_continuity ?? 0, weight: 0.2, detail: squad.xi_continuity === null ? 'fewer than two sourced XIs' : `${Math.round(squad.xi_continuity * 100)}% of starters kept` },
  ]);
}
