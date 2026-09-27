#!/usr/bin/env node
// Live ESPN Core canary (read-only). Writes docs/evidence/espn-canary-latest.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { espnLiveCanary } from '../../workers/soccer-ingest/src/canary.js';
const r = await espnLiveCanary();
mkdirSync('docs/evidence', { recursive: true });
writeFileSync('docs/evidence/espn-canary-latest.json', JSON.stringify(r, null, 2) + '\n');
for (const c of r.checks) console.log(c.pass ? 'ok  ' : 'FAIL', c.name, JSON.stringify(c.detail));
console.log('pass:', r.pass);
process.exit(r.pass ? 0 : 1);
