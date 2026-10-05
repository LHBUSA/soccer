// History-API router. Routes are [pattern, pageName]; params are slug-safe only.
export const ROUTES = [
  [/^\/$/, 'home'],
  [/^\/competitions\/?$/, 'competitions'],
  [/^\/competitions\/([a-z0-9-]+)\/?$/, 'competition'],
  [/^\/matches\/?$/, 'matches'],
  [/^\/matches\/([0-9a-f-]{36})\/?$/, 'match'],
  [/^\/pbecast\/?$/, 'pbecastHub'],
  [/^\/pbecast\/([0-9a-f-]{36})\/?$/, 'pbecast'],
  [/^\/teams\/([a-z0-9-]+)\/?$/, 'team'],
  [/^\/players\/?$/, 'players'],
  [/^\/players\/([a-z0-9-]+)\/?$/, 'player'],
  [/^\/tables\/?$/, 'tables'],
  [/^\/pro\/?$/, 'pro'],
  [/^\/pro\/matches\/([0-9a-f-]{36})\/?$/, 'proMatch'],
  [/^\/all-access\/?$/, 'allAccess'],
  [/^\/news\/?$/, 'news'],
  [/^\/news\/(mls|premier-league|la-liga|serie-a|ligue-1|champions-league|europa-league|bundesliga|international|fifa|nwsl|wsl|uwcl|liga-f|premiere-ligue)\/?$/, 'newsDesk'],
  [/^\/news\/(mls|premier-league|la-liga|serie-a|ligue-1|champions-league|europa-league|bundesliga|international|fifa|nwsl|wsl|uwcl|liga-f|premiere-ligue)\/([a-z0-9-]{3,200})\/?$/, 'article'],
  [/^\/sources\/?$/, 'sources'],
  [/^\/picks\/?$/, 'algoPicks'],
  [/^\/track-record\/?$/, 'trackRecord'],
];

export function resolve(pathname) {
  for (const [re, page] of ROUTES) {
    const m = pathname.match(re);
    if (m) return { page, params: m.slice(1) };
  }
  return { page: 'notfound', params: [] };
}
