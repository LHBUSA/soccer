// Soccer AI router — soccer-ai-router/1.0.0 (Newsroom V4 stage 3, owner brief 2026-09-29).
//
// Model selection is an explicit, deterministic POLICY decision recorded on every model call — never a model name
// hardcoded through the newsroom, and never a model asked whether to use a model. Mirrors the Tennis reference
// (tennis-ai-router) and WNBA (wnba-ai-router) so every PropBetEdge newsroom routes, logs and governs the same way.
//
//   DETERMINISTIC        no model call. Soccer's desk is REQUIRED for publication, so on this lane the story HOLDS
//                        with the routing reason (the newsroom never publishes the mechanical draft instead).
//   VOLUME               an approved mini/nano-pool model for low-value, high-volume work. No soccer editorial task
//                        uses it; route() never selects it for article prose.
//   STANDARD_EDITORIAL   the default premium newsroom model (gpt-5.6-sol)
//   FLAGSHIP_EDITORIAL   candidate premium flagship (gpt-6-astra): a deterministically flagship-eligible packet, only
//                        when SOCCER_AI_FLAGSHIP_ENABLED === "true" and the class is released in
//                        SOCCER_AI_FLAGSHIP_CLASSES (empty = none). Off until an offline blind canary earns it.
//
// TRIGGER ALLOW-LIST (enforced HERE, not by callers; owner spec 2026-09-29): new_story (a genuinely new canonical story),
// admin re-edit (`manual_reedit` internally, ledger `admin_reedit`, named slugs) and canary (explicit admin, never
// publishes). A corrective `repair` is only ever attempt 2 of an admin re-edit or canary. Everything else — revision,
// withdrawn/correction, legacy or scope backfill, dry_run, anything unknown — is DETERMINISTIC with reason
// `trigger_not_eligible:<trigger>`.
// Kill switch: SOCCER_AI=off routes EVERYTHING (admin included) to DETERMINISTIC; nothing bypasses it.

export const ROUTER_VERSION = 'soccer-ai-router/1.0.0';

export const LANES = Object.freeze({ DETERMINISTIC: 'DETERMINISTIC', VOLUME: 'VOLUME', STANDARD: 'STANDARD_EDITORIAL', FLAGSHIP: 'FLAGSHIP_EDITORIAL' });

// model -> shared pool (the org's complimentary daily pools are shared by Tennis, WNBA, Soccer, ...). Unknown = premium.
export const DEFAULT_POOLS = Object.freeze({
  'gpt-6-astra': 'premium', 'gpt-6-sol': 'premium', 'gpt-6-luna': 'premium', 'gpt-5.6-sol': 'premium',
  'gpt-5.4-mini': 'volume', 'gpt-5.4-nano': 'volume'
});

// Nominal STANDARD list rates (USD per 1M tokens) — reporting only; not evidence of actual billing. Only gpt-5.6-sol has a
// default; any other model reports null until SOCCER_AI_RATES (JSON { model: { input, cached_input, output } }) sets it.
export const DEFAULT_RATES = Object.freeze({ 'gpt-5.6-sol': Object.freeze({ input: 1.25, cached_input: 0.125, output: 10 }) });

export const ELIGIBLE_TRIGGERS = Object.freeze(['new_story', 'manual_reedit', 'admin_reedit', 'canary']);
const REPAIR_PARENTS = new Set(['manual_reedit', 'admin_reedit', 'canary']);

export const FLAGSHIP_CLASS_IDS = Object.freeze(['rich_match_report', 'continental_or_international']);

const num = (v, d) => (v !== undefined && v !== null && String(v).trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const json = (v, d) => { try { const x = v ? JSON.parse(v) : d; return x && typeof x === 'object' && !Array.isArray(x) ? x : d; } catch { return d; } };

export function aiConfig(env = {}) {
  return {
    enabled: String(env.SOCCER_AI || 'on').toLowerCase() !== 'off',
    standardModel: env.SOCCER_AI_STANDARD_MODEL || env.NEWS_DESK_MODEL || 'gpt-5.6-sol',
    flagshipModel: env.SOCCER_AI_FLAGSHIP_MODEL || 'gpt-6-astra',
    flagshipEnabled: String(env.SOCCER_AI_FLAGSHIP_ENABLED || 'false') === 'true',
    flagshipClasses: new Set(String(env.SOCCER_AI_FLAGSHIP_CLASSES || '').split(',').map(x => x.trim()).filter(Boolean)),
    volumeModel: env.SOCCER_AI_VOLUME_MODEL || 'gpt-5.4-mini',
    // Standard keeps the governed desk cap (NEWS_DESK_MAX_OUTPUT_TOKENS, production var 4000) unless the lane knob overrides.
    standardMaxOutput: Math.max(1000, Math.min(18000, num(env.SOCCER_AI_STANDARD_MAX_OUTPUT, num(env.NEWS_DESK_MAX_OUTPUT_TOKENS, 6000)))),
    flagshipMaxOutput: num(env.SOCCER_AI_FLAGSHIP_MAX_OUTPUT, 8000),
    volumeMaxOutput: num(env.SOCCER_AI_VOLUME_MAX_OUTPUT, 2000),
    standardEffort: env.SOCCER_AI_STANDARD_EFFORT || 'medium',
    flagshipEffort: env.SOCCER_AI_FLAGSHIP_EFFORT || 'medium',
    volumeEffort: env.SOCCER_AI_VOLUME_EFFORT || 'low',
    pools: { ...DEFAULT_POOLS, ...json(env.SOCCER_AI_POOLS, {}) },
    rates: { ...DEFAULT_RATES, ...json(env.SOCCER_AI_RATES, {}) },
  };
}

export const poolOf = (model, cfg = aiConfig()) => (model ? cfg.pools[model] || 'premium' : 'none');

const CONTINENTAL = /champions|ucl|europa|conference|nations|world-cup|euro-|euros|copa|libertadores|afcon|gold-cup|asian-cup/i;

/**
 * Deterministic flagship eligibility from the FROZEN packet only — never a model, never the prose. { eligible, id, reason }
 *   rich_match_report            a match recap whose packet is 'rich' (>= 3 goals, stats, table/group context)
 *   continental_or_international a match recap in a continental club or international competition with a full stat line
 */
export function flagshipEligibility(packet = {}, { richness = null } = {}) {
  const kind = packet?.event?.kind || null;
  if (kind === 'match_recap' && richness === 'rich') return { eligible: true, id: 'rich_match_report', reason: 'rich match-report packet (>= 3 goals, stats, table/group context)' };
  if (kind === 'match_recap' && packet.stats && CONTINENTAL.test(String(packet.competition?.slug || packet.match?.competition?.slug || ''))) return { eligible: true, id: 'continental_or_international', reason: `continental/international match recap (${packet.competition?.slug || packet.match?.competition?.slug})` };
  return { eligible: false, id: null, reason: 'routine story: standard editorial' };
}

/**
 * route({ packet, trigger, attempt, parentTrigger, env, hasKey, richness }) -> routing decision:
 *   { lane, model, pool, reason, max_output_tokens, reasoning_effort, flagship_eligible, flagship_class, trigger,
 *     story_class, router_version }. Pure.
 */
export function route({ packet = {}, trigger = 'new_story', attempt = 1, parentTrigger = null, env = {}, hasKey = true, richness = null } = {}) {
  const cfg = aiConfig(env);
  const base = (lane, model, reason, extra = {}) => ({
    lane, model, pool: poolOf(model, cfg), reason,
    max_output_tokens: lane === LANES.FLAGSHIP ? cfg.flagshipMaxOutput : lane === LANES.STANDARD ? cfg.standardMaxOutput : lane === LANES.VOLUME ? cfg.volumeMaxOutput : 0,
    reasoning_effort: lane === LANES.FLAGSHIP ? cfg.flagshipEffort : lane === LANES.STANDARD ? cfg.standardEffort : lane === LANES.VOLUME ? cfg.volumeEffort : null,
    trigger, story_class: packet?.event?.kind || null, router_version: ROUTER_VERSION, flagship_eligible: false, flagship_class: null, ...extra,
  });
  const repairOk = trigger === 'repair' && Number(attempt) >= 2 && REPAIR_PARENTS.has(parentTrigger);
  if (!ELIGIBLE_TRIGGERS.includes(trigger) && !repairOk) return base(LANES.DETERMINISTIC, null, `trigger_not_eligible:${trigger}`);
  if (!cfg.enabled) return base(LANES.DETERMINISTIC, null, 'SOCCER_AI=off: no model call (kill switch)');
  if (!hasKey) return base(LANES.DETERMINISTIC, null, 'no OPENAI_API_KEY: no model call');
  const fl = flagshipEligibility(packet, { richness });
  if (fl.eligible && cfg.flagshipEnabled && cfg.flagshipClasses.has(fl.id)) return base(LANES.FLAGSHIP, cfg.flagshipModel, `flagship: ${fl.reason}`, { flagship_eligible: true, flagship_class: fl.id });
  const why = !fl.eligible ? `standard: ${fl.reason}`
    : !cfg.flagshipEnabled ? `standard: flagship-eligible (${fl.id}) but SOCCER_AI_FLAGSHIP_ENABLED is off`
      : `standard: flagship-eligible (${fl.id}) but the class is not released in SOCCER_AI_FLAGSHIP_CLASSES`;
  return base(LANES.STANDARD, cfg.standardModel, why, { flagship_eligible: fl.eligible, flagship_class: fl.id });
}

/** True when the routing decision may reach a model transport at all. */
export const reachesTransport = r => Boolean(r && r.model && (r.lane === LANES.STANDARD || r.lane === LANES.FLAGSHIP || r.lane === LANES.VOLUME));

/** Nominal standard-rate cost (USD) of one call; null when the model's rate is not configured. Nominal standard-rate estimate only; not evidence of actual billing. */
export function nominalStandardCost(model, u = {}, cfg = aiConfig()) {
  const r = cfg.rates[model];
  if (!r) return null;
  const cached = Math.max(0, Number(u.cached_input_tokens) || 0);
  const input = Math.max(0, (Number(u.input_tokens) || 0) - cached);
  return Math.round(((input * r.input + cached * (r.cached_input ?? r.input) + (Number(u.output_tokens) || 0) * r.output) / 1e6) * 1e6) / 1e6;
}
