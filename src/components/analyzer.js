import { esc, join } from '../lib/html.js';
import { num, dateShort } from '../lib/format.js';
import { sectionHead, sourcePanel, errorState } from './ui.js';
import { proGet } from '../lib/pro.js';

const coverageSide = (name,c) => '<div><h3>'+esc(name)+'</h3><dl>'+join([['Result matches',c.matches],['Sourced XIs (21-day workload window)',c.lineups],['Paired shot-stat matches',c.paired_stats],['Event-ledger matches',c.events],['Stored competition-seasons',c.historical_seasons],['Top-11 nominal minute share',c.top11_minute_share===null?null:Math.round(c.top11_minute_share*100)+'%']],([k,v])=>'<div><dt>'+esc(k)+'</dt><dd>'+(typeof v==='string'?esc(v):num(v))+'</dd></div>')+'</dl></div>';
export function analyzerView(d, match) {
  const side = key => match[key]?.short_name || match[key]?.name || (key==='home'?'Home':'Away');
  const card = c => '<article class="edge-row"><header><h3>'+esc(c.label)+'</h3><span class="edge-tag">'+(c.edge===0?'LEVEL':c.edge>0?esc(side('home')):esc(side('away')))+'</span></header><div class="edge-values"><b>'+num(c.home,{dp:2})+' <small>'+esc(c.unit)+'</small></b><b>'+num(c.away,{dp:2})+' <small>'+esc(c.unit)+'</small></b></div><div class="edge-axis" role="img" aria-label="Normalized home edge '+esc(String(c.edge))+' on a scale from minus one to one"><i style="left:'+(c.edge<0?50+c.edge*50:50)+'%;width:'+Math.abs(c.edge)*50+'%" class="'+(c.edge<0?'away':'home')+'"></i><span></span></div><p class="edge-meta">EDGE '+num(c.edge,{dp:2})+' / 1 · SAMPLE '+num(c.sample.home)+' / '+num(c.sample.away)+' · COVERAGE '+num(c.coverage.home.available)+'/'+num(c.coverage.home.total)+' home, '+num(c.coverage.away.available)+'/'+num(c.coverage.away.total)+' away</p><details><summary>BASIS & NORMALIZATION</summary><p>'+esc(c.basis)+'</p><p>'+esc(c.normalization)+'. Scale: '+num(c.scale,{dp:2})+'. Weight: '+num(c.weight*100,{dp:1})+'% of available components.</p></details></article>';
  const groups = [['results','RESULTS & FORM'],['style','STYLE / SHOT DATA'],['schedule','SCHEDULE & XI']];
  const history = (key,rows) => '<div><h3>'+esc(side(key))+'</h3>'+(rows.length?join(rows,b=>'<div class="baseline-row"><p>'+num(b.seasons.length)+' stored seasons in the last '+num(b.window)+' available season window · '+num(b.matches)+' baseline matches</p><p>Scoring: <b>'+num(b.current_goals_for_pg,{dp:2})+'</b> current / '+num(b.goals_for_pg,{dp:2})+' baseline · change '+num(b.scoring_change,{dp:2})+'</p><p>Conceding: <b>'+num(b.current_goals_against_pg,{dp:2})+'</b> current / '+num(b.goals_against_pg,{dp:2})+' baseline · change '+num(b.conceding_change,{dp:2})+'</p><small>'+esc(b.seasons.join(', '))+' · '+num(b.current_matches)+' current matches. '+esc(b.basis)+'</small></div>'):'<p class="muted">No earlier compatible stored season baseline.</p>')+'</div>';
  const h2h=d.head_to_head;
  return '<section class="analyzer">'+sectionHead('PBE MATCHUP ANALYZER','The evidence behind the matchup')+'<p class="analyzer-note">Descriptive pre-match comparisons · '+esc(d.competition)+' '+esc(d.season || '')+' · as of '+esc(d.as_of)+'. No win probability or prediction.</p><div class="analyzer-rating"><span>'+esc(side('home'))+'<b>'+num(d.rating?.home)+'</b></span><div><strong>'+esc(d.coverage.label)+'</strong><p>Component score / 100</p></div><span>'+esc(side('away'))+'<b>'+num(d.rating?.away)+'</b></span></div><details class="analyzer-formula"><summary>HOW THE COMPONENT SCORE WORKS</summary><p>'+esc(d.formula)+'</p></details>'+
    join(groups,([key,title])=>d.components.some(c=>c.group===key)?'<h3 class="analyzer-group">'+title+'</h3><div class="edge-grid">'+join(d.components.filter(c=>c.group===key),card)+'</div>':'')+
    sectionHead('WHY THE EDGE EXISTS','Deterministic facts, visible inputs')+'<ul class="analyzer-explanations">'+join(d.components,c=>'<li>'+esc(c.explanation)+'</li>')+'</ul>'+
    sectionHead('HISTORICAL CONTEXT','Each side against its own stored baseline')+'<div class="baseline-grid">'+history('home',d.historical_context.home)+history('away',d.historical_context.away)+'</div>'+
    sectionHead('HEAD-TO-HEAD','Canonical meetings before this matchup')+(h2h?'<p>'+num(h2h.matches.length)+' stored meetings · '+esc(side('home'))+' '+num(h2h.home_goals)+' goals / '+esc(side('away'))+' '+num(h2h.away_goals)+' goals</p><ul class="h2h-list">'+join(h2h.matches,m=>{const home=m.home_team_id===d.home_id;return '<li><a href="/matches/'+esc(m.id)+'" data-link>'+esc(dateShort(m.kickoff_at))+' · '+esc(home?side('home'):side('away'))+' <b>'+num(m.home_score)+'–'+num(m.away_score)+'</b> '+esc(home?side('away'):side('home'))+' · '+esc(m.competition || '')+'</a></li>';})+'</ul>':'<p class="muted">Fewer than two stored canonical meetings. No head-to-head summary.</p>')+
    sectionHead('DATA COVERAGE','Observation depth, not predictive confidence')+'<div class="coverage-grid">'+coverageSide(side('home'),d.coverage.home)+coverageSide(side('away'),d.coverage.away)+'</div><p class="caveat">'+esc(d.coverage.basis)+'</p>'+
    (d.omitted.length?'<details><summary>'+num(d.omitted.length)+' unavailable components omitted</summary><ul>'+join(d.omitted,c=>'<li>'+esc(c.label)+': '+esc(c.reason)+' Minimum sample: '+num(c.minimum)+'</li>')+'</ul></details>':'')+'</section>';
}

export function analyzerPreviewHtml(d, match) {
  const name = k => match[k]?.short_name || match[k]?.name || (k === 'home' ? 'Home' : 'Away');
  const rows = d.components || [];
  return '<section class="analyzer analyzer-preview">'+sectionHead('PBE MATCHUP ANALYZER','Selected evidence · full workstation in All Access')+
    '<p class="analyzer-note">Descriptive canonical comparisons · '+esc(d.competition || '')+' '+esc(d.season || '')+' · as of '+esc(d.as_of || '')+'. No prediction or win probability.</p>'+
    (rows.length ? '<div class="edge-grid">'+join(rows,c=>'<article class="edge-row"><header><h3>'+esc(c.label)+'</h3><span class="edge-tag">EDGE '+num(c.edge,{dp:2})+'</span></header><div class="edge-values"><b>'+num(c.home,{dp:2})+' <small>'+esc(c.unit)+'</small><span>'+esc(name('home'))+'</span></b><b>'+num(c.away,{dp:2})+' <small>'+esc(c.unit)+'</small><span>'+esc(name('away'))+'</span></b></div><p class="edge-meta">SAMPLE '+num(c.sample?.home)+' / '+num(c.sample?.away)+' · '+esc(c.explanation || '')+'</p><details><summary>BASIS</summary><p>'+esc(c.basis || '')+'</p></details></article>')+'</div>' : '<p class="muted">'+esc(d.coverage?.basis || 'Too little compatible canonical data for a comparison. No values are filled in.')+'</p>')+
    '<p class="caveat">DATA COVERAGE · '+esc(d.coverage?.label || 'LIMITED')+'. This is sample coverage, not predictive confidence.</p></section>';
}

export async function mountAnalyzer(root, d, {isCurrent=()=>true}={}) {
  const slot=root.querySelector('[data-analyzer]'); if(!slot || !d.res.body.data.analyzer_available) return;
  const res=await proGet('matches/'+d.id+'/analyzer');
  if(!isCurrent() || !slot.isConnected) return;
  slot.innerHTML=res.status===200?analyzerView(res.body.data,d.res.body.data.match)+sourcePanel(res.body.meta,{title:'ANALYZER METHOD'}):errorState({status:res.status},false);
}
