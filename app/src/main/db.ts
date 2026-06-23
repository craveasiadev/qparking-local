/**
 * Local SQLite store. Single .db file under userData/. Schema is idempotent —
 * we apply CREATE TABLE IF NOT EXISTS on boot so new releases don't need a
 * migration runner. Every column is denormalised (no foreign-key enforcement)
 * because the operator may delete a terminal while sessions still reference it
 * and we'd rather keep the audit trail than ON DELETE CASCADE.
 */
import path from 'node:path';
import { app } from 'electron';
import Database from 'better-sqlite3';
import type {
  ActivePass,
  AppSettings, LprCamera, ParkingLane, ParkingSession, PaymentTerminal, ScopeRate, TariffRule,
} from '../shared/types';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const dbPath = path.join(app.getPath('userData'), 'qparking-local.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL'); // concurrent reads while writing
  db.pragma('foreign_keys = OFF');
  applySchema(db);
  return db;
}

function applySchema(d: Database.Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS terminals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 5000,
      secret_key TEXT NOT NULL,
      plaza_id TEXT NOT NULL,
      lane_id TEXT NOT NULL,
      lane_type TEXT NOT NULL CHECK (lane_type IN ('entry','exit','open','dual')),
      mode TEXT NOT NULL CHECK (mode IN ('lpr','kiosk')) DEFAULT 'kiosk',
      operation_mode TEXT NOT NULL CHECK (operation_mode IN ('maintenance','live','not_in_use')) DEFAULT 'live',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS cameras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      lane_id INTEGER,
      direction TEXT NOT NULL CHECK (direction IN ('entry','exit','dual')) DEFAULT 'entry',
      ingest_mode TEXT NOT NULL CHECK (ingest_mode IN ('webhook','poll')) DEFAULT 'webhook',
      host TEXT,
      snapshot_url TEXT,
      webhook_secret TEXT,
      poll_url TEXT,
      poll_interval_seconds INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS lanes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('entry','exit')) DEFAULT 'entry',
      scope_id TEXT,
      terminal_id INTEGER,
      gate_relay_address TEXT,
      enabled INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS sessions (
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
        CHECK (payment_status IN ('pending','paid','declined','cancelled','free','manual_release')),
      terminal_txn_id TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_plate_open ON sessions (plate) WHERE exit_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_sessions_entry_at ON sessions (entry_at DESC);

    CREATE TABLE IF NOT EXISTS scopes (
      scope_id TEXT PRIMARY KEY,
      scope_name TEXT NOT NULL,
      free_minutes INTEGER NOT NULL DEFAULT 0,
      first_block_cents INTEGER NOT NULL DEFAULT 0,
      per_block_cents INTEGER NOT NULL DEFAULT 0,
      block_minutes INTEGER NOT NULL DEFAULT 60,
      daily_cap_cents INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'MYR',
      fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      -- Policy-level extras from qparking SaaS RatePolicy (added 2026-06).
      policy_id TEXT,
      policy_name TEXT,
      grace_exceeded_behavior TEXT,
      cutoff_enabled INTEGER NOT NULL DEFAULT 0,
      cutoff_time TEXT,
      cutoff_behavior TEXT
    );

    -- Full active rule schedule per scope. Each row is one time-windowed
    -- TariffRule from qparking SaaS. The fee calculator picks the row
    -- matching the SESSION moment, not the moment we polled the cloud.
    CREATE TABLE IF NOT EXISTS tariff_rules (
      rule_id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      name TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      vehicle_type TEXT,
      days_of_week TEXT,                -- JSON array of ints, NULL = all days
      time_from TEXT NOT NULL DEFAULT '00:00:00',
      time_to TEXT NOT NULL DEFAULT '23:59:59',
      valid_from TEXT,                  -- yyyy-MM-dd, NULL = no lower bound
      valid_to TEXT,
      rule_type TEXT NOT NULL DEFAULT 'block_hourly',
      flat_amount_cents INTEGER NOT NULL DEFAULT 0,
      first_block_amount_cents INTEGER NOT NULL DEFAULT 0,
      first_block_minutes INTEGER NOT NULL DEFAULT 60,
      subsequent_block_amount_cents INTEGER NOT NULL DEFAULT 0,
      subsequent_block_minutes INTEGER NOT NULL DEFAULT 60,
      daily_cap_cents INTEGER NOT NULL DEFAULT 0,
      is_overnight INTEGER NOT NULL DEFAULT 0,
      fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_tariff_rules_scope ON tariff_rules (scope_id);

    -- Active season/visitor/free-access passes pulled down from qparking SaaS.
    -- Indexed by (scope_id, plate_number) for the gate's "is this plate
    -- already paid?" check at exit time. The same plate can have multiple
    -- rows (e.g. visitor + corporate); the gate uses the lowest-cost match.
    CREATE TABLE IF NOT EXISTS active_passes (
      pass_id TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      plate_number TEXT NOT NULL,
      pass_type TEXT NOT NULL,
      status TEXT NOT NULL,
      start_date TEXT,
      end_date TEXT,
      is_free INTEGER NOT NULL DEFAULT 0,
      space_number TEXT,
      fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (pass_id, plate_number)
    );
    CREATE INDEX IF NOT EXISTS idx_passes_lookup ON active_passes (scope_id, plate_number);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS terminal_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      terminal_id INTEGER NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('send','recv','error','info')),
      message TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_terminal_log_created ON terminal_log (created_at DESC);

    -- Persistent sync queue. Every push to qparking SaaS lands here first
    -- so failures survive process restarts and we can retry with backoff.
    -- The queue row IS the authoritative "we owe qparking this update"
    -- record; once delivered it's deleted. status='failed' means we've
    -- exhausted the retry budget — operator action needed (Dashboard
    -- surfaces these). last_error captures the human-readable reason.
    CREATE TABLE IF NOT EXISTS sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      op TEXT NOT NULL,             -- 'session.entry' | 'session.exit' | 'session.update' | 'session.delete'
      payload TEXT NOT NULL,        -- JSON body to POST
      attempts INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',  -- pending | failed
      last_error TEXT,
      next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_sync_queue_next ON sync_queue (status, next_attempt_at);
  `);

  // Idempotent column adds for installs whose `cameras` table was created
  // before host/snapshot_url existed. SQLite's ALTER ADD COLUMN throws if
  // the column already exists, so wrap each in its own try/catch.
  for (const col of ['host TEXT', 'snapshot_url TEXT']) {
    try { d.exec(`ALTER TABLE cameras ADD COLUMN ${col}`); } catch { /* already there */ }
  }
  // Same pattern for sessions — older installs predate card_scheme /
  // payment_timestamp. Both feed the new finance columns on the cloud.
  for (const col of ['card_scheme TEXT', 'payment_timestamp TEXT']) {
    try { d.exec(`ALTER TABLE sessions ADD COLUMN ${col}`); } catch { /* already there */ }
  }
  // One-shot correction for the W4G default port. Earlier dev builds
  // defaulted tngPort to 8080 (vendor docs don't specify, my initial guess
  // was wrong) — the actual test rig at 192.168.1.105 serves on plain
  // HTTP port 80. Wipe the persisted 8080 so the new default kicks in;
  // anyone who explicitly chose a different port keeps their value.
  try { d.prepare(`DELETE FROM settings WHERE key='tngPort' AND value='8080'`).run(); } catch { /* ignore */ }

  // Idempotent ALTERs for scopes — installs predating the 2026-06 schedule
  // expansion lack the policy + cutoff columns.
  for (const col of [
    'policy_id TEXT',
    'policy_name TEXT',
    'grace_exceeded_behavior TEXT',
    'cutoff_enabled INTEGER NOT NULL DEFAULT 0',
    'cutoff_time TEXT',
    'cutoff_behavior TEXT',
    // 2026-06-22: 3-tab Pricing redesign in qparking SaaS adds these.
    'policy_description TEXT',
    'new_day_fixed_fee_cents INTEGER',
  ]) {
    try { d.exec(`ALTER TABLE scopes ADD COLUMN ${col}`); } catch { /* already there */ }
  }
  // 2026-06-22: per-rule is_active flag — mirrors the Activations tab so
  // operators can see which rules are dimmed and the exit flow can skip
  // inactive rules even if they technically match the moment.
  try { d.exec(`ALTER TABLE tariff_rules ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1`); } catch { /* already there */ }
}

// ─── settings (key-value) ──────────────────────────────────────────────────

const DEFAULT_SETTINGS: AppSettings = {
  qparkingBaseUrl: '',
  qparkingApiKey: '',
  lprWebhookPort: 6001,
  apiPort: 6000,
  imageStorePath: '',
  exitGracePeriodSeconds: 90,
  faceappBaseUrl: '',
  faceappApiToken: '',
  faceappDeviceId: 0,
  entryCameraHandlesExit: false,
  faceGateEnabled: true,
  minimumChargeCents: 0,
  tngEnabled: false,
  tngHost: '192.168.1.105',
  tngPort: 80,
  tngCallbackPort: 6002,
  tngTimeoutSeconds: 30,
};

export function getSettings(): AppSettings {
  const d = getDb();
  const rows = d.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const result: AppSettings = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    if (row.key in result) {
      const k = row.key as keyof AppSettings;
      // Booleans/numbers come back as strings — coerce by the default's type.
      const v = row.value;
      const defType = typeof DEFAULT_SETTINGS[k];
      if (defType === 'number') (result as any)[k] = Number(v);
      else if (defType === 'boolean') (result as any)[k] = v === 'true' || v === '1';
      else (result as any)[k] = v;
    }
  }
  return result;
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const d = getDb();
  const stmt = d.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const tx = d.transaction(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === null) continue;
      stmt.run(k, String(v));
    }
  });
  tx();
  return getSettings();
}

// ─── terminals ─────────────────────────────────────────────────────────────

function rowToTerminal(r: any): PaymentTerminal {
  return {
    id: r.id, name: r.name, host: r.host, port: r.port, secretKey: r.secret_key,
    plazaId: r.plaza_id, laneId: r.lane_id, laneType: r.lane_type, mode: r.mode,
    operationMode: r.operation_mode, enabled: !!r.enabled,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function listTerminals(): PaymentTerminal[] {
  return (getDb().prepare('SELECT * FROM terminals ORDER BY id').all() as any[]).map(rowToTerminal);
}

export function getTerminal(id: number): PaymentTerminal | null {
  const r = getDb().prepare('SELECT * FROM terminals WHERE id = ?').get(id) as any;
  return r ? rowToTerminal(r) : null;
}

export function upsertTerminal(t: Omit<PaymentTerminal, 'id'|'createdAt'|'updatedAt'> & { id?: number }): PaymentTerminal {
  const d = getDb();
  if (t.id) {
    d.prepare(`UPDATE terminals SET name=?, host=?, port=?, secret_key=?, plaza_id=?, lane_id=?, lane_type=?, mode=?, operation_mode=?, enabled=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(t.name, t.host, t.port, t.secretKey, t.plazaId, t.laneId, t.laneType, t.mode, t.operationMode, t.enabled ? 1 : 0, t.id);
    return getTerminal(t.id)!;
  }
  const info = d.prepare(`INSERT INTO terminals (name, host, port, secret_key, plaza_id, lane_id, lane_type, mode, operation_mode, enabled) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(t.name, t.host, t.port, t.secretKey, t.plazaId, t.laneId, t.laneType, t.mode, t.operationMode, t.enabled ? 1 : 0);
  return getTerminal(Number(info.lastInsertRowid))!;
}

export function deleteTerminal(id: number) {
  getDb().prepare('DELETE FROM terminals WHERE id = ?').run(id);
}

export function logTerminal(terminalId: number, direction: 'send'|'recv'|'error'|'info', message: string, payload?: unknown) {
  try {
    getDb().prepare('INSERT INTO terminal_log (terminal_id, direction, message, payload) VALUES (?,?,?,?)')
      .run(terminalId, direction, message, payload === undefined ? null : JSON.stringify(payload));
  } catch { /* best-effort */ }
}

// ─── cameras ───────────────────────────────────────────────────────────────

function rowToCamera(r: any): LprCamera {
  return {
    id: r.id, name: r.name, laneId: r.lane_id, direction: r.direction,
    ingestMode: r.ingest_mode, webhookSecret: r.webhook_secret,
    host: r.host ?? null, snapshotUrl: r.snapshot_url ?? null,
    pollUrl: r.poll_url, pollIntervalSeconds: r.poll_interval_seconds,
    enabled: !!r.enabled, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function listCameras(): LprCamera[] {
  return (getDb().prepare('SELECT * FROM cameras ORDER BY id').all() as any[]).map(rowToCamera);
}

export function getCamera(id: number): LprCamera | null {
  const r = getDb().prepare('SELECT * FROM cameras WHERE id = ?').get(id) as any;
  return r ? rowToCamera(r) : null;
}

export function upsertCamera(c: Omit<LprCamera, 'id'|'createdAt'|'updatedAt'> & { id?: number }): LprCamera {
  const d = getDb();
  if (c.id) {
    d.prepare(`UPDATE cameras SET name=?, lane_id=?, direction=?, ingest_mode=?, host=?, snapshot_url=?, webhook_secret=?, poll_url=?, poll_interval_seconds=?, enabled=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(c.name, c.laneId, c.direction, c.ingestMode, c.host, c.snapshotUrl, c.webhookSecret, c.pollUrl, c.pollIntervalSeconds, c.enabled ? 1 : 0, c.id);
    return getCamera(c.id)!;
  }
  const info = d.prepare(`INSERT INTO cameras (name, lane_id, direction, ingest_mode, host, snapshot_url, webhook_secret, poll_url, poll_interval_seconds, enabled) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(c.name, c.laneId, c.direction, c.ingestMode, c.host, c.snapshotUrl, c.webhookSecret, c.pollUrl, c.pollIntervalSeconds, c.enabled ? 1 : 0);
  return getCamera(Number(info.lastInsertRowid))!;
}

export function deleteCamera(id: number) {
  getDb().prepare('DELETE FROM cameras WHERE id = ?').run(id);
}

// ─── lanes ─────────────────────────────────────────────────────────────────

function rowToLane(r: any): ParkingLane {
  return {
    id: r.id, name: r.name, direction: r.direction, scopeId: r.scope_id,
    terminalId: r.terminal_id, gateRelayAddress: r.gate_relay_address,
    enabled: !!r.enabled,
  };
}

export function listLanes(): ParkingLane[] {
  return (getDb().prepare('SELECT * FROM lanes ORDER BY id').all() as any[]).map(rowToLane);
}

export function getLane(id: number): ParkingLane | null {
  const r = getDb().prepare('SELECT * FROM lanes WHERE id = ?').get(id) as any;
  return r ? rowToLane(r) : null;
}

export function upsertLane(l: Omit<ParkingLane, 'id'> & { id?: number }): ParkingLane {
  const d = getDb();
  if (l.id) {
    d.prepare(`UPDATE lanes SET name=?, direction=?, scope_id=?, terminal_id=?, gate_relay_address=?, enabled=? WHERE id=?`)
      .run(l.name, l.direction, l.scopeId, l.terminalId, l.gateRelayAddress, l.enabled ? 1 : 0, l.id);
    return getLane(l.id)!;
  }
  const info = d.prepare(`INSERT INTO lanes (name, direction, scope_id, terminal_id, gate_relay_address, enabled) VALUES (?,?,?,?,?,?)`)
    .run(l.name, l.direction, l.scopeId, l.terminalId, l.gateRelayAddress, l.enabled ? 1 : 0);
  return getLane(Number(info.lastInsertRowid))!;
}

export function deleteLane(id: number) {
  getDb().prepare('DELETE FROM lanes WHERE id = ?').run(id);
}

// ─── sessions ──────────────────────────────────────────────────────────────

function rowToSession(r: any): ParkingSession {
  return {
    id: r.id, plate: r.plate,
    entryAt: r.entry_at, entryLaneId: r.entry_lane_id, entryCameraId: r.entry_camera_id, entryImagePath: r.entry_image_path,
    exitAt: r.exit_at, exitLaneId: r.exit_lane_id, exitCameraId: r.exit_camera_id, exitImagePath: r.exit_image_path,
    durationMinutes: r.duration_minutes, feeCents: r.fee_cents,
    paymentStatus: r.payment_status, terminalTxnId: r.terminal_txn_id,
    cardScheme: r.card_scheme ?? null,
    paymentTimestamp: r.payment_timestamp ?? null,
    notes: r.notes,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** Find the OPEN session for a plate (entry recorded, exit not yet). Used by
 *  the exit flow to look up entry time + fee calculation source. */
export function findOpenSessionByPlate(plate: string): ParkingSession | null {
  const r = getDb().prepare('SELECT * FROM sessions WHERE plate = ? AND exit_at IS NULL ORDER BY entry_at DESC LIMIT 1').get(plate) as any;
  return r ? rowToSession(r) : null;
}

export function createEntrySession(plate: string, laneId: number | null, cameraId: number | null, imagePath: string | null): ParkingSession {
  const d = getDb();
  const info = d.prepare(`INSERT INTO sessions (plate, entry_lane_id, entry_camera_id, entry_image_path) VALUES (?,?,?,?)`)
    .run(plate, laneId, cameraId, imagePath);
  return getSessionById(Number(info.lastInsertRowid))!;
}

export function getSessionById(id: number): ParkingSession | null {
  const r = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
  return r ? rowToSession(r) : null;
}

export function recordExit(sessionId: number, patch: {
  exitAt: string;
  exitLaneId: number | null;
  exitCameraId: number | null;
  exitImagePath: string | null;
  durationMinutes: number;
  feeCents: number;
  paymentStatus: ParkingSession['paymentStatus'];
  terminalTxnId: string | null;
  cardScheme?: string | null;
  paymentTimestamp?: string | null;
}): ParkingSession | null {
  getDb().prepare(`UPDATE sessions SET exit_at=?, exit_lane_id=?, exit_camera_id=?, exit_image_path=?, duration_minutes=?, fee_cents=?, payment_status=?, terminal_txn_id=?, card_scheme=?, payment_timestamp=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(
      patch.exitAt, patch.exitLaneId, patch.exitCameraId, patch.exitImagePath,
      patch.durationMinutes, patch.feeCents, patch.paymentStatus, patch.terminalTxnId,
      patch.cardScheme ?? null, patch.paymentTimestamp ?? null,
      sessionId,
    );
  return getSessionById(sessionId);
}

export function manualReleaseSession(sessionId: number, reason: string): ParkingSession | null {
  const now = new Date().toISOString();
  getDb().prepare(`UPDATE sessions SET exit_at=?, payment_status='manual_release', notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(now, reason, sessionId);
  return getSessionById(sessionId);
}

/**
 * Update editable fields on a session — used by the admin "edit session"
 * modal to correct entry/exit times when the LPR misread or the operator
 * needs to verify the fee calculation. Pass only the fields you want to
 * change; everything else stays put. `durationMinutes` / `feeCents` are
 * NOT pulled from the patch — they're always recomputed from the new
 * entry/exit pair using the supplied scope rate (passed by the caller
 * so this stays a pure data update; the caller decides the rate).
 */
export function updateSessionFields(sessionId: number, patch: {
  plate?: string;
  entryAt?: string;
  exitAt?: string | null;
  feeCents?: number;
  durationMinutes?: number;
  paymentStatus?: ParkingSession['paymentStatus'];
  notes?: string;
}): ParkingSession | null {
  const sets: string[] = [];
  const vals: any[] = [];
  if (patch.plate !== undefined) { sets.push('plate = ?'); vals.push(patch.plate); }
  if (patch.entryAt !== undefined) { sets.push('entry_at = ?'); vals.push(patch.entryAt); }
  if (patch.exitAt !== undefined) { sets.push('exit_at = ?'); vals.push(patch.exitAt); }
  if (patch.feeCents !== undefined) { sets.push('fee_cents = ?'); vals.push(patch.feeCents); }
  if (patch.durationMinutes !== undefined) { sets.push('duration_minutes = ?'); vals.push(patch.durationMinutes); }
  if (patch.paymentStatus !== undefined) { sets.push('payment_status = ?'); vals.push(patch.paymentStatus); }
  if (patch.notes !== undefined) { sets.push('notes = ?'); vals.push(patch.notes); }
  if (sets.length === 0) return getSessionById(sessionId);
  sets.push('updated_at = CURRENT_TIMESTAMP');
  vals.push(sessionId);
  getDb().prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getSessionById(sessionId);
}

export function listOpenSessions(): ParkingSession[] {
  return (getDb().prepare('SELECT * FROM sessions WHERE exit_at IS NULL ORDER BY entry_at DESC').all() as any[]).map(rowToSession);
}

export function listRecentSessions(limit: number): ParkingSession[] {
  return (getDb().prepare('SELECT * FROM sessions ORDER BY entry_at DESC LIMIT ?').all(limit) as any[]).map(rowToSession);
}

/** Total session counts for pagination (open vs all). */
export function countSessions(): { open: number; total: number } {
  const d = getDb();
  const open = (d.prepare('SELECT COUNT(*) as c FROM sessions WHERE exit_at IS NULL').get() as any).c as number;
  const total = (d.prepare('SELECT COUNT(*) as c FROM sessions').get() as any).c as number;
  return { open, total };
}

/** Paginated session lists for the renderer. */
export function listSessionsPage(opts: { tab: 'open' | 'recent'; limit: number; offset: number }): ParkingSession[] {
  const d = getDb();
  const sql = opts.tab === 'open'
    ? 'SELECT * FROM sessions WHERE exit_at IS NULL ORDER BY entry_at DESC LIMIT ? OFFSET ?'
    : 'SELECT * FROM sessions ORDER BY entry_at DESC LIMIT ? OFFSET ?';
  return (d.prepare(sql).all(opts.limit, opts.offset) as any[]).map(rowToSession);
}

export function deleteSession(sessionId: number): boolean {
  const info = getDb().prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  return info.changes > 0;
}

// ─── sync queue ────────────────────────────────────────────────────────────
// Persistent retry queue for outbound pushes to qparking SaaS. Every state
// change to a session (entry / update / exit / delete) drops a row here;
// the sync-queue module drains the queue with exponential backoff. A
// process restart finds these rows still pending — nothing is lost.

export type SyncOp = 'session.entry' | 'session.exit' | 'session.update' | 'session.delete';
export interface SyncQueueRow {
  id: number;
  op: SyncOp;
  payload: Record<string, unknown>;
  attempts: number;
  status: 'pending' | 'failed';
  lastError: string | null;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
}

function rowToSync(r: any): SyncQueueRow {
  return {
    id: r.id, op: r.op as SyncOp, payload: JSON.parse(r.payload),
    attempts: r.attempts, status: r.status, lastError: r.last_error,
    nextAttemptAt: r.next_attempt_at, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function enqueueSync(op: SyncOp, payload: Record<string, unknown>): number {
  const info = getDb().prepare(`INSERT INTO sync_queue (op, payload) VALUES (?, ?)`).run(op, JSON.stringify(payload));
  return Number(info.lastInsertRowid);
}

export function listDueSync(now = new Date().toISOString(), limit = 25): SyncQueueRow[] {
  return (getDb().prepare(
    `SELECT * FROM sync_queue WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id ASC LIMIT ?`
  ).all(now, limit) as any[]).map(rowToSync);
}

export function markSyncOk(id: number): void {
  getDb().prepare(`DELETE FROM sync_queue WHERE id = ?`).run(id);
}

export function markSyncRetry(id: number, error: string, delayMs: number): void {
  const next = new Date(Date.now() + delayMs).toISOString();
  getDb().prepare(
    `UPDATE sync_queue SET attempts = attempts + 1, last_error = ?, next_attempt_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(error, next, id);
}

export function markSyncFailed(id: number, error: string): void {
  getDb().prepare(
    `UPDATE sync_queue SET status = 'failed', last_error = ?, attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(error, id);
}

export function syncQueueStats(): { pending: number; failed: number; oldestPending: string | null } {
  const d = getDb();
  const pending = (d.prepare(`SELECT COUNT(*) as c FROM sync_queue WHERE status = 'pending'`).get() as any).c;
  const failed = (d.prepare(`SELECT COUNT(*) as c FROM sync_queue WHERE status = 'failed'`).get() as any).c;
  const oldest = d.prepare(`SELECT created_at FROM sync_queue WHERE status = 'pending' ORDER BY id ASC LIMIT 1`).get() as any;
  return { pending, failed, oldestPending: oldest?.created_at ?? null };
}

export function listFailedSync(limit = 50): SyncQueueRow[] {
  return (getDb().prepare(
    `SELECT * FROM sync_queue WHERE status = 'failed' ORDER BY id DESC LIMIT ?`
  ).all(limit) as any[]).map(rowToSync);
}

export function retryAllFailedSync(): number {
  return getDb().prepare(
    `UPDATE sync_queue SET status = 'pending', attempts = 0, next_attempt_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE status = 'failed'`
  ).run().changes;
}

export function clearFailedSync(): number {
  return getDb().prepare(`DELETE FROM sync_queue WHERE status = 'failed'`).run().changes;
}

/**
 * Bulk delete. Accepts a list of ids OR a `tab` filter ('open' | 'recent' | 'all')
 * for the "delete everything in this tab" use case.
 */
export function deleteSessionsBulk(opts: { ids?: number[]; tab?: 'open' | 'recent' | 'all' }): number {
  const d = getDb();
  if (opts.ids && opts.ids.length > 0) {
    const placeholders = opts.ids.map(() => '?').join(',');
    const info = d.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...opts.ids);
    return info.changes;
  }
  if (opts.tab === 'open') {
    return d.prepare('DELETE FROM sessions WHERE exit_at IS NULL').run().changes;
  }
  if (opts.tab === 'recent') {
    // "Recent" tab clears completed sessions only — never wipes open ones.
    return d.prepare('DELETE FROM sessions WHERE exit_at IS NOT NULL').run().changes;
  }
  if (opts.tab === 'all') {
    return d.prepare('DELETE FROM sessions').run().changes;
  }
  return 0;
}

// ─── scopes ────────────────────────────────────────────────────────────────

function rowToScope(r: any, rules: TariffRule[] = []): ScopeRate {
  return {
    scopeId: r.scope_id, scopeName: r.scope_name, freeMinutes: r.free_minutes,
    firstBlockCents: r.first_block_cents, perBlockCents: r.per_block_cents,
    blockMinutes: r.block_minutes, dailyCapCents: r.daily_cap_cents,
    currency: r.currency, fetchedAt: r.fetched_at,
    policyId: r.policy_id ?? null,
    policyName: r.policy_name ?? null,
    policyDescription: r.policy_description ?? null,
    graceExceededBehavior: (r.grace_exceeded_behavior ?? null) as any,
    cutoffEnabled: !!r.cutoff_enabled,
    cutoffTime: r.cutoff_time ?? null,
    cutoffBehavior: r.cutoff_behavior ?? null,
    newDayFixedFeeCents: r.new_day_fixed_fee_cents ?? null,
    rules,
  };
}

function rowToTariffRule(r: any): TariffRule {
  return {
    ruleId: r.rule_id, name: r.name,
    priority: r.priority,
    vehicleType: r.vehicle_type ?? null,
    daysOfWeek: r.days_of_week ? JSON.parse(r.days_of_week) : null,
    timeFrom: r.time_from, timeTo: r.time_to,
    validFrom: r.valid_from ?? null, validTo: r.valid_to ?? null,
    ruleType: r.rule_type as 'flat_rate' | 'block_hourly',
    flatAmountCents: r.flat_amount_cents,
    firstBlockAmountCents: r.first_block_amount_cents,
    firstBlockMinutes: r.first_block_minutes,
    subsequentBlockAmountCents: r.subsequent_block_amount_cents,
    subsequentBlockMinutes: r.subsequent_block_minutes,
    dailyCapCents: r.daily_cap_cents,
    isOvernight: !!r.is_overnight,
    // Default true on legacy rows (DB column has DEFAULT 1) so an
    // unmigrated install doesn't suddenly treat every rule as inactive.
    isActive: r.is_active === 0 ? false : true,
  };
}

function listTariffRulesForScope(scopeId: string): TariffRule[] {
  return (getDb().prepare('SELECT * FROM tariff_rules WHERE scope_id = ? ORDER BY priority DESC, rule_id ASC').all(scopeId) as any[]).map(rowToTariffRule);
}

export function listScopes(): ScopeRate[] {
  const rows = getDb().prepare('SELECT * FROM scopes ORDER BY scope_name').all() as any[];
  return rows.map((r) => rowToScope(r, listTariffRulesForScope(r.scope_id)));
}

export function getScope(id: string): ScopeRate | null {
  const r = getDb().prepare('SELECT * FROM scopes WHERE scope_id = ?').get(id) as any;
  if (!r) return null;
  return rowToScope(r, listTariffRulesForScope(id));
}

/**
 * Idempotent upsert. Replaces the full rule set for this scope on every
 * call — the SaaS is the source of truth, so a rule removed in the cloud
 * UI should disappear locally on the very next poll.
 */
export function upsertScope(s: ScopeRate): ScopeRate {
  const d = getDb();
  const tx = d.transaction(() => {
    d.prepare(`INSERT INTO scopes (
        scope_id, scope_name, free_minutes, first_block_cents, per_block_cents,
        block_minutes, daily_cap_cents, currency, fetched_at,
        policy_id, policy_name, grace_exceeded_behavior, cutoff_enabled, cutoff_time, cutoff_behavior,
        policy_description, new_day_fixed_fee_cents
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(scope_id) DO UPDATE SET
        scope_name=excluded.scope_name,
        free_minutes=excluded.free_minutes,
        first_block_cents=excluded.first_block_cents,
        per_block_cents=excluded.per_block_cents,
        block_minutes=excluded.block_minutes,
        daily_cap_cents=excluded.daily_cap_cents,
        currency=excluded.currency,
        fetched_at=excluded.fetched_at,
        policy_id=excluded.policy_id,
        policy_name=excluded.policy_name,
        grace_exceeded_behavior=excluded.grace_exceeded_behavior,
        cutoff_enabled=excluded.cutoff_enabled,
        cutoff_time=excluded.cutoff_time,
        cutoff_behavior=excluded.cutoff_behavior,
        policy_description=excluded.policy_description,
        new_day_fixed_fee_cents=excluded.new_day_fixed_fee_cents`)
      .run(
        s.scopeId, s.scopeName, s.freeMinutes, s.firstBlockCents, s.perBlockCents,
        s.blockMinutes, s.dailyCapCents, s.currency, s.fetchedAt,
        s.policyId ?? null, s.policyName ?? null, s.graceExceededBehavior ?? null,
        s.cutoffEnabled ? 1 : 0, s.cutoffTime ?? null, s.cutoffBehavior ?? null,
        s.policyDescription ?? null, s.newDayFixedFeeCents ?? null,
      );

    d.prepare('DELETE FROM tariff_rules WHERE scope_id = ?').run(s.scopeId);
    const insertRule = d.prepare(`INSERT INTO tariff_rules (
        rule_id, scope_id, name, priority, vehicle_type, days_of_week,
        time_from, time_to, valid_from, valid_to, rule_type,
        flat_amount_cents, first_block_amount_cents, first_block_minutes,
        subsequent_block_amount_cents, subsequent_block_minutes,
        daily_cap_cents, is_overnight, is_active, fetched_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`);
    for (const r of s.rules ?? []) {
      insertRule.run(
        r.ruleId, s.scopeId, r.name, r.priority,
        r.vehicleType ?? null,
        r.daysOfWeek ? JSON.stringify(r.daysOfWeek) : null,
        r.timeFrom, r.timeTo,
        r.validFrom ?? null, r.validTo ?? null,
        r.ruleType,
        r.flatAmountCents, r.firstBlockAmountCents, r.firstBlockMinutes,
        r.subsequentBlockAmountCents, r.subsequentBlockMinutes,
        r.dailyCapCents,
        r.isOvernight ? 1 : 0,
        // Default true so older sync payloads that don't carry is_active keep
        // every rule live (matches the cloud's pre-2026-06-22 behavior).
        r.isActive === false ? 0 : 1,
      );
    }
  });
  tx();
  return getScope(s.scopeId)!;
}

// ─── active passes ─────────────────────────────────────────────────────────
// Plate-keyed cache of active season/visitor/free-access passes. Refreshed
// from qparking SaaS on the same cadence as scopes. The gate looks up the
// inbound plate here BEFORE driving the terminal — a match means "already
// paid, just open the gate".

function rowToActivePass(r: any): ActivePass {
  return {
    passId: r.pass_id, scopeId: r.scope_id, plateNumber: r.plate_number,
    passType: r.pass_type, status: r.status,
    startDate: r.start_date ?? null, endDate: r.end_date ?? null,
    isFree: !!r.is_free, spaceNumber: r.space_number ?? null,
    fetchedAt: r.fetched_at,
  };
}

/** Find an active pass for the given plate at the given scope (cloud site
 *  uuid). Returns the longest-coverage pass first so a plate with a
 *  free_access + corporate match prefers the broader entitlement. */
export function findActivePassByPlate(scopeId: string, plate: string): ActivePass | null {
  const normalised = plate.toUpperCase().replace(/\s+/g, '');
  const r = getDb().prepare(`
    SELECT * FROM active_passes
    WHERE scope_id = ? AND plate_number = ? AND status = 'active'
    ORDER BY is_free DESC, end_date DESC
    LIMIT 1
  `).get(scopeId, normalised) as any;
  return r ? rowToActivePass(r) : null;
}

export function listActivePasses(scopeId?: string): ActivePass[] {
  const sql = scopeId
    ? 'SELECT * FROM active_passes WHERE scope_id = ? ORDER BY plate_number'
    : 'SELECT * FROM active_passes ORDER BY scope_id, plate_number';
  const rows = (scopeId
    ? getDb().prepare(sql).all(scopeId)
    : getDb().prepare(sql).all()) as any[];
  return rows.map(rowToActivePass);
}

/**
 * Replace the entire cached pass set for a given scope. The SaaS is the
 * source of truth — a pass that disappeared from the cloud (revoked,
 * expired, holder unenrolled) must vanish from the local cache on the
 * very next sync.
 */
export function replaceActivePassesForScope(scopeId: string, passes: ActivePass[]): void {
  const d = getDb();
  const tx = d.transaction(() => {
    d.prepare('DELETE FROM active_passes WHERE scope_id = ?').run(scopeId);
    const insert = d.prepare(`INSERT INTO active_passes (
        pass_id, scope_id, plate_number, pass_type, status,
        start_date, end_date, is_free, space_number, fetched_at
      ) VALUES (?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`);
    for (const p of passes) {
      insert.run(
        p.passId, p.scopeId, p.plateNumber.toUpperCase().replace(/\s+/g, ''),
        p.passType, p.status,
        p.startDate, p.endDate,
        p.isFree ? 1 : 0,
        p.spaceNumber,
      );
    }
  });
  tx();
}
