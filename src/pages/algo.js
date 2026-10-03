// SOCCER PBE PICKS: every production-approved soccer algo, each loaded independently from its own API and shown only
// while that model is live (its API's `live` flag = the model has started in production). Models never merge: each
// keeps its frozen model, thresholds, policy and append-only record. Three surfaces that never mix:
//   OFFICIAL PICKS         frozen-policy picks from a model's append-only ledger (the only thing in its record)
//   GAME BEST              each model's strongest selection for every forecast match (a model forecast)
//   HISTORICAL VALIDATION  research on past seasons (committed evidence), never part of a record
// The combined ALL view only lists cards side by side; every card names its competition and algo version. There is no
// combined hit rate or calibration: /track-record shows one model's record at a time.
import { api } from '../lib/api.js';
import { esc, join, when } from '../lib/html.js';
import { dateTime } from '../lib/format.js';
import { empty, link, mergeMeta, sectionHead, sourcePanel } from '../components/ui.js';
import { AVM_ALGO_MODEL, boardEntry, boardWithin, byDeadline, loadAlgoVsMarket, trackRecordAvmHtml } from '../data/kalshi.js';
import { findAvmRow, pickMarketSlot } from '../lib/pick-market.js';

// Longest the track record waits for the Algo vs Market read (it runs in parallel with the record reads).
export const AVM_WAIT_MS = 2500;

// Production-approved soccer algos. lock_minutes = each frozen spec's lead_time.lock_minutes_before_kickoff.
export const MODELS = [
  { key: 'bundesliga', tab: 'BUNDESLIGA', competition: 'Bundesliga', version: 'Soccer Algo V1', api: 'algo', lock_minutes: 60,
    lane: 'Bundesliga — Soccer Algo V1',
    about: 'Frozen Bundesliga model. GAME BEST is the strongest model selection for each forecast match and is a model forecast unless it qualifies as an Official Pick.' },
  { key: 'nations-league', tab: 'NATIONS LEAGUE', competition: 'UEFA Nations League', version: 'Soccer Algo V2', api: 'algo/v2', lock_minutes: 60,
    lane: 'International — Soccer Algo V2',
    about: 'Frozen national-team model for UEFA Nations League group / league-phase matches. GAME BEST is the strongest model selection for each forecast match and is a model forecast unless it meets the frozen Official Pick threshold.' },
];

// ONE provenance block for every model lane on the page: the lanes share a source (PBE) and coverage, so each lane is a
// section inside the same card instead of its own SOURCE & COVERAGE shell (was: one card per lane, 2026-10-03).
export function picksSource(shown) {
  const meta = mergeMeta(shown.map(x => x.res.meta));
  if (!meta) return '';
  const locks = [...new Set(shown.map(x => x.model.lock_minutes))];
  meta.semantics = `OFFICIAL PICKS are each model's frozen-policy qualifying selections, written to that model's append-only ledger before lock (${locks.length === 1 ? `kickoff − ${locks[0]} min` : 'each model\'s lock time'}) and never edited.${shown.length > 1 ? ` Records remain separate between ${shown.map(x => x.model.version.replace('Soccer Algo ', '')).join(' and ')}.` : ''}`;
  return sourcePanel(meta, { sections: shown.map(x => ({ title: x.model.lane, text: x.model.about })) });
}
const byKey = new Map(MODELS.map(m => [m.key, m]));

const pc = (p, dp = 1) => (p === null || p === undefined ? '—' : `${(100 * p).toFixed(dp)}%`);
const teamName = t => (t ? link(`/teams/${t.slug}`, esc(t.name)) : '—');
const fixture = x => `${teamName(x.home)} <span class="muted">v</span> ${teamName(x.away)}`;
const STATUS = { pending: 'PENDING', win: 'HIT', loss: 'MISS', void: 'VOID', push: 'PUSH' };
const statusChip = s => `<span class="algo-st algo-${esc(s)}">${STATUS[s] || esc(s)}</span>`;
const modelChip = m => `<span class="algo-model"><b>${esc(m.competition)}</b> · ${esc(m.version)}</span>`;
const lockOf = (m, kickoff) => new Date(Date.parse(kickoff) - m.lock_minutes * 60e3).toISOString();
const marketsOf = pol => pol.markets || pol.official_markets || [];

const hero = (kicker, title, lede) => `<section class="hero compact"><div class="wrap"><p class="kicker gold">${esc(kicker)}</p><h1 class="display">${title}</h1><p class="lede">${esc(lede)}</p>
  <p class="algo-tabs">${link('/picks', 'OFFICIAL PICKS', 'btn')} ${link('/track-record', 'TRACK RECORD', 'btn')}</p></div></section>`;

function policyBlock(m, pol) {
  return `<div class="algo-policy">
    <p>${modelChip(m)} · <b>${esc(pol.algo_version)}</b> · policy ${esc(pol.pick_policy_version)} · ${esc(pol.competition)}</p>
    <ul>${join(marketsOf(pol), x => `<li>${esc(x.name)}: an Official Pick needs a model probability of at least <b>${pc(x.threshold, 1)}</b></li>`)}
      <li>At most one Official Pick per match. Picks are written to an append-only ledger when the match enters the 7-day window and lock ${m.lock_minutes} minutes before kickoff; nothing is edited after issue.</li>
      <li>No sportsbook prices are captured, so no ROI, units or closing-line value is stated. No default sportsbook odds are ever assumed.</li></ul>
    <p class="muted">Spec hash <code>${esc(pol.spec_hash.slice(0, 16))}…</code> · model hash <code>${esc(pol.model_hash.slice(0, 16))}…</code></p></div>`;
}

// Kalshi for an Official Pick: the SAME match (canonical match UUID) and the SAME side (home / draw / away), only for
// the match-result market (Kalshi's 90-minute result contract; home-to-score has no comparable market). A settled or
// kicked-off pick shows only stored market evidence; the frozen Algo vs Market comparison when one exists. '' otherwise.
export function pickKalshi(p, avm = null, now = Date.now()) {
  if (!p || p.market !== '1x2' || !['home', 'draw', 'away'].includes(p.selection) || !p.match_id) return '';
  const settled = p.status !== 'pending' || Date.parse(p.kickoff_at || '') <= now;
  return pickMarketSlot(boardEntry(p.match_id), p.selection, { settled, avmRow: findAvmRow(avm, p.match_id, p.selection) });
}

const pickRow = (m, showModel, avm) => p => `<tr>${showModel ? `<td>${modelChip(m)}</td>` : ''}<td class="num">#${esc(p.record_no)}</td><td class="tm">${fixture(p)}<br><span class="muted">${esc(dateTime(p.kickoff_at))}</span></td>
    <td><b>${esc(p.label)}</b><br><span class="muted">${esc(p.market_name)}</span>${pickKalshi(p, avm)}</td><td class="num">${pc(p.model_probability)}<br><span class="muted small">threshold ${pc(p.threshold, 1)}</span></td>
    <td>${statusChip(p.status)}${p.final_score ? ` <span class="muted">${esc(p.final_score)}</span>` : ''}${p.status === 'void' && p.settlement_reason ? `<br><span class="muted">${esc(p.settlement_reason)}</span>` : ''}</td>
    <td class="muted small">issued ${esc(dateTime(p.issued_at))}<br>locks ${esc(dateTime(p.lock_at))}</td></tr>`;
const pickTable = (rows, label, showModel, avm = null) => `<div class="tablewrap" tabindex="0" role="region" aria-label="${esc(label)}"><table class="ltable algo-table"><thead><tr>${showModel ? '<th scope="col">Model</th>' : ''}<th scope="col">No.</th><th class="tm" scope="col">Match</th><th scope="col">Pick</th><th scope="col">Model probability</th><th scope="col">Result</th><th scope="col">Ledger</th></tr></thead><tbody>${rows.map(([m, p]) => pickRow(m, showModel, avm)(p)).join('')}</tbody></table></div>`;

function gameBestCard(m, g) {
  const b = g.game_best; const official = b.qualifies && g.official_pick;
  return `<article class="algo-gb${official ? ' is-official' : ''}">
    <p class="algo-gb-model">${modelChip(m)}</p>
    <p class="algo-gb-when">${esc(dateTime(g.kickoff_at))}</p>
    <p class="algo-gb-fx">${fixture(g)}</p>
    <p class="algo-gb-tag">${official ? `<span class="algo-st algo-official">OFFICIAL PICK #${esc(g.official_pick.record_no)}</span>` : '<span class="algo-st algo-forecast">MODEL FORECAST</span>'}</p>
    <p class="algo-gb-pick"><span class="kicker">GAME BEST</span><b>${esc(b.label)}</b> <span>${pc(b.probability)}</span></p>
    <p class="muted small">${esc(b.market_name || b.market)} · threshold ${pc(b.threshold, 1)} · issued ${esc(dateTime(g.forecast_issued_at))} · locks ${esc(dateTime(lockOf(m, g.kickoff_at)))}</p>
    ${official ? '' : `<p class="muted small">Not an Official Pick: below the ${pc(b.threshold, 1)} threshold. Not counted in any record.</p>`}
    <p class="algo-gb-probs small">Home ${pc(g.probabilities.home_win)} · Draw ${pc(g.probabilities.draw)} · Away ${pc(g.probabilities.away_win)} · Home scores ${pc(g.probabilities.home_to_score)}</p>
  </article>`;
}

// load every model independently; a model that fails to load or is not live is simply not shown
async function loadModels(path, query) {
  const got = await Promise.allSettled(MODELS.map(m => api(`${m.api}/${path}`, query)));
  return MODELS.map((m, i) => ({ model: m, res: got[i].status === 'fulfilled' ? got[i].value : null })).filter(x => x.res?.data?.live === true);
}
const tabLink = (base, key, label, on) => link(`${base}${key ? `?model=${key}` : ''}`, esc(label), `btn${on ? ' gold' : ''}`);

export const picks = {
  title: () => 'Soccer PBE Picks | PropBetEdge Soccer',
  async load(_p, sp) {
    // The Kalshi board (one shared read) and the frozen Algo vs Market ledger run beside the picks reads, bounded, so
    // a pick's Kalshi line is part of the first paint (no late insert). A slow or failed read renders nothing.
    const avmDeadline = Date.now() + AVM_WAIT_MS;
    const avmRead = loadAlgoVsMarket();
    const [models] = await Promise.all([loadModels('picks'), boardWithin(AVM_WAIT_MS)]);
    const avm = (await byDeadline(avmRead, avmDeadline)) ?? null;
    const want = sp?.get('model');
    return { models, tab: models.some(x => x.model.key === want) ? want : 'all', avm };
  },
  render({ models, tab, avm = null }) {
    const shown = tab === 'all' ? models : models.filter(x => x.model.key === tab);
    const many = shown.length > 1;
    const open = shown.flatMap(x => x.res.data.official_picks.open.map(p => [x.model, p])).sort((a, b) => Date.parse(a[1].kickoff_at) - Date.parse(b[1].kickoff_at));
    const recent = shown.flatMap(x => x.res.data.official_picks.recent.map(p => [x.model, p])).sort((a, b) => Date.parse(b[1].kickoff_at) - Date.parse(a[1].kickoff_at));
    const best = shown.flatMap(x => x.res.data.game_best.map(g => [x.model, g])).sort((a, b) => Date.parse(a[1].kickoff_at) - Date.parse(b[1].kickoff_at));
    const awaiting = shown.flatMap(x => (x.res.data.awaiting_forecast || []).map(g => [x.model, g]));
    const comps = shown.map(x => x.model.competition).join(' · ');
    return `${hero(`SOCCER PBE PICKS${comps ? ` · ${comps.toUpperCase()}` : ''}`, 'Official <span>Picks</span>', 'Frozen models, frozen thresholds, picks locked before kickoff and graded from the final score. Each model keeps its own record; every Official Pick counts, forever.')}
    <section class="canvas algo-canvas"><div class="wrap">
      ${models.length ? `<p class="algo-filters" role="navigation" aria-label="Competition">${tabLink('/picks', null, 'ALL', tab === 'all')} ${join(models, x => tabLink('/picks', x.model.key, x.model.tab, tab === x.model.key))}</p>` : `<div class="algo-banner"><b>Not live yet.</b> No PBE Picks model has issued an Official Pick. Each record starts with its first pick after go-live and is never back-filled.</div>`}
      ${sectionHead('OFFICIAL PICKS', 'Open picks')}
      ${open.length ? pickTable(open, 'Open Official Picks', many, avm) : empty('No open Official Picks', models.length ? 'No upcoming match currently meets a frozen threshold.' : 'Official Picks have not gone live.')}
      ${when(recent.length, () => `${sectionHead('RECENTLY SETTLED', 'Latest results')}${pickTable(recent, 'Recently settled Official Picks', many, avm)}<p>${link('/track-record', 'Full track record →', 'sec-link')}</p>`)}
      ${sectionHead('GAME BEST', 'Every forecast match')}
      <p class="sec-note">Each model's strongest selection for every match inside its 7-day forecast window. A Game Best is a model forecast; it enters a record only when it is also an Official Pick of that model.</p>
      ${best.length ? `<div class="algo-gbgrid">${best.map(([m, g]) => gameBestCard(m, g)).join('')}</div>` : empty('No forecasts in the window', models.length ? 'Forecasts are issued when a match is 7 days away.' : 'Forecasts start at go-live.')}
      ${when(awaiting.length, () => `${sectionHead('NEXT UP', 'Awaiting forecast')}<ul class="algo-next">${awaiting.map(([m, g]) => `<li>${modelChip(m)} ${fixture(g)} <span class="muted">· kickoff ${esc(dateTime(g.kickoff_at))} · forecast window opens ${esc(dateTime(g.forecast_window_opens_at))}</span></li>`).join('')}</ul>`)}
      ${when(shown.length, () => `${sectionHead('THE POLICY', 'Frozen before any outcome')}${shown.map(x => policyBlock(x.model, x.res.data.policy)).join('')}`)}
      ${picksSource(shown)}
    </div></section>`;
  },
};

function summaryCards(t) {
  const cells = [['Record', `${t.wins}–${t.losses}`], ['Hit rate', pc(t.hit_rate)], ['Avg model probability', pc(t.average_model_probability)], ['Void', String(t.voids)], ['Pending', String(t.pending)]];
  return `<div class="algo-kpis">${join(cells, ([k, v]) => `<div><p class="kicker">${esc(k)}</p><p class="algo-kpi">${esc(v)}</p></div>`)}</div>`;
}
const calibrationTable = cal => `<div class="tablewrap"><table class="ltable"><thead><tr><th scope="col">Model probability</th><th scope="col">Graded picks</th><th scope="col">Mean model probability</th><th scope="col">Hit rate</th></tr></thead><tbody>${join(cal, b => `<tr><td>${esc(b.band)}</td><td class="num">${b.picks}</td><td class="num">${pc(b.mean_probability)}</td><td class="num">${pc(b.hit_rate)}</td></tr>`)}</tbody></table></div>`;

// Bundesliga (V1) research panel; another model's research is shown with its own disclaimer only
function researchPanel(m, r) {
  if (m.key !== 'bundesliga') return when(r?.disclaimer, () => `<section class="algo-research" aria-labelledby="algo-research-h"><p class="kicker">MODEL RESEARCH · ${esc(m.competition.toUpperCase())}</p><h2 id="algo-research-h">HISTORICAL VALIDATION</h2><p class="algo-banner warn">${esc(r.disclaimer)}</p></section>`);
  const row = (label, s) => `<tr><td>${esc(label)}</td><td class="num">${s.picks ?? s.official_picks}</td><td class="num">${pc(s.coverage)}</td><td class="num">${pc(s.hit_rate)}</td><td class="num">${pc(s.mean_probability)}</td></tr>`;
  const mk = r.markets;
  return `<section class="algo-research" aria-labelledby="algo-research-h">
    <p class="kicker">MODEL RESEARCH · BUNDESLIGA</p><h2 id="algo-research-h">HISTORICAL VALIDATION</h2>
    <p class="algo-banner warn">${esc(r.disclaimer)}</p>
    <div class="tablewrap"><table class="ltable"><thead><tr><th scope="col">Past seasons (research)</th><th scope="col">Picks</th><th scope="col">Coverage</th><th scope="col">Hit rate</th><th scope="col">Mean model probability</th></tr></thead><tbody>
      ${row(`Selection ${r.select.seasons[0]}–${r.select.seasons.at(-1)}: all policy picks`, r.select.combined)}
      ${row(`Holdout ${r.holdout.seasons[0]}–${r.holdout.seasons.at(-1)}: all policy picks`, r.holdout.combined)}
      ${row('Holdout: match result ≥ 60%', mk['1x2'].holdout_picks)}
      ${row('Holdout: home team to score ≥ 87.5%', mk.home_to_score.holdout_picks)}
    </tbody></table></div>
    <p class="muted small">Thresholds were chosen on the selection seasons only and frozen (freeze ${esc(r.select_freeze_sha256.slice(0, 12))}…) before the holdout seasons were evaluated once (${esc(dateTime(r.holdout_evaluated_at))}). Match-result log loss on the holdout: ${esc(mk['1x2'].validation_holdout.log_loss)} against a ${esc(mk['1x2'].validation_holdout.baseline_log_loss)} baseline, better in ${mk['1x2'].validation_holdout.seasons_beating_baseline} of ${mk['1x2'].validation_holdout.seasons} seasons. ${esc(r.prices)}</p>
  </section>`;
}

export const trackRecord = {
  title: () => 'Soccer PBE Picks Track Record | PropBetEdge Soccer',
  async load(_p, sp) {
    // which models are live: one cheap picks read each; the record and research of the SELECTED model only
    const avmDeadline = Date.now() + AVM_WAIT_MS;
    const avmRead = loadAlgoVsMarket();
    const [live] = await Promise.all([loadModels('picks'), boardWithin(AVM_WAIT_MS)]);
    const want = sp?.get('model');
    const model = (live.find(x => x.model.key === want) || live[0] || { model: MODELS[0] }).model;
    const markets = marketsOf((live.find(x => x.model === model)?.res.data.policy) || {}).map(x => x.market);
    const market = markets.includes(sp?.get('market')) ? sp.get('market') : undefined;
    const last = ['30', '60', '100'].includes(sp?.get('last')) ? sp.get('last') : undefined;
    const [rec, res] = await Promise.all([api(`${model.api}/record`, { market, last }), api(`${model.api}/research`)]);
    // Algo vs Market: only for a model with an exactly comparable market (V1, match result); never under another market filter
    const avmOn = Object.values(AVM_ALGO_MODEL).includes(model.key) && (!market || market === '1x2');
    const avm = avmOn ? (await byDeadline(avmRead, avmDeadline)) ?? null : null;
    const op = live.find(x => x.model === model)?.res.data.official_picks;
    const avmPicks = [...(rec.data.picks || []), ...(op?.open || []), ...(op?.recent || [])];
    return { rec, res, market, last, model, live: live.map(x => x.model), markets: marketsOf(rec.data.policy), avm, avmPicks };
  },
  render({ rec, res, market, last, model = MODELS[0], live = [], markets = [], avm = null, avmPicks = [] }) {
    const d = rec.data;
    const avmHtml = trackRecordAvmHtml(avm, model.key, avmPicks);
    const q = o => { const p = new URLSearchParams({ ...(live.length > 1 ? { model: model.key } : {}), ...(market ? { market } : {}), ...(last ? { last } : {}), ...o }); for (const [k, v] of [...p]) if (!v) p.delete(k); return p.toString() ? `?${p}` : ''; };
    const f = (k, v, l) => link(`/track-record${q({ [k]: v || '' })}`, esc(l), `btn${(k === 'market' ? market : last) === v ? ' gold' : ''}`);
    return `${hero(`${model.version.toUpperCase()} · ${model.competition.toUpperCase()} · PUBLIC RECORD`, 'Track <span>record</span>', 'Every Official Pick this model issued after go-live, straight from its append-only ledger. Wins, losses, voids and pending picks. Nothing is removed, nothing from before go-live is counted, and no model shares a record with another.')}
    <section class="canvas algo-canvas"><div class="wrap">
      ${when(live.length > 1, () => `<p class="algo-filters" role="navigation" aria-label="Model">${join(live, m => link(`/track-record?model=${m.key}`, esc(m.tab), `btn${m.key === model.key ? ' gold' : ''}`))}</p>`)}
      ${d.live ? '' : `<div class="algo-banner"><b>The record is empty.</b> Official Picks have not gone live. The first pick after go-live becomes record #1.</div>`}
      <p class="algo-filters">${f('market', undefined, 'All markets')} ${join(markets, x => f('market', x.market, x.name))} <span class="muted">·</span> ${f('last', undefined, 'All')} ${f('last', '30', 'Last 30')} ${f('last', '60', 'Last 60')} ${f('last', '100', 'Last 100')}</p>
      ${sectionHead('OFFICIAL RECORD', `${esc(model.competition)} results`)}
      ${summaryCards(d.totals)}
      <p class="sec-note">Hit rate = hits / (hits + misses). Void and pending picks are not in it. ${esc(d.prices?.reason || '')}</p>
      ${sectionHead('CALIBRATION', 'Model probability vs outcome')}
      ${calibrationTable(d.totals.calibration)}
      ${when(avmHtml, () => `${sectionHead('ALGO VS MARKET', 'PBE pick vs prediction market at lock')}<div class="avm-slot">${avmHtml}</div>`)}
      ${sectionHead('LEDGER', 'Every Official Pick')}
      ${d.picks.length ? pickTable(d.picks.map(p => [model, p]), 'Official Pick ledger', false, avm) : empty('No Official Picks yet', 'The ledger is empty.')}
      ${researchPanel(model, res.data)}
      ${sourcePanel(rec.meta)}
    </div></section>`;
  },
};
export { byKey as MODEL_BY_KEY };
