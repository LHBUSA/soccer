#!/usr/bin/env node
// Capture the Wyscout public soccer-logs dataset (Pappalardo et al. 2019,
// figshare collection 4415000, CC BY 4.0) into the raw archive.
//
// Each file is verified against the md5 that figshare publishes for it, archived
// content-addressed under .raw/ (the local mirror of the R2 layout), and its
// capture record appended to docs/evidence/captures/wyscout_figshare.json, which
// IS committed. Re-running re-captures (new capture ids) but never rewrites a
// payload: identical bytes land on the same sha256 key.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { archiveCapture, fsStorage } from '../../workers/shared/archive.js';
import { politeFetch } from '../../workers/shared/http.js';
import { WYSCOUT_FILES, WYSCOUT_PARSER_VERSION } from '../../workers/providers/wyscout-figshare.js';

const storage = await fsStorage('.raw');
const records = [];
for (const file of WYSCOUT_FILES) {
  const meta = JSON.parse(new TextDecoder().decode((await politeFetch(`https://api.figshare.com/v2/articles/${file.article}`)).bytes));
  const f = meta.files.find(x => x.id === file.fileId);
  if (!f) throw new Error(`figshare article ${file.article} no longer lists file ${file.fileId}`);
  const res = await politeFetch(f.download_url, { timeoutMs: 600000 });
  const md5 = createHash('md5').update(res.bytes).digest('hex');
  const expected = f.computed_md5 || f.supplied_md5;
  if (md5 !== expected) throw new Error(`${file.name}: md5 ${md5} != figshare ${expected}`);
  const rec = await archiveCapture(storage, {
    family: 'wyscout_figshare', sourceKey: `wyscout_figshare.${file.key}`, url: f.download_url,
    status: res.status, contentType: res.contentType, bytes: res.bytes, parserVersion: WYSCOUT_PARSER_VERSION,
    notes: `figshare article ${file.article} file ${file.fileId} (${f.name}); licence ${meta.license?.name}; md5 verified ${md5}`,
  });
  records.push(rec);
  console.log(`${file.key.padEnd(14)} ${String(rec.bytes).padStart(10)}  ${rec.content_sha256.slice(0, 16)}  ${rec.capture_id}`);
}
mkdirSync('docs/evidence/captures', { recursive: true });
writeFileSync('docs/evidence/captures/wyscout_figshare.json', JSON.stringify({ captured: new Date().toISOString(), records }, null, 2) + '\n');
