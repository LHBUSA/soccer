/**
 * Article Market module — ONE module with a lifecycle (contract article-market/1, packet post_event_market_result/1).
 * CANONICAL SOURCE: propbetedge-workers/workers/propsports-markets/client/article-market-ui.js (vendor unchanged,
 * next to kalshi-market-ui.js + article-market-ui.css). docs/POST_EVENT_MARKET_RESULT.md.
 *
 *   articleMarketModule(payload, opts)   HTML string: LIVE MARKET WATCH (market open) or THE MARKET RESULT (event over)
 *   mountArticleMarket(host, opts)       progressive enhancement: first paint from an embedded payload, then refresh
 *                                        ~30 s while visible (never offscreen / hidden tab); frozen packets never refetch
 *
 * Truth rules: venues are separate columns (never averaged); a checkpoint we did not observe says so; PBE-vs-venue
 * only for comparable venues; related markets show their own path under "RULES DIFFER"; LIVE only <= 150 s
 * ("Updated X ago" otherwise; an unchanged price says "unchanged since"); movement after publication is timing only,
 * never attributed to the story. Ineligible / nothing observed -> renders nothing (no empty state).
 *
 * PBE CONTEXT (opts.pbeContext, optional, host-hydrated): sport-native PBE intelligence that is NOT the official
 * Algo-vs-Market record (packet.pbe stays that record, sealed and untouched). Only read when the packet has no
 * official PBE decision; omitted -> the module renders exactly as before. Shape (docs/POST_EVENT_MARKET_RESULT.md):
 *   { scope: 'VALIDATION' | 'TRACKING' | 'NONE', access: 'full' | 'locked',
 *     game_signals: [{ display, price, probability, market, lifecycle, before_kickoff, scope_label }],   // [0] = lead
 *     td_targets:   [{ rank: 'PRIMARY' | 'SECONDARY', name, probability }],
 *     cta: { href, label } }                                                                            // locked only
 * Never compared numerically with a venue here (a pregame decision vs an in-play price is not a comparison), never
 * blended, never relabelled official. A locked context names nothing: no team, player, line, price or probability.
 *
 * LOCALE (opts.locale, optional, default 'en'; soccer#16): the module's OWN presentation text (titles, row labels,
 * freshness, notes, aria labels, the PBE strip) is rendered natively in the requested language from the catalogs
 * below — whole messages, never fragments. Evidence passes through untouched in every language: venue names,
 * market titles, outcome labels, prices, percentages, timestamps, links and settlement values. Venue-sourced
 * English text on a non-English page is marked lang="en" (deliberately English, never half-translated). A
 * server-sent label or disclosure the catalog does not know is shown as sent, marked lang="en". Unknown locale ->
 * English. 'en' (and no locale at all) renders byte for byte what this module rendered before locales existed
 * (test/article-market-locale.test.js, baseline test/fixtures/article-market/en-baseline-d2a920a.json).
 *
 * DISTINCT CONTRACT HEADERS: when one venue carries more than one market for the event (e.g. Polymarket's separate
 * home / draw / away soccer contracts) every column header, PBE line and path caption of that venue also names
 * WHICH contract it is, from the market's own verified metadata only: the single outcome role the contract map
 * assigned to its YES token (home / draw / away), else the venue's market title. The exact venue market title is
 * always kept in the header (visually hidden + tooltip) so each <th scope="col"> is unique and understandable.
 */
import { ageLabel } from './kalshi-market-ui.js'

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const cents = (bp) => (bp == null ? null : `${Number.isInteger(bp / 100) ? bp / 100 : (bp / 100).toFixed(1)}¢`)
const signed = (bp) => (bp == null ? null : `${bp > 0 ? '+' : bp < 0 ? '−' : '±'}${Math.abs(bp / 100).toFixed(1)}¢`)
const pts = (x) => (x == null ? null : `${x > 0 ? '+' : x < 0 ? '−' : '±'}${Math.abs(x).toFixed(1)} pts`)
const time = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toISOString().slice(11, 16) + ' UTC' : '' }

// ---------------------------------------------------------------------------------------------------------
// Presentation catalogs. EN reproduces the pre-locale strings exactly (byte-identity is tested).
const EN = {
  code: 'en',
  missing: { NO_OBSERVATION_AT_PBE_FORECAST: 'Not observed', NO_OBSERVED_PRE_EVENT_PRICE: 'No observed pre-event price', NO_OBSERVATION_AT_TIME: 'Not observed' },
  notObserved: 'Not observed',
  venueClass: { EXACT_MATCH: 'Exact match', COMPARABLE_EXCEPT_EXCEPTIONS: 'Comparable · postponement rules differ' },
  labels: {}, // server-sent venue labels: shown as sent in English
  disclosures: {}, // server-sent disclosures: shown as sent (+ '.') in English
  roleContract: { home: 'Home win', away: 'Away win', draw: 'Draw' },
  focusContract: 'Focus contract',
  chartAria: (n) => `Mid-market across ${n} observed snapshots`,
  pathCaption: ' · pre-event path',
  observedPrices: (n) => `${n} observed prices`,
  row: { first: 'First observed', pub: 'At publication', lock: 'At PBE lock', pre: 'Pre-event', final: 'Final trade', settle: 'Settlement', move: 'Move (first → pre-event)' },
  awaitingSettlement: 'Awaiting settlement',
  awaiting: 'Awaiting',
  result: { yes: 'YES', no: 'NO' },
  noCall: '<span class="am__sr">PBE: </span><b>No official call</b> on this event',
  noDecision: '<span class="am__sr">PBE: </span><b>No PBE decision</b> on this event',
  ctxTitle: { VALIDATION: 'PBE live validation', TRACKING: 'PBE tracking' },
  ctxFoot: 'Validation/tracking scope · not the Official Track Record',
  ctxExists: { VALIDATION: 'PBE live validation intelligence exists for this game', TRACKING: 'PBE tracking intelligence exists for this game' },
  unlock: 'Unlock',
  lockedAtKickoff: 'Locked at kickoff',
  lockedBeforeKickoff: 'Locked before kickoff',
  activeDecision: 'Pre-game decision · can be replaced until kickoff',
  otherSignal: 'Other game signal',
  tdTargets: 'TD targets',
  notComparable: 'Not comparable',
  notScored: ' · not scored',
  atLock: (venue) => `${venue} at PBE lock`,
  moved: { TOWARD: ' · then moved toward PBE', AWAY: ' · then moved away from PBE', UNCHANGED: ' · unchanged after the PBE lock' },
  grade: { W: 'PBE side won', L: 'PBE side lost', VOID: 'Void', pending: 'Result pending' },
  pbeVsMarket: 'PBE vs market',
  on: ' on ',
  locked: ' · locked ',
  sincePub: 'Since publication',
  notObservedAtPub: 'Not observed at publication',
  sinceFirst: 'Since first observed',
  checked: 'Checked',
  live: 'LIVE',
  updated: (ageS) => `Updated ${ageLabel(ageS)}`,
  venueNow: (venue) => `${venue} now`,
  field: { first: 'First obs.', pub: 'At pub.', pre: 'Pre-event', final: 'Final trade', result: 'Result', now: 'Now', sincePub: 'Since pub.', sinceFirst: 'Since first obs.' },
  won: 'Won',
  more: (n, venue) => `+${n} more in the field on ${venue}`,
  winnerMarket: ' · winner market',
  leaders: ' · leaders',
  title: { result: 'The market result', live: 'Live market watch' },
  tag: { settled: 'Settled', pending: 'Awaiting venue settlement', inplay: 'In-play prices', pre: 'Pre-event prices' },
  notes: {
    observed: 'Prediction-market prices are our timestamped observations of public venue data, shown per venue and never averaged.',
    timing: 'Movement after publication is timing only; it does not mean this story moved the market.',
    field: 'One contract per participant; "—" means we did not observe a price at that checkpoint.',
    fieldResult: 'Pre-event = our last observed price before the scheduled start; the result is the venue settlement.',
  },
}

// Spanish: neutral international football Spanish, "tú" register, the same vocabulary as the hosts' catalogs
// ("en vivo", "cierre PBE", "plataforma" for a venue). Numbers, prices and times keep their source form.
const ageEs = (sec) => {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return ''
  if (sec < 60) return `${Math.max(0, Math.round(sec))} s`
  const m = Math.round(sec / 60)
  return m < 60 ? `${m} min` : `${Math.round(m / 60)} h`
}
const ES = {
  code: 'es',
  missing: { NO_OBSERVATION_AT_PBE_FORECAST: 'No observado', NO_OBSERVED_PRE_EVENT_PRICE: 'Sin precio observado antes del evento', NO_OBSERVATION_AT_TIME: 'No observado' },
  notObserved: 'No observado',
  venueClass: { EXACT_MATCH: 'Coincidencia exacta', COMPARABLE_EXCEPT_EXCEPTIONS: 'Comparable · difieren las reglas de aplazamiento' },
  labels: {
    'RELATED MARKET · RULES DIFFER': 'MERCADO RELACIONADO · REGLAS DISTINTAS',
    'RELATED MARKET · RULES NOT VERIFIED': 'MERCADO RELACIONADO · REGLAS NO VERIFICADAS',
  },
  disclosures: {
    'Postponement/cancellation settlement rules differ between venues': 'Las reglas de liquidación por aplazamiento o cancelación difieren entre plataformas.',
    'Normal 90-minute result rules match. Postponement, cancellation and fallback settlement rules differ between venues.': 'Las reglas del resultado a 90 minutos coinciden. Las reglas de liquidación por aplazamiento, cancelación y fuente alternativa difieren entre plataformas.',
    'Official race result rules match. Postponement, cancellation and fallback-source settlement rules differ between venues.': 'Las reglas del resultado oficial de la carrera coinciden. Las reglas de liquidación por aplazamiento, cancelación y fuente alternativa difieren entre plataformas.',
  },
  roleContract: { home: 'Victoria local', away: 'Victoria visitante', draw: 'Empate' },
  focusContract: 'Contrato destacado',
  chartAria: (n) => `Precio medio en ${n} observaciones registradas`,
  pathCaption: ' · evolución antes del evento',
  observedPrices: (n) => `${n} precios observados`,
  row: { first: 'Primera observación', pub: 'En la publicación', lock: 'En el cierre PBE', pre: 'Antes del evento', final: 'Última operación', settle: 'Liquidación', move: 'Movimiento (primera → antes del evento)' },
  awaitingSettlement: 'Pendiente de liquidación',
  awaiting: 'Pendiente',
  result: { yes: 'SÍ', no: 'NO', split: '50-50' },
  // Authoritative NO_PBE_DECISION only (packet.pbe_status); the visible PBE mark is decorative, the sentence names PBE.
  noCall: '<b>PBE no ha emitido una selección oficial</b> para este evento.',
  noDecision: '<b>PBE no tiene una decisión</b> para este evento.',
  ctxTitle: { VALIDATION: 'Validación en vivo de PBE', TRACKING: 'Seguimiento de PBE' },
  ctxFoot: 'Ámbito de validación/seguimiento · no forma parte del historial oficial',
  ctxExists: { VALIDATION: 'Hay inteligencia de validación en vivo de PBE para este partido', TRACKING: 'Hay inteligencia de seguimiento de PBE para este partido' },
  unlock: 'Desbloquear',
  lockedAtKickoff: 'Fijada al inicio del partido',
  lockedBeforeKickoff: 'Fijada antes del inicio del partido',
  activeDecision: 'Decisión previa al partido · puede sustituirse hasta el inicio',
  otherSignal: 'Otra señal del partido',
  tdTargets: 'Objetivos de touchdown',
  notComparable: 'No comparable',
  notScored: ' · sin evaluar',
  atLock: (venue) => `${venue} en el cierre PBE`,
  moved: { TOWARD: ' · después se movió hacia PBE', AWAY: ' · después se alejó de PBE', UNCHANGED: ' · sin cambios tras el cierre PBE' },
  grade: { W: 'Ganó el lado de PBE', L: 'Perdió el lado de PBE', VOID: 'Anulada', pending: 'Resultado pendiente' },
  pbeVsMarket: 'PBE frente al mercado',
  on: ' para ',
  locked: ' · cierre ',
  sincePub: 'Desde la publicación',
  notObservedAtPub: 'No observado en la publicación',
  sinceFirst: 'Desde la primera observación',
  checked: 'Comprobado',
  live: 'EN VIVO',
  updated: (ageS) => `Actualizado hace ${ageEs(ageS)}`,
  venueNow: (venue) => `${venue} ahora`,
  field: { first: 'Primera obs.', pub: 'En la publ.', pre: 'Antes', final: 'Última op.', result: 'Resultado', now: 'Ahora', sincePub: 'Desde la publ.', sinceFirst: 'Desde la 1.ª obs.' },
  won: 'Ganó',
  more: (n, venue) => `+${n} más en el mercado completo de ${venue}`,
  winnerMarket: ' · mercado de ganador',
  leaders: ' · líderes',
  title: { result: 'El resultado del mercado', live: 'Seguimiento del mercado en vivo' },
  tag: { settled: 'Liquidado', pending: 'Pendiente de liquidación', inplay: 'Precios en juego', pre: 'Precios previos al evento' },
  notes: {
    observed: 'Los precios de los mercados de predicción son nuestras observaciones con fecha y hora de datos públicos de cada plataforma, mostrados por plataforma y nunca promediados.',
    timing: 'El movimiento posterior a la publicación es solo temporal; no significa que esta noticia haya movido el mercado.',
    field: 'Un contrato por participante; «—» significa que no observamos un precio en ese punto de control.',
    fieldResult: 'Antes = nuestro último precio observado antes del inicio programado; el resultado es la liquidación de la plataforma.',
  },
}
export const ARTICLE_MARKET_LOCALES = Object.freeze({ en: EN, es: ES })
const catalog = (locale) => ARTICLE_MARKET_LOCALES[String(locale || 'en').toLowerCase().split('-')[0]] || EN

// Venue-sourced text (market titles, outcome labels, unknown server labels): escaped as is; on a non-English page
// marked as English so it is never mistaken for (or machine-mixed with) the page language.
const src = (t, s) => (t.code === 'en' ? esc(s) : `<span lang="en">${esc(s)}</span>`)
// A server-sent label / disclosure: the catalog's whole-message translation, else the original marked English.
const known = (t, map, s) => (t.code === 'en' ? esc(s) : map[s] !== undefined ? esc(map[s]) : src(t, s))

const venueTag = (v, t) => (v.label ? known(t, t.labels, v.label) : t.venueClass[v.semantic_class] ? esc(t.venueClass[v.semantic_class]) : null)
const cell = (c, t) => (!c ? '<span class="am__na">—</span>' : c.missing ? `<span class="am__na">${esc(t.missing[c.missing] || t.notObserved)}</span>` : `<b>${esc(cents(c.mid_bp))}</b>`)

// Venues that carry more than one market for this event (non-field): only these get a contract line, so a venue
// with one market renders exactly as before.
function multiMarketVenues(packet) {
  const n = new Map()
  for (const v of packet.venues) if (!v.field) n.set(v.venue, (n.get(v.venue) || 0) + 1)
  return new Set([...n].filter(([, c]) => c > 1).map(([k]) => k))
}
// The specific contract of one market, from its own verified metadata: the single outcome role its contract map
// assigned (home / draw / away), else its venue title. null when nothing verified names it.
function contractOf(v, t) {
  const roles = [...new Set((v.outcomes || []).map((o) => o.role).filter((r) => r != null))]
  if (roles.length === 1 && t.roleContract[roles[0]]) return { short: esc(t.roleContract[roles[0]]), title: v.title || null }
  if (v.title) return { short: src(t, v.title), title: v.title }
  return null
}
const contractFor = (v, t, multi) => (multi.has(v.venue) ? contractOf(v, t) : null)
// Venue name for list lines / captions: "Polymarket · Home win" only for a multi-market venue.
const venueName = (v, t, multi) => { const c = contractFor(v, t, multi); return `${esc(v.venue_label)}${c ? ` · ${c.short}` : ''}` }

// Focus outcome: the PBE selection, else the event winner, else the first outcome.
function focusRole(packet) {
  return packet.pbe?.selection_role || packet.event_result?.winner_role || packet.venues[0]?.outcomes[0]?.role || null
}
const outcomeOf = (v, role) => v.outcomes.find((o) => o.role === role) || null
// The PBE selection's name: the frozen label, else the venue's own outcome label for that role (never a bare role).
const selectionName = (packet) => {
  const role = packet.pbe?.selection_role, own = packet.pbe?.selection_label
  if (own && own !== role) return own // some ledgers store the bare role ('away') as the label: not a name
  return packet.venues.map((v) => outcomeOf(v, role)?.label).find((l) => l && l !== role) || own || role
}

// The focus outcome's label exactly as stored (never expanded or renamed), inside an intentional focus treatment.
const focusBlock = (label, t) => `<p class="am__focus"><span class="am__fcl">${esc(t.focusContract)}</span><b class="am__fcv">${src(t, label)}</b></p>`
// Column header: venue link, then (multi-market venues only) WHICH contract — a short visible line plus the exact
// venue market title for screen readers and as a tooltip — then the venue's comparability tag.
function venueHead(v, t, multi) {
  const tag = venueTag(v, t)
  const c = contractFor(v, t, multi)
  const ct = c ? `<small class="am__ct"${c.title ? ` title="${esc(c.title)}"` : ''}>${c.short}${c.title && c.short !== src(t, c.title) ? `<span class="am__sr"> · ${src(t, c.title)}</span>` : ''}</small>` : ''
  return `<a href="${esc(v.market_url)}" target="_blank" rel="sponsored noopener">${esc(v.venue_label)}</a>${ct}${tag ? `<small>${tag}</small>` : ''}`
}
// Label column ~39%, the venues split the rest evenly. Three or more venue columns: a narrower label column.
const cols = (n) => `<colgroup><col class="am__c0">${'<col>'.repeat(n)}</colgroup>`
const tableClass = (n) => `am__t${n >= 3 ? ' am__t--wide' : ''}`
// Settlement badge: driven only by the venue's recorded settlement; none recorded -> the pending text.
function settleBadge(st, pending, t) {
  if (!st) return `<span class="am__badge am__badge--pending">${esc(pending)}</span>`
  const r = String(st.result || '').toLowerCase()
  const text = r === 'yes' ? t.result.yes : r === 'no' ? t.result.no : (t.result[r] ?? String(st.result || '').toUpperCase())
  return `<span class="am__badge am__badge--${r === 'yes' || r === 'no' ? r : 'other'}">${esc(text)}</span>`
}

// Pre-event price path for the result module: observed points only, drawn as a STEP line (each price holds until
// the next read; no interpolation, no smoothing, nothing added). Same scale rule as the shared sparkline (a sub-2¢
// range is drawn on a 2¢ scale, never exaggerated) and the same up/down/flat direction classes. Styled entirely by
// article-market-ui.css, so a host without kalshi-market-ui.css still draws it. Dots are zero-length round-capped
// segments with a non-scaling stroke: they stay round when the stretched SVG is wider than its viewBox.
const CHART_W = 300, CHART_H = 60, CHART_PAD = 5
function stepChart(points, t) {
  const pts = (points || []).filter((p) => p.mid_bp != null && Number.isFinite(Date.parse(p.t)))
  if (pts.length < 2) return ''
  const t0 = Date.parse(pts[0].t), span = Math.max(1, Date.parse(pts[pts.length - 1].t) - t0)
  const vals = pts.map((p) => p.mid_bp)
  let lo = Math.min(...vals), hi = Math.max(...vals)
  if (hi - lo < 200) { const mid = (hi + lo) / 2; lo = mid - 100; hi = mid + 100 }
  const x = (tt) => (CHART_PAD + ((Date.parse(tt) - t0) / span) * (CHART_W - 2 * CHART_PAD)).toFixed(1)
  const y = (v) => (CHART_PAD + (1 - (v - lo) / (hi - lo)) * (CHART_H - 2 * CHART_PAD)).toFixed(1)
  let d = `M${x(pts[0].t)},${y(pts[0].mid_bp)}`
  for (let i = 1; i < pts.length; i++) d += ` H${x(pts[i].t)} V${y(pts[i].mid_bp)}`
  const dots = pts.map((p) => `M${x(p.t)},${y(p.mid_bp)}h0`).join(' ')
  const dir = vals[vals.length - 1] > vals[0] ? 'up' : vals[vals.length - 1] < vals[0] ? 'down' : 'flat'
  return `<svg class="am__chart am__chart--${dir}" viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="none" role="img" aria-label="${esc(t.chartAria(pts.length))}"><path class="am__cl" d="${d}"/><path class="am__cd" d="${dots}"/></svg>`
}
// One chart well per venue: caption, the first and last OBSERVED prices of the path, the observation count.
function pathWell(nameHtml, spark, t) {
  const pts = spark.filter((p) => p.mid_bp != null)
  const ends = pts.length >= 2 ? `<span class="am__ends">${esc(cents(pts[0].mid_bp))} → ${esc(cents(pts[pts.length - 1].mid_bp))}</span>` : ''
  return `<figure class="am__spark"><figcaption><span>${nameHtml}${esc(t.pathCaption)}</span>${ends}</figcaption>${stepChart(spark.map((p) => ({ t: p.t, mid_bp: p.mid_bp })), t)}<small class="am__obs">${esc(t.observedPrices(pts.length))}</small></figure>`
}

function resultTable(packet, t) {
  const role = focusRole(packet)
  const vs = packet.venues.filter((v) => !v.field && outcomeOf(v, role))
  if (!vs.length) return ''
  const multi = multiMarketVenues(packet)
  const label = outcomeOf(vs[0], role)?.label || role
  const rows = [
    [t.row.first, (o) => cell(o.first_observed, t)],
    packet.article ? [t.row.pub, (o) => cell(o.at_publication, t)] : null,
    packet.pbe ? [t.row.lock, (o) => cell(o.at_pbe_lock, t)] : null,
    [t.row.pre, (o) => cell(o.pre_event, t)],
    [t.row.final, (o) => (o.close?.final_trade_bp != null ? `<b>${esc(cents(o.close.final_trade_bp))}</b>` : '<span class="am__na">—</span>'), 'am__key'],
    [t.row.settle, (o) => settleBadge(o.settlement, t.awaitingSettlement, t)],
    [t.row.move, (o) => (o.move?.first_to_pre_event_bp != null ? `<b>${esc(signed(o.move.first_to_pre_event_bp))}</b>` : '<span class="am__na">—</span>')],
  ].filter(Boolean)
  const head = vs.map((v) => `<th scope="col">${venueHead(v, t, multi)}</th>`).join('')
  const body = rows.map(([name, f, cls]) => `<tr${cls ? ` class="${cls}"` : ''}><th scope="row">${esc(name)}</th>${vs.map((v) => `<td>${f(outcomeOf(v, role))}</td>`).join('')}</tr>`).join('')
  const sparks = vs.map((v) => { const s = outcomeOf(v, role).sparkline; return s.length >= 3 ? pathWell(venueName(v, t, multi), s, t) : '' }).join('')
  return `${focusBlock(label, t)}<div class="am__tw"><table class="${tableClass(vs.length)}">${cols(vs.length)}<thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table></div>${sparks ? `<div class="am__sparks">${sparks}</div>` : ''}`
}

// PBE closing strip. The visible "PBE" mark is decorative (aria-hidden); screen readers get the "PBE: " prefix.
const pbeMark = '<span class="am__pbeid" aria-hidden="true">PBE</span>'
// ONLY the authoritative packet status NO_PBE_DECISION says "no official call"; pending / missing say nothing.
const noCall = (packet, t) => (packet.pbe_status === 'NO_PBE_DECISION' ? `<div class="am__pbe am__pbe--none">${pbeMark}<p class="am__pbeh">${t.noCall}</p></div>` : '')

// Non-official PBE context (see header). Absent -> the original no-call strip, byte for byte.
const pct = (p) => `${Math.round(Number(p) * 1000) / 10}%`
const american = (n) => (n == null || n === '' || !Number.isFinite(Number(n)) ? '' : Number(n) > 0 ? `+${Number(n)}` : `${Number(n)}`)
const signalTerms = (s) => [s.display, american(s.price)].filter(Boolean).join(' ')
function lockLine(s, t) {
  if (s.lifecycle === 'LOCKED' || s.lifecycle === 'FINAL') return s.before_kickoff === false ? t.lockedAtKickoff : t.lockedBeforeKickoff
  if (s.lifecycle === 'ACTIVE') return t.activeDecision
  return null
}
const scopeWord = (s) => String(s.scope_label || '').replace(/^PBE\s+/i, '').toLowerCase() || null
function contextBlock(packet, ctx, t) {
  if (ctx === undefined || ctx === null) return noCall(packet, t)
  const ctxFoot = `<p class="am__ctxf">${esc(t.ctxFoot)}</p>`
  const scope = String(ctx.scope || 'NONE').toUpperCase()
  const title = t.ctxTitle[scope]
  if (!title) return `<div class="am__pbe am__pbe--none">${pbeMark}<p class="am__pbeh">${t.noDecision}</p></div>`
  if (ctx.access !== 'full') {
    const cta = ctx.cta?.href ? `<a class="am__ctxcta" href="${esc(ctx.cta.href)}">${esc(ctx.cta.label || t.unlock)}</a>` : ''
    return `<div class="am__pbe am__pbe--ctx am__pbe--locked">${pbeMark}<div class="am__pbeb"><h4>${esc(title)}</h4><p class="am__pbeh"><span class="am__sr">PBE: </span>${esc(t.ctxExists[scope])}</p>${cta}${ctxFoot}</div></div>`
  }
  const signals = (Array.isArray(ctx.game_signals) ? ctx.game_signals : []).filter((s) => s && s.display && Number.isFinite(Number(s.probability)))
  const targets = (Array.isArray(ctx.td_targets) ? ctx.td_targets : []).filter((x) => x && x.name && Number.isFinite(Number(x.probability)))
  if (!signals.length && !targets.length) return noCall(packet, t)
  const [lead, ...rest] = signals
  // scope_label is host-sent English: shown as sent (marked English on a non-English page).
  const leadSub = lead ? [lockLine(lead, t) && esc(lockLine(lead, t)), scopeWord(lead) && src(t, scopeWord(lead))].filter(Boolean).join(' · ') : ''
  const leadHtml = lead ? `<p class="am__pbeh"><span class="am__sr">PBE: </span><b>${src(t, signalTerms(lead))}</b> · <b>PBE ${esc(pct(lead.probability))}</b></p>${leadSub ? `<p class="am__ctxs">${leadSub}</p>` : ''}` : ''
  const related = rest.length ? `<ul class="am__ctxl">${rest.map((s) => `<li><span>${esc(t.otherSignal)}</span><span>${src(t, signalTerms(s))} · PBE ${esc(pct(s.probability))}</span></li>`).join('')}</ul>` : ''
  const td = targets.length ? `<h4 class="am__ctxh">${esc(t.tdTargets)}</h4><ul class="am__ctxl">${targets.map((x) => `<li><span>${esc(String(x.rank || '').toUpperCase())} · ${esc(x.name)}</span><span>${esc(pct(x.probability))}</span></li>`).join('')}</ul>` : ''
  return `<div class="am__pbe am__pbe--ctx">${pbeMark}<div class="am__pbeb"><h4>${esc(title)}</h4>${leadHtml}${related}${td}${ctxFoot}</div></div>`
}
function pbeBlock(packet, ctx, t) {
  const p = packet.pbe
  if (!p) return contextBlock(packet, ctx, t)
  const multi = multiMarketVenues(packet)
  const lines = packet.venues.map((v) => {
    const name = venueName(v, t, multi)
    if (!v.comparable_to_pbe) return `<li><span>${name}</span><span class="am__na">${venueTag(v, t) || esc(t.notComparable)}${esc(t.notScored)}</span></li>`
    const c = v.pbe_vs_venue
    if (!c || c.venue_at_pbe_lock_bp == null) return `<li><span>${t.atLock(name)}</span><span class="am__na">${esc(t.notObserved)}</span></li>`
    const moved = t.moved[c.moved_after_pbe] || ''
    return `<li><span>${t.atLock(name)}</span><span><b>${esc(cents(c.venue_at_pbe_lock_bp))}</b> · PBE ${esc(pts(c.divergence_pts))}${esc(moved)}</span></li>`
  }).join('')
  const grade = p.grade === 'W' ? t.grade.W : p.grade === 'L' ? t.grade.L : p.grade === 'VOID' ? t.grade.VOID : t.grade.pending
  return `<div class="am__pbe">${pbeMark}<div class="am__pbeb"><h4>${esc(t.pbeVsMarket)}</h4><p class="am__pbeh"><b>PBE ${esc(Math.round(p.probability * 1000) / 10)}%</b>${t.on}${src(t, selectionName(packet))}${t.locked}${esc(time(p.lock_at))} · <span class="am__g am__g--${esc(String(p.grade || 'pending').toLowerCase())}">${esc(grade)}</span></p><ul>${lines}</ul></div></div>`
}

function liveTable(payload, ctx, t) {
  const { packet, live } = payload
  const vs = live.venues.filter((v) => v.outcomes.some((o) => o.current))
  if (!vs.length) return ''
  const multi = multiMarketVenues(packet)
  const key = (v) => `${v.venue}|${v.venue_market_id ?? ''}`
  const pv = new Map(packet.venues.map((v) => [key(v), v]))
  const pvOf = (v) => pv.get(key(v)) || {}
  const roles = vs[0].outcomes.map((o) => o.role)
  const head = vs.map((v) => { const pvv = pvOf(v); return `<th scope="col">${venueHead({ ...pvv, venue: v.venue, outcomes: pvv.outcomes || v.outcomes, venue_label: pvv.venue_label || v.venue }, t, multi)}</th>` }).join('')
  const priceRows = roles.map((r) => `<tr><th scope="row">${src(t, vs[0].outcomes.find((o) => o.role === r)?.label || r)}</th>${vs.map((v) => { const o = v.outcomes.find((x) => x.role === r); return `<td>${o?.current ? `<b data-am-px>${esc(cents(o.current.mid_bp))}</b>` : '<span class="am__na">—</span>'}</td>` }).join('')}</tr>`).join('')
  const focus = focusRole(packet) || roles[0]
  const pubRow = packet.article ? `<tr class="am__sub"><th scope="row">${esc(t.sincePub)}</th>${vs.map((v) => { const o = v.outcomes.find((x) => x.role === focus); return `<td>${o?.since_publication_bp != null ? esc(signed(o.since_publication_bp)) : `<span class="am__na">${esc(t.notObservedAtPub)}</span>`}</td>` }).join('')}</tr>` : ''
  const firstRow = `<tr class="am__sub"><th scope="row">${esc(t.sinceFirst)}</th>${vs.map((v) => { const o = v.outcomes.find((x) => x.role === focus); return `<td>${o?.since_first_bp != null ? esc(signed(o.since_first_bp)) : '<span class="am__na">—</span>'}</td>` }).join('')}</tr>`
  const fresh = `<tr class="am__sub"><th scope="row">${esc(t.checked)}</th>${vs.map((v) => { const o = v.outcomes.find((x) => x.role === focus) || v.outcomes[0]; return `<td data-am-age="${esc(o.checked_at || '')}">${o.freshness === 'LIVE' ? `<span class="am__live">${esc(t.live)}</span>` : esc(t.updated(o.age_s))}</td>` }).join('')}</tr>`
  const pbeNow = packet.pbe ? vs.map((v) => (v.pbe_now ? `<li><span>${t.venueNow(pv.get(key(v)) ? venueName(pv.get(key(v)), t, multi) : esc(v.venue))}</span><span>PBE ${esc(pts(v.pbe_now.divergence_now_pts))}</span></li>` : '')).join('') : ''
  const pbe = !packet.pbe ? contextBlock(packet, ctx, t) : packet.pbe ? `<div class="am__pbe">${pbeMark}<div class="am__pbeb"><p class="am__pbeh"><b>PBE ${esc(Math.round(packet.pbe.probability * 1000) / 10)}%</b>${t.on}${src(t, selectionName(packet))}</p>${pbeNow ? `<ul>${pbeNow}</ul>` : ''}</div></div>` : ''
  return `<div class="am__tw"><table class="${tableClass(vs.length)}">${cols(vs.length)}<thead><tr><th></th>${head}</tr></thead><tbody>${priceRows}${pubRow}${firstRow}${fresh}</tbody></table></div>${pbe}`
}

// ---------------------------------------------------------------------------------------------------------
// FIELD markets (golf tournament, F1 race: one contract per participant). Shows the article's participants (the
// packet's `focus` flags, from the host's `focus` list of canonical ids) else the field leaders, the venue winner
// once settled, and a clear "+N more" linking to the full market. Same truth rules: observed prices only, a
// checkpoint we did not observe is "—" (legend says so), no averaging, settlement is the venue's.
const FIELD_LEADERS = 5
const focusRoles = (focus) => new Set((Array.isArray(focus) ? focus : String(focus || '').split(',')).map((x) => String(x).trim()).filter(Boolean).map((x) => (x.startsWith('p:') ? x : `p:${x}`)))
function fieldRows(v, result, focus) {
  const want = focusRoles(focus)
  const rank = (o, i) => o.rank ?? i + 1
  const focused = v.outcomes.filter((o) => o.focus || want.has(o.role))
  const rows = focused.length ? focused.slice() : v.outcomes.filter((o, i) => rank(o, i) <= FIELD_LEADERS)
  if (result) for (const o of v.outcomes) if (o.settlement?.result === 'yes' && !rows.includes(o)) rows.push(o)
  rows.sort((a, b) => rank(a, v.outcomes.indexOf(a)) - rank(b, v.outcomes.indexOf(b)))
  const size = v.field_size ?? v.outcomes.length + (v.more_outcomes || 0)
  return { rows, more: Math.max(0, size - rows.length), focused: focused.length > 0 }
}
const fcell = (c, t, { move = null } = {}) => (!c || c.missing || c.mid_bp == null ? `<span class="am__na"${c?.missing ? ` title="${esc(t.missing[c.missing] || t.notObserved)}"` : ''}>—</span>` : `<b>${esc(cents(c.mid_bp))}</b>${move != null ? `<small class="am__mv">${esc(signed(move))}</small>` : ''}`)
const fname = (o, t) => `${o.settlement?.result === 'yes' ? `<span class="am__win">${esc(t.won)}</span> ` : ''}${src(t, o.label || o.role)}`
const moreLine = (v, more, t) => (more > 0 ? `<p class="am__more"><a href="${esc(v.market_url)}" target="_blank" rel="sponsored noopener">${esc(t.more(more, v.venue_label))}</a></p>` : '')
const fieldHead = (v, focused, t) => `<p class="am__focus"><a href="${esc(v.market_url)}" target="_blank" rel="sponsored noopener">${esc(v.venue_label)}</a>${esc(t.winnerMarket)}${focused ? '' : esc(t.leaders)}</p>`

function fieldResult(packet, v, focus, t) {
  const { rows, more, focused } = fieldRows(v, true, focus)
  if (!rows.length) return ''
  const fc = [
    [t.field.first, (o) => fcell(o.first_observed, t)],
    packet.article ? [t.field.pub, (o) => fcell(o.at_publication, t)] : null,
    [t.field.pre, (o) => fcell(o.pre_event, t, { move: o.move?.first_to_pre_event_bp ?? null })],
    [t.field.final, (o) => (o.close?.final_trade_bp != null ? `<b>${esc(cents(o.close.final_trade_bp))}</b>` : '<span class="am__na">—</span>')],
    [t.field.result, (o) => settleBadge(o.settlement, t.awaiting, t)],
  ].filter(Boolean)
  const head = fc.map(([n]) => `<th scope="col">${esc(n)}</th>`).join('')
  const body = rows.map((o) => `<tr><th scope="row">${fname(o, t)}</th>${fc.map(([, f]) => `<td>${f(o)}</td>`).join('')}</tr>`).join('')
  return `${fieldHead(v, focused, t)}<div class="am__tw"><table class="am__t am__t--field"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table></div>${moreLine(v, more, t)}`
}

function fieldLive(payload, v, focus, t) {
  const { packet, live } = payload
  const lv = live.venues.find((x) => x.venue === v.venue && (x.venue_market_id ?? null) === (v.venue_market_id ?? null))
  if (!lv || !lv.outcomes.some((o) => o.current)) return ''
  const { rows, more, focused } = fieldRows(v, false, focus)
  const now = (r) => lv.outcomes.find((o) => o.role === r) || null
  if (!rows.some((o) => now(o.role)?.current)) return ''
  const fc = [
    [t.field.now, (l) => (l?.current ? `<b data-am-px>${esc(cents(l.current.mid_bp))}</b>` : '<span class="am__na">—</span>')],
    packet.article ? [t.field.sincePub, (l) => (l?.since_publication_bp != null ? esc(signed(l.since_publication_bp)) : '<span class="am__na">—</span>')] : null,
    [t.field.sinceFirst, (l) => (l?.since_first_bp != null ? esc(signed(l.since_first_bp)) : '<span class="am__na">—</span>')],
  ].filter(Boolean)
  const head = fc.map(([n]) => `<th scope="col">${esc(n)}</th>`).join('')
  const body = rows.map((o) => `<tr><th scope="row">${fname(o, t)}</th>${fc.map(([, f]) => `<td>${f(now(o.role))}</td>`).join('')}</tr>`).join('')
  const ck = lv.outcomes.find((o) => o.checked_at) || lv.outcomes[0]
  const fresh = `<tr class="am__sub"><th scope="row">${esc(t.checked)}</th><td colspan="${fc.length}" data-am-age="${esc(ck.checked_at || '')}">${ck.freshness === 'LIVE' ? `<span class="am__live">${esc(t.live)}</span>` : esc(t.updated(ck.age_s))}</td></tr>`
  return `${fieldHead(v, focused, t)}<div class="am__tw"><table class="am__t am__t--field"><thead><tr><th></th>${head}</tr></thead><tbody>${body}${fresh}</tbody></table></div>${moreLine(v, more, t)}`
}

function shell({ result, field, placement, packet, live, body, notes }, t) {
  const title = result ? t.title.result : t.title.live
  const tag = result ? (packet.packet_state === 'FINAL' ? t.tag.settled : t.tag.pending) : live.in_play ? t.tag.inplay : t.tag.pre
  const tagState = result ? (packet.packet_state === 'FINAL' ? 'settled' : 'pending') : live.in_play ? 'inplay' : 'pre'
  return `<section class="am am--${result ? 'result' : 'live'}${field ? ' am--field' : ''}" data-am-placement="${esc(placement)}" data-am-sha="${esc(packet.sha256)}"${t.code === 'en' ? '' : ` data-am-locale="${t.code}"`} aria-label="${esc(title)}"><header class="am__hd"><h3>${esc(title)}</h3><span class="am__tag am__tag--${tagState}">${esc(tag)}</span></header>${body}<ul class="am__notes">${notes.filter(Boolean).map((n) => `<li>${n}</li>`).join('')}</ul></section>`
}

export function articleMarketModule(payload, { placement = 'article', focus = null, pbeContext = null, locale = 'en' } = {}) {
  if (!payload?.eligible || !payload.packet || !payload.live || payload.packet.packet_state === 'NO_MARKET_OBSERVED') return ''
  const t = catalog(locale)
  const { packet, live } = payload
  const result = live.mode === 'MARKET_RESULT'
  const fv = packet.venues.find((v) => v.field)
  if (fv) return fieldModule(payload, fv, { placement, focus, result, pbeContext }, t)
  const body = result ? resultTable(packet, t) + pbeBlock(packet, pbeContext, t) : liveTable(payload, pbeContext, t)
  if (!body) return ''
  const d = packet.venues.find((v) => v.disclosure)?.disclosure
  const notes = [
    esc(t.notes.observed),
    packet.article ? esc(t.notes.timing) : null,
    d ? (t.code === 'en' ? esc(d + '.') : t.disclosures[d] !== undefined ? esc(t.disclosures[d]) : src(t, d + '.')) : null,
  ]
  return shell({ result, field: false, placement, packet, live, body, notes }, t)
}

function fieldModule(payload, fv, { placement, focus, result, pbeContext = null }, t) {
  const { packet, live } = payload
  const table = result ? fieldResult(packet, fv, focus, t) : fieldLive(payload, fv, focus, t)
  if (!table) return ''
  const body = table + (packet.pbe ? '' : contextBlock(packet, pbeContext, t))
  const notes = [
    esc(t.notes.observed),
    esc(t.notes.field),
    result ? esc(t.notes.fieldResult) : null,
    packet.article ? esc(t.notes.timing) : null,
  ]
  return shell({ result, field: true, placement, packet, live, body, notes }, t)
}

// Progressive enhancement. opts: { base (REQUIRED, the product's same-origin path, e.g. '/api/markets'), sport, eventId, publishedAt, initial (embedded payload), refreshMs, fetchImpl,
//   focus (optional, FIELD events only: the article's participants as canonical ids — golf-api player slug / f1-api driver id),
//   pbeContext (optional: the context object, or a function returning the current one — see header),
//   locale (optional, default 'en': the presentation language, or a function returning the current one) }.
// The returned stop() also carries stop.repaint(): re-render the last payload now (e.g. once the host's PBE context lands
// or the host's language changed without a page load). Every refresh renders in the current locale.
// The host should reserve the module's height server-side when the article is eligible (zero CLS). A FINAL packet is
// rendered once and never refetched (it is the article's permanent record).
export function mountArticleMarket(host, { base, sport, eventId, publishedAt, initial = null, refreshMs = 30000, fetchImpl = (...a) => globalThis.fetch(...a), focus = null, pbeContext = null, locale = 'en' } = {}) {
  if (!host || !base || !sport || !eventId || !publishedAt) return () => {} // base required: products read through their own same-origin rewrite
  let timer = null, visible = true, stopped = false, last = initial, lastAt = initial ? Date.now() : 0
  const fq = [...focusRoles(focus)].map((r) => r.slice(2)).join(',')
  const ctx = () => (typeof pbeContext === 'function' ? pbeContext() : pbeContext)
  const loc = () => (typeof locale === 'function' ? locale() : locale)
  const paint = (p) => { const html = articleMarketModule(p, { focus, pbeContext: ctx(), locale: loc() }); if (html !== host.innerHTML) host.innerHTML = html }
  const frozen = (p) => p?.packet?.packet_state === 'FINAL' && p?.live?.mode === 'MARKET_RESULT'
  if (initial) paint(initial)
  const tick = async () => {
    if (host.isConnected === false) { stop(); return } // SPA navigated away: never keep polling a detached host
    if (stopped || frozen(last) || !visible || (typeof document !== 'undefined' && document.hidden)) return
    if (Date.now() - lastAt < refreshMs / 2) return // just read (first paint / previous tick): never double-fetch
    lastAt = Date.now()
    try {
      const r = await fetchImpl(`${base}/v1/article-market/${encodeURIComponent(sport)}/${encodeURIComponent(eventId)}?published_at=${encodeURIComponent(publishedAt)}${fq ? `&focus=${encodeURIComponent(fq)}` : ''}`)
      if (!r.ok) return // failed read: keep what is shown, never blank it
      last = await r.json()
      paint(last)
    } catch { /* keep the last good render */ }
  }
  const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((es) => { visible = es.some((e) => e.isIntersecting); if (visible) tick() }) : null
  io?.observe(host)
  const onVis = () => { if (typeof document !== 'undefined' && !document.hidden) tick() }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis)
  if (!initial) tick()
  timer = setInterval(tick, refreshMs)
  function stop() { stopped = true; clearInterval(timer); io?.disconnect(); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis) }
  stop.repaint = () => { if (!stopped && last) paint(last) }
  return stop
}
