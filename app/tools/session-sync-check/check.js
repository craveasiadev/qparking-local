/**
 * Session → cloud delivery checks, run inside a REAL electron main process
 * (better-sqlite3 is built for the electron ABI, so plain node can't open the DB).
 *
 *   electron tools/session-sync-check/check.js <resultFile>
 *
 * THE regression this exists for (found 2026-08-06): every enqueue helper used to
 * resolve a rate policy for the payload's legacy `site_id` field and RETURN EARLY
 * when it found none — console.warn only. On a box whose lanes carry no rate plan
 * and which has no site-default plan, that silently discarded EVERY session: the
 * queue stayed empty, the cloud's Parking Activity page stayed blank, and nothing
 * anywhere recorded the loss. The cloud endpoint never even read `site_id`.
 *
 * Also pins the watermark semantics that replaced a naive "pushed" boolean:
 * a session is "needs push" when it was never acknowledged OR has changed since
 * it was — because unlike an activity-log row, a session mutates repeatedly.
 *
 * Launched by run.mjs. Results go to a JSON file rather than stdout because
 * electron is a Windows GUI-subsystem binary and its console output is unreliable
 * when spawned.
 */
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TZ = 'Asia/Kuala_Lumpur';

const resultFile = process.argv[2];
const out = { ok: false, checks: [], error: null };
const check = (name, pass, detail = null) => out.checks.push({ name, pass, detail });

try {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-session-sync-'));
  app.setPath('userData', tmpDir);

  const db = require('../../dist/main/services/db');
  const queue = require('../../dist/main/services/cloud-queue');

  // No cloud creds: enqueueing must not depend on being able to reach the cloud.
  db.saveSettings({ qparkingBaseUrl: '', qparkingApiKey: '' });

  // ─── 1. a lane with NO rate policy still queues ────────────────────────────
  // Deliberately the exact shape of the box that lost its sessions: lane has no
  // policyId, and rate_policies is empty so there's no site default either.
  const bareLane = db.upsertLane({ name: 'No Policy', policyId: null, terminalId: null, enabled: true });
  const noPolicy = db.getSiteDefaultRatePolicy?.() ?? null;
  check('precondition: no site-default rate policy exists', !noPolicy, JSON.stringify(noPolicy));

  const s1 = db.createEntrySession('NOPOLICY1', bareLane.id, null, null);
  queue.enqueueEntry(s1);
  const queued = db.listDueSync().filter((row) => row.op === 'session.entry');
  check('a session on a policy-less lane IS queued for the cloud', queued.length === 1,
    `queue now: ${JSON.stringify(db.listDueSync().map((r) => r.op))}`);
  check('…and its payload omits site_id rather than blocking on it',
    queued[0] && !('site_id' in queued[0].payload), JSON.stringify(queued[0]?.payload ?? null));
  check('…and carries the plate the cloud correlates by',
    queued[0]?.payload?.plate_number === 'NOPOLICY1', String(queued[0]?.payload?.plate_number));

  // ─── 2. watermark: never delivered → needs push ────────────────────────────
  check('a brand-new session needs pushing', db.countSessionsNeedingCloudPush() === 1, String(db.countSessionsNeedingCloudPush()));
  check('…and appears in the push list', db.listSessionsNeedingCloudPush().some((s) => s.id === s1.id));

  // ─── 3. a successful drain stamps THAT session ─────────────────────────────
  db.markSyncOk(queued[0].id);
  const stamped = db.getSessionById(s1.id);
  check('markSyncOk stamps cloud_synced_at on the session', !!stamped.cloudSyncedAt, String(stamped.cloudSyncedAt));
  check('…clears any previous error', stamped.cloudSyncError === null, String(stamped.cloudSyncError));
  check('…and it no longer needs pushing', db.countSessionsNeedingCloudPush() === 0, String(db.countSessionsNeedingCloudPush()));
  check('…and the queue row is gone', db.listDueSync().length === 0);

  // ─── 4. a later local change makes the cloud copy STALE ───────────────────
  // This is what a boolean "pushed" flag cannot express, and why sessions carry a
  // watermark: the row IS in the cloud, but not this version of it.
  db.recordExit(s1.id, {
    exitAt: new Date(Date.parse(stamped.entryAt) + 3_600_000).toISOString(),
    exitLaneId: bareLane.id, exitCameraId: null, exitImagePath: null,
    durationMinutes: 60, feeCents: 0, paymentStatus: 'free', terminalTxnId: null,
    freeReason: 'no-policy',
  });
  const exited = db.getSessionById(s1.id);
  check('recording the exit makes the session need pushing again',
    db.countSessionsNeedingCloudPush() === 1,
    `updatedAt=${exited.updatedAt} cloudSyncedAt=${exited.cloudSyncedAt}`);
  check('…while KEEPING the previous acknowledgement (stale, not absent)', !!exited.cloudSyncedAt);

  // ─── 5. the exit payload carries free_reason ───────────────────────────────
  // Without it the cloud's Parking Activity page can only say "free", and an
  // entitled pass exit is indistinguishable from a lane charging nobody.
  queue.enqueueExit(exited);
  const exitRow = db.listDueSync().find((row) => row.op === 'session.exit');
  check('the exit push carries free_reason', exitRow?.payload?.free_reason === 'no-policy', JSON.stringify(exitRow?.payload?.free_reason));
  check('…and the exit fields the cloud page renders',
    exitRow?.payload?.exit_time && exitRow?.payload?.duration_minutes === 60 && exitRow?.payload?.status === 'exited',
    JSON.stringify(exitRow?.payload));

  // ─── 6. a failed push records WHY without faking absence ──────────────────
  db.markSyncFailed(exitRow.id, '422 plate_number required');
  const failed = db.getSessionById(s1.id);
  check('markSyncFailed records the reason on the session', failed.cloudSyncError === '422 plate_number required', String(failed.cloudSyncError));
  check('…and does NOT clear the earlier acknowledgement', !!failed.cloudSyncedAt);

  // ─── 7. a transaction push must not stamp the session ─────────────────────
  // Only a session op means "the cloud has this session". A ledger push is a
  // different record entirely, and treating it as one would report a session as
  // delivered when only its payment was.
  const s2 = db.createEntrySession('TXNONLY1', bareLane.id, null, null);
  const txn = db.createTransaction({ sessionId: s2.id, status: 'pending', amountCents: 500, orderId: 'ORDER1', terminalId: null, terminalName: null });
  queue.enqueueTransaction(s2, txn);
  const txnRow = db.listDueSync().find((row) => row.op === 'transaction.upsert');
  check('a transaction push is queued', !!txnRow);
  db.markSyncOk(txnRow.id);
  check('…and does NOT mark its session as delivered', db.getSessionById(s2.id).cloudSyncedAt === null,
    String(db.getSessionById(s2.id).cloudSyncedAt));

  // ─── 8. an identical pending push collapses instead of stacking ───────────
  // Pressing "Push to cloud" repeatedly used to queue one full copy per click —
  // ~800KB each for a session carrying two plate captures. Worse, until the cloud
  // matcher was fixed each of those landed as a SEPARATE parking record (one box
  // reached 38 copies of a single stay).
  const s3 = db.createEntrySession('DEDUPE001', bareLane.id, null, null);
  queue.enqueueEntry(s3);
  queue.enqueueEntry(s3);
  queue.enqueueEntry(s3);
  const dupeRows = db.listDueSync().filter((row) => row.op === 'session.entry' && row.payload.plate_number === 'DEDUPE001');
  check('three identical pushes queue ONE row', dupeRows.length === 1, `queued ${dupeRows.length}`);

  // …but a real change must still get its own row.
  db.updateSessionFields(s3.id, { notes: 'edited by the operator' });
  const s3Edited = db.getSessionById(s3.id);
  check('an edit bumps the session rev', s3Edited.rev > s3.rev, `${s3.rev} → ${s3Edited.rev}`);
  queue.enqueueUpdate(s3Edited);
  const afterEdit = db.listDueSync().filter((row) => row.sessionId === s3.id);
  check('…and the changed version queues a SECOND row', afterEdit.length === 2, `queued ${afterEdit.length}`);

  // ─── 9. a cloud-restored session isn't reported as needing a push back ────
  // It came FROM the cloud, so pushing it up again is pure noise. (It starts with
  // a NULL watermark, so this documents the known trade-off rather than asserting
  // a behaviour we don't have.)
  const before = db.countSessionsNeedingCloudPush();
  db.importOpenSessionsFromCloud([{ plate: 'RESTORED1', entryAt: '2026-08-06T01:00:00.000Z' }]);
  check('a cloud-restored session is listed as not-yet-acknowledged (known trade-off)',
    db.countSessionsNeedingCloudPush() === before + 1,
    'it will re-push once, harmlessly: the cloud upsert is idempotent per plate+open-record');

  // ─── 10. the late plate capture reaches the cloud ─────────────────────────
  // Regression from 2026-08-07: the vendor ANPR posts one read twice — a
  // plate-only "quick result" first, the JPEG a beat later. A collapse keyed
  // only on (camera, plate) let the imageless post win and dropped the
  // picture-bearing one, so plates kept working while every session silently
  // lost its photo. attachSessionCapture is what puts the late half back.
  const capLane = db.upsertLane({ name: 'Capture', policyId: null, terminalId: null, enabled: true });

  // Entry: the session already exists when the picture lands.
  const cap1 = db.createEntrySession('CAPTURE01', capLane.id, 7, null);
  check('precondition: the quick post opened the session with NO image', cap1.entryImagePath === null);
  const attached = db.attachSessionCapture('CAPTURE01', 'entry', 'C:\\plates\\CAPTURE01-entry.jpg');
  check('a late capture attaches to the open session', attached?.entryImagePath === 'C:\\plates\\CAPTURE01-entry.jpg',
    String(attached?.entryImagePath));
  check('…and bumps rev so the sync queue treats it as a real change', attached.rev > cap1.rev,
    `${cap1.rev} → ${attached?.rev}`);
  queue.enqueueEntry(cap1);          // the imageless push that already went out
  queue.enqueueEntry(attached);      // the capture push
  const capRows = db.listDueSync().filter((r) => r.payload.plate_number === 'CAPTURE01');
  check('…so it queues its OWN push rather than collapsing into the imageless one', capRows.length === 2,
    `queued ${capRows.length}`);

  // An already-photographed session must never be overwritten by a re-post.
  const reattach = db.attachSessionCapture('CAPTURE01', 'entry', 'C:\\plates\\WRONG.jpg');
  check('a second capture does NOT overwrite a session that already has one', reattach === null,
    String(db.getSessionById(cap1.id).entryImagePath));

  // Exit: the picture lands while the charge is still in flight, so the column
  // is filled BEFORE recordExit runs. recordExit passes null for the image and
  // must not wipe it — that assignment is why the COALESCE is there.
  const cap2 = db.createEntrySession('CAPTURE02', capLane.id, 8, null);
  db.recordExit(cap2.id, {
    exitAt: new Date().toISOString(), exitLaneId: capLane.id, exitCameraId: 8,
    exitImagePath: null, durationMinutes: 10, feeCents: 0, paymentStatus: 'free', terminalTxnId: null,
  });
  const cap2Exited = db.attachSessionCapture('CAPTURE02', 'exit', 'C:\\plates\\CAPTURE02-exit.jpg');
  check('a late EXIT capture attaches to the closed session', cap2Exited?.exitImagePath === 'C:\\plates\\CAPTURE02-exit.jpg',
    String(cap2Exited?.exitImagePath));
  db.recordExit(cap2.id, {
    exitAt: cap2Exited.exitAt, exitLaneId: capLane.id, exitCameraId: 8,
    exitImagePath: null, durationMinutes: 10, feeCents: 500, paymentStatus: 'paid', terminalTxnId: 'T1',
  });
  check('…and a later imageless recordExit does NOT wipe it',
    db.getSessionById(cap2.id).exitImagePath === 'C:\\plates\\CAPTURE02-exit.jpg',
    String(db.getSessionById(cap2.id).exitImagePath));

  // The window is bounded, so a photo can't graft onto an unrelated older stay.
  const stale = db.attachSessionCapture('CAPTURE02', 'exit', 'C:\\plates\\LATE.jpg', -1);
  check('a capture outside the attach window is refused', stale === null, String(stale?.exitImagePath));

  // ── photos must never hold the parking record hostage ──────────────────
  // A plate capture is ~500KB of base64 riding inside the record's own JSON, and
  // the client timeout was one 10s constant for every call. On a slow link the
  // body could not finish, the WHOLE thing was retried six times, and the record
  // — the audit trail and the revenue — was abandoned along with the photo.
  //
  // Two changes, pinned here: the deadline now scales with what is being carried,
  // and one timeout splits the photos off so the record goes on alone.
  const T_BASE = 10_000;
  check('a payload with no photo keeps the base 10s deadline',
    queue.__test_timeoutForPayload({ plate_number: 'TMO0001' }) === T_BASE,
    String(queue.__test_timeoutForPayload({ plate_number: 'TMO0001' })));
  const small = queue.__test_timeoutForPayload({ plate_number: 'X', entry_image_base64: 'a'.repeat(500 * 1024) });
  check('~500KB of photo earns a longer one', small > T_BASE && small <= 120_000, `${small}ms`);
  const both = queue.__test_timeoutForPayload({
    plate_number: 'X',
    entry_image_base64: 'a'.repeat(500 * 1024),
    exit_image_base64: 'b'.repeat(500 * 1024),
  });
  check('…and an exit carrying TWO photos earns more again', both > small, `${small}ms → ${both}ms`);
  check('the deadline is capped, so one row cannot hold the drain open',
    queue.__test_timeoutForPayload({ entry_image_base64: 'a'.repeat(50 * 1024 * 1024) }) === 120_000);

  // The split. Needs a REAL file: readImageForUpload reads the photo off disk at
  // enqueue time, so a fixture pointing at a path that does not exist queues a
  // payload with no image at all and there is nothing to split.
  const splitJpeg = path.join(tmpDir, 'SPLIT001-entry.jpg');
  fs.writeFileSync(splitJpeg, Buffer.alloc(120 * 1024, 0x41));   // 120KB stand-in
  const splitStay = db.createEntrySession('SPLIT001', null, null, splitJpeg);
  queue.enqueueEntry(db.getSessionById(splitStay.id));
  const beforeSplit = db.listDueSync(new Date(Date.now() + 60_000).toISOString(), 100)
    .filter((r) => r.op === 'session.entry' && r.sessionId === splitStay.id);
  check('precondition: the entry queued as ONE row', beforeSplit.length === 1, `rows=${beforeSplit.length}`);

  const didSplit = queue.__test_splitImagesOff(beforeSplit[0]);
  const afterSplit = db.listDueSync(new Date(Date.now() + 60_000).toISOString(), 100)
    .filter((r) => r.sessionId === splitStay.id);
  const recordRow = afterSplit.find((r) => r.op === 'session.entry');
  const imageRow = afterSplit.find((r) => r.op === 'session.images');
  check('a timed-out photo push is split in two', didSplit === true && afterSplit.length === 2,
    `split=${didSplit} rows=${afterSplit.length}`);
  check('…the record row keeps its id and loses the photo',
    recordRow?.id === beforeSplit[0].id && recordRow?.payload.entry_image_base64 === undefined,
    `id=${recordRow?.id} hasImage=${recordRow?.payload.entry_image_base64 !== undefined}`);
  check('…the record row keeps what identifies the stay, so it can still land',
    recordRow?.payload.plate_number === 'SPLIT001' && !!recordRow?.payload.entry_time);
  check('…the photo row carries the image plus identity, and nothing that could rewrite the record',
    typeof imageRow?.payload.entry_image_base64 === 'string'
    && imageRow?.payload.plate_number === 'SPLIT001'
    && imageRow?.payload.status === undefined
    && imageRow?.payload.fee_amount === undefined,
    JSON.stringify(Object.keys(imageRow?.payload ?? {})));
  check('a payload with no photo is not split (nothing to take off)',
    queue.__test_splitImagesOff({ ...beforeSplit[0], payload: { plate_number: 'NOPIC' } }) === false);

  // ── a local delete must not race its own pending pushes ────────────────
  // Observed 2026-08-21: an `entry` was still queued for a stay that had been
  // deleted here. The delete landed first (soft-deleting the cloud record), the
  // entry landed after, and because the cloud's upsert deliberately excludes
  // soft-deleted rows from its lookup it created a SECOND record for one stay.
  // Reversed, the survivor is a LIVE record for a stay deleted locally — a car
  // showing as inside forever.
  const delStay = db.createEntrySession('DELRACE1', null, null, null);
  const otherStay = db.createEntrySession('KEEPME01', null, null, null);
  queue.enqueueEntry(db.getSessionById(delStay.id));
  queue.enqueueUpdate(db.getSessionById(delStay.id));
  queue.enqueueEntry(db.getSessionById(otherStay.id));
  const far = () => new Date(Date.now() + 3600_000).toISOString();
  const beforeDel = db.listDueSync(far(), 200);
  check('precondition: two pushes queued for the doomed stay, one for the other',
    beforeDel.filter((r) => r.sessionId === delStay.id).length === 2
    && beforeDel.filter((r) => r.sessionId === otherStay.id).length === 1,
    `doomed=${beforeDel.filter((r) => r.sessionId === delStay.id).length} other=${beforeDel.filter((r) => r.sessionId === otherStay.id).length}`);

  queue.enqueueDelete(db.getSessionById(delStay.id));
  const afterDel = db.listDueSync(far(), 200);
  const leftForStay = afterDel.filter((r) => r.sessionId === delStay.id);
  const deleteRows = afterDel.filter((r) => r.op === 'session.delete' && r.payload.plate_number === 'DELRACE1');
  check('a local delete drops every push still queued for that stay',
    leftForStay.length === 0, `still queued: ${leftForStay.map((r) => r.op).join(', ') || 'none'}`);
  check('…and queues the delete itself, so the cloud is still told',
    deleteRows.length === 1, `delete rows=${deleteRows.length}`);
  check('…while a different stay keeps its own queued push',
    afterDel.filter((r) => r.sessionId === otherStay.id).length === 1);

  // A row that already exhausted its retries must go too: it no longer retries on
  // its own, but "Retry failed" would resurrect it after the stay is gone.
  const failStay = db.createEntrySession('DELRACE2', null, null, null);
  queue.enqueueEntry(db.getSessionById(failStay.id));
  const failRow = db.listDueSync(far(), 200).find((r) => r.sessionId === failStay.id);
  db.markSyncFailed(failRow.id, 'simulated exhaustion');
  check('precondition: the row is parked as failed',
    db.syncQueueStats().failed >= 1, JSON.stringify(db.syncQueueStats()));
  queue.enqueueDelete(db.getSessionById(failStay.id));
  const failedLeft = db.listSyncQueueIssues(50).filter((i) => i.ref === 'DELRACE2' && i.status === 'failed');
  check('a FAILED push for a deleted stay is dropped too, so Retry failed cannot revive it',
    failedLeft.length === 0, `failed rows left: ${failedLeft.length}`);

  out.ok = out.checks.every((c) => c.pass);
} catch (error) {
  out.error = error?.stack ?? String(error);
} finally {
  fs.writeFileSync(resultFile, JSON.stringify(out, null, 2));
  app.exit(0);
}
