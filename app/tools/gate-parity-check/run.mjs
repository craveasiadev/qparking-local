/**
 * Gate-decision parity harness runner.  npm run test:parity
 *
 * gate-decisions.json is a COPY of qparking/backend/tests/fixtures/gate-decisions.json.
 * Both suites run the same cases; if the cloud and the box ever disagree about
 * who gets in, one of them goes red.
 */
import { readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runUnderElectron, APP_DIR } from '../run-under-electron.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, '.results');
const RESULT = path.join(OUT_DIR, 'parity.json');

if (!existsSync(path.join(APP_DIR, 'dist', 'main', 'services', 'parking-flow.js'))) {
  console.error('Missing dist/main/services/parking-flow.js — run "npm run build:main" first.');
  process.exit(2);
}

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

await runUnderElectron(path.join('tools', 'gate-parity-check', 'check.js'), [RESULT]);

if (!existsSync(RESULT)) {
  console.error('No result file — electron exited early.');
  process.exit(1);
}

const r = JSON.parse(readFileSync(RESULT, 'utf8'));
if (r.error) {
  console.error(`ERROR: ${r.error}`);
  process.exit(1);
}

let failed = 0;
for (const c of r.checks) {
  if (!c.pass) failed++;
  console.log(`  ${c.pass ? 'ok  ' : 'FAIL'} ${c.name}${c.detail && !c.pass ? `\n         detail: ${c.detail}` : ''}`);
}
// Never let skipped cases read as covered.
if (r.skipped > 0) console.log(`\n  (${r.skipped} exit-direction case(s) skipped — covered by test:fees / test:sessions)`);
console.log(`\n${failed === 0 ? `PASS — ${r.checks.length} gate-parity checks green` : `FAIL — ${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
