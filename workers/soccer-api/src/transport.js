// HTTP transport for responses that reach browsers through Vercel's external rewrites (/api/soccer/*).
//
// Vercel caches those responses under a key that ignores Accept-Encoding. Without no-transform,
// Cloudflare compressed each response for whichever client filled Vercel's cache (zstd for Chrome),
// and Vercel replayed those bytes to every client: Safari and other non-zstd clients got unreadable
// JSON. With no-transform Cloudflare returns identity bytes, Vercel caches one representation and
// negotiates gzip/br per client. Existing directives (private, no-store, max-age) are kept verbatim.

/** The same response with `no-transform` merged into its Cache-Control (idempotent). */
export function noTransform(res) {
  const cc = res.headers.get('cache-control') || '';
  if (/(^|[\s,])no-transform([\s,]|$)/i.test(cc)) return res;
  const headers = new Headers(res.headers);
  headers.set('cache-control', cc ? `${cc}, no-transform` : 'no-transform');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
