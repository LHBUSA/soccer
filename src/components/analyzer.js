import { esc, join } from '../lib/html.js';
import { num, dateShort } from '../lib/format.js';
import { sectionHead, sourcePanel, errorState } from './ui.js';
import { proGet } from '../lib/pro.js';
import { proCopy } from '../i18n/pro-copy.js';

// Analyzer copy with values. English is the product copy; other locales override it from their catalog
// (src/i18n/catalog/<locale>-pro.js `ui`). API text (labels, bases, explanations) goes through proCopy by code.
const UI_EN = {
  level: 'LEVEL',
  edgeMeta: ({ edge, sh, sa, ch, th, ca, ta }) => `EDGE ${edge} / 1 · SAMPLE ${sh} / ${sa} · COVERAGE ${ch}/${th} home, ${ca}/${ta} away`,
  axis: edge => `Normalized home edge ${edge} on a scale from minus one to one`,
  scaleWeight: ({ norm, scale, weight }) => `${norm}. Scale: ${scale}. Weight: ${weight}% of available components.`,
  groups: { results: 'RESULTS & FORM', style: 'STYLE / SHOT DATA', schedule: 'SCHEDULE & XI' },
  note: ({ comp, season, asOf }) => `Descriptive pre-match comparisons · ${comp} ${season} · as of ${asOf}. No win probability or prediction.`,
  previewNote: ({ comp, season, asOf }) => `Descriptive canonical comparisons · ${comp} ${season} · as of ${asOf}. No prediction or win probability.`,
  componentScore: 'Component score / 100',
  baseline: ({ seasons, window, matches }) => `${seasons} stored seasons in the last ${window} available season window · ${matches} baseline matches`,
  scoring: ({ cur, base, change }) => ['Scoring: ', cur, ` current / ${base} baseline · change ${change}`],
  conceding: ({ cur, base, change }) => ['Conceding: ', cur, ` current / ${base} baseline · change ${change}`],
  currentMatches: n => `${n} current matches.`,
  noBaseline: 'No earlier compatible stored season baseline.',
  h2h: ({ n, home, hg, away, ag }) => `${n} stored meetings · ${home} ${hg} goals / ${away} ${ag} goals`,
  noH2h: 'Fewer than two stored canonical meetings. No head-to-head summary.',
  coverageRows: ['Result matches', 'Sourced XIs (21-day workload window)', 'Paired shot-stat matches', 'Event-ledger matches', 'Stored competition-seasons', 'Top-11 nominal minute share'],
  omitted: n => `${n} unavailable components omitted`,
  minimum: n => `Minimum sample: ${n}`,
  sample: (h, a) => `SAMPLE ${h} / ${a}`,
  edge: e => `EDGE ${e}`,
  tooFew: 'Too little compatible canonical data for a comparison. No values are filled in.',
  previewCoverage: l => `DATA COVERAGE · ${l}. This is sample coverage, not predictive confidence.`,
  limited: 'LIMITED',
};
const copy = () => { const t = proCopy(); return { t, U: { ...UI_EN, ...(t.ui || {}) } }; };

const coverageSide = (U, name, c) => '<div><h3>'+esc(name)+'</h3><dl>'+join([[U.coverageRows[0],c.matches],[U.coverageRows[1],c.lineups],[U.coverageRows[2],c.paired_stats],[U.coverageRows[3],c.events],[U.coverageRows[4],c.historical_seasons],[U.coverageRows[5],c.top11_minute_share===null?null:Math.round(c.top11_minute_share*100)+'%']],([k,v])=>'<div><dt>'+esc(k)+'</dt><dd>'+(typeof v==='string'?esc(v):num(v))+'</dd></div>')+'</dl></div>';
export function analyzerView(d, match) {
  const { t, U } = copy();
  const side = key => match[key]?.short_name || match[key]?.name || (key==='home'?'Home':'Away');
  const card = c => '<article class="edge-row"><header><h3>'+esc(t.label(c))+'</h3><span class="edge-tag">'+(c.edge===0?U.level:c.edge>0?esc(side('home')):esc(side('away')))+'</span></header><div class="edge-values"><b>'+num(c.home,{dp:2})+' <small>'+esc(t.unit(c.unit))+'</small></b><b>'+num(c.away,{dp:2})+' <small>'+esc(t.unit(c.unit))+'</small></b></div><div class="edge-axis" role="img" aria-label="'+esc(U.axis(String(c.edge)))+'"><i style="left:'+(c.edge<0?50+c.edge*50:50)+'%;width:'+Math.abs(c.edge)*50+'%" class="'+(c.edge<0?'away':'home')+'"></i><span></span></div><p class="edge-meta">'+U.edgeMeta({ edge: num(c.edge,{dp:2}), sh: num(c.sample.home), sa: num(c.sample.away), ch: num(c.coverage.home.available), th: num(c.coverage.home.total), ca: num(c.coverage.away.available), ta: num(c.coverage.away.total) })+'</p><details><summary>BASIS & NORMALIZATION</summary><p>'+esc(t.basis(c))+'</p><p>'+esc(U.scaleWeight({ norm: t.normalization(c.normalization), scale: num(c.scale,{dp:2}), weight: num(c.weight*100,{dp:1}) }))+'</p></details></article>';
  const groups = ['results','style','schedule'];
  const history = (key,rows) => '<div><h3>'+esc(side(key))+'</h3>'+(rows.length?join(rows,b=>{ const s=U.scoring({ cur: num(b.current_goals_for_pg,{dp:2}), base: num(b.goals_for_pg,{dp:2}), change: num(b.scoring_change,{dp:2}) }); const c=U.conceding({ cur: num(b.current_goals_against_pg,{dp:2}), base: num(b.goals_against_pg,{dp:2}), change: num(b.conceding_change,{dp:2}) }); return '<div class="baseline-row"><p>'+U.baseline({ seasons: num(b.seasons.length), window: num(b.window), matches: num(b.matches) })+'</p><p>'+esc(s[0])+'<b>'+s[1]+'</b>'+esc(s[2])+'</p><p>'+esc(c[0])+'<b>'+c[1]+'</b>'+esc(c[2])+'</p><small>'+esc(b.seasons.join(', '))+' · '+esc(U.currentMatches(num(b.current_matches)))+' '+esc(t.historyBasis(b.basis))+'</small></div>'; }):'<p class="muted">'+esc(U.noBaseline)+'</p>')+'</div>';
  const h2h=d.head_to_head;
  return '<section class="analyzer">'+sectionHead('PBE MATCHUP ANALYZER','The evidence behind the matchup')+'<p class="analyzer-note">'+esc(U.note({ comp: d.competition, season: d.season || '', asOf: d.as_of }))+'</p><div class="analyzer-rating"><span>'+esc(side('home'))+'<b>'+num(d.rating?.home)+'</b></span><div><strong>'+esc(t.coverageLabel(d.coverage.label))+'</strong><p>'+esc(U.componentScore)+'</p></div><span>'+esc(side('away'))+'<b>'+num(d.rating?.away)+'</b></span></div><details class="analyzer-formula"><summary>HOW THE COMPONENT SCORE WORKS</summary><p>'+esc(t.formula(d.formula))+'</p></details>'+
    join(groups,key=>d.components.some(c=>c.group===key)?'<h3 class="analyzer-group">'+U.groups[key]+'</h3><div class="edge-grid">'+join(d.components.filter(c=>c.group===key),card)+'</div>':'')+
    sectionHead('WHY THE EDGE EXISTS','Deterministic facts, visible inputs')+'<ul class="analyzer-explanations">'+join(d.components,c=>'<li>'+esc(t.explanation(c))+'</li>')+'</ul>'+
    sectionHead('HISTORICAL CONTEXT','Each side against its own stored baseline')+'<div class="baseline-grid">'+history('home',d.historical_context.home)+history('away',d.historical_context.away)+'</div>'+
    sectionHead('HEAD-TO-HEAD','Canonical meetings before this matchup')+(h2h?'<p>'+esc(U.h2h({ n: num(h2h.matches.length), home: side('home'), hg: num(h2h.home_goals), away: side('away'), ag: num(h2h.away_goals) }))+'</p><ul class="h2h-list">'+join(h2h.matches,m=>{const home=m.home_team_id===d.home_id;return '<li><a href="/matches/'+esc(m.id)+'" data-link>'+esc(dateShort(m.kickoff_at))+' · '+esc(home?side('home'):side('away'))+' <b>'+num(m.home_score)+'–'+num(m.away_score)+'</b> '+esc(home?side('away'):side('home'))+' · '+esc(m.competition || '')+'</a></li>';})+'</ul>':'<p class="muted">'+esc(U.noH2h)+'</p>')+
    sectionHead('DATA COVERAGE','Observation depth, not predictive confidence')+'<div class="coverage-grid">'+coverageSide(U,side('home'),d.coverage.home)+coverageSide(U,side('away'),d.coverage.away)+'</div><p class="caveat">'+esc(t.coverageBasis(d.coverage.basis))+'</p>'+
    (d.omitted.length?'<details><summary>'+esc(U.omitted(num(d.omitted.length)))+'</summary><ul>'+join(d.omitted,c=>'<li>'+esc(t.label(c))+': '+esc(t.omittedReason(c.reason))+' '+esc(U.minimum(num(c.minimum)))+'</li>')+'</ul></details>':'')+'</section>';
}

export function analyzerPreviewHtml(d, match) {
  const { t, U } = copy();
  const name = k => match[k]?.short_name || match[k]?.name || (k === 'home' ? 'Home' : 'Away');
  const rows = d.components || [];
  return '<section class="analyzer analyzer-preview">'+sectionHead('PBE MATCHUP ANALYZER','Selected evidence · full workstation in All Access')+
    '<p class="analyzer-note">'+esc(U.previewNote({ comp: d.competition || '', season: d.season || '', asOf: d.as_of || '' }))+'</p>'+
    (rows.length ? '<div class="edge-grid">'+join(rows,c=>'<article class="edge-row"><header><h3>'+esc(t.label(c))+'</h3><span class="edge-tag">'+esc(U.edge(num(c.edge,{dp:2})))+'</span></header><div class="edge-values"><b>'+num(c.home,{dp:2})+' <small>'+esc(t.unit(c.unit))+'</small><span>'+esc(name('home'))+'</span></b><b>'+num(c.away,{dp:2})+' <small>'+esc(t.unit(c.unit))+'</small><span>'+esc(name('away'))+'</span></b></div><p class="edge-meta">'+esc(U.sample(num(c.sample?.home), num(c.sample?.away)))+' · '+esc(t.explanation(c) || '')+'</p><details><summary>BASIS</summary><p>'+esc(t.basis(c) || '')+'</p></details></article>')+'</div>' : '<p class="muted">'+esc(d.coverage?.basis ? t.coverageBasis(d.coverage.basis) : U.tooFew)+'</p>')+
    '<p class="caveat">'+esc(U.previewCoverage(d.coverage?.label ? t.coverageLabel(d.coverage.label) : U.limited))+'</p></section>';
}

export async function mountAnalyzer(root, d, {isCurrent=()=>true}={}) {
  const slot=root.querySelector('[data-analyzer]'); if(!slot || !d.res.body.data.analyzer_available) return;
  const res=await proGet('matches/'+d.id+'/analyzer');
  if(!isCurrent() || !slot.isConnected) return;
  slot.innerHTML=res.status===200?analyzerView(res.body.data,d.res.body.data.match)+sourcePanel(res.body.meta,{title:'ANALYZER METHOD'}):errorState({status:res.status},false);
}
