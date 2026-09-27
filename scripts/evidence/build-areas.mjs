#!/usr/bin/env node
// Builds data/registry/areas.json (area code -> English name) from the Wyscout
// source's own area objects. Used only to compare nationality evidence.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixText } from '../../workers/providers/wyscout-figshare.js';
const cap = JSON.parse(readFileSync('docs/evidence/captures/wyscout_figshare.json', 'utf8')).records;
const get = k => JSON.parse(readFileSync(join('.raw', ...cap.find(r => r.source_key === `wyscout_figshare.${k}`).raw_key.split('/')), 'utf8'));
const areas = {};
for (const p of get('players')) for (const a of [p.passportArea, p.birthArea]) if (a?.alpha3code) areas[a.alpha3code] = fixText(a.name);
for (const t of get('teams')) if (t.area?.alpha3code) areas[t.area.alpha3code] = fixText(t.area.name);
const prev = JSON.parse(readFileSync('data/registry/areas.json', 'utf8'));
prev.areas = Object.fromEntries(Object.entries(areas).sort());
writeFileSync('data/registry/areas.json', JSON.stringify(prev, null, 2) + '\n');
console.log(Object.keys(areas).length, areas.CIV, areas.KOR);
