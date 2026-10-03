#!/usr/bin/env node
// SOCCER PBE PICKS COVERAGE REPORT (read-only). Which competitions could ever enter the Picker, and what each one has.
// Data availability is NOT model validation: a competition reaches the Picker only through its own research, a frozen
// holdout, an approved pick policy and an owner activation. Never by reusing another competition's model.
//   node scripts/algo/picks-coverage.mjs   -> docs/PICKS_COVERAGE.md + docs/evidence/algo/picks-coverage.json
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { storeFromEnv } from '../../workers/shared/postgrest.js';

const env = Object.fromEntries(readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const store = storeFromEnv(env);
const reg = JSON.parse(readFileSync('data/registry/competitions.json', 'utf8')).competitions;
const v1 = JSON.parse(readFileSync('workers/soccer-ingest/src/algo-v1.json', 'utf8'));
const v2 = JSON.parse(readFileSync('workers/soccer-ingest/src/algo-v2.json', 'utf8'));
const wrangler = readFileSync('workers/soccer-ingest/wrangler.toml', 'utf8');
const flag = k => (wrangler.match(new RegExp(`^${k}\\s*=\\s*"([^"]+)"`, 'm')) || [])[1] || null;
// the ONLY models that exist: one per competition scope, from their frozen specs
const MODELS = {
  [v1.competition_scope?.competition_slug || 'bundesliga']: { model: v1.algo_version, research: 'docs/evidence/research (Algo V1 protocol: selection seasons + one-shot holdout)', holdout: 'frozen (select_freeze_sha256 in algo-research.json)', policy: v1.pick_policy?.version, status: v1.status, flag: flag('ALGO_OFFICIAL'), production: flag('ALGO_OFFICIAL') === 'on' ? 'LIVE (owner G7 sign-off 2026-09-29)' : 'off' },
  [v2.competition_scope.competition_slug]: { model: v2.algo_version, research: 'scripts/research/algo-v2-research.mjs (pre-registered national-team protocol)', holdout: 'frozen; input membership frozen 2026-10-02 (algo-v2-dataset.json)', policy: v2.pick_policy.version, status: v2.status, flag: flag('ALGO_V2'), production: flag('ALGO_V2') === 'on' ? 'LIVE' : 'OFF (never ran; pre-activation preflight + owner sign-off pending)' },
};
const rows = [];
for (const c of reg) {
  const [comp] = await store.select('soccer_competitions', { columns: ['id', 'slug', 'comp_type'], eq: { slug: c.slug } });
  if (!comp) { rows.push({ slug: c.slug, missing: true }); continue; }
  const seasons = await store.select('soccer_seasons', { columns: ['label', 'publication_state', 'coverage_tier'], eq: { competition_id: comp.id }, order: 'label.asc' });
  const pub = seasons.filter(s => s.publication_state === 'published');
  const held = seasons.filter(s => s.publication_state === 'held');
  const m = MODELS[c.slug] || null;
  rows.push({ slug: c.slug, type: comp.comp_type, seasons_total: seasons.length, published: pub.length, held: held.length, first_published: pub[0]?.label || null, last_published: pub.at(-1)?.label || null, tiers: pub.reduce((o, s) => ({ ...o, [s.coverage_tier || 'none']: (o[s.coverage_tier || 'none'] || 0) + 1 }), {}), research_depth_ok: pub.length >= 10, model: m });
}
const out = { at: new Date().toISOString(), rule: 'Data availability is not model validation. A competition enters PBE Picks only with its own research, frozen holdout, approved pick policy and owner activation.', competitions: rows };
mkdirSync('docs/evidence/algo', { recursive: true });
writeFileSync('docs/evidence/algo/picks-coverage.json', `${JSON.stringify(out, null, 1)}\n`);
const yes = b => (b ? 'yes' : 'no');
let md = `# Soccer PBE Picks — competition coverage\n\nGenerated ${out.at} by \`scripts/algo/picks-coverage.mjs\` (read-only).\n\n**${out.rule}** The Bundesliga model is never applied to another competition because its fixtures exist.\n\n| Competition | Published seasons (range) | Held | ≥10 seasons for research | Model research | Frozen holdout | Pick policy | Production |\n|---|---|---|---|---|---|---|---|\n`;
for (const r of rows) {
  if (r.missing) { md += `| ${r.slug} | not in the canonical graph | – | no | none | none | none | not eligible |\n`; continue; }
  md += `| ${r.slug} | ${r.published}${r.published ? ` (${r.first_published} – ${r.last_published})` : ''} | ${r.held} | ${yes(r.research_depth_ok)} | ${r.model ? r.model.research : 'none'} | ${r.model ? r.model.holdout : 'none'} | ${r.model?.policy || 'none'} | ${r.model ? `${r.model.model} · ${r.model.production}` : 'not eligible (no model)'} |\n`;
}
writeFileSync('docs/PICKS_COVERAGE.md', md);
console.log(md);
// Recommendation (deliberately static and conservative: a proposal for the owner, never an activation)
writeFileSync('docs/PICKS_COVERAGE.md', `${readFileSync('docs/PICKS_COVERAGE.md', 'utf8')}
## Recommended next competition-model research lane

**Premier League**, as its own research lane (never the Bundesliga model reused): its Pass A history lane is running
2001/02 → 2025/26 under the hardened acceptance gate (20 clubs × 38, structure-registered), which would give ~24
complete seasons of canonical results, enough for a selection/holdout split like Algo V1's. Start only after that lane
finishes and every season used is PUBLISHED; then pre-register the protocol, freeze thresholds on the selection
seasons, evaluate the holdout once, and bring the result to the owner. MLS is a later candidate: its format changes
season to season (reviewed manifests, repeat meetings, playoffs), so its research needs per-season structure inputs.
Champions League, World Cup, LaLiga, Serie A and Ligue 1 lack canonical history depth today.
`);
