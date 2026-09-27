// SERVER-ONLY. Imported by api/*.js and middleware.js, never by src/ (the
// browser bundle), so the Worker hostname is never shipped to browsers.
export const UPSTREAM = 'https://soccer-api.sales-fd3.workers.dev/v1/';
export const SITE = 'https://soccer.propbetedge.ai';

export async function upstreamJson(path, { timeoutMs = 4000 } = {}) {
  const res = await fetch(new URL(path, UPSTREAM), { headers: { accept: 'application/json', 'user-agent': 'propbetedge-soccer-web-server' }, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 404) return { notFound: true };
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return res.json();
}
