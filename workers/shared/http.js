// The only way soccer code talks to an external source.
// Honest user agent, one request at a time per host, no cookie jar, and a hard
// stop on access control: a 401/403/challenge page raises SourceBlockedError and
// is NEVER retried, solved, or routed around.

export const USER_AGENT = 'PropBetEdgeSoccer/0.1 (+https://soccer.propbetedge.ai/sources)';

export class SourceBlockedError extends Error {
  constructor(url, status, reason) {
    super(`source blocked (${status} ${reason}): ${url}`);
    this.name = 'SourceBlockedError';
    this.url = url;
    this.status = status;
    this.reason = reason;
  }
}

export function detectAccessControl(status, headers, bodyText) {
  const head = (bodyText || '').slice(0, 4000).toLowerCase();
  if (headers.get?.('cf-mitigated') === 'challenge' || /just a moment|cf-chl|challenge-platform/.test(head)) return 'cloudflare_challenge';
  if ((headers.get?.('server') || '').toLowerCase().includes('akamai') && status === 403) return 'akamai';
  if (/captcha|datadome/.test(head) && status >= 400) return 'captcha';
  if (status === 401) return 'auth_required';
  if (status === 403) return 'forbidden';
  return null;
}

const lastHit = new Map();

export async function politeFetch(url, { minIntervalMs = 1000, timeoutMs = 30000, headers = {} } = {}) {
  const host = new URL(url).host;
  const wait = (lastHit.get(host) || 0) + minIntervalMs - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastHit.set(host, Date.now());
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json, text/csv, */*', ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const blocked = detectAccessControl(res.status, res.headers, new TextDecoder().decode(bytes.subarray(0, 4000)));
  if (blocked) throw new SourceBlockedError(url, res.status, blocked);
  return { status: res.status, contentType: res.headers.get('content-type'), bytes, finalUrl: res.url };
}
