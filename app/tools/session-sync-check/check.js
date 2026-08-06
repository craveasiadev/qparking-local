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
  const bareLane = db.upsertLane({ name: 'No Policy', policyId: null, terminalId: null, gateRelayAddress: null, enabled: true });
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

  out.ok = out.checks.every((c) => c.pass);
} catch (error) {
  out.error = error?.stack ?? String(error);
} finally {
  fs.writeFileSync(resultFile, JSON.stringify(out, null, 2));
  app.exit(0);
}
