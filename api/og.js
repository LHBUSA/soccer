// Dynamic 1200x630 social cards: match | team | player | competition | site.
// Text-first by design: no crests or photos until licensed media exists.
// Served at /og/<type>/<key>.png (vercel.json rewrite) so it is outside the
// robots-disallowed /api/ path. Node runtime: @vercel/og's resvg wasm is large.
// Never 404s a card: unknown keys degrade to the brand card (still 200) so a
// shared link never shows a broken preview; the page itself carries the 404.
import { ImageResponse } from '@vercel/og';
import { upstreamJson } from '../server/upstream.js';

const INK = '#07090a'; const INK2 = '#151c1a'; const GOLD = '#d4a73a'; const PITCH = '#16603b'; const MUTED = '#93a19a'; const WHITE = '#ffffff';
const h = (type, style, ...children) => ({ type, props: { style: { display: 'flex', ...style }, children: children.flat().filter(c => c !== null && c !== undefined && c !== false) } });
const day = iso => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');

function frame(kicker, body, footer) {
  return h('div', { width: 1200, height: 630, background: INK, color: WHITE, flexDirection: 'column', fontFamily: 'sans-serif', position: 'relative' },
    h('div', { height: 10, background: GOLD, width: '100%' }),
    h('div', { position: 'absolute', right: -120, top: 120, width: 520, height: 520, border: `3px solid ${PITCH}`, borderRadius: 260 }),
    h('div', { position: 'absolute', right: 140, top: 110, width: 3, height: 520, background: PITCH }),
    h('div', { flexDirection: 'column', padding: '48px 64px 0', flexGrow: 1 },
      h('div', { fontSize: 26, letterSpacing: 6, color: GOLD, fontWeight: 700 }, 'PROPBETEDGE SOCCER INTELLIGENCE'),
      h('div', { fontSize: 24, letterSpacing: 4, color: MUTED, marginTop: 14 }, kicker),
      body),
    h('div', { padding: '0 64px 40px', fontSize: 22, color: MUTED, justifyContent: 'space-between' }, h('div', {}, footer || 'soccer.propbetedge.ai'), h('div', { color: GOLD }, 'EVERY EVENT HAS A PLACE ON THE PITCH')));
}

const big = (text, size = 84) => h('div', { fontSize: size, fontWeight: 800, lineHeight: 1.02, marginTop: 26, maxWidth: 1000 }, text);

export async function cardFor(type, key) {
  try {
    if (type === 'match' && /^[0-9a-f-]{36}$/.test(key)) {
      const env = await upstreamJson(`matches/${key}`);
      if (!env.notFound) {
        const m = env.data;
        const sc = m.score && m.score.home !== null && m.score.home !== undefined ? `${m.score.home} – ${m.score.away}` : 'vs';
        const status = m.status === 'finished' ? 'FULL TIME' : m.status === 'scheduled' ? 'SCHEDULED' : (m.status || '').toUpperCase();
        return frame(`${(m.competition?.name || 'MATCH').toUpperCase()}${m.season ? ` · ${m.season}` : ''} · ${day(m.kickoff_at).toUpperCase()}`,
          h('div', { flexDirection: 'column', marginTop: 40 },
            h('div', { alignItems: 'center', gap: 36 },
              h('div', { fontSize: 64, fontWeight: 800, maxWidth: 400, textAlign: 'right', justifyContent: 'flex-end' }, m.home?.name || ''),
              h('div', { fontSize: 96, fontWeight: 800, color: GOLD, background: '#000', padding: '8px 28px', borderRadius: 18 }, sc),
              h('div', { fontSize: 64, fontWeight: 800, maxWidth: 400 }, m.away?.name || '')),
            h('div', { marginTop: 30, fontSize: 28, color: MUTED, letterSpacing: 4 }, `${status} · MATCH INTELLIGENCE`)),
          (m.shots || []).length ? `Event map: ${m.shots.length} located shots · event locations, not tracking` : 'soccer.propbetedge.ai');
      }
    }
    if (type === 'team' && /^[a-z0-9-]+$/.test(key)) {
      const env = await upstreamJson(`teams/${key}`);
      if (!env.notFound) {
        const t = env.data;
        const comps = [...new Set([...(t.recent || []), ...(t.upcoming || [])].map(x => x.competition?.name).filter(Boolean))].join(' · ');
        return frame('TEAM INTELLIGENCE', h('div', { flexDirection: 'column' }, big(t.name),
          comps ? h('div', { fontSize: 32, color: MUTED, marginTop: 18 }, comps) : null,
          (t.form || []).length ? h('div', { gap: 10, marginTop: 30 }, ...(t.form).map(r => h('div', { width: 54, height: 54, borderRadius: 10, alignItems: 'center', justifyContent: 'center', fontSize: 28, fontWeight: 800, background: r === 'W' ? '#1d8a4e' : r === 'L' ? '#c0392b' : '#8a948f' }, r))) : null));
      }
    }
    if (type === 'player' && /^[a-z0-9-]+$/.test(key)) {
      const env = await upstreamJson(`players/${key}`);
      if (!env.notFound) {
        const p = env.data;
        const bits = [p.role ? p.role.toUpperCase() : null, p.birth_date ? `BORN ${day(`${String(p.birth_date).slice(0, 10)}T12:00:00Z`).toUpperCase()}` : null].filter(Boolean).join(' · ');
        return frame('PLAYER INTELLIGENCE', h('div', { flexDirection: 'column' }, big(p.name), bits ? h('div', { fontSize: 30, color: MUTED, marginTop: 18, letterSpacing: 3 }, bits) : null,
          (p.seasons || []).length ? h('div', { fontSize: 28, color: GOLD, marginTop: 26 }, `Event-derived statistics: ${p.seasons.map(s => s.season).join(', ')}`) : null));
      }
    }
    if (type === 'competition' && /^[a-z0-9-]+$/.test(key)) {
      const env = await upstreamJson(`competitions/${key}`);
      if (!env.notFound) {
        const c = env.data; const seasons = c.seasons || [];
        const total = seasons.reduce((n, s) => n + (s.matches || 0), 0);
        return frame('COMPETITION', h('div', { flexDirection: 'column' }, big(c.name.toUpperCase(), 92),
          h('div', { fontSize: 32, color: MUTED, marginTop: 20 }, `Season ${seasons[0]?.label || ''} · ${seasons.length} stored ${seasons.length === 1 ? 'season' : 'seasons'} · ${total.toLocaleString('en-US')} canonical matches`)));
      }
    }
  } catch { /* fall through to the brand card */ }
  return frame('EVERY MATCH. EVERY EVENT.', h('div', { flexDirection: 'column' }, big('ONE CANONICAL FIELD.', 96),
    h('div', { fontSize: 32, color: MUTED, marginTop: 20, maxWidth: 900 }, 'Results, lineups, event maps and source evidence on one soccer intelligence graph.')));
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'https://soccer.propbetedge.ai');
  const type = url.searchParams.get('type') || 'site';
  const key = (url.searchParams.get('key') || '').replace(/\.png$/, '');
  const img = new ImageResponse(await cardFor(type, key), { width: 1200, height: 630 });
  const buf = Buffer.from(await img.arrayBuffer());
  res.setHeader('content-type', 'image/png');
  res.setHeader('cache-control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');
  res.setHeader('x-content-type-options', 'nosniff');
  res.statusCode = 200;
  res.end(buf);
}
