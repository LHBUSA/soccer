// Soccer Algo V1 pages. HIDDEN until go-live (docs/MODEL_READINESS.md: owner sign-off G7): no navigation
// link, noindex, not in the sitemap. Three surfaces that never mix:
//   OFFICIAL PICKS         frozen-policy picks from the append-only ledger (the only thing in the record)
//   GAME BEST              the model's strongest selection for every forecast match (a model forecast)
//   HISTORICAL VALIDATION  research on past seasons (committed evidence), never part of the record
import { api } from '../lib/api.js';
import { esc, join, when } from '../lib/html.js';
import { dateTime } from '../lib/format.js';
import { empty, link, sectionHead, sourcePanel } from '../components/ui.js';

const pc = (p, dp = 1) => (p === null || p === undefined ? '—' : `${(100 * p).toFixed(dp)}%`);
const teamName = t => (t ? link(`/teams/${t.slug}`, esc(t.name)) : '—');
const fixture = x => `${teamName(x.home)} <span class="muted">v</span> ${teamName(x.away)}`;
const STATUS = { pending: 'PENDING', win: 'HIT', loss: 'MISS', void: 'VOID', push: 'PUSH' };
const statusChip = s => `<span class="algo-st algo-${esc(s)}">${STATUS[s] || esc(s)}</span>`;

const hero = (kicker, title, lede) => `<section class="hero compact"><div class="wrap"><p class="kicker gold">${esc(kicker)}</p><h1 class="display">${title}</h1><p class="lede">${esc(lede)}</p>
  <p class="algo-tabs">${link('/picks', 'OFFICIAL PICKS', 'btn')} ${link('/track-record', 'TRACK RECORD', 'btn')}</p></div></section>`;

function policyBlock(pol) {
  return `<div class="algo-policy">
    <p><b>${esc(pol.algo_version)}</b> · policy ${esc(pol.pick_policy_version)} · ${esc(pol.competition)}</p>
    <ul>${join(pol.markets, m => `<li>${esc(m.name)}: an Official Pick needs a model probability of at least <b>${pc(m.threshold, 1)}</b></li>`)}
      <li>At most one Official Pick per match. Picks are written to an append-only ledger when the match enters the 7-day window and lock 60 minutes before kickoff; nothing is edited after issue.</li>
      <li>No sportsbook prices are captured in V1, so no ROI, units or closing-line value is stated. No default odds are ever assumed.</li></ul>
    <p class="muted">Spec hash <code>${esc(pol.spec_hash.slice(0, 16))}…</code> · model hash <code>${esc(pol.model_hash.slice(0, 16))}…</code></p></div>`;
}

function pickRow(p) {
  return `<tr><td class="num">#${esc(p.record_no)}</td><td class="tm">${fixture(p)}<br><span class="muted">${esc(dateTime(p.kickoff_at))}</span></td>
    <td><b>${esc(p.label)}</b><br><span class="muted">${esc(p.market_name)}</span></td><td class="num">${pc(p.model_probability)}</td>
    <td>${statusChip(p.status)}${p.final_score ? ` <span class="muted">${esc(p.final_score)}</span>` : ''}${p.status === 'void' && p.settlement_reason ? `<br><span class="muted">${esc(p.settlement_reason)}</span>` : ''}</td>
    <td class="muted small">issued ${esc(dateTime(p.issued_at))}<br>locks ${esc(dateTime(p.lock_at))}</td></tr>`;
}
const pickTable = (rows, label) => `<div class="tablewrap" tabindex="0" role="region" aria-label="${esc(label)}"><table class="ltable algo-table"><thead><tr><th scope="col">No.</th><th class="tm" scope="col">Match</th><th scope="col">Pick</th><th scope="col">Model</th><th scope="col">Result</th><th scope="col">Ledger</th></tr></thead><tbody>${join(rows, pickRow)}</tbody></table></div>`;

function gameBestCard(g) {
  const b = g.game_best;
  return `<article class="algo-gb${b.qualifies ? ' is-official' : ''}">
    <p class="algo-gb-when">${esc(dateTime(g.kickoff_at))}</p>
    <p class="algo-gb-fx">${fixture(g)}</p>
    <p class="algo-gb-tag">${b.qualifies && g.official_pick ? `<span class="algo-st algo-official">OFFICIAL PICK #${esc(g.official_pick.record_no)}</span>` : '<span class="algo-st algo-forecast">MODEL FORECAST</span>'}</p>
    <p class="algo-gb-pick"><span class="kicker">GAME BEST</span><b>${esc(b.label)}</b> <span>${pc(b.probability)}</span></p>
    ${b.qualifies && g.official_pick ? '' : `<p class="muted small">Not an Official Pick: below the ${pc(b.threshold, 1)} threshold. Not counted in the record.</p>`}
    <p class="algo-gb-probs small">Home ${pc(g.probabilities.home_win)} · Draw ${pc(g.probabilities.draw)} · Away ${pc(g.probabilities.away_win)} · Home scores ${pc(g.probabilities.home_to_score)}</p>
  </article>`;
}

export const picks = {
  title: () => 'Soccer Algo Official Picks | PropBetEdge Soccer',
  robots: 'noindex, follow',
  async load() { return api('algo/picks'); },
  render(env) {
    const d = env.data;
    const open = d.official_picks.open; const recent = d.official_picks.recent;
    return `${hero('SOCCER ALGO V1 · BUNDESLIGA', 'Official <span>Picks</span>', 'Frozen model, frozen thresholds, picks locked before kickoff and graded from the final score. Every Official Pick counts, forever.')}
    <section class="canvas"><div class="wrap">
      ${d.live ? '' : `<div class="algo-banner"><b>Not live yet.</b> No Official Pick has been issued. The public record starts with the first pick after go-live and is never back-filled.</div>`}
      ${sectionHead('OFFICIAL PICKS', 'Open picks')}
      ${open.length ? pickTable(open, 'Open Official Picks') : empty('No open Official Picks', d.live ? 'No upcoming Bundesliga match currently meets a frozen threshold.' : 'Official Picks have not gone live.')}
      ${when(recent.length, () => `${sectionHead('RECENTLY SETTLED', 'Latest results')}${pickTable(recent, 'Recently settled Official Picks')}<p>${link('/track-record', 'Full track record →', 'sec-link')}</p>`)}
      ${sectionHead('GAME BEST', 'Every forecast match')}
      <p class="sec-note">The model's strongest selection for each Bundesliga match inside the 7-day forecast window. A Game Best is a model forecast; it enters the record only when it is also an Official Pick.</p>
      ${d.game_best.length ? `<div class="algo-gbgrid">${join(d.game_best, gameBestCard)}</div>` : empty('No forecasts in the window', d.live ? 'Forecasts are issued when a match is 7 days away.' : 'Forecasts start at go-live.')}
      ${when(d.awaiting_forecast.length, () => `${sectionHead('NEXT UP', 'Awaiting forecast')}<ul class="algo-next">${join(d.awaiting_forecast, m => `<li>${fixture(m)} <span class="muted">· kickoff ${esc(dateTime(m.kickoff_at))} · forecast window opens ${esc(dateTime(m.forecast_window_opens_at))}</span></li>`)}</ul>`)}
      ${sectionHead('THE POLICY', 'Frozen before any outcome')}
      ${policyBlock(d.policy)}
      ${sourcePanel(env.meta)}
    </div></section>`;
  },
};

function summaryCards(t) {
  const cells = [['Record', `${t.wins}–${t.losses}`], ['Hit rate', pc(t.hit_rate)], ['Avg model probability', pc(t.average_model_probability)], ['Void', String(t.voids)], ['Pending', String(t.pending)]];
  return `<div class="algo-kpis">${join(cells, ([k, v]) => `<div><p class="kicker">${esc(k)}</p><p class="algo-kpi">${esc(v)}</p></div>`)}</div>`;
}
const calibrationTable = cal => `<div class="tablewrap"><table class="ltable"><thead><tr><th scope="col">Model probability</th><th scope="col">Graded picks</th><th scope="col">Mean model probability</th><th scope="col">Hit rate</th></tr></thead><tbody>${join(cal, b => `<tr><td>${esc(b.band)}</td><td class="num">${b.picks}</td><td class="num">${pc(b.mean_probability)}</td><td class="num">${pc(b.hit_rate)}</td></tr>`)}</tbody></table></div>`;

function researchPanel(r) {
  const row = (label, s) => `<tr><td>${esc(label)}</td><td class="num">${s.picks ?? s.official_picks}</td><td class="num">${pc(s.coverage)}</td><td class="num">${pc(s.hit_rate)}</td><td class="num">${pc(s.mean_probability)}</td></tr>`;
  const m = r.markets;
  return `<section class="algo-research" aria-labelledby="algo-research-h">
    <p class="kicker">MODEL RESEARCH</p><h2 id="algo-research-h">HISTORICAL VALIDATION</h2>
    <p class="algo-banner warn">${esc(r.disclaimer)}</p>
    <div class="tablewrap"><table class="ltable"><thead><tr><th scope="col">Past seasons (research)</th><th scope="col">Picks</th><th scope="col">Coverage</th><th scope="col">Hit rate</th><th scope="col">Mean model probability</th></tr></thead><tbody>
      ${row(`Selection ${r.select.seasons[0]}–${r.select.seasons.at(-1)}: all policy picks`, r.select.combined)}
      ${row(`Holdout ${r.holdout.seasons[0]}–${r.holdout.seasons.at(-1)}: all policy picks`, r.holdout.combined)}
      ${row('Holdout: match result ≥ 60%', m['1x2'].holdout_picks)}
      ${row('Holdout: home team to score ≥ 87.5%', m.home_to_score.holdout_picks)}
    </tbody></table></div>
    <p class="muted small">Thresholds were chosen on the selection seasons only and frozen (freeze ${esc(r.select_freeze_sha256.slice(0, 12))}…) before the holdout seasons were evaluated once (${esc(dateTime(r.holdout_evaluated_at))}). Match-result log loss on the holdout: ${esc(m['1x2'].validation_holdout.log_loss)} against a ${esc(m['1x2'].validation_holdout.baseline_log_loss)} baseline, better in ${m['1x2'].validation_holdout.seasons_beating_baseline} of ${m['1x2'].validation_holdout.seasons} seasons. ${esc(r.prices)}</p>
  </section>`;
}

export const trackRecord = {
  title: () => 'Soccer Algo Track Record | PropBetEdge Soccer',
  robots: 'noindex, follow',
  async load(_p, sp) {
    const market = ['1x2', 'home_to_score'].includes(sp?.get('market')) ? sp.get('market') : undefined;
    const last = ['30', '60', '100'].includes(sp?.get('last')) ? sp.get('last') : undefined;
    const [rec, res] = await Promise.all([api('algo/record', { market, last }), api('algo/research')]);
    return { rec, res, market, last };
  },
  render({ rec, res, market, last }) {
    const d = rec.data;
    const f = (k, v, l) => { const on = (k === 'market' ? market : last) === v; const q = new URLSearchParams({ ...(market ? { market } : {}), ...(last ? { last } : {}) }); if (v) q.set(k, v); else q.delete(k); return link(`/track-record${q.toString() ? `?${q}` : ''}`, esc(l), `btn${on ? ' gold' : ''}`); };
    return `${hero('SOCCER ALGO V1 · PUBLIC RECORD', 'Track <span>record</span>', 'Every Official Pick issued after go-live, straight from the append-only ledger. Wins, losses, voids and pending picks. Nothing is removed and nothing from before go-live is counted.')}
    <section class="canvas"><div class="wrap">
      ${d.live ? '' : `<div class="algo-banner"><b>The record is empty.</b> Official Picks have not gone live. The first pick after go-live becomes record #1.</div>`}
      <p class="algo-filters">${f('market', undefined, 'All markets')} ${f('market', '1x2', 'Match result')} ${f('market', 'home_to_score', 'Home to score')} <span class="muted">·</span> ${f('last', undefined, 'All')} ${f('last', '30', 'Last 30')} ${f('last', '60', 'Last 60')} ${f('last', '100', 'Last 100')}</p>
      ${sectionHead('OFFICIAL RECORD', 'Results')}
      ${summaryCards(d.totals)}
      <p class="sec-note">Hit rate = hits / (hits + misses). Void and pending picks are not in it. ${esc(d.prices.reason)}</p>
      ${sectionHead('CALIBRATION', 'Model probability vs outcome')}
      ${calibrationTable(d.totals.calibration)}
      ${sectionHead('LEDGER', 'Every Official Pick')}
      ${d.picks.length ? pickTable(d.picks, 'Official Pick ledger') : empty('No Official Picks yet', 'The ledger is empty.')}
      ${researchPanel(res.data)}
      ${sourcePanel(rec.meta)}
    </div></section>`;
  },
};
