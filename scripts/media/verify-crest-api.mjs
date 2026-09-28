#!/usr/bin/env node
// API proof for crests (read-only): team object -> cached same-origin crest URL -> HTTP 200 image bytes that
// decode (PNG/JPEG/WebP/GIF header with non-zero dimensions), rights basis present; plus article entities.
//   node scripts/media/verify-crest-api.mjs slug1 slug2 ... [--article <desk>/<slug>]
import { writeFileSync } from 'node:fs';
const SITE = 'https://soccer.propbetedge.ai'; const API = `${SITE}/api/soccer`;
const args = process.argv.slice(2); const ai = args.indexOf('--article'); const article = ai >= 0 ? args.splice(ai, 2)[1] : null;
function dims(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return { type: 'png', w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) { let i = 2; while (i < b.length) { if (b[i] !== 0xff) return null; const m = b[i + 1]; const len = b.readUInt16BE(i + 2); if (m >= 0xc0 && m <= 0xc3) return { type: 'jpeg', h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) }; i += 2 + len; } return null; }
  if (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') return { type: 'webp', w: -1, h: -1 };
  if (b.slice(0, 3).toString() === 'GIF') return { type: 'gif', w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  return null;
}
async function img(url) {
  const r = await fetch(SITE + url); const b = Buffer.from(await r.arrayBuffer()); const d = dims(b);
  return { status: r.status, type: r.headers.get('content-type'), bytes: b.length, decoded: !!d && d.w !== 0 && d.h !== 0, format: d?.type || null, w: d?.w, h: d?.h };
}
const out = [];
for (const slug of args) {
  const td = (await (await fetch(`${API}/teams/${slug}`)).json()).data;
  const c = td?.crest; const i = c?.url ? await img(c.url) : null;
  const ok = !!(td?.id && c?.url && /^\/api\/soccer\/media\/[0-9a-f]{64}$/.test(c.url) && i.status === 200 && /^image\//.test(i.type) && i.bytes > 0 && i.decoded && c.basis);
  out.push({ slug, id: td?.id, name: td?.name, url: c?.url || null, basis: c?.basis || null, source: c?.source, license: c?.license, ...i, ok });
}
let art = null;
if (article) {
  const a = (await (await fetch(`${API}/news/${article.split('/').pop()}`)).json()).data;
  art = (a.entities || []).filter(e => e.type === 'SportsTeam').map(e => ({ name: e.name, slug: e.slug, crest: e.crest?.url || null }));
  for (const e of art) if (e.crest) Object.assign(e, await img(e.crest));
}
const res = { at: new Date().toISOString(), teams: out, article: article ? { path: article, teams: art } : null };
writeFileSync(`docs/evidence/media/crest-api-${res.at.slice(0, 10)}.json`, JSON.stringify(res, null, 2) + '\n');
for (const t of out) console.log(`${t.ok ? 'PASS' : 'FAIL'} ${t.name} ${t.id?.slice(0, 8)} ${t.basis} ${t.status} ${t.type} ${t.bytes}B ${t.format} ${t.w}x${t.h}`);
if (art) for (const e of art) console.log(`ARTICLE ${e.name}: ${e.crest ? `${e.status} ${e.type} ${e.bytes}B decoded=${e.decoded}` : 'NO CREST'}`);
