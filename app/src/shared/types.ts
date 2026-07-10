/**
 * Types shared between the main (Node/Electron) and renderer (React) processes.
 * Keep zero runtime dependencies in this file — it must be safely importable
 * from both sides.
 *
 * Split by role:
 *   db-models.ts → SQLite table row shapes (re-exported here, so importing
 *                  from './types' keeps working everywhere)
 *   this file    → runtime status objects, wire-protocol envelopes, and the
 *                  BridgeApi contract that types `window.bridge`
 */
export * from './db-models';

import type {
  ActivePass,
  AppSettings,
  LprCamera,
  ParkingLane,
  ParkingSession,
  ParkingSpace,
  PaymentTerminal,
  ScopeRate,
  SyncQueueRow,
} from './db-models';

// ─── runtime status objects (never persisted) ────────────────────────────────

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

// ─── wire protocol ───────────────────────────────────────────────────────────

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

// ─── the bridge contract ─────────────────────────────────────────────────────

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
  listSessionsPage(opts: {
    tab: 'open' | 'recent';
    limit: number;
    offset: number;
    /** Case-insensitive contains-match on plate — for reconciling
     *  mis-read exits ("ABC" entry vs "ABX" exit). */
    plateSearch?: string | null;
    /** ISO datetime range on entry_at (inclusive). */
    entryFrom?: string | null;
    entryTo?: string | null;
    /** ISO datetime range on exit_at (inclusive). */
    exitFrom?: string | null;
    exitTo?: string | null;
  }): Promise<{
    rows: ParkingSession[];
    counts: { open: number; total: number };
  }>;
  /** Manually retrigger the exit payment flow for a stuck session. Fires
   *  the terminal (ECPI initCard + W4G PayRequest race) using the lane +
   *  terminal wired to the session's lane. Returns immediately; the actual
   *  card tap resolves asynchronously through the normal parking-flow. */
  retriggerSessionPayment(id: number): Promise<{ ok: boolean; error?: string }>;
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

  // Mirrored config from qparking SaaS (read-only locally)
  listSpaces(): Promise<ParkingSpace[]>;
  syncSpacesNow(): Promise<{ ok: boolean; fetched: number; error?: string }>;
  /** Read every active pass cached from the cloud. Already populated by the
   *  periodic syncPasses(); this just lets the UI display them. */
  listActivePasses(): Promise<ActivePass[]>;

  // Scopes / rates
  listScopes(): Promise<ScopeRate[]>;
  syncScopesNow(): Promise<{ ok: boolean; fetched: number; error?: string }>;

  syncAllNow(): Promise<{
    scopes: { ok: boolean; fetched: number; error?: string };
    passes: { ok: boolean; fetched: number; error?: string };
    spaces: { ok: boolean; fetched: number; error?: string };
  }>;

  /** Push a rate edit to qparking SaaS, then re-pull. The SaaS becomes the
   *  source of truth; the local cache reflects whatever it canonicalised. */
  saveScopeRate(input: {
    firstBlockCents: number; perBlockCents: number;
    blockMinutes: number; freeMinutes: number; dailyCapCents: number;
  }): Promise<{ ok: boolean; fetched: number; error?: string }>;
  /** "Test price" — simulate a rate plan's fee for an entry→exit window. */
  simulateScopeFee(input: { scopeId: string; entry: string; exit: string }): Promise<{
    ok: boolean; feeCents?: number; durationMinutes?: number;
    scopeName?: string; currency?: string; error?: string;
  }>;

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

  // Settings + diagnostics
  getSettings(): Promise<AppSettings>;
  saveSettings(s: Partial<AppSettings>): Promise<AppSettings>;
  /** LPR listener health — bound port, LAN addresses cameras can reach, camera count. */
  diagnoseLpr(): Promise<{ port: number; addresses: string[]; cameras: number }>;

  // Gate simulator
  openGateSimulator(): Promise<void>;
  testGate(opts?: { plate?: string; direction?: 'in'|'out'|'test'; laneName?: string }): Promise<void>;

  // Face-auth turnstile bridge (faceapp_main /api/external/*)
  pingFaceGate(): Promise<{ ok: boolean; status?: number; error?: string; body?: unknown }>;
  openFaceGate(opts?: { plate?: string; reason?: string }): Promise<{ ok: boolean; status?: number; error?: string; body?: unknown }>;

  // App self-update — checks qparking cloud /latest-built endpoint.
  /** Probe the cloud for a newer published build. Reads version from
   *  package.json on this side, compares semver-style, returns the manifest. */
  appUpdateCheck(): Promise<{
    ok: boolean;
    currentVersion: string;
    latestVersion?: string;
    isNewer?: boolean;
    releasedAt?: string | null;
    notes?: string | null;
    portable?: { filename: string; size: number | null; sha256: string | null; url: string } | null;
    installer?: { filename: string; size: number | null; sha256: string | null; url: string } | null;
    error?: string;
  }>;
  /** Download the chosen variant (portable | installer) to a temp file and
   *  return its absolute path. Streams progress via 'app-update-progress'
   *  event so the renderer can show a bar. */
  appUpdateDownload(opts: { variant: 'portable' | 'installer' }): Promise<{
    ok: boolean;
    path?: string;
    bytes?: number;
    sha256?: string;
    error?: string;
  }>;
  /** Launch the downloaded build via the OS and quit the current app so the
   *  installer/portable can replace it. For NSIS this triggers the standard
   *  Windows installer wizard; for portable it just opens the new exe. */
  appUpdateApply(opts: { path: string }): Promise<{ ok: boolean; error?: string }>;

  // Touch'n'Go W4G IO-controller bridge
  /** Probe the W4G device: TCP-connect on the configured host:port. Doesn't
   *  send PayRequest — just verifies reachability for the Settings page. */
  tngPing(): Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
  /** Send GET / to the device and return status + headers + first 400 bytes
   *  of body. Lets the operator see whether the box is speaking HTTP at all
   *  on the configured IP+port, independent of the W4G API surface. */
  tngProbeHttp(): Promise<{
    ok: boolean;
    status?: number;
    statusText?: string;
    headers?: Record<string, string | string[] | undefined>;
    bodyPreview?: string;
    elapsedMs?: number;
    error?: string;
  }>;
  /** POST a synthetic PayResult into our own listener to verify the receive
   *  path works end-to-end. If this passes but real device callbacks don't
   *  land, the issue is purely device-side (URL config / firewall). */
  tngLoopbackPayResult(opts?: { orderId?: string; state?: string; payType?: number; cardNo?: string; balance?: number }): Promise<{
    ok: boolean;
    status?: number;
    responseBody?: string;
    elapsedMs?: number;
    sentBody?: string;
    error?: string;
  }>;
  /** Fire a one-shot PayRequest and wait for the PayResult callback. Used
   *  by the Settings "Test" trigger to exercise the full round-trip without
   *  opening a real parking session. Defaults: 100c, no discount, now. */
  tngTestPayRequest(opts?: {
    payAmount?: number;
    discountAmount?: number;
    enterTime?: number;
    payTime?: number;
    orderId?: string;
  }): Promise<{ ok: boolean; orderId: string; deviceState?: number; resultState?: string; payType?: number; cardNo?: string; balance?: number; stan?: string; apprCode?: string; error?: string }>;
  /** Fire PayCancel against an order. The device only honours cancel after
   *  the current deduction times out (~6s per vendor doc). */
  tngTestPayCancel(orderId: string): Promise<{ ok: boolean; deviceState?: number; error?: string }>;
  /** Current state of the W4G integration — running, pending orders, last
   *  callback at, last error. Used by the Settings page status panel. */
  tngStatus(): Promise<{
    enabled: boolean;
    listening: boolean;
    listenPort: number;
    listenPorts: number[];
    listenAddresses: string[];
    host: string;
    port: number;
    pending: { orderId: string; payAmount: number; startedAt: string }[];
    lastResult?: { orderId: string; status: string; payType?: number; at: string };
    lastError?: string;
  }>;

  // Stream events to renderer (returns an unsubscribe fn)
  onEvent(channel: 'terminal-status' | 'session' | 'log' | 'plate-detected' | 'gate-state' | 'sync-status' | 'parking-flow-log' | 'app-update-progress', cb: (payload: unknown) => void): () => void;
}

/**
 * Make `window.bridge` fully typed in the RENDERER. This file is included by
 * the renderer tsconfig, so every React page gets autocomplete + type-checking
 * on bridge calls. The implementation side is enforced in preload.ts, which
 * declares its `api` object as `BridgeApi` — if the two ever drift, the main
 * build fails instead of the renderer crashing at runtime.
 */
declare global {
  interface Window { bridge: BridgeApi }
}
