// Knockout bracket edges PROVEN from canonical match identities and results only.
// No tournament format is assumed: for every team in a knockout match after the first knockout
// stage, its feeder is that team's latest earlier knockout match. The edge exists only when the
// feeder is finished with a stored winner and the team either won it (advanced) or lost it (a
// third-place match). A match whose two teams do not both have a proven feeder gets no edges, and
// the bracket is reported as proven only when every later-stage match has both.
//
// stages:  [{ id, name, stage_order }] knockout stages only
// matches: [{ id, stage_id, kickoff_at, status, home_team_id, away_team_id, winner_team_id }]
export function provenBracket(stages, matches) {
  const order = new Map(stages.map(s => [s.id, s.stage_order]));
  const ko = matches.filter(m => order.has(m.stage_id)).sort((a, b) => Date.parse(a.kickoff_at) - Date.parse(b.kickoff_at) || String(a.id).localeCompare(String(b.id)));
  const first = Math.min(...stages.map(s => s.stage_order));
  const edges = []; const unproven = [];
  const used = new Map(); // feeder id -> { winner: n, loser: n }
  for (const m of ko) {
    if (order.get(m.stage_id) === first) continue;
    const mine = [];
    for (const team of [m.home_team_id, m.away_team_id]) {
      const feeder = ko.filter(x => x.id !== m.id && Date.parse(x.kickoff_at) < Date.parse(m.kickoff_at) && order.get(x.stage_id) < order.get(m.stage_id) && (x.home_team_id === team || x.away_team_id === team)).pop();
      if (!feeder || feeder.status !== 'finished' || !feeder.winner_team_id) { mine.push(null); continue; }
      mine.push({ from: feeder.id, to: m.id, team_id: team, via: feeder.winner_team_id === team ? 'winner' : 'loser' });
    }
    if (mine.some(e => !e)) { unproven.push({ match_id: m.id, reason: 'feeder not proven for both teams' }); continue; }
    edges.push(...mine);
    for (const e of mine) { const u = used.get(e.from) || { winner: 0, loser: 0 }; u[e.via] += 1; used.set(e.from, u); }
  }
  // A feeder can send on one winner and at most one loser; anything else is contradictory.
  const bad = [...used.entries()].filter(([, u]) => u.winner > 1 || u.loser > 1).map(([id]) => id);
  const clean = edges.filter(e => !bad.includes(e.from));
  const later = ko.filter(m => order.get(m.stage_id) !== first).length;
  return { edges: clean, proven: later > 0 && !unproven.length && !bad.length, later_matches: later, unproven, contradictory_feeders: bad };
}
