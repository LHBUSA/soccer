// ARTICLE PAGE (house standard: propbetedge.ai article UX + UFC newsroom modules, in football):
//   hero (competition · story type · date / headline / dek / byline · reading time · updated / share)
//   -> IN THIS STORY (portrait / crest chips, real links) -> hero media (approved subject media over
//   the owned stadium art, match score when the story is a match) -> the story (serif, drop cap)
//   -> intelligence modules (match: score, key players, shot profile, PBEcast replay; Player DNA)
//   -> related coverage -> SOURCE & METHOD (collapsed; pipeline identifiers only under "Advanced").
import { api } from '../lib/api.js';
import { esc, join, when } from '../lib/html.js';
import { ago, dateLong, dateTime, num } from '../lib/format.js';
import { compByDesk } from '../lib/competitions.js';
import { storyLabel } from '../lib/news.js';
import { competitionMark, link, portrait, teamMark } from '../components/ui.js';
import { keyPlayers } from '../components/keyplayers.js';
import { officialVideo, mountOfficialVideos } from '../components/video.js';
import { orderVisuals, renderVisual } from '../components/visuals.js';

const SITE = 'https://soccer.propbetedge.ai';
const TYPE = { match_recap: 'Match report', player_form: 'Player form', team_trend: 'Team trend', competition_intelligence: 'Table watch', match_preview: 'Preview' };

export function readingMinutes(sections) {
  const words = (sections || []).flatMap(s => s.paragraphs || []).join(' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 225));
}

// The public story: desk sections; for an older article, its sections minus the method section,
// whose paragraphs become the disclosure instead of dominating the story.
export function storyParts(a) {
  const body = a.body || {};
  const sections = (body.sections || []).filter(s => s.key !== 'method');
  const legacyMethod = (body.sections || []).find(s => s.key === 'method');
  const disclosure = body.disclosure || legacyMethod?.paragraphs || [];
  return { sections, disclosure, desk: /soccer-desk/.test(a.composer || '') };
}

export function shareBar(url, title) {
  const u = encodeURIComponent(url);
  const shareText = `${title} — PropBetEdge Soccer`;
  const t = encodeURIComponent(`${shareText}\n\n@PROPBETEDGE`);
  return `<div class="share-bar" data-share-url="${esc(url)}" data-share-title="${esc(title)}" data-share-text="${esc(shareText)}"><span class="share-h">SHARE</span>
    <button type="button" class="share-btn share-native" data-native-share>Share</button>
    <a class="share-btn" href="https://x.com/intent/tweet?text=${t}&url=${u}" target="_blank" rel="noopener noreferrer nofollow" aria-label="Share on X">X</a>
    <a class="share-btn" href="https://www.linkedin.com/sharing/share-offsite/?url=${u}" target="_blank" rel="noopener noreferrer nofollow" aria-label="Share on LinkedIn">LinkedIn</a>
    <button type="button" class="share-btn" data-copy>Copy link</button>
    <span class="sr-only" aria-live="polite" data-share-status></span></div>`;
}

export function inThisStory(entities) {
  const people = entities.filter(e => e.type === 'Person' && e.href).slice(0, 6);
  const teams = entities.filter(e => e.type === 'SportsTeam' && e.href).slice(0, 4);
  const match = entities.find(e => e.type === 'SportsEvent' && e.href);
  const comp = entities.find(e => e.type === 'SportsOrganization' && e.href);
  if (!people.length && !teams.length && !match && !comp) return '';
  const chip = (href, fig, name, meta, attrs = '') => `<li><a class="ent-chip" href="${esc(href)}" data-link${attrs}>${fig}<span class="ent-t"><b>${esc(name)}</b>${meta ? `<small>${esc(meta)}</small>` : ''}</span></a></li>`;
  return `<aside class="in-story" aria-label="In this story"><p class="in-story-h">IN THIS STORY</p><ul class="ent-chips">
    ${join(people, e => chip(e.href, portrait(e, 'sm'), e.name, 'Player DNA', ` data-player-slug="${esc(e.slug)}"`))}
    ${join(teams, e => chip(e.href, teamMark(e, 'xs'), e.name, 'Team'))}
    ${when(match, () => chip(`/pbecast/${match.href.split('/').pop()}`, '<span class="ent-ico" aria-hidden="true">▶</span>', 'PBEcast replay', match.name))}
    ${when(match, () => chip(match.href, '<span class="ent-ico" aria-hidden="true">◎</span>', 'Match Intelligence', match.name))}
    ${when(comp, () => chip(comp.href, competitionMark(comp.slug, 'xs'), comp.name, 'Competition'))}
  </ul></aside>`;
}

// Hero media: approved subject portrait (or crest) over the owned stadium art; otherwise the
// branded competition treatment. The match score is filled in when the match module loads.
export function heroMedia(a) {
  const c = compByDesk(a.desk);
  const bg = '<img class="ah-bg" src="/brand/soccer-stadium-1600.webp" alt="" width="1600" height="900" decoding="async">';
  const score = a.entities?.find(e => e.type === 'SportsEvent') ? '<span class="ah-score" data-hero-score hidden></span>' : '';
  const credit = a.hero?.attribution ? `<figcaption class="ah-credit">${a.hero.kind === 'portrait' ? 'Photo' : 'Crest'}: ${esc(a.hero.attribution)}${a.hero.kind === 'crest' ? '. Used to identify the club.' : ''}</figcaption>` : '';
  if (a.hero?.kind === 'portrait') {
    return `<figure class="art-hero-media k-portrait a-${esc(c?.accent || 'x')}">${bg}
      <span class="ah-subject"><img src="${esc(a.hero.url)}" alt="${esc(a.hero.entity?.name || '')}" width="480" height="480" decoding="async" data-fallback-portrait></span>
      <span class="ah-tag">${c ? competitionMark(c.slug, 'md') : ''}<b>${esc(a.hero.entity?.name || '')}</b></span>${score}${credit}</figure>`;
  }
  if (a.hero?.kind === 'crest') {
    return `<figure class="art-hero-media k-crest a-${esc(c?.accent || 'x')}">${bg}${teamMark({ name: a.hero.entity?.name, crest: { url: a.hero.url, attribution: a.hero.attribution } }, 'xl')}<span class="ah-tag">${c ? competitionMark(c.slug, 'md') : ''}<b>${esc(a.hero.entity?.name || '')}</b></span>${score}${credit}</figure>`;
  }
  const team = a.entities?.find(e => e.type === 'SportsTeam');
  return `<figure class="art-hero-media k-brand a-${esc(c?.accent || 'x')}">${bg}${team ? teamMark(team, 'xl') : ''}<span class="ah-tag">${c ? competitionMark(c.slug, 'md') : ''}<b>${esc(c?.long || '')}</b></span>${score}</figure>`;
}

// WATCH: a matcher-linked official video (docs/VIDEO.md), after the first editorial section so the reader
// gets the story first. No linked video -> no module (fail closed).
export function watchInArticle(a) {
  const v = (a.media?.videos || []).find(x => x.validated);
  if (!v) return '';
  return `<section class="art-watch" aria-label="Watch"><p class="nrail-h">WATCH · ${v.video_type === 'highlights' ? 'OFFICIAL HIGHLIGHTS' : 'OFFICIAL VIDEO'}</p>${officialVideo(v, { feature: true })}</section>`;
}

function storyLinkables(entities = []) {
  return entities
    .filter(e => e?.href && e?.name && ['Person', 'SportsTeam', 'SportsOrganization'].includes(e.type))
    .sort((a, b) => b.name.length - a.name.length);
}

export function linkStoryText(text, entities = [], seen = new Set()) {
  const src = String(text ?? '');
  const candidates = storyLinkables(entities);
  let cursor = 0; let html = '';
  while (cursor < src.length) {
    let best = null;
    for (const e of candidates) {
      const key = e.href;
      if (seen.has(key)) continue;
      const at = src.indexOf(e.name, cursor);
      if (at < 0) continue;
      if (!best || at < best.at || (at === best.at && e.name.length > best.e.name.length)) best = { at, e };
    }
    if (!best) { html += esc(src.slice(cursor)); break; }
    html += esc(src.slice(cursor, best.at));
    html += `<a class="story-link" href="${esc(best.e.href)}" data-link>${esc(best.e.name)}</a>`;
    seen.add(best.e.href);
    cursor = best.at + best.e.name.length;
  }
  return html;
}

export function body(sections, watch = '', entities = [], visuals = []) {
  // Link only canonical entities already attached to the story, once each, so prose gains useful
  // internal navigation without turning every repeated name into SEO-style link spam.
  const seen = new Set();
  const html = sections.map((s, i) => `${i > 0 || s.heading ? `<h2>${esc(s.heading)}</h2>` : ''}${join(s.paragraphs, p => `<p>${linkStoryText(p, entities, seen)}</p>`)}`);
  // Data visuals (frozen specs, ordered by orderVisuals): the lead visual after the first section, the next
  // after the second, the rest in THE NUMBERS block after the story. The WATCH module follows the first section.
  const after = [[watch, renderVisual(visuals[0])].filter(Boolean).join(''), visuals[1] ? renderVisual(visuals[1]) : ''];
  const blocks = html.map((h, i) => `<div class="art-body${i ? ' cont' : ''}">${h}</div>${after[i] || ''}`);
  if (!html.length) blocks.push(after.join(''));
  const rest = visuals.slice(2).map(renderVisual).filter(Boolean);
  const numbers = rest.length ? `<section class="art-numbers" aria-label="The numbers behind the story"><p class="nrail-h">THE NUMBERS BEHIND THE STORY</p>${rest.join('')}</section>` : '';
  // single visual / no second section: whatever was not placed goes to the numbers block
  const unplaced = html.length < 2 && visuals[1] ? renderVisual(visuals[1]) : '';
  return `${blocks.join('')}${unplaced ? `<section class="art-numbers">${unplaced}</section>` : ''}${numbers}`;
}

function sourceMethod(a, parts, meta) {
  const sources = parts.disclosure.filter(p => /^(Fixtures|Structured|Event data|Results)/.test(p));
  const notes = parts.disclosure.filter(p => !sources.includes(p) && !/evidence packet|hash/i.test(p));
  const unavailable = (parts.disclosure.join(' ').match(/Not reported: ([^.]+)\./) || [])[1];
  return `<details class="src-method"><summary><span>SOURCE &amp; METHOD</span><small>How this story was built</small></summary>
    <div class="sm-body">
      <dl>
        <div><dt>Sources</dt><dd>${sources.length ? esc(sources.join(' ')) : 'PropBetEdge canonical soccer graph'}</dd></div>
        ${unavailable ? `<div><dt>Not covered</dt><dd>${esc(unavailable)}</dd></div>` : ''}
        <div><dt>Last verified</dt><dd>${esc(dateTime(a.updated_at || a.published_at))}</dd></div>
        <div><dt>Method</dt><dd>Every figure comes from a frozen fact record assembled before writing and checked by publication gates. ${link('/sources', 'Sources and method →')}</dd></div>
      </dl>
      ${when(notes.length, () => `<p class="sm-notes">${esc(notes.map(n => n.replace(/Every figure in this story comes from its frozen evidence packet \([^)]*\)\.\s*/, '')).filter(Boolean).join(' '))}</p>`)}
      <details class="sm-adv"><summary>Advanced</summary><ul><li>Evidence record: <code>${esc(String(a.packet_hash || '').slice(0, 16))}</code></li><li>Composer: <code>${esc(a.composer || '')}</code></li><li>Gates: <code>${esc(a.gate_version || '')}</code>, all passed</li><li>API: <code>${esc(meta?.api_version || '')}</code></li></ul></details>
    </div></details>`;
}

function related(a) {
  if (!a.related?.length) return '';
  return `<section class="art-related"><p class="nrail-h">RELATED COVERAGE</p><div class="rel-grid">${join(a.related, r => {
    const c = compByDesk(r.desk);
    return `<a class="rel-card" href="/news/${esc(r.desk)}/${esc(r.slug)}" data-link><span class="rc-top">${c ? competitionMark(c.slug, 'xs') : ''}<span>${esc(TYPE[r.story_class] || storyLabel(r.story_class))}</span></span><b>${esc(r.headline)}</b><small>${esc(ago(r.published_at))}</small></a>`;
  })}</div></section>`;
}

export function renderArticle(env) {
  const a = env.data; const c = compByDesk(a.desk);
  const parts = storyParts(a);
  const url = `${SITE}/news/${a.desk}/${a.slug}`;
  const updated = a.updated_at && a.published_at && Date.parse(a.updated_at) - Date.parse(a.published_at) > 5 * 60e3;
  const match = (a.entities || []).find(e => e.type === 'SportsEvent');
  const people = (a.entities || []).filter(e => e.type === 'Person' && e.slug);
  return `<article class="art" data-article>
    <section class="art-top"><div class="wrap art-col">
      <nav class="art-crumbs" aria-label="Breadcrumb">${link('/news', 'News')}<span aria-hidden="true">›</span>${link(`/news/${a.desk}`, esc(c?.name || a.desk))}</nav>
      <p class="art-meta">${c ? competitionMark(c.slug, 'xs') : ''}<span class="am-comp">${esc(c?.long || '')}</span><span class="am-type">${esc((TYPE[a.story_class] || storyLabel(a.story_class)).toUpperCase())}</span><time class="am-date" datetime="${esc(a.published_at)}">${esc(dateLong(a.published_at))}</time></p>
      <h1 class="art-title">${esc(a.headline)}</h1>
      ${when(a.dek, () => `<p class="art-dek">${esc(a.dek)}</p>`)}
      <p class="art-byline">By <b>PropBetEdge Soccer Desk</b><span>·</span><time datetime="${esc(a.published_at)}">${esc(ago(a.published_at))}</time><span>·</span><span>${readingMinutes(parts.sections)} min read</span>${updated ? `<span>·</span><span>Updated <time datetime="${esc(a.updated_at)}">${esc(dateLong(a.updated_at))}</time></span>` : ''}</p>
      ${shareBar(url, a.headline)}
    </div></section>
    <section class="canvas art-canvas"><div class="wrap art-grid">
      <div class="art-main">
        ${inThisStory(a.entities || [])}
        ${heroMedia(a)}
        ${body(parts.sections, watchInArticle(a), a.entities || [], orderVisuals(a.body))}
        ${when(match, () => `<section class="art-mod" data-art-match="${esc(match.href.split('/').pop())}"><p class="nrail-h">MATCH INTELLIGENCE</p><div class="am-slot"><p class="muted">Loading match intelligence…</p></div></section>`)}
        ${when(people.length, () => `<section class="art-mod"><p class="nrail-h">PLAYER DNA</p><div class="kp-grid">${join(people.slice(0, 4), p => `<a class="kp-card" href="/players/${esc(p.slug)}" data-link data-player-slug="${esc(p.slug)}"${match ? ` data-match-id="${esc(match.href.split('/').pop())}"` : ''}>${portrait(p, 'md')}<span class="kp-id"><b>${esc(p.name)}</b><small>Open Player DNA</small></span></a>`)}</div></section>`)}
        ${related(a)}
        ${sourceMethod(a, parts, env.meta)}
      </div>
      <aside class="art-rail" data-art-rail aria-label="Latest from the desk"></aside>
    </div></section>
  </article>`;
}

// After render: share controls, the match module, the hero score, the rail.
export async function mountArticle(root, env) {
  mountOfficialVideos(root);
  const bar = root.querySelector('[data-share-url]');
  bar?.querySelector('[data-native-share]')?.addEventListener('click', async e => {
    const btn = e.currentTarget; const st = bar.querySelector('[data-share-status]');
    const payload = { title: bar.dataset.shareTitle || document.title, text: bar.dataset.shareText || '', url: bar.dataset.shareUrl };
    if (!navigator.share) {
      try { await navigator.clipboard.writeText(payload.url); btn.textContent = 'Copied'; if (st) st.textContent = 'Link copied'; } catch { btn.textContent = 'Copy failed'; }
      setTimeout(() => { btn.textContent = 'Share'; }, 2200);
      return;
    }
    try { await navigator.share(payload); if (st) st.textContent = 'Share sheet opened'; } catch (err) { if (err?.name !== 'AbortError' && st) st.textContent = 'Share cancelled'; }
  });
  bar?.querySelector('[data-copy]')?.addEventListener('click', async e => {
    const url = bar.dataset.shareUrl; const btn = e.currentTarget; const st = bar.querySelector('[data-share-status]');
    try { await navigator.clipboard.writeText(url); btn.textContent = 'Copied'; if (st) st.textContent = 'Link copied'; } catch { btn.textContent = 'Copy failed'; }
    setTimeout(() => { btn.textContent = 'Copy link'; }, 2200);
  });
  const slot = root.querySelector('[data-art-match]');
  if (slot) {
    try {
      const m = (await api(`matches/${slot.dataset.artMatch}`)).data;
      const sc = m.score; const s = m.stats;
      const hero = root.querySelector('[data-hero-score]');
      if (hero && sc) { hero.hidden = false; hero.innerHTML = `${teamMark(m.home, 'xs')}<b>${esc(String(sc.home))}–${esc(String(sc.away))}</b>${teamMark(m.away, 'xs')}`; }
      const bar2 = (k, label) => (s && s.home[k] !== undefined && s.away[k] !== undefined ? `<div class="am-row"><span>${num(s.home[k])}</span><span class="am-l">${esc(label)}</span><span>${num(s.away[k])}</span><span class="am-bar"><i class="h" style="width:${(100 * s.home[k] / ((s.home[k] + s.away[k]) || 1)).toFixed(1)}%"></i><i class="a" style="width:${(100 * s.away[k] / ((s.home[k] + s.away[k]) || 1)).toFixed(1)}%"></i></span></div>` : '');
      slot.querySelector('.am-slot').innerHTML = `<div class="am-board">${teamMark(m.home, 'md')}<b class="am-name">${esc(m.home?.short_name || m.home?.name || '')}</b><span class="am-sc">${sc ? `${esc(String(sc.home))}<i>–</i>${esc(String(sc.away))}` : 'v'}</span><b class="am-name">${esc(m.away?.short_name || m.away?.name || '')}</b>${teamMark(m.away, 'md')}</div>
        ${s ? `<div class="am-shots"><p class="am-h">SHOT PROFILE${s.basis === 'source' ? ' · source statistics' : ' · PBE counts'}</p>${bar2('shots', 'Shots')}${bar2('shots_on_target', 'On target')}${bar2('corners', 'Corners')}</div>` : ''}
        ${keyPlayers(m, { n: 4 })}
        <p class="am-cta">${link(`/pbecast/${m.id}`, m.status === 'finished' ? '▶ PBECAST REPLAY' : '▶ PBECAST', 'btn gold')} ${link(`/matches/${m.id}`, 'FULL MATCH INTELLIGENCE →', 'btn ghost dark')}</p>`;
    } catch { slot.remove(); }
  }
  const rail = root.querySelector('[data-art-rail]');
  if (rail) {
    try {
      const list = (await api('news', { limit: 8 })).data.filter(x => x.slug !== env.data.slug).slice(0, 5);
      rail.innerHTML = `<div class="rail-card"><p class="nrail-h">LATEST FROM THE DESK</p>${join(list, x => { const c = compByDesk(x.desk); return `<a class="rail-item" href="/news/${esc(x.desk)}/${esc(x.slug)}" data-link><span class="rc-top">${c ? competitionMark(c.slug, 'xs') : ''}<span>${esc(TYPE[x.story_class] || storyLabel(x.story_class))}</span></span><b>${esc(x.headline)}</b><small>${esc(ago(x.published_at))}</small></a>`; })}${link('/news', 'ALL NEWS →', 'nrail-all')}</div>`;
    } catch { rail.remove(); }
  }
}

