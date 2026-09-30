import test from 'node:test';
import assert from 'node:assert/strict';
import { cachedCoverage, COVERAGE_KEY, isFreshCoverage } from '../workers/soccer-api/src/coverage-cache.js';
const now=Date.parse('2026-09-30T12:00:00Z');
test('materialized coverage fresh across edge locations requires zero canonical reads',async()=>{
 const env={data:{totals:{events:123}},meta:{generated_at:new Date(now-1000).toISOString()}};
 const out=await cachedCoverage({select:()=>{throw Error('unexpected read');}},{SOCCER_STATE:{get:async k=>{assert.equal(k,COVERAGE_KEY);return env;}}},{now});
 assert.equal(out.data.totals.events,123);assert.equal(isFreshCoverage(env,now),true);
});
test('expired coverage is never stale fake success when canonical refresh fails',async()=>{
 const hit={meta:{generated_at:new Date(now-3600001).toISOString()},data:{totals:{events:123}}};
 await assert.rejects(cachedCoverage({select:async()=>{throw Error('store down');}},{SOCCER_STATE:{get:async()=>hit}},{now}),/store down/);
 assert.equal(isFreshCoverage({meta:{generated_at:new Date(now+100).toISOString()}},now),false);
});
