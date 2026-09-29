// News PRIMARY SUBJECT: who (or what) a story is about, and therefore whose image it carries.
// ONE module for every surface: the newsroom marks the subject when it composes (from the material
// evidence that caused publication, never from prose), and soccer-api's news list, article page and
// related cards all resolve the subject and its media through selectSubject() / subjectMedia().
//
// Media rule: the subject's own approved photo -> the subject's own team crest (a person subject) ->
// nothing (the page draws the competition graphic). NEVER another person's portrait: a story about
// Michael Olise never shows a teammate because the teammate happens to have an approved photo.
//
// Durable marker (no schema change): exactly one entity in soccer_articles.entities carries
//   { primary: true, subject_reason, subject_version[, subject_team_id] }.
export const SUBJECT_VERSION = 'news-subject/1.0.0';

// Case, accents, punctuation and whitespace-insensitive text for name matching.
export const normName = s => ` ${String(s || '').normalize('NFD').replace(/\p{M}/gu, '').replace(/ß/g, 'ss').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
const tokens = s => normName(s).trim().split(' ').filter(Boolean);
// Club prefixes/suffixes a headline may drop ("1. FC Union Berlin" -> "Union Berlin").
const coreTeam = n => String(n || '').replace(/^(\d+\.\s*)?(FC|SC|SV|VfB|VfL|TSG|FSV|AFC|CF|AC|AS|SS|RB|RC|CD)\s+/i, '').replace(/\s+(FC|SC|CF|AFC)$/i, '').trim();

// Does the headline name this person? Exact full name, or the surname (last token) when no OTHER
// person in the same article shares that surname (never a broad substring: "Silva" must not select
// the wrong Silva, "Kane" never matches "Kaner").
export function headlineNamesPerson(headline, person, people = []) {
  const H = normName(headline);
  if (normName(person.name).trim() && H.includes(normName(person.name))) return 'full_name';
  const t = tokens(person.name); const last = t[t.length - 1];
  if (!last || last.length < 3 || t.length < 2) return null;
  const clash = people.some(p => p !== person && p.id !== person.id && tokens(p.name).slice(-1)[0] === last);
  return !clash && H.includes(` ${last} `) ? 'surname' : null;
}
export const headlineNamesTeam = (headline, team) => {
  const H = normName(headline);
  return [team.name, coreTeam(team.name)].some(n => tokens(n).length && H.includes(normName(n)));
};

// The subject of an article: { entity, reason } (entity null when the story names no one usable).
//   1. the explicit primary marker written by the newsroom
//   2. a person the headline names (full name first, then an unambiguous surname), leftmost first
//   3. a team the headline names
//   4. the story class's natural subject (player form -> the player, other classes -> first team)
export function selectSubject({ headline = '', story_class = null, entities = [] } = {}) {
  const ents = entities || [];
  const marked = ents.find(e => e.primary === true);
  if (marked) return { entity: marked, reason: `primary:${marked.subject_reason || 'marked'}` };
  const people = ents.filter(e => e.type === 'Person' && e.id && e.name);
  const H = normName(headline);
  const pos = e => { const full = H.indexOf(normName(e.name)); return full >= 0 ? full : H.indexOf(` ${tokens(e.name).slice(-1)[0]} `); };
  const named = people.map(p => ({ p, how: headlineNamesPerson(headline, p, people) })).filter(x => x.how).sort((a, b) => (a.how === b.how ? pos(a.p) - pos(b.p) : a.how === 'full_name' ? -1 : 1));
  if (named.length) return { entity: named[0].p, reason: `headline_${named[0].how}` };
  const teams = ents.filter(e => e.type === 'SportsTeam' && e.id && e.name);
  const team = teams.filter(t => headlineNamesTeam(headline, t)).sort((a, b) => H.indexOf(normName(coreTeam(a.name))) - H.indexOf(normName(coreTeam(b.name))))[0];
  if (team) return { entity: team, reason: 'headline_team' };
  if (story_class === 'player_form' && people[0]) return { entity: people[0], reason: 'class_player_form' };
  if (teams[0]) return { entity: teams[0], reason: 'class_first_team' };
  return { entity: null, reason: 'none' };
}

// Media for a subject. `portraits`: Map personId -> { url, attribution, license }; `crests`: Map teamId ->
// [{ url, attribution }] (approvedMedia shape). Returns { kind, url, attribution, license?, alt, entity,
// fallback? } or null. Only the subject's own media, or its own team's crest.
export function subjectMedia(subject, portraits, crests, entities = []) {
  const e = subject?.entity; if (!e) return null;
  const crestOf = id => { const c = crests?.get(id); return c ? (Array.isArray(c) ? c[0] : c) : null; };
  const teamEntity = id => entities.find(x => x.type === 'SportsTeam' && x.id === id) || null;
  if (e.type === 'Person') {
    const p = portraits?.get(e.id);
    if (p) return { kind: 'portrait', url: p.url, attribution: p.attribution, license: p.license || null, alt: e.name, entity: { type: 'Person', name: e.name, slug: e.slug } };
    const tid = e.subject_team_id; const c = tid ? crestOf(tid) : null; const t = tid ? teamEntity(tid) : null;
    if (c) return { kind: 'crest', url: c.url, attribution: c.attribution, alt: t?.name || e.name, entity: { type: 'SportsTeam', name: t?.name || null, slug: t?.slug || null }, fallback: 'subject_team' };
    return null; // the page draws the competition graphic; never another player's face
  }
  if (e.type === 'SportsTeam') {
    const c = crestOf(e.id);
    return c ? { kind: 'crest', url: c.url, attribution: c.attribution, alt: e.name, entity: { type: 'SportsTeam', name: e.name, slug: e.slug } } : null;
  }
  return null;
}

// ---- newsroom side: the primary subject from the FROZEN PACKET (the material event), not from prose.
const goalsBy = p => { const m = new Map(); for (const g of p.goals || []) if (!g.own_goal && g.scorer?.id) m.set(g.scorer.id, { player: g.scorer, team: g.team, n: (m.get(g.scorer.id)?.n || 0) + 1 }); return [...m.values()].sort((a, b) => b.n - a.n || (a.player.name < b.player.name ? -1 : 1)); };
export function primaryFromPacket(p) {
  const kind = p?.event?.kind;
  if (kind === 'player_form' && p.player?.id) return { id: p.player.id, type: 'Person', reason: 'player_form', team_id: p.team?.id || null };
  if (kind === 'team_trend' && p.team?.id) return { id: p.team.id, type: 'SportsTeam', reason: 'team_trend' };
  if (kind === 'competition_intelligence') {
    // one table -> its leader; a brief across many groups has no single subject (competition graphic)
    const lead = p.brief === 'group_watch' ? (p.groups?.length === 1 ? p.groups[0].leader?.team : null) : p.table?.top?.[0]?.team || null;
    return lead?.id ? { id: lead.id, type: 'SportsTeam', reason: 'table_leader' } : null;
  }
  if (kind === 'match_preview' && p.subject?.id) return { id: p.subject.id, type: p.subject.type || 'SportsTeam', reason: p.subject.reason || 'preview' };
  if (kind === 'match_recap' && p.teams) {
    const top = goalsBy(p)[0];
    const sideTeam = s => p.teams[s]?.id || null;
    if (top && top.n >= 3) return { id: top.player.id, type: 'Person', reason: 'hat_trick', team_id: sideTeam(top.team) };
    const leader = (p.angles || []).find(a => /leader_change/.test(a.key))?.detail;
    const leaderId = leader?.new_leader_team?.id || leader?.new_leader;
    if (leaderId) return { id: leaderId, type: 'SportsTeam', reason: 'leader_change' };
    if (top && top.n >= 2) return { id: top.player.id, type: 'Person', reason: 'multi_goal_scorer', team_id: sideTeam(top.team) };
    const w = p.match?.winner;
    if (w && w !== 'draw' && sideTeam(w)) return { id: sideTeam(w), type: 'SportsTeam', reason: 'match_winner' };
    return sideTeam('home') ? { id: sideTeam('home'), type: 'SportsTeam', reason: 'match_home_team' } : null;
  }
  return null;
}

// Mark exactly one entity as the primary subject (idempotent; clears any older marker). A subject
// the entity list does not hold is not invented: the list is returned unmarked.
export function markPrimary(entities, primary) {
  const clean = (entities || []).map(e => { const { primary: _p, subject_reason: _r, subject_version: _v, subject_team_id: _t, ...rest } = e; return rest; });
  if (!primary?.id) return clean;
  const i = clean.findIndex(e => e.id === primary.id && e.type === primary.type);
  if (i < 0) return clean;
  clean[i] = { ...clean[i], primary: true, subject_reason: primary.reason, subject_version: SUBJECT_VERSION, ...(primary.team_id ? { subject_team_id: primary.team_id } : {}) };
  return clean;
}
