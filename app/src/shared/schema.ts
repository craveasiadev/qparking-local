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
 *   RatePolicy        → rate_policies
 *   SeasonPass       → season_passes
 *   ParkingSpace     → parking_spaces
 *   Site             → sites
 *   SyncQueueRow     → sync_queue
 *   ActivityLog      → activity_logs
 *   CompanySetting   → company_settings  (single row)
 *   AppSettings      → settings   (key-value rows, coerced by default's type)
 *
 * Shared by BOTH processes (main + renderer) — keep zero runtime code here.
 */

// ─── terminals ───────────────────────────────────────────────────────────────

/** An Alarmtech Touch'n'Go W4G payment device on the LAN. One per exit lane;
 *  a lane points at its device via `lanes.terminal_id`. On a paid exit the gate
 *  fires a PayRequest at `host:port` and settles the session from the device's
 *  PayResult callback. (Replaced the former Coherent/ECPI reader model.) */
export interface PaymentTerminal {
  id: number;
  /** Durable cloud identity — survives reinstall/renumber. Used as the cloud
   *  upsert key and for push/pull sync. Backfilled to `local-{id}` on existing
   *  rows; new rows get a `dev-<uuid>`. */
  externalId: string;
  name: string;
  /** W4G device IP on the LAN. e.g. 192.168.1.105 */
  host: string;
  /** Device HTTP port — vendor default 80. */
  port: number;
  /** Per-transaction wait budget (seconds) before we PayCancel and give up. */
  timeoutSeconds: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── LCD displays ────────────────────────────────────────────────────────────

/**
 * A driver-facing LCD panel at a barrier, running the qparking-lcd Android app.
 *
 * The panel LISTENS on `host:port`; this box dials in and holds one long-lived
 * TCP connection per display, pushing plate / fare / thank-you frames as the
 * parking flow decides them. See lcd-display.ts and qparking-lcd/PROTOCOL.md.
 *
 * A lane points at its panel via `lanes.lcd_id`. One panel per lane, and a panel
 * may serve only one lane — two lanes pushing to the same glass would overwrite
 * each other's fare mid-transaction.
 */
export interface LcdDisplay {
  id: number;
  /** Durable cloud identity — survives reinstall/renumber. See PaymentTerminal.externalId. */
  externalId: string;
  name: string;
  /** The panel's LAN address, as shown on its own idle screen footer. */
  host: string;
  /** The panel's listen port — qparking-lcd Settings → Listen port. Default 7070. */
  port: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Live link health for one panel, for the Displays page. Not persisted. */
export interface LcdDisplayStatus {
  lcdId: number;
  connected: boolean;
  /** ISO timestamp of the last successful frame ack, or null if never. */
  lastAckAt: string | null;
  /** Last screen the panel acknowledged. */
  lastScreen: string | null;
  /** Most recent connection error, cleared on a successful connect. */
  lastError: string | null;
}

// ─── cameras ─────────────────────────────────────────────────────────────────

/** Per-camera config. Cameras POST plate events to our HTTP webhook
 *  (/lpr/event); live video comes from the device SDK. */
export interface LprCamera {
  id: number;
  /** Durable cloud identity — survives reinstall/renumber. See PaymentTerminal.externalId. */
  externalId: string;
  name: string;
  /** Which lane this camera covers — links plate detection to a parking lane. */
  laneId: number | null;
  /**
   * Which way this camera faces. A camera is single-direction BY PHYSICS: it is
   * aimed down one approach and reads plates coming toward it. The old third
   * value, 'dual', claimed one camera could gate both directions at a shared
   * barrier — it can't. An exiting car approaches from behind the camera's cone
   * and only enters frame AFTER it has passed the barrier, so that read arrives
   * far too late to decide anything. It could record an exit, never authorise one.
   *
   * A shared in/out barrier is modelled as TWO cameras (one facing each way),
   * which is also what makes the lane read as bidirectional — see
   * deriveLaneDirection, where 'dual' remains a valid LANE value. Lane-level
   * 'dual' is derived from having both an entry and an exit camera; it is a
   * different concept from the retired camera value and is unaffected.
   */
  direction: 'entry' | 'exit';
  /** Camera's LAN IP/host — needed for ping/test-connection. e.g. 192.168.1.50 */
  host: string | null;
  /** Vendor-SDK login for pulling live H.264 video directly off the device
   *  (VzLPRSDK). `host` is the camera IP; `devicePort` is the SDK control port
   *  (default 80). When user + password are set, the main process connects via
   *  the SDK and grabs a JPEG frame ~1×/sec into the live-frame cache that the
   *  Live display reads — a clean video feed with no web page / token. */
  deviceUser: string | null;
  devicePassword: string | null;
  /** The port on the CAMERA the box connects TO for the SDK video pull (80).
   *  Opposite direction to `webhookPort` below — do not confuse them. */
  devicePort: number | null;
  /** The port THIS server listens on for this camera's plate pushes.
   *
   *  Per camera because firmware varies in what it will let you set, so a site
   *  can end up with cameras pushing to different ports. The box binds a
   *  listener for every distinct port in use. Required; 6001 by default. */
  webhookPort: number;
  /**
   * Who this camera lets through.
   *
   *   'open'      — every plate (DEFAULT, and what every install did before
   *                 2026-08-05). The barrier is opened by the camera's own
   *                 onboard relay logic; this app only records the movement.
   *   'pass_only' — ONLY a plate holding a season pass that is valid right now.
   *                 Anything else is refused: no session, no barrier, an
   *                 ACCESS DENIED screen for the driver and an audit row for
   *                 the operator. Applies at entry AND exit — the question is
   *                 always just "is there a valid pass?", never "is there an
   *                 open session?".
   *
   * REQUIRES device credentials. In 'pass_only' this app becomes the thing that
   * opens the barrier (pulseBarrier → VzLPRClient_SetIOOutputAuto), which needs
   * host + deviceUser + devicePassword. Without them NOBODY gets through, pass
   * or not — so the Cameras form refuses to save that combination.
   *
   * Also requires the camera's OWN auto-open to be switched off on the device.
   * If the camera keeps firing its own relay, an unregistered car still gets in
   * and this setting is decorative.
   *
   * TEXT rather than a boolean so a looser mode (e.g. 'registered' — any known
   * vehicle, pass or not) can be added later without a second migration.
   */
  accessMode: 'open' | 'pass_only';
  // REMOVED 2026-08-07: `barrierControl` ('camera' | 'app'). It chose who
  // physically lifted the boom, and defaulted to 'camera' — meaning this app
  // recorded the session and pulsed nothing, so the gate never moved unless the
  // device's own auto-open did it. That default is what "the barrier trigger
  // doesn't work" actually was.
  //
  // qparking-local now ALWAYS opens the barrier for a car it has authorised: it
  // receives the plate event, checks blacklist → pass → fee, and pulses the
  // camera's IO relay. A site whose camera firmware also auto-opens switches
  // that off on the device.
  //
  // ⚠️ The trade-off this makes site-wide: the barrier depends on this PC. If
  // qparking-local isn't running, the lane does not open.
  /** Webhook secret — cameras POSTing /lpr/event must include this header. */
  webhookSecret: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** Last connection-test result (ok|err|never). Runtime only — not persisted. */
  online?: 'ok' | 'err' | 'never';
  /**
   * A configuration fault that would stop this camera doing its job, computed on
   * read — see db.describeCameraRisk. Null when the camera is coherent.
   *
   * Exists because the dangerous states here are SILENT: a lane whose app-owned
   * barrier has no credentials looks perfectly normal in the list, right up to
   * the moment a resident is sitting at a boom that will never lift. Runtime
   * only, never persisted.
   */
  risk?: string | null;
}

// ─── lanes ───────────────────────────────────────────────────────────────────

/** A parking lane = one entry or exit gate. Owns at least one LPR camera and
 *  optionally a payment terminal (exit lanes always have one; entry lanes
 *  usually don't — they just record the plate + open the gate).
 *
 *  Direction (entry/exit/dual) is NOT stored on the lane — it's derived from
 *  the directions of the cameras assigned to it (see db.deriveLaneDirection).
 *  The camera is the single source of truth for direction because routing is
 *  keyed to the camera that saw the plate. A lane reads as 'dual' when it has
 *  BOTH an entry and an exit camera — one shared barrier covered from both
 *  sides. That is the only surviving meaning of 'dual'; cameras themselves are
 *  strictly entry or exit (see LprCamera.direction). */
export interface ParkingLane {
  id: number;
  /** Durable cloud identity — survives reinstall/renumber. See PaymentTerminal.externalId. */
  externalId: string;
  name: string;
  /** Policy from qparking SaaS — the rate config is fetched per policy. */
  policyId: string | null;
  /** FK to PaymentTerminal — exit lanes have this set. */
  terminalId: number | null;
  /** FK to LcdDisplay — the driver-facing panel at this barrier. Unlike the
   *  terminal this is useful in BOTH directions: an entry lane shows the plate
   *  and a welcome, an exit lane shows the plate and the fare. */
  lcdId: number | null;
  enabled: boolean;
  // REMOVED 2026-08-14: `gateRelayAddress` — an optional "GPIO addr / relay URL"
  // that nothing ever read. The barrier is raised by pulsing the LPR camera's
  // own onboard IO relay (camera-relay.ts, keyed on the camera's host +
  // credentials), so a lane-level relay address had no consumer on either side:
  // the cloud stored it, mirrored it back, and never showed it either.
}

// ─── sessions ────────────────────────────────────────────────────────────────

/** One parking session = entry event → optional exit event. While the exit
 *  event is null the car is still inside the lot. */
export interface ParkingSession {
  id: number;
  /**
   * Durable cloud identity for this stay — a UUID minted at entry that NEVER
   * changes, whatever the operator later edits.
   *
   * The cloud used to identify a stay by plate + entry_time, so correcting a
   * misread plate created a SECOND cloud record and left the original open
   * forever (the car exits as the corrected plate). This is the key that makes a
   * correction an update instead of a fork.
   *
   * Null only on a row written before this column existed and somehow not
   * backfilled; the cloud falls back to its old matching in that case.
   */
  externalId: string | null;
  plate: string;
  entryAt: string;
  entryLaneId: number | null;
  entryCameraId: number | null;
  entryImagePath: string | null;
  exitAt: string | null;
  exitLaneId: number | null;
  exitCameraId: number | null;
  exitImagePath: string | null;
  /** Total billable minutes — computed at exit time using the lane's policy rate. */
  durationMinutes: number | null;
  /** Final amount in CENTS (so 100 = RM 1.00). */
  feeCents: number | null;
  /** The car's physical journey — the authoritative session state.
   *   entered        — car is inside the lot
   *   exited         — car paid (or free) and left
   *   manual_release — staff released the car without a successful payment */
  status: 'entered' | 'exited' | 'manual_release';
  /** DEPRECATED as a source of truth — kept as a denormalised MIRROR of the
   *  latest transaction so the existing operator UI keeps working. Payment
   *  outcome now lives in the `transactions` table. */
  paymentStatus: 'pending' | 'paid' | 'declined' | 'cancelled' | 'free' | 'manual_release';
  /** ECPI txnID from the terminal once paid. */
  terminalTxnId: string | null;
  /** Card scheme from cardRead body.cardScheme (TNG | VISA | MASTERCARD | ...). Null for free / declined / manual release. */
  cardScheme: string | null;
  /** txnDt from the reader — the exact moment the card tapped. Differs from exitAt (gate-rise time). */
  paymentTimestamp: string | null;
  /** The season pass that waived the charge, when this exit was free because the
   *  plate is on the cloud pass roster. Null for every other outcome. */
  passId: string | null;
  /** Why a zero-fee exit was zero-fee: 'pass-<type>' | 'within-grace' |
   *  'rate-zero' | 'no-policy'. Null when money was actually due. Without this a
   *  pass exit and a misconfigured RM0 rate plan are indistinguishable. */
  freeReason: string | null;
  /** Optional notes (manual release reason, etc). */
  notes: string | null;
  /** Local change counter — bumped by every mutation (exit recorded, edit,
   *  manual release). Paired with `cloudSyncedRev` it says whether qparking SaaS
   *  holds the CURRENT version, which a boolean "pushed" flag cannot: a session
   *  mutates several times over its life, whereas an activity-log row is written
   *  once. Revisions rather than timestamps because SQLite's clock is too coarse
   *  — a change in the same tick as an acknowledgement compared equal. */
  rev: number;
  /** The `rev` qparking SaaS has acknowledged. Null = never delivered; anything
   *  below `rev` means the cloud copy is stale. */
  cloudSyncedRev: number | null;
  /** When that acknowledgement happened (display, and a backstop comparison
   *  against `updatedAt`). */
  cloudSyncedAt: string | null;
  /** Why the last delivery attempt for this session failed. Cleared on success.
   *  Never accompanied by clearing cloudSyncedAt — a failed RE-push must not make
   *  an already-delivered session look absent. */
  cloudSyncError: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── transactions ────────────────────────────────────────────────────────────

/** A single payment attempt against a session. One session can own many
 *  transactions (a declined attempt followed by a paid retry). The session's
 *  payment mirror is derived from the latest meaningful transaction. */
export type TransactionStatus = 'pending' | 'paid' | 'failed' | 'refunded' | 'voided';

export interface Transaction {
  id: number;
  /** Client-generated UUID — the idempotency key the cloud upserts on, and
   *  re-sent on every sync retry. */
  localTransactionId: string;
  sessionId: number;
  status: TransactionStatus;
  /** Amount attempted/charged for THIS transaction, in CENTS. */
  amountCents: number;
  /** Card scheme from the W4G reader (VISA_W4G | TNG_CARD | ...). */
  paymentMethod: string | null;
  /** W4G CardNo — the card's manufacturing number from the PayResult. */
  cardNumber: string | null;
  /** Payment device that rang up the charge — local FK id + name snapshot. */
  terminalId: number | null;
  terminalName: string | null;
  /** W4G order id assigned to the PayRequest. */
  orderId: string | null;
  paymentTimestamp: string | null;
  // ── W4G PayResult extras (2026-07-22) ──────────────────────────────────
  /** Bank approval code (APPR_CODE) — blank for TNG-wallet taps. */
  apprCode: string | null;
  /** Raw W4G pay type: 0 TNG card, 1 Visa, 2 Mastercard, 3 MCCS, 4 TNG e-wallet. */
  payType: number | null;
  createdAt: string;
  updatedAt: string;
}

// ─── tariff_rules ────────────────────────────────────────────────────────────

/** A single time-windowed tariff rule from qparking SaaS. Multiple of these
 *  per policy describe the full schedule (weekday/weekend, daytime/night,
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
   *  in Parking Policies, but the exit-flow fee math skips them. Defaults to true. */
  isActive: boolean;
}

// ─── policies ──────────────────────────────────────────────────────────────────

/** Cached qparking policy/rate row. Refreshed periodically from the SaaS. */
export interface RatePolicy {
  policyId: string;
  policyName: string;
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
  /** Operator-facing free-form description from the cloud Setup & Rules tab. */
  policyDescription: string | null;
  /** Cloud flag: this is the site-wide default plan applied when a lane
   *  hasn't picked one of its own. Rendered as a "Default" badge in the
   *  local Rate Plans list so the operator knows which plan governs
   *  fallback pricing. */
  isSiteDefault?: boolean;
}

// ─── season_passes ───────────────────────────────────────────────────────────

/** A plate-keyed pass cached from qparking SaaS so the gate can decide
 *  "skip charging this car, it's already paid" without a WAN round-trip. */
export interface SeasonPass {
  passId: string;
  plateNumber: string;
  passType: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  isFree: boolean;
  spaceNumber: string | null;
  /** How many of this pass's plates may be inside at once — one per bay, or 1
   *  with no bay. Pre-computed by the cloud; the box never derives it. */
  concurrentLimit: number;
  /** resident | staff | season | visitor */
  role: string | null;
  /** The plan the pass was sold on, in the operator's own words ("3 Slot
   *  Resident", "Staff"). NULL on v1 payloads, which carry no plan. */
  plan: string | null;
  fetchedAt: string;
}

// ─── cloud_customers / cloud_vehicles (read-only directories) ────────────────
// Mirrored purely so site staff can answer "who owns this plate?" at the gate
// without opening the cloud portal in a browser. qparking-local never writes
// these back — the cloud is the only place they're edited.

/** A customer mirrored from qparking SaaS, for local lookup. */
export interface CloudCustomer {
  id: string;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  /** What they ARE at THIS site: 'resident' | 'staff' | 'season' | 'visitor' —
   *  the holder type of the pass they hold here (wire: `holder_type`, named
   *  `site_role` before the cloud's 2026-08-18 rename — the sync reads both).
   *  NULL on a box that has not synced since the cloud started sending it.
   *  Always one of the four canonical words: the mirror is replace-all on every
   *  pull and the cloud stopped sending the pre-rename 'guest' on 2026-08-16. */
  holderType: string | null;
  /** Status of the pass that `holderType` came from — the SAME pass, picked by the
   *  cloud with one ordering (live beats finished, then newest). Drives the
   *  live/lapsed verdict on the directory pages; the pass's DATES are shown only
   *  on the Vehicles page, keyed on the plate, so there is one place they can be
   *  read and one way they are derived. NULL on a box that has not synced since
   *  the cloud started sending it. */
  seasonPassStatus: string | null;
  isEnabled: boolean;
  vehiclesCount: number;
  /** Active passes AT THIS SITE only. */
  activePassesCount: number;
  lastSignIn: string | null;
  createdAt: string | null;
  fetchedAt: string;
}

/** A registered vehicle mirrored from qparking SaaS, with its owner and its
 *  entitlement at this site. Also the operator-facing view of the blacklist. */
export interface CloudVehicle {
  id: string;
  plateNumber: string;
  vehicleType: string | null;
  color: string | null;
  model: string | null;
  ownerName: string | null;
  /** 'customer' | 'corporate' | null */
  ownerKind: string | null;
  isBlacklisted: boolean;
  blacklistReason: string | null;
  createdAt: string | null;
  fetchedAt: string;
}

// ─── blocked_plates ──────────────────────────────────────────────────────────

/** A blacklisted plate mirrored from qparking SaaS (`vehicles.is_blacklisted`).
 *  The gate refuses both entry and exit for these — no charge, no gate pulse —
 *  so the operator deals with the owner in person. */
export interface BlockedPlate {
  plateNumber: string;
  vehicleId: string | null;
  /** Operator-entered `blacklist_reason`, shown so staff know why on the spot. */
  reason: string | null;
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
  /** What the bay is SET ASIDE for: 'visitor' | 'resident' | 'season' | 'staff'.
   *  The operator's designation, which holds whether or not anyone is in it. */
  bayType: string | null;
  passId: string | null;
  startDate: string | null;
  endDate: string | null;
  notes: string | null;
  fetchedAt: string;
}

// ─── sites ───────────────────────────────────────────────────────────────────

/** The branch/site record mirrored from the qparking SaaS `sites` table,
 *  as served by GET /local-server/site (Laravel SiteResource). Cloud is the
 *  source of truth; cached locally so identity / occupancy / contact info is
 *  available offline. `id` and `companyId` are cloud UUIDs. The API
 *  deliberately omits local_server_api_key and the created/updated
 *  timestamps, so they're not part of this shape. */
export interface Site {
  id: string;
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
  parkingSiteType: string | null;
  logoUrl: string | null;
}

// ─── sync_queue ──────────────────────────────────────────────────────────────

export type SyncOp =
  | 'session.entry' | 'session.exit' | 'session.update' | 'session.delete'
  | 'transaction.upsert';

export interface SyncQueueRow {
  id: number;
  op: SyncOp;
  payload: Record<string, unknown>;
  attempts: number;
  status: 'pending' | 'failed';
  lastError: string | null;
  nextAttemptAt: string;
  /** The session this push describes, when it describes one (null for
   *  transaction pushes and for a delete, whose session is already gone). Lets a
   *  successful drain stamp that session's cloud watermark. */
  sessionId: number | null;
  /** The session's `rev` at the moment this row was queued — the payload is a
   *  snapshot, so this is the revision the cloud will be holding once it lands.
   *  Also the dedupe key: an identical pending push collapses onto it. */
  sessionRev: number | null;
  createdAt: string;
  updatedAt: string;
}

// ─── activity_logs ─────────────────────────────────────────────────────────

/** One audit-trail row. Operational events generated on this box (gate opens,
 *  payment outcomes, equipment/config edits, sync failures) are written here
 *  and pushed up to qparking SaaS; cloud rows mirrored back down for the
 *  Activity Log page land here too. Mirrors the `activity_logs` table — and
 *  the cloud ActivityLog model / ActivityLogResource it syncs against. */
export interface ActivityLog {
  /** UUID — generated locally so the row keeps its identity when pushed to the
   *  cloud (the cloud ActivityLog is UUID-keyed too), avoiding a re-key. */
  id: string;
  /** Machine slug, e.g. 'gate.manual.opened' | 'payment.declined' | 'sync.failed'.
   *  NULL on rows mirrored down from the cloud's own operator-CRUD writer, which
   *  doesn't set one — locally-written rows (ActivityLogPayload) always do. */
  eventKey: string | null;
  /** Verb: 'create' | 'edit' | 'delete' | 'access' | 'failed' | 'retry' | … */
  action: string;
  /** Grouping: 'gate' | 'payment' | 'equipment' | 'config' | 'sync' | 'session' | …
   *  NULL on cloud operator-CRUD rows, same as eventKey. */
  category: string | null;
  severity: 'low' | 'medium' | 'high' | 'critical';
  /**     Result: 'ok' | 'failed' | 'declined' | 'timeout' | 'skipped' | … null = n/a. */
  outcome: string | null;
  /** Affected entity type, e.g. 'gate' | 'local_terminal' | 'rate_policy'. */
  resourceType: string | null;
  resourceId: string | null;
  /** Ties related rows across one action (payment + gate + sync of a single exit). */
  correlationId: string | null;
  description: string | null;
  /** Structured before/after diff. Persisted as a JSON string in the TEXT
   *  column (same convention as SyncQueueRow.payload); the mapper converts. */
  changes: Record<string, unknown> | null;
  /** Origin: 'local' (generated on this box) or 'cloud' (mirrored down). */
  source: 'local' | 'cloud';
  /** Who/what triggered it, e.g. 'Site: Main Plaza' | 'System: qparking-local'. */
  actorName: string | null;
  /** Cloud site UUID this event belongs to. null until the site has synced. */
  siteId: string | null;
  /** When the event actually happened (ISO 8601) — drives ordering. */
  occurredAt: string;
  /** When the row was written locally (ISO 8601). */
  createdAt: string;
  /** Has this row been delivered to /activity-logs/batch yet? */
  pushedToCloud: boolean;
  /** Timestamp of the successful push (ISO 8601). null until pushed. */
  pushedAt?: string | null;
  /** Last push error, if delivery failed. null = no error. */
  syncError?: string | null;
}

// ─── settings (key-value) ────────────────────────────────────────────────────

export interface AppSettings {
  /** qparking SaaS base URL, e.g. https://parking.qbot.now */
  qparkingBaseUrl: string;
  /** Tenant API key issued by qparking for this VPS/site. */
  qparkingApiKey: string;
  /**
   * How long after a car EXITS to keep ignoring fresh entry reads of the same
   * plate. Default 60s; 0 disables the guard entirely.
   *
   * ANPR cameras report the same plate two or three times per pass. At a shared
   * barrier the exit camera closes the session on its first read, and an entry
   * camera can then see the SAME departing car — without this window that second
   * read opens a brand-new entry: a phantom "car inside" for a car that has just
   * driven out, which then blocks its real next visit with ALREADY INSIDE and
   * inflates occupancy. Enforced in parking-flow's handleEntry.
   *
   * A window this long is safe because re-entering within it is physically
   * implausible at a barrier — and it is operator-tunable for sites where it
   * isn't (a short-stay drop-off loop, say).
   *
   * NOT an auto-release timer. It has nothing to do with payment: a car whose
   * charge fails stays put until it is paid or staff release it. The old doc
   * comment here claimed otherwise for a long time and it was never true.
   */
  exitGracePeriodSeconds: number;
  // REMOVED 2026-08-07: `faceappBaseUrl`, `faceappApiToken`, `faceappDeviceId`
  // and `faceGateEnabled` — the face-auth turnstile bridge (faceapp_main
  // /api/external/open-gate). This is a parking app: a barrier is raised by
  // pulsing the LPR camera's onboard IO relay (see camera-relay.ts), and drivers
  // stay in their cars, so there was never a face to authenticate. Settings are
  // key-value and getSettings() only reads keys present in DEFAULT_SETTINGS, so
  // any rows left in an existing DB are simply ignored.
  //
  // REMOVED 2026-08-05: `entryCameraHandlesExit`. It let an entry camera also
  // close sessions (first read opens, second read of the same plate closes) for a
  // single shared barrier covered by ONE camera. Retired together with the camera
  // direction 'dual', which did byte-for-byte the same thing, because that
  // configuration does not occur in practice — and it could not work properly
  // anyway: a departing car only enters the camera's frame after it has passed
  // the barrier, so the second read could record an exit but never authorise one.
  //
  // A shared in/out barrier is now modelled as TWO cameras, one facing each way,
  // which is also what makes the lane derive as 'dual' (see deriveLaneDirection).
  // Camera direction is therefore the ONLY thing that decides entry-vs-exit
  // routing — there is no global override any more.
  /** Override for the computed fee — if the policy-based calculation would
   *  return less than this value (in cents), use this instead. 0 disables
   *  the override. Useful when testing the EMV terminal flow without having
   *  to wait for duration > freeMinutes, OR for sites with a flat minimum
   *  charge regardless of how briefly the car was parked. */
  minimumChargeCents: number;

  /** Dev/QA mode — unlocks hidden testing tools (currently the Sessions lane
   *  simulator). Off by default; toggled by tapping the sidebar build version
   *  7×. Purely gates UI — it has no effect on the live parking flow. */
  devMode: boolean;

  // REMOVED 2026-08-12: `paymentController` ('terminal' | 'tng'). It was meant
  // to route a paid exit at either the ECPI terminal or the W4G IO controller,
  // but the 2026-07-14 cutover retired ECPI entirely (see migrateTerminalsToW4g)
  // and left only one controller to choose between. Nothing ever read the key —
  // not the parking flow, not the Settings page — so it was a stored preference
  // with no effect. Settings are key-value and getSettings() only reads keys
  // present in DEFAULT_SETTINGS, so rows left in an existing DB are ignored.

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
  /** Legacy single PayResult callback port. Kept as the fallback used when
   *  `tngCallbackPorts` is empty. Prefer `tngCallbackPorts` (the multi-port
   *  list the listener actually binds). */
  tngCallbackPort: number;
  /** Comma-separated list of ports WE bind the PayResult listener on
   *  (e.g. "80, 120, 240"). When non-empty this is AUTHORITATIVE — the listener
   *  binds exactly these ports and nothing else (no implicit port 80). Falls
   *  back to `tngCallbackPort` when blank. */
  tngCallbackPorts: string;
  /** Per-transaction wait budget. The W4G PayResult callback should arrive
   *  within a few seconds, but cards left on the reader can stretch it out.
   *  After this timeout we PayCancel the order and continue with the ECPI
   *  terminal alone (or mark the session declined if that also timed out). */
  tngTimeoutSeconds: number;
  /** When a paid exit charge fails / times out / is declined, automatically
   *  re-fire the PayRequest at the same terminal after a short delay (2s) so
   *  the driver can tap again without staff having to manually retrigger.
   *  Capped per session (see MAX_AUTO_RETRIGGERS in parking-flow) so an
   *  abandoned car can't hold the lane forever. Default ON — turn OFF to make
   *  a failed tap require a manual retrigger.
   *  ⚠️ Re-arming after a *timeout* can double-charge if a tap actually
   *  succeeded but its PayResult callback was lost (network/firewall). Only
   *  fully safe once the PayResult callback path is reliable. */
  tngAutoRetrigger: boolean;
}

/** Company-wide settings mirrored from qparking SaaS (GET /company/settings).
 *  A read-only mirror this app never writes back, like cloud_customers /
 *  cloud_vehicles.
 *
 *  Exactly ONE row — the cloud owns a single settings record per company — so
 *  db.getCompanySetting() takes no lookup key, the way getCurrentSite() doesn't.
 *
 *  syncCaptureImages gates cloud-queue's image upload and syncIntervalMinutes
 *  drives cloud-sync's pull cadence — both wired up. ⚠️ seasonPassGraceDays is
 *  still MIRRORED ONLY: nothing honours it at the gate yet. */
export interface CompanySetting {
  id: string;
  companyId: string | null;
  seasonPassGraceDays: number;
  syncCaptureImages: boolean;
  syncIntervalMinutes: number;
}
