// Pure classification for a REVIEWED season format manifest (data/history-review/<comp>-<season>.json). Shared by
// scripts/history/apply-format-review.mjs and tests/format-review.test.js. Never mutates its inputs.
// matches: [{ id, espn_event, kickoff_at, status, home, away, home_score, away_score, provider_stage }] with team SLUGS;
// provider_stage is the provider's own classification (ESPN season type), kept as source evidence and never changed.
//   playoff  = exactly one canonical match whose (local date, unordered pairing, per-team goals) equals a reviewed
//              fixture. Local date = the UTC kickoff date or the day before (US evening kick-offs are next-day UTC).
//   excluded = cancelled / postponed / abandoned listings (never counted)
//   regular  = every other finished canonical match; must reconcile club by club to the reviewed standings.
const VOID = new Set(['cancelled', 'postponed', 'abandoned']);
const KEYS = ['played', 'won', 'drawn', 'lost', 'goals_for', 'goals_against'];
export const localDates = iso => { const d = new Date(iso); return [d.toISOString().slice(0, 10), new Date(d.getTime() - 864e5).toISOString().slice(0, 10)]; };
const goalsOf = (m, slug) => (m.home === slug ? m.home_score : m.away === slug ? m.away_score : null);
const pairs = (m, a, b) => new Set([m.home, m.away]).has(a) && new Set([m.home, m.away]).has(b) && a !== b;

export function classifyFormatReview(manifest, matches) {
  const playoff = new Map(); const fixtures = [];
  for (const f of manifest.playoffs.fixtures) {
    const x = f.provider_date_exception;
    const cands = matches.filter(m => m.status === 'finished' && pairs(m, f.team_a, f.team_b) && goalsOf(m, f.team_a) === f.goals_a && goalsOf(m, f.team_b) === f.goals_b && !playoff.has(m.id)
      && (x ? m.espn_event === x.event_id && localDates(m.kickoff_at).includes(x.provider_local_date) : localDates(m.kickoff_at).includes(f.date_local)));
    const res = { stage: f.stage, date_local: f.date_local, fixture: `${f.team_a} ${f.goals_a}-${f.goals_b} ${f.team_b}`, stadium: f.stadium ?? null, candidates: cands.map(m => ({ match_id: m.id, espn_event: m.espn_event, kickoff_at: m.kickoff_at, home: m.home, provider_stage: m.provider_stage })) };
    if (cands.length === 1) { playoff.set(cands[0].id, { stage: f.stage, fixture: f }); res.outcome = x ? 'matched_reviewed_date_exception' : 'matched'; if (x) res.exception = x; }
    else {
      res.outcome = cands.length ? 'ambiguous' : 'no_match';
      // diagnostic only (never classifies): same pairing and goals on any date
      res.diagnostic_same_pairing_and_goals = matches.filter(m => pairs(m, f.team_a, f.team_b) && goalsOf(m, f.team_a) === f.goals_a && goalsOf(m, f.team_b) === f.goals_b).map(m => ({ match_id: m.id, espn_event: m.espn_event, kickoff_at: m.kickoff_at }));
    }
    fixtures.push(res);
  }
  const excluded = matches.filter(m => VOID.has(m.status));
  const regular = matches.filter(m => m.status === 'finished' && !playoff.has(m.id));
  const unresolved = matches.filter(m => m.status !== 'finished' && !VOID.has(m.status));
  const table = Object.fromEntries(Object.keys(manifest.regular_season.standings).map(sl => [sl, Object.fromEntries(KEYS.map(k => [k, 0]))]));
  const strangers = new Set();
  for (const m of regular) for (const [me, gf, ga] of [[m.home, m.home_score, m.away_score], [m.away, m.away_score, m.home_score]]) {
    const r = table[me]; if (!r) { strangers.add(me); continue; }
    r.played++; r.goals_for += gf; r.goals_against += ga; if (gf > ga) r.won++; else if (gf === ga) r.drawn++; else r.lost++;
  }
  const standings_differences = Object.entries(manifest.regular_season.standings).map(([sl, want]) => { const d = KEYS.filter(k => table[sl][k] !== want[k]); return d.length ? { team: sl, fields: Object.fromEntries(d.map(k => [k, { reviewed: want[k], canonical: table[sl][k] }])) } : null; }).filter(Boolean);
  // every match's canonical stage under the manifest, beside the provider's untouched classification
  const assignment = matches.map(m => ({ match_id: m.id, espn_event: m.espn_event, provider_stage: m.provider_stage, reviewed_stage: playoff.get(m.id)?.stage ?? (VOID.has(m.status) ? null : m.status === 'finished' ? manifest.regular_season.stage : null) }));
  // reclassified = the provider's KIND (league vs playoff) differs from the reviewed kind; moving a provider "Playoffs"
  // match into its reviewed playoff round is a refinement and is not listed here.
  const kind = st => (st === manifest.regular_season.stage ? 'league' : 'playoff');
  const reclassified = assignment.filter(a => a.reviewed_stage && a.provider_stage && kind(a.reviewed_stage) !== kind(a.provider_stage))
    .map(a => { const p = playoff.get(a.match_id); const m = matches.find(x => x.id === a.match_id); return { ...a, kickoff_at: m.kickoff_at, result: `${m.home} ${m.home_score}-${m.away_score} ${m.away}`, evidence: p ? { reviewed_fixture: `${p.fixture.team_a} ${p.fixture.goals_a}-${p.fixture.goals_b} ${p.fixture.team_b}`, date_local: p.fixture.date_local, stage: p.fixture.stage, stadium: p.fixture.stadium ?? null, sources: manifest.evidence.map(e => ({ source: e.source, sha256: e.sha256 })) } : { rule: 'not a reviewed playoff fixture; reconciles to the reviewed regular-season standings', sources: manifest.evidence.map(e => ({ source: e.source, sha256: e.sha256 })) } }; });
  const ready = playoff.size === manifest.playoffs.fixtures.length && fixtures.every(f => f.outcome.startsWith('matched')) && regular.length === manifest.regular_season.expected_matches && !unresolved.length && !standings_differences.length && !strangers.size;
  return { playoff, regular, excluded, unresolved, fixtures, standings_differences, strangers: [...strangers], assignment, reclassified, ready };
}

// league-stage structure after the manifest: games per club in the reviewed regular-season stage only
export function leagueGamesPerTeam(assignment, matches, leagueStage) {
  const byId = new Map(matches.map(m => [m.id, m])); const n = {};
  for (const a of assignment) if (a.reviewed_stage === leagueStage) { const m = byId.get(a.match_id); for (const t of [m.home, m.away]) n[t] = (n[t] || 0) + 1; }
  return n;
}

// EVIDENCE INTEGRITY: every evidence file must still hash to the manifest's sha256 and every reviewed quote (facts and
// per-fixture corroboration) must appear verbatim in its source file. Throws (fail closed) on any drift.
// read(path) -> file text (string); sha(text) -> hex sha256 of the raw bytes as read.
export function verifyManifestEvidence(manifest, read, sha) {
  const problems = [];
  for (const e of manifest.evidence || []) { let t = null; try { t = read(e.file); } catch { problems.push(`missing evidence ${e.file}`); continue; } if (sha(t) !== e.sha256) problems.push(`evidence changed: ${e.file}`); }
  const quotes = [...(manifest.facts?.quotes || []), ...(manifest.playoffs?.fixtures || []).flatMap(f => f.corroboration || [])];
  for (const q of quotes) { let t = ''; try { t = read(q.source).replace(/\r\n/g, '\n'); } catch { problems.push(`missing quote source ${q.source}`); continue; } if (!t.includes(q.quote)) problems.push(`quote not found in ${q.source}: ${q.quote.slice(0, 60)}`); }
  if (problems.length) throw new Error(`reviewed manifest evidence failed: ${problems.join('; ')}`);
  return { files: (manifest.evidence || []).length, quotes: quotes.length };
}
