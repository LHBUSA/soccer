#!/usr/bin/env node
// DRY Nations League newsroom run against PRODUCTION data (read-only: runNews dry=true never inserts).
// Builds the real candidates, frozen packets and deterministic drafts, runs the fact gates, and prints
// what the packet tells the desk (national-team format, group + League tier context). The OpenAI desk
// runs only in the Worker (its key is a Worker secret), so locally stories report the desk as unavailable.
//   node scripts/news/dry-nations.mjs [--days 4]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { loadSeason, detect, buildPacket } from '../../workers/soccer-news/src/engine.js';
import { compose } from '../../workers/soccer-news/src/compose2.js';
import { runGates2 } from '../../workers/soccer-news/src/gates2.js';
import { PROFILES, unsupportedGroupClaims } from '../../workers/soccer-news/src/profiles.js';

const days = Number((process.argv.slice(2).join(' ').match(/--days (\d+)/) || [])[1] || 4);
const text = readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8').replace(/^\uFEFF/, '');
const store = storeFromEnv(Object.fromEntries(text.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])));
const S = await loadSeason(store, 'uefa-nations-league');
const cands = await detect(store, S, { now: Date.now(), windowDays: days });
const out = { at: new Date().toISOString(), candidates: cands.length, stories: [] };
for (const c of cands.sort((a, b) => b.materiality.score - a.materiality.score).slice(0, 3)) {
  const packet = await buildPacket(store, S, c);
  const draft = compose(packet);
  const g = runGates2(draft, packet);
  const body = [draft.headline, draft.dek, ...draft.sections.flatMap(s => s.paragraphs || [])].join(' ');
  const P = PROFILES[packet.event.profile];
  out.stories.push({
    kind: packet.event.kind, profile: packet.event.profile, desk: draft.desk, headline: draft.headline,
    competition: packet.competition, groups: { home: packet.teams?.home?.group || null, away: packet.teams?.away?.group || null },
    entities: draft.entities?.map(e => `${e.type}:${e.name}`), gates: { pass: g.pass, failed: g.failed },
    banned_hits: P.banned.filter(([, re]) => re.test(body)).map(([n]) => n), unsupported_claims: unsupportedGroupClaims(P, body, packet),
    club_word: /\bclubs?\b/i.test(body), sections: draft.sections.map(s => s.heading || s.key), words: body.split(/\s+/).length,
  });
}
mkdirSync('docs/evidence/news', { recursive: true });
const file = `docs/evidence/news/nations-dry-${out.at.slice(0, 10)}.json`;
writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 1).slice(0, 6000));
