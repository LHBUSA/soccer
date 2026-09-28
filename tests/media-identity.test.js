// Deterministic club identity paths (media-wikimedia 1.1.0): never by name, paths must agree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { currentLogos, clubsAtWindow, commonsFileFromUpload, resolveTeamIdentity, proveClubByRoster } from '../workers/soccer-ingest/src/media-wikimedia.js';
import { readFileSync } from 'node:fs';

test('current logo: deprecated and ended statements drop; preferred rank wins', () => {
  assert.deepEqual(currentLogos([{ file: 'old', ended: true }, { file: 'new' }]), ['new']);
  assert.deepEqual(currentLogos([{ file: 'a' }, { file: 'b', preferred: true }]), ['b']);
  assert.deepEqual(currentLogos([{ file: 'x', deprecated: true }]), []);
  assert.deepEqual(currentLogos([{ file: 'a' }, { file: 'b' }]), ['a', 'b'], 'two live logos stay ambiguous (caller requires exactly one)');
});

test('dated roster proof: only the spell overlapping our observed window counts', () => {
  const spells = [{ club: 'Q1', start: '2019-07-01', end: '2024-06-30' }, { club: 'Q2', start: '2024-07-01', end: null }, { club: 'Q3', start: null, end: '2015-01-01' }];
  assert.deepEqual(clubsAtWindow(spells, { from: '2026-08-01', to: '2026-09-20' }), ['Q2']);
  assert.deepEqual(clubsAtWindow(spells, { from: '2024-05-01', to: '2024-08-01' }).sort(), ['Q1', 'Q2']);
  // same thresholds as the current-club proof
  assert.equal(proveClubByRoster([['Q2'], ['Q2'], ['Q2'], ['Q2']]).reason, 'too_few_matched_players');
  assert.equal(proveClubByRoster([['Q2'], ['Q2'], ['Q2'], ['Q2'], ['Q2'], ['Q9']]).qid, 'Q2');
});

test('OpenLigaDB icon: only an exact Commons upload is a candidate; Imgur / club hosts are never trusted', () => {
  assert.equal(commonsFileFromUpload('https://upload.wikimedia.org/wikipedia/commons/0/01/1._FC_Koeln_Logo_2014%E2%80%93.svg'), '1. FC Koeln Logo 2014–.svg');
  assert.equal(commonsFileFromUpload('https://upload.wikimedia.org/wikipedia/commons/thumb/6/67/Borussia_Dortmund_logo.svg/960px-Borussia_Dortmund_logo.svg.png'), 'Borussia Dortmund logo.svg');
  assert.equal(commonsFileFromUpload('https://i.imgur.com/KSIk0Eu.png'), null);
  assert.equal(commonsFileFromUpload('https://assets.dfb.de/uploads/000/018/232/small_union-Berlin.jpg'), null);
  assert.equal(commonsFileFromUpload('https://upload.wikimedia.org/wikipedia/en/a/ab/Local_fair_use.png'), null, 'English-Wikipedia local (fair use) files are not Commons');
});

test('identity paths must agree; none proven -> reasons kept', () => {
  assert.equal(resolveTeamIdentity([{ method: 'a', qid: 'Q1' }, { method: 'b', qid: null, reason: 'x' }]).qid, 'Q1');
  assert.deepEqual(resolveTeamIdentity([{ method: 'a', qid: 'Q1' }, { method: 'b', qid: 'Q1' }]).methods, ['a', 'b']);
  assert.equal(resolveTeamIdentity([{ method: 'a', qid: 'Q1' }, { method: 'b', qid: 'Q2' }]).reason, 'identity_paths_disagree');
  assert.match(resolveTeamIdentity([{ method: 'a', qid: null, reason: 'too_few' }]).reason, /a:too_few/);
});

test('owner holds are listed file by file and enforced by the pipeline', () => {
  const policy = JSON.parse(readFileSync('data/media/policy.json', 'utf8'));
  for (const f of ['Football Club Barcelona Color Update.png', 'Inter Miami CF wordmark-full pink.png', 'AS ROMA Text Logo 2020 - 2021 .svg', 'Logo Liverpool FC (2024).png']) assert.ok(policy.owner_holds[f], f);
  assert.match(readFileSync('scripts/media/wikimedia-backfill.mjs', 'utf8'), /policy\.owner_holds\?\.\[/);
});
