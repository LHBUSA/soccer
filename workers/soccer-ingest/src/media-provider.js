// Provider media under the OWNER IDENTIFICATION POLICY (data/media/policy.json owner_identification,
// migration 20260928000800). Identity is never loosened: a provider asset is attached ONLY when the
// provider's own API payload lists it on the entity whose provider id EXACTLY equals the id in our
// canonical crosswalk (soccer_team_external_ids / soccer_player_external_ids). No name matching, no
// guessed URLs. Rights are recorded truthfully: rights_status 'owner_approved_identification' means
// the owner approved display for identification; the licence text says the asset is NOT free-licensed.
import { mediaId } from './media-wikimedia.js';

export const PROVIDER_MEDIA_VERSION = 'media-provider/1.0.0';
export const ESPN_LEAGUE = { mls: 'usa.1', 'premier-league': 'eng.1', bundesliga: 'ger.1', 'uefa-champions-league': 'uefa.champions' };
const ESPN_HOST = /^https:\/\/a\.espncdn\.com\//;

// Crest: the team's DEFAULT logo from ESPN's league team listing, for the exact ESPN team id.
export function espnCrestCandidate(espnTeamId, listing) {
  const t = (listing || []).find(x => String(x.id) === String(espnTeamId));
  if (!t) return { ok: false, reason: 'espn_team_id_not_in_current_league_listing' };
  const logos = (t.logos || []).filter(l => (l.rel || []).includes('default') && ESPN_HOST.test(l.href || ''));
  if (logos.length !== 1) return { ok: false, reason: logos.length ? 'several_default_logos' : 'current_crest_not_found' };
  return { ok: true, url: logos[0].href, width: logos[0].width || null, height: logos[0].height || null, espn_name: t.displayName, last_updated: logos[0].lastUpdated || null };
}

// Portrait: the athlete's headshot from ESPN's team roster payload, for the exact ESPN athlete id;
// a stated birth date must equal ours (the same guard as the Wikidata path).
export function espnHeadshotCandidate(espnAthleteId, roster, birthDate) {
  const hits = (roster || []).filter(a => String(a.id) === String(espnAthleteId));
  if (hits.length !== 1) return { ok: false, reason: hits.length ? 'athlete_listed_twice' : 'athlete_not_on_espn_roster' };
  const a = hits[0];
  if (!a.headshot?.href || !ESPN_HOST.test(a.headshot.href)) return { ok: false, reason: 'no_headshot_in_payload' };
  const dob = a.dateOfBirth ? String(a.dateOfBirth).slice(0, 10) : null;
  if (birthDate && dob && dob !== String(birthDate).slice(0, 10)) {
    // ESPN stores midnight-local dates as UTC; allow only the one-day timezone shift, never more.
    const d = Math.abs(Date.parse(dob) - Date.parse(String(birthDate).slice(0, 10))) / 864e5;
    if (d > 1) return { ok: false, reason: 'birth_date_contradiction' };
  }
  return { ok: true, url: a.headshot.href, espn_name: a.displayName, dob_checked: !!(birthDate && dob) };
}

// A fully provenanced row for display under the owner policy (never 'approved' = free-licensed).
export function providerMediaRow({ entityType, entityId, mediaType, provider = 'espn', url, sourceUrl, subjectName, evidence, policy }) {
  const oi = policy.owner_identification;
  const comp = entityType === 'competition';
  const what = comp ? `${subjectName} logo` : mediaType === 'crest' ? `${subjectName} crest` : `Photo of ${subjectName}`;
  return {
    id: mediaId(entityType, entityId, mediaType, sourceUrl),
    entity_type: entityType, entity_id: entityId, media_type: mediaType,
    url, source: 'provider_artwork', source_url: sourceUrl, source_entity: evidence.external_id,
    provider, owner_policy_version: oi.policy_version,
    match_evidence: { ...evidence, version: PROVIDER_MEDIA_VERSION },
    license: comp
      ? `Not free-licensed. Competition logo: copyright and trademark of the competition organiser (${subjectName}). Provider artwork (${provider.toUpperCase()}); displayed to identify the competition under the owner identification policy.`
      : mediaType === 'crest'
      ? `Not free-licensed. Club crest: copyright and trademark of ${subjectName}. Provider artwork (${provider.toUpperCase()}); displayed to identify the club under the owner identification policy.`
      : `Not free-licensed. Provider photograph (${provider.toUpperCase()}); copyright of the photographer or provider. Displayed to identify the player under the owner identification policy.`,
    license_url: null,
    author: provider.toUpperCase(),
    attribution: mediaType === 'crest' ? `${what}. Image: ${provider.toUpperCase()}` : `${what}: ${provider.toUpperCase()}`,
    rights_status: oi.rights_status,
    rights_notes: `${oi.decision} (${oi.policy_version}). Not free-licensed; used only to identify the ${comp ? 'competition' : mediaType === 'crest' ? 'club' : 'player'}.`,
    trademark_status: mediaType === 'crest' ? 'trademark_notice' : 'none',
    rejection_reason: null,
  };
}

// Which entities need a provider asset: priority 1 is an already-governed free-licensed primary.
// Competition logo: the league object in ESPN's own scoreboard payload whose slug EXACTLY equals our
// canonical competition's ESPN external id; `default` and `dark` variants as ESPN publishes them.
export function espnLeagueLogos(espnCompId, league) {
  if (!league || String(league.slug) !== String(espnCompId)) return { ok: false, reason: 'espn_league_slug_mismatch' };
  const pick = rel => (league.logos || []).filter(l => (l.rel || []).includes(rel) && ESPN_HOST.test(l.href || ''));
  const d = pick('default'); const k = pick('dark');
  if (d.length !== 1) return { ok: false, reason: d.length ? 'several_default_logos' : 'current_logo_not_found' };
  return { ok: true, default: d[0].href, dark: k.length === 1 ? k[0].href : null, espn_league_id: league.id, espn_name: league.name };
}

export const needsProvider = (entityId, freePrimary) => !freePrimary.has(entityId);
