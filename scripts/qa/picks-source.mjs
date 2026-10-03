#!/usr/bin/env node
// Production QA for /picks provenance (2026-10-03): exactly ONE "SOURCE & COVERAGE" heading at 390 / 768 / 1440, both
// lane explanations inside it, no "Not stated", no horizontal overflow. Output: docs/evidence/qa/picks-source-<date>.json
//   node scripts/qa/picks-source.mjs [--base https://soccer.propbetedge.ai]
import { mkdirSync, writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const base = argv.includes('--base') ? argv[argv.indexOf('--base') + 1] : 'https://soccer.propbetedge.ai';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: 'D:/Temp/soccer-qa-chrome-picks', args: ['--no-first-run', '--disable-extensions'] });
const results = [];
for (const width of [390, 768, 1440]) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 900 });
  await page.goto(`${base}/picks?qa=${Date.now()}`, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('details.source', { timeout: 30000 });
  await page.evaluate(() => { for (const d of document.querySelectorAll('details.source')) d.open = true; });
  const r = await page.evaluate(() => {
    const body = document.body.innerText;
    const cards = [...document.querySelectorAll('details.source')];
    const pick = cards.find(c => /SOURCE & COVERAGE/.test(c.querySelector('.src-title')?.textContent || ''));
    const t = pick?.innerText || '';
    return {
      source_coverage_headings: (body.match(/SOURCE & COVERAGE/g) || []).length,
      source_cards: cards.length,
      lanes: [...(pick?.querySelectorAll('.src-lane-h') || [])].map(x => x.textContent.trim()),
      has_v1_text: /Frozen Bundesliga model\./.test(t), has_v2_text: /Frozen national-team model for UEFA Nations League group \/ league-phase matches\./.test(t),
      records_separate: /Records remain separate between V1 and V2\./.test(t), ledger_rule: /append-only ledger before lock/.test(t),
      source_row: /PropSports/.test(t), not_stated: /Not stated/i.test(body), updated_row: /\bUpdated\b/i.test(t),
      overflow_x: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  r.width = width;
  r.pass = r.source_coverage_headings === 1 && r.lanes.length === 2 && r.has_v1_text && r.has_v2_text && r.records_separate && r.ledger_rule && r.source_row && !r.not_stated && !r.overflow_x;
  results.push(r);
  console.log(JSON.stringify(r));
  await page.close();
}
await browser.close();
const day = new Date().toISOString().slice(0, 10);
mkdirSync('docs/evidence/qa', { recursive: true });
writeFileSync(`docs/evidence/qa/picks-source-${day}.json`, JSON.stringify({ generated_at: new Date().toISOString(), base, results, pass: results.every(r => r.pass) }, null, 2) + '\n');
console.log('pass', results.every(r => r.pass));
