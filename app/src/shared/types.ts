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
  SeasonPass,
  AppSettings,
  LprCamera,
  ParkingLane,
  ParkingSession,
  ParkingSpace,
  PaymentTerminal,
  RatePolicy,
  Site,
  SyncQueueRow,
} from './db-models';

// ─── runtime status objects (never persisted) ────────────────────────────────

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

/** Per-item outcome of pushing one local equipment row up to the cloud
 *  registry (lane / terminal / camera), surfaced in the Settings sync report. */
export interface EquipmentPushItem {
  id: number;
  name: string;
  ok: boolean;
  /** True when the push was intentionally skipped (e.g. the lane has no rate
   *  policy), rather than a genuine failure — rendered as a warning, not error. */
  skipped?: boolean;
  error?: string;
}

// ─── the bridge contract ─────────────────────────────────────────────────────

/** What the bridge exposes to the renderer. Every method returns a Promise. */
export interface BridgeApi {
  // Payment terminals (Alarmtech W4G devices) — CRUD
  listTerminals(): Promise<PaymentTerminal[]>;
  saveTerminal(input: Omit<PaymentTerminal, 'id' | 'createdAt' | 'updatedAt'> & { id?: number }): Promise<PaymentTerminal>;
  deleteTerminal(id: number): Promise<void>;
  /** TCP reachability probe by host:port — backs the per-device "Test
   *  connection" button (works against the form values before saving). */
  pingTerminalHost(input: { host: string; port: number }): Promise<{ ok: boolean; latencyMs?: number; error?: string }>;

  // LPR cameras
  listCameras(): Promise<LprCamera[]>;
  saveCamera(input: Omit<LprCamera, 'id' | 'createdAt' | 'updatedAt'> & { id?: number }): Promise<LprCamera>;
  deleteCamera(id: number): Promise<void>;
  /** Latest frame the camera PUSHED with a plate event (base64 JPEG). Live
   *  display fallback for WebSocket/RTSP-only cameras with no snapshot URL.
   *  Null until the camera has pushed at least one frame. */
  getCameraLatestFrame(cameraId: number): Promise<{ base64: string; contentType: string; at: string } | null>;
  /** Probe TCP/HTTP reachability — used by the "Test connection" button. */
  pingCamera(cameraId: number): Promise<{ ok: boolean; status?: number; latencyMs?: number; error?: string }>;
  /** Probe reachability by host:port directly — lets "Test connection" run
   *  against the form values before the camera is saved. */
  pingCameraHost(input: { host: string; port?: number }): Promise<{ ok: boolean; status?: number; latencyMs?: number; error?: string }>;

  // Lanes
  listLanes(): Promise<ParkingLane[]>;
  /** The lane is the composition root: it owns which cameras cover it
   *  (`cameraIds` → each camera's lane_id) and which payment terminal it
   *  charges on (`terminalId`). Passing `cameraIds` reassigns exactly that
   *  set of cameras to this lane and unassigns any others previously on it. */
  saveLane(input: Omit<ParkingLane, 'id'> & { id?: number; cameraIds?: number[] }): Promise<ParkingLane>;
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
    /** Exact payment-status match (paid / pending / declined / …). */
    paymentStatus?: string | null;
  }): Promise<{
    /** Open rows carry `livePreviewFeeCents` — the current fee computed
     *  server-side with the real rules-aware calc (the UI can't run it). */
    rows: Array<ParkingSession & { livePreviewFeeCents?: number | null }>;
    counts: { open: number; total: number };
  }>;
  /** Manually retrigger the exit payment flow for a stuck session. Fires
   *  the terminal (ECPI initCard + W4G PayRequest race) using the lane +
   *  terminal wired to the session's lane. Returns immediately; the actual
   *  card tap resolves asynchronously through the normal parking-flow. */
  retriggerSessionPayment(id: number, laneId?: number | null): Promise<{ ok: boolean; error?: string }>;
  /** Retrigger exit payment for whichever open session holds this plate — the
   *  Live-display action where the operator types the plate off the feed.
   *  `laneId` is the exit lane the operator triggered from, so the exit runs on
   *  that gate's controller. */
  retriggerSessionPaymentByPlate(plate: string, laneId?: number | null): Promise<{ ok: boolean; error?: string }>;
  /** DEV/QA: fire a synthetic plate event on a lane (resolving an enabled
   *  camera on it) with a forced direction, exercising the real parking flow
   *  end-to-end. Backs the hidden Sessions lane simulator. */
  simulateLaneEvent(laneId: number, plate: string, direction: 'entry' | 'exit'): Promise<{ ok: boolean; error?: string; cameraId?: number }>;
  /** DEV/QA: record a completed session over an explicit entry→exit window
   *  (local only; computes the fee from the lane's plan). Backs the Sessions
   *  simulator's "Simulate session" mode. */
  simulateSession(laneId: number, plate: string, entryIso: string, exitIso: string): Promise<{
    ok: boolean; error?: string; sessionId?: number; durationMinutes?: number;
    feeCents?: number; scopeName?: string; currency?: string; paymentStatus?: string;
  }>;
  /** DEV/QA: open a session stamped with a chosen entry time (no gate/terminal). */
  simulateEntry(laneId: number, plate: string, entryIso: string): Promise<{ ok: boolean; error?: string; sessionId?: number }>;
  /** DEV/QA: run the real exit flow (fee + terminal) at a chosen exit time. */
  simulateExit(laneId: number, plate: string, exitIso: string): Promise<{ ok: boolean; error?: string; cameraId?: number }>;
  /** Read a session capture (entry/exit image) off disk as base64 for display —
   *  the renderer can't load the raw file:// path over its http/app origin. */
  readSessionImage(filePath: string): Promise<{ base64: string; contentType: string } | null>;
  deleteSession(id: number): Promise<boolean>;
  deleteSessionsBulk(opts: { ids?: number[]; tab?: 'open' | 'recent' | 'all' }): Promise<{ deleted: number }>;
  manualReleaseSession(id: number, reason: string, laneId?: number | null): Promise<void>;
  updateSession(id: number, patch: {
    plate?: string;
    entryAt?: string;
    exitAt?: string | null;
    paymentStatus?: 'pending'|'paid'|'declined'|'cancelled'|'free'|'manual_release';
    notes?: string;
    policyIdOverride?: string | null;
  }): Promise<ParkingSession>;

  // Mirrored config from qparking SaaS (read-only locally)
  listParkingSpaces(): Promise<ParkingSpace[]>;
  syncParkingSpacesNow(): Promise<{ ok: boolean; fetched: number; error?: string }>;
  /** Read every active pass cached from the cloud. Already populated by the
   *  periodic syncSeasonPasses(); this just lets the UI display them. */
  listSeasonPasses(): Promise<SeasonPass[]>;

  // Rate policies
  listRatePolicies(): Promise<RatePolicy[]>;
  syncRatePoliciesNow(): Promise<{ ok: boolean; fetched: number; error?: string }>;

  syncAllNow(): Promise<{
    policies: { ok: boolean; fetched: number; error?: string };
    passes: { ok: boolean; fetched: number; error?: string };
    spaces: { ok: boolean; fetched: number; error?: string };
    site: { ok: boolean; fetched: number; error?: string };
    /** Local equipment pushed UP to the cloud registry, per item. */
    equipment: {
      lanes: EquipmentPushItem[];
      terminals: EquipmentPushItem[];
      cameras: EquipmentPushItem[];
    };
  }>;

  /** The site profile mirrored from qparking SaaS (one site per install).
   *  Populated by the periodic syncSite(); null until the first sync lands. */
  getCurrentSite(): Promise<Site | null>;

  debug(): Promise<any>;

  /** Push a rate edit to qparking SaaS, then re-pull. The SaaS becomes the
   *  source of truth; the local cache reflects whatever it canonicalised. */
  saveRatePolicy(input: {
    firstBlockCents: number; perBlockCents: number;
    blockMinutes: number; freeMinutes: number; dailyCapCents: number;
  }): Promise<{ ok: boolean; fetched: number; error?: string }>;
  /** "Test price" — simulate a rate plan's fee for an entry→exit window. */
  simulateRatePolicyFee(input: { policyId: string; entry: string; exit: string }): Promise<{
    ok: boolean; feeCents?: number; durationMinutes?: number;
    policyName?: string; currency?: string; error?: string;
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
  /** Operator "open barrier" for a lane/camera from the Live display —
   *  raises the gate (simulator + face turnstile). */
  manualOpenGate(opts: { cameraId?: number | null; laneId?: number | null }): Promise<{ ok: boolean; note?: string }>;

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
    /** Target a specific device (multi-device); omitted → the settings device. */
    host?: string;
    port?: number;
  }): Promise<{ ok: boolean; orderId: string; deviceState?: number; resultState?: string; payType?: number; cardNo?: string; balance?: number; stan?: string; apprCode?: string; error?: string }>;
  /** Fire PayCancel against an order. The device only honours cancel after
   *  the current deduction times out (~6s per vendor doc). */
  tngTestPayCancel(orderId: string, target?: { host?: string; port?: number }): Promise<{ ok: boolean; deviceState?: number; error?: string }>;
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
  onEvent(channel: 'session' | 'log' | 'plate-detected' | 'gate-state' | 'sync-status' | 'parking-flow-log' | 'app-update-progress', cb: (payload: unknown) => void): () => void;
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
