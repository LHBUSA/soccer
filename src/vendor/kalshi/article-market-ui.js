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
 * LOCALE (opts.locale, optional, 'en' default | 'es'): the module's own presentation copy is written natively per
 * locale here, as whole messages (never assembled from translated fragments). Data passes through untouched: venue
 * names, outcome/participant names, market links, prices, numbers and timestamps. A server-provided string this
 * module has no native copy for (a new venue label or disclosure) is shown verbatim and marked lang="en". Hosts
 * must keep their own DOM translation passes out of the module (.am). 'en' (or an unknown locale) renders exactly
 * the English module.
 *
 * CONTRACT HEADERS: a venue that lists one binary contract per outcome (Polymarket "Will X win?" — Yes = an outcome
 * role, No = none) gets a second header line naming that contract's outcome (from the verified outcome role and the
 * event's own outcome names), so several contracts from one venue never share an identical column header.
 */
import { ageLabel } from './kalshi-market-ui.js'

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const cents = (bp) => (bp == null ? null : `${Number.isInteger(bp / 100) ? bp / 100 : (bp / 100).toFixed(1)}¢`)
const signed = (bp) => (bp == null ? null : `${bp > 0 ? '+' : bp < 0 ? '−' : '±'}${Math.abs(bp / 100).toFixed(1)}¢`)
const pts = (x) => (x == null ? null : `${x > 0 ? '+' : x < 0 ? '−' : '±'}${Math.abs(x).toFixed(1)} pts`)
const time = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toISOString().slice(11, 16) + ' UTC' : '' }

// ---------------------------------------------------------------------------------------------------------
// Presentation copy, one complete message per key. EN is the original module copy, byte for byte.
const EN = {
  lang: 'en',
  venueClass: { EXACT_MATCH: 'Exact match', COMPARABLE_EXCEPT_EXCEPTIONS: 'Comparable · postponement rules differ' },
  // server-side venue labels / disclosures (propsports-markets post-event.js, pm/contracts.js) with native copy
  known: {},
  missing: { NO_OBSERVATION_AT_PBE_FORECAST: 'Not observed', NO_OBSERVED_PRE_EVENT_PRICE: 'No observed pre-event price', NO_OBSERVATION_AT_TIME: 'Not observed' },
  notObserved: 'Not observed',
  focusContract: 'Focus contract',
  chartAria: (n) => `Mid-market across ${n} observed snapshots`,
  prePath: (venue) => `${venue} · pre-event path`,
  observedPrices: (n) => `${n} observed prices`,
  firstObserved: 'First observed', atPublication: 'At publication', atPbeLock: 'At PBE lock', preEvent: 'Pre-event', finalTrade: 'Final trade',
  settlement: 'Settlement', move: 'Move (first → pre-event)', awaitingSettlement: 'Awaiting settlement',
  badge: { yes: 'YES', no: 'NO' },
  outcome: { Yes: 'Yes', No: 'No', Draw: 'Draw', Tie: 'Tie' },
  // contract header line (new; see header): the outcome a binary contract pays on
  wins: (name) => `${name} to win`, draw: 'Draw', roleWin: { home: 'Home win', away: 'Away win' }, market: (id) => `Market ${id}`,
  noCall: '<b>No official call</b> on this event',
  noDecision: '<b>No PBE decision</b> on this event',
  ctxTitle: { VALIDATION: 'PBE live validation', TRACKING: 'PBE tracking' },
  ctxFoot: 'Validation/tracking scope · not the Official Track Record',
  lockedKickoff: 'Locked at kickoff', lockedBefore: 'Locked before kickoff', activeLine: 'Pre-game decision · can be replaced until kickoff',
  ctxWhat: { VALIDATION: 'PBE live validation intelligence', TRACKING: 'PBE tracking intelligence' },
  ctxExists: (what) => `${what} exists for this game`,
  unlock: 'Unlock', otherSignal: 'Other game signal', tdTargets: 'TD targets',
  notComparable: 'Not comparable', notScored: ' · not scored', atLock: (venue) => `${venue} at PBE lock`,
  moved: { TOWARD: ' · then moved toward PBE', AWAY: ' · then moved away from PBE', UNCHANGED: ' · unchanged after the PBE lock' },
  grade: { W: 'PBE side won', L: 'PBE side lost', VOID: 'Void', pending: 'Result pending' },
  pbeVsMarket: 'PBE vs market',
  pbeOn: (p, name) => `<b>PBE ${esc(p)}%</b> on ${esc(name)}`,
  locked: (t) => `locked ${t}`,
  sincePublication: 'Since publication', notObservedAtPublication: 'Not observed at publication', sinceFirst: 'Since first observed',
  checked: 'Checked', live: 'LIVE', updated: (sec) => `Updated ${ageLabel(sec)}`, now: (venue) => `${venue} now`,
  titleResult: 'The market result', titleLive: 'Live market watch',
  tagSettled: 'Settled', tagAwaiting: 'Awaiting venue settlement', tagInPlay: 'In-play prices', tagPre: 'Pre-event prices',
  noteVenues: 'Prediction-market prices are our timestamped observations of public venue data, shown per venue and never averaged.',
  noteTiming: 'Movement after publication is timing only; it does not mean this story moved the market.',
  noteField: 'One contract per participant; "—" means we did not observe a price at that checkpoint.',
  noteFieldResult: 'Pre-event = our last observed price before the scheduled start; the result is the venue settlement.',
  fFirst: 'First obs.', fPub: 'At pub.', fPre: 'Pre-event', fFinal: 'Final trade', fResult: 'Result', fAwaiting: 'Awaiting',
  fNow: 'Now', fSincePub: 'Since pub.', fSinceFirst: 'Since first obs.', won: 'Won',
  more: (n, venue) => `+${n} more in the field on ${venue}`,
  winnerMarket: 'winner market', leaders: 'leaders',
}

// Spanish: written for the reader (neutral international Spanish), not translated word by word.
const ageEs = (sec) => {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return ''
  if (sec < 60) return `${Math.max(0, Math.round(sec))} s`
  const m = Math.round(sec / 60)
  return m < 60 ? `${m} min` : `${Math.round(m / 60)} h`
}
const ES = {
  lang: 'es',
  venueClass: { EXACT_MATCH: 'Coincidencia exacta', COMPARABLE_EXCEPT_EXCEPTIONS: 'Comparable · difieren las reglas de aplazamiento' },
  known: {
    'RELATED MARKET · RULES NOT VERIFIED': 'Mercado relacionado · reglas no verificadas',
    'RELATED MARKET · RULES DIFFER': 'Mercado relacionado · reglas distintas',
    'Postponement/cancellation settlement rules differ between venues': 'Las reglas de liquidación por aplazamiento o cancelación difieren entre plataformas',
    'Normal 90-minute result rules match. Postponement, cancellation and fallback settlement rules differ between venues':
      'Coinciden las reglas del resultado a 90 minutos. Las reglas de liquidación por aplazamiento, cancelación y fuente alternativa difieren entre plataformas',
    'Official race result rules match. Postponement, cancellation and fallback-source settlement rules differ between venues':
      'Coinciden las reglas del resultado oficial de la carrera. Las reglas de liquidación por aplazamiento, cancelación y fuente alternativa difieren entre plataformas',
  },
  missing: { NO_OBSERVATION_AT_PBE_FORECAST: 'Sin observación', NO_OBSERVED_PRE_EVENT_PRICE: 'Sin precio previo observado', NO_OBSERVATION_AT_TIME: 'Sin observación' },
  notObserved: 'Sin observación',
  focusContract: 'Contrato de referencia',
  chartAria: (n) => `Precio medio en ${n} lecturas observadas`,
  prePath: (venue) => `${venue} · evolución previa`,
  observedPrices: (n) => `${n} precios observados`,
  firstObserved: 'Primera observación', atPublication: 'Al publicarse', atPbeLock: 'Al fijar PBE', preEvent: 'Antes del inicio', finalTrade: 'Última operación',
  settlement: 'Liquidación', move: 'Variación (primera → previa)', awaitingSettlement: 'Pendiente de liquidación',
  badge: { yes: 'SÍ', no: 'NO' },
  outcome: { Yes: 'Sí', No: 'No', Draw: 'Empate', Tie: 'Empate' },
  wins: (name) => `Gana ${name}`, draw: 'Empate', roleWin: { home: 'Gana el local', away: 'Gana el visitante' }, market: (id) => `Mercado ${id}`,
  noCall: 'PBE no ha emitido una selección oficial para este evento.',
  noDecision: 'PBE no tiene una decisión para este evento.',
  ctxTitle: { VALIDATION: 'Validación en vivo de PBE', TRACKING: 'Seguimiento de PBE' },
  ctxFoot: 'Ámbito de validación/seguimiento · no forma parte del historial oficial',
  lockedKickoff: 'Fijada al inicio', lockedBefore: 'Fijada antes del inicio', activeLine: 'Decisión previa · puede sustituirse hasta el inicio',
  ctxWhat: { VALIDATION: 'inteligencia de validación en vivo de PBE', TRACKING: 'inteligencia de seguimiento de PBE' },
  ctxExists: (what) => `Hay ${what} para este partido`,
  unlock: 'Desbloquear', otherSignal: 'Otra señal del partido', tdTargets: 'Objetivos de TD',
  notComparable: 'No comparable', notScored: ' · sin puntuar', atLock: (venue) => `${venue} al fijar PBE`,
  moved: { TOWARD: ' · después se movió hacia PBE', AWAY: ' · después se alejó de PBE', UNCHANGED: ' · sin cambios tras la selección de PBE' },
  grade: { W: 'Acertó la selección de PBE', L: 'Falló la selección de PBE', VOID: 'Anulada', pending: 'Resultado pendiente' },
  pbeVsMarket: 'PBE frente al mercado',
  pbeOn: (p, name) => `<b>PBE ${esc(p)}%</b> para ${esc(name)}`,
  locked: (t) => `fijada a las ${t}`,
  sincePublication: 'Desde la publicación', notObservedAtPublication: 'Sin observación al publicarse', sinceFirst: 'Desde la primera observación',
  checked: 'Consultado', live: 'EN VIVO', updated: (sec) => (ageEs(sec) ? `Actualizado hace ${ageEs(sec)}` : 'Actualizado'), now: (venue) => `${venue} ahora`,
  titleResult: 'El resultado del mercado', titleLive: 'El mercado en vivo',
  tagSettled: 'Liquidado', tagAwaiting: 'Pendiente de liquidación', tagInPlay: 'Precios en juego', tagPre: 'Precios antes del inicio',
  noteVenues: 'Los precios de los mercados de predicción son observaciones nuestras, con fecha y hora, de datos públicos de cada plataforma; se muestran por separado y nunca se promedian.',
  noteTiming: 'Un movimiento posterior a la publicación solo indica cuándo ocurrió; no significa que esta noticia haya movido el mercado.',
  noteField: 'Un contrato por participante; «—» significa que no observamos ningún precio en ese momento.',
  noteFieldResult: 'Antes del inicio = el último precio que observamos antes de la hora prevista; el resultado es la liquidación de la plataforma.',
  fFirst: '1.ª obs.', fPub: 'Al publicar', fPre: 'Previo', fFinal: 'Última op.', fResult: 'Resultado', fAwaiting: 'Pendiente',
  fNow: 'Ahora', fSincePub: 'Desde pub.', fSinceFirst: 'Desde 1.ª obs.', won: 'Ganó',
  more: (n, venue) => `${n} más en ${venue}`,
  winnerMarket: 'mercado de ganador', leaders: 'favoritos',
}
const LOCALES = { en: EN, es: ES }
const strings = (locale) => LOCALES[String(locale || 'en').toLowerCase().split('-')[0]] || EN

// A server string: native copy when this locale has it, else verbatim and (outside English) marked as English.
const srv = (s, t, end = '') => {
  if (s == null || s === '') return ''
  if (t.lang === 'en') return esc(s + end)
  const own = t.known[s]
  return own != null ? esc(own + end) : `<span lang="en">${esc(s + end)}</span>`
}
const venueTag = (v, t) => (v.label ? srv(v.label, t) : t.venueClass[v.semantic_class] ? esc(t.venueClass[v.semantic_class]) : null)
const venueTagText = (v, t) => (v.label ? (t.known[v.label] ?? v.label) : t.venueClass[v.semantic_class] || null)
// A venue's generic side ("Yes" / "No" / "Draw") in the reader's language; a real name passes through untouched.
const sideLabel = (label, t) => (label != null && Object.hasOwn(t.outcome, label) ? t.outcome[label] : label)
const cell = (c, t) => (!c ? '<span class="am__na">—</span>' : c.missing ? `<span class="am__na">${esc(t.missing[c.missing] || t.notObserved)}</span>` : `<b>${esc(cents(c.mid_bp))}</b>`)

// Focus outcome: the PBE selection, else the event winner, else the first outcome.
function focusRole(packet) {
  return packet.pbe?.selection_role || packet.event_result?.winner_role || packet.venues[0]?.outcomes[0]?.role || null
}
const outcomeOf = (v, role) => v.outcomes.find((o) => o.role === role) || null
const GENERIC = new Set(['Yes', 'No'])
// The event's own name for an outcome role: the first venue outcome label for it that is a name (not Yes / No /
// the bare role). Never invented: no such label -> null.
const roleName = (packet, role) => packet.venues.map((v) => outcomeOf(v, role)?.label).find((l) => l && l !== role && !GENERIC.has(l)) || null
// The PBE selection's name: the frozen label, else the venue's own outcome label for that role (never a bare role).
const selectionName = (packet) => {
  const role = packet.pbe?.selection_role, own = packet.pbe?.selection_label
  if (own && own !== role) return own // some ledgers store the bare role ('away') as the label: not a name
  return packet.venues.map((v) => outcomeOf(v, role)?.label).find((l) => l && l !== role) || own || role
}

// A binary contract on ONE outcome (two outcomes, exactly one carrying a role): the outcome it pays on.
function contractRole(v) {
  const o = v?.outcomes || []
  const roled = o.filter((x) => x.role != null)
  return o.length === 2 && roled.length === 1 ? roled[0].role : null
}
function contractLine(packet, v, t) {
  const role = contractRole(v)
  if (!role) return null
  if (role === 'draw') return t.draw
  const name = roleName(packet, role)
  return name ? t.wins(name) : t.roleWin[role] || null
}

// The focus outcome's label exactly as stored (never expanded or renamed), inside an intentional focus treatment.
const focusBlock = (label, t) => `<p class="am__focus"><span class="am__fcl">${esc(t.focusContract)}</span><b class="am__fcv">${esc(label)}</b></p>`
// Column header: venue link, the contract's outcome when the venue lists one contract per outcome, the venue tag.
// English hover title = the venue's own contract question, verbatim.
const venueHead = (v, t, line = null) => `<a href="${esc(v.market_url)}" target="_blank" rel="sponsored noopener">${esc(v.venue_label)}</a>${line ? `<span class="am__ct"${t.lang === 'en' && v.title ? ` title="${esc(v.title)}"` : ''}>${esc(line)}</span>` : ''}${venueTag(v, t) ? `<small>${venueTag(v, t)}</small>` : ''}`
// Header lines for a row of venue columns; two columns that would still read the same get the venue's market id.
function headLines(packet, venues, t) {
  const lines = venues.map((v) => contractLine(packet, v, t))
  const key = (v, i) => `${v.venue_label}|${lines[i] || ''}|${venueTagText(v, t) || ''}`
  const seen = new Map()
  venues.forEach((v, i) => seen.set(key(v, i), (seen.get(key(v, i)) || 0) + 1))
  return venues.map((v, i) => (seen.get(key(v, i)) > 1 && v.venue_market_id != null ? [lines[i], t.market(v.venue_market_id)].filter(Boolean).join(' · ') : lines[i]))
}
// Label column ~39%, the venues split the rest evenly.
const cols = (n) => `<colgroup><col class="am__c0">${'<col>'.repeat(n)}</colgroup>`
// Settlement badge: driven only by the venue's recorded settlement; none recorded -> the pending text.
function settleBadge(st, pending, t) {
  if (!st) return `<span class="am__badge am__badge--pending">${esc(pending)}</span>`
  const r = String(st.result || '').toLowerCase()
  const text = r === 'yes' ? t.badge.yes : r === 'no' ? t.badge.no : String(st.result || '').toUpperCase()
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
  const x = (at) => (CHART_PAD + ((Date.parse(at) - t0) / span) * (CHART_W - 2 * CHART_PAD)).toFixed(1)
  const y = (v) => (CHART_PAD + (1 - (v - lo) / (hi - lo)) * (CHART_H - 2 * CHART_PAD)).toFixed(1)
  let d = `M${x(pts[0].t)},${y(pts[0].mid_bp)}`
  for (let i = 1; i < pts.length; i++) d += ` H${x(pts[i].t)} V${y(pts[i].mid_bp)}`
  const dots = pts.map((p) => `M${x(p.t)},${y(p.mid_bp)}h0`).join(' ')
  const dir = vals[vals.length - 1] > vals[0] ? 'up' : vals[vals.length - 1] < vals[0] ? 'down' : 'flat'
  return `<svg class="am__chart am__chart--${dir}" viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="none" role="img" aria-label="${esc(t.chartAria(pts.length))}"><path class="am__cl" d="${d}"/><path class="am__cd" d="${dots}"/></svg>`
}
// One chart well per venue: caption, the first and last OBSERVED prices of the path, the observation count.
function pathWell(venueLabel, spark, t) {
  const pts = spark.filter((p) => p.mid_bp != null)
  const ends = pts.length >= 2 ? `<span class="am__ends">${esc(cents(pts[0].mid_bp))} → ${esc(cents(pts[pts.length - 1].mid_bp))}</span>` : ''
  return `<figure class="am__spark"><figcaption><span>${esc(t.prePath(venueLabel))}</span>${ends}</figcaption>${stepChart(spark.map((p) => ({ t: p.t, mid_bp: p.mid_bp })), t)}<small class="am__obs">${esc(t.observedPrices(pts.length))}</small></figure>`
}

function resultTable(packet, t) {
  const role = focusRole(packet)
  const vs = packet.venues.filter((v) => !v.field && outcomeOf(v, role))
  if (!vs.length) return ''
  const own = outcomeOf(vs[0], role)?.label
  const label = own && !GENERIC.has(own) ? own : roleName(packet, role) || sideLabel(own, t) || role
  const rows = [
    [t.firstObserved, (o) => cell(o.first_observed, t)],
    packet.article ? [t.atPublication, (o) => cell(o.at_publication, t)] : null,
    packet.pbe ? [t.atPbeLock, (o) => cell(o.at_pbe_lock, t)] : null,
    [t.preEvent, (o) => cell(o.pre_event, t)],
    [t.finalTrade, (o) => (o.close?.final_trade_bp != null ? `<b>${esc(cents(o.close.final_trade_bp))}</b>` : '<span class="am__na">—</span>'), 'am__key'],
    [t.settlement, (o) => settleBadge(o.settlement, t.awaitingSettlement, t)],
    [t.move, (o) => (o.move?.first_to_pre_event_bp != null ? `<b>${esc(signed(o.move.first_to_pre_event_bp))}</b>` : '<span class="am__na">—</span>')],
  ].filter(Boolean)
  const lines = headLines(packet, vs, t)
  const head = vs.map((v, i) => `<th scope="col">${venueHead(v, t, lines[i])}</th>`).join('')
  const body = rows.map(([name, f, cls]) => `<tr${cls ? ` class="${cls}"` : ''}><th scope="row">${esc(name)}</th>${vs.map((v) => `<td>${f(outcomeOf(v, role))}</td>`).join('')}</tr>`).join('')
  const sparks = vs.map((v, i) => { const s = outcomeOf(v, role).sparkline; return s.length >= 3 ? pathWell(lines[i] ? `${v.venue_label} · ${lines[i]}` : v.venue_label, s, t) : '' }).join('')
  return `${focusBlock(label, t)}<div class="am__tw"><table class="am__t">${cols(vs.length)}<thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table></div>${sparks ? `<div class="am__sparks">${sparks}</div>` : ''}`
}

// PBE closing strip. The visible "PBE" mark is decorative (aria-hidden); screen readers get the "PBE: " prefix.
// A Spanish message names PBE itself, so it needs no prefix.
const pbeMark = '<span class="am__pbeid" aria-hidden="true">PBE</span>'
const srPbe = (t) => (t.lang === 'en' ? '<span class="am__sr">PBE: </span>' : '')
const noCall = (packet, t) => (packet.pbe_status === 'NO_PBE_DECISION' ? `<div class="am__pbe am__pbe--none">${pbeMark}<p class="am__pbeh">${srPbe(t)}${t.noCall}</p></div>` : '')

// Non-official PBE context (see header). Absent -> the original no-call strip, byte for byte.
const pct = (p) => `${Math.round(Number(p) * 1000) / 10}%`
const american = (n) => (n == null || n === '' || !Number.isFinite(Number(n)) ? '' : Number(n) > 0 ? `+${Number(n)}` : `${Number(n)}`)
const ctxFoot = (t) => `<p class="am__ctxf">${esc(t.ctxFoot)}</p>`
const signalTerms = (s) => [s.display, american(s.price)].filter(Boolean).join(' ')
function lockLine(s, t) {
  if (s.lifecycle === 'LOCKED' || s.lifecycle === 'FINAL') return s.before_kickoff === false ? t.lockedKickoff : t.lockedBefore
  if (s.lifecycle === 'ACTIVE') return t.activeLine
  return null
}
const scopeWord = (s) => String(s.scope_label || '').replace(/^PBE\s+/i, '').toLowerCase() || null
function contextBlock(packet, ctx, t) {
  if (ctx === undefined || ctx === null) return noCall(packet, t)
  const scope = String(ctx.scope || 'NONE').toUpperCase()
  const title = t.ctxTitle[scope]
  if (!title) return `<div class="am__pbe am__pbe--none">${pbeMark}<p class="am__pbeh">${srPbe(t)}${t.noDecision}</p></div>`
  if (ctx.access !== 'full') {
    const what = scope === 'VALIDATION' ? t.ctxWhat.VALIDATION : t.ctxWhat.TRACKING
    const cta = ctx.cta?.href ? `<a class="am__ctxcta" href="${esc(ctx.cta.href)}">${esc(ctx.cta.label || t.unlock)}</a>` : ''
    return `<div class="am__pbe am__pbe--ctx am__pbe--locked">${pbeMark}<div class="am__pbeb"><h4>${esc(title)}</h4><p class="am__pbeh">${srPbe(t)}${esc(t.ctxExists(what))}</p>${cta}${ctxFoot(t)}</div></div>`
  }
  const signals = (Array.isArray(ctx.game_signals) ? ctx.game_signals : []).filter((s) => s && s.display && Number.isFinite(Number(s.probability)))
  const targets = (Array.isArray(ctx.td_targets) ? ctx.td_targets : []).filter((x) => x && x.name && Number.isFinite(Number(x.probability)))
  if (!signals.length && !targets.length) return noCall(packet, t)
  const [lead, ...rest] = signals
  // the host's scope label is its own copy (English): only shown with English copy
  const leadSub = lead ? [lockLine(lead, t), t.lang === 'en' ? scopeWord(lead) : null].filter(Boolean).join(' · ') : ''
  const leadHtml = lead ? `<p class="am__pbeh">${srPbe(t)}<b>${esc(signalTerms(lead))}</b> · <b>PBE ${esc(pct(lead.probability))}</b></p>${leadSub ? `<p class="am__ctxs">${esc(leadSub)}</p>` : ''}` : ''
  const related = rest.length ? `<ul class="am__ctxl">${rest.map((s) => `<li><span>${esc(t.otherSignal)}</span><span>${esc(signalTerms(s))} · PBE ${esc(pct(s.probability))}</span></li>`).join('')}</ul>` : ''
  const td = targets.length ? `<h4 class="am__ctxh">${esc(t.tdTargets)}</h4><ul class="am__ctxl">${targets.map((x) => `<li><span>${esc(String(x.rank || '').toUpperCase())} · ${esc(x.name)}</span><span>${esc(pct(x.probability))}</span></li>`).join('')}</ul>` : ''
  return `<div class="am__pbe am__pbe--ctx">${pbeMark}<div class="am__pbeb"><h4>${esc(title)}</h4>${leadHtml}${related}${td}${ctxFoot(t)}</div></div>`
}
function pbeBlock(packet, ctx, t) {
  const p = packet.pbe
  if (!p) return contextBlock(packet, ctx, t)
  const named = headLines(packet, packet.venues, t)
  const lines = packet.venues.map((v, i) => {
    if (!v.comparable_to_pbe) return `<li><span>${esc(named[i] ? `${v.venue_label} · ${named[i]}` : v.venue_label)}</span><span class="am__na">${venueTag(v, t) || esc(t.notComparable)}${esc(t.notScored)}</span></li>`
    const c = v.pbe_vs_venue
    if (!c || c.venue_at_pbe_lock_bp == null) return `<li><span>${esc(t.atLock(v.venue_label))}</span><span class="am__na">${esc(t.notObserved)}</span></li>`
    const moved = t.moved[c.moved_after_pbe] || ''
    return `<li><span>${esc(t.atLock(v.venue_label))}</span><span><b>${esc(cents(c.venue_at_pbe_lock_bp))}</b> · PBE ${esc(pts(c.divergence_pts))}${esc(moved)}</span></li>`
  }).join('')
  const grade = p.grade === 'W' ? t.grade.W : p.grade === 'L' ? t.grade.L : p.grade === 'VOID' ? t.grade.VOID : t.grade.pending
  return `<div class="am__pbe">${pbeMark}<div class="am__pbeb"><h4>${esc(t.pbeVsMarket)}</h4><p class="am__pbeh">${t.pbeOn(Math.round(p.probability * 1000) / 10, selectionName(packet))} · ${esc(t.locked(time(p.lock_at)))} · <span class="am__g am__g--${esc(String(p.grade || 'pending').toLowerCase())}">${esc(grade)}</span></p><ul>${lines}</ul></div></div>`
}

function liveTable(payload, ctx, t) {
  const { packet, live } = payload
  const vs = live.venues.filter((v) => v.outcomes.some((o) => o.current))
  if (!vs.length) return ''
  const pv = new Map(packet.venues.map((v) => [`${v.venue}|${v.venue_market_id ?? ''}`, v]))
  const roles = vs[0].outcomes.map((o) => o.role)
  const heads = vs.map((v) => { const pvv = pv.get(`${v.venue}|${v.venue_market_id ?? ''}`) || {}; return { ...pvv, outcomes: pvv.outcomes || v.outcomes, venue_market_id: pvv.venue_market_id ?? v.venue_market_id, venue_label: pvv.venue_label || v.venue } })
  const lines = headLines(packet, heads, t)
  const head = heads.map((h, i) => `<th scope="col">${venueHead(h, t, lines[i])}</th>`).join('')
  const priceRows = roles.map((r) => `<tr><th scope="row">${esc(sideLabel(vs[0].outcomes.find((o) => o.role === r)?.label, t) || r)}</th>${vs.map((v) => { const o = v.outcomes.find((x) => x.role === r); return `<td>${o?.current ? `<b data-am-px>${esc(cents(o.current.mid_bp))}</b>` : '<span class="am__na">—</span>'}</td>` }).join('')}</tr>`).join('')
  const focus = focusRole(packet) || roles[0]
  const pubRow = packet.article ? `<tr class="am__sub"><th scope="row">${esc(t.sincePublication)}</th>${vs.map((v) => { const o = v.outcomes.find((x) => x.role === focus); return `<td>${o?.since_publication_bp != null ? esc(signed(o.since_publication_bp)) : `<span class="am__na">${esc(t.notObservedAtPublication)}</span>`}</td>` }).join('')}</tr>` : ''
  const firstRow = `<tr class="am__sub"><th scope="row">${esc(t.sinceFirst)}</th>${vs.map((v) => { const o = v.outcomes.find((x) => x.role === focus); return `<td>${o?.since_first_bp != null ? esc(signed(o.since_first_bp)) : '<span class="am__na">—</span>'}</td>` }).join('')}</tr>`
  const fresh = `<tr class="am__sub"><th scope="row">${esc(t.checked)}</th>${vs.map((v) => { const o = v.outcomes.find((x) => x.role === focus) || v.outcomes[0]; return `<td data-am-age="${esc(o.checked_at || '')}">${o.freshness === 'LIVE' ? `<span class="am__live">${esc(t.live)}</span>` : esc(t.updated(o.age_s))}</td>` }).join('')}</tr>`
  const pbeNow = packet.pbe ? vs.map((v) => (v.pbe_now ? `<li><span>${esc(t.now(pv.get(`${v.venue}|${v.venue_market_id ?? ''}`)?.venue_label || v.venue))}</span><span>PBE ${esc(pts(v.pbe_now.divergence_now_pts))}</span></li>` : '')).join('') : ''
  const pbe = !packet.pbe ? contextBlock(packet, ctx, t) : packet.pbe ? `<div class="am__pbe">${pbeMark}<div class="am__pbeb"><p class="am__pbeh">${t.pbeOn(Math.round(packet.pbe.probability * 1000) / 10, selectionName(packet))}</p>${pbeNow ? `<ul>${pbeNow}</ul>` : ''}</div></div>` : ''
  return `<div class="am__tw"><table class="am__t">${cols(vs.length)}<thead><tr><th></th>${head}</tr></thead><tbody>${priceRows}${pubRow}${firstRow}${fresh}</tbody></table></div>${pbe}`
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
const fname = (o, t) => `${o.settlement?.result === 'yes' ? `<span class="am__win">${esc(t.won)}</span> ` : ''}${esc(o.label || o.role)}`
const moreLine = (v, more, t) => (more > 0 ? `<p class="am__more"><a href="${esc(v.market_url)}" target="_blank" rel="sponsored noopener">${esc(t.more(more, v.venue_label))}</a></p>` : '')
const fieldHead = (v, focused, t) => `<p class="am__focus"><a href="${esc(v.market_url)}" target="_blank" rel="sponsored noopener">${esc(v.venue_label)}</a> · ${esc(t.winnerMarket)}${focused ? '' : ` · ${esc(t.leaders)}`}</p>`

function fieldResult(packet, v, focus, t) {
  const { rows, more, focused } = fieldRows(v, true, focus)
  if (!rows.length) return ''
  const cols = [
    [t.fFirst, (o) => fcell(o.first_observed, t)],
    packet.article ? [t.fPub, (o) => fcell(o.at_publication, t)] : null,
    [t.fPre, (o) => fcell(o.pre_event, t, { move: o.move?.first_to_pre_event_bp ?? null })],
    [t.fFinal, (o) => (o.close?.final_trade_bp != null ? `<b>${esc(cents(o.close.final_trade_bp))}</b>` : '<span class="am__na">—</span>')],
    [t.fResult, (o) => settleBadge(o.settlement, t.fAwaiting, t)],
  ].filter(Boolean)
  const head = cols.map(([n]) => `<th scope="col">${esc(n)}</th>`).join('')
  const body = rows.map((o) => `<tr><th scope="row">${fname(o, t)}</th>${cols.map(([, f]) => `<td>${f(o)}</td>`).join('')}</tr>`).join('')
  return `${fieldHead(v, focused, t)}<div class="am__tw"><table class="am__t am__t--field"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table></div>${moreLine(v, more, t)}`
}

function fieldLive(payload, v, focus, t) {
  const { packet, live } = payload
  const lv = live.venues.find((x) => x.venue === v.venue && (x.venue_market_id ?? null) === (v.venue_market_id ?? null))
  if (!lv || !lv.outcomes.some((o) => o.current)) return ''
  const { rows, more, focused } = fieldRows(v, false, focus)
  const now = (r) => lv.outcomes.find((o) => o.role === r) || null
  if (!rows.some((o) => now(o.role)?.current)) return ''
  const cols = [
    [t.fNow, (l) => (l?.current ? `<b data-am-px>${esc(cents(l.current.mid_bp))}</b>` : '<span class="am__na">—</span>')],
    packet.article ? [t.fSincePub, (l) => (l?.since_publication_bp != null ? esc(signed(l.since_publication_bp)) : '<span class="am__na">—</span>')] : null,
    [t.fSinceFirst, (l) => (l?.since_first_bp != null ? esc(signed(l.since_first_bp)) : '<span class="am__na">—</span>')],
  ].filter(Boolean)
  const head = cols.map(([n]) => `<th scope="col">${esc(n)}</th>`).join('')
  const body = rows.map((o) => `<tr><th scope="row">${fname(o, t)}</th>${cols.map(([, f]) => `<td>${f(now(o.role))}</td>`).join('')}</tr>`).join('')
  const ck = lv.outcomes.find((o) => o.checked_at) || lv.outcomes[0]
  const fresh = `<tr class="am__sub"><th scope="row">${esc(t.checked)}</th><td colspan="${cols.length}" data-am-age="${esc(ck.checked_at || '')}">${ck.freshness === 'LIVE' ? `<span class="am__live">${esc(t.live)}</span>` : esc(t.updated(ck.age_s))}</td></tr>`
  return `${fieldHead(v, focused, t)}<div class="am__tw"><table class="am__t am__t--field"><thead><tr><th></th>${head}</tr></thead><tbody>${body}${fresh}</tbody></table></div>${moreLine(v, more, t)}`
}

const langAttr = (t) => (t.lang === 'en' ? '' : ` lang="${t.lang}"`)

export function articleMarketModule(payload, { placement = 'article', focus = null, pbeContext = null, locale = 'en' } = {}) {
  if (!payload?.eligible || !payload.packet || !payload.live || payload.packet.packet_state === 'NO_MARKET_OBSERVED') return ''
  const t = strings(locale)
  const { packet, live } = payload
  const result = live.mode === 'MARKET_RESULT'
  const fv = packet.venues.find((v) => v.field)
  if (fv) return fieldModule(payload, fv, { placement, focus, result, pbeContext, t })
  const body = result ? resultTable(packet, t) + pbeBlock(packet, pbeContext, t) : liveTable(payload, pbeContext, t)
  if (!body) return ''
  const title = result ? t.titleResult : t.titleLive
  const tag = result ? (packet.packet_state === 'FINAL' ? t.tagSettled : t.tagAwaiting) : live.in_play ? t.tagInPlay : t.tagPre
  const tagState = result ? (packet.packet_state === 'FINAL' ? 'settled' : 'pending') : live.in_play ? 'inplay' : 'pre'
  const disclosure = packet.venues.find((v) => v.disclosure)?.disclosure
  const notes = [
    esc(t.noteVenues),
    packet.article ? esc(t.noteTiming) : null,
    disclosure ? srv(disclosure, t, '.') : null,
  ].filter(Boolean).map((n) => `<li>${n}</li>`).join('')
  return `<section class="am am--${result ? 'result' : 'live'}" data-am-placement="${esc(placement)}" data-am-sha="${esc(packet.sha256)}"${langAttr(t)} aria-label="${esc(title)}"><header class="am__hd"><h3>${esc(title)}</h3><span class="am__tag am__tag--${tagState}">${esc(tag)}</span></header>${body}<ul class="am__notes">${notes}</ul></section>`
}

function fieldModule(payload, fv, { placement, focus, result, pbeContext = null, t = EN }) {
  const { packet, live } = payload
  const table = result ? fieldResult(packet, fv, focus, t) : fieldLive(payload, fv, focus, t)
  if (!table) return ''
  const body = table + (packet.pbe ? '' : contextBlock(packet, pbeContext, t))
  const title = result ? t.titleResult : t.titleLive
  const tag = result ? (packet.packet_state === 'FINAL' ? t.tagSettled : t.tagAwaiting) : live.in_play ? t.tagInPlay : t.tagPre
  const tagState = result ? (packet.packet_state === 'FINAL' ? 'settled' : 'pending') : live.in_play ? 'inplay' : 'pre'
  const notes = [
    t.noteVenues,
    t.noteField,
    result ? t.noteFieldResult : null,
    packet.article ? t.noteTiming : null,
  ].filter(Boolean).map((n) => `<li>${esc(n)}</li>`).join('')
  return `<section class="am am--${result ? 'result' : 'live'} am--field" data-am-placement="${esc(placement)}" data-am-sha="${esc(packet.sha256)}"${langAttr(t)} aria-label="${esc(title)}"><header class="am__hd"><h3>${esc(title)}</h3><span class="am__tag am__tag--${tagState}">${esc(tag)}</span></header>${body}<ul class="am__notes">${notes}</ul></section>`
}

// Progressive enhancement. opts: { base (REQUIRED, the product's same-origin path, e.g. '/api/markets'), sport, eventId, publishedAt, initial (embedded payload), refreshMs, fetchImpl,
//   focus (optional, FIELD events only: the article's participants as canonical ids — golf-api player slug / f1-api driver id),
//   pbeContext (optional: the context object, or a function returning the current one — see header),
//   locale (optional: 'en' default | 'es' — every repaint, refreshes included, renders in this locale) }.
// The returned stop() also carries stop.repaint(): re-render the last payload now (e.g. once the host's PBE context lands).
// The host should reserve the module's height server-side when the article is eligible (zero CLS). A FINAL packet is
// rendered once and never refetched (it is the article's permanent record).
export function mountArticleMarket(host, { base, sport, eventId, publishedAt, initial = null, refreshMs = 30000, fetchImpl = (...a) => globalThis.fetch(...a), focus = null, pbeContext = null, locale = 'en' } = {}) {
  if (!host || !base || !sport || !eventId || !publishedAt) return () => {} // base required: products read through their own same-origin rewrite
  let timer = null, visible = true, stopped = false, last = initial, lastAt = initial ? Date.now() : 0
  const fq = [...focusRoles(focus)].map((r) => r.slice(2)).join(',')
  const ctx = () => (typeof pbeContext === 'function' ? pbeContext() : pbeContext)
  const paint = (p) => { const html = articleMarketModule(p, { focus, pbeContext: ctx(), locale }); if (html !== host.innerHTML) host.innerHTML = html }
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
