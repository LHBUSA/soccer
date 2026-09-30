import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzer, historicalBaseline } from '../workers/soccer-api/src/pro/analyzer.js';
import { teamProfile } from '../workers/soccer-api/src/pro/matchup.js';
import { proAnalyzer, publicAnalyzerPreview } from '../workers/soccer-api/src/pro/routes.js';
const games=(gf,ga,sig='espn:source')=>Array.from({length:5},()=>({gf,ga,stat_signature:sig,stats:{shots:12,shots_on_target:5},opp_stats:{shots:8,shots_on_target:3},event_family:'espn'}));
test('analyzer arithmetic: named components reconcile to bounded descriptive rating',()=>{
 const x=analyzer({homeGames:games(2,0),awayGames:games(1,2),competition:'bundesliga',season:'2026/27'});
 const lean=x.components.reduce((a,c)=>a+c.edge*c.weight,0);
 assert.equal(x.rating.home,Math.round(50+50*lean)); assert.equal(x.rating.away,Math.round(50-50*lean));
 assert.equal(x.rating.home+x.rating.away,100);
 for(const c of x.components) { assert.ok(c.edge>=-1&&c.edge<=1);assert.ok(c.basis);assert.ok(c.explanation);assert.equal(c.sample.home,5);assert.ok(c.coverage); }
 assert.match(x.rating_label,/Not a win probability/);
});
test('no data: no fabricated score, no component values; weak sample cannot produce rating',()=>{
 const x=analyzer({});assert.equal(x.rating,null);assert.deepEqual(x.components,[]);assert.equal(x.head_to_head,null);assert.match(x.coverage.label,/WEAK DATA/);
 assert.equal(analyzer({homeGames:games(2,0).slice(0,2),awayGames:games(1,1)}).rating,null);
 const p=teamProfile([{gf:1,ga:0,home:true,stats:{shots:8,shots_on_target:null},opp_stats:{shots:5,shots_on_target:null}}]);
 assert.equal(p.shots_on_target_for_pg,null);assert.equal(p.shots_on_target_against_pg,null);
});
test('incompatible source samples omit shot comparisons; missing SoT is never zero',()=>{
 const x=analyzer({homeGames:games(2,0),awayGames:games(1,1,'wyscout_figshare:derived')});
 assert.ok(!x.components.some(c=>c.group==='style'));
 const h=games(2,0);h.forEach(g=>{g.stats.shots_on_target=null;g.opp_stats.shots_on_target=null;});
 const y=analyzer({homeGames:h,awayGames:games(1,1)});assert.ok(!y.components.some(c=>c.key==='sot_diff'));assert.ok(y.components.some(c=>c.key==='shots'));
});
test('historical baseline is match-weighted, competition scoped, goals-only',()=>{
 const row=(slug,season,p,gf)=>({competition:{slug},season,league_record:{played:p,goals_for:gf,goals_against:p}});
 const b=historicalBaseline({seasons:[row('bundesliga','2024/25',10,30),row('cup','2025',5,100),row('bundesliga','2025/26',20,20),row('bundesliga','2026/27',4,20)]},'bundesliga','2026/27',5);
 assert.equal(b.matches,30);assert.equal(b.goals_for_pg,1.67);assert.deepEqual(b.seasons,['2024/25','2025/26']);
});
test('head-to-head excludes future meetings and requires two actual score pairs',()=>{
 const m=(date,hs,as)=>({kickoff_at:date,status:'finished',home_team_id:'h',away_team_id:'a',home_score:hs,away_score:as});
 const args={homeId:'h',awayId:'a',asOf:'2026-09-30',h2h:[m('2026-09-01',1,0),m('2026-09-10',2,2),m('2026-10-01',9,0),m('2026-08-01',null,null)]};
 const x=analyzer(args);assert.equal(x.head_to_head.matches.length,2);assert.equal(x.head_to_head.home_goals,3);assert.equal(x.head_to_head.away_goals,2);
});
test('premium analyzer denies before any canonical or history read',async()=>{
 let n=0;const s={select:()=>{n++;throw new Error('read');}};
 const x=await proAnalyzer(s,'missing',{granted:false,membership:{state:'free'}});assert.equal(x.status,403);assert.equal(n,0);assert.equal(x.body.data,undefined);
});

test('public analyzer preview returns only selected rows and keeps the composite score private',async()=>{
 const id='00000000-0000-5000-8000-000000000901', home='00000000-0000-5000-8000-000000000902', away='00000000-0000-5000-8000-000000000903', comp='00000000-0000-5000-8000-000000000904', season='00000000-0000-5000-8000-000000000905';
 const s={select:async(table,q)=> table==='soccer_matches'&&q.eq?.id===id?[{id,season_id:season,competition_id:comp,kickoff_at:'2026-10-01T12:00:00Z',home_team_id:home,away_team_id:away}]:table==='soccer_seasons'?[{label:'2026/27'}]:table==='soccer_competitions'?[{id:comp,slug:'bundesliga'}]:[]};
 const x=await publicAnalyzerPreview(s,id); assert.equal(x.status,200); assert.deepEqual(x.body.data.components,[]); assert.equal(x.body.data.rating,undefined); assert.equal(x.body.data.formula,undefined); assert.match(x.body.data.coverage.label,/WEAK DATA/);
});
