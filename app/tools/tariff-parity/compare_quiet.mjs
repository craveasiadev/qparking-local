import { readFileSync } from 'node:fs';
const scenarios = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const cloud = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const local = JSON.parse(readFileSync(process.argv[4], 'utf8'));
const c = Object.fromEntries(cloud.map(r => [r.id, r]));
const l = Object.fromEntries(local.map(r => [r.id, r]));
let ok = 0, mism = 0, cloudErr = 0, shown = 0;
for (const sc of scenarios) {
  const C = c[sc.id], L = l[sc.id];
  if (C?.error) { cloudErr++; continue; } // cloud misconfig throw — not a math diff
  if (L?.error) { mism++; if (shown++ < 15) console.log(`MISMATCH ${sc.id}: cloud=${C.total_cents} local=ERR(${L.error})`); continue; }
  if (C.total_cents === L.total_cents) { ok++; }
  else {
    mism++;
    if (shown++ < 15) {
      console.log(`MISMATCH ${sc.id}: cloud=${C.total_cents} local=${L.total_cents}`);
      console.log('  policy=' + JSON.stringify(sc.policy));
      console.log('  entry=' + sc.entry + ' exit=' + sc.exit);
      console.log('  rules=' + JSON.stringify(sc.rules));
    }
  }
}
console.log(`\n${ok} match, ${mism} mismatch, ${cloudErr} cloud-throw(skipped), of ${scenarios.length}`);
