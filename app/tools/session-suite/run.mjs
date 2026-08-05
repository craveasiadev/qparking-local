/**
 * Session-lifecycle + season-pass harness runner.  npm run test:sessions
 */
import { readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runUnderElectron, APP_DIR } from '../run-under-electron.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, '.results');
const RESULT = path.join(OUT_DIR, 'sessions.json');

if (!existsSync(path.join(APP_DIR, 'dist', 'main', 'services', 'parking-flow.js'))) {
  console.error('Missing dist/main/services/parking-flow.js — run "npm run build:main" first.');
  process.exit(2);
}

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

await runUnderElectron(path.join('tools', 'session-suite', 'check.js'), [RESULT]);

if (!existsSync(RESULT)) {
  console.error('No result file — electron exited early.');
  process.exit(1);
}

const out = JSON.parse(readFileSync(RESULT, 'utf8'));
if (out.error) {
  console.error('Harness crashed:\n' + out.error);
}

let group = null;
let failed = 0;
for (const c of out.checks) {
  if (c.group !== group) {
    group = c.group;
    console.log(`\n── ${group} ${'─'.repeat(Math.max(0, 68 - group.length))}`);
  }
  if (!c.pass) failed++;
  const mark = c.pass ? ' ok ' : 'FAIL';
  console.log(`  [${mark}] ${c.name}${c.pass || !c.detail ? '' : `\n           got: ${c.detail}`}`);
}

const total = out.checks.length;
console.log(`\n${'─'.repeat(72)}`);
console.log(
  failed === 0 && !out.error
    ? `PASS — ${total} session/pass assertions all hold`
    : `FAIL — ${failed} of ${total} assertions failed${out.error ? ' (harness also crashed)' : ''}`,
);
process.exit(failed === 0 && !out.error ? 0 : 1);
