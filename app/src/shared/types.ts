/**
 * Types shared between the main (Node/Electron) and renderer (React) processes
 * via the contextBridge IPC layer. Keep zero runtime dependencies in this file —
 * it must be safely importable from both sides.
 */

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

export type TerminalConnState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'initialising'
  | 'ready'
  | 'transacting'
  | 'error';

export interface TerminalStatus {
  terminalId: number;
  conn: TerminalConnState;
  /** Latest state reported by the reader (from getStatus: 01 idle, 02 scanning, ...). */
  readerState: string | null;
  lastError: string | null;
  /** Last successful heartbeat ack (ISO timestamp). Stale → reader probably wedged. */
  lastHeartbeatAt: string | null;
  lastSeenAt: string | null;
}

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
}

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

/** A single time-windowed tariff rule from qparking SaaS. Multiple of these
 *  per scope describe the full schedule (weekday/weekend, daytime/night,
 *  24-hour, etc). qparking-local picks the rule matching the SESSION moment,
 *  not the moment the cloud was polled. */
export interface TariffRule {
  ruleId: string;
  name: string;
  priority: number;
  vehicleType: string | null;
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
}

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
  /** Policy-level daily cap (cents). 0 = no cap. */
  dailyCapCents: number;
  currency: string;
  fetchedAt: string;
  /** Full active rule set from qparking SaaS. When non-empty, the time-aware
   *  computeFee picks the rule matching the session moment and IGNORES the
   *  flat firstBlockCents/perBlockCents/blockMinutes above. */
  rules: TariffRule[];
  graceExceededBehavior: 'charge_from_entry' | 'charge_from_grace' | null;
  cutoffEnabled: boolean;
  cutoffTime: string | null;
  cutoffBehavior: string | null;
  policyId: string | null;
  policyName: string | null;
}

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

/** Status snapshot for the outbound sync queue (Dashboard panel). */
export interface SyncStatus {
  pending: number;
  failed: number;
  inFlight: boolean;
  oldestPending: string | null;
  lastDrainAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}

export interface SyncQueueRow {
  id: number;
  op: 'session.entry' | 'session.exit' | 'session.update' | 'session.delete';
  payload: Record<string, unknown>;
  attempts: number;
  status: 'pending' | 'failed';
  lastError: string | null;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
}

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
}

/** Wire-level message envelope used by the ECPI terminal protocol. */
export interface EcpiEnvelope {
  apiVersion: string;
  message: string;
  type: 'request' | 'ack' | 'response';
  timestamp: string;
  messageTraceID: string;
  body: Record<string, unknown>;
  signature?: string;
}

/** What the bridge exposes to the renderer. Every method returns a Promise. */
export interface BridgeApi {
  // Terminals — CRUD + lifecycle
  listTerminals(): Promise<PaymentTerminal[]>;
  saveTerminal(input: Omit<PaymentTerminal, 'id' | 'createdAt' | 'updatedAt'> & { id?: number }): Promise<PaymentTerminal>;
  deleteTerminal(id: number): Promise<void>;
  getTerminalStatus(id: number): Promise<TerminalStatus>;
  terminalConnect(id: number): Promise<void>;
  terminalDisconnect(id: number): Promise<void>;

  // Terminals — full ECPI API surface
  terminalInitTerminal(id: number, op?: '0'|'1'|'2'): Promise<void>;
  terminalDeinitTerminal(id: number): Promise<void>;
  terminalGetStatus(id: number): Promise<void>;
  terminalInitCard(id: number, opts?: { fareClass?: string; retrigger?: '0'|'1'; titleTXT?: string; messageTXT?: string }): Promise<void>;
  terminalInitEntry(id: number, opts?: { mode?: '0'|'1'|'2'; fareAmount?: number; fareClass?: string }): Promise<void>;
  terminalInitExit(id: number, opts?: { mode?: '0'|'1'|'2' }): Promise<void>;
  terminalInitTxn(id: number, opts: { fareAmount: number; fareClass?: string; entryDt?: string; vehicleNo?: string; entryLane?: string; gstAmount?: number; pAmount?: number }): Promise<void>;
  terminalProceedEntry(id: number, opts?: { payFlag?: -1|0|1 }): Promise<void>;
  terminalProceedExit(id: number, opts: { fareAmount: number; fareClass?: string; fallTimeout?: number; payFlag?: -1|0|1 }): Promise<void>;
  terminalFinTxn(id: number): Promise<void>;
  terminalAbort(id: number, reason?: 'success'|'failed'|'silent'): Promise<void>;
  terminalShowStatus(id: number, opts: { titleTXT: string; messageTXT: string; sound?: '01'|'02'|'FF'; image?: '04'|'08' }): Promise<void>;

  // LPR cameras
  listCameras(): Promise<LprCamera[]>;
  saveCamera(input: Omit<LprCamera, 'id' | 'createdAt' | 'updatedAt'> & { id?: number }): Promise<LprCamera>;
  deleteCamera(id: number): Promise<void>;
  /** Manually simulate a plate detection — used to test entry/exit flow without real hardware. */
  simulatePlate(cameraId: number, plate: string): Promise<void>;
  /** Demo helper — fire entry, wait holdMs (default 3s), fire exit so the
   *  operator can watch the full flow end-to-end with a single click. */
  simulateFullFlow(cameraId: number, plate: string, holdMs?: number): Promise<{ ok: boolean }>;
  /** Fetch a single live snapshot from the camera's HTTP endpoint. Returns JPEG as base64. */
  fetchCameraSnapshot(cameraId: number): Promise<{ ok: boolean; contentType?: string; base64?: string; fetchedAt?: string; status?: number; error?: string }>;
  /** Probe TCP/HTTP reachability — used by the "Test connection" button. */
  pingCamera(cameraId: number): Promise<{ ok: boolean; status?: number; latencyMs?: number; error?: string }>;

  // Lanes
  listLanes(): Promise<ParkingLane[]>;
  saveLane(input: Omit<ParkingLane, 'id'> & { id?: number }): Promise<ParkingLane>;
  deleteLane(id: number): Promise<void>;

  // Sessions
  listOpenSessions(): Promise<ParkingSession[]>;
  listRecentSessions(limit: number): Promise<ParkingSession[]>;
  listSessionsPage(opts: { tab: 'open' | 'recent'; limit: number; offset: number }): Promise<{
    rows: ParkingSession[];
    counts: { open: number; total: number };
  }>;
  deleteSession(id: number): Promise<boolean>;
  deleteSessionsBulk(opts: { ids?: number[]; tab?: 'open' | 'recent' | 'all' }): Promise<{ deleted: number }>;
  manualReleaseSession(id: number, reason: string): Promise<void>;
  updateSession(id: number, patch: {
    plate?: string;
    entryAt?: string;
    exitAt?: string | null;
    paymentStatus?: 'pending'|'paid'|'declined'|'cancelled'|'free'|'manual_release';
    notes?: string;
    scopeIdOverride?: string | null;
  }): Promise<ParkingSession>;

  // Scopes / rates
  listScopes(): Promise<ScopeRate[]>;
  syncScopesNow(): Promise<{ ok: boolean; fetched: number; error?: string }>;
  /** Push a rate edit to qparking SaaS, then re-pull. The SaaS becomes the
   *  source of truth; the local cache reflects whatever it canonicalised. */
  saveScopeRate(input: {
    firstBlockCents: number; perBlockCents: number;
    blockMinutes: number; freeMinutes: number; dailyCapCents: number;
  }): Promise<{ ok: boolean; fetched: number; error?: string }>;

  // App build metadata — operator-visible version stamp.
  getAppVersion(): Promise<{ version: string; isPackaged: boolean; builtAt: string }>;
  /** Wipe Electron's session cache + storage and reload the renderer. Does
   *  NOT touch the SQLite app DB. */
  clearAppCache(): Promise<{ ok: boolean; elapsedMs: number; clearedAt: string }>;

  // Outbound sync to qparking SaaS (entry/exit/update/delete with retry).
  getSyncStatus(): Promise<SyncStatus>;
  syncDrainNow(): Promise<SyncStatus>;
  listFailedSync(limit?: number): Promise<SyncQueueRow[]>;
  retryFailedSync(): Promise<{ retried: number }>;
  clearFailedSync(): Promise<{ cleared: number }>;
  /** Push every existing local session to qparking — one-shot recovery
   *  for sessions that pre-date the auto-sync wiring. */
  backfillSessions(): Promise<{ entries: number; exits: number }>;

  // Settings
  getSettings(): Promise<AppSettings>;
  saveSettings(s: Partial<AppSettings>): Promise<AppSettings>;

  // Gate simulator
  openGateSimulator(): Promise<void>;
  testGate(opts?: { plate?: string; direction?: 'in'|'out'|'test'; laneName?: string }): Promise<void>;

  // Face-auth turnstile bridge (faceapp_main /api/external/*)
  pingFaceGate(): Promise<{ ok: boolean; status?: number; error?: string; body?: unknown }>;
  openFaceGate(opts?: { plate?: string; reason?: string }): Promise<{ ok: boolean; status?: number; error?: string; body?: unknown }>;

  // Stream events to renderer (returns an unsubscribe fn)
  onEvent(channel: 'terminal-status' | 'session' | 'log' | 'plate-detected' | 'gate-state' | 'sync-status' | 'parking-flow-log', cb: (payload: unknown) => void): () => void;
}
