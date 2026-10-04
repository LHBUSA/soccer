// Competition-specific materiality + language profiles. A profile decides which
// angles can exist (a table angle needs a verified league table) and which words
// are forbidden because the competition format makes them false.
//
//   domestic_european_league  EPL, Bundesliga: 18-20 team double round-robin with
//                             relegation and European places -> table angles allowed.
//   mls                       30 teams, two conferences (not stored), playoffs, NO
//                             promotion/relegation, NO European places. Only the overall
//                             standings (MLS tiebreak: wins before GD) may be described.
//   ucl_league_phase          UEFA Champions League 2024+ format: one 36-team league phase,
//                             8 matches each; 1-8 -> round of 16, 9-24 -> knockout play-off,
//                             25-36 out. PropBetEdge stores UCL matches without a verified
//                             league-phase table, so NO table / qualification angles and no
//                             "top four" language: match-level angles only.
//   knockout                  Two-legged or single knockout ties. Aggregate scores are not
//                             stored, so no "through / eliminated / aggregate" language.
//   nations_league            UEFA Nations League league phase: 54 NATIONAL teams in Leagues A-D,
//                             groups A1..D2 (4/4/4/3 teams); no overall table exists. Never
//                             domestic-league language (title race, relegation zone, top four) and
//                             never "club". Group lead / quarter-final / promotion / relegation /
//                             play-off wording only when the packet carries a VERIFIED group whose
//                             source zone note supports that exact concept (verified_claims).
//   nations_league_knockout   Quarter-finals, promotion/relegation play-offs and finals: knockout
//                             rules plus national-team language.

export const PROFILES_VERSION = 'soccer-news-profiles/1.2.0';

// National-team competitions: never domestic-league race language, never "club".
const NATIONAL_BANNED = [
  ['nl_domestic_race_language', /\b(title race|title rivals?|top[ -]four|relegation zone|drop zone|bottom three|survival (fight|battle|race)|top of the (table|league)|league table|league leaders?)\b/i],
  ['nl_club_language', /\bclubs?\b/i],
];

// European qualification is NOT stored for any domestic league (allocation moves with UEFA coefficients and cup
// winners), so "top four" stays a table position and never becomes a Champions League / European places claim.
const EUROPEAN_PLACES_BANNED = ['european_places_claim', /\b((champions|europa|conference) league (places?|spots?|qualification|football)|european (places?|spots?|qualification|football)|qualif\w* for (europe|the champions league|the europa league))\b/i];

const COMMON_MATCH_ANGLES = {
  comeback_from_ht: 1.0,   // winner trailed at half-time (needs a stored half-time score)
  multi_goal_scorer: 0.6,  // resolved player scored >= 2 (1.2 for >= 3)
  high_scoring: 0.6,       // >= 6 total goals
  heavy_margin: 0.6,       // margin >= 4
};

export const PROFILES = {
  domestic_european_league: {
    table: true, tiebreak: 'standard',
    angles: { leader_change: 1.2, title_race_swing: 1.0, top4_entry_exit: 0.8, relegation_zone_move: 0.8, upset: 1.0, winning_streak: 1.0, unbeaten_run_ended: 1.0, ...COMMON_MATCH_ANGLES },
    zones: { top: 4, bottom: 3 },
    upset_gap: 8,
    banned: [EUROPEAN_PLACES_BANNED],
  },
  // Bundesliga: 18th and 17th go down, 16th plays a relegation play-off. That rule is not stored, so "bottom three"
  // stays a table position and every relegation claim holds (same table angles as the domestic profile otherwise).
  domestic_league_relegation_playoff: {
    table: true, tiebreak: 'standard',
    angles: { leader_change: 1.2, title_race_swing: 1.0, top4_entry_exit: 0.8, relegation_zone_move: 0.8, upset: 1.0, winning_streak: 1.0, unbeaten_run_ended: 1.0, ...COMMON_MATCH_ANGLES },
    zones: { top: 4, bottom: 3 },
    upset_gap: 8,
    banned: [EUROPEAN_PLACES_BANNED, ['relegation_claim_unsupported', /\b(relegat\w*|drop zone|go(es|ing)? down)\b/i]],
  },
  mls: {
    table: true, tiebreak: 'mls',
    angles: { overall_leader_change: 1.2, upset: 1.0, winning_streak: 1.0, unbeaten_run_ended: 1.0, ...COMMON_MATCH_ANGLES },
    zones: null,
    upset_gap: 12,
    banned: [
      ['mls_relegation', /\b(relegat\w*|drop zone|bottom three|survival|go down)\b/i],
      ['mls_european_places', /\b(europe\w*|champions league|europa|top[ -]four|continental places?)\b/i],
      ['mls_conference_claim', /\b(eastern|western) conference\b/i], // conferences are not stored
      ['mls_playoff_claim', /\bplayoff (spot|place|line|position)s?\b/i],
    ],
  },
  // Women's domestic leagues (NWSL, WSL, Liga F, Première Ligue): a computed overall table only. Their qualification,
  // play-off and relegation rules are not stored, so no zone angles and no zone language (same discipline as MLS).
  womens_league: {
    table: true, tiebreak: 'standard',
    angles: { overall_leader_change: 1.2, upset: 1.0, winning_streak: 1.0, unbeaten_run_ended: 1.0, ...COMMON_MATCH_ANGLES },
    zones: null,
    upset_gap: 8,
    banned: [
      ['womens_zone_claim', /\b(relegat\w*|drop zone|bottom (two|three)|top[ -](three|four)|champions league (places?|spots?)|european places?|continental places?)\b/i],
      ['womens_playoff_claim', /\bplay-?off (spot|place|line|position)s?\b/i],
    ],
  },
  ucl_league_phase: {
    table: false, tiebreak: null,
    angles: { ...COMMON_MATCH_ANGLES },
    zones: null,
    banned: [
      ['ucl_top_four', /\btop[ -]four\b/i],
      ['ucl_table_claim', /\b(league[ -]phase table|standings|top of the (table|league)|table|relegat\w*|title race)\b/i],
      ['ucl_qualification_claim', /\b(qualif\w*|round of 16|knockout play-?off|eliminated|through to)\b/i],
    ],
  },
  knockout: {
    table: false, tiebreak: null,
    angles: { ...COMMON_MATCH_ANGLES },
    zones: null,
    banned: [
      ['knockout_aggregate', /\b(aggregate|through to|eliminated|knocked out|progress(es|ed)? to)\b/i],
      ['ucl_top_four', /\btop[ -]four\b/i],
    ],
  },
  nations_league: {
    table: false, tiebreak: null, team_kind: 'national',
    angles: { ...COMMON_MATCH_ANGLES },
    zones: null,
    banned: [...NATIONAL_BANNED],
    // [gate, claim pattern, zone support pattern | null]: the claim needs a verified group in the
    // packet, and (when a support pattern is given) a verified zone note of a team in the packet
    // that states the same concept. Unverified or unsupported -> the gate fails (HOLD).
    verified_claims: [
      ['nl_group_position_claim', /\b(group (lead(ers?)?|winners?|standings|table)|top of (the |their )?group|(lead|leads|leading|led) (the |their )?group|bottom of (the |their )?group|standings)\b/i, null],
      ['nl_quarterfinal_claim', /\bquarter-?finals?\b|\bqfs?\b/i, /\b(quarter|qfs?)\b/i],
      ['nl_promotion_claim', /\bpromot\w*/i, /promot/i],
      ['nl_relegation_claim', /\brelegat\w*/i, /relegat/i],
      ['nl_playoff_claim', /\bplay-?offs?\b/i, /play-?offs?/i],
    ],
  },
  nations_league_knockout: {
    table: false, tiebreak: null, team_kind: 'national',
    angles: { ...COMMON_MATCH_ANGLES },
    zones: null,
    banned: [
      ['knockout_aggregate', /\b(aggregate|through to|eliminated|knocked out|progress(es|ed)? to)\b/i],
      ...NATIONAL_BANNED,
    ],
  },
};

// Claims a profile allows only with verified, source-supported group context (see verified_claims).
export function unsupportedGroupClaims(profile, text, packet) {
  // every verified group the packet carries: recap/trend/preview teams, matchday fixtures, group-watch tables
  const groups = [packet?.teams?.home?.group, packet?.teams?.away?.group, packet?.team?.group, ...(packet?.groups || []), ...(packet?.fixtures || []).flatMap(f => [f.home?.group, f.away?.group])].filter(g => g?.verified);
  const zones = groups.flatMap(g => [g.zone, ...(g.rows || []).map(r => r.zone)]).filter(Boolean);
  const out = [];
  for (const [name, re, support] of profile?.verified_claims || []) {
    const m = String(text || '').match(re);
    if (!m) continue;
    if (!groups.length || (support && !zones.some(z => support.test(z)))) out.push([name, m[0]]);
  }
  return out;
}

// Profile selection per competition + match date. UCL league phase ends with
// matchday 8 (late January); after that every UCL match is a knockout tie.
export const COMPETITION_PROFILES = {
  'premier-league': () => 'domestic_european_league',
  'la-liga': () => 'domestic_european_league',
  'serie-a': () => 'domestic_european_league',
  'ligue-1': () => 'domestic_european_league',
  bundesliga: () => 'domestic_league_relegation_playoff',
  mls: () => 'mls',
  'uefa-champions-league': (kickoffIso, cfg = {}) => (Date.parse(kickoffIso) < Date.parse(cfg.ucl_league_phase_end || '2027-02-01T00:00:00Z') ? 'ucl_league_phase' : 'knockout'),
  'uefa-europa-league': (kickoffIso, cfg = {}) => (Date.parse(kickoffIso) < Date.parse(cfg.uel_league_phase_end || '2027-02-01T00:00:00Z') ? 'ucl_league_phase' : 'knockout'),
  nwsl: () => 'womens_league',
  'womens-super-league': () => 'womens_league',
  'liga-f': () => 'womens_league',
  'premiere-ligue': () => 'womens_league',
  // League phase = ESPN season type 1, ending 2026-12-18 (docs/evidence/world/espn-world-discovery-2026-10-03.json).
  'uefa-womens-champions-league': (kickoffIso, cfg = {}) => (Date.parse(kickoffIso) < Date.parse(cfg.uwcl_league_phase_end || '2026-12-19T00:00:00Z') ? 'ucl_league_phase' : 'knockout'),
  // League phase = ESPN season type 1, ending 2026-11-19T04:59Z (docs/evidence/espn/uefa-nations-discovery-2026-09-29.json).
  'uefa-nations-league': (kickoffIso, cfg = {}) => (Date.parse(kickoffIso) < Date.parse(cfg.unl_league_phase_end || '2026-11-19T05:00:00Z') ? 'nations_league' : 'nations_league_knockout'),
  // World Cup publishing is currently disabled in the registry. This profile makes the
  // engine format-safe for a deliberate FIFA backfill/current-tournament enablement.
  'fifa-world-cup': (kickoffIso, cfg = {}) => (Date.parse(kickoffIso) < Date.parse(cfg.fifa_group_phase_end || '2026-06-28T00:00:00Z') ? 'nations_league' : 'nations_league_knockout'),
};

// League-phase boundaries are production configuration (Worker vars), never a silent code default: the runner skips
// a competition whose boundary var is missing (pipeline.js). The defaults inside COMPETITION_PROFILES serve tests only.
export const LEAGUE_PHASE_CONFIG = {
  'uefa-champions-league': { cfg: 'ucl_league_phase_end', env: 'UCL_LEAGUE_PHASE_END' },
  'uefa-europa-league': { cfg: 'uel_league_phase_end', env: 'UEL_LEAGUE_PHASE_END' },
  'uefa-womens-champions-league': { cfg: 'uwcl_league_phase_end', env: 'UWCL_LEAGUE_PHASE_END' },
};
export const leaguePhaseCfg = env => Object.fromEntries(Object.values(LEAGUE_PHASE_CONFIG).filter(x => Number.isFinite(Date.parse(env?.[x.env] || ''))).map(x => [x.cfg, env[x.env]]));
export const missingPhaseConfig = (slug, cfg) => { const x = LEAGUE_PHASE_CONFIG[slug]; return x && !Number.isFinite(Date.parse(cfg?.[x.cfg] || '')) ? x.env : null; };

export function profileFor(slug, kickoffIso, cfg) {
  const f = COMPETITION_PROFILES[slug];
  if (!f) return null;
  const key = f(kickoffIso, cfg);
  return { key, ...PROFILES[key] };
}
