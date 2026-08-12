/**
 * Schema-migration harness runner.  npm run test:migration
 *
 * Runs each scenario in check.js under a real electron main process (see
 * ../run-under-electron.mjs for why), then prints the collected results and diffs
 * the fresh-install column set against the rebuilt one.
 */
import { readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runUnderElectron } from '../run-under-electron.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, '.results');


rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const CASES = [
  ['control', 'pre-fix SQL still reproduces the bug (proves the test has teeth)'],
  ['fresh', 'fresh install — baseline column set'],
  ['rebuild', 'legacy DB (stale CHECK) → rebuild keeps the audit columns'],
  ['carry', 'existing pass_id / free_reason values survive the rebuild'],
  ['dual-only', "retiring camera 'dual' — every entry cam was dual → setting flipped, behaviour preserved"],
  ['dual-mixed', "retiring camera 'dual' — dual + plain entry cams → global setting NOT flipped"],
  ['webhook-port', 'the box-wide LPR port moves onto each camera, carrying the value already in use'],
];

async function runCase(name) {
  const resultFile = path.join(OUT_DIR, `${name}.json`);
  await runUnderElectron(path.join('tools', 'migration-check', 'check.js'), [name, resultFile]);
  if (!existsSync(resultFile)) {
    return { case: name, ok: false, checks: [], error: 'no result file — electron exited early' };
  }
  return JSON.parse(readFileSync(resultFile, 'utf8'));
}

const results = [];
for (const [name] of CASES) results.push(await runCase(name));

let failed = 0;
for (const [name, desc] of CASES) {
  const r = results.find((x) => x.case === name);
  console.log(`\n=== ${name} — ${desc}`);
  if (r.error) { console.log(`  ERROR: ${r.error.split('\n')[0]}`); failed++; continue; }
  for (const c of r.checks) {
    console.log(`  ${c.pass ? 'ok  ' : 'FAIL'} ${c.name}${c.detail && !c.pass ? `\n         detail: ${c.detail}` : ''}`);
    if (!c.pass) failed++;
  }
}

// The future-proof assertion: whatever columns a fresh install gets, a rebuilt
// table must get too. This is what catches the NEXT column added to `sessions`
// without a matching entry in the rebuild block.
const fresh = results.find((r) => r.case === 'fresh')?.columns;
const rebuilt = results.find((r) => r.case === 'rebuild')?.columns;
console.log('\n=== column parity: fresh install vs rebuilt table');
if (!fresh || !rebuilt) {
  console.log('  FAIL could not collect both column sets');
  failed++;
} else {
  const missing = fresh.filter((c) => !rebuilt.includes(c));
  const extra = rebuilt.filter((c) => !fresh.includes(c));
  if (missing.length === 0 && extra.length === 0) {
    console.log(`  ok   identical (${fresh.length} columns)`);
  } else {
    if (missing.length) console.log(`  FAIL rebuild is MISSING: ${missing.join(', ')}`);
    if (extra.length) console.log(`  FAIL rebuild has extra: ${extra.join(', ')}`);
    failed++;
  }
}

console.log(`\n${failed === 0 ? 'PASS — all migration checks green' : `FAIL — ${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
