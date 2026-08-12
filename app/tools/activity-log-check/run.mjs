/**
 * Activity-log durability harness runner.  npm run test:activity
 *
 * Runs check.js under a real electron main process (see
 * ../run-under-electron.mjs for why) and prints the collected results.
 */
import { readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runUnderElectron } from '../run-under-electron.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, '.results');
const RESULT = path.join(OUT_DIR, 'activity.json');


rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

await runUnderElectron(path.join('tools', 'activity-log-check', 'check.js'), [RESULT]);

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
console.log(`\n${failed === 0 ? `PASS — ${r.checks.length} activity-log checks green` : `FAIL — ${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
