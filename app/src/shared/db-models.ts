/**
 * Database row models — each interface here mirrors ONE SQLite table (see
 * `services/db.ts` → applySchema for the DDL). Fields are camelCase mirrors
 * of the table's snake_case columns; the rowTo*() mappers in db.ts convert.
 *
 *   Interface        → table
 *   ───────────────────────────────
 *   PaymentTerminal  → terminals
 *   LprCamera        → cameras
 *   ParkingLane      → lanes
 *   ParkingSession   → sessions
 *   TariffRule       → tariff_rules
 *   ScopeRate        → scopes
 *   ActivePass       → active_passes
 *   ParkingSpace     → parking_spaces
 *   Site             → sites
 *   SyncQueueRow     → sync_queue
 *   AppSettings      → settings   (key-value rows, coerced by default's type)
 *
 * Shared by BOTH processes (main + renderer) — keep zero runtime code here.
 */

// ─── terminals ───────────────────────────────────────────────────────────────

export type LaneType = 'entry' | 'exit' | 'open' | 'dual';
export type LaneMode = 'lpr' | 'kiosk';
export type OperationMode = 'maintenance' | 'live' | 'not_in_use';

export interface PaymentTerminal {
  id: number;
  name: string;
  /** Reader IP on the LAN (ECPI box). */
  host: string;
  /** Reader TCP port — default 5000. */
  port: number;
  /** Shared secret used in the SHA-256 signature. */
  secretKey: string;
  /** ECPI plazaID — assigned by CoherentPlus during commissioning. */
  plazaId: string;
  /** ECPI laneID — one per gate / kiosk. */
  laneId: string;
  laneType: LaneType;
  /** Which command-set to use: lpr (gate-controlled) or kiosk (self-service). */
  mode: LaneMode;
  /** Initial operation mode the terminal is brought up in. */
  operationMode: OperationMode;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── cameras ─────────────────────────────────────────────────────────────────

/** Per-camera config. We support two ingest modes: WEBHOOK (camera POSTs a
 *  plate event to our HTTP server) and POLL (we hit a vendor URL on a timer). */
export type LprIngestMode = 'webhook' | 'poll';

export interface LprCamera {
  id: number;
  name: string;
  /** Which lane this camera covers — links plate detection to a parking lane. */
  laneId: number | null;
  /** entry / exit / dual — overrides lane's default if present. */
  direction: 'entry' | 'exit' | 'dual';
  ingestMode: LprIngestMode;
  /** Camera's LAN IP/host — needed for ping/test-connection. e.g. 192.168.1.50 */
  host: string | null;
  /** HTTP(S) URL that returns a JPEG snapshot. Used for live preview in
   *  the UI and periodic upload to the cloud mirror. Most IP cameras expose
   *  something like http://<ip>/snapshot.jpg or http://<ip>/cgi-bin/snapshot.cgi. */
  snapshotUrl: string | null;
  /** Webhook secret — cameras POSTing /lpr/event must include this header. */
  webhookSecret: string | null;
  /** For poll mode — vendor REST URL we hit every N seconds. */
  pollUrl: string | null;
  pollIntervalSeconds: number | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** Last successful snapshot fetch (ISO timestamp). null = never. Runtime only. */
  lastSnapshotAt?: string | null;
  /** Last connection-test result (ok|err|never). Runtime only — not persisted. */
  online?: 'ok' | 'err' | 'never';
}

// ─── lanes ───────────────────────────────────────────────────────────────────

/** A parking lane = one entry or exit gate. Owns at least one LPR camera and
 *  optionally a payment terminal (exit lanes always have one; entry lanes
 *  usually don't — they just record the plate + open the gate). */
export interface ParkingLane {
  id: number;
  name: string;
  direction: 'entry' | 'exit';
  /** Scope from qparking SaaS — the rate config is fetched per scope. */
  scopeId: string | null;
  /** FK to PaymentTerminal — exit lanes have this set. */
  terminalId: number | null;
  /** Optional GPIO/relay address for the gate barrier. */
  gateRelayAddress: string | null;
  enabled: boolean;
  /**
   * Descriptive label for the physical lane (`car` default), mirrored to the
   * cloud equipment map. As of 2026-07-09 it has NO effect on pricing — fees
   * are driven solely by the lane's assigned rate plan and that plan's
   * day/time/date rules (the vehicle-type dimension was retired cloud-side).
   */
  laneType: 'car' | 'motorcycle' | 'mixed';
}

// ─── sessions ────────────────────────────────────────────────────────────────

/** One parking session = entry event → optional exit event. While the exit
 *  event is null the car is still inside the lot. */
export interface ParkingSession {
  id: number;
  plate: string;
  entryAt: string;
  entryLaneId: number | null;
  entryCameraId: number | null;
  entryImagePath: string | null;
  exitAt: string | null;
  exitLaneId: number | null;
  exitCameraId: number | null;
  exitImagePath: string | null;
  /** Total billable minutes — computed at exit time using the lane's scope rate. */
  durationMinutes: number | null;
  /** Final amount in CENTS (so 100 = RM 1.00). */
  feeCents: number | null;
  /** Payment status from terminal. */
  paymentStatus: 'pending' | 'paid' | 'declined' | 'cancelled' | 'free' | 'manual_release';
  /** ECPI txnID from the terminal once paid. */
  terminalTxnId: string | null;
  /** Card scheme from cardRead body.cardScheme (TNG | VISA | MASTERCARD | ...). Null for free / declined / manual release. */
  cardScheme: string | null;
  /** txnDt from the reader — the exact moment the card tapped. Differs from exitAt (gate-rise time). */
  paymentTimestamp: string | null;
  /** Optional notes (manual release reason, etc). */
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── tariff_rules ────────────────────────────────────────────────────────────

/** A single time-windowed tariff rule from qparking SaaS. Multiple of these
 *  per scope describe the full schedule (weekday/weekend, daytime/night,
 *  24-hour, etc). qparking-local picks the rule matching the SESSION moment,
 *  not the moment the cloud was polled. */
export interface TariffRule {
  ruleId: string;
  name: string;
  priority: number;
  /** Days of week ints (0=Sun ... 6=Sat). null = every day. */
  daysOfWeek: number[] | null;
  /** 'HH:mm:ss' string. If timeTo <= timeFrom the window wraps past midnight. */
  timeFrom: string;
  timeTo: string;
  /** Date range yyyy-mm-dd. null = always valid. */
  validFrom: string | null;
  validTo: string | null;
  ruleType: 'flat_rate' | 'block_hourly';
  flatAmountCents: number;
  firstBlockAmountCents: number;
  firstBlockMinutes: number;
  subsequentBlockAmountCents: number;
  subsequentBlockMinutes: number;
  /** Per-rule daily cap. 0 = inherit policy-level cap. */
  dailyCapCents: number;
  isOvernight: boolean;
  /** Per-rule activation flag — mirrors the cloud Activations tab. Inactive
   *  rules are still cached locally so the operator can see the full picture
   *  in Scopes, but the exit-flow fee math skips them. Defaults to true. */
  isActive: boolean;
}

// ─── scopes ──────────────────────────────────────────────────────────────────

/** Cached qparking scope/rate row. Refreshed periodically from the SaaS. */
export interface ScopeRate {
  scopeId: string;
  scopeName: string;
  /** Free duration in minutes at start of session. */
  freeMinutes: number;
  /** Legacy flat fields — kept as fallback when `rules` is empty. */
  firstBlockCents: number;
  perBlockCents: number;
  blockMinutes: number;
  /** LEGACY flat mirror — the currently-effective RULE's cap at sync time.
   *  Used only by the no-rules block fallback. Do NOT use as the policy cap
   *  for the schedule path — use `policyDailyCapCents` for that. 0 = no cap. */
  dailyCapCents: number;
  currency: string;
  fetchedAt: string;
  /** Full active rule set from qparking SaaS. When non-empty, the time-aware
   *  computeFee picks the rule matching the session moment and IGNORES the
   *  flat firstBlockCents/perBlockCents/blockMinutes above. */
  rules: TariffRule[];
  graceExceededBehavior: 'charge_from_entry' | 'charge_from_grace_end' | null;
  cutoffEnabled: boolean;
  cutoffTime: string | null;
  cutoffBehavior: string | null;
  /** Fixed fee charged when cutoffBehavior == 'new_day_fixed_fee' and the
   *  session crosses the daily reset boundary. Null for the other behaviours. */
  newDayFixedFeeCents: number | null;
  /** How the tariff is anchored across a stay (cloud RatePolicy.rate_basis):
   *  'occupancy' (default) prices each moment by whichever rule covers it;
   *  'entry' lets the rule active at entry govern the whole stay. */
  rateBasis?: 'occupancy' | 'entry' | null;
  /** How flat-rate rules combine when a stay spans several of them
   *  (cloud RatePolicy.flat_multi_rate): 'sum' (each distinct rule once),
   *  'entry' (only the entry rule), 'highest' (single largest), 'per_day'. */
  flatMultiRate?: 'sum' | 'entry' | 'highest' | 'per_day' | null;
  /** When true (and cutoff enabled), the first-block premium is charged once
   *  per entry rather than re-charged each cut-off cycle. */
  firstBlockOncePerEntry?: boolean | null;
  /** TRUE policy-level daily cap in cents (cloud RatePolicy.daily_cap_cents).
   *  null / undefined / 0 = uncapped. This — NOT the legacy `dailyCapCents`
   *  mirror — is the policy cap the schedule-path fee calc applies alongside
   *  each rule's own cap. */
  policyDailyCapCents?: number | null;
  policyId: string | null;
  policyName: string | null;
  /** Operator-facing free-form description from the cloud Setup & Rules tab. */
  policyDescription: string | null;
  /** Cloud flag: this is the site-wide default plan applied when a lane
   *  hasn't picked one of its own. Rendered as a "Default" badge in the
   *  local Rate Plans list so the operator knows which plan governs
   *  fallback pricing. */
  isSiteDefault?: boolean;
}

// ─── active_passes ───────────────────────────────────────────────────────────

/** A plate-keyed pass cached from qparking SaaS so the gate can decide
 *  "skip charging this car, it's already paid" without a WAN round-trip. */
export interface ActivePass {
  passId: string;
  scopeId: string;
  plateNumber: string;
  passType: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  isFree: boolean;
  spaceNumber: string | null;
  fetchedAt: string;
}

// ─── parking_spaces ──────────────────────────────────────────────────────────

/** Parking space inventory mirrored from qparking SaaS. Read-only. */
export interface ParkingSpace {
  id: string;
  building: string | null;
  level: string | null;
  zone: string | null;
  spaceNumber: string | null;
  spaceCode: string | null;
  /** Free-form status — 'available' | 'occupied' | 'reserved' | 'vip' | 'maintenance' | … */
  status: string;
  customerName: string | null;
  vehiclePlate: string | null;
  passType: string | null;
  passId: string | null;
  startDate: string | null;
  endDate: string | null;
  notes: string | null;
  fetchedAt: string;
}

// ─── sites ───────────────────────────────────────────────────────────────────

/** The branch/site record mirrored from the qparking SaaS `sites` table
 *  (Laravel App\Models\Site). Cloud is the source of truth; cached locally so
 *  company / receipt / logo / scope-override config is available offline.
 *  `id` and `companyId` are cloud UUIDs. */
export interface Site {
  id: string;
  localServerApiKey: string | null;
  companyId: string | null;
  name: string;
  address: string | null;
  totalSpaces: number;
  occupiedSpaces: number;
  revenueToday: number;
  status: 'active' | 'maintenance' | 'offline';
  alarmCount: number;
  contactPerson: string | null;
  telephone: string | null;
  fax: string | null;
  country: string | null;
  email: string | null;
  seasonPassLogoUrl: string | null;
  parkingSiteType: string | null;
  logoUrl: string | null;
  receiptHeader: string | null;
  receiptFooter: string | null;
  primaryColor: string;
  /** Per-site scope overrides editable from the local Scopes page. Null = use
   *  the cloud rate plan unchanged. */
  scopeFreeMinutes: number | null;
  scopeFirstBlockCents: number | null;
  scopePerBlockCents: number | null;
  scopeBlockMinutes: number | null;
  scopeDailyCapCents: number | null;
  createdAt: string;
  updatedAt: string;
}

// ─── sync_queue ──────────────────────────────────────────────────────────────

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

// ─── settings (key-value) ────────────────────────────────────────────────────

export interface AppSettings {
  /** qparking SaaS base URL, e.g. https://parking.qbot.now */
  qparkingBaseUrl: string;
  /** Tenant API key issued by qparking for this VPS/site. */
  qparkingApiKey: string;
  /** Local HTTP port for LPR camera webhooks. */
  lprWebhookPort: number;
  /** Local HTTP port for the operator REST API (used by KDS-style external dashboards). */
  apiPort: number;
  /** Where to store captured plate images. Falls back to userData dir if blank. */
  imageStorePath: string;
  /** Auto-release gate after this many seconds of waiting at exit if payment doesn't complete. */
  exitGracePeriodSeconds: number;
  /** Face-auth gate integration (faceapp_main /api/external/open-gate). When
   *  configured, qparking-local fires this URL after every paid exit so the
   *  turnstile barrier opens at the same time the receipt prints. */
  faceappBaseUrl: string;
  /** Bearer token expected by faceapp's /api/external/open-gate. */
  faceappApiToken: string;
  /** Optional managed-device id on faceapp side. Leave 0 to use the default. */
  faceappDeviceId: number;
  /** When ON: an entry-direction camera ALSO handles exits. The first scan
   *  of a plate opens a session; a second scan of the SAME plate while the
   *  session is still open closes it (drives terminal payment + gate open).
   *  Use this at single-lane sites where one camera covers both directions.
   *  When OFF (default): entry cams only do entries; exits need a separate
   *  exit-direction or dual camera. */
  entryCameraHandlesExit: boolean;
  /** Master switch for the faceapp_main turnstile trigger. When ON, every
   *  successful entry AND every paid exit fires `/api/external/open-gate`
   *  on the configured faceapp instance — matching real-world parking where
   *  the LPR-driven barrier and the face-auth turnstile open together.
   *  When OFF, no faceapp calls are made even if URL/token are filled in. */
  faceGateEnabled: boolean;
  /** Override for the computed fee — if the scope-based calculation would
   *  return less than this value (in cents), use this instead. 0 disables
   *  the override. Useful when testing the EMV terminal flow without having
   *  to wait for duration > freeMinutes, OR for sites with a flat minimum
   *  charge regardless of how briefly the car was parked. */
  minimumChargeCents: number;

  // ─── Touch'n'Go W4G IO-controller integration ─────────────────────────
  /** Master switch. When ON, every paid exit ALSO fires a PayRequest at the
   *  W4G IO controller — Touch'n'Go card / e-wallet / Visa / Master / MCCS
   *  taps go through this device in parallel with the ECPI terminal. The
   *  first device to confirm payment wins; the other is cancelled. Sessions
   *  paid via W4G are recorded with cardScheme=TNG_CARD / TNG_EWALLET /
   *  VISA_W4G / MASTER_W4G / MCCS_W4G so the cloud Finance report can
   *  distinguish them from the ECPI terminal's normal Visa/Master flow. */
  tngEnabled: boolean;
  /** W4G IO controller LAN IP — the box that exposes /w4g/PayRequest. */
  tngHost: string;
  /** HTTP port the W4G IO controller listens on. Default 80 — vendor docs
   *  don't specify, but the 192.168.1.105 test rig responds on the standard
   *  HTTP port. Change here if your device serves on 8080 / a custom port. */
  tngPort: number;
  /** Local HTTP port WE listen on for the W4G PayResult callback. The W4G
   *  device POSTs back to http://<our-lan-ip>:<tngCallbackPort>/w4g/PayResult
   *  once it has settled (or failed) the card deduction. */
  tngCallbackPort: number;
  /** Per-transaction wait budget. The W4G PayResult callback should arrive
   *  within a few seconds, but cards left on the reader can stretch it out.
   *  After this timeout we PayCancel the order and continue with the ECPI
   *  terminal alone (or mark the session declined if that also timed out). */
  tngTimeoutSeconds: number;
}
