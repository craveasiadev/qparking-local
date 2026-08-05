/**
 * VZ camera discovery runner.  npm run find:cameras [-- <searchMs>]
 * See check.js. Read-only — it broadcasts a discovery probe and listens.
 */
import { readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runUnderElectron } from '../run-under-electron.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, '.results');
const RESULT = path.join(OUT_DIR, 'devices.json');
const SEARCH_MS = process.argv[2] ?? '6000';

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

console.log(`Broadcasting for VZ cameras (${SEARCH_MS}ms)…\n`);
await runUnderElectron(path.join('tools', 'find-cameras', 'check.js'), [RESULT, SEARCH_MS]);

if (!existsSync(RESULT)) {
  console.error('No result file — electron exited early.');
  process.exit(1);
}
const r = JSON.parse(readFileSync(RESULT, 'utf8'));
if (r.error) {
  console.error(`ERROR: ${r.error}`);
  process.exit(1);
}

/** a.b.c.d + mask → network address, so we can compare subnets. */
function network(ip, mask) {
  if (!ip || !mask) return null;
  const i = ip.split('.').map(Number);
  const m = mask.split('.').map(Number);
  if (i.length !== 4 || m.length !== 4 || i.some(isNaN) || m.some(isNaN)) return null;
  return i.map((o, k) => o & m[k]).join('.');
}

console.log('This PC:');
for (const i of r.interfaces) {
  console.log(`  ${i.name.padEnd(16)} ${i.address.padEnd(16)} mask ${i.netmask}  (net ${network(i.address, i.netmask)})`);
}

if (r.configured?.length) {
  console.log('\nCameras configured in qparking-local:');
  for (const c of r.configured) {
    console.log(`  #${c.id} ${String(c.name).padEnd(16)} host=${c.host ?? '(none)'} port=${c.device_port ?? '-'} user=${c.device_user ?? '(none)'}`);
  }
}

console.log(`\nDevices found: ${r.devices.length}`);
if (r.devices.length === 0) {
  console.log(`
  Nothing answered the broadcast. In order of likelihood:
    1. The camera is still booting — it can take 30-60s. Try again.
    2. Windows Firewall is dropping the reply. The probe is a UDP broadcast;
       allow electron.exe on Private networks, or test with the firewall off.
    3. The PC and camera are on different VLANs, or the switch port is dead —
       broadcast discovery only crosses a layer-2 segment.
    4. The camera is not powered / not linked. Check the switch port LED.`);
} else {
  const pcNets = new Set(r.interfaces.map((i) => network(i.address, i.netmask)).filter(Boolean));
  for (const d of r.devices) {
    const devNet = network(d.ip, d.netmask);
    const reachable = devNet && pcNets.has(devNet);
    console.log(`
  ${d.name}
    IP        ${d.ip}${d.port ? `:${d.port}` : ''}
    netmask   ${d.netmask ?? '(not reported)'}
    gateway   ${d.gateway ?? '(not reported)'}
    serial    ${d.serial}
    subnet    ${devNet ?? '?'}  →  ${reachable ? 'REACHABLE from this PC' : 'NOT on any subnet this PC has — this is why ping fails'}`);
    if (!reachable && devNet) {
      const suggest = d.ip.split('.').slice(0, 3).join('.');
      console.log(`    fix       add an IP on ${suggest}.x to this PC's adapter, or change the camera to one of: ${[...pcNets].join(', ')}`);
    }
  }
}
console.log('');
