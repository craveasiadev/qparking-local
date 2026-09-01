/**
 * Device-health + equipment-push checks, run inside a REAL electron main process
 * (better-sqlite3 is built for the electron ABI, so plain node can't open the DB).
 *
 *   electron tools/device-health-check/check.js <resultFile>
 *
 * WHY THIS EXISTS. The device-health feature shipped 2026-08-19 with the note
 * "no test covers this end to end", and a coverage sweep on 2026-09-01 confirmed
 * it was still true on THIS side: `health-heartbeat`, `device-health`,
 * `device-push`, `device-sync` and `camera-push` were the only main-process
 * services no harness loaded at all. The cloud half is now covered by
 * qparking's DeviceHealthTest; this is the box half.
 *
 * THE DESIGN DECISION MOST WORTH GUARDING is that the heartbeat deliberately
 * does NOT go through cloud-queue. cloud-queue is durable-with-backoff, which is
 * right for sessions and transactions — facts that must eventually land. A
 * heartbeat is the opposite: a statement about NOW, where a replayed stale one is
 * actively harmful, because "camera 3 online" delivered ten minutes late
 * resurrects a dead camera on the operator's screen. So a failed post must be
 * DROPPED, not queued. That is invisible to any happy-path test and is checked
 * here by asserting the queue stays empty across a failing post.
 *
 * Talks to a stub cloud on 127.0.0.1 rather than mocking axios, so the real URL
 * building, Bearer header and error handling are exercised.
 *
 * Launched by run.mjs. Results go to a JSON file rather than stdout because
 * electron is a Windows GUI-subsystem binary and its console output is unreliable
 * when spawned.
 */
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

process.env.TZ = 'Asia/Kuala_Lumpur';

const resultFile = process.argv[2];
const out = { ok: false, checks: [], error: null };
const check = (name, pass, detail = null) => out.checks.push({ name, pass, detail });

// --- stub cloud -------------------------------------------------------------
let handler = () => [200, { ok: true }];
const received = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed = null;
    try { parsed = JSON.parse(body || '{}'); } catch { parsed = { __unparsed: body }; }
    received.push({ path: req.url, method: req.method, body: parsed });
    const [status, payload] = handler(req.url, parsed);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
});

function finish() {
  out.ok = out.checks.every((c) => c.pass) && !out.error;
  fs.writeFileSync(resultFile, JSON.stringify(out, null, 2));
  try { server.close(); } catch { /* ignore */ }
  app.exit(0);
}

async function main() {
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'qp-device-health-')));

  const db = require('../../dist/main/services/db');
  const heartbeat = require('../../dist/main/services/health-heartbeat');
  const health = require('../../dist/main/services/device-health');
  const queue = require('../../dist/main/services/cloud-queue');
  const devicePush = require('../../dist/main/services/device-push');

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // --- 1. guards: never post to the wrong place ----------------------------
  db.saveSettings({ qparkingBaseUrl: '', qparkingApiKey: '' });
  const unconfigured = await heartbeat.postHeartbeat();
  check('an unconfigured box does not post a heartbeat',
    !unconfigured.ok && unconfigured.error === 'qparking_not_configured', JSON.stringify(unconfigured));
  check('...and sends nothing on the wire', received.length === 0, JSON.stringify(received));

  // Configured, but the box is not bound to the site its key resolves to. Any
  // report now would attach health to ANOTHER site's equipment.
  db.saveSettings({ qparkingBaseUrl: `http://127.0.0.1:${port}`, qparkingApiKey: 'test-key' });
  const unbound = await heartbeat.postHeartbeat();
  check('a box not bound to its site does not post',
    !unbound.ok && unbound.error === 'site_not_bound', JSON.stringify(unbound));
  check('...and still sends nothing on the wire', received.length === 0, JSON.stringify(received));

  // Bind the box: upsert a site and mark it bound, the way syncSite does.
  const site = db.upsertSite({
    id: 'site-health-1', companyId: 'co-1', name: 'Health Site', address: 'x',
    totalSpaces: 5, occupiedSpaces: 0, status: 'active', contactPerson: null,
    telephone: null, fax: null, country: 'MY', email: null,
    parkingSiteType: null, logoUrl: null,
  });
  db.setBoundSiteId(site.id);
  check('precondition: the box is now bound to its site', db.isBoundToCurrentSite());

  // --- 2. an empty report still proves the box is alive --------------------
  received.length = 0;
  const empty = await heartbeat.postHeartbeat();
  check('a box with no equipment still posts a heartbeat', empty.ok, JSON.stringify(empty));
  check('...to /device-health', received[0]?.path?.endsWith('/device-health') === true, JSON.stringify(received[0]?.path));
  check('...carrying reported_at and app_version so the cloud can age it',
    !!received[0]?.body?.reported_at && !!received[0]?.body?.app_version,
    JSON.stringify(received[0]?.body));
  check('...with an empty devices array rather than no array',
    Array.isArray(received[0]?.body?.devices) && received[0].body.devices.length === 0,
    JSON.stringify(received[0]?.body?.devices));

  // --- 3. the wire shape, and what is deliberately left out ---------------
  // A camera the box knows about but has NEVER pushed has no cloud row to
  // attach health to; inventing an id would create a phantom device.
  const cam = db.upsertCamera({
    name: 'North', direction: 'entry', host: '192.168.1.9', enabled: true,
  });
  await health.sweepDeviceHealth();
  const rows = health.snapshotDeviceHealth();
  check('the sweep produced at least one device row', rows.length > 0, JSON.stringify(rows.map((r) => r.kind)));

  received.length = 0;
  const withDevices = await heartbeat.postHeartbeat();
  const sent = received[0]?.body?.devices ?? [];
  check('a normal camera IS reported', sent.length === 1 && withDevices.skipped === 0,
    `sent=${sent.length} skipped=${withDevices.skipped}`);

  // Now the case the skip guard actually exists for. Every device created
  // through the app gets an external_id at insert, so the ONLY way to hold a row
  // without one is a legacy install upgraded from before that column was
  // populated — which is exactly what this simulates, by nulling it directly.
  //
  // Constructing it matters: with every device carrying an id, an assertion of
  // the form "skipped === (rows without an id)" is 0 === 0 and stays green even
  // if the guard is deleted. Measured — that version of this check SURVIVED the
  // mutation.
  // Through the module's OWN handle: a second better-sqlite3 connection to the
  // same file did not show up in the sweep, and chasing that is not the point of
  // this test.
  const changed = db.getDb().prepare('UPDATE cameras SET external_id = NULL').run().changes;
  check('precondition: the legacy row was actually written', changed > 0, String(changed));
  check('precondition: listCameras now reports no external id',
    db.listCameras().every((c) => !c.externalId),
    JSON.stringify(db.listCameras().map((c) => c.externalId)));

  await health.sweepDeviceHealth();
  const legacyRows = health.snapshotDeviceHealth();
  const withoutId = legacyRows.filter((r) => !r.externalId).length;
  check('precondition: a legacy device row with no external_id exists',
    withoutId > 0, `rows=${legacyRows.length} withoutId=${withoutId}`);

  received.length = 0;
  const legacyPost = await heartbeat.postHeartbeat();
  const legacySent = received[0]?.body?.devices ?? [];
  check('a device with no external_id is SKIPPED, not given an invented id',
    legacyPost.skipped === withoutId && legacySent.length === legacyRows.length - withoutId,
    `skipped=${legacyPost.skipped} withoutId=${withoutId} sent=${legacySent.length} rows=${legacyRows.length}`);
  check('...and nothing on the wire carries a null-ish external_id',
    legacySent.every((d) => !!d.external_id && d.external_id !== 'null' && d.external_id !== 'undefined'),
    JSON.stringify(legacySent.map((d) => d.external_id)));
  for (const d of sent) {
    check(`...a reported device carries type+external_id+status (${d.external_id})`,
      !!d.type && !!d.external_id && !!d.status, JSON.stringify(d));
  }
  check('...and never claims "unknown", which is the CLOUD\'s to derive',
    sent.every((d) => d.status !== 'unknown'), JSON.stringify(sent.map((d) => d.status)));

  // --- 4. THE design decision: a failed heartbeat is DROPPED, not queued ---
  const queuedBefore = queue.getSyncStatus().pending;
  handler = () => [500, { message: 'cloud on fire' }];
  const failed = await heartbeat.postHeartbeat();
  check('a failing heartbeat reports the error', !failed.ok && !!failed.error, JSON.stringify(failed));
  check('...and is NOT queued for replay (a stale heartbeat resurrects dead devices)',
    queue.getSyncStatus().pending === queuedBefore,
    `pending before=${queuedBefore} after=${queue.getSyncStatus().pending}`);
  // POSITIVE CONTROL for the check above: prove the counter MOVES when something
  // really is queued, so "pending didn't change" is evidence and not a tautology
  // (e.g. if getSyncStatus ever started returning a constant).
  const controlLane = db.upsertLane({ name: 'Control', policyId: null, terminalId: null, enabled: true });
  queue.enqueueEntry(db.createEntrySession('CTRL0001', controlLane.id, null, null));
  check('...and the queue counter demonstrably does move for things that ARE queued',
    queue.getSyncStatus().pending === queuedBefore + 1,
    `pending=${queue.getSyncStatus().pending} expected=${queuedBefore + 1}`);
  check('...and the failure is visible in the heartbeat state',
    !!heartbeat.getHeartbeatState().lastError, JSON.stringify(heartbeat.getHeartbeatState()));

  // A later success must clear the error, or the panel shows a dead link forever.
  handler = () => [200, { ok: true }];
  await heartbeat.postHeartbeat();
  const st = heartbeat.getHeartbeatState();
  check('a recovered heartbeat clears the error and stamps lastOkAt',
    st.lastError === null && !!st.lastOkAt, JSON.stringify(st));

  // --- 5. equipment push: a skip is not a failure -------------------------
  // SKIP_REASONS classifies "not bound"/"not configured" as SKIPPED so the
  // operator sees "nothing to do", not a red row they cannot act on.
  const skipItem = devicePush.toEquipmentPushItem(1, 'North', { ok: false, error: 'site_not_bound' });
  check('an unbound push is classified as a SKIP, not an error',
    skipItem.ok === false && skipItem.skipped === true, JSON.stringify(skipItem));
  const failItem = devicePush.toEquipmentPushItem(1, 'North', { ok: false, error: 'http_500' });
  check('...while a real failure is NOT a skip',
    failItem.ok === false && failItem.skipped === false, JSON.stringify(failItem));
  const okItem = devicePush.toEquipmentPushItem(1, 'North', { ok: true });
  check('...and a success carries no error', okItem.ok === true && !okItem.error, JSON.stringify(okItem));

  // --- 6. camera push refuses to write to the wrong site ------------------
  const cameraPush = require('../../dist/main/services/camera-push');
  db.setBoundSiteId('some-other-site');
  const misbound = await cameraPush.pushCamera(cam.id);
  check('camera push refuses while bound to a different site',
    !misbound.ok && misbound.error === 'site_not_bound', JSON.stringify(misbound));
  db.setBoundSiteId(site.id);

  // --- 7. device-sync: preview, push, pull --------------------------------
  // The PREVIEW is what the operator reads before confirming a destructive
  // mirror, so its arithmetic is the thing to get right: for a PUSH, cloud-only
  // ids are what will be soft-deleted; for a PULL, local-only ids are what will
  // be deleted here. Getting those two backwards would show "0 to remove" on the
  // screen and then remove things.
  const deviceSync = require('../../dist/main/services/device-sync');

  // Give the box two cameras and the cloud one shared + one of its own.
  //
  // ASYMMETRIC ON PURPOSE: 3 local (2 of them local-only) vs 2 cloud (1
  // cloud-only). With a symmetric 1-and-1 fixture, push.toRemove and
  // pull.toRemove are both 1 and swapping the two expressions changes nothing —
  // measured, that version of this check SURVIVED the mutation.
  db.getDb().prepare('DELETE FROM cameras').run();
  db.upsertCamera({ name: 'A', direction: 'entry', host: '10.0.0.1', enabled: true });
  db.upsertCamera({ name: 'B', direction: 'exit', host: '10.0.0.2', enabled: true });
  db.upsertCamera({ name: 'C', direction: 'entry', host: '10.0.0.3', enabled: true });
  const localIds = db.listCameras().map((c) => c.externalId);

  const cloudRows = [
    { external_id: localIds[0], name: 'A (cloud)', direction: 'entry', host: '10.0.0.1', enabled: true },
    { external_id: 'cloud-only-1', name: 'Cloud Only', direction: 'entry', host: '10.0.0.9', enabled: true },
  ];
  handler = (url) => {
    if (url.includes('/camera-devices/reconcile')) return [200, { removed: 1 }];
    if (url.includes('/camera-devices/upsert')) return [200, { data: {} }];
    if (url.includes('/camera-devices')) return [200, { data: cloudRows }];
    return [200, { ok: true }];
  };

  const pushPreview = await deviceSync.previewDeviceSync('cameras', 'push');
  check('push preview: the CLOUD-only row is the one to remove (1 of 2 cloud rows)',
    pushPreview.ok && pushPreview.localCount === 3 && pushPreview.cloudCount === 2
      && pushPreview.toRemove === 1 && pushPreview.toUpdate === 1 && pushPreview.toAdd === 2,
    JSON.stringify(pushPreview));

  const pullPreview = await deviceSync.previewDeviceSync('cameras', 'pull');
  check('pull preview: the two LOCAL-only rows are the ones to remove',
    pullPreview.ok && pullPreview.toRemove === 2 && pullPreview.toUpdate === 1 && pullPreview.toAdd === 1,
    JSON.stringify(pullPreview));

  received.length = 0;
  const pushed = await deviceSync.pushDevicesToCloud('cameras');
  const pushedPaths = received.map((r) => r.path);
  check('pushing cameras upserts each one and then reconciles',
    pushed.ok && pushedPaths.filter((p) => p.includes('/camera-devices/upsert')).length === 3
      && pushedPaths.some((p) => p.includes('/camera-devices/reconcile')),
    JSON.stringify(pushedPaths));
  const reconcileBody = received.find((r) => r.path.includes('reconcile'))?.body;
  check('...and the reconcile keep-list is exactly what the box holds',
    Array.isArray(reconcileBody?.keep) && reconcileBody.keep.length === 3
      && localIds.every((id) => reconcileBody.keep.includes(id)),
    JSON.stringify(reconcileBody));

  const pulled = await deviceSync.pullDevicesFromCloud('cameras');
  const afterPull = db.listCameras().map((c) => c.externalId);
  check('pulling applies the cloud rows', pulled.ok && pulled.applied === 2, JSON.stringify(pulled));
  check('...adding the cloud-only camera locally',
    afterPull.includes('cloud-only-1'), JSON.stringify(afterPull));
  check('...and dropping the local-only one the cloud does not have',
    !afterPull.includes(localIds[1]), JSON.stringify(afterPull));

  // Both directions must refuse while mis-bound — a push would overwrite another
  // site's equipment, a pull would replace this box's with theirs.
  db.setBoundSiteId('some-other-site');
  const pushMisbound = await deviceSync.pushDevicesToCloud('cameras');
  const pullMisbound = await deviceSync.pullDevicesFromCloud('cameras');
  check('device push refuses while bound to a different site',
    !pushMisbound.ok && pushMisbound.error === 'site_not_bound', JSON.stringify(pushMisbound));
  check('device pull refuses while bound to a different site',
    !pullMisbound.ok && pullMisbound.error === 'site_not_bound', JSON.stringify(pullMisbound));
  db.setBoundSiteId(site.id);

  // --- 8. timer hygiene ---------------------------------------------------
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const baseline = timers();
  heartbeat.startHealthHeartbeat();
  check('startHealthHeartbeat arms a timer', timers() === baseline + 1, `${baseline} -> ${timers()}`);
  heartbeat.startHealthHeartbeat();
  check('...and is idempotent', timers() === baseline + 1, `${baseline} -> ${timers()}`);
  heartbeat.stopHealthHeartbeat();
  check('stopHealthHeartbeat clears it', timers() === baseline, `${baseline} -> ${timers()}`);

  finish();
}

main().catch((e) => { out.error = String((e && e.stack) || e); finish(); });
