// Temporary backlog migration: inert without the KV control key; only reachable from its own cron.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readControl, migrationTick, MIGRATION_CRON } from '../workers/soccer-news/src/migration.js';

const kv = (m = {}) => ({ get: async (k, t) => (m[k] === undefined ? null : t === 'json' ? JSON.parse(m[k]) : m[k]), put: async (k, v) => { m[k] = v; } });

test('no control key (or an unknown mode) -> no-op', async () => {
  assert.equal(await readControl(kv()), null);
  assert.equal(await readControl(kv({ 'migration:control': JSON.stringify({ mode: 'delete' }) })), null);
  assert.deepEqual(await migrationTick({ SOCCER_STATE: kv() }), { skipped: 'no migration control' });
  assert.deepEqual(await readControl(kv({ 'migration:control': JSON.stringify({ mode: 'dry', only: ['a', 1], per_tick: 99 }) })), { mode: 'dry', only: ['a'], per_tick: 6 });
});

test('the migration has no HTTP route and runs only on its own cron; the news run is untouched', () => {
  const idx = readFileSync('workers/soccer-news/src/index.js', 'utf8');
  assert.doesNotMatch(idx, /migrationTick\(env\)[^\n]*\n[^\n]*url\.pathname/);
  assert.match(idx, /if \(event\.cron === MIGRATION_CRON\) \{[^\n]*return; \}/);
  assert.ok(readFileSync('workers/soccer-news/wrangler.toml', 'utf8').includes(`"${MIGRATION_CRON}"`), 'migration cron declared');
  assert.match(readFileSync('workers/soccer-news/src/migration.js', 'utf8'), /reeditArticle\(store, a\.slug, \{ \.\.\.env, NEWS_DESK: 'on' \}, \{ dry: ctl\.mode === 'dry', holdOnFail: false \}\)/);
});
