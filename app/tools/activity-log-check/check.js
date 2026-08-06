/**
 * Activity-log durability checks, run inside a REAL electron main process
 * (better-sqlite3 is built for the electron ABI, so plain node can't open the DB).
 *
 *   electron tools/activity-log-check/check.js <resultFile>
 *
 * What this exists to protect (all three were live defects on 2026-08-06):
 *
 *   1. The cloud mirror-down (`replaceAllActivityLogs`) used to DELETE the whole
 *      table before re-inserting the cloud's set. Local rows the cloud hadn't
 *      acked yet — manual releases, blacklist refusals, gate refusals — exist
 *      NOWHERE else, so a "Sync now" pressed before "Push to cloud" destroyed
 *      them silently.
 *   2. A push that lands server-side but loses its response leaves the local row
 *      unacked while the cloud already holds it under the SAME id, so the next
 *      mirror-down has to be able to absorb that collision instead of throwing.
 *   3. An undeliverable row (one the cloud's enums can't map) has to end up with
 *      a REASON against it, not sit at a bare "Not pushed yet" forever.
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-activity-log-'));
  app.setPath('userData', tmpDir);

  const db = require('../../dist/main/services/db');

  /** A cloud-shaped row as mapApiRowToActivityLogs() would hand it over. */
  const cloudRow = (id, eventKey, occurredAt) => ({
    id,
    eventKey,
    action: 'entry',
    category: 'session',
    severity: 'high',
    outcome: 'ok',
    resourceType: 'parking_record',
    resourceId: '1',
    correlationId: null,
    description: `cloud ${eventKey}`,
    changes: null,
    source: 'cloud',
    actorName: 'Site: Test',
    siteId: 'site-1',
    occurredAt,
    createdAt: occurredAt,
  });

  const byId = (id) => db.listActivityLogs().find((row) => row.id === id) ?? null;

  // ─── 1. a local row the cloud hasn't acked survives the mirror-down ────────
  db.insertActivityLog({
    eventKey: 'session.manual_release',
    action: 'manual_release',
    category: 'session',
    severity: 'high',
    outcome: 'ok',
    resourceType: 'parking_record',
    resourceId: '42',
    description: 'released by hand, never pushed',
    siteId: 'site-1',
  });
  const unpushed = db.listActivityLogs().find((row) => row.eventKey === 'session.manual_release');
  check('a fresh local row starts unpushed', !!unpushed && !unpushed.pushedToCloud);

  db.replaceAllActivityLogs([cloudRow('cloud-1', 'session.entry', '2026-08-06T02:00:00.000Z')]);

  const survivor = db.listActivityLogs().find((row) => row.eventKey === 'session.manual_release');
  check('mirror-down PRESERVES the unpushed local row', !!survivor,
    `rows now: ${db.listActivityLogs().map((r) => r.eventKey).join(', ') || 'none'}`);
  check('…and still brings the cloud row down', !!byId('cloud-1'));

  // ─── 2. an acked local row is replaced by the cloud's copy, not duplicated ──
  db.insertActivityLog({
    eventKey: 'gate.manual.opened',
    action: 'access',
    category: 'gate',
    severity: 'high',
    outcome: 'ok',
    resourceType: 'local_lane',
    resourceId: '7',
    description: 'pushed already',
    siteId: 'site-1',
  });
  const pushedRow = db.listActivityLogs().find((row) => row.eventKey === 'gate.manual.opened');
  db.updateActivityLogs([pushedRow]);
  check('an acked row is marked pushed', !!byId(pushedRow.id)?.pushedToCloud);

  db.replaceAllActivityLogs([cloudRow('cloud-2', 'session.exit', '2026-08-06T03:00:00.000Z')]);
  check('mirror-down DROPS a row the cloud already has (no orphan copy)',
    !byId(pushedRow.id),
    'an acked local row must come back from the cloud set, not linger locally');

  // ─── 3. the lost-response collision: same id in both places ────────────────
  const collide = db.listActivityLogs().find((row) => row.eventKey === 'session.manual_release');
  let collisionError = null;
  try {
    db.replaceAllActivityLogs([
      cloudRow('cloud-3', 'session.entry', '2026-08-06T04:00:00.000Z'),
      // The cloud stored the preserved row (its ack was lost in transit) and now
      // returns it under the id the local row still carries.
      { ...cloudRow(collide.id, 'session.manual_release', '2026-08-06T01:00:00.000Z'), source: 'local' },
    ]);
  } catch (e) {
    collisionError = e?.message ?? String(e);
  }
  check('mirror-down absorbs an id collision instead of throwing', collisionError === null, collisionError);
  const resolved = byId(collide.id);
  check('…and the collided row flips to pushed (the cloud has it)', !!resolved?.pushedToCloud);
  check('…exactly once', db.listActivityLogs().filter((row) => row.id === collide.id).length === 1);

  // ─── 4. a rejected push leaves a reason on the row ────────────────────────
  db.insertActivityLog({
    eventKey: 'config.settings.saved',
    action: 'edit',
    category: 'config',
    severity: 'medium',
    outcome: 'ok',
    resourceType: 'app_settings',
    description: 'settings edit the cloud rejected',
    siteId: 'site-1',
  });
  const rejected = db.listActivityLogs().find((row) => row.eventKey === 'config.settings.saved');
  db.markActivityLogsPushFailed([rejected.id], 'Missing or empty required field: action');
  check('a rejected row carries the cloud\'s reason', byId(rejected.id)?.syncError === 'Missing or empty required field: action');
  check('…and is still pending, not silently acked', !byId(rejected.id)?.pushedToCloud);

  // An acked row must never be stamped with an error — the push loop hands the
  // rejected list in wholesale, and a stale id in it would smear a false error
  // over a row that landed fine.
  db.markActivityLogsPushFailed([resolved.id], 'should not stick');
  check('a pushed row cannot be stamped with a push error', byId(resolved.id)?.syncError === null);

  // ─── 5. newest-first ordering survives a mixed local/cloud table ───────────
  const order = db.listActivityLogs().map((row) => row.occurredAt);
  const sorted = [...order].sort().reverse();
  check('listActivityLogs stays newest-first', JSON.stringify(order) === JSON.stringify(sorted));

  out.ok = out.checks.every((c) => c.pass);
} catch (error) {
  out.error = error?.stack ?? String(error);
} finally {
  fs.writeFileSync(resultFile, JSON.stringify(out, null, 2));
  app.exit(0);
}
