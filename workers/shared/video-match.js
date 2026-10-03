// Official video <-> article matcher (pure, explainable, fail-closed). docs/VIDEO.md.
// A video attaches to an article only when its score reaches THRESHOLD and no penalty fires that
// identifies a different game. Scores are additive and every contribution is recorded as a reason.
//
//   +40 both teams of the article's match named in the title
//   +25 the article's player named in full (player_form; REQUIRED for a player-form story)
//   +20 competition: the channel is that competition's, a club in the match, or a governing body whose
//       scope includes the competition (a body serving SEVERAL competitions, e.g. UEFA, earns it only
//       when the title names the article's competition)
//   +20 date proximity: published between kickoff and 72 h after it
//   +15 the final score in the title (either order)
//   +10 highlights / match recap / goals video
//   -50 conflicting opponent: another club named in the title
//   -40 wrong competition named in the title
//   -30 stale or premature: published before kickoff or more than 7 days after it
// Player form (1.2.0): the player named in the title (+25), OR official highlights / goals of the exact match of
// the story's latest appearance when the canonical appearance records that the player SCORED in it (0 points,
// reason recorded) -- the video then shows the goal the story is about. Otherwise a player-form story takes no video.
// Match preview (1.2.0): the timing rule inverts -- +20 published within the 7 days BEFORE kickoff, -30 after
// kickoff (a pre-match story never takes post-match footage) -- and only preview / press conference / interview /
// analysis videos can attach (+10); highlights never attach to a preview.
// THRESHOLD 75, and any conflicting-opponent or wrong-competition penalty rejects outright. A single-team
// title can reach at most 20+20+15+10 = 65 (never attaches); both teams alone (40) or both teams + keyword
// (50) do not attach; a match video needs both teams plus competition/date context (40+20+20 = 80).
// Target-aware gender (1.3.0): women's football is a competition context, not a blanket rejection. Every alias index
// entry carries its team's gender and only teams of the story's gender are matched (Arsenal Women never counts for
// Arsenal). A men's story rejects a title that names women's football; a women's story needs a women's football
// marker in the title, or a channel that is itself a women's channel -- a club channel covering both sides proves nothing.
export const MATCHER_VERSION = 'soccer-video-match/1.3.0';
export const THRESHOLD = 75;

export const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/ø/g, 'o').replace(/æ/g, 'ae')
  .toLowerCase().replace(/&amp;/g, '&').replace(/[^a-z0-9&]+/g, ' ').replace(/\s+/g, ' ').trim();
const GENERIC = new Set(['fc', 'sc', 'cf', 'afc', 'ac', 'as', 'sv', 'vfb', 'vfl', 'tsg', 'fsv', 'ssc', 'rc', 'cd', 'sk', 'fk', 'city', 'united', 'club', 'football', 'soccer', 'real', 'sporting', 'athletic', 'de', 'the', 'and', 'of', 'new', 'st', '1', '04', '05', '07']);
// Common English / short forms that official channels use (exonyms, standard abbreviations).
const EXONYMS = {
  'bayern munchen': ['bayern munich', 'fc bayern'], 'manchester city': ['man city'], 'manchester united': ['man utd', 'man united'],
  'tottenham hotspur': ['spurs', 'tottenham'], internazionale: ['inter', 'inter milan'], 'borussia m gladbach': ['gladbach', 'monchengladbach', 'borussia monchengladbach'],
  koln: ['cologne', 'fc koln', '1 fc koln'], 'paris saint germain': ['psg', 'paris sg'], 'atletico madrid': ['atletico de madrid', 'atleti'],
  'borussia dortmund': ['bvb'], 'red bull new york': ['new york red bulls', 'ny red bulls', 'red bulls'], 'new york city fc': ['nycfc'],
  'sporting kansas city': ['sporting kc'], 'd c united': ['dc united'], 'la galaxy': ['la galaxy'], lafc: ['los angeles fc'],
  'brighton hove albion': ['brighton'], 'wolverhampton wanderers': ['wolves'], 'nottingham forest': ['nottm forest', "nott'm forest"], 'st louis city sc': ['st louis city', 'st louis city sc'],
  'cf montreal': ['cf montreal', 'montreal'], 'hamburger sv': ['hsv', 'hamburg'], 'psv eindhoven': ['psv'], 'fc porto': ['porto'], 'sporting cp': ['sporting cp', 'sporting lisbon'],
};
const core = n => fold(n).replace(/^(\d+ )?(fc|sc|sv|vfb|vfl|tsg|fsv|afc|cf|ac|as|ss|ssc|rb|rc|cd) /, '').replace(/ (fc|sc|cf|afc)$/, '').trim();

// Alias index over OUR teams: full name, short name, core name, known exonyms, and a single distinctive
// token when it is unique across all teams (>= 5 letters, not generic).
export function buildAliasIndex(teams) {
  const tokenCount = new Map(); const g = t => t.gender || 'men';
  // a distinctive token is unique within its gender (the women's side shares the club's name)
  for (const t of teams) for (const tok of new Set(core(t.name).split(' '))) tokenCount.set(`${g(t)}:${tok}`, (tokenCount.get(`${g(t)}:${tok}`) || 0) + 1);
  const idx = [];
  for (const t of teams) {
    const set = new Set([fold(t.name), fold(t.short_name), core(t.name), core(t.short_name)].filter(x => x && x.length >= 3));
    for (const [k, v] of Object.entries(EXONYMS)) if (core(t.name) === k || fold(t.name) === k || core(t.short_name) === k) v.forEach(x => set.add(fold(x)));
    for (const tok of core(t.name).split(' ')) if (tok.length >= 5 && !GENERIC.has(tok) && tokenCount.get(`${g(t)}:${tok}`) === 1) set.add(tok);
    // "Arsenal Women": the side is also titled by its club name (the women's marker elsewhere in the title is required)
    if (g(t) === 'women') for (const a of [...set]) { const b = a.replace(/ (women|women s|womens|w|ladies|femenino|frauen|feminines?|femminile)$/, ''); if (b !== a && b.length >= 3) set.add(b); }
    idx.push({ id: t.id, name: t.name, gender: g(t), aliases: [...set].sort((a, b) => b.length - a.length) });
  }
  return idx;
}
const has = (text, phrase) => new RegExp(`(^| )${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(text);
// Longest match wins: every alias occurrence is a span; spans are accepted longest first and a shorter
// alias inside an accepted span does not count for another club ("sporting" inside "sporting kansas city").
export function teamsInTitle(title, index, gender = null) {
  const t = ` ${fold(title)} `;
  const hits = [];
  for (const e of index) if (!gender || (e.gender || 'men') === gender) for (const a of e.aliases) {
    let from = 0;
    for (;;) { const i = t.indexOf(` ${a} `, from); if (i < 0) break; hits.push({ id: e.id, start: i + 1, end: i + 1 + a.length }); from = i + 1; }
  }
  hits.sort((x, y) => (y.end - y.start) - (x.end - x.start) || x.start - y.start);
  const taken = []; const ids = new Set();
  for (const h of hits) { if (taken.some(s => h.start < s.end && s.start < h.end)) continue; taken.push(h); ids.add(h.id); }
  return [...ids];
}
// Titles are folded first: "Women's" reads "women s". Men's patterns never fire inside a women's competition name.
const W = '(?:women s|womens|women)';
const COMP_WORDS = {
  'mls': /\b(mls|major league soccer)\b/, 'premier-league': /\bpremier league\b/, 'la-liga': /\b(la liga|laliga)\b/, 'serie-a': /\bserie a\b(?! (femminile|women))/, 'ligue-1': /\bligue 1\b/,
  bundesliga: /(?<!frauen )\bbundesliga\b/, 'uefa-champions-league': new RegExp(`(?<!${W} )\\b(champions league|ucl)\\b`), 'uefa-europa-league': /\b(europa league|uel)\b/, 'uefa-nations-league': new RegExp(`(?<!${W} )\\b(nations league|unl)\\b`),
  'fifa-world-cup': new RegExp(`(?<!${W} )\\b(fifa )?world cup\\b`),
  nwsl: /\bnwsl\b/, 'womens-super-league': new RegExp(`\\b(wsl|${W} super league)\\b`), 'uefa-womens-champions-league': new RegExp(`\\b(uwcl|${W} champions league)\\b`), 'liga-f': /\bliga f\b/,
  'frauen-bundesliga': /\bfrauen bundesliga\b/, 'premiere-ligue': /\b(premiere ligue|d1 arkema)\b/, 'serie-a-women': /\bserie a (femminile|women)\b/, 'fifa-womens-world-cup': new RegExp(`\\b(fifa )?${W} world cup\\b`),
};
export const WOMEN_COMPETITIONS = new Set(['nwsl', 'womens-super-league', 'uefa-womens-champions-league', 'liga-f', 'frauen-bundesliga', 'premiere-ligue', 'serie-a-women', 'fifa-womens-world-cup']);
const WOMEN_MARK = /\b(women|womens|woman|ladies|frauen|femenino|feminin|feminine|feminines|femminile|nwsl|wsl|uwcl|liga f)\b/;
// National-team football outside our competitions (qualifiers, friendlies, finals tournaments) is another competition too.
// Women's football is NOT here any more (1.3.0): it is a gender context handled in scoreVideo.
const OTHER_COMP = /\b(conference league|fa cup|carabao|efl cup|dfb pokal|pokal|leagues cup|us open cup|concacaf|copa|friendly|friendlies|preseason|u19|u21|u23|youth|academy|mls next|legends|qualifier|qualifiers|qualifying|euro 20\d\d|euro qualifiers?)\b/;
export const HIGHLIGHT_TYPES = new Set(['highlights', 'match_recap', 'goals']);
export const PREVIEW_TYPES = new Set(['preview', 'press_conference', 'interview', 'analysis']);

export function classifyVideo(title) {
  const t = fold(title);
  // Live shows and streams are never highlights, whatever else the title says ("Matchday Live | FIVE GOALS ...").
  if (/\b(matchday live|live stream|livestream|watch live|live show|watchalong|watch along)\b/.test(t)) return 'other';
  if (/\bpress conference\b|\bpresser\b/.test(t)) return 'press_conference';
  if (/\b(all goals|every goal|goals)\b/.test(t) && !/\bhighlights\b/.test(t)) return 'goals';
  if (/\b(extended highlights|highlights|hl)\b/.test(t)) return 'highlights';
  if (/\b(match recap|recap|full match|match review|reaction)\b/.test(t)) return 'match_recap';
  if (/\b(interview|speaks|reacts|post match|postgame|post game|mixed zone)\b/.test(t)) return 'interview';
  if (/\b(preview|build up|matchday preview)\b/.test(t)) return 'preview';
  if (/\b(analysis|tactical|breakdown|explained)\b/.test(t)) return 'analysis';
  return 'other';
}

// ctx: { competition_slug, competition_id, match: { home_id, away_id, kickoff, score:{home,away} } | null,
//        player: { name } | null, club_channel_team_ids } ;
// channel: { competition_id, scope_competition_ids?, team_id, publisher_type }
export const allowedChannel = c => !!(c && c.verified === true && c.enabled === true && /^UC[A-Za-z0-9_-]{22}$/.test(c.channel_id || ''));

export function scoreVideo(video, channel, ctx, index) {
  const reasons = []; let score = 0; const add = (n, why) => { score += n; reasons.push({ points: n, why }); };
  if (!allowedChannel(channel)) return { score: 0, reasons: [{ points: 0, why: 'channel not on the verified allowlist' }], status: 'rejected' };
  const title = video.title || ''; const t = fold(title);
  if (!ctx.match) return { score: 0, reasons: [{ points: 0, why: 'no match context: this story type does not take a match video' }], status: 'rejected' };
  const gender = ctx.gender || (WOMEN_COMPETITIONS.has(ctx.competition_slug) ? 'women' : 'men');
  const found = teamsInTitle(title, index, gender);
  const { home_id: H, away_id: A } = ctx.match;
  const both = found.includes(H) && found.includes(A);
  if (both) add(40, 'both teams named');
  else if (found.includes(H) || found.includes(A)) reasons.push({ points: 0, why: 'only one team named (weak)' });
  const playerNamed = !!ctx.player?.name && has(t, fold(ctx.player.name));
  const scoredHighlights = !playerNamed && !!ctx.player?.name && ctx.player.goals_in_match >= 1 && HIGHLIGHT_TYPES.has(video.video_type);
  if (playerNamed) add(25, `player named: ${ctx.player.name}`);
  else if (scoredHighlights) reasons.push({ points: 0, why: `player form: official ${video.video_type} of the match in which ${ctx.player.name} scored (${ctx.player.goals_in_match} goal${ctx.player.goals_in_match === 1 ? '' : 's'}, canonical appearance)` });
  else if (ctx.player?.name) reasons.push({ points: 0, why: `player form: ${ctx.player.name} is not named and did not score in that match (required)` });
  const others = found.filter(id => id !== H && id !== A);
  if (others.length) add(-50, 'conflicting opponent named');
  const scope = channel.scope_competition_ids?.length ? channel.scope_competition_ids : channel.competition_id ? [channel.competition_id] : [];
  const inScope = scope.includes(ctx.competition_id);
  const clubOk = !!channel.team_id && (channel.team_id === H || channel.team_id === A);
  // A publisher serving several competitions (UEFA) never vouches for the competition by itself.
  const namesOwnComp = !!COMP_WORDS[ctx.competition_slug]?.test(t);
  const compOk = clubOk || (inScope && (scope.length === 1 || namesOwnComp));
  if (compOk) add(20, clubOk ? 'club channel of a team in the match' : scope.length > 1 ? 'governing body channel; title names this competition' : 'competition channel');
  else if (inScope) reasons.push({ points: 0, why: 'governing body channel serves several competitions; title does not name this one (no credit)' });
  const wrongComp = Object.entries(COMP_WORDS).some(([slug, re]) => slug !== ctx.competition_slug && re.test(t)) || OTHER_COMP.test(t);
  if (wrongComp) add(-40, 'another competition named');
  const womenNamed = WOMEN_MARK.test(t);
  let genderOk = true;
  if (gender === 'men' && womenNamed) { genderOk = false; add(-40, "women's football named; this story is men's"); }
  if (gender === 'women' && !womenNamed && channel.gender !== 'women') { genderOk = false; reasons.push({ points: 0, why: "women's story: no women's football marker in the title and not a women's channel" }); }
  const pub = Date.parse(video.published_at || ''); const ko = Date.parse(ctx.match.kickoff);
  if (Number.isFinite(pub) && Number.isFinite(ko)) {
    const h = (pub - ko) / 3600e3;
    if (ctx.preview) {
      if (h < 0 && h >= -168) add(20, 'published within 7 days before kickoff');
      else add(-30, h >= 0 ? 'published after kickoff (a preview never takes post-match video)' : 'published more than 7 days before kickoff');
    } else if (h >= 0 && h <= 72) add(20, 'published within 72 h after kickoff');
    else if (h < 0 || h > 168) add(-30, h < 0 ? 'published before kickoff' : 'published more than 7 days after kickoff');
  }
  const sc = ctx.match.score;
  if (sc && Number.isInteger(sc.home) && Number.isInteger(sc.away) && [`${sc.home} ${sc.away}`, `${sc.away} ${sc.home}`].some(p => t.includes(p))) add(15, 'final score in title');
  if (ctx.preview) {
    if (PREVIEW_TYPES.has(video.video_type)) add(10, `${video.video_type} video (pre-match)`);
    else reasons.push({ points: 0, why: `${video.video_type} video cannot attach to a preview` });
  } else if (HIGHLIGHT_TYPES.has(video.video_type)) add(10, `${video.video_type} video`);
  const typeOk = ctx.preview ? PREVIEW_TYPES.has(video.video_type) : true;
  const playerOk = !ctx.player?.name || playerNamed || scoredHighlights;
  const status = score >= THRESHOLD && !others.length && !wrongComp && genderOk && playerOk && typeOk ? 'linked' : 'rejected';
  return { score, reasons, status };
}

// Context for an article from its frozen packet (no live state): recap -> its match; player form -> the
// latest appearance's match + the player; team trend -> the run's latest match; table race -> none.
export function articleContext(article, packet) {
  const slug = packet.competition?.slug;
  const comp = { competition_slug: slug, competition_id: packet.competition?.id, gender: packet.competition?.gender || (WOMEN_COMPETITIONS.has(slug) ? 'women' : 'men') };
  if (packet.event?.kind === 'match_recap' && packet.match) {
    return { ...comp, match: { id: packet.match.id, home_id: packet.teams.home.id, away_id: packet.teams.away.id, kickoff: packet.match.kickoff_utc, score: { home: packet.match.score.home, away: packet.match.score.away } }, player: null };
  }
  if (packet.event?.kind === 'player_form' && packet.form?.appearances?.length) {
    const a = packet.form.appearances[packet.form.appearances.length - 1];
    const [gf, ga] = String(a.score || '').split('-').map(Number);
    return { ...comp, match: { id: a.match_id, home_id: a.team.id, away_id: a.opponent.id, kickoff: `${a.date}T00:00:00Z`, score: Number.isInteger(gf) ? { home: gf, away: ga } : null }, player: packet.player ? { ...packet.player, goals_in_match: Number.isInteger(a.goals) ? a.goals : 0 } : null };
  }
  if (packet.event?.kind === 'team_trend' && packet.trend?.games?.length) {
    const g = packet.trend.games[packet.trend.games.length - 1];
    return { ...comp, match: { id: g.match_id, home_id: packet.team.id, away_id: g.opponent.id, kickoff: `${g.date}T00:00:00Z`, score: { home: g.goals_for, away: g.goals_against } }, player: null };
  }
  if (packet.event?.kind === 'match_preview' && packet.fixture?.id && packet.teams?.home?.id && packet.teams?.away?.id) {
    return { ...comp, preview: true, match: { id: packet.fixture.id, home_id: packet.teams.home.id, away_id: packet.teams.away.id, kickoff: packet.fixture.kickoff_utc, score: null }, player: null };
  }
  return { ...comp, match: null, player: null };
}
