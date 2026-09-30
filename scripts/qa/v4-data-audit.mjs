// Read-only canonical audit and real candidate history/analyzer artifacts. Never writes production.
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {storeFromEnv} from '../../workers/shared/postgrest.js';
import {teamHistory} from '../../workers/soccer-api/src/history.js';
import {proAnalyzer} from '../../workers/soccer-api/src/pro/routes.js';
const env=Object.fromEntries(readFileSync('D:/Workers/secrets/soccer-supabase.env','utf8').split(String.fromCharCode(10)).filter(l=>l.includes('=')).map(l=>[l.slice(0,l.indexOf('=')).trim(),l.slice(l.indexOf('=')+1).trim()]));
const store=storeFromEnv(env,{fetch:(url,opts)=>{if(!['GET','HEAD'].includes(opts.method))throw Error('read-only audit');return fetch(url,opts);}});
const comps=await store.select('soccer_competitions',{columns:['id','slug','name','comp_type']});
const international=[];
for(const c of comps.filter(c=>c.comp_type==='international_tournament')){
 const seasons=await store.select('soccer_seasons',{columns:['id','label'],eq:{competition_id:c.id}});
 const matches=await store.select('soccer_matches',{columns:['id','home_team_id','away_team_id','status','kickoff_at'],eq:{competition_id:c.id},order:'kickoff_at.asc'});
 const teams=matches.length?await store.select('soccer_teams',{columns:['id','slug','team_type','country_code'],in:{id:[...new Set(matches.flatMap(m=>[m.home_team_id,m.away_team_id]))]}}):[];
 let lineups=0,events=0,stats=0,players=new Set(),groups=0,standings=0;
 for(let i=0;i<matches.length;i+=100){const ids=matches.slice(i,i+100).map(m=>m.id);
  const ls=await store.select('soccer_lineups',{columns:['id'],in:{match_id:ids}});lineups+=ls.length;
  events+=await store.count('soccer_match_events',{in:{match_id:ids}});
  stats+=await store.count('soccer_team_match_stats',{in:{match_id:ids}});
  if(ls.length)for(const p of await store.select('soccer_lineup_players',{columns:['player_id'],in:{lineup_id:ls.map(l=>l.id)}}))players.add(p.player_id);
 }
 if(seasons.length){const gs=await store.select('soccer_season_groups',{columns:['id','group_type','group_key'],in:{season_id:seasons.map(s=>s.id)}});groups=gs.length;if(gs.length)standings=await store.count('soccer_source_standings',{in:{group_id:gs.map(g=>g.id)}});}
 international.push({competition:c.slug,seasons:seasons.map(s=>s.label),matches:matches.length,finished:matches.filter(m=>m.status==='finished').length,scheduled:matches.filter(m=>m.status==='scheduled').length,national_teams:teams.filter(t=>t.team_type==='national').length,team_identities:teams,lineups,canonical_players:players.size,events,team_stat_rows:stats,groups,standings_rows:standings,first_stored_match:matches[0]?.kickoff_at,last_stored_match:matches.at(-1)?.kickoff_at});
}
mkdirSync('docs/evidence/v4',{recursive:true});
writeFileSync('docs/evidence/v4/international-audit.json',JSON.stringify({at:new Date().toISOString(),canonical_competitions:comps.map(c=>c.slug),world_cup:international.find(c=>c.competition==='fifa-world-cup')||{canonical:false,matches_2026:0,matches_2018:0},international,fifa_rankings:{supported:false,basis:'No approved FIFA ranking source/ingestion/table contract in repository.'}},null,2));
const history=await teamHistory(store,'bayern-munchen');writeFileSync('docs/evidence/v4/bayern-history.json',JSON.stringify(history,null,2));
const [bl]=comps.filter(c=>c.slug==='bundesliga');
const [m]=await store.select('soccer_matches',{columns:['id','kickoff_at','home_team_id','away_team_id'],eq:{competition_id:bl.id,status:'scheduled'},order:'kickoff_at.asc',limit:1});
if(m){const out=await proAnalyzer(store,m.id,{granted:true});writeFileSync('docs/evidence/v4/analyzer-canonical.json',JSON.stringify(out.body,null,2));writeFileSync('docs/evidence/v4/analyzer-match.json',JSON.stringify({id:m.id,kickoff_at:m.kickoff_at,home:(await store.select('soccer_teams',{columns:['slug','name','short_name'],eq:{id:m.home_team_id},limit:1}))[0],away:(await store.select('soccer_teams',{columns:['slug','name','short_name'],eq:{id:m.away_team_id},limit:1}))[0]},null,2));}
console.log(JSON.stringify({international:international.map(({team_identities,...c})=>c),history_seasons:history.data.seasons.length,history_matches:history.data.summary.played,analyzer_match:m?.id,store_requests:store.requests}));
