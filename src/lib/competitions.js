// The product competitions, in rail order. Monograms are typographic labels drawn by
// us, never crests or logos. `format` drives honest copy:
//   league  one table from canonical results (MLS adds verified conference tables)
//   ucl     one verified league-phase table, then knockouts (no stored single league table)
//   groups  a tournament of verified group tables and NO overall table (Nations League now;
//           World Cup / EURO / Copa America / Gold Cup reuse it)
// `nav` places the competition in the top rail: 'club' chips, or inside the INTERNATIONAL menu.
export const FEATURED_COMPS = [
  { slug: 'mls', name: 'MLS', long: 'Major League Soccer', mono: 'MLS', accent: 'mls', desk: 'mls', format: 'league', nav: 'club', enabled: true },
  { slug: 'premier-league', name: 'Premier League', long: 'Premier League', mono: 'PL', accent: 'epl', desk: 'premier-league', format: 'league', nav: 'club', enabled: true },
  { slug: 'la-liga', name: 'LaLiga', long: 'LaLiga', mono: 'LL', accent: 'laliga', desk: 'la-liga', format: 'league', nav: 'club', enabled: false },
  { slug: 'serie-a', name: 'Serie A', long: 'Serie A', mono: 'SA', accent: 'seriea', desk: 'serie-a', format: 'league', nav: 'club', enabled: false },
  { slug: 'ligue-1', name: 'Ligue 1', long: 'Ligue 1', mono: 'L1', accent: 'ligue1', desk: 'ligue-1', format: 'league', nav: 'club', enabled: false },
  { slug: 'bundesliga', name: 'Bundesliga', long: 'Bundesliga', mono: 'BL', accent: 'bl', desk: 'bundesliga', format: 'league', nav: 'club', enabled: true },
  { slug: 'uefa-champions-league', name: 'Champions League', long: 'UEFA Champions League', mono: 'UCL', accent: 'ucl', desk: 'champions-league', format: 'ucl', nav: 'club', enabled: true },
  { slug: 'uefa-europa-league', name: 'Europa League', long: 'UEFA Europa League', mono: 'UEL', accent: 'uel', desk: 'europa-league', format: 'ucl', nav: 'club', enabled: false },
  { slug: 'uefa-nations-league', name: 'Nations League', long: 'UEFA Nations League', mono: 'UNL', accent: 'unl', desk: 'international', format: 'groups', nav: 'international', teams: 'national', enabled: true },
  { slug: 'fifa-world-cup', name: 'FIFA World Cup', long: 'FIFA World Cup', mono: 'FIFA', accent: 'fifa', desk: 'fifa', format: 'groups', nav: 'international', teams: 'national', enabled: true },
  { slug: 'uefa-european-championship', name: 'European Championship', long: 'UEFA European Championship', mono: 'EURO', accent: 'euro', desk: 'international', format: 'groups', nav: 'international', teams: 'national', enabled: false },
]
export const FEATURED = FEATURED_COMPS.map(c => c.slug);
export const CLUB_COMPS = FEATURED_COMPS.filter(c => c.nav === 'club');
export const INTERNATIONAL_COMPS = FEATURED_COMPS.filter(c => c.nav === 'international');
export const compMeta = slug => FEATURED_COMPS.find(c => c.slug === slug) || null;
export const compByDesk = desk => FEATURED_COMPS.find(c => c.desk === desk && c.enabled) || FEATURED_COMPS.find(c => c.desk === desk) || null;
// Competitions contested by national teams: copy says nations / national teams, never clubs.
export const isNationalComp = slug => compMeta(slug)?.teams === 'national';
