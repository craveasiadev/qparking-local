/**
 * Cross-repo mirror-contract probe — MANUAL, needs a live SaaS. See README.md.
 *
 *   node tools/mirror-contract-probe/run.mjs <baseUrl> <siteApiKey>
 *
 * Proves end-to-end that the cloud sends `meta.total` on the gate-critical
 * mirrors and that this box therefore APPLIES a corroborated emptying on an
 * unattended tick. Nothing else pins the two halves MEETING: the backend's
 * LocalMirrorCountTest pins what the cloud sends, gate-sync-check pins what the
 * box does with it, and both would still pass if the field moved or vanished on
 * the wire.
 *
 * Point it at a site whose DENY LIST is empty in the cloud (the probe plants a
 * stale ban locally first). A pass means the empty list was corroborated and
 * applied; a fail means the box refused it, which is what a missing `meta.total`
 * looks like.
 *
 * Read-only against the cloud: three GETs. All writes go to a throwaway
 * userData dir.
 */
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const resultFile = process.argv[2];
// URL/key come through the ENV, not argv: electron's own command-line parsing
// eats argv entries that look like URLs and the process dies before this file runs.
const baseUrl = process.env.PROBE_BASE_URL;
const apiKey = process.env.PROBE_API_KEY;
const out = { checks: [], error: null };
const check = (name, pass, detail = null) => out.checks.push({ name, pass, detail });

function finish() {
  fs.writeFileSync(resultFile, JSON.stringify(out, null, 2));
  app.exit(0);
}

// Electron is a Windows GUI-subsystem binary: stdout is unreliable when spawned,
// so a crash before finish() would otherwise be completely silent.
out.stage = 'loaded';
fs.writeFileSync(resultFile, JSON.stringify(out, null, 2));
process.on('uncaughtException', (e) => { out.error = 'uncaught: ' + ((e && e.stack) || e); finish(); });
process.on('unhandledRejection', (e) => { out.error = 'unhandled: ' + ((e && e.stack) || e); finish(); });

async function main() {
  out.stage = 'main-entered';
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'qp-mirror-probe-')));
  const db = require('../../dist/main/services/db');
  const sync = require('../../dist/main/services/cloud-sync');

  db.saveSettings({ qparkingBaseUrl: baseUrl, qparkingApiKey: apiKey });

  // Plant a ban the cloud does not have. If the box reads meta.total=0 it will
  // clear this; if the total is missing it refuses and the row survives.
  db.replaceAllBlockedPlates([
    { plateNumber: 'STALEBAN1', vehicleId: null, reason: 'planted by the probe', fetchedAt: new Date().toISOString() },
  ]);
  check('precondition: box holds a stale ban the cloud does not have',
    db.mirrorRowCounts().blockedPlates === 1, JSON.stringify(db.mirrorRowCounts()));

  out.stage = 'about-to-sync';
  fs.writeFileSync(resultFile, JSON.stringify(out, null, 2));
  const r = await sync.syncGateCritical();
  out.result = r;
  out.counts = db.mirrorRowCounts();

  check('the gate tick reached the real SaaS', r.passes.ok, JSON.stringify(r.passes));
  check('...and pulled this site\'s real pass roster',
    db.mirrorRowCounts().passes > 0, JSON.stringify(db.mirrorRowCounts()));
  check('an UNATTENDED tick applied the corroborated empty deny list',
    r.blockedPlates.ok && db.mirrorRowCounts().blockedPlates === 0,
    `${JSON.stringify(r.blockedPlates)} · counts=${JSON.stringify(db.mirrorRowCounts())}`);

  finish();
}

main().catch((e) => { out.error = String((e && e.stack) || e); finish(); });
