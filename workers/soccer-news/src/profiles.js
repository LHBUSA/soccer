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

export const PROFILES_VERSION = 'soccer-news-profiles/1.0.0';

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
    banned: [],
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
};

// Profile selection per competition + match date. UCL league phase ends with
// matchday 8 (late January); after that every UCL match is a knockout tie.
export const COMPETITION_PROFILES = {
  'premier-league': () => 'domestic_european_league',
  bundesliga: () => 'domestic_european_league',
  mls: () => 'mls',
  'uefa-champions-league': (kickoffIso, cfg = {}) => (Date.parse(kickoffIso) < Date.parse(cfg.ucl_league_phase_end || '2027-02-01T00:00:00Z') ? 'ucl_league_phase' : 'knockout'),
};

export function profileFor(slug, kickoffIso, cfg) {
  const f = COMPETITION_PROFILES[slug];
  if (!f) return null;
  const key = f(kickoffIso, cfg);
  return { key, ...PROFILES[key] };
}
