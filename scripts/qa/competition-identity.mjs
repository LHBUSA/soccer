#!/usr/bin/env node
// Competition identity coverage matrix: every competition the API serves and every competition the frontend
// registers -> canonical identity, ESPN crosswalk, logo status (approved logo / deliberate mono fallback), and a
// live fetch of each approved file through the production same-origin media route.
//   node scripts/qa/competition-identity.mjs [--site https://soccer.propbetedge.ai]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { ALL_COMPS, resolveComp } from '../../src/lib/competitions.js';
import { COMPETITION_MEDIA } from '../../src/lib/competition-media.js';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const SITE = arg('--site', 'https://soccer.propbetedge.ai').replace(/\/$/, '');
const api = (await (await fetch(`${SITE}/api/soccer/competitions`)).json()).data;
const logoRun = JSON.parse(readFileSync('docs/evidence/media/competition-logos-2026-10-04.json', 'utf8'));
const slugs = [...new Set([...ALL_COMPS.map(c => c.slug), ...api.map(c => c.slug)])];
const rows = [];
for (const slug of slugs) {
  const c = resolveComp(slug); const a = api.find(x => x.slug === slug); const l = COMPETITION_MEDIA[slug];
  const run = logoRun.competitions.find(x => x.slug === slug);
  const files = {};
  for (const [v, u] of Object.entries({ light: l?.url, dark: l?.url_dark })) {
    if (!u) continue;
    const r = await fetch(SITE + u); const b = await r.arrayBuffer();
    files[v] = { status: r.status, type: r.headers.get('content-type'), bytes: b.byteLength };
  }
  const filesOk = Object.values(files).every(f => f.status === 200 && /^image\//.test(f.type) && f.bytes > 0);
  rows.push({
    slug, registered: !!c, enabled: !!c?.enabled, in_api: !!a, api_name: a?.name || null, matches: a?.matches ?? null,
    identity: c?.slug || null, api_name_resolves: a ? resolveComp(a.name)?.slug === slug : null,
    espn_id: c?.espn || null, branding: l ? 'approved_logo' : 'mono_fallback', mono: c?.mono || null,
    fallback_reason: l ? null : (run?.reason || run?.status || 'not_in_logo_run'),
    dark: l ? (l.url_dark && l.url_dark !== l.url ? 'provider_dark_variant' : c?.darkPlate ? 'light_plate' : 'same_file') : null,
    attribution: l?.attribution || null, files, files_ok: l ? filesOk : null,
  });
}
const urls = Object.values(COMPETITION_MEDIA).map(l => l.url);
const out = {
  at: new Date().toISOString(), site: SITE,
  totals: { competitions: rows.length, in_api: rows.filter(r => r.in_api).length, enabled: rows.filter(r => r.enabled).length, approved_logo: rows.filter(r => r.branding === 'approved_logo').length, mono_fallback: rows.filter(r => r.branding === 'mono_fallback').length, broken_files: rows.filter(r => r.files_ok === false).length, shared_logo_files: urls.length - new Set(urls).size, api_not_registered: rows.filter(r => r.in_api && !r.registered).length },
  rows,
};
mkdirSync('docs/evidence/qa', { recursive: true });
writeFileSync(`docs/evidence/qa/competition-identity-${out.at.slice(0, 10)}.json`, JSON.stringify(out, null, 2) + '\n');
console.table(rows.map(r => ({ slug: r.slug, enabled: r.enabled, api: r.in_api, espn: r.espn_id, branding: r.branding, dark: r.dark, files: r.files_ok, why: r.fallback_reason })));
console.log(JSON.stringify(out.totals));
process.exit(out.totals.broken_files || out.totals.shared_logo_files || out.totals.api_not_registered ? 1 : 0);
