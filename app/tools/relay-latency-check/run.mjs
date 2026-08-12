/**
 * Relay-latency harness runner.  npm run test:relay-latency
 *
 * Runs check.js under a real electron main process (see ../run-under-electron.mjs
 * for why), then prints the measured times alongside the pass/fail lines. The
 * times are printed even when everything passes: this harness exists because a
 * six-second block looked like nothing at all from the outside, so the numbers
 * are the point, not just the verdict.
 */
import { readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runUnderElectron } from '../run-under-electron.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, '.results');
const RESULT = path.join(OUT_DIR, 'relay-latency.json');

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

await runUnderElectron(path.join('tools', 'relay-latency-check', 'check.js'), [RESULT]);

if (!existsSync(RESULT)) {
  console.error('No result file — electron exited early.');
  process.exit(1);
}

const r = JSON.parse(readFileSync(RESULT, 'utf8'));
if (r.error) {
  console.error(`ERROR: ${r.error}`);
  process.exit(1);
}

console.log('\n=== measured (unreachable camera — the state that used to cost ~6s a time)');
for (const t of r.timings) {
  console.log(`  ${String(t.ms).padStart(6)} ms  ${t.label}${t.note ? `\n                ${t.note}` : ''}`);
}

console.log('');
let failed = 0;
for (const c of r.checks) {
  if (!c.pass) failed++;
  console.log(`  ${c.pass ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `   [${c.detail}]` : ''}`);
}
console.log(`\n${failed === 0 ? `PASS — ${r.checks.length} relay-latency checks green` : `FAIL — ${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
