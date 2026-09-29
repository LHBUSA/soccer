#!/usr/bin/env node
// Production QA: PBEcast pitch contract + news subject imagery + news curation, across widths.
//   node scripts/qa/news-pbecast.mjs [--site https://soccer.propbetedge.ai] [--match <cast id>] [--story <bundesliga slug>]
// PBEcast: the visible pitch (landscape or portrait) draws exactly one marker per located shot / goal / own
// goal, a ring per goal only, no .pulse halo, no highlight at full time; seeking a key moment shows only
// events through the cursor with exactly one current marker. News: the story's image is its own subject on
// the card (/news, desk) and the article hero; the homepage lead = selectHomepageLead(API items) and the
// latest rail is chronological. Evidence: docs/evidence/qa/news-pbecast-<date>.json.
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { selectHomepageLead, latestNews } from '../../src/lib/news.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const SITE = arg('--site', 'https://soccer.propbetedge.ai');
const MATCH = arg('--match', '4ad3c11c-0e39-555a-bfd4-ca6e98e22fb7'); // Vancouver 3-3 D.C. United (owner's ghost-circle case)
const STORY = arg('--story', 'bayern-munchen-1-fc-union-berlin-2026-09-18-3ce080'); // Olise hat-trick
const WIDTHS = arg('--widths', '360,390,768,1024,1440').split(',').map(Number);
const results = []; const check = (name, ok, detail = null) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || detail === null ? '' : ` :: ${JSON.stringify(detail).slice(0, 300)}`}`); };
const getJson = async p => (await (await fetch(`${SITE}/api/soccer/${p}`, { headers: { 'cache-control': 'no-cache' } })).json()).data;

const cast = await getJson(`matches/${MATCH}/cast`);
const pitchN = cast.sequence.filter(x => ['shot', 'goal', 'own_goal'].includes(x.type) && Number.isFinite(x.x)).length;
const goalN = cast.sequence.filter(x => (x.type === 'goal' || x.type === 'own_goal') && Number.isFinite(x.x)).length;
const story = await getJson(`news/${STORY}`);
const list = await getJson('news?limit=30');
const expectLead = selectHomepageLead(list);
const expectLatest = latestNews(list, expectLead)[0];

const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: 'D:/Temp/soccer-news-qa-chrome', args: ['--no-first-run', '--disable-extensions'] });
for (const width of WIDTHS) {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.setViewport({ width, height: 1000 });
  // ---- PBEcast
  await page.goto(`${SITE}/pbecast/${MATCH}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.pitch.cast');
  const pitch = () => page.evaluate(() => {
    const vis = el => el.getBoundingClientRect().width > 0 && getComputedStyle(el).display !== 'none';
    const wrap = [...document.querySelectorAll('.pitchwrap')].find(vis);
    const marks = [...wrap.querySelectorAll('.cmark')];
    const v = Number(document.querySelector('[data-rp-range]')?.value);
    return { which: wrap.classList.contains('port') ? 'portrait' : 'landscape', marks: marks.length, rings: wrap.querySelectorAll('.cmark .ring').length,
      visibleCircles: [...wrap.querySelectorAll('.cmark circle')].filter(c => vis(c) && Number(getComputedStyle(c).opacity) > 0).length,
      pulse: document.querySelectorAll('.pitch circle.pulse').length, cur: wrap.querySelectorAll('.cmark.cur').length, cpulse: wrap.querySelectorAll('.cpulse').length,
      future: marks.filter(g => Number(g.dataset.v) > v).length, v, hscroll: document.documentElement.scrollWidth > window.innerWidth + 1,
      nonShot: marks.filter(g => !/k-(goal|og|on|off|blocked|post)/.test(g.getAttribute('class'))).length };
  });
  let p = await pitch();
  check(`[${width}] pbecast full time: ${pitchN} markers on the ${p.which} pitch`, p.marks === pitchN && p.nonShot === 0, p);
  check(`[${width}] pbecast full time: rings only on goals, no halo, no highlight`, p.rings === goalN && p.pulse === 0 && p.cur === 0 && p.cpulse === 0 && p.visibleCircles === pitchN + goalN, p);
  check(`[${width}] no horizontal page scroll`, !p.hscroll);
  await page.evaluate(() => [...document.querySelectorAll('.rp-moments [data-seek]')][1].click());
  await new Promise(r => setTimeout(r, 300));
  p = await pitch();
  const through = cast.sequence.filter(x => ['shot', 'goal', 'own_goal'].includes(x.type) && Number.isFinite(x.x) && x.period === '1H' && x.minute <= p.v).length;
  check(`[${width}] pbecast seek ${p.v}': ${through} markers, none in the future, exactly one current`, p.marks === through && p.future === 0 && p.cur === 1 && p.cpulse <= 1, p);
  // ---- Olise article hero
  await page.goto(`${SITE}/news/${story.desk}/${STORY}`, { waitUntil: 'networkidle0' });
  const hero = await page.evaluate(() => ({ alt: document.querySelector('.art-hero-media .ah-subject img, .art-hero-media .tmark img')?.getAttribute('alt') || null, src: document.querySelector('.art-hero-media .ah-subject img, .art-hero-media .tmark img')?.getAttribute('src') || null, tag: document.querySelector('.art-hero-media .ah-tag b')?.textContent || null }));
  check(`[${width}] article hero subject = ${story.subject?.name}`, hero.alt === story.subject?.name && hero.tag === story.subject?.name && hero.src === story.hero?.url, hero);
  // ---- /news and the desk: the story's card image is its own subject
  for (const path of ['/news', `/news/${story.desk}`]) {
    await page.goto(`${SITE}${path}`, { waitUntil: 'networkidle0' });
    const card = await page.evaluate(h => { const a = [...document.querySelectorAll('.nwc')].find(x => x.querySelector('.nwc-head')?.textContent === h); const img = a?.querySelector('img.nimg-photo, img.nimg-crest'); return a ? { alt: img?.getAttribute('alt') || null, src: img?.getAttribute('src') || null } : null; }, story.headline);
    check(`[${width}] ${path}: story card image = its subject`, !card || (card.alt === story.subject?.name && card.src === story.hero?.url), card || 'story not listed on this page (not an error)');
  }
  // ---- homepage lead + latest
  await page.goto(`${SITE}/`, { waitUntil: 'networkidle0' });
  const home = await page.evaluate(() => ({ lead: document.querySelector('.ndesk .nlead .nl-head')?.textContent?.trim() || null, latest: document.querySelector('.ndesk .nrail .ncard2 .nc2-head')?.textContent?.trim() || null }));
  check(`[${width}] homepage lead = selectHomepageLead(API)`, home.lead && expectLead && home.lead.includes(expectLead.headline), { page: home.lead, expected: expectLead?.headline });
  check(`[${width}] homepage latest = newest non-lead story`, home.latest && expectLatest && home.latest.includes(expectLatest.headline), { page: home.latest, expected: expectLatest?.headline });
  check(`[${width}] no page errors`, !errors.length, errors);
  await page.close();
}
await browser.close();
const out = { at: new Date().toISOString(), site: SITE, match: MATCH, story: STORY, widths: WIDTHS, expected: { pitch_markers: pitchN, goal_rings: goalN, lead: expectLead?.headline, lead_published_at: expectLead?.published_at, latest: expectLatest?.headline, newest_api: list[0]?.headline, newest_api_at: list[0]?.published_at, subject: story.subject }, passed: results.filter(r => r.ok).length, total: results.length, results };
mkdirSync('docs/evidence/qa', { recursive: true });
writeFileSync(`docs/evidence/qa/news-pbecast-${out.at.slice(0, 10)}.json`, `${JSON.stringify(out, null, 2)}\n`);
console.log(`\nNEWS + PBECAST QA ${out.passed}/${out.total}`);
process.exit(out.passed === out.total ? 0 : 1);
