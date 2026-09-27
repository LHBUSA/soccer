#!/usr/bin/env node
// Vertical-proof step 2: canonical match -> evidence packet -> gated article -> match page.
// Loads the PGlite snapshot produced by scripts/backfill/proof-bundesliga-2017.mjs.
//
// Usage: node scripts/news/proof-article.mjs ["Home Team" "Away Team"]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { ATTRIBUTION as WY_ATTR } from '../../workers/providers/wyscout-figshare.js';
import { ATTRIBUTION as OL_ATTR } from '../../workers/providers/openligadb.js';
import { buildMatchRecapPacket } from '../../workers/soccer-news/src/packet.js';
import { composeMatchRecap } from '../../workers/soccer-news/src/compose.js';
import { runGates } from '../../workers/soccer-news/src/gates.js';
import { renderMatchPage } from '../../workers/shared/render/match-page.js';
import { uuidv5 } from '../../workers/shared/ids.js';

const [homeName = 'Bayern München', awayName = 'Borussia Dortmund'] = process.argv.slice(2);
const db = new PGlite({ loadDataDir: new Blob([readFileSync('.proof/bundesliga-2017-18.pgdata.tar.gz')]) });
await db.waitReady;
const store = { query: (s, p = []) => db.query(s, p) };

const { rows: [m] } = await db.query(`
  select m.id from soccer_matches m join soccer_teams h on h.id = m.home_team_id join soccer_teams a on a.id = m.away_team_id
   join soccer_seasons s on s.id = m.season_id where h.name = $1 and a.name = $2 and s.label = '2017/18'`, [homeName, awayName]);
if (!m) throw new Error(`no 2017/18 match ${homeName} v ${awayName}`);

const attributions = [WY_ATTR, OL_ATTR];
const packet = await buildMatchRecapPacket(store, m.id, { attributions });
const article = composeMatchRecap(packet);
const gates = runGates(article, packet, { requiredAttributions: attributions });

// Adversarial check: the same gates must reject an article with one invented number.
const tampered = structuredClone(article);
tampered.sections[2].paragraphs[0] = tampered.sections[2].paragraphs[0].replace(/had (\d+) shots/, (_, n) => `had ${Number(n) + 7} shots`);
const tamperedGates = runGates(tampered, packet, { requiredAttributions: attributions });

// Persist: news event -> frozen packet -> article. An archive recap is HELD:
// it is a proof of the pipeline, not current news, and is not indexable.
const newsEventId = packet.event.event_id;
await db.query(`insert into soccer_news_events (id, story_class, desk, match_id, team_ids, competition_id, materiality, as_of, status)
  select $1,'match_recap',$2,$3, array[$4::uuid,$5::uuid], m.competition_id, $6, $7, 'composed' from soccer_matches m where m.id = $3 on conflict (id) do nothing`,
  [newsEventId, article.desk, m.id, packet.teams.home.id, packet.teams.away.id, Math.min(1, 0.4 + 0.1 * packet.match.margin), packet.event.as_of]);
await db.query(`insert into soccer_article_evidence (packet_hash, news_event_id, packet_version, packet, capture_ids) values ($1,$2,$3,$4,$5) on conflict do nothing`,
  [packet.hash, newsEventId, packet.version, JSON.stringify(packet), packet.provenance.source_results.map(r => r.capture_id).filter(Boolean)]);
let immutable = false;
try { await db.query(`update soccer_article_evidence set packet_version = 'tampered' where packet_hash = $1`, [packet.hash]); } catch { immutable = true; }
const holdReasons = [...gates.failed, ...(packet.event.archive ? ['archive_match_not_current_news'] : [])];
await db.query(`insert into soccer_articles (id, slug, news_event_id, packet_hash, story_class, desk, headline, dek, body, entities, composer, gate_version, gate_results, status, hold_reasons)
  values ($1,$2,$3,$4,'match_recap',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) on conflict (id) do nothing`,
  [uuidv5(`article:${packet.hash}`), article.slug, newsEventId, packet.hash, article.desk, article.headline, article.dek, JSON.stringify(article.sections), JSON.stringify(article.entities), article.composer, gates.version, JSON.stringify(gates.results), holdReasons.length ? 'held' : 'draft', holdReasons]);

// Match page inputs from the ledger.
const { rows: lp } = await db.query(`
  select l.team_id, p.display_name name, p.slug, lp.is_starter,
         coalesce((select minute from soccer_substitutions s where s.match_id = l.match_id and s.player_out_id = lp.player_id),
                  (select minute from soccer_substitutions s where s.match_id = l.match_id and s.player_in_id = lp.player_id)) sub_minute,
         exists(select 1 from soccer_substitutions s where s.match_id = l.match_id and s.player_in_id = lp.player_id) came_on
    from soccer_lineups l join soccer_lineup_players lp on lp.lineup_id = l.id join soccer_players p on p.id = lp.player_id
   where l.match_id = $1 order by lp.is_starter desc, p.display_name`, [m.id]);
const lineups = { home: [], away: [] };
for (const r of lp) if (r.is_starter || r.came_on) lineups[r.team_id === packet.teams.home.id ? 'home' : 'away'].push(r);
const { rows: tlRows } = await db.query(`
  select e.minute, e.team_id, e.event_type, e.subtype, e.outcome, e.card, e.is_goal, e.is_own_goal, p.display_name
    from soccer_match_events e left join soccer_players p on p.id = e.player_id
   where e.match_id = $1 and (e.is_goal or e.is_own_goal or e.card is not null) order by e.sequence`, [m.id]);
const { rows: subRows } = await db.query(`select s.minute, s.team_id, pi.display_name pin, po.display_name pout from soccer_substitutions s
  join soccer_players pi on pi.id = s.player_in_id join soccer_players po on po.id = s.player_out_id where s.match_id = $1`, [m.id]);
const timeline = [
  ...tlRows.map(e => ({ minute: e.minute, team: e.team_id === packet.teams.home.id ? 'home' : 'away', label: e.is_goal ? `⚽ ${e.display_name}` : e.is_own_goal ? `⚽ OG ${e.display_name}` : `${e.card === 'yellow' ? '🟨' : '🟥'} ${e.display_name}` })),
  ...subRows.map(s => ({ minute: s.minute, team: s.team_id === packet.teams.home.id ? 'home' : 'away', label: `⇄ ${s.pin} for ${s.pout}` })),
].sort((a, b) => a.minute - b.minute);

mkdirSync('docs/evidence/proof', { recursive: true });
writeFileSync('docs/evidence/proof/packet-bayern-dortmund-2018-03-31.json', JSON.stringify(packet, null, 2) + '\n');
writeFileSync('docs/evidence/proof/article-bayern-dortmund-2018-03-31.json', JSON.stringify({ article, gates, tampered_gates: { pass: tamperedGates.pass, failed: tamperedGates.failed, detail: tamperedGates.results.find(r => r.gate === 'numeric_grounding').detail }, packet_immutable: immutable, status: holdReasons.length ? 'held' : 'draft', hold_reasons: holdReasons }, null, 2) + '\n');
writeFileSync('docs/evidence/proof/match-bayern-dortmund-2018-03-31.html', renderMatchPage({ packet, article, lineups, timeline }));
console.log(article.headline);
console.log('gates pass:', gates.pass, gates.failed);
console.log('tampered article rejected:', !tamperedGates.pass, tamperedGates.failed, tamperedGates.results.find(r => r.gate === 'numeric_grounding').detail);
console.log('packet immutable:', immutable, '| status:', holdReasons.length ? 'held' : 'draft', holdReasons);
await db.close();
