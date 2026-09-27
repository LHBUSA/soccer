#!/usr/bin/env node
// Regenerates the generated block of docs/SOURCE_MATRIX.md from
// data/source-registry/sources.json. Hand-written sections are left alone.
import { readFileSync, writeFileSync } from 'node:fs';

const reg = JSON.parse(readFileSync('data/source-registry/sources.json', 'utf8'));
const START = '<!-- generated:start -->';
const END = '<!-- generated:end -->';
const short = { schedule: 'sched', results: 'res', competition_structure: 'struct', teams: 'teams', player_identity: 'p-id', rosters: 'roster', managers: 'mgr', venues: 'venue', starting_xi: 'XI', bench: 'bench', formation: 'form', substitutions: 'subs', goals: 'goals', cards: 'cards', fouls: 'fouls', shots: 'shots', passes: 'pass', carries: 'carry', duels: 'duel', tackles: 'tackl', interceptions: 'int', recoveries: 'recov', corners: 'crnr', free_kicks: 'FK', goalkeeper_actions: 'GK', event_coordinates: 'xy', event_sequence: 'seq', live: 'live', historical_depth: 'hist', stable_ids: 'ids' };

let md = `${START}\n_Generated from \`data/source-registry/sources.json\` (registry ${reg.registry_version}) by \`npm run matrix\`. Do not edit by hand._\n\n`;
md += '### Verdicts\n\n| Source | Tier | Licence | Verdict | Prod-ready | Evidence |\n|---|---|---|---|---|---|\n';
for (const s of reg.sources) md += `| ${s.name} (\`${s.key}\`) | ${s.tier} | ${s.licence} | **${s.verdict}** | ${s.production_ready ? 'yes' : 'no'} | ${s.evidence.length} file(s) |\n`;
md += '\n### Capabilities (sources with structured data)\n\nY provided · P partial · N not provided · ? not verified\n\n';
const withCaps = reg.sources.filter(s => Object.keys(s.capabilities || {}).length);
md += `| Capability | ${withCaps.map(s => `\`${s.key}\``).join(' | ')} |\n|---|${withCaps.map(() => '---').join('|')}|\n`;
for (const k of reg.capability_keys) md += `| ${k} (${short[k]}) | ${withCaps.map(s => s.capabilities[k] || '·').join(' | ')} |\n`;
md += '\n### Terms and access, verbatim\n\n';
for (const s of reg.sources) {
  md += `**${s.name}** — ${s.verdict}. Access: ${s.access}. Robots: ${s.robots}.\n\n> ${s.terms.quote}\n\n${s.production_note}${s.obligations?.length ? ` Obligations: ${s.obligations.join('; ')}.` : ''}\n\nEvidence: ${s.evidence.map(e => `\`${e}\``).join(', ')}\n\n`;
}
md += END;

const doc = readFileSync('docs/SOURCE_MATRIX.md', 'utf8');
const i = doc.indexOf(START); const j = doc.indexOf(END);
if (i < 0 || j < 0) throw new Error('SOURCE_MATRIX.md is missing the generated markers');
writeFileSync('docs/SOURCE_MATRIX.md', doc.slice(0, i) + md + doc.slice(j + END.length));
console.log(`matrix: ${reg.sources.length} sources written`);
