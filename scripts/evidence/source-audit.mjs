#!/usr/bin/env node
// Phase 0 source red team. Probes robots.txt, terms pages and one representative
// data endpoint per source, and writes one evidence file per probe:
//   docs/evidence/source-audit/<date>/<source>__<probe>.json
// It records what happened — status, headers, byte count, sha256, access-control
// fingerprints, and short keyword-windowed excerpts from terms pages.
// It never retries around a challenge, never sends cookies, never solves anything.
//
// Usage: node scripts/evidence/source-audit.mjs [--only key1,key2]

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const UA = 'PropBetEdgeSourceAudit/0.1 (+https://propbetedge.ai/sources)';
const DATE = new Date().toISOString().slice(0, 10);
const OUT = join('docs', 'evidence', 'source-audit', DATE);

// kind: robots | terms | data
export const PROBES = [
  // --- open / community ---------------------------------------------------
  ['openfootball', 'license', 'terms', 'https://raw.githubusercontent.com/openfootball/football.json/master/LICENSE.md'],
  ['openfootball', 'epl_2025_26', 'data', 'https://raw.githubusercontent.com/openfootball/football.json/master/2025-26/en.1.json'],
  ['openfootball', 'bundesliga_2025_26', 'data', 'https://raw.githubusercontent.com/openfootball/football.json/master/2025-26/de.1.json'],
  ['openfootball', 'worldcup_2026', 'data', 'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json'],
  ['statsbomb_open', 'competitions', 'data', 'https://raw.githubusercontent.com/statsbomb/open-data/master/data/competitions.json'],
  ['wyscout_figshare', 'collection', 'data', 'https://api.figshare.com/v2/collections/4415000'],
  ['wyscout_figshare', 'competitions', 'data', 'https://ndownloader.figshare.com/files/15073685'],
  ['football_data_co_uk', 'robots', 'robots', 'https://www.football-data.co.uk/robots.txt'],
  ['football_data_co_uk', 'epl_2025_26_csv', 'data', 'https://www.football-data.co.uk/mmz4281/2526/E0.csv'],
  ['football_data_co_uk', 'notes', 'terms', 'https://www.football-data.co.uk/notes.txt'],
  ['football_data_co_uk', 'disclaimer', 'terms', 'https://www.football-data.co.uk/disclaimer.php'],
  ['football_data_org', 'matches_no_token', 'data', 'https://api.football-data.org/v4/competitions/PL/matches'],
  ['football_data_org', 'terms', 'terms', 'https://www.football-data.org/documentation/quickstart'],
  ['openligadb', 'robots', 'robots', 'https://www.openligadb.de/robots.txt'],
  ['openligadb', 'bl1_2025', 'data', 'https://api.openligadb.de/getmatchdata/bl1/2025/1'],
  ['openligadb', 'home', 'terms', 'https://www.openligadb.de/'],
  ['openligadb', 'license', 'terms', 'https://www.openligadb.de/lizenz'],
  ['wikidata', 'sparql_epl_clubs', 'data', 'https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent('SELECT ?club ?clubLabel WHERE { ?club wdt:P118 wd:Q9448; wdt:P31 wd:Q476028. SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } LIMIT 40')],
  ['wikidata', 'licensing', 'terms', 'https://www.wikidata.org/wiki/Wikidata:Licensing'],
  ['thesportsdb', 'epl_next', 'data', 'https://www.thesportsdb.com/api/v1/json/3/eventsnextleague.php?id=4328'],
  ['thesportsdb', 'terms', 'terms', 'https://www.thesportsdb.com/docs_terms_of_use.php'],
  ['wikimedia_commons', 'api', 'data', 'https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=Premier%20League%20match&srnamespace=6&format=json&srlimit=3'],

  // --- scraped aggregators -------------------------------------------------
  ['fbref', 'robots', 'robots', 'https://fbref.com/robots.txt'],
  ['fbref', 'epl_page', 'data', 'https://fbref.com/en/comps/9/Premier-League-Stats'],
  ['fbref', 'terms', 'terms', 'https://www.sports-reference.com/termsofuse.html'],
  ['fbref', 'data_use', 'terms', 'https://www.sports-reference.com/data_use.html'],
  ['understat', 'robots', 'robots', 'https://understat.com/robots.txt'],
  ['understat', 'epl_page', 'data', 'https://understat.com/league/EPL'],
  ['sofascore', 'robots', 'robots', 'https://www.sofascore.com/robots.txt'],
  ['sofascore', 'api_events', 'data', 'https://api.sofascore.com/api/v1/sport/football/scheduled-events/' + DATE],
  ['fotmob', 'robots', 'robots', 'https://www.fotmob.com/robots.txt'],
  ['fotmob', 'api_league', 'data', 'https://www.fotmob.com/api/leagues?id=47'],
  ['fotmob', 'terms', 'terms', 'https://www.fotmob.com/terms'],
  ['whoscored', 'robots', 'robots', 'https://www.whoscored.com/robots.txt'],
  ['whoscored', 'home', 'data', 'https://www.whoscored.com/'],
  ['transfermarkt', 'robots', 'robots', 'https://www.transfermarkt.com/robots.txt'],
  ['espn_soccer', 'scoreboard', 'data', 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard'],
  ['espn_soccer', 'core_events', 'data', 'https://sports.core.api.espn.com/v2/sports/soccer/leagues/eng.1/events?limit=5'],

  // --- official league / federation ---------------------------------------
  ['premier_league', 'robots', 'robots', 'https://www.premierleague.com/robots.txt'],
  ['premier_league', 'terms', 'terms', 'https://www.premierleague.com/en/terms-and-conditions'],
  ['premier_league', 'pulselive_comps', 'data', 'https://footballapi.pulselive.com/football/competitions?page=0&pageSize=5'],
  ['uefa', 'robots', 'robots', 'https://www.uefa.com/robots.txt'],
  ['uefa', 'terms', 'terms', 'https://www.uefa.com/termsconditions/'],
  ['uefa', 'match_api', 'data', 'https://match.uefa.com/v5/matches?competitionId=1&seasonYear=2026&limit=5&offset=0&order=ASC'],
  ['laliga', 'robots', 'robots', 'https://www.laliga.com/robots.txt'],
  ['laliga', 'legal', 'terms', 'https://www.laliga.com/en-GB/legal/legal-web'],
  ['bundesliga', 'robots', 'robots', 'https://www.bundesliga.com/robots.txt'],
  ['bundesliga', 'terms', 'terms', 'https://www.bundesliga.com/en/bundesliga/info/terms-of-use-services'],
  ['bundesliga', 'legal_notices', 'terms', 'https://www.bundesliga.com/en/bundesliga/info/legal-notices'],
  ['serie_a', 'robots', 'robots', 'https://www.legaseriea.it/robots.txt'],
  ['ligue_1', 'robots', 'robots', 'https://ligue1.com/robots.txt'],
  ['mls', 'robots', 'robots', 'https://www.mlssoccer.com/robots.txt'],
  ['mls', 'terms', 'terms', 'https://www.mlssoccer.com/about/terms-of-service'],
  ['mls', 'stats_api', 'data', 'https://stats-api.mlssoccer.com/v1/matches/seasons/MLS-SEA-0001KA/competitions/MLS-COM-000001?per_page=5'],
  ['fifa', 'robots', 'robots', 'https://www.fifa.com/robots.txt'],
  ['fifa', 'terms', 'terms', 'https://www.fifa.com/en/legal/terms-of-service'],
  ['fifa', 'api_matches', 'data', 'https://api.fifa.com/api/v3/calendar/matches?idCompetition=17&idSeason=285023&count=5&language=en'],
  // YouTube channel feeds for the official-video lane (owner decision 2026-09-29: scheduled Worker lane via RSS).
  ['youtube_rss', 'robots', 'robots', 'https://www.youtube.com/robots.txt'],
  ['youtube_rss', 'terms', 'terms', 'https://www.youtube.com/t/terms'],
  ['youtube_rss', 'channel_feed', 'data', 'https://www.youtube.com/feeds/videos.xml?channel_id=UC6UL29enLNe4mqwTfAyeNuw'],
];

const TERMS_KEYWORDS = /(scrap|crawl|spider|robot|automated|data ?mining|harvest|extract|database|commercial|resell|redistribut|betting|gambling|wager|licen[cs]e|creative commons|cc[- ]by|cc0|public domain|attribution|non-commercial|api key|rate limit)/gi;

function fingerprint(status, headers, body) {
  const server = (headers.get('server') || '').toLowerCase();
  const text = body.slice(0, 4000).toLowerCase();
  const out = [];
  if (headers.get('cf-mitigated') === 'challenge' || /just a moment|cf-chl|challenge-platform/.test(text)) out.push('cloudflare_challenge');
  if (server.includes('akamai') || /access denied.*reference #/s.test(text) || headers.get('x-akamai-transformed')) out.push('akamai');
  if (/captcha|recaptcha|hcaptcha|turnstile/.test(text)) out.push('captcha_markup');
  if (/datadome/.test(text) || headers.get('x-datadome')) out.push('datadome');
  if (status === 401) out.push('auth_required');
  if (status === 403) out.push('forbidden');
  if (status === 429) out.push('rate_limited');
  return out;
}

function excerpts(text, max = 14) {
  const plain = text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  const hits = [];
  const seen = new Set();
  for (const m of plain.matchAll(TERMS_KEYWORDS)) {
    const start = Math.max(0, m.index - 160);
    const bucket = Math.floor(start / 300);
    if (seen.has(bucket)) continue;
    seen.add(bucket);
    hits.push(plain.slice(start, m.index + 200).trim());
    if (hits.length >= max) break;
  }
  return hits;
}

function robotsSummary(text) {
  // Keep the whole robots file if small; it is the evidence.
  return text.length <= 6000 ? text : text.slice(0, 6000) + '\n…[truncated]';
}

async function probe([source, name, kind, url]) {
  const started = Date.now();
  const rec = { source, probe: name, kind, url, captured_at: new Date().toISOString(), user_agent: UA };
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
    const buf = Buffer.from(await res.arrayBuffer());
    const body = buf.toString('utf8');
    rec.status = res.status;
    rec.final_url = res.url;
    rec.elapsed_ms = Date.now() - started;
    rec.bytes = buf.length;
    rec.sha256 = createHash('sha256').update(buf).digest('hex');
    rec.headers = Object.fromEntries(['content-type', 'server', 'cache-control', 'x-robots-tag', 'cf-ray', 'cf-mitigated', 'x-cache', 'access-control-allow-origin', 'last-modified', 'x-ratelimit-limit', 'x-requests-available-minute']
      .map(h => [h, res.headers.get(h)]).filter(([, v]) => v));
    rec.access_fingerprint = fingerprint(res.status, res.headers, body);
    if (kind === 'robots') rec.robots_txt = robotsSummary(body);
    else if (kind === 'terms') rec.terms_excerpts = excerpts(body);
    else {
      rec.body_head = body.slice(0, 700);
      if ((res.headers.get('content-type') || '').includes('json')) {
        try { const j = JSON.parse(body); rec.json_top_level = Array.isArray(j) ? { array_length: j.length, first_keys: Object.keys(j[0] || {}).slice(0, 25) } : { keys: Object.keys(j).slice(0, 25) }; } catch { rec.json_parse = 'failed'; }
      }
    }
  } catch (err) {
    rec.error = String(err && (err.cause?.code || err.cause?.message || err.message || err));
    rec.elapsed_ms = Date.now() - started;
  }
  return rec;
}

async function main() {
  const onlyArg = process.argv.indexOf('--only');
  const only = onlyArg > 0 ? new Set(process.argv[onlyArg + 1].split(',')) : null;
  mkdirSync(OUT, { recursive: true });
  const probes = PROBES.filter(p => !only || only.has(p[0]));
  const summary = [];
  // Sequential and polite: one request at a time.
  for (const p of probes) {
    const rec = await probe(p);
    writeFileSync(join(OUT, `${rec.source}__${rec.probe}.json`), JSON.stringify(rec, null, 2) + '\n');
    summary.push({ source: rec.source, probe: rec.probe, kind: rec.kind, status: rec.status ?? null, error: rec.error ?? null, bytes: rec.bytes ?? 0, flags: rec.access_fingerprint ?? [] });
    console.log(`${rec.source.padEnd(20)} ${rec.probe.padEnd(22)} ${String(rec.status ?? rec.error).padEnd(12)} ${String(rec.bytes ?? '').padStart(9)}  ${(rec.access_fingerprint || []).join(',')}`);
  }
  if (!only) writeFileSync(join(OUT, '_summary.json'), JSON.stringify(summary, null, 2) + '\n');
}

main();
