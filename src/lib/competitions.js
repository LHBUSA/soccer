// The product competitions, in rail order. Monograms are typographic labels drawn by
// us, never crests or logos. `format` drives honest copy:
//   league  one table from canonical results (MLS adds verified conference tables)
//   ucl     one verified league-phase table, then knockouts (no stored single league table)
//   groups  a tournament of verified group tables and NO overall table (Nations League now;
//           World Cup / EURO / Copa America / Gold Cup reuse it)
// `nav` places the competition in the top rail: 'club' chips, or inside the INTERNATIONAL menu.
// `darkPlate: true` = the provider publishes ONE logo and it is too dark for our dark surfaces (contact sheet
// docs/evidence/media/competition-logos-2026-10-04.json): it sits on a light plate there, never recoloured.
// `spatial: false` = the source gives this competition's events no pitch locations (canary SPATIAL_DATA_UNAVAILABLE):
// PBEcast shows a neutral 'shot map not available' note, never an empty pitch, never invented locations.
export const ALL_COMPS = [
  { slug: 'mls', espn: 'usa.1', name: 'MLS', long: 'Major League Soccer', mono: 'MLS', accent: 'mls', desk: 'mls', format: 'league', nav: 'club', enabled: true },
  { slug: 'premier-league', espn: 'eng.1', aliases: ["English Premier League", "EPL"], name: 'Premier League', long: 'Premier League', mono: 'PL', accent: 'epl', desk: 'premier-league', format: 'league', nav: 'club', enabled: true },
  { slug: 'la-liga', espn: 'esp.1', aliases: ["La Liga", "LaLiga EA Sports", "Spanish LaLiga"], name: 'LaLiga', long: 'LaLiga', mono: 'LL', accent: 'laliga', desk: 'la-liga', format: 'league', nav: 'club', enabled: true },
  { slug: 'serie-a', espn: 'ita.1', aliases: ["Italian Serie A"], name: 'Serie A', long: 'Serie A', mono: 'SA', accent: 'seriea', desk: 'serie-a', format: 'league', nav: 'club', enabled: true },
  { slug: 'ligue-1', espn: 'fra.1', aliases: ["French Ligue 1"], name: 'Ligue 1', long: 'Ligue 1', mono: 'L1', accent: 'ligue1', desk: 'ligue-1', format: 'league', nav: 'club', enabled: true },
  { slug: 'bundesliga', espn: 'ger.1', aliases: ["German Bundesliga", "1. Bundesliga"], name: 'Bundesliga', long: 'Bundesliga', mono: 'BL', accent: 'bl', desk: 'bundesliga', format: 'league', nav: 'club', enabled: true },
  { slug: 'uefa-champions-league', espn: 'uefa.champions', name: 'Champions League', long: 'UEFA Champions League', mono: 'UCL', accent: 'ucl', desk: 'champions-league', format: 'ucl', nav: 'club', enabled: true },
  { slug: 'uefa-europa-league', espn: 'uefa.europa', name: 'Europa League', long: 'UEFA Europa League', mono: 'UEL', accent: 'uel', desk: 'europa-league', format: 'ucl', nav: 'club', enabled: true },
  { slug: 'uefa-nations-league', darkPlate: true, espn: 'uefa.nations', aliases: ["Nations League"], name: 'Nations League', long: 'UEFA Nations League', mono: 'UNL', accent: 'unl', desk: 'international', format: 'groups', nav: 'international', teams: 'national', enabled: true },
  { slug: 'fifa-world-cup', espn: 'fifa.world', name: 'FIFA World Cup', long: 'FIFA World Cup', mono: 'FIFA', accent: 'fifa', desk: 'fifa', format: 'groups', nav: 'international', teams: 'national', enabled: true },
  { slug: 'uefa-european-championship', espn: 'uefa.euro', aliases: ["EURO", "European Championship"], name: 'European Championship', long: 'UEFA European Championship', mono: 'EURO', accent: 'euro', desk: 'international', format: 'groups', nav: 'international', teams: 'national', enabled: false },
  // Women's football: first-class competitions on the same product (gender 'women' in the canonical graph; a women's
  // team is its own canonical team, never the men's club of the same name). nav 'women' = the WOMEN menu group.
  { slug: 'nwsl', espn: 'usa.nwsl', name: 'NWSL', long: "National Women's Soccer League", mono: 'NWSL', accent: 'nwsl', desk: 'nwsl', format: 'league', nav: 'women', gender: 'women', enabled: true },
  { slug: 'womens-super-league', espn: 'eng.w.1', aliases: ["Women's Super League", "Barclays Women's Super League", "English Women's Super League"], name: 'WSL', long: "Women's Super League", mono: 'WSL', accent: 'wsl', desk: 'wsl', format: 'league', nav: 'women', gender: 'women', enabled: true },
  { slug: 'uefa-womens-champions-league', darkPlate: true, espn: 'uefa.wchampions', aliases: ["Women's Champions League"], name: "Women's Champions League", long: "UEFA Women's Champions League", mono: 'UWCL', accent: 'uwcl', desk: 'uwcl', format: 'ucl', nav: 'women', gender: 'women', enabled: true },
  { slug: 'liga-f', espn: 'esp.w.1', aliases: ["Spanish Liga F"], name: 'Liga F', long: 'Liga F', mono: 'LF', accent: 'ligaf', desk: 'liga-f', format: 'league', nav: 'women', gender: 'women', spatial: false, enabled: true },
  { slug: 'premiere-ligue', espn: 'fra.w.1', aliases: ["Premiere Ligue", "Division 1 Feminine", "French Premiere Ligue"], name: 'Première Ligue', long: 'Première Ligue', mono: 'D1F', accent: 'd1f', desk: 'premiere-ligue', format: 'league', nav: 'women', gender: 'women', spatial: false, enabled: true },
]
// Product navigation only advertises competitions whose canonical graph is live.
export const FEATURED_COMPS = ALL_COMPS.filter(c => c.enabled);
export const NEWSROOM_COMPS = ALL_COMPS;
export const FEATURED = FEATURED_COMPS.map(c => c.slug);
export const CLUB_COMPS = FEATURED_COMPS.filter(c => c.nav === 'club');
export const INTERNATIONAL_COMPS = FEATURED_COMPS.filter(c => c.nav === 'international');
export const WOMEN_COMPS = FEATURED_COMPS.filter(c => c.nav === 'women');
export const compMeta = slug => ALL_COMPS.find(c => c.slug === slug) || null;
// ONE competition identity for every label a feed or the API may carry: our slug, the product name, the long
// name, the monogram, the newsroom desk, the exact ESPN league id or a listed alias. Matching is EXACT after
// case / accent / punctuation folding (never fuzzy, never substring), so "NWSL", "nwsl", "usa.nwsl" and
// "National Women's Soccer League" are one identity and an unknown label resolves to null (-> mono, never a
// wrong logo). `espn` is the crosswalk id used by scripts/media/competition-logos.mjs, not the identity.
export const foldLabel = v => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[\u2019']/g, '').replace(/[^a-z0-9.]+/g, ' ').trim();
const IDENTITY = new Map();
for (const c of ALL_COMPS) {
  for (const label of [c.slug, c.name, c.long, c.mono, c.desk, c.espn, ...(c.aliases || [])]) {
    const k = foldLabel(label); if (!k) continue;
    const prior = IDENTITY.get(k);
    // A label two competitions share (e.g. desk 'international') is ambiguous: it identifies neither.
    IDENTITY.set(k, prior && prior !== c ? null : c);
  }
}
export const resolveComp = x => {
  if (!x) return null;
  if (typeof x === 'object') return resolveComp(x.slug) || resolveComp(x.name) || null;
  return IDENTITY.get(foldLabel(x)) || null;
};
export const compByDesk = desk => ALL_COMPS.find(c => c.desk === desk && c.enabled) || ALL_COMPS.find(c => c.desk === desk) || null;
// Competitions contested by national teams: copy says nations / national teams, never clubs.
export const isNationalComp = slug => compMeta(slug)?.teams === 'national';
