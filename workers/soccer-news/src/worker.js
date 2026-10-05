// soccer-news Worker entry module (wrangler `main`). The HTTP/cron handler lives in index.js; this module only adds the
// INTERNAL competition runner (phase 3): a named WorkerEntrypoint reachable solely through the same-Worker loopback
// binding ctx.exports.NewsRunner (compatibility flag enable_ctx_exports). It has no fetch handler and no route, so it is
// not reachable over HTTP. Kept separate because `cloudflare:workers` only resolves inside the Workers runtime (the
// test suite imports index.js / isolation.js directly).
import { WorkerEntrypoint } from 'cloudflare:workers';
import handler from './index.js';
import { runnerRpc } from './isolation.js';

export default handler;

export class NewsRunner extends WorkerEntrypoint {
  // One competition, one invocation: run(slug, { now, dry?, windowDays?, fault? }) -> { slug, out, routing, facts }.
  async run(slug, opts) { return runnerRpc(this.env, slug, opts); }
}
