#!/usr/bin/env node
// Build a v3 packet (as-of-safe rebuild: ORIGINAL frozen packet + depth) for a stored fixture, read-only.
//   node scripts/news/build-v3-fixture.mjs tests/fixtures/news/bayern-packet.json tests/fixtures/news/bayern-packet-v3.json
import { readFileSync, writeFileSync } from 'node:fs';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { richerPacket } from '../../workers/soccer-news/src/pipeline.js';
const [src, dst] = process.argv.slice(2);
const envText = readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8');
const store = storeFromEnv(Object.fromEntries(envText.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])));
const original = JSON.parse(readFileSync(src, 'utf8'));
const { packet, path } = await richerPacket(store, original, { now: Date.parse('2026-09-28T22:00:00Z') });
writeFileSync(dst, JSON.stringify(packet, null, 2) + '\n');
console.log(path, packet.version, packet.hash, 'derived_from', packet.derived_from?.packet_hash);
console.log(JSON.stringify({ goal_sequence: packet.depth?.goal_sequence, first_half: packet.depth?.phases?.first_half, second_half: packet.depth?.phases?.second_half, lines: packet.depth?.player_lines?.slice(0, 5).map(r => [r.player.name, r.goals, r.assists, r.shots, r.shots_on_target, r.shots_inside_box]), shot: packet.depth?.shot_profile && { home: packet.depth.shot_profile.home, away: packet.depth.shot_profile.away }, table: packet.depth?.table_move, recent: packet.depth?.recent_league_results, cards: packet.depth?.discipline?.length, subs: packet.depth?.substitutions?.length, next: [packet.teams.home.next, packet.teams.away.next] }, null, 1));
