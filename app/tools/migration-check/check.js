/**
 * One migration scenario, run inside a REAL electron main process (better-sqlite3
 * is built for the electron ABI, so plain node can't open the DB).
 *
 *   electron tools/migration-check/check.js <case> <resultFile>
 *
 * Launched by run.mjs — see the README. Results go to a JSON file rather than
 * stdout because electron is a Windows GUI-subsystem binary and its console
 * output is unreliable when spawned.
 */
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const DIST_DB = path.join(__dirname, '..', '..', 'dist', 'main', 'services', 'db.js');

// The canonical payment_status CHECK, verbatim from db.ts. Testing for this exact
// string is deliberate: a looser probe like sql.includes("'manual_release'") is a
// FALSE POSITIVE, because the `status` column's own CHECK also contains
// 'manual_release' — so a rebuild that failed and rolled back still looked like
// it had succeeded.
const CANONICAL_PAY_CHECK = "payment_status IN ('pending','paid','declined','cancelled','free','manual_release')";

const testCase = process.argv[2];
const resultFile = process.argv[3];
const out = { case: testCase, ok: false, checks: [], columns: null, error: null };
const check = (name, pass, detail = null) => out.checks.push({ name, pass, detail });

/**
 * A pre-2026-07-17 `sessions` table: restrictive payment_status CHECK, and none
 * of the columns later releases added (status, card_scheme, payment_timestamp,
 * pass_id, free_reason). The stale CHECK is what makes applySchema decide the
 * table needs rebuilding — which is the code path under test.
 */
const LEGACY_SESSIONS = `
  CREATE TABLE sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plate TEXT NOT NULL,
    entry_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    entry_lane_id INTEGER,
    entry_camera_id INTEGER,
    entry_image_path TEXT,
    exit_at TEXT,
    exit_lane_id INTEGER,
    exit_camera_id INTEGER,
    exit_image_path TEXT,
    duration_minutes INTEGER,
    fee_cents INTEGER,
    payment_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (payment_status IN ('pending','paid','free','release')),
    terminal_txn_id TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`;

function seedLegacy(dbPath, { withAuditColumns = false } = {}) {
  const seed = new Database(dbPath);
  seed.exec(LEGACY_SESSIONS);
  if (withAuditColumns) {
    seed.exec('ALTER TABLE sessions ADD COLUMN pass_id TEXT');
    seed.exec('ALTER TABLE sessions ADD COLUMN free_reason TEXT');
  }
  // id=1: still inside — the row we later close via recordExit().
  seed.prepare(`INSERT INTO sessions (id, plate, entry_at, payment_status)
                VALUES (1,'ABC1234','2026-07-29T01:00:00.000Z','pending')`).run();
  // id=2: legacy 'release' spelling — must be sanitised to 'manual_release'.
  seed.prepare(`INSERT INTO sessions (id, plate, entry_at, exit_at, payment_status)
                VALUES (2,'XYZ9999','2026-07-28T01:00:00.000Z','2026-07-28T03:00:00.000Z','release')`).run();
  if (withAuditColumns) {
    // id=3: a completed pass exit whose audit trail must survive the rebuild.
    seed.prepare(`INSERT INTO sessions (id, plate, entry_at, exit_at, payment_status, pass_id, free_reason)
                  VALUES (3,'VIP0001','2026-07-28T05:00:00.000Z','2026-07-28T06:00:00.000Z','free','pass-uuid-777','pass-monthly')`).run();
  }
  seed.close();
}

function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

/**
 * SELECT that survives a missing column. When the rebuild HAS regressed, a query
 * naming pass_id throws — and an escaping throw would abort the scenario and hide
 * every remaining check. Returning the error instead keeps the whole report.
 */
function safeGet(db, sql) {
  try { return { row: db.prepare(sql).get() }; }
  catch (e) { return { error: e.message }; }
}

try {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `qp-migration-${testCase}-`));
  app.setPath('userData', tmpDir);
  const dbPath = path.join(tmpDir, 'qparking-local.db');

  if (testCase === 'control') {
    // ─── Proves the assertions aren't vacuous ────────────────────────────
    // Replays the ORIGINAL (pre-fix) rebuild SQL. If this case ever starts
    // passing its columns through, the `rebuild` case below has lost its teeth.
    seedLegacy(dbPath);
    const db = new Database(dbPath);
    for (const sql of [
      `ALTER TABLE sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'entered'`,
      'ALTER TABLE sessions ADD COLUMN card_scheme TEXT',
      'ALTER TABLE sessions ADD COLUMN payment_timestamp TEXT',
      'ALTER TABLE sessions ADD COLUMN pass_id TEXT',
      'ALTER TABLE sessions ADD COLUMN free_reason TEXT',
    ]) db.exec(sql);
    check('before rebuild: pass_id present', columnsOf(db, 'sessions').includes('pass_id'));

    db.exec('BEGIN');
    db.exec(`CREATE TABLE sessions_rebuild (
      id INTEGER PRIMARY KEY AUTOINCREMENT, plate TEXT NOT NULL,
      entry_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, entry_lane_id INTEGER,
      entry_camera_id INTEGER, entry_image_path TEXT, exit_at TEXT, exit_lane_id INTEGER,
      exit_camera_id INTEGER, exit_image_path TEXT, duration_minutes INTEGER, fee_cents INTEGER,
      status TEXT NOT NULL DEFAULT 'entered' CHECK (status IN ('entered','exited','manual_release')),
      payment_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (payment_status IN ('pending','paid','declined','cancelled','free','manual_release')),
      terminal_txn_id TEXT, card_scheme TEXT, payment_timestamp TEXT, notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    db.exec(`INSERT INTO sessions_rebuild
      (id, plate, entry_at, entry_lane_id, entry_camera_id, entry_image_path,
       exit_at, exit_lane_id, exit_camera_id, exit_image_path, duration_minutes, fee_cents,
       status, payment_status, terminal_txn_id, card_scheme, payment_timestamp, notes, created_at, updated_at)
      SELECT id, plate, entry_at, entry_lane_id, entry_camera_id, entry_image_path,
       exit_at, exit_lane_id, exit_camera_id, exit_image_path, duration_minutes, fee_cents,
       status,
       CASE WHEN payment_status IN ('pending','paid','declined','cancelled','free','manual_release') THEN payment_status
            WHEN payment_status='release' THEN 'manual_release' ELSE 'pending' END,
       terminal_txn_id, card_scheme, payment_timestamp, notes, created_at, updated_at
      FROM sessions`);
    db.exec('DROP TABLE sessions');
    db.exec('ALTER TABLE sessions_rebuild RENAME TO sessions');
    db.exec('COMMIT');

    check('old SQL drops pass_id (the original bug)', !columnsOf(db, 'sessions').includes('pass_id'),
      columnsOf(db, 'sessions').join(','));

    let updateErr = null;
    try {
      db.prepare('UPDATE sessions SET exit_at=?, pass_id=?, free_reason=? WHERE id=?')
        .run(new Date().toISOString(), 'p1', 'pass-monthly', 1);
    } catch (e) { updateErr = e.message; }
    check('old SQL breaks the recordExit UPDATE', updateErr !== null, updateErr);
    db.close();
  } else if (testCase === 'fresh') {
    // Baseline: a brand-new install. Nothing seeded, so applySchema creates the
    // canonical sessions table. run.mjs diffs these columns against `rebuild`.
    const dbmod = require(DIST_DB);
    const db = dbmod.getDb();
    out.columns = columnsOf(db, 'sessions');
    check('fresh install created a sessions table', out.columns.length > 0, out.columns.join(','));
    const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'`).get().sql;
    check('fresh table did NOT need a rebuild', sql.includes(CANONICAL_PAY_CHECK));
  } else {
    // ─── The real migration, via the built main-process db module ──────────
    seedLegacy(dbPath, { withAuditColumns: testCase === 'carry' });
    const dbmod = require(DIST_DB);
    const db = dbmod.getDb();

    out.columns = columnsOf(db, 'sessions');
    const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'`).get().sql;
    // Must be the payment_status CHECK specifically — see CANONICAL_PAY_CHECK.
    // If this fails, the rebuild threw and rolled back (db.ts logs the reason).
    check('rebuild ran and committed (payment_status CHECK is canonical)',
      sql.includes(CANONICAL_PAY_CHECK), sql.replace(/\s+/g, ' ').slice(0, 200));
    check('sessions.pass_id survived', out.columns.includes('pass_id'), out.columns.join(','));
    check('sessions.free_reason survived', out.columns.includes('free_reason'));

    const legacy = db.prepare('SELECT payment_status FROM sessions WHERE id=2').get();
    check("legacy 'release' mapped to 'manual_release'", legacy.payment_status === 'manual_release',
      legacy.payment_status);

    if (testCase === 'carry') {
      const r = safeGet(db, 'SELECT pass_id, free_reason FROM sessions WHERE id=3');
      check('existing pass_id value carried across', r.row?.pass_id === 'pass-uuid-777', r.error ?? r.row?.pass_id);
      check('existing free_reason value carried across', r.row?.free_reason === 'pass-monthly', r.error ?? r.row?.free_reason);
    }

    // THE regression. recordExit() writes pass_id/free_reason; before the fix this
    // threw "no such column: pass_id" for the rest of the boot, so NO exit could
    // be recorded until the app was restarted.
    let recordErr = null;
    try {
      dbmod.recordExit(1, {
        exitAt: '2026-07-29T02:00:00.000Z',
        exitLaneId: null, exitCameraId: null, exitImagePath: null,
        durationMinutes: 60, feeCents: 0, paymentStatus: 'free', terminalTxnId: null,
        passId: 'pass-uuid-123', freeReason: 'pass-monthly',
      });
    } catch (e) { recordErr = e.message; }
    check('recordExit() works after the rebuild', recordErr === null, recordErr);

    const closed = safeGet(db, 'SELECT status, payment_status, pass_id, free_reason FROM sessions WHERE id=1');
    check('free-exit audit trail persisted',
      closed.row?.pass_id === 'pass-uuid-123' && closed.row?.free_reason === 'pass-monthly',
      closed.error ?? JSON.stringify(closed.row));
  }

  out.ok = out.checks.every((c) => c.pass);
} catch (e) {
  out.error = e && e.stack ? e.stack : String(e);
}

fs.writeFileSync(resultFile, JSON.stringify(out, null, 2));
app.exit(out.ok ? 0 : 1);
