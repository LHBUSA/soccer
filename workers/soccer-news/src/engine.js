// News engine core: load a competition's current season from the canonical graph
// (select primitives only, so it runs on PostgREST in the Worker and PGlite in
// tests), DETECT story candidates with the competition's profile, and build the
// evidence PACKET for each. A packet is the only input a composer may use.
import { computeTable, distanceToGoal } from './packet.js';
import { profileFor, PROFILES_VERSION } from './profiles.js';
import { displayMinute } from '../../shared/clock.js';
import { payloadHash, uuidv5 } from '../../shared/ids.js';
import { chunkArr } from '../../soccer-ingest/src/store.js';
import { verifyGroupStandings } from '../../shared/standings.js';
import { ownGoalBeneficiary } from '../../shared/own-goals.js';
import { loadSeasonData, teamDna } from '../../soccer-api/src/dna.js';
import { depthFromRows, loadDepthRows, packetV3 } from './depth.js';

export const ENGINE_VERSION = 'soccer-news-engine/2.0.0';
export const PACKET_V2 = 'soccer-packet/2.0.0';
const FAMILY = ['wyscout_figshare', 'espn', 'openligadb'];
const ATTRIBUTION = {
  espn: 'Structured facts: ESPN (secondary source).',
  openligadb: 'Fixtures and results: OpenLigaDB (Open Database License).',
  wyscout_figshare: 'Event data: Pappalardo et al. (2019), Wyscout public dataset, CC BY 4.0.',
};

const res = (m, tid) => { const gf = m.home_team_id === tid ? m.home_score : m.away_score; const ga = m.home_team_id === tid ? m.away_score : m.home_score; return gf > ga ? 'W' : gf < ga ? 'L' : 'D'; };
const byKick = (a, b) => Date.parse(a.kickoff_at) - Date.parse(b.kickoff_at);
const posOf = (t, id) => { const i = t.findIndex(r => r.team_id === id); return i < 0 ? null : i + 1; };
const row = (t, id) => { const i = t.findIndex(r => r.team_id === id); return i < 0 ? null : { position: i + 1, played: t[i].played, won: t[i].won, drawn: t[i].drawn, lost: t[i].lost, points: t[i].points, goal_difference: t[i].gd, goals_for: t[i].gf }; };

export async function loadSeason(store, slug) {
  const [comp] = await store.select('soccer_competitions', { columns: ['id', 'slug', 'name'], eq: { slug }, limit: 1 });
  if (!comp) return null;
  const seasons = (await store.select('soccer_seasons', { columns: ['id', 'label'], eq: { competition_id: comp.id } })).sort((a, b) => (a.label < b.label ? 1 : -1));
  const season = seasons[0]; if (!season) return null;
  const leagueStages = new Set((await store.select('soccer_stages', { columns: ['id'], eq: { season_id: season.id, stage_type: 'league' } })).map(s => s.id));
  const matches = await store.select('soccer_matches', { columns: ['id', 'kickoff_at', 'matchday', 'stage_id', 'status', 'home_team_id', 'away_team_id', 'home_score', 'away_score', 'home_score_ht', 'away_score_ht', 'venue_id', 'result_provider', 'updated_at'], eq: { season_id: season.id }, order: 'id.asc' });
  for (const m of matches) m.kickoff_at = new Date(m.kickoff_at).toISOString(); // PGlite returns Date, PostgREST strings
  const teamIds = [...new Set(matches.flatMap(m => [m.home_team_id, m.away_team_id]))];
  const teams = new Map();
  for (const part of chunkArr(teamIds, 150)) for (const t of await store.select('soccer_teams', { columns: ['id', 'slug', 'name', 'short_name'], in: { id: part } })) teams.set(t.id, t);
  const finished = matches.filter(m => m.status === 'finished' && m.home_score !== null && m.away_score !== null).sort(byKick);
  return { comp, season, leagueStages, matches, finished, teams };
}

// Goal events for a set of matches: one event family per match (richest first).
export async function goalsFor(store, matchIds) {
  const evs = [];
  const cols = ['match_id', 'sequence', 'period', 'minute', 'team_id', 'player_id', 'is_goal', 'is_own_goal', 'set_piece', 'source_family'];
  for (const part of chunkArr([...new Set(matchIds)], 100)) {
    for (const flag of ['is_goal', 'is_own_goal']) evs.push(...await store.select('soccer_match_events', { columns: cols, in: { match_id: part }, eq: { [flag]: true }, order: 'match_id.asc,sequence.asc' }));
  }
  const fam = new Map();
  for (const e of evs) { const f = fam.get(e.match_id); if (f === undefined || FAMILY.indexOf(e.source_family) < FAMILY.indexOf(f)) fam.set(e.match_id, e.source_family); }
  const out = new Map();
  for (const e of evs.filter(x => fam.get(x.match_id) === x.source_family)) out.set(e.match_id, [...(out.get(e.match_id) || []), e]);
  return out;
}

async function peopleById(store, ids) {
  const out = new Map();
  for (const part of chunkArr([...new Set(ids.filter(Boolean))], 150)) for (const p of await store.select('soccer_players', { columns: ['id', 'slug', 'display_name'], in: { id: part } })) out.set(p.id, { id: p.id, name: p.display_name, slug: p.slug });
  return out;
}

const tableUntil = (S, profile, until, excludeId = null) => computeTable(S.finished.filter(m => S.leagueStages.has(m.stage_id) && Date.parse(m.kickoff_at) <= Date.parse(until) && m.id !== excludeId), { tiebreak: profile.tiebreak || 'standard' });

// ---------- DETECTION ----------
// window: only matches finished within [now - windowDays, now] can create stories.
export async function detect(store, S, { now = Date.now(), windowDays = 4, cfg = {} } = {}) {
  const since = now - windowDays * 86400e3;
  const recent = S.finished.filter(m => Date.parse(m.kickoff_at) >= since && Date.parse(m.kickoff_at) <= now - 2 * 3600e3);
  if (!recent.length) return [];
  const goals = await goalsFor(store, recent.map(m => m.id));
  const out = [];
  for (const m of recent) {
    const profile = profileFor(S.comp.slug, m.kickoff_at, cfg); if (!profile) continue;
    const a = assess(S, m, profile, goals.get(m.id) || []);
    if (a.material) out.push({ story_class: 'match_recap', key: `match_recap:${m.id}`, as_of: m.kickoff_at, match: m, profile, materiality: a });
  }
  // Team trends: a streak reaching a threshold with its latest match in the window.
  const TRENDS = [['winning_run', r => r === 'W', 4], ['unbeaten_run', r => r !== 'L', 7], ['losing_run', r => r === 'L', 4], ['winless_run', r => r !== 'W', 7]];
  for (const [tid] of S.teams) {
    const games = S.finished.filter(m => (m.home_team_id === tid || m.away_team_id === tid) && S.leagueStages.has(m.stage_id)).sort(byKick);
    const last = games[games.length - 1];
    if (!last || !recent.some(r => r.id === last.id)) continue;
    const profile = profileFor(S.comp.slug, last.kickoff_at, cfg); if (!profile?.table) continue;
    for (const [kind, pred, min] of TRENDS) {
      let n = 0; for (let i = games.length - 1; i >= 0 && pred(res(games[i], tid)); i--) n += 1;
      if (kind === 'unbeaten_run' && games.slice(-n).every(g => res(g, tid) === 'W')) continue; // a pure winning run is reported as such
      if (kind === 'winless_run' && games.slice(-n).every(g => res(g, tid) === 'L')) continue;
      if (n >= min) out.push({ story_class: 'team_trend', key: `team_trend:${tid}:${kind}:${n}:${last.id}`, as_of: last.kickoff_at, team_id: tid, kind, run: games.slice(-n), profile, materiality: { score: n >= min + 2 ? 1.4 : 1.0, angles: [{ key: kind, weight: 1, detail: { run: n } }] } });
    }
  }
  // Player form: scored in >= 3 consecutive appearances (sourced lineups), latest in window.
  const recentIds = new Set(recent.map(m => m.id));
  const lineups = [];
  for (const part of chunkArr(S.finished.map(m => m.id), 100)) lineups.push(...await store.select('soccer_lineups', { columns: ['id', 'match_id', 'team_id'], in: { match_id: part } }));
  if (lineups.length) {
    const lps = [];
    for (const part of chunkArr(lineups.map(l => l.id), 100)) lps.push(...await store.select('soccer_lineup_players', { columns: ['lineup_id', 'player_id', 'is_starter'], in: { lineup_id: part }, order: 'lineup_id.asc,player_id.asc' }));
    const subs = [];
    for (const part of chunkArr(lineups.map(l => l.match_id), 100)) subs.push(...await store.select('soccer_substitutions', { columns: ['match_id', 'player_in_id'], in: { match_id: part } }));
    const cameOn = new Set(subs.map(s => `${s.match_id}|${s.player_in_id}`));
    const lu = new Map(lineups.map(l => [l.id, l]));
    const apps = new Map();
    for (const x of lps) {
      const l = lu.get(x.lineup_id);
      if (!(x.is_starter || cameOn.has(`${l.match_id}|${x.player_id}`))) continue;
      apps.set(x.player_id, [...(apps.get(x.player_id) || []), { match_id: l.match_id, team_id: l.team_id, started: x.is_starter }]);
    }
    const allGoals = await goalsFor(store, lineups.map(l => l.match_id));
    const kick = new Map(S.finished.map(m => [m.id, m]));
    for (const [pid, list] of apps) {
      const seq = list.filter(x => kick.has(x.match_id)).sort((a, b) => byKick(kick.get(a.match_id), kick.get(b.match_id)));
      const lastApp = seq[seq.length - 1];
      if (!lastApp || !recentIds.has(lastApp.match_id)) continue;
      const g = seq.map(x => (allGoals.get(x.match_id) || []).filter(e => e.is_goal && e.player_id === pid).length);
      let n = 0; for (let i = g.length - 1; i >= 0 && g[i] > 0; i--) n += 1;
      if (n >= 3) {
        const profile = profileFor(S.comp.slug, kick.get(lastApp.match_id).kickoff_at, cfg);
        out.push({ story_class: 'player_form', key: `player_form:${pid}:${n}:${lastApp.match_id}`, as_of: kick.get(lastApp.match_id).kickoff_at, player_id: pid, apps: seq.slice(-Math.max(n, 3)).map((x, i, arr) => ({ ...x, goals: g[g.length - arr.length + i] })), streak: n, profile, materiality: { score: 1.0 + (n - 3) * 0.2, angles: [{ key: 'scoring_run', weight: 1, detail: { matches: n } }] } });
      }
    }
  }
  // Table race: once per ISO week with >= 6 league results in the window and no
  // league match in the last 12 hours (the round is settled). Table profiles only.
  const lastLeague = recent.filter(m => S.leagueStages.has(m.stage_id));
  const profile = profileFor(S.comp.slug, new Date(now).toISOString(), cfg);
  if (profile?.table && lastLeague.length >= 6 && !S.matches.some(m => m.status !== 'finished' && S.leagueStages.has(m.stage_id) && Math.abs(Date.parse(m.kickoff_at) - now) < 12 * 3600e3)) {
    const latest = lastLeague[lastLeague.length - 1];
    const week = isoWeek(new Date(latest.kickoff_at));
    out.push({ story_class: 'competition_intelligence', key: `table_race:${S.comp.id}:${week}`, as_of: latest.kickoff_at, profile, round: lastLeague, materiality: { score: 1.0, angles: [{ key: 'table_race', weight: 1, detail: { week } }] } });
  }
  return out;
}

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - y) / 86400e3 + 1) / 7)).padStart(2, '0')}`;
}

// Recap materiality under a profile (pure over loaded data).
export function assess(S, m, profile, goals) {
  const angles = [];
  const add = (key, detail, weight = profile.angles[key]) => { if (weight) angles.push({ key, weight, detail }); };
  const H = m.home_team_id; const A = m.away_team_id;
  const winner = m.home_score > m.away_score ? H : m.away_score > m.home_score ? A : null;
  const loser = winner === H ? A : winner === A ? H : null;
  const league = S.leagueStages.has(m.stage_id);
  if (profile.table && league) {
    const tb = tableUntil(S, profile, m.kickoff_at, m.id); const ta = tableUntil(S, profile, m.kickoff_at);
    // "Still true" rule: a table angle is only reported if the latest table agrees
    // (a team that went top at 15:30 and was overtaken at 17:30 is not "top").
    const tNow = computeTable(S.finished.filter(x => S.leagueStages.has(x.stage_id)), { tiebreak: profile.tiebreak || 'standard' });
    const played = ta.find(r => r.team_id === H)?.played || 0;
    if (tb.length && ta.length && tb[0].team_id !== ta[0].team_id && [H, A].includes(ta[0].team_id) && tNow[0]?.team_id === ta[0].team_id && played >= 3) add(profile.key === 'mls' ? 'overall_leader_change' : 'leader_change', { new_leader: ta[0].team_id, previous: tb[0].team_id });
    if (profile.key !== 'mls' && played >= 10 && tb.length > 1) {
      const gapB = tb[0].points - tb[1].points; const gapA = ta[0].points - ta[1].points;
      if ([tb[0].team_id, tb[1].team_id, ta[0].team_id, ta[1].team_id].some(t => t === H || t === A) && Math.abs(gapA - gapB) >= 3) add('title_race_swing', { gap_before: gapB, gap_after: gapA });
    }
    if (profile.zones && played >= 5) {
      const n = ta.length;
      for (const t of [H, A]) {
        const pb = posOf(tb, t); const pa = posOf(ta, t); if (pb === null || pa === null) continue;
        const pn = posOf(tNow, t);
        if ((pb <= profile.zones.top) !== (pa <= profile.zones.top) && (pn <= profile.zones.top) === (pa <= profile.zones.top)) add('top4_entry_exit', { team_id: t, from: pb, to: pa });
        if ((pb > n - profile.zones.bottom) !== (pa > n - profile.zones.bottom) && (pn > n - profile.zones.bottom) === (pa > n - profile.zones.bottom)) add('relegation_zone_move', { team_id: t, from: pb, to: pa });
      }
    }
    if (winner && played > 5) { const pw = posOf(tb, winner); const pl = posOf(tb, loser); if (pw && pl && pw - pl >= profile.upset_gap) add('upset', { winner_position_before: pw, loser_position_before: pl }); }
    if (winner) {
      const prior = tid => S.finished.filter(x => x.id !== m.id && S.leagueStages.has(x.stage_id) && Date.parse(x.kickoff_at) < Date.parse(m.kickoff_at) && (x.home_team_id === tid || x.away_team_id === tid)).sort((a, b) => byKick(b, a));
      let w = 1; for (const x of prior(winner)) { if (res(x, winner) === 'W') w += 1; else break; }
      if (w >= 5) add('winning_streak', { team_id: winner, run: w });
      let u = 0; for (const x of prior(loser)) { if (res(x, loser) !== 'L') u += 1; else break; }
      if (u >= 8) add('unbeaten_run_ended', { team_id: loser, run: u });
    }
  }
  if (winner && m.home_score_ht !== null && m.away_score_ht !== null) {
    const wHt = winner === H ? m.home_score_ht - m.away_score_ht : m.away_score_ht - m.home_score_ht;
    if (wHt < 0) add('comeback_from_ht', { half_time: `${m.home_score_ht}-${m.away_score_ht}` });
  }
  const byPlayer = new Map();
  for (const g of goals) if (g.is_goal && g.player_id) byPlayer.set(g.player_id, (byPlayer.get(g.player_id) || 0) + 1);
  for (const [pid, n] of byPlayer) if (n >= 2) add('multi_goal_scorer', { player_id: pid, goals: n }, n >= 3 ? 1.2 : profile.angles.multi_goal_scorer);
  if (m.home_score + m.away_score >= 6) add('high_scoring', { goals: m.home_score + m.away_score });
  if (Math.abs(m.home_score - m.away_score) >= 4) add('heavy_margin', { margin: Math.abs(m.home_score - m.away_score) });
  const score = Math.round(angles.reduce((n, a) => n + a.weight, 0) * 100) / 100;
  return { profile: profile.key, profiles_version: PROFILES_VERSION, material: score >= 1.0, score, angles };
}

// ---------- PACKETS ----------
const teamRef = (S, id) => { const t = S.teams.get(id); return t ? { id: t.id, name: t.name, slug: t.slug } : { id, name: null, slug: null }; };

function freeze(packet) {
  packet.event.event_id = uuidv5(`news_event:${packet.event.key}`);
  packet.hash = payloadHash(packet);
  return packet;
}

export async function buildPacket(store, S, cand) {
  const base = { version: PACKET_V2, engine: ENGINE_VERSION, event: { kind: cand.story_class, key: cand.key, as_of: cand.as_of, profile: cand.profile.key, ...(cand.corrects ? { corrects: cand.corrects } : {}) }, competition: { id: S.comp.id, name: S.comp.name, slug: S.comp.slug, season: S.season.label, ...(cand.profile.team_kind === 'national' ? { team_kind: 'national', format: NATIONAL_FORMAT[S.comp.slug] || 'National teams; no overall table.' } : {}) }, materiality: cand.materiality };
  if (cand.story_class === 'match_recap') {
    const v2 = { ...base, ...(await recapBody(store, S, cand)) };
    return freeze(packetV3(v2, depthFromRows(v2, await loadDepthRows(store, S, v2)))); // v3: v2 evidence + depth
  }
  if (cand.story_class === 'team_trend') return freeze({ ...base, ...(await trendBody(store, S, cand)) });
  if (cand.story_class === 'player_form') return freeze({ ...base, ...(await formBody(store, S, cand)) });
  if (cand.story_class === 'competition_intelligence') return freeze({ ...base, ...raceBody(S, cand) });
  throw new Error(`unknown story class ${cand.story_class}`);
}

// Format facts the desk may state for national-team competitions (UEFA's published format; the packet
// carries them so the desk never calls a nation a club or invents a domestic-league frame).
const NATIONAL_FORMAT = {
  'uefa-nations-league': 'National teams, not clubs. League phase in Leagues A, B, C and D; groups A1-A4, B1-B4, C1-C4 (four teams) and D1-D2 (three teams). There is no overall table: position is only ever a group position.',
};

// Verified group context (MLS conference / UCL league phase) for the given teams, as of
// NOW (packet build time): only when the provider's standings verify against our own
// canonical results (same rule as the API). Unverified -> no context, no claims.
export async function groupContext(store, S, teamIds) {
  const groups = await store.select('soccer_season_groups', { columns: ['id', 'group_key', 'name', 'group_type'], eq: { season_id: S.season.id } });
  if (!groups.length) return {};
  // Tournament groups carry their tier (Nations League "League A"); read only where such groups exist.
  const tiers = groups.some(g => g.group_type === 'group') ? new Map((await store.select('soccer_season_groups', { columns: ['id', 'parent_name'], eq: { season_id: S.season.id, group_type: 'group' } })).map(g => [g.id, g.parent_name])) : new Map();
  const byId = new Map(computeTable(S.finished.filter(m => S.leagueStages.has(m.stage_id))).map(r => [r.team_id, r]));
  const out = {};
  for (const g of groups) {
    const src = await store.select('soccer_source_standings', { columns: ['team_id', 'rank', 'played', 'won', 'drawn', 'lost', 'goals_for', 'goals_against', 'points', 'deductions', 'note', 'observed_at'], eq: { group_id: g.id, provider: 'espn' } });
    if (!verifyGroupStandings(src, byId).verified) continue;
    for (const tid of teamIds) {
      const r = src.find(x => x.team_id === tid);
      if (r) out[tid] = { group: g.name, group_type: g.group_type, ...(tiers.get(g.id) ? { tier: tiers.get(g.id) } : {}), position: r.rank, teams_in_group: src.length, points: r.points, played: r.played, zone: r.note || null, verified: true, observed_at: r.observed_at };
    }
  }
  return out;
}

// The team's next scheduled canonical match after this one (never a played match).
export function nextFixture(S, tid, afterIso) {
  const n = S.matches.filter(x => x.status === 'scheduled' && (x.home_team_id === tid || x.away_team_id === tid) && Date.parse(x.kickoff_at) > Date.parse(afterIso)).sort(byKick)[0];
  if (!n) return null;
  const home = n.home_team_id === tid;
  return { match_id: n.id, date: new Date(n.kickoff_at).toISOString().slice(0, 10), opponent: teamRef(S, home ? n.away_team_id : n.home_team_id), venue: home ? 'home' : 'away' };
}

async function recapBody(store, S, cand) {
  const m = cand.match;
  const [venue] = m.venue_id ? await store.select('soccer_venues', { columns: ['name'], eq: { id: m.venue_id }, limit: 1 }) : [];
  const goals = (await goalsFor(store, [m.id])).get(m.id) || [];
  const shots = await store.select('soccer_match_events', { columns: ['sequence', 'team_id', 'player_id', 'outcome', 'is_goal', 'x_m', 'y_m', 'source_family'], eq: { match_id: m.id, event_type: 'shot' } });
  const fam = FAMILY.find(f => shots.some(s => s.source_family === f));
  const famShots = shots.filter(s => s.source_family === fam);
  const located = famShots.filter(s => s.x_m !== null);
  const assistEv = fam === 'espn' ? await store.select('soccer_match_events', { columns: ['sequence', 'team_id', 'player_id'], eq: { match_id: m.id, source_family: 'espn', subtype: 'espn_assist' } }) : [];
  const stats = await store.select('soccer_team_match_stats', { columns: ['team_id', 'stat_key', 'value', 'basis', 'provider'], eq: { match_id: m.id } });
  const basis = stats.some(s => s.basis === 'source') ? 'source' : stats.length ? 'derived' : null;
  const side = tid => (tid === m.home_team_id ? 'home' : 'away');
  const st = { home: {}, away: {} };
  for (const s of stats.filter(x => x.basis === basis)) if (['shots', 'shots_on_target', 'corners', 'fouls_committed', 'saves', 'possession_pct'].includes(s.stat_key)) st[side(s.team_id)][s.stat_key] = Number(s.value);
  const people = await peopleById(store, [...goals.map(g => g.player_id), ...famShots.map(s => s.player_id), ...assistEv.map(x => x.player_id), ...cand.materiality.angles.map(a => a.detail?.player_id)]);
  let h = 0; let a = 0;
  const goalList = goals.map(g => {
    const benefit = side(g.is_own_goal ? ownGoalBeneficiary(g, m.home_team_id, m.away_team_id) : g.team_id);
    if (benefit === 'home') h += 1; else a += 1;
    const assist = !g.is_own_goal ? assistEv.filter(x => x.team_id === g.team_id && Math.abs(x.sequence - g.sequence) <= 4).sort((x, y) => Math.abs(g.sequence - x.sequence) - Math.abs(g.sequence - y.sequence))[0] : null;
    return { minute: g.minute, display_minute: displayMinute(g.period, g.minute), team: benefit, scorer: people.get(g.player_id) || null, assist: assist ? people.get(assist.player_id) || null : null, own_goal: !!g.is_own_goal, penalty: g.set_piece === 'penalty', running_score: `${h}-${a}` };
  });
  // Decisive players: goals + assists, then shots on target, then shots (a documented ordering rule, not a rating).
  const perf = new Map();
  const P = (pid, tid) => { if (!perf.has(pid)) perf.set(pid, { player: people.get(pid), team: side(tid), goals: 0, assists: 0, shots: 0, shots_on_target: 0 }); return perf.get(pid); };
  for (const s of famShots) if (s.player_id && people.has(s.player_id)) { const r = P(s.player_id, s.team_id); r.shots += 1; if (s.outcome === 'goal' || s.outcome === 'on_target') r.shots_on_target += 1; }
  for (const g of goals) if (g.player_id && people.has(g.player_id) && !g.is_own_goal) P(g.player_id, g.team_id).goals += 1;
  for (const g of goalList) if (g.assist) { const pid = g.assist.id; const tid = g.team === 'home' ? m.home_team_id : m.away_team_id; P(pid, tid).assists += 1; }
  const decisive = [...perf.values()].filter(r => r.player && (r.goals || r.assists)).sort((x, y) => (y.goals + y.assists) - (x.goals + x.assists) || y.shots_on_target - x.shots_on_target || y.shots - x.shots || (x.player.name < y.player.name ? -1 : 1)).slice(0, 4);
  const profile = cand.profile;
  const league = S.leagueStages.has(m.stage_id) && profile.table;
  const tb = league ? tableUntil(S, profile, m.kickoff_at, m.id) : null; const ta = league ? tableUntil(S, profile, m.kickoff_at) : null;
  const form = tid => S.finished.filter(x => x.id !== m.id && Date.parse(x.kickoff_at) < Date.parse(m.kickoff_at) && S.leagueStages.has(x.stage_id) && (x.home_team_id === tid || x.away_team_id === tid)).sort((x, y) => byKick(y, x)).slice(0, 5).map(x => res(x, tid));
  const angles = cand.materiality.angles.map(x => ({ ...x, detail: { ...x.detail, ...(x.detail.team_id ? { team: teamRef(S, x.detail.team_id) } : {}), ...(x.detail.new_leader ? { new_leader_team: teamRef(S, x.detail.new_leader) } : {}), ...(x.detail.player_id ? { player: people.get(x.detail.player_id) || null } : {}) } }));
  const dist = k => { const d = located.filter(s => side(s.team_id) === k).map(s => distanceToGoal(s.x_m, s.y_m)).filter(v => v !== null); return d.length ? Math.round((d.reduce((p, q) => p + q, 0) / d.length) * 10) / 10 : null; };
  const groups = await groupContext(store, S, [m.home_team_id, m.away_team_id]);
  const team = tid => ({ ...teamRef(S, tid), table_before: tb && row(tb, tid), table_after: ta && row(ta, tid), form_before: league ? form(tid) : [], form_before_count: league ? form(tid).length : 0, group: groups[tid] || null, next: nextFixture(S, tid, m.kickoff_at) });
  return {
    match: { id: m.id, kickoff_utc: new Date(m.kickoff_at).toISOString(), venue: venue?.name || null, league_stage: S.leagueStages.has(m.stage_id), status: m.status,
      score: { home: m.home_score, away: m.away_score, home_ht: m.home_score_ht, away_ht: m.away_score_ht, final: `${m.home_score}-${m.away_score}` },
      winner: m.home_score > m.away_score ? 'home' : m.away_score > m.home_score ? 'away' : 'draw', margin: Math.abs(m.home_score - m.away_score) },
    teams: { home: team(m.home_team_id), away: team(m.away_team_id) },
    teams_in_table: ta ? ta.length : null,
    goals: goalList, angles, decisive,
    stats: basis ? { basis, provider: stats.find(x => x.basis === basis)?.provider || null, ...st } : null,
    shots_located: fam ? { home: located.filter(s => side(s.team_id) === 'home').length, away: located.filter(s => side(s.team_id) === 'away').length, avg_distance_m: { home: dist('home'), away: dist('away') }, source: fam } : null,
    unavailable: ['quotes (none sourced)', 'injuries (no legitimate source ingested)', 'odds (not part of this product)', 'xG (PBE xG not validated)'],
    provenance: { attributions: [...new Set([m.result_provider, fam, basis === 'source' ? stats.find(x => x.basis === 'source')?.provider : null, Object.keys(groups).length ? 'espn' : null].filter(Boolean).map(p => ATTRIBUTION[p]).filter(Boolean))] },
  };
}

async function trendBody(store, S, cand) {
  const t = teamRef(S, cand.team_id);
  const table = tableUntil(S, cand.profile, cand.as_of);
  const games = cand.run.map(g => {
    const home = g.home_team_id === cand.team_id;
    return { match_id: g.id, date: g.kickoff_at.slice(0, 10), opponent: teamRef(S, home ? g.away_team_id : g.home_team_id), venue: home ? 'home' : 'away', goals_for: home ? g.home_score : g.away_score, goals_against: home ? g.away_score : g.home_score, result: res(g, cand.team_id) };
  });
  // Team DNA (time-safe: matches before the day after the run's last match) — only the
  // metrics a story may cite, with their percentile among the competition-season's teams.
  let dna = null;
  try {
    const asOf = new Date(Date.parse(cand.as_of) + 86400e3).toISOString().slice(0, 10) + 'T00:00:00Z';
    const all = teamDna(await loadSeasonData(store, S.season.id, asOf)); const me = all.get(cand.team_id);
    if (me) dna = { as_of: asOf, teams_compared: all.size, matches: me.matches, goals_for_per_match: me.goals_for_per_match, goals_against_per_match: me.goals_against_per_match, clean_sheet_pct: me.clean_sheet_rate === null ? null : Math.round(me.clean_sheet_rate * 100), percentiles: { goals_for_per_match: me.percentiles.goals_for_per_match, goals_against_per_match: me.percentiles.goals_against_per_match, clean_sheet_rate: me.percentiles.clean_sheet_rate } };
  } catch { dna = null; }
  return {
    team: { ...t, table_now: row(table, cand.team_id), next: nextFixture(S, cand.team_id, cand.as_of) }, teams_in_table: table.length, dna,
    trend: { kind: cand.kind, matches: games.length, goals_for: games.reduce((n, g) => n + g.goals_for, 0), goals_against: games.reduce((n, g) => n + g.goals_against, 0), wins: games.filter(g => g.result === 'W').length, draws: games.filter(g => g.result === 'D').length, losses: games.filter(g => g.result === 'L').length, games },
    unavailable: ['quotes (none sourced)', 'injuries (no legitimate source ingested)', 'odds (not part of this product)'],
    provenance: { attributions: [...new Set(cand.run.map(g => ATTRIBUTION[g.result_provider]).filter(Boolean))] },
  };
}

async function formBody(store, S, cand) {
  const people = await peopleById(store, [cand.player_id]);
  const kick = new Map(S.finished.map(m => [m.id, m]));
  const apps = cand.apps.map(x => {
    const m = kick.get(x.match_id); const home = m.home_team_id === x.team_id;
    return { match_id: m.id, date: m.kickoff_at.slice(0, 10), team: teamRef(S, x.team_id), opponent: teamRef(S, home ? m.away_team_id : m.home_team_id), started: x.started, goals: x.goals, score: home ? `${m.home_score}-${m.away_score}` : `${m.away_score}-${m.home_score}` };
  });
  return {
    player: people.get(cand.player_id), team: apps[apps.length - 1].team,
    form: { consecutive_scoring_appearances: cand.streak, goals_in_run: apps.slice(-cand.streak).reduce((n, a) => n + a.goals, 0), appearances: apps },
    unavailable: ['quotes (none sourced)', 'injuries (no legitimate source ingested)', 'odds (not part of this product)', 'minutes (not stated per match by the source)'],
    provenance: { attributions: [...new Set(apps.map(a => ATTRIBUTION[kick.get(a.match_id).result_provider]).filter(Boolean)), ATTRIBUTION.espn].filter((x, i, arr) => arr.indexOf(x) === i) },
  };
}

function raceBody(S, cand) {
  const table = tableUntil(S, cand.profile, cand.as_of);
  const rows = table.map((r, i) => ({ position: i + 1, team: teamRef(S, r.team_id), played: r.played, won: r.won, points: r.points, goal_difference: r.gd }));
  const results = cand.round.map(m => ({ match_id: m.id, date: m.kickoff_at.slice(0, 10), home: teamRef(S, m.home_team_id), away: teamRef(S, m.away_team_id), score: `${m.home_score}-${m.away_score}` }));
  return {
    table: { tiebreak: cand.profile.tiebreak, teams: rows.length, top: rows.slice(0, 5), bottom: cand.profile.zones ? rows.slice(-cand.profile.zones.bottom) : [], leader_gap: rows.length > 1 ? rows[0].points - rows[1].points : null },
    round: { results_counted: results.length, results },
    unavailable: ['head-to-head and deductions (not applied)', ...(cand.profile.key === 'mls' ? ['conference standings (not stored)'] : [])],
    provenance: { attributions: [...new Set(cand.round.map(m => ATTRIBUTION[m.result_provider]).filter(Boolean))] },
  };
}
