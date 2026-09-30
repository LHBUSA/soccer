// Deterministic, descriptive comparisons. No model weights or predictive confidence.
import { aggregateResults } from '../history.js';
export const ANALYZER_VERSION = 'soccer-analyzer/2.0.0';
const mean = xs => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : null;
const r2 = n => Number.isFinite(n) ? Math.round(n*100)/100 : null;
const clamp = n => Math.max(-1,Math.min(1,n));
export function historicalBaseline(history, competition, currentSeason, n) {
  const rows = (history?.seasons || []).filter(s=>s.competition?.slug===competition && s.season!==currentSeason && s.league_record.played>0).slice(-n);
  const matches = rows.reduce((a,s)=>a+s.league_record.played,0);
  return matches ? { seasons:rows.map(s=>s.season), matches, goals_for_pg:r2(rows.reduce((a,s)=>a+s.league_record.goals_for,0)/matches), goals_against_pg:r2(rows.reduce((a,s)=>a+s.league_record.goals_against,0)/matches), basis:'Match-weighted canonical league/group-stage goals in stored seasons; event/stat metrics are not compared across eras.' } : null;
}
export function analyzer({homeGames=[],awayGames=[],homeSeason=[],awaySeason=[],homeId,awayId,homeLoad=null,awayLoad=null,homeSquad=null,awaySquad=null,homeHistory=null,awayHistory=null,competition,season,h2h=[],asOf}) {
  const components=[], omitted=[];
  const add=(key,label,h,a,hs,as,scale,lower,basis,unit,group='results',minimum=3,ht=homeGames.length,at=awayGames.length)=>{
    if(!Number.isFinite(h)||!Number.isFinite(a)||hs<minimum||as<minimum) { omitted.push({key,label,minimum,reason:'Missing, incompatible or insufficient paired coverage.'}); return; }
    const edge=r2(clamp((h-a)/scale)*(lower?-1:1));
    components.push({key,label,home:r2(h),away:r2(a),edge,scale,lower_is_better:lower,unit,group,sample:{home:hs,away:as},coverage:{home:{available:hs,total:ht},away:{available:as,total:at}},basis,normalization:'clamp((home - away) / scale, -1, 1), inverted for lower-is-better',explanation:`Home: ${r2(h)} ${unit}; away: ${r2(a)} ${unit}. Samples: ${hs} / ${as}. ${basis}`});
  };
  const ppg=gs=>mean(gs.map(g=>g.gf>g.ga?3:g.gf===g.ga?1:0));
  for(const n of [5,10]) { const h=homeGames.slice(0,n), a=awayGames.slice(0,n); add(`form${n}`,`Recent form · last ${n}`,ppg(h),ppg(a),h.length,a.length,1.5,false,'Canonical results in the same competition-season league/group stages; 3/1/0 result points.','pts/m'); }
  for(const [key,label,value,lower,scale] of [['scoring','Recent scoring',g=>g.gf,false,1.5],['conceding','Recent conceding',g=>g.ga,true,1.5],['gd','Recent goal differential',g=>g.gf-g.ga,false,2]]) add(key,label,mean(homeGames.map(value)),mean(awayGames.map(value)),homeGames.length,awayGames.length,scale,lower,'Last ten stored score pairs in the same competition-season league/group stages.','goals/m');
  const H=aggregateResults(homeSeason,homeId,true), A=aggregateResults(awaySeason,awayId,true);
  add('season_scoring','Season scoring',H.goals_per_match,A.goals_per_match,H.played,A.played,1.5,false,'Current competition-season league/group-stage results.','goals/m','results',3,H.played,A.played);
  add('season_conceding','Season conceding',H.goals_allowed_per_match,A.goals_allowed_per_match,H.played,A.played,1.5,true,'Current competition-season league/group-stage results.','goals/m','results',3,H.played,A.played);
  add('venue','Home / away split',H.home.points_per_game,A.away.points_per_game,H.home.played,A.away.played,1.5,false,'Home team at home and away team away; same competition-season league/group stages.','pts/m','results',3,H.played,A.played);
  for(const [key,label,metric,mode,scale,lower] of [['shots','Shot creation','shots','own',6,false],['suppression','Shot suppression','shots','opp',6,true],['shot_diff','Shot differential','shots','diff',6,false],['sot_diff','Shots-on-target differential','shots_on_target','diff',3,false]]) {
    const usable=gs=>gs.filter(g=>g.stat_signature&&Number.isFinite(g.stats?.[metric])&&Number.isFinite(g.opp_stats?.[metric]));
    const h=usable(homeGames),a=usable(awayGames);
    const signatures=[...new Set(h.map(g=>g.stat_signature))].filter(s=>a.some(g=>g.stat_signature===s));
    const count=(gs,s)=>gs.filter(g=>g.stat_signature===s).length;
    const sig=signatures.sort((x,y)=>Math.min(count(h,y),count(a,y))-Math.min(count(h,x),count(a,x))||x.localeCompare(y))[0];
    const hh=h.filter(g=>g.stat_signature===sig),aa=a.filter(g=>g.stat_signature===sig);
    const value=g=>mode==='own'?g.stats[metric]:mode==='opp'?g.opp_stats[metric]:g.stats[metric]-g.opp_stats[metric];
    add(key,label,mean(hh.map(value)),mean(aa.map(value)),hh.length,aa.length,scale,lower,`Paired team/opponent ${metric}; compatible provider and basis: ${sig||'none'}.`,'shots/m','style');
  }
  // A sample is an observed prior match, never an inferred rest period with no history.
  const seenH=homeLoad?.last_match_id?1:0,seenA=awayLoad?.last_match_id?1:0;
  add('rest','Days since last match',homeLoad?.days_since_last,awayLoad?.days_since_last,seenH,seenA,7,false,'Calendar days at as-of time; all competitions. Rest comparison, not fitness.','days','schedule',1,1,1);
  add('load7','Recent schedule load',homeLoad?.matches_7,awayLoad?.matches_7,seenH,seenA,3,true,'Canonical matches played in seven days, all competitions; fewer fixtures = lower schedule load.','matches','schedule',1,1,1);
  add('xi','XI continuity',homeSquad?.xi_continuity,awaySquad?.xi_continuity,homeSquad?.matches_considered||0,awaySquad?.matches_considered||0,0.3,false,'Consecutive sourced starting XIs; fraction retained. Not a selection forecast.','fraction','schedule',2,homeSquad?.matches_considered||0,awaySquad?.matches_considered||0);
  const weights={results:0.5,style:0.3,schedule:0.2};const groups=[...new Set(components.map(c=>c.group))];const sum=groups.reduce((a,g)=>a+weights[g],0);
  let lean=0;for(const c of components) { const w=weights[c.group]/components.filter(x=>x.group===c.group).length/(sum||1);c.weight=w;c.contribution=r2(50*w*c.edge);lean+=w*c.edge; }
  const rating=homeGames.length>=3&&awayGames.length>=3&&components.length>=3?{home:Math.round(50+50*lean),away:Math.round(50-50*lean),components_used:components.length,components_total:components.length+omitted.length}:null;
  const context=(history,current)=>[3,5].map(n=>{const b=historicalBaseline(history,competition,season,n);return b?{window:n,...b,current_matches:current.played,current_goals_for_pg:current.goals_per_match,current_goals_against_pg:current.goals_allowed_per_match,scoring_change:current.played?r2(current.goals_per_match-b.goals_for_pg):null,conceding_change:current.played?r2(current.goals_allowed_per_match-b.goals_against_pg):null}:null;}).filter(Boolean);
  const meetings=h2h.filter(m=>m.status==='finished'&&Number.isInteger(m.home_score)&&Number.isInteger(m.away_score)&&Date.parse(m.kickoff_at)<Date.parse(asOf));
  const coverage=(games,squad,hist)=>({matches:games.length,lineups:squad?.matches_considered||0,paired_stats:games.filter(g=>g.stat_signature&&Number.isFinite(g.stats?.shots)&&Number.isFinite(g.opp_stats?.shots)).length,events:games.filter(g=>g.event_family).length,historical_seasons:hist?.seasons.filter(s=>s.competition?.slug===competition).length||0,top11_minute_share:squad?.top11_minute_share??null});
  return {version:ANALYZER_VERSION,as_of:asOf,competition,season,rating,rating_label:'PBE MATCHUP RATING: descriptive component score. Not a win probability or prediction.',formula:'Results 50%, compatible shot stats 30%, schedule/XI 20%; equal weights within each available group, groups renormalized when absent. Home = round(50 + 50 × weighted edge), away = round(50 - 50 × weighted edge). Scales are display normalizations, not fitted predictive weights. Rating requires at least three result matches per side.',components,omitted,historical_context:{home:context(homeHistory,H),away:context(awayHistory,A)},head_to_head:meetings.length>=2?{matches:meetings,home_goals:meetings.reduce((a,m)=>a+(m.home_team_id===homeId?m.home_score:m.away_score),0),away_goals:meetings.reduce((a,m)=>a+(m.home_team_id===awayId?m.home_score:m.away_score),0)}:null,coverage:{home:coverage(homeGames,homeSquad,homeHistory),away:coverage(awayGames,awaySquad,awayHistory),label:!rating?'WEAK DATA · RATING WITHHELD':components.some(c=>c.group==='style')?'RESULTS + COMPATIBLE STATS':'RESULTS / SCHEDULE ONLY',basis:'Coverage of stored observations, never predictive confidence. National-team results never enter club-league comparison samples.'}};
}
