#!/usr/bin/env node
// Rollback-only proof for ONE new migration on top of the applied chain:
// BEGIN; <migration>; <checks>; RAISE (always aborts). Output: .proof/rollback-proof.sql,
// run with scripts/db/run-rollback-proof.ps1 (fingerprint + residue checks).
//   node scripts/db/build-single-rollback-proof.mjs <migration.sql> <checks.sql>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const [file, checksFile] = process.argv.slice(2);
if (!file || !checksFile) throw new Error('usage: build-single-rollback-proof.mjs <migration.sql> <checks.sql>');
const strip = s => s.replace(/^\s*begin;\s*$/gim, '').replace(/^\s*commit;\s*$/gim, '');
const sql = strip(readFileSync(file, 'utf8'));
const checks = readFileSync(checksFile, 'utf8');
mkdirSync('.proof', { recursive: true });
writeFileSync('.proof/rollback-proof.sql', `begin;\n-- ${file}\n${sql}\n-- checks: ${checksFile}\n${checks}\nrollback;\n`);
console.log('wrote .proof/rollback-proof.sql');
