// Team identity from fixture structure, never from names.
// Subset variant: the provider has only part of the season (e.g. ESPN fixtures
// fetched so far). A provider team maps to canonical team T iff T is the only
// canonical team whose home AND away fixtures cover every provider fixture of
// that team (date +-1 day). Every provider team needs >= minAppearances fixtures,
// the mapping must be injective, and every provider fixture must reproduce a
// canonical fixture exactly. Anything less proves nothing.

export function proveTeamsByFixtureSubset(canonical, provider, { toleranceDays = 1, minAppearances = 3 } = {}) {
  const dayMs = 86400000;
  const near = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) <= toleranceDays * dayMs;
  const canonTeams = [...new Set(canonical.flatMap(f => [f.home, f.away]))];
  const provTeams = [...new Set(provider.flatMap(f => [f.home, f.away]))];
  const appearances = new Map(provTeams.map(t => [t, provider.filter(f => f.home === t || f.away === t).length]));
  const candidates = new Map(provTeams.map(t => [t, new Set(canonTeams)]));
  for (const pf of provider) {
    const sameDay = canonical.filter(cf => near(cf.date, pf.date));
    const homes = new Set(sameDay.map(cf => cf.home)); const aways = new Set(sameDay.map(cf => cf.away));
    for (const c of [...candidates.get(pf.home)]) if (!homes.has(c)) candidates.get(pf.home).delete(c);
    for (const c of [...candidates.get(pf.away)]) if (!aways.has(c)) candidates.get(pf.away).delete(c);
  }
  const mapping = new Map(); const unresolved = []; const thin = [];
  for (const [t, set] of candidates) {
    if (appearances.get(t) < minAppearances) { thin.push(t); continue; }
    if (set.size === 1) mapping.set(t, [...set][0]); else unresolved.push({ provider_team: t, candidates: [...set] });
  }
  const targets = [...mapping.values()];
  const collisions = targets.filter((v, i) => targets.indexOf(v) !== i);
  const canonKeys = new Set(canonical.map(f => `${f.home}|${f.away}`));
  const covered = provider.filter(pf => mapping.has(pf.home) && mapping.has(pf.away));
  const unmatched = covered.filter(pf => !canonKeys.has(`${mapping.get(pf.home)}|${mapping.get(pf.away)}`));
  // A team whose candidate set was emptied is a contradiction between the sources:
  // the whole proof is void, not just that team.
  const contradictions = provTeams.filter(t => candidates.get(t).size === 0);
  const valid = collisions.length === 0 && unmatched.length === 0 && contradictions.length === 0;
  // Per-team proof: a team is proven when it is mapped and the global checks pass.
  return { valid, mapping: valid ? mapping : new Map(), unresolved, thin, collisions, contradictions, unmatched: unmatched.length, provider_fixtures: provider.length };
}
