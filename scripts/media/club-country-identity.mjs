#!/usr/bin/env node
// READ-ONLY proof: Nations League players are the SAME canonical player as in club football.
// For sampled national teams, every lineup player with club appearances too: one player_id, club +
// national appearances on it, one primary portrait at most, no second canonical player with the same
// ESPN athlete id or the same name + DOB.
//   node scripts/media/club-country-identity.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { chunkArr } from '../../workers/soccer-ingest/src/store.js';

const envText = readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8');
const store = storeFromEnv(Object.fromEntries(envText.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])));
const selIn = async (t, col, vals, o = {}) => { const out = []; for (const p of chunkArr([...new Set(vals)], 150)) out.push(...await store.select(t, { ...o, in: { ...(o.in || {}), [col]: p } })); return out; };
const comps = new Map((await store.select('soccer_competitions', { columns: ['id', 'slug'] })).map(c => [c.id, c.slug]));
const NATIONS = ['england', 'germany', 'france', 'spain', 'portugal', 'norway', 'italy', 'netherlands'];
const nat = await store.select('soccer_teams', { columns: ['id', 'slug', 'name'], in: { slug: NATIONS } });
const out = { at: new Date().toISOString(), teams: {}, totals: { players: 0, with_club_apps: 0, duplicate_espn_ids: 0, duplicate_name_dob: 0, multi_primary_portrait: 0 }, samples: [] };
for (const t of nat) {
  const lus = await store.select('soccer_lineups', { columns: ['id', 'match_id'], eq: { team_id: t.id } });
  const lps = await selIn('soccer_lineup_players', 'lineup_id', lus.map(l => l.id), { columns: ['player_id'] });
  const pids = [...new Set(lps.map(x => x.player_id))];
  const people = await selIn('soccer_players', 'id', pids, { columns: ['id', 'slug', 'display_name', 'birth_date'] });
  const allLps = await selIn('soccer_lineup_players', 'player_id', pids, { columns: ['player_id', 'lineup_id'] });
  const allLus = await selIn('soccer_lineups', 'id', allLps.map(x => x.lineup_id), { columns: ['id', 'team_id', 'match_id'] });
  const teams = new Map((await selIn('soccer_teams', 'id', allLus.map(l => l.team_id), { columns: ['id', 'name', 'team_type'] })).map(x => [x.id, x]));
  const matches = new Map((await selIn('soccer_matches', 'id', allLus.map(l => l.match_id), { columns: ['id', 'competition_id'] })).map(m => [m.id, m]));
  const xw = await selIn('soccer_player_external_ids', 'player_id', pids, { columns: ['player_id', 'provider', 'external_id', 'method'] });
  const media = await selIn('soccer_entity_media', 'entity_id', pids, { columns: ['entity_id', 'rights_status'], eq: { entity_type: 'player', media_type: 'portrait', is_primary: true } });
  let withClub = 0;
  for (const p of people) {
    const mine = allLps.filter(x => x.player_id === p.id).map(x => allLus.find(l => l.id === x.lineup_id)).filter(Boolean);
    const club = mine.filter(l => teams.get(l.team_id)?.team_type !== 'national');
    const natl = mine.filter(l => teams.get(l.team_id)?.team_type === 'national');
    if (!club.length) continue;
    withClub += 1;
    const espnIds = xw.filter(x => x.player_id === p.id && x.provider === 'espn').map(x => x.external_id);
    // any OTHER canonical player carrying the same ESPN athlete id, or the same name + DOB?
    const sameEspn = espnIds.length ? (await store.select('soccer_player_external_ids', { columns: ['player_id'], eq: { provider: 'espn' }, in: { external_id: espnIds } })).filter(x => x.player_id !== p.id) : [];
    const sameNameDob = p.birth_date ? (await store.select('soccer_players', { columns: ['id', 'display_name'], eq: { birth_date: p.birth_date, status: 'active' } })).filter(x => x.id !== p.id && x.display_name === p.display_name) : [];
    const prim = media.filter(m => m.entity_id === p.id);
    out.totals.duplicate_espn_ids += sameEspn.length; out.totals.duplicate_name_dob += sameNameDob.length; out.totals.multi_primary_portrait += prim.length > 1 ? 1 : 0;
    if (out.samples.filter(s => s.nation === t.name).length < 3) out.samples.push({
      nation: t.name, player: p.display_name, slug: p.slug, player_id: p.id, espn_ids: espnIds,
      crosswalks: xw.filter(x => x.player_id === p.id).map(x => `${x.provider}:${x.method}`),
      club_appearances: club.length, club_teams: [...new Set(club.map(l => teams.get(l.team_id)?.name))], club_competitions: [...new Set(club.map(l => comps.get(matches.get(l.match_id)?.competition_id)))],
      national_appearances: natl.length, portrait_primaries: prim.map(m => m.rights_status),
    });
  }
  out.teams[t.name] = { lineup_players: people.length, also_in_club_lineups: withClub };
  out.totals.players += people.length; out.totals.with_club_apps += withClub;
}
writeFileSync(`docs/evidence/media/club-country-identity-${out.at.slice(0, 10)}.json`, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ teams: out.teams, totals: out.totals }, null, 1));
for (const s of out.samples) console.log(`${s.nation.padEnd(12)} ${s.player.padEnd(24)} ${s.player_id.slice(0, 8)} club ${s.club_appearances} (${s.club_teams.join('/')}; ${s.club_competitions.join('/')}) national ${s.national_appearances} portrait ${JSON.stringify(s.portrait_primaries)} xw ${s.crosswalks.join(',')}`);
