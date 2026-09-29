import { videoObject } from '../components/video.js';
// Server-first SEO: pure builders from API envelopes to page metadata.
// Used by middleware.js (first HTML response) and by the client on navigation.
// Only fields the canonical graph actually returns are ever emitted.
import { resolve } from '../lib/router.js';

export const SITE = 'https://soccer.propbetedge.ai';
export const BRAND = 'PropBetEdge Soccer';
export const INDEX = 'index, follow, max-image-preview:large';
export const NOINDEX = 'noindex, follow';
export const SHARE_IMAGE = `${SITE}/share/propbetedge-soccer-social-v1.jpg`;
export const LOGO = `${SITE}/share/propbetedge-logo-v3-512.png`;
export const ORG = { '@type': 'Organization', name: 'PropBetEdge', url: 'https://propbetedge.ai/', logo: { '@type': 'ImageObject', url: LOGO, width: 512, height: 512 }, sameAs: ['https://x.com/PROPBETEDGE'] };

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clip = (s, n = 165) => (s.length <= n ? s : `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…`);
const day = iso => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : null);
export const canonicalFor = pathname => `${SITE}${pathname === '/' ? '/' : pathname.replace(/\/+$/, '')}`;

const STATIC = {
  home: {
    title: 'Soccer Intelligence, Live Match Data & Player DNA | PropBetEdge',
    description: 'Live match intelligence, Player DNA, event maps, team intelligence and data-backed soccer news from PropBetEdge across MLS, Premier League, Champions League and Bundesliga, with every source shown.',
    h1: 'PropBetEdge Soccer Intelligence',
  },
  competitions: { title: 'Competitions — Soccer Intelligence | PropBetEdge Soccer', description: 'MLS, Premier League, UEFA Champions League, Bundesliga and UEFA Nations League on the PropBetEdge canonical soccer graph: seasons, results, fixtures, verified tables and coverage.', h1: 'Competitions' },
  matches: { title: 'Matches — Results, Fixtures & Match Intelligence | PropBetEdge Soccer', description: 'Recent results, today’s matches and upcoming fixtures, each with PropBetEdge Match Intelligence: timelines, event maps, statistics and lineups where sourced.', h1: 'Matches' },
  tables: { title: 'Tables — League Standings | PropBetEdge Soccer', description: 'League tables computed by PropBetEdge from canonical finished league-stage results, with the method shown alongside every table.', h1: 'Tables' },
  pbecastHub: { title: 'PBEcast — Live Soccer Match Tracker & Replays | PropBetEdge Soccer', description: 'Live soccer scores with the provider clock, then replays of every sourced shot, goal, card and substitution on the canonical pitch, across MLS, Premier League, Champions League and Bundesliga.', h1: 'PBEcast' },
  players: { title: 'Player DNA Directory — Soccer Player Stats & Profiles | PropBetEdge Soccer', description: 'Every player named in sourced lineups this season across MLS, Premier League, Champions League and Bundesliga: appearances, minutes, goals, assists and per-competition rate leaders, with Player DNA for each.', h1: 'Player DNA directory' },
  pro: { title: 'Soccer Pro — Match Center, Matchup Lab & Fatigue Intelligence | PropBetEdge', description: 'Soccer Pro with PropBetEdge All Access ($29/month, every current and future Pro sport): Pro Match Center, Fatigue Intelligence, Rotation / XI Stability and a descriptive Matchup Lab built from canonical soccer data. Workload intelligence, not medical advice.', h1: 'Soccer Pro' },
  proMatch: { title: 'Pro Match Center | PropBetEdge Soccer', description: 'Soccer Pro Match Center: fatigue, rotation and matchup intelligence for PropBetEdge All Access members.', h1: 'Pro Match Center', robots: 'noindex, follow' },
  // Soccer Algo V1: live since owner G7 sign-off 2026-09-29 (docs/evidence/algo/ACCEPTANCE.md): indexed, in nav and sitemap.
  algoPicks: { title: 'Soccer Algo Official Picks | PropBetEdge Soccer', description: 'Soccer Algo V1 Official Picks for the Bundesliga: a frozen model and frozen thresholds, picks locked 60 minutes before kickoff and graded from the final score, plus the model Game Best for every forecast match.', h1: 'Official Picks' },
  trackRecord: { title: 'Soccer Algo Track Record | PropBetEdge Soccer', description: 'Every Soccer Algo V1 Official Pick issued after go-live, from an append-only ledger: wins, losses, voids, pending, hit rate and calibration. Historical validation is shown separately and never counted.', h1: 'Track record' },
  sources: { title: 'Sources & Method — PropBetEdge Soccer Intelligence', description: 'Where every PropBetEdge Soccer fact comes from: sources, attribution, identity rules, event-map semantics and how missing data is shown.', h1: 'Sources' },
};

// Newsroom desks (URL segment -> display). The index and each desk are indexable
// only once they contain real published stories.
export const DESKS = { mls: 'MLS', 'premier-league': 'Premier League', 'champions-league': 'Champions League', bundesliga: 'Bundesliga', international: 'International' };

export function newsMeta(pathname, env, desk = null) {
  const items = env?.data || [];
  const where = desk ? `${DESKS[desk]} ` : '';
  const title = `${where}Soccer News — Evidence-Backed Reporting | ${BRAND}`;
  const description = items.length
    ? `${where}soccer news from the PropBetEdge canonical graph: ${items.slice(0, 2).map(a => a.headline).join('; ')}. Every figure traces to a frozen evidence packet.`
    : `${where}evidence-backed soccer reporting from the PropBetEdge canonical graph is coming online.`;
  const url = canonicalFor(pathname);
  return base(pathname, {
    title, description, robots: items.length ? INDEX : NOINDEX,
    jsonld: [breadcrumb([['Soccer', `${SITE}/`], ['News', `${SITE}/news`], ...(desk ? [[DESKS[desk], url]] : [])]),
      ...(items.length ? [{ '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: items.slice(0, 10).map((a, i) => ({ '@type': 'ListItem', position: i + 1, url: `${SITE}/news/${a.desk}/${a.slug}`, name: a.headline })) }] : [])],
    ssr: { h1: desk ? `${DESKS[desk]} news` : 'PropBetEdge Soccer Newsroom', p: description, links: items.slice(0, 8).map(a => [`/news/${a.desk}/${a.slug}`, a.headline]) },
  });
}

export function articleMeta(pathname, env, desk) {
  const a = env.data;
  if (a.desk !== desk) return notFoundMeta(pathname, 'article');
  const url = canonicalFor(pathname);
  const entities = a.entities || [];
  const teams = entities.filter(e => e.type === 'SportsTeam');
  const people = entities.filter(e => e.type === 'Person');
  const match = entities.find(e => e.type === 'SportsEvent');
  const competition = entities.find(e => e.type === 'SportsOrganization');
  const org = ORG;
  const image = `${SITE}/og/article/${a.slug}.png`;
  const about = [
    ...teams.map(t => ({ '@type': 'SportsTeam', name: t.name, url: `${SITE}${t.href || `/teams/${t.slug}`}` })),
    ...people.slice(0, 8).map(p => ({ '@type': 'Person', name: p.name, url: `${SITE}${p.href || `/players/${p.slug}`}` })),
  ];
  const mentions = [
    ...(competition ? [{ '@type': 'SportsOrganization', name: competition.name, url: `${SITE}${competition.href}` }] : []),
    ...(match ? [{ '@type': 'SportsEvent', name: match.name, url: `${SITE}${match.href}` }] : []),
  ];
  return base(pathname, {
    title: `${a.headline} | ${BRAND}`,
    description: a.dek || a.headline,
    image,
    imageAlt: `${a.headline} — PropBetEdge Soccer`,
    ogType: 'article',
    jsonld: [{ '@context': 'https://schema.org', '@type': 'NewsArticle',
      headline: a.headline.slice(0, 110),
      ...(a.dek ? { description: a.dek } : {}),
      datePublished: a.published_at,
      dateModified: a.updated_at || a.published_at,
      author: { '@type': 'Organization', name: 'PropBetEdge Soccer Desk', url: `${SITE}/news` },
      publisher: org,
      mainEntityOfPage: { '@type': 'WebPage', '@id': url },
      url,
      isPartOf: { '@type': 'WebSite', name: 'PropBetEdge Soccer Intelligence', url: `${SITE}/` },
      articleSection: DESKS[a.desk],
      image: [{ '@type': 'ImageObject', url: image, width: 1200, height: 630 }],
      ...(about.length ? { about } : {}),
      ...(mentions.length ? { mentions } : {}),
    },
    breadcrumb([['Soccer', `${SITE}/`], ['News', `${SITE}/news`], [DESKS[a.desk], `${SITE}/news/${a.desk}`], [a.headline, url]]),
    // VideoObject only for a matcher-validated official video linked to this story.
    ...((a.media?.videos || []).filter(v => v.validated).slice(0, 1).map(videoObject).filter(Boolean))],
    ssr: { h1: a.headline, p: a.dek || '', links: [[`/news/${a.desk}`, `${DESKS[a.desk]} news`], ...entities.filter(e => e.href).slice(0, 10).map(e => [e.href, e.name])] },
  });
}

const breadcrumb = items => ({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items.map(([name, url], i) => ({ '@type': 'ListItem', position: i + 1, name, item: url })) });

export function notFoundMeta(pathname, what = 'page') {
  return { status: 404, title: `Not found — ${BRAND}`, description: `This ${what} is not in the PropBetEdge canonical soccer graph.`, canonical: null, robots: NOINDEX, jsonld: [], image: null, ssr: { h1: 'Not found', p: `This ${what} is not in the PropBetEdge canonical soccer graph.`, links: [['/', 'Back to today']] } };
}

function base(pathname, { title, description, robots = INDEX, jsonld = [], image = null, imageAlt = null, ogType = 'website', ssr }) {
  return { status: 200, title, description: clip(description), canonical: canonicalFor(pathname), robots, jsonld, image: image || SHARE_IMAGE, imageAlt: imageAlt || (image ? title : 'PropBetEdge Soccer Intelligence: live match intelligence, Player DNA and event maps'), ogType, ssr };
}

export function staticMeta(page, pathname) {
  const s = STATIC[page];
  const jsonld = page === 'home' ? [
    { '@context': 'https://schema.org', '@type': 'WebSite', name: 'PropBetEdge Soccer Intelligence', alternateName: 'PropBetEdge Soccer', url: `${SITE}/`, publisher: ORG },
    { '@context': 'https://schema.org', ...ORG },
  ] : [breadcrumb([['Soccer', `${SITE}/`], [s.h1, canonicalFor(pathname)]])];
  return base(pathname, { title: s.title, description: s.description, robots: s.robots || INDEX, jsonld, ssr: { h1: s.h1, p: s.description, links: [['/competitions', 'Competitions'], ['/matches', 'Matches'], ['/tables', 'Tables'], ['/sources', 'Sources']] } });
}

export function competitionMeta(pathname, compEnv, tableEnv) {
  const c = compEnv.data;
  const seasons = c.seasons || [];
  const total = seasons.reduce((n, s) => n + (s.matches || 0), 0);
  const hasTable = (tableEnv?.data?.rows || []).length > 0;
  const latest = seasons[0]?.label;
  // Group competitions (Nations League): claim tables only for groups that VERIFIED; never an overall table.
  const grouped = tableEnv?.data?.view === 'groups';
  const verified = grouped ? tableEnv.data.verified_groups || 0 : 0;
  const title = grouped ? `${c.name}${latest ? ` ${latest}` : ''} — ${verified ? 'Tables, ' : ''}Fixtures & Match Intelligence | PropBetEdge`
    : hasTable ? `${c.name} Table, Results & Match Intelligence | PropBetEdge` : `${c.name} Results & Match Intelligence | PropBetEdge`;
  const description = grouped
    ? `${c.name}${latest ? ` ${latest}` : ''}: ${verified ? `${verified} verified group ${verified === 1 ? 'table' : 'tables'}, ` : ''}results and fixtures for ${(c.current?.teams || []).length || 'every'} national teams — ${total.toLocaleString('en-US')} canonical matches on the PropBetEdge soccer graph.`
    : `${c.name}${latest ? ` ${latest}` : ''}: ${hasTable ? 'table, results and fixtures' : 'results and fixtures'} — ${seasons.length} stored ${seasons.length === 1 ? 'season' : 'seasons'}, ${total.toLocaleString('en-US')} canonical matches on the PropBetEdge soccer graph.`;
  const url = canonicalFor(pathname);
  return base(pathname, {
    title, description, image: `${SITE}/og/competition/${c.slug}.png`,
    jsonld: [breadcrumb([['Soccer', `${SITE}/`], ['Competitions', `${SITE}/competitions`], [c.name, url]]),
      { '@context': 'https://schema.org', '@type': 'SportsOrganization', name: c.name, sport: 'Soccer', url,
        ...(grouped ? { description: 'International football competition between national teams.' } : {}) }],
    ssr: { h1: c.name, p: description, links: [['/competitions', 'All competitions'], [`/tables?competition=${c.slug}`, `${c.name} table`], ['/matches', 'Matches']] },
  });
}

// Titles never claim LIVE unless the canonical status is live.
export function matchTitle(m) {
  const home = m.home?.name; const away = m.away?.name;
  return m.status === 'live' ? `${home} vs ${away} Live Match Intelligence | PropBetEdge` : `${home} vs ${away} Match Intelligence | PropBetEdge`;
}

const EVENT_STATUS = { scheduled: 'https://schema.org/EventScheduled', finished: 'https://schema.org/EventScheduled', postponed: 'https://schema.org/EventPostponed', cancelled: 'https://schema.org/EventCancelled' };

export function matchMeta(pathname, env) {
  const m = env.data;
  const home = m.home?.name; const away = m.away?.name;
  const sc = m.score && m.score.home !== null && m.score.home !== undefined ? `${m.score.home}–${m.score.away}` : null;
  const when = day(m.kickoff_at);
  const shots = (m.shots || []).length;
  const intel = [
    shots ? `event map (${shots} ${shots === 1 ? 'shot' : 'shots'})` : null,
    m.stats?.basis === 'source' ? 'source stats' : m.stats?.basis === 'derived' ? 'PBE derived counts' : null,
    m.lineups ? 'lineups' : null,
    (m.timeline || []).length ? 'timeline' : null,
  ].filter(Boolean);
  const head = m.status === 'finished' && sc ? `${home} ${sc} ${away}` : `${home} vs ${away}`;
  const status = m.status === 'scheduled' ? ' Scheduled.' : m.status === 'postponed' ? ' Postponed.' : m.status === 'finished' && sc ? ' Full time.' : '';
  const description = `${head}${m.competition ? ` · ${m.competition.name}${m.season ? ` ${m.season}` : ''}` : ''}${when ? ` · ${when}` : ''}.${status}${intel.length ? ` Match Intelligence: ${intel.join(', ')}.` : ''}`.replace(/\s+/g, ' ').trim();
  const url = canonicalFor(pathname);
  const team = t => ({ '@type': 'SportsTeam', name: t.name, ...(t.slug ? { url: `${SITE}/teams/${t.slug}` } : {}) });
  const event = {
    '@context': 'https://schema.org', '@type': 'SportsEvent', name: `${home} vs ${away}`, sport: 'Soccer', url,
    ...(m.kickoff_at ? { startDate: m.kickoff_at } : {}),
    ...(EVENT_STATUS[m.status] ? { eventStatus: EVENT_STATUS[m.status] } : {}),
    homeTeam: team(m.home), awayTeam: team(m.away),
    ...(m.venue?.name ? { location: { '@type': 'Place', name: m.venue.name, ...(m.venue.city ? { address: { '@type': 'PostalAddress', addressLocality: m.venue.city } } : {}) } } : {}),
    ...(m.competition ? { superEvent: { '@type': 'SportsEvent', name: `${m.competition.name}${m.season ? ` ${m.season}` : ''}`, url: `${SITE}/competitions/${m.competition.slug}` } } : {}),
  };
  const crumbs = [['Soccer', `${SITE}/`], ...(m.competition ? [[m.competition.name, `${SITE}/competitions/${m.competition.slug}`]] : []), [`${home} vs ${away}`, url]];
  return base(pathname, {
    title: matchTitle(m), description, image: `${SITE}/og/match/${m.id}.png`,
    robots: m.status === 'finished' || m.status === 'scheduled' ? INDEX : NOINDEX,
    jsonld: [event, breadcrumb(crumbs)],
    ssr: { h1: `${home}${sc ? ` ${sc} ` : ' vs '}${away}`, p: description, links: [...(m.home?.slug ? [[`/teams/${m.home.slug}`, home]] : []), ...(m.away?.slug ? [[`/teams/${m.away.slug}`, away]] : []), ...(m.competition ? [[`/competitions/${m.competition.slug}`, m.competition.name]] : [])] },
  });
}

// A PBEcast page shows the same match as its Match Intelligence page: same facts, canonical
// to the match page, its own title.
export function castMeta(pathname, env) {
  const m = env.data;
  const meta = matchMeta(`/matches/${m.id}`, env);
  return { ...meta, title: `${m.home?.name} vs ${m.away?.name} ${m.status === 'live' ? 'Live ' : ''}PBEcast | PropBetEdge`, ssr: { ...meta.ssr, links: [[`/matches/${m.id}`, 'Match Intelligence'], ...meta.ssr.links] } };
}

export function teamMeta(pathname, env) {
  const t = env.data;
  const comps = [...new Set([...(t.recent || []), ...(t.upcoming || [])].map(x => x.competition?.name).filter(Boolean))];
  const form = (t.form || []).join('-');
  const description = `${t.name}${comps.length ? ` (${comps.join(', ')})` : ''}: recent results${form ? ` (last five: ${form})` : ''}, upcoming fixtures and match intelligence from the PropBetEdge canonical soccer graph.`;
  const url = canonicalFor(pathname);
  return base(pathname, {
    title: `${t.name} Results, Team DNA & Soccer Intelligence | PropBetEdge`, description, image: `${SITE}/og/team/${t.slug}.png`,
    jsonld: [{ '@context': 'https://schema.org', '@type': 'SportsTeam', name: t.name, sport: 'Soccer', url,
      ...(t.official_name && t.official_name !== t.name ? { alternateName: t.official_name } : {}),
      ...(t.city ? { location: { '@type': 'Place', name: t.city } } : {}) },
    breadcrumb([['Soccer', `${SITE}/`], [t.name, url]])],
    ssr: { h1: t.name, p: description, links: [...(t.recent || []).slice(0, 5).map(x => [`/matches/${x.id}`, `${x.home?.name} vs ${x.away?.name}`])] },
  });
}

const ROLE = { goalkeeper: 'goalkeeper', defender: 'defender', midfielder: 'midfielder', forward: 'forward' };
export function playerMeta(pathname, env) {
  const p = env.data;
  const seasons = (p.seasons || []).map(s => s.season).filter(Boolean);
  const bits = [ROLE[p.role], p.birth_date ? `born ${day(`${String(p.birth_date).slice(0, 10)}T12:00:00Z`)}` : null].filter(Boolean);
  const description = `${p.name}${bits.length ? ` — ${bits.join(', ')}` : ''}. Player Intelligence from the PropBetEdge canonical soccer graph${seasons.length ? `: event-derived statistics for ${seasons.join(', ')}` : ''}.`;
  const url = canonicalFor(pathname);
  const person = { '@context': 'https://schema.org', '@type': 'Person', name: p.name, url,
    ...(p.first_name ? { givenName: p.first_name } : {}), ...(p.last_name ? { familyName: p.last_name } : {}),
    ...(p.birth_date ? { birthDate: String(p.birth_date).slice(0, 10) } : {}),
    ...(p.height_cm ? { height: { '@type': 'QuantitativeValue', value: p.height_cm, unitCode: 'CMT' } } : {}),
    ...(p.nationality_code ? { nationality: { '@type': 'Country', identifier: p.nationality_code } } : {}) };
  return base(pathname, {
    title: `${p.name} Stats, Player DNA & Match Intelligence | PropBetEdge`, description, image: `${SITE}/og/player/${p.slug}.png`, ogType: 'profile',
    jsonld: [person, breadcrumb([['Soccer', `${SITE}/`], [p.name, url]])],
    ssr: { h1: p.name, p: description, links: [['/matches', 'Matches']] },
  });
}

// Which API calls a route needs for its metadata.
export function metaPlan(pathname) {
  const { page, params } = resolve(pathname);
  if (page === 'notfound') return { page };
  if (STATIC[page]) return { page };
  if (page === 'competition') return { page, calls: [`competitions/${params[0]}`, `table?competition=${encodeURIComponent(params[0])}`] };
  if (page === 'match' || page === 'pbecast') return { page, calls: [`matches/${params[0]}`] };
  if (page === 'team') return { page, calls: [`teams/${params[0]}`] };
  if (page === 'player') return { page, calls: [`players/${params[0]}`] };
  if (page === 'news') return { page, calls: ['news?limit=10'] };
  if (page === 'newsDesk') return { page, calls: [`news?desk=${params[0]}&limit=10`] };
  if (page === 'article') return { page, calls: [`news/${params[1]}`] };
  return { page };
}

export function buildMeta(pathname, page, results = []) {
  if (page === 'notfound') return notFoundMeta(pathname);
  if (STATIC[page]) return staticMeta(page, pathname);
  const [first, second] = results;
  if (!first || first.notFound) return notFoundMeta(pathname, page);
  if (page === 'competition') return competitionMeta(pathname, first, second && !second.notFound ? second : null);
  if (page === 'match') return matchMeta(pathname, first);
  if (page === 'pbecast') return castMeta(pathname, first);
  if (page === 'team') return teamMeta(pathname, first);
  if (page === 'player') return playerMeta(pathname, first);
  if (page === 'news') return newsMeta(pathname, first);
  if (page === 'newsDesk') return newsMeta(pathname, first, resolve(pathname).params[0]);
  if (page === 'article') return articleMeta(pathname, first, resolve(pathname).params[0]);
  return notFoundMeta(pathname);
}

// ---- HTML injection (server) ----
export function headTags(meta) {
  const t = [
    `<title>${esc(meta.title)}</title>`,
    `<meta name="description" content="${esc(meta.description)}">`,
    `<meta name="robots" content="${esc(meta.robots)}">`,
    meta.canonical ? `<link rel="canonical" href="${esc(meta.canonical)}">` : '',
    `<meta property="og:site_name" content="PropBetEdge Soccer Intelligence">`,
    `<meta property="og:type" content="${esc(meta.ogType || 'website')}">`,
    `<meta property="og:title" content="${esc(meta.title)}">`,
    `<meta property="og:description" content="${esc(meta.description)}">`,
    meta.canonical ? `<meta property="og:url" content="${esc(meta.canonical)}">` : '',
    meta.image ? `<meta property="og:image" content="${esc(meta.image)}">` : '',
    meta.image ? '<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">' : '',
    meta.image ? `<meta property="og:image:alt" content="${esc(meta.imageAlt || meta.title)}">` : '',
    '<meta name="twitter:site" content="@PROPBETEDGE">',
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${esc(meta.title)}">`,
    `<meta name="twitter:description" content="${esc(meta.description)}">`,
    meta.image ? `<meta name="twitter:image" content="${esc(meta.image)}">` : '',
    meta.image ? `<meta name="twitter:image:alt" content="${esc(meta.imageAlt || meta.title)}">` : '',
    ...(meta.jsonld || []).map(j => `<script type="application/ld+json">${JSON.stringify(j).replace(/</g, '\\u003c')}</script>`),
  ];
  return t.filter(Boolean).join('\n  ');
}

export function ssrBody(meta) {
  const s = meta.ssr || {};
  return `<div id="app"><main class="ssr"><p class="ssr-brand">PROPBETEDGE SOCCER INTELLIGENCE</p><h1>${esc(s.h1 || meta.title)}</h1><p>${esc(s.p || meta.description)}</p>${(s.links || []).length ? `<nav>${s.links.map(([h, l]) => `<a href="${esc(h)}">${esc(l)}</a>`).join(' · ')}</nav>` : ''}</main></div>`;
}

export function injectMeta(html, meta) {
  return html
    .replace(/<title>[\s\S]*?<\/title>/i, '')
    .replace(/<meta\s+name="description"[^>]*>/i, '')
    .replace(/<meta\s+name="robots"[^>]*>/i, '')
    .replace(/<link\s+rel="canonical"[^>]*>/i, '')
    .replace('</head>', `  ${headTags(meta)}\n</head>`)
    .replace(/<div id="app"><\/div>/, ssrBody(meta));
}
