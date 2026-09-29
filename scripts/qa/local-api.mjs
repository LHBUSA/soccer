#!/usr/bin/env node
// LOCAL QA ONLY: serves the soccer-api read routes over a PGlite snapshot (e.g. the Nations League
// canary store) so the web app can be previewed against data that is not in production yet.
// Point vite at it:  SOCCER_API_TARGET=http://127.0.0.1:8791 npx vite preview --port 4180
//   node scripts/qa/local-api.mjs [--snapshot .proof/unl-pglite.tar.gz] [--port 8791]
// Routes mirror workers/soccer-api/src/index.js (same handlers from routes.js / cast.js).
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pgliteStore } from '../../workers/soccer-ingest/src/store-pglite.js';
import * as R from '../../workers/soccer-api/src/routes.js';
import * as C from '../../workers/soccer-api/src/cast.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const { PGlite } = await import('@electric-sql/pglite');
const db = new PGlite({ loadDataDir: new Blob([readFileSync(arg('--snapshot', '.proof/unl-pglite.tar.gz'))]) });
await db.waitReady;
const store = pgliteStore(db);
const env = {};

const ROUTES = [
  [/^\/v1\/competitions$/, () => R.competitions(store)],
  [/^\/v1\/coverage$/, () => R.coverage(store)],
  [/^\/v1\/competitions\/([a-z0-9-]+)$/, m => R.competition(store, m[1])],
  [/^\/v1\/matches$/, (_m, q) => R.matches(store, q)],
  [/^\/v1\/matches\/([0-9a-f-]{36})$/, m => R.match(store, m[1])],
  [/^\/v1\/matches\/([0-9a-f-]{36})\/cast$/, m => C.cast(store, m[1], env)],
  [/^\/v1\/live$/, () => C.live(store, env)],
  [/^\/v1\/players$/, (_m, q) => C.players(store, q, env)],
  [/^\/v1\/teams\/([a-z0-9-]+)$/, m => R.team(store, m[1], env)],
  [/^\/v1\/teams\/([a-z0-9-]+)\/dna$/, (m, q) => R.teamDnaRoute(store, m[1], q, env)],
  [/^\/v1\/players\/([a-z0-9-]+)\/dna$/, (m, q) => R.playerDnaRoute(store, m[1], q, env)],
  [/^\/v1\/players\/([a-z0-9-]+)$/, m => R.player(store, m[1])],
  [/^\/v1\/table$/, (_m, q) => R.table(store, q)],
  [/^\/v1\/news$/, (_m, q) => R.news(store, q)],
  [/^\/v1\/videos$/, (_m, q) => R.videos(store, q)],
];

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  const hit = ROUTES.map(([re, fn]) => [url.pathname.match(re), fn]).find(([m]) => m);
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
  if (!hit) return send(404, { error: 'not found' });
  try { send(200, await hit[1](hit[0], Object.fromEntries(url.searchParams))); } catch (err) { send(err.status || 502, { error: err.message }); }
}).listen(Number(arg('--port', '8791')), '127.0.0.1', () => console.log(`local soccer-api on http://127.0.0.1:${arg('--port', '8791')}`));
