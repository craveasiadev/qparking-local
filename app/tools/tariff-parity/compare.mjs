import { readFileSync } from 'node:fs';
const scenarios = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const cloud = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const local = JSON.parse(readFileSync(process.argv[4], 'utf8'));
const cById = Object.fromEntries(cloud.map(r => [r.id, r]));
const lById = Object.fromEntries(local.map(r => [r.id, r]));

const fmt = (r) => r == null ? '-' : r.error ? `ERR(${r.error.slice(0,30)})` : `RM${(r.total_cents/100).toFixed(2)}`;
const pad = (s, n) => String(s).padEnd(n);

let pass = 0, fail = 0;
console.log(pad('SCENARIO', 32) + pad('CLOUD (B)', 14) + pad('LOCAL (A)', 14) + 'RESULT');
console.log('-'.repeat(78));
for (const sc of scenarios) {
  const c = cById[sc.id], l = lById[sc.id];
  const same = c && l && !c.error && !l.error && c.total_cents === l.total_cents;
  if (same) pass++; else fail++;
  console.log(pad(sc.id, 32) + pad(fmt(c), 14) + pad(fmt(l), 14) + (same ? 'OK' : 'MISMATCH'));
}
console.log('-'.repeat(78));
console.log(`${pass} match, ${fail} mismatch, of ${scenarios.length} scenarios`);
console.log('\nDescriptions:');
for (const sc of scenarios) console.log(`  ${sc.id}: ${sc.desc}`);
