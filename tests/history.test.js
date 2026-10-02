import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMigrations, openPglite } from '../workers/soccer-ingest/src/store-pglite.js';
import { aggregateResults, teamHistory } from '../workers/soccer-api/src/history.js';
const U = n => `00000000-0000-5000-8000-${String(n).padStart(12,'0')}`;
test('history API: multiple chronological seasons, competition isolation, canonical score reconciliation, no invented finish', async () => {
  const s = await openPglite(); await applyMigrations(s);
  try {
    await s.insert('soccer_competitions', [{id:U(1),slug:'bundesliga',name:'Bundesliga',comp_type:'league'},{id:U(2),slug:'cup',name:'Cup',comp_type:'international_tournament'}]);
    await s.insert('soccer_teams', [10,11].map(n=>({id:U(n),slug:`team-${n}`,name:`Team ${n}`,team_type:'club',founding_provider:'espn',founding_external_id:String(n)})));
    await s.insert('soccer_seasons', [{id:U(20),competition_id:U(1),label:'2024/25', publication_state: 'published', published_at: '2026-01-01T00:00:00Z'},{id:U(21),competition_id:U(1),label:'2025/26', publication_state: 'published', published_at: '2026-01-01T00:00:00Z'},{id:U(22),competition_id:U(2),label:'2025', publication_state: 'published', published_at: '2026-01-01T00:00:00Z'}]);
    await s.insert('soccer_stages', [20,21,22].map(n=>({id:U(n+10),season_id:U(n),name:'Stage',stage_type:n===22?'knockout':'league',stage_order:1})));
    const m=(n,season,home,hs,as)=>({id:U(n),season_id:U(season),competition_id:U(season===22?2:1),stage_id:U(season+10),kickoff_at:`${season===20?'2024':'2025'}-09-${season===21?'20':'10'}T12:00:00Z`,status:'finished',home_team_id:U(home?10:11),away_team_id:U(home?11:10),home_score:hs,away_score:as,result_provider:'espn'});
    const ms=[m(100,20,true,3,1),m(101,21,false,2,2),m(102,22,true,0,1)]; await s.insert('soccer_matches',ms);
    const env=await teamHistory(s,'team-10'); const d=env.data;
    assert.deepEqual(d.seasons.map(r=>r.season),['2024/25','2025','2025/26']);
    const league=d.competitions.find(c=>c.slug==='bundesliga').summary; assert.deepEqual([league.played,league.won,league.drawn,league.lost,league.goals_for,league.goals_against],[2,1,1,0,5,3]);
    assert.equal(d.seasons.find(r=>r.season==='2025').points,null); assert.ok(d.seasons.every(r=>r.table_finish===null));
    assert.equal(d.summary.goals_for,5); assert.equal(d.summary.goals_against,4); assert.equal(d.summary.played,3);
    assert.equal(d.seasons[0].home.won,1); assert.equal(d.seasons.at(-1).away.drawn,1);
  } finally { await s.db.close(); }
});
test('unknown scores excluded; known 0-0 remains an actual draw; knockout points absent', () => {
  const m=(hs,as)=>({home_team_id:'a',away_team_id:'b',status:'finished',home_score:hs,away_score:as});
  const r=aggregateResults([m(null,null),m(0,0),m(2,0)],'a'); assert.deepEqual([r.played,r.drawn,r.won,r.goals_for],[2,1,1,2]); assert.equal(r.points,null); assert.equal(aggregateResults([m(null,0)],'a').goals_per_match,null);
});
