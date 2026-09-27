// The four product competitions, in rail order. Monograms are typographic
// labels drawn by us, never crests or logos. `format` drives honest copy:
// UCL has no stored single table (league phase + knockouts are not a league stage).
export const FEATURED_COMPS = [
  { slug: 'mls', name: 'MLS', long: 'Major League Soccer', mono: 'MLS', accent: 'mls', desk: 'mls', format: 'league' },
  { slug: 'premier-league', name: 'Premier League', long: 'Premier League', mono: 'PL', accent: 'epl', desk: 'premier-league', format: 'league' },
  { slug: 'uefa-champions-league', name: 'Champions League', long: 'UEFA Champions League', mono: 'UCL', accent: 'ucl', desk: 'champions-league', format: 'ucl' },
  { slug: 'bundesliga', name: 'Bundesliga', long: 'Bundesliga', mono: 'BL', accent: 'bl', desk: 'bundesliga', format: 'league' },
];
export const FEATURED = FEATURED_COMPS.map(c => c.slug);
export const compMeta = slug => FEATURED_COMPS.find(c => c.slug === slug) || null;
export const compByDesk = desk => FEATURED_COMPS.find(c => c.desk === desk) || null;
