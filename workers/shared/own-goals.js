// Which side an own goal counts for. Providers disagree on which team an own-goal
// event is tagged with, verified against final scores on 2026-09-28:
//   espn              the BENEFITING team (52/52 events; scores reconcile 49/49)
//   wyscout_figshare  the player's own team (22/22 matches)
//   openligadb        the player's own team (337/338 matches)
export const OWN_GOAL_TAGS_BENEFICIARY = new Set(['espn']);

export function ownGoalBeneficiary(e, homeTeamId, awayTeamId) {
  if (OWN_GOAL_TAGS_BENEFICIARY.has(e.source_family)) return e.team_id;
  return e.team_id === homeTeamId ? awayTeamId : homeTeamId;
}

// The team of the player who put the ball into their own net.
export function ownGoalPlayerTeam(e, homeTeamId, awayTeamId) {
  const b = ownGoalBeneficiary(e, homeTeamId, awayTeamId);
  return b === homeTeamId ? awayTeamId : homeTeamId;
}
