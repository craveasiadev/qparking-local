/**
 * Coverage-gap fee harness runner.  npm run test:fees
 */
import { readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runUnderElectron, APP_DIR } from '../run-under-electron.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, '.results');
const RESULT = path.join(OUT_DIR, 'fees.json');

if (!existsSync(path.join(APP_DIR, 'dist', 'main', 'services', 'parking-flow.js'))) {
  console.error('Missing dist/main/services/parking-flow.js — run "npm run build:main" first.');
  process.exit(2);
}

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

await runUnderElectron(path.join('tools', 'fee-gap-check', 'check.js'), [RESULT]);

if (!existsSync(RESULT)) {
  console.error('No result file — electron exited early.');
  process.exit(1);
}

const rows = JSON.parse(readFileSync(RESULT, 'utf8'));
const rm = (c) => (c == null ? '   -  ' : `RM ${(c / 100).toFixed(2)}`.padStart(9));
let failed = 0;

console.log(`${'CASE'.padEnd(36)}${'EXPECTED'.padStart(10)}${'ACTUAL'.padStart(11)}   RESULT`);
console.log('-'.repeat(72));
for (const r of rows) {
  if (!r.pass) failed++;
  console.log(`${r.id.padEnd(36)}${rm(r.expect)}${rm(r.got)}   ${r.pass ? 'ok' : `FAIL${r.err ? ` (${r.err})` : ''}`}`);
}
console.log('-'.repeat(72));
for (const r of rows) console.log(`  ${r.id}\n      ${r.why}`);

console.log(`\n${failed === 0 ? `PASS — ${rows.length} gap scenarios priced correctly` : `FAIL — ${failed} of ${rows.length} scenarios mispriced`}`);
process.exit(failed === 0 ? 0 : 1);
