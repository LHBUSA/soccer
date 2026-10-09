import { readFileSync } from 'node:fs';
import { translateText } from '../../src/i18n/translate.js';
const files = process.argv.slice(2);
const out = new Set();
for (const f of files) {
  const s = readFileSync(f, 'utf8');
  const cands = [...s.matchAll(/>([^<>${}`]{2,})</g)].map(m => m[1]).concat([...s.matchAll(/'([^'\n$`]{3,})'/g)].map(m => m[1])).concat([...s.matchAll(/`([^`$<>\n]{3,})`/g)].map(m => m[1]));
  for (let c of cands) { c = c.replace(/\s+/g, ' ').trim(); if (!/[a-z]{2,}/.test(c) || /^[a-z_./-]+$/.test(c) || /[=(){};]|=>|\.js|https?:/.test(c)) continue; if (translateText(c, 'es') === c) out.add(`${f.split('/').pop()}\t${c}`); }
}
console.log([...out].join('\n'));
