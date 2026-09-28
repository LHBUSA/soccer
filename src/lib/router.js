// History-API router. Routes are [pattern, pageName]; params are slug-safe only.
export const ROUTES = [
  [/^\/$/, 'home'],
  [/^\/competitions\/?$/, 'competitions'],
  [/^\/competitions\/([a-z0-9-]+)\/?$/, 'competition'],
  [/^\/matches\/?$/, 'matches'],
  [/^\/matches\/([0-9a-f-]{36})\/?$/, 'match'],
  [/^\/teams\/([a-z0-9-]+)\/?$/, 'team'],
  [/^\/players\/?$/, 'players'],
  [/^\/players\/([a-z0-9-]+)\/?$/, 'player'],
  [/^\/tables\/?$/, 'tables'],
  [/^\/news\/?$/, 'news'],
  [/^\/news\/(mls|premier-league|champions-league|bundesliga)\/?$/, 'newsDesk'],
  [/^\/news\/(mls|premier-league|champions-league|bundesliga)\/([a-z0-9-]{3,200})\/?$/, 'article'],
  [/^\/sources\/?$/, 'sources'],
];

export function resolve(pathname) {
  for (const [re, page] of ROUTES) {
    const m = pathname.match(re);
    if (m) return { page, params: m.slice(1) };
  }
  return { page: 'notfound', params: [] };
}
