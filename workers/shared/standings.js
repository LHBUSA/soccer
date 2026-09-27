// Shared standings verification (soccer-api tables and soccer-news packets use the
// SAME rule): a provider's published group standings are trusted for membership,
// official rank and zone notes only when every team's P W D L GF GA PTS equals the
// table PropBetEdge computes from its own canonical results.
export const COUNT_KEYS = [['played', 'played'], ['won', 'won'], ['drawn', 'drawn'], ['lost', 'lost'], ['goals_for', 'gf'], ['goals_against', 'ga'], ['points', 'points']];

export function verifyGroupStandings(source, computedById) {
  const mismatches = [];
  for (const s of source) {
    const c = computedById.get(s.team_id) || { played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, points: 0 };
    const pointsWant = s.points === null ? null : s.points + (s.deductions || 0); // deductions are applied by the provider, not in results
    for (const [sk, ck] of COUNT_KEYS) {
      const want = sk === 'points' ? pointsWant : s[sk];
      if (want === null || want === undefined || Number(want) !== Number(c[ck])) mismatches.push({ team_id: s.team_id, field: sk, source: want ?? null, computed: c[ck] });
    }
  }
  const ranks = source.map(s => s.rank);
  if (ranks.some(r => !Number.isInteger(r)) || new Set(ranks).size !== ranks.length) mismatches.push({ field: 'rank', source: 'missing or duplicate provider ranks' });
  return { verified: source.length > 0 && mismatches.length === 0, mismatches };
}
