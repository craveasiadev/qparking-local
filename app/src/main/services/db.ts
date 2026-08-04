/**
 * Local SQLite store. Single .db file under userData/. Schema is idempotent —
 * we apply CREATE TABLE IF NOT EXISTS on boot so new releases don't need a
 * migration runner. Every column is denormalised (no foreign-key enforcement)
 * because the operator may delete a terminal while sessions still reference it
 * and we'd rather keep the audit trail than ON DELETE CASCADE.
 */
import path from "node:path";
import { app } from "electron";
import Database from "better-sqlite3";
import type {
	SeasonPass,
	BlockedPlate,
	CloudCustomer,
	CloudVehicle,
	AppSettings,
	LprCamera,
	ParkingLane,
	ParkingSession,
	PaymentTerminal,
	RatePolicy,
	TariffRule,
	ParkingSpace,
	Site,
	SyncOp,
	SyncQueueRow,
	SyncIssue,
	ActivityLog,
	Transaction,
	TransactionStatus,
	ActivityLogPayload,
} from "../../shared/types";
import { canonicalPlate } from "../../shared/plate";
import { randomUUID } from "node:crypto";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
	if (db) return db;
	const dbPath = path.join(app.getPath("userData"), "qparking-local.db");
	db = new Database(dbPath);
	db.pragma("journal_mode = WAL"); // concurrent reads while writing
	db.pragma("foreign_keys = OFF");
	migrateScopesToRatePolicies(db);
	migrateActivePassesToSeasonPasses(db);
	migrateTerminalsToW4g(db);
	applySchema(db);
	return db;
}

/**
 * 2026-07-14 payment cutover: the Coherent/ECPI reader model was replaced by
 * Alarmtech Touch'n'Go W4G payment devices. Detect the old ECPI `terminals`
 * schema (by its `secret_key` column), drop it, and recreate the table in the
 * W4G device shape. The single device the operator had configured in Settings
 * (tngHost/tngPort/tngTimeoutSeconds) is preserved as the first row, and the
 * stale lane→terminal links (which pointed at ECPI ids) are nulled so the
 * operator re-assigns each lane to a device. Guarded + one-shot: once the table
 * has the new shape (no `secret_key`), this no-ops.
 */
function migrateTerminalsToW4g(db: Database.Database): void {
	let isEcpi = false;
	try {
		const cols = db.prepare(`PRAGMA table_info(terminals)`).all() as Array<{ name: string }>;
		if (cols.length === 0) return; // table absent → applySchema creates the W4G one
		isEcpi = cols.some((c) => c.name === "secret_key");
	} catch {
		return;
	}
	if (!isEcpi) return;

	// Preserve the currently-configured W4G device from settings before the drop.
	const readSetting = (k: string): string | undefined =>
		(db.prepare(`SELECT value FROM settings WHERE key = ?`).get(k) as { value?: string } | undefined)?.value;
	const seedHost = readSetting("tngHost") ?? "";
	const seedPort = Number(readSetting("tngPort") ?? 80) || 80;
	const seedTimeout = Number(readSetting("tngTimeoutSeconds") ?? 30) || 30;

	db.exec("DROP TABLE IF EXISTS terminals");
	try {
		db.exec("UPDATE lanes SET terminal_id = NULL");
	} catch {
		/* lanes may not exist yet */
	}
	db.exec(`
    CREATE TABLE terminals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 80,
      timeout_seconds INTEGER NOT NULL DEFAULT 30,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
	if (seedHost) {
		db.prepare(`INSERT INTO terminals (name, host, port, timeout_seconds, enabled) VALUES (?,?,?,?,1)`).run(
			"Alarmtech (migrated)",
			seedHost,
			seedPort,
			seedTimeout,
		);
	}
}

/**
 * 2026-07-10 rename: the local "scope" concept was unified with the cloud's
 * "rate policy" (they were always 1:1). Rename the legacy `scopes` table →
 * `rate_policies`, its identity columns `scope_id`/`scope_name` →
 * `policy_id`/`policy_name`, and the `scope_id` FK on lanes / active_passes /
 * tariff_rules → `policy_id`. Runs BEFORE applySchema so the table RENAME
 * isn't blocked by a freshly-created empty `rate_policies`. Every step is
 * guarded, so a fresh install (no legacy tables) and an already-migrated
 * install both no-op.
 */
function migrateScopesToRatePolicies(db: Database.Database): void {
	const hasLegacyScopes = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='scopes'`).get();
	if (hasLegacyScopes) {
		// The legacy scopes table carried BOTH scope_id (PK) and a redundant
		// policy_id extra column (same value — scope and policy were 1:1). Drop
		// the extras first so promoting scope_id → policy_id can't collide.
		// DROP COLUMN needs SQLite ≥ 3.35 (bundled by better-sqlite3).
		try {
			db.exec("ALTER TABLE scopes DROP COLUMN policy_id");
		} catch {
			/* absent / old SQLite */
		}
		try {
			db.exec("ALTER TABLE scopes DROP COLUMN policy_name");
		} catch {
			/* absent / old SQLite */
		}
		try {
			db.exec("ALTER TABLE scopes RENAME COLUMN scope_id TO policy_id");
		} catch {
			/* already renamed */
		}
		try {
			db.exec("ALTER TABLE scopes RENAME COLUMN scope_name TO policy_name");
		} catch {
			/* already renamed */
		}
		try {
			db.exec("ALTER TABLE scopes RENAME TO rate_policies");
		} catch {
			/* already renamed */
		}
	}
	// FK columns on the other tables — renamed independently (guarded, idempotent:
	// once renamed, scope_id no longer exists and the ALTER just throws + skips).
	for (const table of ["lanes", "active_passes", "tariff_rules"]) {
		try {
			db.exec(`ALTER TABLE ${table} RENAME COLUMN scope_id TO policy_id`);
		} catch {
			/* absent / already renamed */
		}
	}
	// Legacy index name — applySchema recreates it as idx_tariff_rules_policy.
	try {
		db.exec("DROP INDEX IF EXISTS idx_tariff_rules_scope");
	} catch {
		/* ignore */
	}
}

/**
 * 2026-07-11 rename: `active_passes` → `season_passes`, aligning the local
 * table with the cloud's SeasonPass model it has always mirrored. Also folds
 * in the earlier site-scoping cleanup (drop the vestigial `policy_id` column
 * and the index that referenced it) so both run while the table still has its
 * old name, THEN renames. Runs BEFORE applySchema so the RENAME isn't blocked
 * by a freshly-created empty `season_passes`. Order is load-bearing: the index
 * must be dropped before the column it depends on, and the column before the
 * table rename. Every step is guarded — a fresh install (no `active_passes`)
 * and an already-migrated install (`season_passes` present) both no-op.
 */
function migrateActivePassesToSeasonPasses(db: Database.Database): void {
	// Legacy site-scoping cleanup: the vestigial policy_id FK and its index.
	// Index first — SQLite refuses to drop a column an index still depends on.
	try {
		db.exec("DROP INDEX IF EXISTS idx_passes_lookup");
	} catch {
		/* absent */
	}
	try {
		db.exec("ALTER TABLE active_passes DROP COLUMN policy_id");
	} catch {
		/* column absent, old SQLite, or already renamed */
	}
	// The rename itself. Indexes and the composite PK follow automatically
	// (SQLite ≥ 3.25 rewrites schema references on RENAME TO).
	try {
		db.exec("ALTER TABLE active_passes RENAME TO season_passes");
	} catch {
		/* already renamed or table absent */
	}
}

function applySchema(db: Database.Database) {
	db.exec(`
    CREATE TABLE IF NOT EXISTS terminals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 80,
      timeout_seconds INTEGER NOT NULL DEFAULT 30,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS cameras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      lane_id INTEGER,
      direction TEXT NOT NULL CHECK (direction IN ('entry','exit','dual')) DEFAULT 'entry',
      host TEXT,
      webhook_secret TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS lanes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      policy_id TEXT,
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
      -- The car's physical journey — the authoritative session state.
      status TEXT NOT NULL DEFAULT 'entered'
        CHECK (status IN ('entered','exited','manual_release')),
      -- Denormalised MIRROR of the latest transaction, kept for the operator
      -- UI. Payment outcome lives in the transactions table.
      payment_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (payment_status IN ('pending','paid','declined','cancelled','free','manual_release')),
      -- Why this exit cost nothing. pass_id points at the season_passes row that
      -- waived the charge (NULL when the exit was free for a non-pass reason);
      -- free_reason records which rule applied ('pass-monthly', 'within-grace',
      -- 'rate-zero', 'no-policy'). Revenue assurance depends on being able to
      -- tell a legitimate pass exit from a misconfigured rate plan.
      pass_id TEXT,
      free_reason TEXT,
      terminal_txn_id TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_plate_open ON sessions (plate) WHERE exit_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_sessions_entry_at ON sessions (entry_at DESC);

    -- Payment ledger. One row per payment attempt against a session; the
    -- authoritative record of whether money moved (the session's payment_status
    -- is just a mirror of the latest meaningful row here).
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      local_transaction_id TEXT NOT NULL UNIQUE,
      session_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','paid','failed','refunded','voided')),
      amount_cents INTEGER NOT NULL DEFAULT 0,
      payment_method TEXT,
      card_number TEXT,
      -- Which payment device rang up the charge. terminal_id is the local FK;
      -- terminal_name is a snapshot kept for display even if the device is
      -- later renamed/deleted (and to show as the cloud "source").
      terminal_id INTEGER,
      terminal_name TEXT,
      order_id TEXT,
      payment_timestamp TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_transactions_session ON transactions (session_id);

    CREATE TABLE IF NOT EXISTS rate_policies (
      policy_id TEXT PRIMARY KEY,
      policy_name TEXT NOT NULL,
      free_minutes INTEGER NOT NULL DEFAULT 0,
      first_block_cents INTEGER NOT NULL DEFAULT 0,
      per_block_cents INTEGER NOT NULL DEFAULT 0,
      block_minutes INTEGER NOT NULL DEFAULT 60,
      daily_cap_cents INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'MYR',
      fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      -- Policy-level extras from qparking SaaS RatePolicy (added 2026-06).
      grace_exceeded_behavior TEXT,
      cutoff_enabled INTEGER NOT NULL DEFAULT 0,
      cutoff_time TEXT,
      cutoff_behavior TEXT
    );

    -- Full active rule schedule per policy. Each row is one time-windowed
    -- TariffRule from qparking SaaS. The fee calculator picks the row
    -- matching the SESSION moment, not the moment we polled the cloud.
    CREATE TABLE IF NOT EXISTS tariff_rules (
      rule_id TEXT PRIMARY KEY,
      policy_id TEXT NOT NULL,
      name TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
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
    CREATE INDEX IF NOT EXISTS idx_tariff_rules_policy ON tariff_rules (policy_id);

    -- Season / visitor / free-access passes mirrored from qparking SaaS (the
    -- cloud SeasonPass model). Site-scoped — one site per install — so the gate
    -- looks a plate up directly. A plate can ride on more than one pass (e.g. a
    -- personal + a corporate entitlement), hence the composite PK on
    -- (pass_id, plate_number); the gate prefers the free / longest-coverage row.
    CREATE TABLE IF NOT EXISTS season_passes (
      pass_id TEXT NOT NULL,
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
    -- Gate lookup is by plate alone (passes are already site-scoped).
    CREATE INDEX IF NOT EXISTS idx_passes_plate ON season_passes (plate_number);

    -- Read-only customer + vehicle directories mirrored from qparking SaaS, so
    -- staff can look an owner up at the gate without a browser. The cloud_
    -- prefix marks them as mirrors this app never writes back (unlike
    -- sessions/lanes/cameras, which are locally owned).
    CREATE TABLE IF NOT EXISTS cloud_customers (
      id TEXT PRIMARY KEY,
      full_name TEXT,
      email TEXT,
      phone TEXT,
      type TEXT,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      vehicles_count INTEGER NOT NULL DEFAULT 0,
      active_passes_count INTEGER NOT NULL DEFAULT 0,
      last_sign_in TEXT,
      created_at TEXT,
      fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS cloud_vehicles (
      id TEXT PRIMARY KEY,
      plate_number TEXT NOT NULL,
      vehicle_type TEXT,
      color TEXT,
      model TEXT,
      owner_name TEXT,
      owner_kind TEXT,
      is_blacklisted INTEGER NOT NULL DEFAULT 0,
      blacklist_reason TEXT,
      pass_type TEXT,
      pass_status TEXT,
      pass_end_date TEXT,
      created_at TEXT,
      fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    -- Plate lookup is the whole point of this mirror.
    CREATE INDEX IF NOT EXISTS idx_cloud_vehicles_plate ON cloud_vehicles (plate_number);

    -- Blacklisted plates mirrored from qparking SaaS (vehicles.is_blacklisted).
    -- Separate from season_passes because a banned vehicle usually holds NO
    -- pass, so the pass roster can never carry this. Checked BEFORE the
    -- free-exit shortcut: a banned plate that still holds an active pass must
    -- still be stopped. Plates are stored canonically (see shared/plate.ts).
    CREATE TABLE IF NOT EXISTS blocked_plates (
      plate_number TEXT PRIMARY KEY,
      vehicle_id TEXT,
      reason TEXT,
      fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

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

    -- Cached parking space inventory from qparking SaaS. Read-only mirror —
    -- written by the periodic sync; the on-prem operator views this on the
    -- Space Management page. Refreshed on the same cadence as policies/passes.
    CREATE TABLE IF NOT EXISTS parking_spaces (
      id TEXT PRIMARY KEY,
      building TEXT,
      level TEXT,
      zone TEXT,
      space_number TEXT,
      space_code TEXT,
      status TEXT NOT NULL DEFAULT 'available',
      customer_name TEXT,
      vehicle_plate TEXT,
      pass_type TEXT,
      pass_id TEXT,
      start_date TEXT,
      end_date TEXT,
      notes TEXT,
      fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_spaces_building ON parking_spaces (building);
    CREATE INDEX IF NOT EXISTS idx_spaces_status ON parking_spaces (status);

    -- Local mirror of the qparking SaaS sites table (Laravel Site model).
    -- Cloud is the source of truth; cached here so identity / occupancy /
    -- contact info is available offline. id and company_id are cloud UUIDs
    -- (TEXT, not autoincrement).
    CREATE TABLE IF NOT EXISTS sites (
      id TEXT PRIMARY KEY,
      local_server_api_key TEXT UNIQUE,
      company_id TEXT,
      name TEXT NOT NULL,
      address TEXT,
      total_spaces INTEGER NOT NULL DEFAULT 0,
      occupied_spaces INTEGER NOT NULL DEFAULT 0,
      revenue_today REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK (status IN ('active','maintenance','offline')) DEFAULT 'active',
      alarm_count INTEGER NOT NULL DEFAULT 0,
      contact_person TEXT,
      telephone TEXT,
      fax TEXT,
      country TEXT,
      email TEXT,
      season_pass_logo_url TEXT,
      parking_site_type TEXT,
      logo_url TEXT,
      receipt_header TEXT,
      receipt_footer TEXT,
      primary_color TEXT NOT NULL DEFAULT '#3b82f6',
      scope_free_minutes INTEGER,
      scope_first_block_cents INTEGER,
      scope_per_block_cents INTEGER,
      scope_block_minutes INTEGER,
      scope_daily_cap_cents INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS activity_logs (
      id TEXT PRIMARY KEY,
      event_key VARCHAR(64) NOT NULL,
      action VARCHAR(32) NOT NULL,
      category VARCHAR(32) NOT NULL,
      severity VARCHAR(16) NOT NULL DEFAULT 'low',
      outcome VARCHAR(16) DEFAULT 'ok',
      resource_type VARCHAR(64),
      resource_id VARCHAR(64),
      correlation_id VARCHAR(64),
      description TEXT,
      changes TEXT,
      source TEXT DEFAULT 'local',
      actor_name TEXT,
      site_id TEXT,
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      pushed_to_cloud BOOLEAN DEFAULT 0,
      pushed_at TEXT,
      sync_error TEXT
    );
  `);

	// 2026-07-09: the cloud retired the vehicle-type concept — pricing is now
	// purely lane → rate policy → day/time/date. Drop the cached taxonomy tables
	// and the vehicle_type column on tariff_rules on installs that still have
	// them. All idempotent / best-effort (DROP COLUMN needs SQLite ≥ 3.35).
	try {
		db.exec("DROP TABLE IF EXISTS vehicle_types");
	} catch {
		/* ignore */
	}
	try {
		db.exec("DROP TABLE IF EXISTS vehicle_groups");
	} catch {
		/* ignore */
	}
	try {
		db.exec("ALTER TABLE tariff_rules DROP COLUMN vehicle_type");
	} catch {
		/* column absent or old SQLite */
	}
	// The lane-level car/motorcycle/mixed descriptor was part of the same
	// retired vehicle-type concept — it never affected pricing. Drop it.
	try {
		db.exec("ALTER TABLE lanes DROP COLUMN lane_type");
	} catch {
		/* column absent or old SQLite */
	}
	// Lane direction is no longer stored either — it's derived from the
	// directions of the cameras assigned to the lane (deriveLaneDirection).
	// The camera is the single source of truth, so the lanes row is now pure
	// wiring (rate plan + terminal + gate relay). Drop the stale column.
	try {
		db.exec("ALTER TABLE lanes DROP COLUMN direction");
	} catch {
		/* column absent or old SQLite */
	}

	// Live video now comes from the device SDK (device_user/password/port), not a
	// stream/RTSP URL. Drop the vestigial cameras.stream_url column left over from
	// the old RTSP attempt (best-effort; no-op on old SQLite or if already gone).
	try {
		db.exec("ALTER TABLE cameras DROP COLUMN stream_url");
	} catch {
		/* column absent or old SQLite */
	}
	// HTTP snapshot URL retired — live view + captures come from the device SDK.
	try {
		db.exec("ALTER TABLE cameras DROP COLUMN snapshot_url");
	} catch {
		/* column absent or old SQLite */
	}
	// Ingest-mode + poll fields retired — cameras only ever push to the webhook.
	try {
		db.exec("ALTER TABLE cameras DROP COLUMN ingest_mode");
	} catch {
		/* column absent or old SQLite */
	}
	try {
		db.exec("ALTER TABLE cameras DROP COLUMN poll_url");
	} catch {
		/* column absent or old SQLite */
	}
	try {
		db.exec("ALTER TABLE cameras DROP COLUMN poll_interval_seconds");
	} catch {
		/* column absent or old SQLite */
	}

	// 2026-07-10: the site page was slimmed to identity / occupancy / contact,
	// so receipt-branding, season-pass logo and policy-override columns are no
	// longer synced or read. Drop them on installs whose `sites` table predates
	// this. Idempotent / best-effort (DROP COLUMN needs SQLite ≥ 3.35).
	for (const col of [
		"season_pass_logo_url",
		"receipt_header",
		"receipt_footer",
		"primary_color",
		"scope_free_minutes",
		"scope_first_block_cents",
		"scope_per_block_cents",
		"scope_block_minutes",
		"scope_daily_cap_cents",
	]) {
		try {
			db.exec(`ALTER TABLE sites DROP COLUMN ${col}`);
		} catch {
			/* column absent or old SQLite */
		}
	}

	// Idempotent column adds for installs whose `cameras` table was created
	// before host/snapshot_url existed. SQLite's ALTER ADD COLUMN throws if
	// the column already exists, so wrap each in its own try/catch.
	for (const col of ["host TEXT", "device_user TEXT", "device_password TEXT", "device_port INTEGER"]) {
		try {
			db.exec(`ALTER TABLE cameras ADD COLUMN ${col}`);
		} catch {
			/* already there */
		}
	}
	// Same pattern for sessions — older installs predate card_scheme /
	// payment_timestamp. Both feed the new finance columns on the cloud.
	// pass_id / free_reason (2026-07-29) make a zero-fee exit self-explaining: a
	// pass exit, a grace exit and a misconfigured RM0 rate plan all used to land
	// as payment_status='free' with nothing to tell them apart, so "why did this
	// car leave without paying?" was unanswerable after the fact.
	for (const col of ["card_scheme TEXT", "payment_timestamp TEXT", "pass_id TEXT", "free_reason TEXT"]) {
		try {
			db.exec(`ALTER TABLE sessions ADD COLUMN ${col}`);
		} catch {
			/* already there */
		}
	}
	// 2026-07-17: split the car's journey (sessions.status) out of the payment
	// outcome (now the transactions table; payment_status kept as a mirror). Add
	// the column then backfill it from existing rows — done ONCE (the ADD throws
	// on re-run, skipping the backfill so we never clobber live status values).
	try {
		db.exec(`ALTER TABLE sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'entered' CHECK (status IN ('entered','exited','manual_release'))`);
		db.exec(`UPDATE sessions SET status='manual_release' WHERE payment_status='manual_release'`);
		db.exec(`UPDATE sessions SET status='exited' WHERE exit_at IS NOT NULL AND payment_status<>'manual_release'`);
		db.exec(`UPDATE sessions SET status='entered' WHERE exit_at IS NULL`);
	} catch {
		/* already migrated */
	}
	// One-shot correction for the W4G default port. Earlier dev builds
	// defaulted tngPort to 8080 (vendor docs don't specify, my initial guess
	// was wrong) — the actual test rig at 192.168.1.105 serves on plain
	// HTTP port 80. Wipe the persisted 8080 so the new default kicks in;
	// anyone who explicitly chose a different port keeps their value.
	try {
		db.prepare(`DELETE FROM settings WHERE key='tngPort' AND value='8080'`).run();
	} catch {
		/* ignore */
	}
	// 2026-06-29: tngCallbackPort default moved 6002 → 80 because the W4G
	// device firmware hardcodes port 80 for its PayResult callback. Sites
	// running with the old 6002 default never receive PayResult; clear the
	// persisted value so the new default takes effect. We still bind both
	// 80 AND whatever the operator explicitly sets, so a deliberate 6002
	// doesn't break callbacks — it just means the device must also send
	// to 6002 (rare).
	try {
		db.prepare(`DELETE FROM settings WHERE key='tngCallbackPort' AND value='6002'`).run();
	} catch {
		/* ignore */
	}

	// Idempotent ALTERs for rate_policies — installs predating the 2026-06
	// schedule expansion lack the cutoff + policy-detail columns.
	for (const col of [
		"grace_exceeded_behavior TEXT",
		"cutoff_enabled INTEGER NOT NULL DEFAULT 0",
		"cutoff_time TEXT",
		"cutoff_behavior TEXT",
		// 2026-06-22: 3-tab Pricing redesign in qparking SaaS adds these.
		"policy_description TEXT",
		"new_day_fixed_fee_cents INTEGER",
		// 2026-07-08: parity with SaaS TariffCalculator — anchoring, flat-rate
		// combining, and once-per-entry first block.
		"rate_basis TEXT",
		"flat_multi_rate TEXT",
		"first_block_once_per_entry INTEGER NOT NULL DEFAULT 0",
		// 2026-07-09: true policy-level daily cap, distinct from the legacy
		// effective-rule mirror in daily_cap_cents. NULL = uncapped.
		"policy_daily_cap_cents INTEGER",
		// Site-wide default plan flag (cloud RatePolicy.is_site_default). Used as
		// the pricing fallback when a lane/session has no policy of its own.
		"is_site_default INTEGER NOT NULL DEFAULT 0",
	]) {
		try {
			db.exec(`ALTER TABLE rate_policies ADD COLUMN ${col}`);
		} catch {
			/* already there */
		}
	}
	// 2026-06-22: per-rule is_active flag — mirrors the Activations tab so
	// operators can see which rules are dimmed and the exit flow can skip
	// inactive rules even if they technically match the moment.
	try {
		db.exec(`ALTER TABLE tariff_rules ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1`);
	} catch {
		/* already there */
	}

	// 2026-07-22: persist the W4G PayResult fields that appear in the exit log —
	// the approval code and the raw pay-type — alongside the settlement summary.
	for (const col of [
		"appr_code TEXT",
		"pay_type INTEGER",
		// Payment device that rang up the charge (FK + display snapshot).
		"terminal_id INTEGER",
		"terminal_name TEXT",
	]) {
		try {
			db.exec(`ALTER TABLE transactions ADD COLUMN ${col}`);
		} catch {
			/* already there */
		}
	}
	// 2026-07-22: terminal_txn_id actually holds the W4G CardNo, so rename it to
	// card_number; and drop the STAN / balance / device-state columns we never
	// populate from the summary PayResult. All guarded (DROP/RENAME COLUMN need
	// SQLite ≥ 3.35) so fresh + already-migrated installs both no-op.
	try {
		db.exec("ALTER TABLE transactions RENAME COLUMN terminal_txn_id TO card_number");
	} catch {
		/* already renamed / fresh */
	}
	try {
		db.exec("ALTER TABLE transactions DROP COLUMN stan");
	} catch {
		/* absent */
	}
	try {
		db.exec("ALTER TABLE transactions DROP COLUMN balance_cents");
	} catch {
		/* absent */
	}
	try {
		db.exec("ALTER TABLE transactions DROP COLUMN device_state");
	} catch {
		/* absent */
	}
	// OrderId is the business key operators identify a charge by (one per
	// PayRequest attempt). Enforce uniqueness — SQLite lets multiple NULLs
	// coexist, so non-W4G rows (free / simulated exits with no orderId) are
	// unaffected. The autoincrement `id` stays the internal PK (sessions +
	// cloud sync reference it); this index just makes orderId a reliable key.
	try {
		db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_order ON transactions(order_id)`);
	} catch {
		/* ignore */
	}

	// 2026-07-22: stable, reinstall-proof device identity for the equipment
	// Push/Pull-to-cloud sync. Every camera/lane/terminal carries a durable
	// `external_id` (the cloud upsert key). Cross-device links are ALSO expressed
	// by external_id (camera→lane, lane→terminal) so they survive a restore that
	// renumbers local autoincrement ids. Numeric FKs stay the local source of
	// truth for gate logic; the *_external_id columns are the transport/restore
	// buffer that relinkDevices() resolves back to numeric FKs.
	for (const [table, col] of [
		["cameras", "external_id TEXT"],
		["cameras", "lane_external_id TEXT"],
		["lanes", "external_id TEXT"],
		["lanes", "terminal_external_id TEXT"],
		["terminals", "external_id TEXT"],
	] as const) {
		try {
			db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`);
		} catch {
			/* already there */
		}
	}
	// Backfill existing rows to their legacy `local-{id}` id — the cloud already
	// stores them keyed on `local-{id}`, so this preserves today's mappings.
	for (const table of ["cameras", "lanes", "terminals"] as const) {
		try {
			db.exec(`UPDATE ${table} SET external_id = 'local-' || id WHERE external_id IS NULL OR external_id = ''`);
		} catch {
			/* ignore */
		}
	}
	// Backfill link external_ids from the current numeric FKs (each referenced
	// row's external_id is now `local-{fk}` per the backfill above).
	try {
		db.exec(`UPDATE cameras SET lane_external_id = 'local-' || lane_id WHERE (lane_external_id IS NULL OR lane_external_id = '') AND lane_id IS NOT NULL`);
	} catch {
		/* ignore */
	}
	try {
		db.exec(
			`UPDATE lanes SET terminal_external_id = 'local-' || terminal_id WHERE (terminal_external_id IS NULL OR terminal_external_id = '') AND terminal_id IS NOT NULL`,
		);
	} catch {
		/* ignore */
	}
	// Uniqueness on external_id — ALTER can't add UNIQUE, so an index enforces it
	// for both fresh and migrated installs.
	try {
		db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cameras_external ON cameras(external_id)`);
	} catch {
		/* ignore */
	}
	try {
		db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_lanes_external ON lanes(external_id)`);
	} catch {
		/* ignore */
	}
	try {
		db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_terminals_external ON terminals(external_id)`);
	} catch {
		/* ignore */
	}

	// 2026-07-17: rebuild `sessions` when its payment_status CHECK is stale.
	// Very old installs created the table with a restrictive CHECK (e.g. it
	// predates 'manual_release' / 'declined' / 'cancelled'), and SQLite can't
	// ALTER a CHECK constraint — so a manual release or a declined exit hits
	// "CHECK constraint failed". We rebuild ONCE to the canonical schema. This
	// runs AFTER the column-adds above, so every column we copy already exists.
	const CANONICAL_PAY_CHECK = "payment_status IN ('pending','paid','declined','cancelled','free','manual_release')";
	try {
		const meta = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'").get() as { sql?: string } | undefined;
		if (meta?.sql && !meta.sql.includes(CANONICAL_PAY_CHECK)) {
			db.exec("BEGIN");
			db.exec(`CREATE TABLE sessions_rebuild (
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
        status TEXT NOT NULL DEFAULT 'entered'
          CHECK (status IN ('entered','exited','manual_release')),
        payment_status TEXT NOT NULL DEFAULT 'pending'
          CHECK (${CANONICAL_PAY_CHECK}),
        -- Must mirror EVERY column applySchema/the ALTERs above create. A column
        -- missing here is dropped for good on rebuild AND breaks recordExit for
        -- the rest of the boot (it UPDATEs pass_id/free_reason, which would no
        -- longer exist), so no exit could be recorded until the next restart.
        pass_id TEXT,
        free_reason TEXT,
        terminal_txn_id TEXT,
        card_scheme TEXT,
        payment_timestamp TEXT,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
			db.exec(`INSERT INTO sessions_rebuild
        (id, plate, entry_at, entry_lane_id, entry_camera_id, entry_image_path,
         exit_at, exit_lane_id, exit_camera_id, exit_image_path, duration_minutes, fee_cents,
         status, payment_status, pass_id, free_reason, terminal_txn_id, card_scheme, payment_timestamp, notes, created_at, updated_at)
        SELECT
         id, plate, entry_at, entry_lane_id, entry_camera_id, entry_image_path,
         exit_at, exit_lane_id, exit_camera_id, exit_image_path, duration_minutes, fee_cents,
         status,
         -- Sanitise any legacy payment_status value so it passes the new CHECK
         -- ('release' was an old spelling of 'manual_release'; map the rest to pending).
         CASE
           WHEN payment_status IN ('pending','paid','declined','cancelled','free','manual_release') THEN payment_status
           WHEN payment_status='release' THEN 'manual_release'
           ELSE 'pending'
         END,
         pass_id, free_reason,
         terminal_txn_id, card_scheme, payment_timestamp, notes, created_at, updated_at
        FROM sessions`);
			db.exec("DROP TABLE sessions");
			db.exec("ALTER TABLE sessions_rebuild RENAME TO sessions");
			db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_plate_open ON sessions (plate) WHERE exit_at IS NULL");
			db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_entry_at ON sessions (entry_at DESC)");
			db.exec("COMMIT");
			console.log("[db] rebuilt sessions table to refresh stale payment_status CHECK");
		}
	} catch (e) {
		try {
			db.exec("ROLLBACK");
		} catch {
			/* no active txn */
		}
		console.error("[db] sessions rebuild failed:", e);
	}

	// 2026-08-04: drop NOT NULL from activity_logs.event_key / .category — the
	// CREATE TABLE above only fixes FRESH installs (IF NOT EXISTS). Cloud rows
	// written by ActivityLogSupport::record() (web UI) leave both null, which
	// failed the mirror-down pull with "NOT NULL constraint failed:
	// activity_logs.event_key". SQLite has no ALTER COLUMN, so each is DROPped
	// and re-ADDed nullable — existing values in those two columns are lost,
	// which is fine since this table is a cloud mirror that gets wiped and
	// refilled on every sync anyway.
	try {
		const meta = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='activity_logs'").get() as { sql?: string } | undefined;
		if (meta?.sql?.includes("event_key VARCHAR(64) NOT NULL") || meta?.sql?.includes("category VARCHAR(32) NOT NULL")) {
			db.exec("BEGIN");
			if (meta.sql.includes("event_key VARCHAR(64) NOT NULL")) {
				db.exec("ALTER TABLE activity_logs DROP COLUMN event_key");
				db.exec("ALTER TABLE activity_logs ADD COLUMN event_key VARCHAR(64)");
			}
			if (meta.sql.includes("category VARCHAR(32) NOT NULL")) {
				db.exec("ALTER TABLE activity_logs DROP COLUMN category");
				db.exec("ALTER TABLE activity_logs ADD COLUMN category VARCHAR(32)");
			}
			db.exec("COMMIT");
			console.log("[db] activity_logs: event_key / category re-added as nullable");
		}
	} catch (e) {
		try {
			db.exec("ROLLBACK");
		} catch {
			/* no active txn */
		}
		console.error("[db] activity_logs nullable migration failed:", e);
	}
}

// ─── settings (key-value) ──────────────────────────────────────────────────

const DEFAULT_SETTINGS: AppSettings = {
	qparkingBaseUrl: "",
	qparkingApiKey: "",
	lprWebhookPort: 6001,
	exitGracePeriodSeconds: 90,
	faceappBaseUrl: "",
	faceappApiToken: "",
	faceappDeviceId: 0,
	entryCameraHandlesExit: false,
	faceGateEnabled: true,
	minimumChargeCents: 0,
	devMode: false,
	paymentController: "tng",
	tngEnabled: false,
	tngHost: "192.168.1.105",
	tngPort: 80,
	tngCallbackPort: 80,
	tngCallbackPorts: "80",
	tngTimeoutSeconds: 30,
	tngAutoRetrigger: true,
};

export function getSettings(): AppSettings {
	const db = getDb();
	const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
	const result: AppSettings = { ...DEFAULT_SETTINGS };
	for (const row of rows) {
		if (row.key in result) {
			const key = row.key as keyof AppSettings;
			// Booleans/numbers come back as strings — coerce by the default's type.
			const storedValue = row.value;
			const defaultType = typeof DEFAULT_SETTINGS[key];
			if (defaultType === "number") (result as any)[key] = Number(storedValue);
			else if (defaultType === "boolean") (result as any)[key] = storedValue === "true" || storedValue === "1";
			else (result as any)[key] = storedValue;
		}
	}
	return result;
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
	const db = getDb();
	const stmt = db.prepare("INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
	const tx = db.transaction(() => {
		for (const [key, value] of Object.entries(patch)) {
			if (value === undefined || value === null) continue;
			stmt.run(key, String(value));
		}
	});
	tx();
	return getSettings();
}

// ─── terminals ─────────────────────────────────────────────────────────────

function rowToTerminal(row: any): PaymentTerminal {
	return {
		id: row.id,
		externalId: row.external_id,
		name: row.name,
		host: row.host,
		port: row.port,
		timeoutSeconds: row.timeout_seconds,
		enabled: !!row.enabled,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export function listTerminals(): PaymentTerminal[] {
	return (getDb().prepare("SELECT * FROM terminals ORDER BY id").all() as any[]).map(rowToTerminal);
}

export function getTerminal(id: number): PaymentTerminal | null {
	const row = getDb().prepare("SELECT * FROM terminals WHERE id = ?").get(id) as any;
	return row ? rowToTerminal(row) : null;
}

export function upsertTerminal(
	terminal: Omit<PaymentTerminal, "id" | "externalId" | "createdAt" | "updatedAt"> & { id?: number; externalId?: string },
): PaymentTerminal {
	const db = getDb();
	if (terminal.id) {
		// external_id is immutable device identity — never rewritten on edit.
		db.prepare(`UPDATE terminals SET name=?, host=?, port=?, timeout_seconds=?, enabled=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
			terminal.name,
			terminal.host,
			terminal.port,
			terminal.timeoutSeconds,
			terminal.enabled ? 1 : 0,
			terminal.id,
		);
		return getTerminal(terminal.id)!;
	}
	const externalId = terminal.externalId ?? `dev-${randomUUID()}`;
	const info = db
		.prepare(`INSERT INTO terminals (external_id, name, host, port, timeout_seconds, enabled) VALUES (?,?,?,?,?,?)`)
		.run(externalId, terminal.name, terminal.host, terminal.port, terminal.timeoutSeconds, terminal.enabled ? 1 : 0);
	return getTerminal(Number(info.lastInsertRowid))!;
}

export function deleteTerminal(id: number) {
	getDb().prepare("DELETE FROM terminals WHERE id = ?").run(id);
}

export function logTerminal(terminalId: number, direction: "send" | "recv" | "error" | "info", message: string, payload?: unknown) {
	try {
		getDb()
			.prepare("INSERT INTO terminal_log (terminal_id, direction, message, payload) VALUES (?,?,?,?)")
			.run(terminalId, direction, message, payload === undefined ? null : JSON.stringify(payload));
	} catch {
		/* best-effort */
	}
}

// ─── cameras ───────────────────────────────────────────────────────────────

function rowToCamera(row: any): LprCamera {
	return {
		id: row.id,
		externalId: row.external_id,
		name: row.name,
		laneId: row.lane_id,
		direction: row.direction,
		webhookSecret: row.webhook_secret,
		host: row.host ?? null,
		deviceUser: row.device_user ?? null,
		devicePassword: row.device_password ?? null,
		devicePort: row.device_port ?? null,
		enabled: !!row.enabled,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export function listCameras(): LprCamera[] {
	return (getDb().prepare("SELECT * FROM cameras ORDER BY id").all() as any[]).map(rowToCamera);
}

export function getCamera(id: number): LprCamera | null {
	const row = getDb().prepare("SELECT * FROM cameras WHERE id = ?").get(id) as any;
	return row ? rowToCamera(row) : null;
}

export function upsertCamera(camera: Omit<LprCamera, "id" | "externalId" | "createdAt" | "updatedAt"> & { id?: number; externalId?: string }): LprCamera {
	const db = getDb();
	if (camera.id) {
		// external_id is immutable device identity — never rewritten on edit.
		db.prepare(
			`UPDATE cameras SET name=?, lane_id=?, direction=?, host=?, device_user=?, device_password=?, device_port=?, webhook_secret=?, enabled=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
		).run(
			camera.name,
			camera.laneId,
			camera.direction,
			camera.host,
			camera.deviceUser,
			camera.devicePassword,
			camera.devicePort,
			camera.webhookSecret,
			camera.enabled ? 1 : 0,
			camera.id,
		);
		return getCamera(camera.id)!;
	}
	const externalId = camera.externalId ?? `dev-${randomUUID()}`;
	const info = db
		.prepare(
			`INSERT INTO cameras (external_id, name, lane_id, direction, host, device_user, device_password, device_port, webhook_secret, enabled) VALUES (?,?,?,?,?,?,?,?,?,?)`,
		)
		.run(
			externalId,
			camera.name,
			camera.laneId,
			camera.direction,
			camera.host,
			camera.deviceUser,
			camera.devicePassword,
			camera.devicePort,
			camera.webhookSecret,
			camera.enabled ? 1 : 0,
		);
	return getCamera(Number(info.lastInsertRowid))!;
}

export function deleteCamera(id: number) {
	getDb().prepare("DELETE FROM cameras WHERE id = ?").run(id);
}

// ─── lanes ─────────────────────────────────────────────────────────────────

function rowToLane(row: any): ParkingLane {
	return {
		id: row.id,
		externalId: row.external_id,
		name: row.name,
		policyId: row.policy_id,
		terminalId: row.terminal_id,
		gateRelayAddress: row.gate_relay_address,
		enabled: !!row.enabled,
	};
}

export function listLanes(): ParkingLane[] {
	return (getDb().prepare("SELECT * FROM lanes ORDER BY id").all() as any[]).map(rowToLane);
}

export function getLane(id: number): ParkingLane | null {
	const row = getDb().prepare("SELECT * FROM lanes WHERE id = ?").get(id) as any;
	return row ? rowToLane(row) : null;
}

export function upsertLane(lane: Omit<ParkingLane, "id" | "externalId"> & { id?: number; externalId?: string }): ParkingLane {
	const db = getDb();
	if (lane.id) {
		// external_id is immutable device identity — never rewritten on edit.
		db.prepare(`UPDATE lanes SET name=?, policy_id=?, terminal_id=?, gate_relay_address=?, enabled=? WHERE id=?`).run(
			lane.name,
			lane.policyId,
			lane.terminalId,
			lane.gateRelayAddress,
			lane.enabled ? 1 : 0,
			lane.id,
		);
		return getLane(lane.id)!;
	}
	const externalId = lane.externalId ?? `dev-${randomUUID()}`;
	const info = db
		.prepare(`INSERT INTO lanes (external_id, name, policy_id, terminal_id, gate_relay_address, enabled) VALUES (?,?,?,?,?,?)`)
		.run(externalId, lane.name, lane.policyId, lane.terminalId, lane.gateRelayAddress, lane.enabled ? 1 : 0);
	return getLane(Number(info.lastInsertRowid))!;
}

export function deleteLane(id: number) {
	getDb().prepare("DELETE FROM lanes WHERE id = ?").run(id);
}

/**
 * Set exactly which cameras cover a lane. The lane owns the camera↔lane
 * wiring now (cameras no longer pick their own lane on the camera form):
 *   - every camera in `cameraIds` gets lane_id = laneId (moving it off any
 *     other lane it was previously on)
 *   - every camera previously on THIS lane but not in `cameraIds` is
 *     unassigned (lane_id = NULL)
 * Runs in one transaction so a half-applied reassignment can't leave a
 * camera pointing at a lane the operator just cleared.
 */
export function setLaneCameras(laneId: number, cameraIds: number[]): void {
	const d = getDb();
	const tx = d.transaction(() => {
		if (cameraIds.length > 0) {
			const placeholders = cameraIds.map(() => "?").join(",");
			// Detach cameras that used to be on this lane but were deselected.
			d.prepare(`UPDATE cameras SET lane_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE lane_id = ? AND id NOT IN (${placeholders})`).run(
				laneId,
				...cameraIds,
			);
			// Attach the selected set (also steals any that were on another lane).
			d.prepare(`UPDATE cameras SET lane_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`).run(laneId, ...cameraIds);
		} else {
			// Nothing selected → this lane covers no cameras.
			d.prepare(`UPDATE cameras SET lane_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE lane_id = ?`).run(laneId);
		}
	});
	tx();
}

/**
 * Derive a lane's direction from the cameras assigned to it — the camera is
 * the single source of truth (routing is keyed to the camera that saw the
 * plate, so direction physically belongs to the camera, not the lane).
 *   - all cameras entry-facing          → 'entry'
 *   - all exit-facing                   → 'exit'
 *   - any dual cam, OR both entry+exit  → 'dual'
 *   - no cameras yet                    → null (caller decides the fallback)
 * Used for the lane's displayed direction and the cloud equipment push.
 */
export function deriveLaneDirection(laneId: number): "entry" | "exit" | "dual" | null {
	const rows = getDb().prepare("SELECT DISTINCT direction FROM cameras WHERE lane_id = ?").all(laneId) as { direction: string }[];
	if (rows.length === 0) return null;
	const dirs = new Set(rows.map((r) => r.direction));
	if (dirs.has("dual") || (dirs.has("entry") && dirs.has("exit"))) return "dual";
	if (dirs.has("entry")) return "entry";
	if (dirs.has("exit")) return "exit";
	return null;
}

// ─── device cloud sync (Push / Pull to qparking) ────────────────────────────
// Numeric FKs (camera.lane_id, lane.terminal_id) stay the local source of truth
// for gate logic. The *_external_id columns are the durable, reinstall-proof
// link used to transport/restore that wiring. relinkDevices() re-derives the
// numeric FKs from the external-id links after a Pull, so a restore survives id
// renumbering and sync order doesn't matter (relink again once the other type
// arrives). It is ONLY safe to call right after a Pull, where the external-id
// links are freshly authoritative from the cloud.

export function relinkDevices(): void {
	const db = getDb();
	const tx = db.transaction(() => {
		// Unmatched / null links resolve to NULL and re-resolve on a later relink.
		db.exec(`UPDATE cameras SET lane_id = (SELECT l.id FROM lanes l WHERE l.external_id = cameras.lane_external_id)`);
		db.exec(`UPDATE lanes SET terminal_id = (SELECT t.id FROM terminals t WHERE t.external_id = lanes.terminal_external_id)`);
	});
	tx();
}

export interface CloudTerminalRow {
	externalId: string;
	name: string;
	host: string;
	port: number;
	enabled: boolean;
}
export interface CloudLaneRow {
	externalId: string;
	name: string;
	gateRelayAddress: string | null;
	enabled: boolean;
	terminalExternalId: string | null;
	policyId: string | null;
}
export interface CloudCameraRow {
	externalId: string;
	name: string;
	direction: "entry" | "exit" | "dual";
	host: string | null;
	enabled: boolean;
	laneExternalId: string | null;
}

/**
 * Reconcile a device table to match the cloud set exactly, keyed by external_id:
 * rows present in both are UPDATED in place (numeric id preserved, so existing
 * session references stay valid), cloud-only rows are INSERTED, and local rows
 * the cloud no longer has are DELETED. LAN-only secrets (webhook/terminal
 * secrets) and the terminal timeout are NOT on the cloud, so they're left as-is
 * on surviving rows and default on new ones. Caller runs relinkDevices() after.
 */
export function reconcileTerminalsFromCloud(rows: CloudTerminalRow[]): void {
	const db = getDb();
	const tx = db.transaction(() => {
		const keep = new Set(rows.map((r) => r.externalId));
		for (const local of db.prepare("SELECT id, external_id FROM terminals").all() as { id: number; external_id: string }[]) {
			if (!keep.has(local.external_id)) db.prepare("DELETE FROM terminals WHERE id = ?").run(local.id);
		}
		const upd = db.prepare("UPDATE terminals SET name=?, host=?, port=?, enabled=?, updated_at=CURRENT_TIMESTAMP WHERE external_id=?");
		const ins = db.prepare("INSERT INTO terminals (external_id, name, host, port, timeout_seconds, enabled) VALUES (?,?,?,?,?,?)");
		for (const r of rows) {
			if (upd.run(r.name, r.host, r.port, r.enabled ? 1 : 0, r.externalId).changes === 0) {
				ins.run(r.externalId, r.name, r.host, r.port, 30, r.enabled ? 1 : 0);
			}
		}
	});
	tx();
}

export function reconcileLanesFromCloud(rows: CloudLaneRow[]): void {
	const db = getDb();
	const tx = db.transaction(() => {
		const keep = new Set(rows.map((r) => r.externalId));
		for (const local of db.prepare("SELECT id, external_id FROM lanes").all() as { id: number; external_id: string }[]) {
			if (!keep.has(local.external_id)) db.prepare("DELETE FROM lanes WHERE id = ?").run(local.id);
		}
		// terminal_id left for relinkDevices(); direction is derived from cameras.
		const upd = db.prepare("UPDATE lanes SET name=?, policy_id=?, gate_relay_address=?, enabled=?, terminal_external_id=? WHERE external_id=?");
		const ins = db.prepare(
			"INSERT INTO lanes (external_id, name, policy_id, terminal_id, gate_relay_address, enabled, terminal_external_id) VALUES (?,?,?,NULL,?,?,?)",
		);
		for (const r of rows) {
			if (upd.run(r.name, r.policyId, r.gateRelayAddress, r.enabled ? 1 : 0, r.terminalExternalId, r.externalId).changes === 0) {
				ins.run(r.externalId, r.name, r.policyId, r.gateRelayAddress, r.enabled ? 1 : 0, r.terminalExternalId);
			}
		}
	});
	tx();
}

export function reconcileCamerasFromCloud(rows: CloudCameraRow[]): void {
	const db = getDb();
	const tx = db.transaction(() => {
		const keep = new Set(rows.map((r) => r.externalId));
		for (const local of db.prepare("SELECT id, external_id FROM cameras").all() as { id: number; external_id: string }[]) {
			if (!keep.has(local.external_id)) db.prepare("DELETE FROM cameras WHERE id = ?").run(local.id);
		}
		// lane_id left for relinkDevices(); LAN secrets/SDK creds are not on the
		// cloud, so surviving rows keep theirs and new rows get NULL.
		const upd = db.prepare("UPDATE cameras SET name=?, direction=?, host=?, enabled=?, lane_external_id=?, updated_at=CURRENT_TIMESTAMP WHERE external_id=?");
		const ins = db.prepare("INSERT INTO cameras (external_id, name, lane_id, direction, host, enabled, lane_external_id) VALUES (?,?,NULL,?,?,?,?)");
		for (const r of rows) {
			if (upd.run(r.name, r.direction, r.host, r.enabled ? 1 : 0, r.laneExternalId, r.externalId).changes === 0) {
				ins.run(r.externalId, r.name, r.direction, r.host, r.enabled ? 1 : 0, r.laneExternalId);
			}
		}
	});
	tx();
}

// ─── sessions ──────────────────────────────────────────────────────────────

function rowToSession(row: any): ParkingSession {
	return {
		id: row.id,
		plate: row.plate,
		entryAt: row.entry_at,
		entryLaneId: row.entry_lane_id,
		entryCameraId: row.entry_camera_id,
		entryImagePath: row.entry_image_path,
		exitAt: row.exit_at,
		exitLaneId: row.exit_lane_id,
		exitCameraId: row.exit_camera_id,
		exitImagePath: row.exit_image_path,
		durationMinutes: row.duration_minutes,
		feeCents: row.fee_cents,
		status: row.status,
		paymentStatus: row.payment_status,
		terminalTxnId: row.terminal_txn_id,
		cardScheme: row.card_scheme ?? null,
		paymentTimestamp: row.payment_timestamp ?? null,
		passId: row.pass_id ?? null,
		freeReason: row.free_reason ?? null,
		notes: row.notes,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/** Find the OPEN session for a plate (entry recorded, exit not yet). Used by
 *  the exit flow to look up entry time + fee calculation source. */
export function findOpenSessionByPlate(plate: string): ParkingSession | null {
	const row = getDb().prepare("SELECT * FROM sessions WHERE plate = ? AND exit_at IS NULL ORDER BY entry_at DESC LIMIT 1").get(plate) as any;
	return row ? rowToSession(row) : null;
}

/**
 * The most recently CLOSED session for a plate (latest exit_at). Backs the
 * exit-grace guard in parking-flow: it distinguishes an ANPR camera firing the
 * same plate two or three times on one pass — where the extra events arrive
 * seconds after the exit was recorded — from a genuine new arrival.
 */
export function findLastClosedSessionByPlate(plate: string): ParkingSession | null {
	const row = getDb().prepare("SELECT * FROM sessions WHERE plate = ? AND exit_at IS NOT NULL ORDER BY exit_at DESC LIMIT 1").get(plate) as any;
	return row ? rowToSession(row) : null;
}

export function createEntrySession(plate: string, laneId: number | null, cameraId: number | null, imagePath: string | null): ParkingSession {
	const db = getDb();
	// Store entry_at as an explicit UTC ISO string (…Z), NOT SQLite's
	// CURRENT_TIMESTAMP: the latter is UTC but carries no zone marker, so JS
	// Date.parse mis-reads it as LOCAL time — an 8h skew vs exit_at (which uses
	// toISOString). Keeping both ends in the same UTC-with-Z format is what
	// makes the duration + fee math correct.
	const info = db
		.prepare(`INSERT INTO sessions (plate, entry_at, entry_lane_id, entry_camera_id, entry_image_path) VALUES (?,?,?,?,?)`)
		.run(plate, new Date().toISOString(), laneId, cameraId, imagePath);
	return getSessionById(Number(info.lastInsertRowid))!;
}

export function getSessionById(id: number): ParkingSession | null {
	const row = getDb().prepare("SELECT * FROM sessions WHERE id = ?").get(id) as any;
	return row ? rowToSession(row) : null;
}

/**
 * Restore OPEN sessions from the cloud's parking records — cars the cloud says
 * are still inside this site. This is the recovery path for a rebound /
 * reinstalled / wiped box: without it, a car that entered before the wipe has
 * no open session and the barrier reports exit-without-entry.
 *
 * Import rules (per row, newest entry first):
 *  - a plate with an OPEN local session is skipped — the box's own record wins;
 *  - a plate whose local sessions already include this stay (any session with
 *    entry_at within ±5 minutes of the cloud's entry time, open OR closed) is
 *    skipped — this is the guard against a STALE cloud record re-opening a stay
 *    the box just closed while its exit push is still in the outbound queue.
 *    That guard is also why this import runs on manual "Sync now" only, never
 *    the 60s tick;
 *  - everything else becomes a normal open session (no lane/camera/image — the
 *    exit flow doesn't need them; pricing falls back exit-lane → site default),
 *    stamped in notes as restored so the operator can tell it apart.
 * Nothing is enqueued back to the cloud — these rows came FROM it.
 */
export function importOpenSessionsFromCloud(rows: Array<{ plate: string; entryAt: string }>): { imported: number; skipped: number } {
	const db = getDb();
	const TOLERANCE_MS = 5 * 60_000;
	let imported = 0;
	let skipped = 0;

	const insert = db.prepare(
		`INSERT INTO sessions (plate, entry_at, entry_lane_id, entry_camera_id, entry_image_path, notes)
     VALUES (?,?,NULL,NULL,NULL,?)`,
	);
	const tx = db.transaction(() => {
		// Newest first, so a duplicate-plate anomaly resolves to the latest stay
		// (the older row then skips on the open-session guard).
		const sorted = [...rows].sort((a, b) => Date.parse(b.entryAt) - Date.parse(a.entryAt));
		for (const row of sorted) {
			const plate = canonicalPlate(row.plate);
			const entryMs = Date.parse(row.entryAt);
			if (!plate || Number.isNaN(entryMs)) {
				skipped++;
				continue;
			}

			const open = db.prepare("SELECT 1 FROM sessions WHERE plate = ? AND exit_at IS NULL LIMIT 1").get(plate);
			if (open) {
				skipped++;
				continue;
			}

			const known = (db.prepare("SELECT entry_at FROM sessions WHERE plate = ?").all(plate) as { entry_at: string }[]).some((s) => {
				const ms = Date.parse(s.entry_at);
				return !Number.isNaN(ms) && Math.abs(ms - entryMs) <= TOLERANCE_MS;
			});
			if (known) {
				skipped++;
				continue;
			}

			insert.run(plate, new Date(entryMs).toISOString(), "Restored from cloud (Sync now) — entered before this box was reset/rebound");
			imported++;
		}
	});
	tx();
	return { imported, skipped };
}

export function recordExit(
	sessionId: number,
	patch: {
		exitAt: string;
		exitLaneId: number | null;
		exitCameraId: number | null;
		exitImagePath: string | null;
		durationMinutes: number;
		feeCents: number;
		/** Journey status — an exit is always 'exited'. */
		status?: ParkingSession["status"];
		/** Mirror of the payment outcome for the operator UI. */
		paymentStatus: ParkingSession["paymentStatus"];
		terminalTxnId: string | null;
		cardScheme?: string | null;
		paymentTimestamp?: string | null;
		/** The season_passes row that waived this charge, when the exit was free
		 *  because of a pass. */
		passId?: string | null;
		/** Which rule made this exit free — 'pass-<type>' | 'within-grace' |
		 *  'rate-zero' | 'no-policy'. */
		freeReason?: string | null;
	},
): ParkingSession | null {
	getDb()
		.prepare(
			`UPDATE sessions SET exit_at=?, exit_lane_id=?, exit_camera_id=?, exit_image_path=?, duration_minutes=?, fee_cents=?, status=?, payment_status=?, terminal_txn_id=?, card_scheme=?, payment_timestamp=?, pass_id=?, free_reason=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
		)
		.run(
			patch.exitAt,
			patch.exitLaneId,
			patch.exitCameraId,
			patch.exitImagePath,
			patch.durationMinutes,
			patch.feeCents,
			patch.status ?? "exited",
			patch.paymentStatus,
			patch.terminalTxnId,
			patch.cardScheme ?? null,
			patch.paymentTimestamp ?? null,
			patch.passId ?? null,
			patch.freeReason ?? null,
			sessionId,
		);
	return getSessionById(sessionId);
}

/**
 * Close an OPEN session without a payment, at the operator's discretion.
 *
 * The `exit_at IS NULL` guard is load-bearing: a release can land moments after a
 * successful payment already closed the session (the driver taps just as staff
 * press the button), and without it a genuinely PAID record was rewritten to
 * manual_release — real revenue then read as waived. An already-closed session is
 * left exactly as it is; the caller still opens the barrier, which is what the
 * operator actually wanted. `changed` reports which happened.
 */
export function manualReleaseSession(sessionId: number, reason: string): { session: ParkingSession | null; changed: boolean } {
	const now = new Date().toISOString();
	const info = getDb()
		.prepare(
			`UPDATE sessions SET exit_at=?, status='manual_release', payment_status='manual_release', notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND exit_at IS NULL`,
		)
		.run(now, reason, sessionId);
	return { session: getSessionById(sessionId), changed: info.changes > 0 };
}

/**
 * Update editable fields on a session — used by the admin "edit session"
 * modal to correct entry/exit times when the LPR misread or the operator
 * needs to verify the fee calculation. Pass only the fields you want to
 * change; everything else stays put. `durationMinutes` / `feeCents` are
 * NOT pulled from the patch — they're always recomputed from the new
 * entry/exit pair using the supplied policy rate (passed by the caller
 * so this stays a pure data update; the caller decides the rate).
 */
export function updateSessionFields(
	sessionId: number,
	patch: {
		plate?: string;
		entryAt?: string;
		exitAt?: string | null;
		feeCents?: number;
		durationMinutes?: number;
		status?: ParkingSession["status"];
		paymentStatus?: ParkingSession["paymentStatus"];
		notes?: string;
	},
): ParkingSession | null {
	const sets: string[] = [];
	const vals: any[] = [];
	if (patch.plate !== undefined) {
		sets.push("plate = ?");
		vals.push(patch.plate);
	}
	if (patch.entryAt !== undefined) {
		sets.push("entry_at = ?");
		vals.push(patch.entryAt);
	}
	if (patch.exitAt !== undefined) {
		sets.push("exit_at = ?");
		vals.push(patch.exitAt);
	}
	if (patch.feeCents !== undefined) {
		sets.push("fee_cents = ?");
		vals.push(patch.feeCents);
	}
	if (patch.durationMinutes !== undefined) {
		sets.push("duration_minutes = ?");
		vals.push(patch.durationMinutes);
	}
	if (patch.status !== undefined) {
		sets.push("status = ?");
		vals.push(patch.status);
	}
	if (patch.paymentStatus !== undefined) {
		sets.push("payment_status = ?");
		vals.push(patch.paymentStatus);
	}
	if (patch.notes !== undefined) {
		sets.push("notes = ?");
		vals.push(patch.notes);
	}
	if (sets.length === 0) return getSessionById(sessionId);
	sets.push("updated_at = CURRENT_TIMESTAMP");
	vals.push(sessionId);
	getDb()
		.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`)
		.run(...vals);
	return getSessionById(sessionId);
}

export function listOpenSessions(): ParkingSession[] {
	return (getDb().prepare("SELECT * FROM sessions WHERE exit_at IS NULL ORDER BY entry_at DESC").all() as any[]).map(rowToSession);
}

export function listRecentSessions(limit: number): ParkingSession[] {
	return (getDb().prepare("SELECT * FROM sessions ORDER BY entry_at DESC LIMIT ?").all(limit) as any[]).map(rowToSession);
}

export interface SessionFilters {
	plateSearch?: string | null;
	entryFrom?: string | null;
	entryTo?: string | null;
	exitFrom?: string | null;
	exitTo?: string | null;
	/** Exact journey-status match (entered / exited / manual_release). */
	status?: string | null;
	/** Exact payment-status match (paid / pending / declined / …). */
	paymentStatus?: string | null;
}

function buildSessionFilters(filters: SessionFilters): { clauses: string[]; args: any[] } {
	const clauses: string[] = [];
	const args: any[] = [];
	if (filters.plateSearch && filters.plateSearch.trim()) {
		clauses.push("UPPER(plate) LIKE ?");
		args.push(`%${filters.plateSearch.trim().toUpperCase()}%`);
	}
	if (filters.status) {
		clauses.push("status = ?");
		args.push(filters.status);
	}
	if (filters.paymentStatus) {
		clauses.push("payment_status = ?");
		args.push(filters.paymentStatus);
	}
	if (filters.entryFrom) {
		clauses.push("entry_at >= ?");
		args.push(filters.entryFrom);
	}
	if (filters.entryTo) {
		clauses.push("entry_at <= ?");
		args.push(filters.entryTo);
	}
	if (filters.exitFrom) {
		clauses.push("exit_at >= ?");
		args.push(filters.exitFrom);
	}
	if (filters.exitTo) {
		clauses.push("exit_at <= ?");
		args.push(filters.exitTo);
	}
	return { clauses, args };
}

export function countSessions(filters: SessionFilters = {}): { open: number; total: number } {
	const db = getDb();
	const { clauses, args } = buildSessionFilters(filters);
	const openClauses = ["exit_at IS NULL", ...clauses];
	const openSql = `SELECT COUNT(*) as c FROM sessions WHERE ${openClauses.join(" AND ")}`;
	const totalSql = clauses.length > 0 ? `SELECT COUNT(*) as c FROM sessions WHERE ${clauses.join(" AND ")}` : "SELECT COUNT(*) as c FROM sessions";
	const open = db.prepare(openSql).get(...args) as any;
	const total = db.prepare(totalSql).get(...args) as any;
	return { open: open.c as number, total: total.c as number };
}

/**
 * Paginated session list. Fuzzy plate search + optional entry/exit date
 * ranges. Used for reconciling LPR mis-reads: filter by the wrong-plate
 * time window, then the correct entry surfaces even if the plate text
 * differs by a character.
 */
export function listSessionsPage(
	opts: SessionFilters & {
		tab: "open" | "recent";
		limit: number;
		offset: number;
	},
): ParkingSession[] {
	const db = getDb();
	const { clauses, args } = buildSessionFilters(opts);
	const whereClauses: string[] = [];
	if (opts.tab === "open") whereClauses.push("exit_at IS NULL");
	whereClauses.push(...clauses);
	const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
	const sql = `SELECT * FROM sessions ${where} ORDER BY entry_at DESC LIMIT ? OFFSET ?`;
	return (db.prepare(sql).all(...args, opts.limit, opts.offset) as any[]).map(rowToSession);
}

export function deleteSession(sessionId: number): boolean {
	const info = getDb().prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
	return info.changes > 0;
}

// ─── transactions ────────────────────────────────────────────────────────────

function rowToTransaction(row: any): Transaction {
	return {
		id: row.id,
		localTransactionId: row.local_transaction_id,
		sessionId: row.session_id,
		status: row.status,
		amountCents: row.amount_cents,
		paymentMethod: row.payment_method ?? null,
		cardNumber: row.card_number ?? null,
		terminalId: row.terminal_id ?? null,
		terminalName: row.terminal_name ?? null,
		orderId: row.order_id ?? null,
		paymentTimestamp: row.payment_timestamp ?? null,
		apprCode: row.appr_code ?? null,
		payType: row.pay_type ?? null,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/** Open a new payment attempt for a session. Generates the idempotency key. */
export function createTransaction(patch: {
	sessionId: number;
	status?: TransactionStatus;
	amountCents: number;
	paymentMethod?: string | null;
	cardNumber?: string | null;
	terminalId?: number | null;
	terminalName?: string | null;
	orderId?: string | null;
	paymentTimestamp?: string | null;
}): Transaction {
	const localTransactionId = randomUUID();
	const info = getDb()
		.prepare(
			`INSERT INTO transactions (local_transaction_id, session_id, status, amount_cents, payment_method, card_number, terminal_id, terminal_name, order_id, payment_timestamp)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
		)
		.run(
			localTransactionId,
			patch.sessionId,
			patch.status ?? "pending",
			patch.amountCents,
			patch.paymentMethod ?? null,
			patch.cardNumber ?? null,
			patch.terminalId ?? null,
			patch.terminalName ?? null,
			patch.orderId ?? null,
			patch.paymentTimestamp ?? null,
		);
	return getTransactionById(Number(info.lastInsertRowid))!;
}

/** Update a payment attempt's outcome. Only supplied fields change. */
export function updateTransaction(
	id: number,
	patch: {
		status?: TransactionStatus;
		amountCents?: number;
		paymentMethod?: string | null;
		cardNumber?: string | null;
		paymentTimestamp?: string | null;
		apprCode?: string | null;
		payType?: number | null;
	},
): Transaction | null {
	const sets: string[] = [];
	const vals: any[] = [];
	if (patch.status !== undefined) {
		sets.push("status = ?");
		vals.push(patch.status);
	}
	if (patch.amountCents !== undefined) {
		sets.push("amount_cents = ?");
		vals.push(patch.amountCents);
	}
	if (patch.paymentMethod !== undefined) {
		sets.push("payment_method = ?");
		vals.push(patch.paymentMethod);
	}
	if (patch.cardNumber !== undefined) {
		sets.push("card_number = ?");
		vals.push(patch.cardNumber);
	}
	if (patch.paymentTimestamp !== undefined) {
		sets.push("payment_timestamp = ?");
		vals.push(patch.paymentTimestamp);
	}
	if (patch.apprCode !== undefined) {
		sets.push("appr_code = ?");
		vals.push(patch.apprCode);
	}
	if (patch.payType !== undefined) {
		sets.push("pay_type = ?");
		vals.push(patch.payType);
	}
	if (sets.length === 0) return getTransactionById(id);
	sets.push("updated_at = CURRENT_TIMESTAMP");
	vals.push(id);
	getDb()
		.prepare(`UPDATE transactions SET ${sets.join(", ")} WHERE id = ?`)
		.run(...vals);
	return getTransactionById(id);
}

export function getTransactionById(id: number): Transaction | null {
	const row = getDb().prepare("SELECT * FROM transactions WHERE id = ?").get(id) as any;
	return row ? rowToTransaction(row) : null;
}

/** The most recent still-open (pending) attempt for a session, if any. Used to
 *  void an in-flight charge when a session is manually released. */
export function getOpenTransactionForSession(sessionId: number): Transaction | null {
	const row = getDb().prepare(`SELECT * FROM transactions WHERE session_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`).get(sessionId) as any;
	return row ? rowToTransaction(row) : null;
}

/** A transaction row enriched with the parent session's plate + lane, for the
 *  operator-facing Transactions page (which lists EVERY payment attempt across
 *  all sessions, newest first). */
export interface TransactionPageRow extends Transaction {
	plate: string | null;
	sessionStatus: string | null;
	entryLaneId: number | null;
	exitLaneId: number | null;
}

/** Build the shared WHERE for the transactions list + count (kept in one place
 *  so the page total always matches the rows). `search` is a contains-match on
 *  orderId / plate / card number; `status` is an exact transaction-status match. */
interface TransactionFilterOpts {
	search?: string | null;
	status?: string | null;
	/** Inclusive lower bound — a UTC ISO instant (the renderer maps a GMT+8 day
	 *  to its UTC range). Filters on the row's effective time: payment_timestamp
	 *  when present, else created_at. */
	dateFrom?: string | null;
	/** Exclusive upper bound — a UTC ISO instant. */
	dateTo?: string | null;
}

function transactionFilter(opts: TransactionFilterOpts): { sql: string; params: any[] } {
	const where: string[] = [];
	const params: any[] = [];
	if (opts.status) {
		where.push("t.status = ?");
		params.push(opts.status);
	}
	if (opts.search) {
		where.push("(t.order_id LIKE ? OR s.plate LIKE ? OR t.card_number LIKE ?)");
		const like = `%${opts.search}%`;
		params.push(like, like, like);
	}
	// Normalise the mixed timestamp shapes (ISO `…Z` on payment_timestamp,
	// "YYYY-MM-DD HH:MM:SS" on created_at) via datetime() so both bound and
	// column compare in the same UTC format.
	if (opts.dateFrom) {
		where.push("datetime(COALESCE(t.payment_timestamp, t.created_at)) >= datetime(?)");
		params.push(opts.dateFrom);
	}
	if (opts.dateTo) {
		where.push("datetime(COALESCE(t.payment_timestamp, t.created_at)) < datetime(?)");
		params.push(opts.dateTo);
	}
	return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

export function listTransactionsPage(
	opts: TransactionFilterOpts & {
		limit: number;
		offset: number;
	},
): TransactionPageRow[] {
	const { sql, params } = transactionFilter(opts);
	const rows = getDb()
		.prepare(
			`SELECT t.*, s.plate AS s_plate, s.status AS s_status,
            s.entry_lane_id AS s_entry_lane, s.exit_lane_id AS s_exit_lane
       FROM transactions t
       LEFT JOIN sessions s ON s.id = t.session_id
       ${sql}
       ORDER BY t.id DESC
       LIMIT ? OFFSET ?`,
		)
		.all(...params, opts.limit, opts.offset) as any[];
	return rows.map((r) => ({
		...rowToTransaction(r),
		plate: r.s_plate ?? null,
		sessionStatus: r.s_status ?? null,
		entryLaneId: r.s_entry_lane ?? null,
		exitLaneId: r.s_exit_lane ?? null,
	}));
}

export function countTransactions(opts: TransactionFilterOpts): number {
	const { sql, params } = transactionFilter(opts);
	const row = getDb()
		.prepare(`SELECT COUNT(*) AS n FROM transactions t LEFT JOIN sessions s ON s.id = t.session_id ${sql}`)
		.get(...params) as { n: number };
	return row.n;
}

// ─── sync queue ────────────────────────────────────────────────────────────
// Persistent retry queue for outbound pushes to qparking SaaS. Every state
// change to a session (entry / update / exit / delete) drops a row here;
// the cloud-queue module drains the queue with exponential backoff. A
// process restart finds these rows still pending — nothing is lost.

// Row shape + op union live in shared/db-models.ts (single source of truth);
// re-exported so `from './db'` imports keep working.
export type { SyncOp, SyncQueueRow };

function rowToSync(row: any): SyncQueueRow {
	return {
		id: row.id,
		op: row.op as SyncOp,
		payload: JSON.parse(row.payload),
		attempts: row.attempts,
		status: row.status,
		lastError: row.last_error,
		nextAttemptAt: row.next_attempt_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export function enqueueSync(op: SyncOp, payload: Record<string, unknown>): number {
	const info = getDb().prepare(`INSERT INTO sync_queue (op, payload) VALUES (?, ?)`).run(op, JSON.stringify(payload));
	return Number(info.lastInsertRowid);
}

export function listDueSync(now = new Date().toISOString(), limit = 25): SyncQueueRow[] {
	return (getDb().prepare(`SELECT * FROM sync_queue WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id ASC LIMIT ?`).all(now, limit) as any[]).map(
		rowToSync,
	);
}

export function markSyncOk(id: number): void {
	getDb().prepare(`DELETE FROM sync_queue WHERE id = ?`).run(id);
}

export function markSyncRetry(id: number, error: string, delayMs: number): void {
	const next = new Date(Date.now() + delayMs).toISOString();
	getDb()
		.prepare(`UPDATE sync_queue SET attempts = attempts + 1, last_error = ?, next_attempt_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
		.run(error, next, id);
}

export function markSyncFailed(id: number, error: string): void {
	getDb()
		.prepare(`UPDATE sync_queue SET status = 'failed', last_error = ?, attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
		.run(error, id);
}

export function syncQueueStats(): { pending: number; failed: number; oldestPending: string | null } {
	const db = getDb();
	const pending = (db.prepare(`SELECT COUNT(*) as c FROM sync_queue WHERE status = 'pending'`).get() as any).c;
	const failed = (db.prepare(`SELECT COUNT(*) as c FROM sync_queue WHERE status = 'failed'`).get() as any).c;
	const oldest = db.prepare(`SELECT created_at FROM sync_queue WHERE status = 'pending' ORDER BY id ASC LIMIT 1`).get() as any;
	return { pending, failed, oldestPending: oldest?.created_at ?? null };
}

/**
 * The queue rows worth showing the operator: anything that has failed at least
 * once (a recorded last_error) or exhausted its retries. Rows that pushed
 * cleanly are deleted, and a brand-new pending row (attempts=0, no error) is
 * normal and omitted — so this list is exactly the "why isn't this syncing?"
 * set. `ref` is pulled from the payload (plate / transaction id) so the row is
 * identifiable at a glance. Failed rows sort first, then most-recently-touched.
 */
export function listSyncQueueIssues(limit = 20): SyncIssue[] {
	const rows = getDb()
		.prepare(
			`SELECT * FROM sync_queue WHERE last_error IS NOT NULL OR status = 'failed'
     ORDER BY (status = 'failed') DESC, updated_at DESC LIMIT ?`,
		)
		.all(limit) as any[];
	return rows.map((row): SyncIssue => {
		let ref: string | null = null;
		try {
			const p = JSON.parse(row.payload);
			ref = p.plate_number ?? p.local_transaction_id ?? null;
		} catch {
			/* payload not JSON — leave ref null */
		}
		return {
			id: row.id,
			op: row.op,
			ref,
			status: row.status,
			attempts: row.attempts,
			lastError: row.last_error,
			nextAttemptAt: row.next_attempt_at,
		};
	});
}

export function retryAllFailedSync(): number {
	return getDb()
		.prepare(
			`UPDATE sync_queue SET status = 'pending', attempts = 0, next_attempt_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE status = 'failed'`,
		)
		.run().changes;
}

// ─── policies ────────────────────────────────────────────────────────────────

function rowToRatePolicy(row: any, rules: TariffRule[] = []): RatePolicy {
	return {
		policyId: row.policy_id,
		policyName: row.policy_name,
		freeMinutes: row.free_minutes,
		firstBlockCents: row.first_block_cents,
		perBlockCents: row.per_block_cents,
		blockMinutes: row.block_minutes,
		dailyCapCents: row.daily_cap_cents,
		currency: row.currency,
		fetchedAt: row.fetched_at,
		policyDescription: row.policy_description ?? null,
		graceExceededBehavior: (row.grace_exceeded_behavior ?? null) as any,
		cutoffEnabled: !!row.cutoff_enabled,
		cutoffTime: row.cutoff_time ?? null,
		cutoffBehavior: row.cutoff_behavior ?? null,
		newDayFixedFeeCents: row.new_day_fixed_fee_cents ?? null,
		rateBasis: (row.rate_basis ?? null) as any,
		flatMultiRate: (row.flat_multi_rate ?? null) as any,
		firstBlockOncePerEntry: !!row.first_block_once_per_entry,
		policyDailyCapCents: row.policy_daily_cap_cents ?? null,
		isSiteDefault: !!row.is_site_default,
		rules,
	};
}

function rowToTariffRule(row: any): TariffRule {
	return {
		ruleId: row.rule_id,
		name: row.name,
		priority: row.priority,
		daysOfWeek: row.days_of_week ? JSON.parse(row.days_of_week) : null,
		timeFrom: row.time_from,
		timeTo: row.time_to,
		validFrom: row.valid_from ?? null,
		validTo: row.valid_to ?? null,
		ruleType: row.rule_type as "flat_rate" | "block_hourly",
		flatAmountCents: row.flat_amount_cents,
		firstBlockAmountCents: row.first_block_amount_cents,
		firstBlockMinutes: row.first_block_minutes,
		subsequentBlockAmountCents: row.subsequent_block_amount_cents,
		subsequentBlockMinutes: row.subsequent_block_minutes,
		dailyCapCents: row.daily_cap_cents,
		isOvernight: !!row.is_overnight,
		// Default true on legacy rows (DB column has DEFAULT 1) so an
		// unmigrated install doesn't suddenly treat every rule as inactive.
		isActive: row.is_active === 0 ? false : true,
	};
}

function listTariffRulesForRatePolicy(policyId: string): TariffRule[] {
	return (getDb().prepare("SELECT * FROM tariff_rules WHERE policy_id = ? ORDER BY priority DESC, rule_id ASC").all(policyId) as any[]).map(rowToTariffRule);
}

export function listRatePolicies(): RatePolicy[] {
	const rows = getDb().prepare("SELECT * FROM rate_policies ORDER BY policy_name").all() as any[];
	return rows.map((row) => rowToRatePolicy(row, listTariffRulesForRatePolicy(row.policy_id)));
}

export function getRatePolicy(id: string): RatePolicy | null {
	const row = getDb().prepare("SELECT * FROM rate_policies WHERE policy_id = ?").get(id) as any;
	if (!row) return null;
	return rowToRatePolicy(row, listTariffRulesForRatePolicy(id));
}

/** Map a raw `sites` row (snake_case) to the camelCase Site shape. */
function rowToSite(row: any): Site {
	return {
		id: row.id,
		companyId: row.company_id ?? null,
		name: row.name,
		address: row.address ?? null,
		totalSpaces: row.total_spaces,
		occupiedSpaces: row.occupied_spaces,
		revenueToday: row.revenue_today,
		status: row.status,
		alarmCount: row.alarm_count,
		contactPerson: row.contact_person ?? null,
		telephone: row.telephone ?? null,
		fax: row.fax ?? null,
		country: row.country ?? null,
		email: row.email ?? null,
		parkingSiteType: row.parking_site_type ?? null,
		logoUrl: row.logo_url ?? null,
	};
}

export function getSite(id: string): Site | null {
	const row = getDb().prepare("SELECT * FROM sites WHERE id = ?").get(id) as any;
	if (!row) return null;
	return rowToSite(row);
}

/** The cached site for this install (one site per local server). */
export function getCurrentSite(): Site | null {
	const row = getDb().prepare("SELECT * FROM sites ORDER BY updated_at DESC LIMIT 1").get() as Site;
	return row ? rowToSite(row) : null;
}

/**
 * Idempotent upsert of the site row mirrored from GET /local-server/site.
 * The API payload omits local_server_api_key and timestamps, so the key
 * column keeps whatever value it already has and updated_at is stamped here.
 */
export function upsertSite(site: Site): Site {
	getDb()
		.prepare(
			`INSERT INTO sites (
      id, company_id, name, address, total_spaces, occupied_spaces,
      revenue_today, status, alarm_count, contact_person, telephone, fax,
      country, email, parking_site_type, logo_url
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      company_id=excluded.company_id,
      name=excluded.name,
      address=excluded.address,
      total_spaces=excluded.total_spaces,
      occupied_spaces=excluded.occupied_spaces,
      revenue_today=excluded.revenue_today,
      status=excluded.status,
      alarm_count=excluded.alarm_count,
      contact_person=excluded.contact_person,
      telephone=excluded.telephone,
      fax=excluded.fax,
      country=excluded.country,
      email=excluded.email,
      parking_site_type=excluded.parking_site_type,
      logo_url=excluded.logo_url,
      updated_at=CURRENT_TIMESTAMP`,
		)
		.run(
			site.id,
			site.companyId,
			site.name,
			site.address,
			site.totalSpaces,
			site.occupiedSpaces,
			site.revenueToday,
			site.status,
			site.alarmCount,
			site.contactPerson,
			site.telephone,
			site.fax,
			site.country,
			site.email,
			site.parkingSiteType,
			site.logoUrl,
		);
	return getSite(site.id)!;
}

// ─── site binding (which cloud site this install is provisioned for) ─────────
// The box is bound to exactly ONE site (see "one site per install" throughout).
// The bound site id is stored as a raw `settings` row — deliberately NOT part of
// AppSettings, so it never surfaces in the Settings form or a settings patch —
// and is the source of truth for "which site does this box belong to". Pointing
// the API key at a different site is a re-provision (see the site:rebind IPC),
// which clears the old site's local data and re-binds.

const BOUND_SITE_KEY = "boundSiteId";

/** The cloud site id this install is provisioned for, or null if never bound. */
export function getBoundSiteId(): string | null {
	const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(BOUND_SITE_KEY) as { value: string } | undefined;
	return row?.value ?? null;
}

/** Record which cloud site this install is bound to. */
export function setBoundSiteId(siteId: string): void {
	getDb().prepare("INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(BOUND_SITE_KEY, siteId);
}

/** Stamp the API key that owns a site row (the UNIQUE local_server_api_key
 *  column the SiteResource payload can't populate itself). */
export function bindSiteApiKey(siteId: string, apiKey: string): void {
	getDb().prepare("UPDATE sites SET local_server_api_key = ? WHERE id = ?").run(apiKey, siteId);
}

/** True when this install is bound to a site AND that's the site the currently
 *  cached credentials actually resolve to. Outbound pushes (equipment mirror,
 *  session queue drain) gate on this so nothing leaks to a site the box has not
 *  been provisioned for — e.g. in the window after the API key is changed but
 *  before the operator confirms the re-provision. */
export function isBoundToCurrentSite(): boolean {
	const bound = getBoundSiteId();
	if (!bound) return false;
	const current = getCurrentSite();
	return !!current && current.id === bound;
}

/**
 * Wipe this install's site-specific data so the box can be re-provisioned to a
 * different cloud site. Always clears operational data (sessions, the payment
 * ledger, terminal logs, the outbound sync queue) and the cloud mirrors
 * (policies + rules, passes, spaces, activity logs, cached site rows). Physical
 * equipment (cameras / lanes / terminals) is cleared only when the operator
 * opts in, since the same hardware box may serve the new site. The site binding
 * is re-established by the caller after the first sync against the new key.
 */
export function resetLocalDataForRebind(opts: { wipeEquipment: boolean }): void {
	const db = getDb();
	const tx = db.transaction(() => {
		// Operational / locally-owned data belonging to the old site.
		db.exec("DELETE FROM transactions");
		db.exec("DELETE FROM sessions");
		db.exec("DELETE FROM terminal_log");
		db.exec("DELETE FROM sync_queue");
		// Cloud mirrors — re-pulled fresh for the new site on the next sync.
		db.exec("DELETE FROM tariff_rules");
		db.exec("DELETE FROM rate_policies");
		db.exec("DELETE FROM season_passes");
		db.exec("DELETE FROM blocked_plates");
		db.exec("DELETE FROM cloud_customers");
		db.exec("DELETE FROM cloud_vehicles");
		db.exec("DELETE FROM parking_spaces");
		db.exec("DELETE FROM activity_logs");
		db.exec("DELETE FROM sites");
		// The bound-site marker is stale until the caller re-binds post-sync.
		db.prepare("DELETE FROM settings WHERE key = ?").run(BOUND_SITE_KEY);
		if (opts.wipeEquipment) {
			db.exec("DELETE FROM cameras");
			db.exec("DELETE FROM lanes");
			db.exec("DELETE FROM terminals");
		}
	});
	tx();
}

/** The site-wide default rate plan (cloud RatePolicy flagged is_site_default).
 *  Used as the pricing fallback when neither the entry nor exit lane carries a
 *  policy. Null if the cloud hasn't flagged a default. */
export function getSiteDefaultRatePolicy(): RatePolicy | null {
	const r = getDb().prepare("SELECT * FROM rate_policies WHERE is_site_default = 1 LIMIT 1").get() as any;
	if (!r) return null;
	return rowToRatePolicy(r, listTariffRulesForRatePolicy(r.policy_id));
}

/**
 * Idempotent upsert. Replaces the full rule set for this policy on every
 * call — the SaaS is the source of truth, so a rule removed in the cloud
 * UI should disappear locally on the very next poll.
 */
export function upsertRatePolicy(policy: RatePolicy): RatePolicy {
	const db = getDb();
	const tx = db.transaction(() => {
		db.prepare(
			`INSERT INTO rate_policies (
        policy_id, policy_name, free_minutes, first_block_cents, per_block_cents,
        block_minutes, daily_cap_cents, currency, fetched_at,
        grace_exceeded_behavior, cutoff_enabled, cutoff_time, cutoff_behavior,
        policy_description, new_day_fixed_fee_cents,
        rate_basis, flat_multi_rate, first_block_once_per_entry, policy_daily_cap_cents, is_site_default
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(policy_id) DO UPDATE SET
        policy_name=excluded.policy_name,
        free_minutes=excluded.free_minutes,
        first_block_cents=excluded.first_block_cents,
        per_block_cents=excluded.per_block_cents,
        block_minutes=excluded.block_minutes,
        daily_cap_cents=excluded.daily_cap_cents,
        currency=excluded.currency,
        fetched_at=excluded.fetched_at,
        grace_exceeded_behavior=excluded.grace_exceeded_behavior,
        cutoff_enabled=excluded.cutoff_enabled,
        cutoff_time=excluded.cutoff_time,
        cutoff_behavior=excluded.cutoff_behavior,
        policy_description=excluded.policy_description,
        new_day_fixed_fee_cents=excluded.new_day_fixed_fee_cents,
        rate_basis=excluded.rate_basis,
        flat_multi_rate=excluded.flat_multi_rate,
        first_block_once_per_entry=excluded.first_block_once_per_entry,
        policy_daily_cap_cents=excluded.policy_daily_cap_cents,
        is_site_default=excluded.is_site_default`,
		).run(
			policy.policyId,
			policy.policyName,
			policy.freeMinutes,
			policy.firstBlockCents,
			policy.perBlockCents,
			policy.blockMinutes,
			policy.dailyCapCents,
			policy.currency,
			policy.fetchedAt,
			policy.graceExceededBehavior ?? null,
			policy.cutoffEnabled ? 1 : 0,
			policy.cutoffTime ?? null,
			policy.cutoffBehavior ?? null,
			policy.policyDescription ?? null,
			policy.newDayFixedFeeCents ?? null,
			policy.rateBasis ?? null,
			policy.flatMultiRate ?? null,
			policy.firstBlockOncePerEntry ? 1 : 0,
			policy.policyDailyCapCents ?? null,
			policy.isSiteDefault ? 1 : 0,
		);

		db.prepare("DELETE FROM tariff_rules WHERE policy_id = ?").run(policy.policyId);
		const insertRule = db.prepare(`INSERT INTO tariff_rules (
        rule_id, policy_id, name, priority, days_of_week,
        time_from, time_to, valid_from, valid_to, rule_type,
        flat_amount_cents, first_block_amount_cents, first_block_minutes,
        subsequent_block_amount_cents, subsequent_block_minutes,
        daily_cap_cents, is_overnight, is_active, fetched_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`);
		for (const rule of policy.rules ?? []) {
			insertRule.run(
				rule.ruleId,
				policy.policyId,
				rule.name,
				rule.priority,
				rule.daysOfWeek ? JSON.stringify(rule.daysOfWeek) : null,
				rule.timeFrom,
				rule.timeTo,
				rule.validFrom ?? null,
				rule.validTo ?? null,
				rule.ruleType,
				rule.flatAmountCents,
				rule.firstBlockAmountCents,
				rule.firstBlockMinutes,
				rule.subsequentBlockAmountCents,
				rule.subsequentBlockMinutes,
				rule.dailyCapCents,
				rule.isOvernight ? 1 : 0,
				// Default true so older sync payloads that don't carry is_active keep
				// every rule live (matches the cloud's pre-2026-06-22 behavior).
				rule.isActive === false ? 0 : 1,
			);
		}
	});
	tx();
	return getRatePolicy(policy.policyId)!;
}

/**
 * Delete every policy (and its rules) whose id isn't in `keepIds`. Called
 * after a multi-policy sync so a RatePolicy that was deleted / deactivated
 * on the cloud stops governing sessions locally. Without this, a lane
 * still pointing at a stale policy would keep charging the retired rate.
 */
export function pruneStaleRatePolicies(keepIds: string[]): number {
	const db = getDb();
	const existing = db.prepare("SELECT policy_id FROM rate_policies").all() as { policy_id: string }[];
	const stale = existing.map((row) => row.policy_id).filter((id) => !keepIds.includes(id));
	if (stale.length === 0) return 0;
	const tx = db.transaction((ids: string[]) => {
		const delRule = db.prepare("DELETE FROM tariff_rules WHERE policy_id = ?");
		const delPolicy = db.prepare("DELETE FROM rate_policies WHERE policy_id = ?");
		// Any lane still bound to a stale policy loses its binding — it'll
		// fall back to the site-default policy on the next resolver call.
		const clearLane = db.prepare("UPDATE lanes SET policy_id = NULL WHERE policy_id = ?");
		for (const id of ids) {
			delRule.run(id);
			clearLane.run(id);
			delPolicy.run(id);
		}
	});
	tx(stale);
	return stale.length;
}

// ─── active passes ─────────────────────────────────────────────────────────
// Plate-keyed cache of active season/visitor/free-access passes. Refreshed
// from qparking SaaS on the same cadence as policies. The gate looks up the
// inbound plate here BEFORE driving the terminal — a match means "already
// paid, just open the gate".

function rowToSeasonPass(row: any): SeasonPass {
	return {
		passId: row.pass_id,
		plateNumber: row.plate_number,
		passType: row.pass_type,
		status: row.status,
		startDate: row.start_date ?? null,
		endDate: row.end_date ?? null,
		isFree: !!row.is_free,
		spaceNumber: row.space_number ?? null,
		fetchedAt: row.fetched_at,
	};
}

/** Site-local (GMT+8, pinned in tz.ts) calendar day for an instant, as the
 *  YYYY-MM-DD the cloud stores pass start/end dates in. Comparing date-only
 *  strings keeps this a plain lexicographic test. */
function siteDayKey(at?: string | null): string {
	const ms = at ? Date.parse(at) : Date.now();
	const d = new Date(Number.isNaN(ms) ? Date.now() : ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Find a valid pass for the given plate. Season passes are site-scoped (one site
 * per install), so the lookup is purely by plate. Returns the longest-coverage
 * pass first so a plate with a free_access + corporate match prefers the broader
 * entitlement.
 *
 * Validity is decided ENTIRELY from the dates cached on the row — the gate never
 * calls the cloud to ask. The SaaS already filters its roster to today's valid
 * passes, but that filter only protects an ONLINE box: a WAN outage used to
 * leave a one-day visitor pass in this cache honouring free exits forever, since
 * the old lookup checked `status` and nothing else.
 *
 * A pass counts if it covers the entry instant OR the exit instant. Covering
 * entry means a monthly holder who drove in on their last valid day isn't
 * charged on the way out; covering exit means someone who renewed mid-stay isn't
 * charged either. Omitting the window falls back to "valid right now".
 */
export function findSeasonPassByPlate(plate: string, window?: { entryAt?: string | null; exitAt?: string | null }): SeasonPass | null {
	const normalisedPlate = canonicalPlate(plate);
	const entryDay = siteDayKey(window?.entryAt ?? null);
	const exitDay = siteDayKey(window?.exitAt ?? null);
	// NULLIF guards against a cloud row carrying '' instead of NULL for an
	// open-ended pass (resident / complimentary) — '' would fail every date
	// comparison and silently deny a forever-pass.
	//
	// ORDER BY: free/waived first, then the BROADEST coverage. SQLite sorts NULL
	// below every value, so a plain `end_date DESC` ranked an open-ended pass (NULL
	// end_date = never expires, e.g. a resident or complimentary entitlement) LAST —
	// the exact opposite of "longest coverage". The explicit IS NULL key fixes that.
	// Every candidate row is already valid at this moment thanks to the WHERE clause,
	// so this only decides WHICH pass_id / pass-<type> reason lands in the audit
	// trail, not whether the exit is free.
	const row = getDb()
		.prepare(
			`
    SELECT * FROM season_passes
    WHERE plate_number = @plate AND status = 'active'
      AND (
        (
          (NULLIF(start_date, '') IS NULL OR NULLIF(start_date, '') <= @entryDay)
          AND (NULLIF(end_date, '') IS NULL OR NULLIF(end_date, '') >= @entryDay)
        )
        OR
        (
          (NULLIF(start_date, '') IS NULL OR NULLIF(start_date, '') <= @exitDay)
          AND (NULLIF(end_date, '') IS NULL OR NULLIF(end_date, '') >= @exitDay)
        )
      )
    -- free first, then open-ended (never-expiring), then latest end date.
    ORDER BY is_free DESC, (NULLIF(end_date, '') IS NULL) DESC, end_date DESC
    LIMIT 1
  `,
		)
		.get({ plate: normalisedPlate, entryDay, exitDay }) as any;
	return row ? rowToSeasonPass(row) : null;
}

/**
 * Every active pass the gate currently recognises (cached from
 * `/api/v1/local-server/passes`). Backs the Passes page.
 */
export function listSeasonPasses(): SeasonPass[] {
	const rows = getDb().prepare("SELECT * FROM season_passes ORDER BY plate_number").all() as any[];
	return rows.map(rowToSeasonPass);
}

// ─── customer / vehicle directories (read-only mirrors) ─────────────────────
// Replace-all like every other cloud mirror, so a customer or vehicle deleted
// in the cloud stops showing here on the next sync.

function rowToCloudCustomer(row: any): CloudCustomer {
	return {
		id: row.id,
		fullName: row.full_name ?? null,
		email: row.email ?? null,
		phone: row.phone ?? null,
		type: row.type ?? null,
		isEnabled: !!row.is_enabled,
		vehiclesCount: row.vehicles_count ?? 0,
		activePassesCount: row.active_passes_count ?? 0,
		lastSignIn: row.last_sign_in ?? null,
		createdAt: row.created_at ?? null,
		fetchedAt: row.fetched_at,
	};
}

export function listCloudCustomers(): CloudCustomer[] {
	return (getDb().prepare("SELECT * FROM cloud_customers ORDER BY full_name").all() as any[]).map(rowToCloudCustomer);
}

export function replaceAllCloudCustomers(customers: CloudCustomer[]): void {
	const db = getDb();
	const tx = db.transaction(() => {
		db.prepare("DELETE FROM cloud_customers").run();
		const insert = db.prepare(`INSERT OR REPLACE INTO cloud_customers (
        id, full_name, email, phone, type, is_enabled,
        vehicles_count, active_passes_count, last_sign_in, created_at, fetched_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`);
		for (const c of customers) {
			insert.run(c.id, c.fullName, c.email, c.phone, c.type, c.isEnabled ? 1 : 0, c.vehiclesCount, c.activePassesCount, c.lastSignIn, c.createdAt);
		}
	});
	tx();
}

function rowToCloudVehicle(row: any): CloudVehicle {
	return {
		id: row.id,
		plateNumber: row.plate_number,
		vehicleType: row.vehicle_type ?? null,
		color: row.color ?? null,
		model: row.model ?? null,
		ownerName: row.owner_name ?? null,
		ownerKind: row.owner_kind ?? null,
		isBlacklisted: !!row.is_blacklisted,
		blacklistReason: row.blacklist_reason ?? null,
		passType: row.pass_type ?? null,
		passStatus: row.pass_status ?? null,
		passEndDate: row.pass_end_date ?? null,
		createdAt: row.created_at ?? null,
		fetchedAt: row.fetched_at,
	};
}

export function listCloudVehicles(): CloudVehicle[] {
	return (getDb().prepare("SELECT * FROM cloud_vehicles ORDER BY plate_number").all() as any[]).map(rowToCloudVehicle);
}

export function replaceAllCloudVehicles(vehicles: CloudVehicle[]): void {
	const db = getDb();
	const tx = db.transaction(() => {
		db.prepare("DELETE FROM cloud_vehicles").run();
		const insert = db.prepare(`INSERT OR REPLACE INTO cloud_vehicles (
        id, plate_number, vehicle_type, color, model, owner_name, owner_kind,
        is_blacklisted, blacklist_reason, pass_type, pass_status, pass_end_date,
        created_at, fetched_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`);
		for (const v of vehicles) {
			insert.run(
				// Canonical plate so a staff search matches what the gate reads.
				v.id,
				canonicalPlate(v.plateNumber),
				v.vehicleType,
				v.color,
				v.model,
				v.ownerName,
				v.ownerKind,
				v.isBlacklisted ? 1 : 0,
				v.blacklistReason,
				v.passType,
				v.passStatus,
				v.passEndDate,
				v.createdAt,
			);
		}
	});
	tx();
}

// ─── blocked plates (mirror) ───────────────────────────────────────────────
// Deny list pulled from qparking SaaS. Checked at BOTH ends of the journey and
// BEFORE the free-exit pass shortcut — a banned vehicle that still holds a valid
// pass must not be waved through by it.

function rowToBlockedPlate(row: any): BlockedPlate {
	return {
		plateNumber: row.plate_number,
		vehicleId: row.vehicle_id ?? null,
		reason: row.reason ?? null,
		fetchedAt: row.fetched_at,
	};
}

/** Is this plate banned? Canonicalises the incoming plate the same way ingest
 *  does, so an LPR read always lines up with the stored key. */
export function findBlockedPlate(plate: string): BlockedPlate | null {
	const row = getDb().prepare("SELECT * FROM blocked_plates WHERE plate_number = ?").get(canonicalPlate(plate)) as any;
	return row ? rowToBlockedPlate(row) : null;
}

/**
 * Replace the whole deny list in one transaction. Replace-all matters here in
 * the un-banning direction: a plate the cloud no longer reports as blacklisted
 * must stop being blocked on the very next sync, or a lifted ban would keep
 * trapping the car at the barrier.
 */
export function replaceAllBlockedPlates(plates: BlockedPlate[]): void {
	const db = getDb();
	const tx = db.transaction(() => {
		db.prepare("DELETE FROM blocked_plates").run();
		const insert = db.prepare(
			`INSERT OR REPLACE INTO blocked_plates (plate_number, vehicle_id, reason, fetched_at)
       VALUES (?,?,?,CURRENT_TIMESTAMP)`,
		);
		for (const plate of plates) {
			const key = canonicalPlate(plate.plateNumber);
			// A row whose plate canonicalises to nothing would become a PK of '' and
			// then match every unreadable plate — drop it instead.
			if (!key) continue;
			insert.run(key, plate.vehicleId, plate.reason);
		}
	});
	tx();
}

// ─── parking spaces (mirror) ───────────────────────────────────────────────

function rowToParkingSpace(row: any): ParkingSpace {
	return {
		id: row.id,
		building: row.building ?? null,
		level: row.level ?? null,
		zone: row.zone ?? null,
		spaceNumber: row.space_number ?? null,
		spaceCode: row.space_code ?? null,
		status: row.status ?? "available",
		customerName: row.customer_name ?? null,
		vehiclePlate: row.vehicle_plate ?? null,
		passType: row.pass_type ?? null,
		passId: row.pass_id ?? null,
		startDate: row.start_date ?? null,
		endDate: row.end_date ?? null,
		notes: row.notes ?? null,
		fetchedAt: row.fetched_at,
	};
}

export function listParkingSpaces(): ParkingSpace[] {
	return (getDb().prepare("SELECT * FROM parking_spaces ORDER BY building, level, space_code").all() as any[]).map(rowToParkingSpace);
}

/** Replace the entire cached space inventory in one transaction. */
export function replaceParkingSpaces(parkingSpaces: ParkingSpace[]): void {
	const db = getDb();
	const tx = db.transaction(() => {
		db.prepare("DELETE FROM parking_spaces").run();
		const insert = db.prepare(`INSERT INTO parking_spaces (
        id, building, level, zone, space_number, space_code, status,
        customer_name, vehicle_plate, pass_type, pass_id,
        start_date, end_date, notes, fetched_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`);
		for (const parkingSpace of parkingSpaces) {
			insert.run(
				parkingSpace.id,
				parkingSpace.building,
				parkingSpace.level,
				parkingSpace.zone,
				parkingSpace.spaceNumber,
				parkingSpace.spaceCode,
				parkingSpace.status,
				parkingSpace.customerName,
				parkingSpace.vehiclePlate,
				parkingSpace.passType,
				parkingSpace.passId,
				parkingSpace.startDate,
				parkingSpace.endDate,
				parkingSpace.notes,
			);
		}
	});
	tx();
}

/**
 * Replace the entire cached pass set (site-wide). The SaaS is the source of
 * truth — a pass that disappeared from the cloud (revoked, expired, holder
 * unenrolled) must vanish from the local cache on the very next sync.
 */
export function replaceAllSeasonPasses(passes: SeasonPass[]): void {
	const db = getDb();
	const tx = db.transaction(() => {
		db.prepare("DELETE FROM season_passes").run();
		const insert = db.prepare(`INSERT INTO season_passes (
        pass_id, plate_number, pass_type, status,
        start_date, end_date, is_free, space_number, fetched_at
      ) VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`);
		for (const pass of passes) {
			insert.run(
				// Canonical key (see shared/plate.ts) — the cloud keeps whatever
				// separators the operator typed, the gate reads separator-free, so the
				// cache must store the form BOTH will agree on.
				pass.passId,
				canonicalPlate(pass.plateNumber),
				pass.passType,
				pass.status,
				pass.startDate,
				pass.endDate,
				pass.isFree ? 1 : 0,
				pass.spaceNumber,
			);
		}
	});
	tx();
}

function rowToActivityLog(activityLogRow: any): ActivityLog {
	return {
		id: activityLogRow.id,
		eventKey: activityLogRow.event_key,
		action: activityLogRow.action,
		category: activityLogRow.category,
		severity: activityLogRow.severity,
		outcome: activityLogRow.outcome,
		resourceType: activityLogRow.resource_type,
		resourceId: activityLogRow.resource_id,
		correlationId: activityLogRow.correlation_id,
		description: activityLogRow.description,
		changes: activityLogRow.changes,
		source: activityLogRow.source,
		actorName: activityLogRow.actor_name,
		siteId: activityLogRow.site_id,
		occurredAt: activityLogRow.occurred_at,
		createdAt: activityLogRow.created_at,
		pushedToCloud: activityLogRow.pushed_to_cloud,
		pushedAt: activityLogRow.pushed_at,
		syncError: activityLogRow.sync_error,
	};
}

export function listActivityLogs(): ActivityLog[] {
	const rows = getDb().prepare("SELECT * FROM activity_logs").all() as any[];
	return rows.map(rowToActivityLog);
}

/**
 * Replace the entire cached activity-log set. Mirror-down from qparking SaaS
 * for the local Activity Log page — the cloud is the source of truth for the
 * combined audit trail (it already holds the local events that were pushed
 * up), so we wipe and re-insert on each sync. Rows land with
 * pushed_to_cloud = 1 because they originate FROM the cloud; the outbound push
 * queue must never try to send them back.
 */
export function replaceAllActivityLogs(activityLogs: ActivityLog[]): void {
	const db = getDb();
	const dbTransaction = db.transaction(() => {
		db.prepare("DELETE FROM activity_logs").run();
		const insert = db.prepare(`INSERT INTO activity_logs (
        id, event_key, action, category, severity, outcome,
        resource_type, resource_id, correlation_id, description, changes,
        source, actor_name, site_id, occurred_at, created_at,
        pushed_to_cloud, pushed_at, sync_error
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,NULL,NULL)`);
		for (const activityLog of activityLogs) {
			insert.run(
				activityLog.id,
				activityLog.eventKey,
				activityLog.action,
				activityLog.category,
				activityLog.severity ?? "low",
				activityLog.outcome ?? null,
				activityLog.resourceType ?? null,
				activityLog.resourceId ?? null,
				activityLog.correlationId ?? null,
				activityLog.description ?? null,
				activityLog.changes == null ? null : typeof activityLog.changes === "string" ? activityLog.changes : JSON.stringify(activityLog.changes),
				activityLog.source ?? "cloud",
				activityLog.actorName ?? null,
				activityLog.siteId ?? null,
				activityLog.occurredAt ?? new Date().toISOString(),
				activityLog.createdAt ?? new Date().toISOString(),
			);
		}
	});
	dbTransaction();
}

export function updateActivityLogs(activityLogs: ActivityLog[]): void {
	const db = getDb();
	const update = db.prepare(`UPDATE activity_logs  SET pushed_to_cloud = 1, pushed_at = ?, sync_error = NULL WHERE id = ?`);
	const dbTransaction = db.transaction(() => {
		const pushedAt = new Date().toISOString();
		activityLogs.forEach((activityLog) => {
			update.run(pushedAt, activityLog.id);
		});
	});

	dbTransaction();
}

/**
 * Record ONE locally-generated audit event (source='local'). Unlike
 * replaceAllActivityLogs() (cloud mirror-down, pushed_to_cloud always 1), a
 * fresh local row starts pushed_to_cloud=0 / pushed_at=NULL until an outbound
 * push queue actually delivers it — callers should not need to pass those in.
 */
export function insertActivityLog(payload: ActivityLogPayload): void {
	const db = getDb();
	const id = randomUUID();
	db.prepare(
		`INSERT INTO activity_logs (
        id, event_key, action, category, severity, outcome,
        resource_type, resource_id, correlation_id, description, changes,
        source, actor_name, site_id, occurred_at, created_at,
        pushed_to_cloud, pushed_at, sync_error
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'local',?,?,?,?,0,NULL,NULL)`,
	).run(
		id,
		payload.eventKey,
		payload.action,
		payload.category,
		payload.severity ?? "low",
		payload.outcome ?? null,
		payload.resourceType ?? null,
		payload.resourceId ?? null,
		payload.correlationId ?? null,
		payload.description ?? null,
		payload.changes == null ? null : typeof payload.changes === "string" ? payload.changes : JSON.stringify(payload.changes),
		payload.actorName ?? null,
		payload.siteId ?? null,
		new Date().toISOString(),
		new Date().toISOString(),
	);
}
