/**
 * Electron main process — single instance, one window, BackgroundService-style
 * IPC handlers. All long-lived background work (TCP terminals, LPR webhook
 * server, qparking sync) lives in here so the UI window can be closed without
 * stopping the parking flow. Re-opening the window just reconnects to the
 * already-running services.
 */
// MUST be first — pins the fee-calc timezone to the site's zone (GMT+8)
// before any other module loads or any Date runs. See ./tz.
import './tz';
import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, session } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type { ActivityLogPayload, ActivityLogResourceType } from '../shared/types';

// ─── userData isolation (dev vs packaged) ──────────────────────────────────
// In packaged builds Electron derives userData from package.json's productName.
// In `npm run dev` the host process is just `electron.exe`, so app.getName()
// defaults to "Electron" and userData lands in %APPDATA%/Electron — a dir
// shared with EVERY other Electron app a developer has touched on this box.
// That shared dir caches cookies, localStorage, and (worst of all) Service
// Workers per-origin.
//
// We use SEPARATE userData paths for dev vs packaged:
//   Packaged install → %APPDATA%/qparking-local/
//   Dev (npm run dev) → %APPDATA%/qparking-local-dev/
//
// This gives us two big wins:
//   1. Single-instance lock doesn't collide — a developer can run `npm run
//      dev` while the installed portable is still handling the real gate
//      in the background. Before this split, the dev Electron would call
//      app.quit() immediately because requestSingleInstanceLock() returned
//      false, and the developer saw an unexplained exit code 0.
//   2. Dev experiments (test terminals, mock cameras, synthetic sessions)
//      don't pollute the production DB the packaged portable is running.
//
// Set the name BEFORE anyone reads getPath('userData'). One-shot migration
// below copies the SQLite DB across so existing terminals/cameras/sessions
// follow the operator to the new isolated path.
const IS_DEV_MODE = !app.isPackaged;
app.setName(IS_DEV_MODE ? 'qparking-local-dev' : 'qparking-local');
migrateUserData();

/**
 * Idempotent userData migration. Handles three transitions:
 *   1. Legacy %APPDATA%/Electron/ (pre-v0.14.1) → current userData
 *   2. Packaged %APPDATA%/qparking-local/ → %APPDATA%/qparking-local-dev/
 *      (only in dev mode, so a developer's first dev launch gets the same
 *      data the installed portable has been accumulating)
 * Both copies are best-effort and one-shot — after the first successful
 * copy the target file exists, subsequent boots skip.
 */
function migrateUserData() {
  try {
    const newDir = app.getPath('userData');
    const parent = path.dirname(newDir);
    const sources = [
      path.join(parent, 'Electron'),                       // very old default
      IS_DEV_MODE ? path.join(parent, 'qparking-local') : null,  // packaged → dev
    ].filter((p): p is string => p !== null && p !== newDir);

    fs.mkdirSync(newDir, { recursive: true });
    for (const src of sources) {
      // Copy ONLY the .db — never the -wal/-shm sidecars. Those journal files
      // are meaningful only when paired with the exact .db they were written
      // from; copying them across databases (or independently of the .db)
      // replays foreign schema pages on open and corrupts the target with
      // "malformed database schema … invalid rootpage". SQLite recreates a
      // fresh -wal/-shm on first open, so the .db alone is sufficient. Any
      // un-checkpointed data in the source WAL is intentionally left behind —
      // a lossless seed would require checkpointing the source first, which
      // isn't worth it for this one-shot dev convenience copy.
      const from = path.join(src, 'qparking-local.db');
      const to = path.join(newDir, 'qparking-local.db');
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        fs.copyFileSync(from, to);
        console.log(`[boot] migrated qparking-local.db from ${src} → ${newDir}`);
      }
    }
  } catch (e: any) {
    console.warn(`[boot] userData migration skipped: ${e?.message ?? e}`);
  }
}
import {
  getDb, getSettings, saveSettings,
  listTerminals, upsertTerminal, deleteTerminal,
  listLcds, upsertLcd, deleteLcd,
  listCameras, upsertCamera, deleteCamera, getCamera,
  listLanes, upsertLane, deleteLane, getLane, setLaneCameras,
  listOpenSessions, listRecentSessions, manualReleaseSession, getSessionById, findOpenSessionByPlate, sessionHasPaidTransaction,
  countSessions, listSessionsPage, deleteSession,
  listSessionsNeedingCloudPush, countSessionsNeedingCloudPush,
  updateSessionFields,
  getTransactionById, getOpenTransactionForSession, updateTransaction,
  listTransactionsPage, countTransactions,
  listRatePolicies, getRatePolicy, getSiteDefaultRatePolicy,
  listParkingSpaces, listSeasonPasses, listCloudCustomers, listCloudVehicles,
  findSeasonPassByPlate, findSeasonPassById, listBlockedPlates,
  getCurrentSite, getSite, getBoundSiteId, resetLocalDataForRebind, closeDb,
  listActivityLogs, countActivityLogs, insertActivityLog, dayTotals, reconcileOrphanedTransactions,
  pruneTerminalLog, pruneActivityLogs, pruneOldPlateImages,
} from './services/db';
import { computeFee, stayDurationMinutes, retriggerSessionExit, retriggerSessionExitByPlate, simulateRatePolicyFee, simulateEntryAt, simulateExitAt, admitVehicleByOperator, cancelExitInFlight, startParkingFlow, parkingEvents, laneCameraFacing, shouldRepriceEditedSession, findExitInFlightBySession, findExitInFlightByLane } from './services/parking-flow';
import { canonicalPlate } from '../shared/plate';
import { startLprServers, stopLprServers, lprEvents, getLatestFrame } from './services/lpr-webhook';
import {
  syncRatePolicies, syncParkingSpaces, syncSeasonPasses, syncBlockedPlates,
  syncCloudCustomers, syncCloudVehicles,
  syncAll, fetchSiteWith,
  cloudPullEvents, getCloudPullState,
  pushActivityLogsToCloud,
  autoSync, stopAutoSync,
} from './services/cloud-sync';
import { describeRequestError } from './services/cloud-api';
import {
  startSyncDrain, syncEvents, getSyncStatus, drainNow,
  enqueueEntry, enqueueExit, enqueueUpdate, enqueueDelete, enqueueTransaction,
  backfillAllSessions, backfillAllTransactions,
} from './services/cloud-queue';
import { retryAllFailedSync } from './services/db';
import { pingCamera, pingHost } from './services/camera-probe';
import { pingTerminalHost } from './services/payment-probe';
import { startLcdDisplays, stopLcdDisplays, reloadLcdLinks, getLcdStatuses, testLcd, showManualReleaseOnLane, clearFareForSession } from './services/lcd-display';
import { startCameraRelay, stopCameraRelay, resync as resyncCameraRelay, pulseBarrier, isSdkLoaded } from './services/camera-relay';
import {
  startDeviceHealth, stopDeviceHealth, sweepDeviceHealth, snapshotDeviceHealth, deviceHealthEvents,
} from './services/device-health';
import { startHealthHeartbeat, stopHealthHeartbeat, postHeartbeat, getHeartbeatState } from './services/health-heartbeat';
import { startRtspGrabbers, stopRtspGrabbers, resync as resyncRtspGrabbers, restartFeeds as restartRtspFeeds } from './services/camera-rtsp';
import { previewDeviceSync, pushDevicesToCloud, pullDevicesFromCloud, type DeviceType } from './services/device-sync';
import {
  startW4gServer, stopW4gServer, payRequest as tngPayRequest, payCancel as tngPayCancel,
  loopbackPayResult as tngLoopback,
  payResultListenerReady,
  w4gStatus, w4gEvents,
} from './services/payment-tng';
import { checkForUpdate, downloadUpdate, applyUpdate } from './app-update';

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => { showWindow(); });

app.whenReady().then(async () => {
  getDb(); // open the DB up-front so the schema is applied before anything queries it.

  // Wire the event fan-out FIRST. It used to run near the end of boot, after the
  // listeners had already been started — so a listener that failed to bind at
  // boot (the most likely moment for it) emitted its failure into an empty room
  // and the audit row was lost. Registering listeners touches nothing but
  // EventEmitters; sendToRenderer already no-ops until the window exists.
  wireRendererEvents();

  const settings = getSettings();
  // Bookend for the log: every restart is visible, which is what makes a GAP in
  // the trail readable ("the box was down", not "nothing happened"), and pins
  // the running build — the counterpart to app.update.applied.
  audit({
    eventKey: 'app.started',
    action: 'access',
    category: 'lifecycle',
    severity: 'low',
    outcome: 'ok',
    resourceType: 'app_settings',
    description: `qparking-local ${app.getVersion()} started (${IS_DEV_MODE ? 'dev' : 'packaged'})`
      + ` · TNG ${settings.tngEnabled ? 'on' : 'off'}`,
    changes: { version: app.getVersion(), dev: IS_DEV_MODE, tngEnabled: !!settings.tngEnabled },
  });
  // One listener per port the cameras push to (each camera carries its own; the
  // 6001 default is always bound). Dev and packaged builds bind the same set, so
  // a camera works the same either way — and if a packaged install is already
  // running when you start `npm run dev`, the dev bind fails with EADDRINUSE,
  // which startLprServers() reports and survives rather than crashing.
  // Close out payment attempts a dead process left 'pending' — after a crash or
  // restart mid-charge, the awaiting promise is gone and no PayResult can ever
  // settle them. Done BEFORE the flow starts so the ledger is honest from the
  // first car. Same caveat as a timeout: if the tap actually went through, the
  // callback was lost and the device is the authority.
  const orphanedTxns = reconcileOrphanedTransactions();
  if (orphanedTxns.length > 0) {
    audit({
      eventKey: 'payment.orphans_reconciled',
      action: 'payment',
      category: 'payment',
      severity: 'high',
      outcome: 'failed',
      resourceType: 'transaction',
      description: `${orphanedTxns.length} payment attempt(s) were still 'pending' from before this restart — marked failed. `
        + `The charges cannot still be in flight (the process awaiting them is gone). `
        + `⚠️ If a driver DID tap during the outage, the money moved without a record here — check the device log. `
        + `Attempts: ${orphanedTxns.map((t) => `#${t.id} session ${t.sessionId} ${rm(t.amountCents)}${t.orderId ? ` order ${t.orderId.slice(0, 8)}…` : ''}`).join(' · ')}`,
      changes: { count: orphanedTxns.length, transactionIds: orphanedTxns.map((t) => t.id) },
    });
  }
  const lprPorts = startLprServers();
  console.log(`[boot] mode=${IS_DEV_MODE ? 'dev' : 'packaged'} · LPR listeners → :${lprPorts.join(', :')}`);
  startParkingFlow();
  // Driver-facing LCD panels. Started AFTER the parking flow because it
  // subscribes to that module's events; it opens its own outbound TCP links and
  // never blocks anything the flow does.
  startLcdDisplays();
  // Cloud pull at boot, then hand over to autoSync()'s recurring pull (cadence
  // from company_settings.sync_interval_minutes, which this first pull is what
  // fetches — hence boot-pull-then-arm rather than arming straight away). The
  // local SQLite cache persists across restarts, so a failed boot pull just
  // leaves the gate pricing and gating from the last successful sync until the
  // next tick or a manual "Sync now".
  void syncAll().catch(() => null).then(() => autoSync());
  startSyncDrain();
  // W4G PayResult callback listener — only start when the operator has
  // enabled the TNG integration. Toggling it on/off in Settings restarts
  // it via the settings:save handler below.
  if (settings.tngEnabled) startW4gServer();
  // Equipment (cameras / lanes / terminals) is NOT auto-pushed on boot anymore.
  // It syncs manually, per type, from each device page's Push/Pull-to-cloud
  // buttons — so a freshly-installed empty box can never mirror-delete the
  // cloud's devices, and nothing leaves this PC without an explicit action.

  // Live-display video + plate snapshots come from the RTSP/ffmpeg feed
  // (camera-rtsp) — camera IP only. The VZ SDK now holds a warm handle per
  // credentialed camera solely so an operator "Open barrier" pulses the camera's
  // onboard relay instantly.
  startRtspGrabbers();
  startCameraRelay();
  // Reachability monitoring. LAST of the device services on purpose: its first
  // sweep reads the LCD links and the camera relay's warm handles, so starting it
  // before them would report a site full of offline equipment for one tick.
  startDeviceHealth();
  // Report that health up to the cloud. Started after the monitor so its first
  // post carries a real snapshot rather than an empty one.
  startHealthHeartbeat();
  // Housekeeping last: it only reads and deletes, and its first pass should see
  // whatever the boot pull has already written.
  startRetentionSweep();

  createWindow();
  createTray();
});

/**
 * Shut the background services down. Includes the LPR listeners, which used to be
 * left bound: on a quit that doesn't fully terminate (see forceQuit) they are the
 * thing that keeps the ports occupied.
 */
function stopBackgroundServices() {
  try { stopAutoSync(); } catch { /* ignore */ }
  try { stopRtspGrabbers(); } catch { /* ignore */ }
  try { stopCameraRelay(); } catch { /* ignore */ }
  try { stopLprServers(); } catch { /* ignore */ }
  try { stopLcdDisplays(); } catch { /* ignore */ }
  try { stopDeviceHealth(); } catch { /* ignore */ }
  try { stopHealthHeartbeat(); } catch { /* ignore */ }
  try { stopRetentionSweep(); } catch { /* ignore */ }
}

/** Any quit route that isn't the tray's — Windows shutdown, a task-manager close,
 *  macOS Cmd-Q. Teardown only: forceQuit() handles the rest for the tray. */

app.on('before-quit', stopBackgroundServices);

/**
 * Quit for real.
 *
 * Once the vendor LPR SDK is loaded, app.exit(0) does NOT terminate this process:
 * it hangs inside teardown (koffi loads VzLPRSDK.dll, and we deliberately never
 * call its Cleanup because that segfaults). Measured — and the event loop is
 * already dead at that point, so a setTimeout backstop after app.exit() can never
 * fire. The decision has to be made BEFORE.
 *
 * That matters because a process left alive still holds this box's LPR listener
 * ports: the operator's next launch binds nothing and the box is silently deaf to
 * every camera — plates read, boom never moves, no error on any screen.
 *
 * So: tear down cleanly (which is what releases the ports and flushes the DB),
 * then exit the normal way when that is known to work, and TERMINATE when it
 * isn't. SIGKILL to our own pid is immediate and skips the native teardown that
 * hangs; nothing is lost, because every DB write is committed synchronously and
 * closeDb() has just checkpointed.
 */
function forceQuit() {
  stopBackgroundServices();
  closeDb();
  if (isSdkLoaded()) {
    console.log('[quit] vendor SDK loaded — terminating rather than exiting (app.exit hangs in native teardown)');
    process.kill(process.pid, 'SIGKILL');
    return;
  }
  app.exit(0);
}

app.on('window-all-closed', () => {
  // Keep the process alive on Windows so the background services keep running.
  // The tray gives the operator a way to reopen the window. Only quit on macOS
  // when the user explicitly does so.
  if (process.platform === 'darwin') app.quit();
});

function createWindow() {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); return; }
  mainWindow = new BrowserWindow({
    width: 1280, height: 800,
    minWidth: 1024, minHeight: 680,
    title: 'QParking Local Server',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    // Docked DevTools (bottom panel) — fits inside the same window so you
    // can resize the app and the inspector side-by-side. Switch to 'right'
    // or 'undocked' from the DevTools menu if you prefer.
    mainWindow.webContents.openDevTools({ mode: 'bottom' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }
  mainWindow.on('closed', () => { mainWindow = null; });
}

function showWindow() { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } else { createWindow(); } }

function createTray() {
  try {
    const icon = nativeImage.createEmpty();
    tray = new Tray(icon);
    tray.setToolTip('QParking Local Server');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open dashboard', click: showWindow },
      { type: 'separator' },
      { label: 'Quit', click: forceQuit },
    ]));
    tray.on('double-click', showWindow);
  } catch { /* tray fails on some Linux DEs — non-fatal */ }
}

// ─── renderer event fan-out ────────────────────────────────────────────────

/**
 * Raise the physical barrier for an event this app authorised.
 *
 * Called ONLY from the two authorised outcomes — a created entry session, and an
 * exit that settled as paid / free / manual_release. Every refusal path emits a
 * 'warning' instead and never reaches here, so "was this car allowed through?"
 * is answered by which event fired, not by a flag on the payload.
 *
 * There is no per-camera opt-out: this app receives the plate event, makes the
 * decision, and opens the boom. (A `barrier_control` setting briefly existed for
 * sites whose camera firmware auto-opened; it defaulted to leaving the barrier
 * alone, which just meant the gate never moved. Removed 2026-08-07 — switch the
 * camera's own auto-open off instead.)
 *
 * Best-effort by design: a failed pulse is logged for the operator but never
 * throws, because a dead relay must not take down the session flow. The usual
 * cause is missing device credentials, which describeCameraRisk() flags on the
 * Cameras page.
 *
 * Async, and deliberately NOT awaited by its callers: the session row is already
 * written and the decision already made, so the boom is raised alongside the rest
 * of the entry/exit bookkeeping rather than in front of it. On a warm relay that
 * is one tick; on a cold one it is a socket probe (see pulseBarrier).
 */
async function pulseBarrierFor(payload: any, side: 'entry' | 'exit'): Promise<void> {
  const cameraId = payload?.cameraId ?? payload?.event?.cameraId ?? payload?.session?.entryCameraId;
  if (!cameraId) return;
  const relay = await pulseBarrier(cameraId);
  sendToRenderer('log', {
    terminalId: 0,
    direction: relay.ok ? 'info' : 'error',
    message: relay.ok
      ? `Barrier opened for an authorised ${side} (camera ${cameraId})`
      : `Barrier pulse FAILED on ${side} (camera ${cameraId}): ${relay.error ?? 'unknown'} — the driver is authorised but the gate did not move. Check the camera's host / username / password.`,
    payload: { cameraId, side, relay },
  });
  // Only the FAILURE is audited. A successful pulse is already implied by the
  // session.entry / session.exit row it accompanies, whereas a failed one is the
  // gap between "the app authorised this car" and "the car could actually move"
  // — and on a paid exit, the driver has already been charged.
  if (relay.ok) return;
  audit({
    eventKey: 'gate.barrier.pulse_failed',
    action: side === 'entry' ? 'entry' : 'exit',
    category: 'gate',
    severity: 'critical',
    outcome: 'failed',
    resourceType: 'camera_device',
    resourceId: String(cameraId),
    description: `Barrier did NOT open for an authorised ${side} on "${getCameraName(cameraId)}" — ${relay.error ?? 'unknown relay error'}.`
      + (side === 'exit' ? ' The driver has already paid and is sitting at a closed boom.' : ' The driver was admitted but the boom stayed down.')
      + " Check the camera's host / username / password.",
    changes: { cameraId, side, relayError: relay.error ?? null },
  });
}

// ─── retention sweep ───────────────────────────────────────────────────────
// Horizons agreed with the site (leaner preset). Sessions and transactions are
// deliberately absent: they are the revenue record and are never pruned here.
const RETENTION = {
  /** terminal_log — pure diagnostics, and the chattiest table in the schema. */
  deviceLogDays: 7,
  /** Captured plate JPEGs. Anything still awaiting a cloud push is kept
   *  regardless of age — see pruneOldPlateImages. */
  plateImageDays: 30,
  /** activity_logs. Local rows the cloud has not acked are kept regardless. */
  auditDays: 90,
};
const RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60_000;
let retentionTimer: NodeJS.Timeout | null = null;

/**
 * Reclaim disk. Runs once at boot and daily after.
 *
 * Best-effort and never allowed to throw: a housekeeping failure must not be able
 * to stop a barrier. Only reported when it actually removed something, so a quiet
 * box does not write a row a day saying "nothing to do".
 */
function sweepRetention(): void {
  try {
    const logRows = pruneTerminalLog(RETENTION.deviceLogDays);
    const auditRows = pruneActivityLogs(RETENTION.auditDays);
    const images = pruneOldPlateImages(RETENTION.plateImageDays);
    const total = logRows + auditRows + images.deleted;
    if (total === 0) return;
    const mb = (images.bytesFreed / (1024 * 1024)).toFixed(1);
    console.log(`[retention] pruned ${logRows} device-log row(s), ${auditRows} audit row(s), ${images.deleted} plate image(s) (${mb} MB)`);
    audit({
      eventKey: 'app.retention.swept',
      action: 'edit',
      category: 'lifecycle',
      severity: 'low',
      outcome: 'ok',
      resourceType: 'app_settings',
      description: `Housekeeping · removed ${logRows} device-log row(s) over ${RETENTION.deviceLogDays}d,`
        + ` ${auditRows} audit row(s) over ${RETENTION.auditDays}d,`
        + ` and ${images.deleted} plate image(s) over ${RETENTION.plateImageDays}d (${mb} MB freed)`
        + (images.keptPendingUpload > 0 ? ` · ${images.keptPendingUpload} image(s) kept: still awaiting a cloud push` : ''),
      changes: { ...RETENTION, logRows, auditRows, ...images },
    });
  } catch (err) {
    console.error('[retention] sweep failed', err);
  }
}

function startRetentionSweep(): void {
  if (retentionTimer) return;
  sweepRetention();
  retentionTimer = setInterval(sweepRetention, RETENTION_SWEEP_INTERVAL_MS);
  retentionTimer.unref?.();
}

function stopRetentionSweep(): void {
  if (retentionTimer) { clearInterval(retentionTimer); retentionTimer = null; }
}

/** Camera name for an audit description, falling back to its id. */
function getCameraName(cameraId: number): string {
  return listCameras().find((camera) => camera.id === cameraId)?.name ?? `camera ${cameraId}`;
}

/**
 * Write one row to the local Activity Log from the main process.
 *
 * Wrapped for two reasons: the bound site id is the same on every row (nobody
 * should have to remember to pass it), and an audit write must NEVER be able to
 * break the flow that triggered it — a car at a barrier matters more than its
 * paperwork. Field vocabulary is constrained by the cloud's enums (see
 * Enum\ActivityLog\{Action,Category,Severity,ResourceType}): a value they can't
 * map gets the row rejected on push, so stick to the documented sets.
 */
function audit(payload: Omit<ActivityLogPayload, 'siteId'>): void {
  try {
    insertActivityLog({ ...payload, siteId: getBoundSiteId() });
  } catch (err) {
    console.error(`[activity-log] failed to record ${payload.eventKey}`, err);
  }
}

/** RM-formatted fee for audit descriptions — cents are the storage unit, ringgit
 *  is what an operator reading the log expects to see. */
function rm(cents: number | null | undefined): string {
  return `RM ${((cents ?? 0) / 100).toFixed(2)}`;
}

/** Equipment page's plural device type → the cloud's ResourceType vocabulary. */
function deviceResourceType(type: DeviceType): ActivityLogResourceType {
  const byType: Record<DeviceType, ActivityLogResourceType> = {
    cameras: 'camera_device', lanes: 'local_lane', terminals: 'local_terminal', lcds: 'local_lcd',
  };
  return byType[type] ?? 'app_settings';
}

function wireRendererEvents() {
  lprEvents.on('plate', (event) => sendToRenderer('plate-detected', event));
  for (const ev of ['entry', 'exit-pending', 'exit-completed', 'exit-declined', 'warning', 'rescan-ignored', 'entry-ignored-recent-exit', 'capture-attached'] as const) {
    parkingEvents.on(ev, (payload) => sendToRenderer('session', { kind: ev, payload }));
  }

  // A duplicate camera read moments after an exit. Deliberately paints NOTHING on
  // the gate screen: the exit's own COME AGAIN is still up and is exactly what the
  // departing driver should be looking at. Operator-facing log only.
  parkingEvents.on('entry-ignored-recent-exit', (p: any) => {
    sendToRenderer('log', {
      terminalId: 0,
      direction: 'info',
      message: `Duplicate read ignored — ${p?.plate} exited ${p?.secondsSinceExit}s ago (within the ${p?.graceSeconds}s exit grace); no new entry created`,
      payload: p,
    });
  });

  // A session row exists, which means the entry was AUTHORISED — every refusal
  // path (blacklist, pass-only, rescan, exit-grace) emits 'warning' instead and
  // never reaches here. So this is the one place that raises the boom on entry.
  parkingEvents.on('entry', (p: any) => {
    // THIS app authorised the entry, so this app raises the barrier.
    void pulseBarrierFor(p, 'entry');
    // Audit the entry HERE, on the box, at the moment the barrier goes up. The
    // cloud used to be the only writer of this row (on the pushed record), which
    // meant a WAN outage or a not-yet-synced box had no entry history at all.
    const entryLane = p?.session?.entryLaneId ? getLane(p.session.entryLaneId) : null;
    // S7: record whether staff hand-admitted this car. The old override audit
    // fired only on pass_only lanes; on a normal lane a staff admit was
    // indistinguishable from a camera read. operatorAdmit rides on the event for
    // EVERY lane, so a hand-admit is always marked here.
    const byOperator = !!p?.event?.operatorAdmit;
    audit({
      eventKey: 'session.entry',
      action: 'entry',
      category: 'session',
      severity: 'high',
      outcome: 'ok',
      resourceType: 'parking_record',
      resourceId: p?.session?.id != null ? String(p.session.id) : null,
      description: `Entry · ${p?.session?.plate ?? '?'}${entryLane ? ` · ${entryLane.name}` : ''}${byOperator ? ' · staff admit (override)' : ''}`,
      changes: { entryAt: p?.session?.entryAt ?? null, laneId: p?.session?.entryLaneId ?? null, cameraId: p?.event?.cameraId ?? null, operatorAdmit: byOperator },
    });
    // Mirror to qparking SaaS via the persistent sync queue (retries on
    // failure so a temporary outage doesn't drop the entry record).
    if (p?.session) enqueueEntry(p.session);
  });

  // A re-scan of a plate that is already inside. Operator-facing log only (the
  // 'rescan-ignored' fan-out to the renderer above already covers the UI); the
  // barrier is deliberately NOT pulsed, because no new entry was authorised.
  parkingEvents.on('rescan-ignored', (p: any) => {
    sendToRenderer('log', {
      terminalId: 0,
      direction: 'info',
      message: `Re-scan ignored — ${p?.plate} already has an open session (#${p?.sessionId}); no new entry, barrier not pulsed. Driver should use the exit lane.`,
      payload: p,
    });
  });

  // Operator-action warnings. These are all refusals or misconfigurations: the
  // car is at a closed boom and nothing here pulses the barrier. They exist to
  // put the cause in the operator's log and the Activity Log.
  parkingEvents.on('warning', (p: any) => {
    const kind = p?.kind as string;
    if (kind === 'exit-blacklisted' || kind === 'entry-blacklisted') {
      // Held at the barrier for staff attention — no session, no charge, no
      // pulse. Nothing recovers automatically; the operator walks over.
      sendToRenderer('log', {
        terminalId: 0,
        direction: 'error',
        message: `BLACKLISTED plate ${p?.plate} — ${kind === 'entry-blacklisted' ? 'entry refused, no session and the barrier was NOT pulsed' : 'exit refused, car held at barrier'}`,
        payload: p,
      });
      // Audit trail: a refused gate attempt is exactly what the Activity Log
      // exists for — without this row the ban fires invisibly (gate screen +
      // device log only) and the operator can't review attempts after the fact.
      const isEntry = kind === 'entry-blacklisted';
      audit({
        eventKey: isEntry ? 'gate.entry.blacklisted' : 'gate.exit.blacklisted',
        action: isEntry ? 'entry' : 'exit',
        category: 'gate',
        severity: 'high',
        outcome: 'blocked',
        resourceType: 'vehicle',
        resourceId: p?.vehicleId != null ? String(p.vehicleId) : (p?.plate ?? null),
        description: `Blacklisted plate ${p?.plate ?? '?'} ${isEntry
          ? 'tried to enter — refused (no session created, barrier not opened)'
          : 'tried to exit — refused, car held at barrier'}${p?.reason ? ` · reason: ${p.reason}` : ''}`,
      });
    } else if (kind === 'entry-not-authorised') {
      // Pass-only lane, plate holds no valid pass. Same treatment as a blacklist
      // refusal — barrier stays down, staff release manually.
      //
      // ENTRY only. This branch also accepted 'exit-not-authorised' until
      // 2026-08-20, which nothing has ever emitted and nothing should: a car that
      // was let in must always be able to leave, so there is no such thing as an
      // exit refused for want of a pass. Carrying the phantom meant every message
      // here had to be written twice, once for a direction that cannot happen.
      sendToRenderer('log', {
        terminalId: 0,
        direction: 'error',
        message: `NOT AUTHORISED · ${p?.plate} has no valid pass — entry refused at "${p?.cameraName ?? `camera ${p?.cameraId}`}". Barrier stayed closed; operator must handle this manually.`,
        payload: p,
      });
      audit({
        eventKey: 'gate.entry.not_authorised',
        action: 'entry',
        category: 'gate',
        severity: 'medium',
        outcome: 'blocked',
        resourceType: 'vehicle',
        resourceId: p?.plate ?? null,
        description: `${p?.plate ?? '?'} tried to enter a pass-only lane without a valid pass — refused, barrier not opened`,
      });
    } else if (kind === 'entry-near-miss-pass') {
      // Admitted on a GUESS. Louder than a normal entry on purpose: the operator
      // should be able to see that the gate resolved an ambiguous read, and which
      // holder it credited, without going digging. Severity high for the same
      // reason a manual barrier open is high — a human may need to check it.
      sendToRenderer('log', {
        terminalId: 0,
        direction: 'info',
        message: `NEAR-MISS ADMITTED · read "${p?.plate}" is one character (${p?.matchKind}) from "${p?.matchedPlate}", which holds a valid pass — admitted at "${p?.cameraName ?? `camera ${p?.cameraId}`}". The stay is recorded under the READ plate so the exit camera can match it; correct it on the Sessions page if this was the wrong car.`,
        payload: p,
      });
      audit({
        eventKey: 'gate.entry.near_miss_pass',
        action: 'entry',
        category: 'gate',
        severity: 'high',
        outcome: 'ok',
        resourceType: 'vehicle',
        resourceId: p?.plate ?? null,
        description: `${p?.plate ?? '?'} admitted on a pass-only lane by NEAR-MISS match to ${p?.matchedPlate ?? '?'} (${p?.matchKind ?? '?'}) — pass ${p?.passId ?? '?'}`,
        changes: {
          readPlate: p?.plate ?? null,
          matchedPlate: p?.matchedPlate ?? null,
          matchKind: p?.matchKind ?? null,
          passId: p?.passId ?? null,
          cameraId: p?.cameraId ?? null,
        },
      });
    } else if (kind === 'entry-operator-override') {
      // A human waived Only Pass Allow. High severity like a manual barrier open:
      // it is a deliberate access decision by a person, and the site owner is
      // entitled to see every one of them.
      sendToRenderer('log', {
        terminalId: 0,
        direction: 'info',
        message: `ADMITTED BY STAFF · "${p?.plate}" holds no pass and "${p?.cameraName ?? `camera ${p?.cameraId}`}" is Only Pass Allow, but staff admitted it by hand. The stay is now open and will be charged normally at exit unless a pass covers it.`,
        payload: p,
      });
      audit({
        eventKey: 'gate.entry.operator_override',
        action: 'entry',
        category: 'gate',
        severity: 'high',
        outcome: 'ok',
        resourceType: 'vehicle',
        resourceId: p?.plate ?? null,
        description: `${p?.plate ?? '?'} admitted BY HAND on a pass-only lane — no valid pass; staff override`,
        changes: { plate: p?.plate ?? null, cameraId: p?.cameraId ?? null, cameraName: p?.cameraName ?? null },
      });
    } else if (kind === 'entry-quota-full') {
      // The pass is valid; it just has no free slot. Distinct from
      // not_authorised on purpose — the fix is "one of your other cars must
      // leave", not "buy a pass", and staff need to be told which.
      sendToRenderer('log', {
        terminalId: 0,
        direction: 'error',
        message: `QUOTA FULL · ${p?.plate} holds a valid pass but ${p?.inside}/${p?.limit} of its cars are already inside — entry refused at "${p?.cameraName || `camera ${p?.cameraId}`}". Barrier stayed closed; another of the holder's vehicles must exit first.`,
        payload: p,
      });
      audit({
        eventKey: 'gate.entry.quota_full',
        action: 'entry',
        category: 'gate',
        severity: 'medium',
        outcome: 'blocked',
        resourceType: 'vehicle',
        resourceId: p?.plate ?? null,
        description: `${p?.plate ?? '?'} refused entry — pass ${p?.passId ?? '?'} already has ${p?.inside ?? '?'}/${p?.limit ?? '?'} vehicles inside`,
      });
    } else if (kind === 'exit-pass-holder-no-entry') {
      // Held at the barrier like any other exit we cannot account for. Recorded
      // separately from 'exit-without-entry' because the cause is different and
      // so is the fix: a run of these means the ENTRY camera is dropping reads
      // for cars we can name, which is worth chasing.
      sendToRenderer('log', {
        terminalId: 0,
        direction: 'error',
        message: `${p?.plate} reached the exit with a valid pass but NO entry on record — barrier NOT opened, the car is held. Check the entry camera is reading reliably, then release the car from Parking Activity.`,
        payload: p,
      });
      audit({
        eventKey: 'gate.exit.pass_holder_no_entry',
        action: 'exit',
        category: 'gate',
        severity: 'medium',
        outcome: 'blocked',
        resourceType: 'vehicle',
        resourceId: p?.plate ?? null,
        description: `${p?.plate ?? '?'} held at the exit on pass ${p?.passId ?? '?'} — the pass is valid but no entry was recorded, so there was no session to close and the barrier stayed down`,
      });
    } else if (kind === 'exit-without-entry') {
      audit({
        eventKey: 'gate.exit.no_entry',
        action: 'exit',
        category: 'gate',
        severity: 'medium',
        outcome: 'blocked',
        resourceType: 'vehicle',
        resourceId: p?.plate ?? null,
        description: `${p?.plate ?? '?'} tried to exit with no open session — nothing to charge, barrier not opened. Either the entry read was missed or the plate was misread.`,
      });
    } else if (kind === 'exit-no-lane'
      || kind === 'exit-no-terminal'
      || kind === 'exit-terminal-disabled'
      || kind === 'exit-tng-not-configured') {
      // ─── the car is at the barrier and CANNOT be charged ────────────────
      // Every one of these leaves a driver stuck at a closed boom with an open
      // session, and until now not one of them was recorded anywhere the
      // operator could find later: gate screen (4-5s) + device log only. They
      // are all the same story — "this lane could not take the money" — so they
      // share one event key and name the specific cause in the description.
      const cause = {
        'exit-no-lane': 'the exit camera is not assigned to any lane',
        'exit-no-terminal': 'the lane has no payment terminal wired to it',
        'exit-terminal-disabled': 'the lane\'s payment terminal is switched off',
        'exit-tng-not-configured': `no PayResult listener is running${p?.reason ? ` (${p.reason})` : ''} — no charge was attempted, so no money could be taken and lost`,
        // REMOVED 2026-08-20: 'exit-terminal-offline'. Nothing ever emitted it —
        // a terminal that does not answer surfaces as 'exit-timeout' from
        // startTngExitCharge, which IS emitted and handled here. Two names for one
        // failure meant every new subscriber had to be told about both, and the LCD
        // fare-clearing set was already only told about one.
      }[kind] ?? kind;
      audit({
        eventKey: 'gate.exit.refused',
        action: 'exit',
        category: 'gate',
        // Not 'high': the car is stuck AND the session stays open, so occupancy
        // and the next driver in that lane are both affected until staff act.
        severity: 'critical',
        outcome: 'blocked',
        resourceType: 'parking_record',
        resourceId: p?.sessionId != null ? String(p.sessionId) : null,
        description: `Exit refused — ${cause}. Car held at the barrier with its session still open; needs a manual release or a fixed lane setup.`,
        changes: { kind, laneId: p?.laneId ?? null, terminalId: p?.terminalId ?? null },
      });
    } else if (kind === 'exit-charge-crashed') {
      // An exception escaped the charge helper. Distinct from a decline or a
      // timeout: this is OUR bug, not the driver's card or the device.
      audit({
        eventKey: 'payment.charge_crashed',
        action: 'payment',
        category: 'payment',
        severity: 'critical',
        outcome: 'failed',
        resourceType: 'parking_record',
        resourceId: p?.sessionId != null ? String(p.sessionId) : null,
        description: `Exit charge crashed mid-flight — ${p?.message ?? 'unknown error'}. Session left open; verify at the device whether the driver was actually deducted before retriggering.`,
      });
    } else if (kind === 'exit-auto-retrigger-capped') {
      audit({
        eventKey: 'payment.auto_retrigger_capped',
        action: 'payment',
        category: 'payment',
        severity: 'high',
        outcome: 'failed',
        resourceType: 'parking_record',
        resourceId: p?.sessionId != null ? String(p.sessionId) : null,
        description: `Gave up re-arming the terminal after ${p?.attempts ?? '?'} automatic attempts — ${p?.plate ?? 'the car'} is still at the barrier awaiting a manual release or retrigger.`,
      });
    } else if (kind === 'exit-timeout') {
      // The charge attempt timed out — car stays inside (session 'entered').
      // Push the failed attempt to the ledger so the cloud sees the decline/
      // stuck transaction; the operator retriggers or manually releases.
      const session = p?.sessionId ? getSessionById(p.sessionId) : null;
      const txn = p?.transactionId ? getTransactionById(p.transactionId) : null;
      if (session && txn) enqueueTransaction(session, txn);
      // A timeout is the one payment outcome that can mean money moved WITHOUT
      // us recording it (tap succeeded, PayResult callback lost), so it gets its
      // own row rather than sharing the decline's — and it says so out loud.
      audit({
        eventKey: 'payment.timeout',
        action: 'payment',
        category: 'payment',
        severity: 'critical',
        outcome: 'timeout',
        resourceType: 'transaction',
        resourceId: p?.transactionId != null ? String(p.transactionId) : null,
        correlationId: txn?.orderId ?? null,
        description: `No response from the terminal for ${session?.plate ?? 'a car'} · ${rm(txn?.amountCents)} — attempt marked failed, barrier stayed closed. If the card WAS deducted, the callback was lost: check the device before charging again.`,
        changes: { sessionId: p?.sessionId ?? null, orderId: txn?.orderId ?? null, amountCents: txn?.amountCents ?? null },
      });
    }
  });
  parkingEvents.on('exit-declined', (p: any) => {
    // Card declined — the car is still inside (session stays 'entered'). Show
    // the decline on the gate screen and push the failed transaction to the
    // ledger. The barrier stays CLOSED — operator retriggers or releases.
    const session = p?.sessionId ? getSessionById(p.sessionId) : null;
    const txn = p?.transactionId ? getTransactionById(p.transactionId) : null;
    if (session && txn) enqueueTransaction(session, txn);
    // A decline had NO local row: the cloud writes one when the pushed
    // transaction lands, so the operator couldn't see it until the next
    // mirror-down (boot / "Sync now"). Refusing a driver at a barrier has to be
    // in the log the moment it happens, offline included.
    audit({
      eventKey: 'payment.declined',
      action: 'payment',
      category: 'payment',
      severity: 'high',
      outcome: 'declined',
      resourceType: 'transaction',
      resourceId: p?.transactionId != null ? String(p.transactionId) : null,
      correlationId: txn?.cardNumber ?? txn?.orderId ?? null,
      description: `Card declined for ${session?.plate ?? 'a car'} · ${rm(txn?.amountCents)}${txn?.paymentMethod ? ` · ${txn.paymentMethod}` : ''} — no money taken, barrier stayed closed, session still open.`,
      changes: {
        sessionId: p?.sessionId ?? null,
        orderId: txn?.orderId ?? null,
        amountCents: txn?.amountCents ?? null,
        card: txn?.cardNumber ?? null,
      },
    });
  });
  parkingEvents.on('exit-completed', (p: any) => {
    // Every exit that completes closes a real session — the flow refuses any
    // exit it cannot tie to one, pass holder or not — so the lookup should
    // always land. Kept null-tolerant so a deleted row can't crash the handler.
    const session = p?.sessionId ? getSessionById(p.sessionId) : null;
    // The car has left: mirror the exit (status change) to qparking SaaS, and
    // push the payment transaction to the ledger if this exit carried one
    // (free / pass exits have no transaction).
    if (session) enqueueExit(session);
    const exitTxn = p?.transactionId ? getTransactionById(p.transactionId) : null;
    if (session && exitTxn) enqueueTransaction(session, exitTxn);
    const allowed = ['paid', 'free', 'manual_release'].includes(p?.outcome);
    if (!allowed) return;
    // A paid exit gets TWO rows on purpose: the money (payment.paid, category
    // 'payment') and the car leaving (session.exit, category 'session'). They
    // answer different questions — "what did we take today" vs "who left when" —
    // and a free / pass exit has only the second.
    if (p?.outcome === 'paid') {
      audit({
        eventKey: 'payment.paid',
        action: 'payment',
        category: 'payment',
        severity: 'low',
        outcome: 'ok',
        resourceType: 'transaction',
        resourceId: p?.transactionId != null ? String(p.transactionId) : null,
        correlationId: exitTxn?.cardNumber ?? exitTxn?.orderId ?? null,
        description: `Paid · ${session?.plate ?? p?.plate ?? '?'} · ${rm(exitTxn?.amountCents ?? session?.feeCents)}${exitTxn?.paymentMethod ? ` · ${exitTxn.paymentMethod}` : ''}${exitTxn?.apprCode ? ` · appr ${exitTxn.apprCode}` : ''}`,
        changes: {
          sessionId: p?.sessionId ?? null,
          orderId: exitTxn?.orderId ?? null,
          amountCents: exitTxn?.amountCents ?? null,
          card: exitTxn?.cardNumber ?? null,
        },
      });
    }
    audit({
      eventKey: 'session.exit',
      action: 'exit',
      category: 'session',
      severity: 'high',
      outcome: 'ok',
      resourceType: 'parking_record',
      resourceId: p?.sessionId != null ? String(p.sessionId) : null,
      description: `Exit · ${session?.plate ?? p?.plate ?? '?'} · ${p?.outcome}${p?.reason ? ` (${p.reason})` : ''} · ${rm(session?.feeCents)}${session?.durationMinutes != null ? ` · ${session.durationMinutes} min` : ''}`,
      changes: {
        outcome: p?.outcome ?? null,
        reason: p?.reason ?? null,
        feeCents: session?.feeCents ?? null,
        durationMinutes: session?.durationMinutes ?? null,
        passId: p?.passId ?? null,
      },
    });
    // Raise the boom. Guarded by the `allowed` check above, so this is reachable
    // ONLY for an exit that actually settled: 'paid' (the terminal approved),
    // 'free' (pass / grace / zero-rate) or 'manual_release' (operator decision).
    // A decline, a timeout, a missing terminal or any refusal never emits
    // 'exit-completed' at all — the car stays put with its session open.
    void pulseBarrierFor(p, 'exit');
  });

  // Sync status → renderer for the Dashboard panel.
  syncEvents.on('status', (status) => sendToRenderer('sync-status', status));
  // Reachability is pushed, not polled: every page that shows a status chip gets
  // the same rows at the same moment, and none of them needs a ping loop.
  deviceHealthEvents.on('health', (rows) => sendToRenderer('device-health', rows));

  // Cloud PULL outcome → renderer. Drives the header's "last synced" stamp.
  // Event-driven rather than polled: with the 60s tick gone this only changes
  // on boot, a manual "Sync now", or a rebind.
  cloudPullEvents.on('pulled', (state) => sendToRenderer('cloud-pull', state));

  // Which mirrors that pull actually refreshed → renderer, so the page the
  // operator is standing on re-reads its list. Without it a sync writes fresh
  // rows into SQLite while the open page keeps showing what it read on mount,
  // and a pass issued in the cloud looks like it never arrived.
  cloudPullEvents.on('mirrors', (mirrors) => sendToRenderer('cloud-mirrors', mirrors));

  // Live parking-flow debug log → renderer. Lets the operator see exactly
  // which guard fired (or didn't) without needing to open DevTools — shown
  // in a sticky strip at the bottom of the app.
  parkingEvents.on('debug-log', (p: any) => sendToRenderer('parking-flow-log', p));

  // Webhook-stage lines go to the SAME strip. parking-flow's own first line
  // ("plate event: …") only runs once a read has already survived the webhook,
  // so everything that drops it before then — unknown camera, disabled camera,
  // wrong URL, bad secret — was invisible in the one panel an operator watches
  // to answer "did the gate see this car?". A read that never arrives and a read
  // that arrives and is discarded looked identical, and neither looked like
  // anything at all.
  const flowLog = (text: string) => sendToRenderer('parking-flow-log', {
    ts: new Date().toISOString(),
    text: `[lpr-webhook] ${text}`,
  });

  // W4G TNG activity → renderer log stream (so the Settings test panel +
  // bottom log strip can show outbound / inbound / errors live).
  w4gEvents.on('log', (entry: any) => sendToRenderer('log', { terminalId: -1, ...entry, source: 'w4g' }));

  // ─── infrastructure failures that used to be console-only ─────────────────
  // These three share a shape: nothing crashes, every screen looks healthy, and
  // the app has quietly stopped doing its job. They belong in the operator's
  // Activity Log, not in a terminal nobody has open.

  // No LPR listener = no plate events = not one car recorded, anywhere.
  lprEvents.on('listener-error', (p: any) => {
    // Straight into the live strip too: this is the single most likely reason
    // for "the camera fires and the log stays empty", and it happens at BOOT —
    // long before the operator starts watching, so the Activity Log alone means
    // discovering it only if you think to go looking.
    flowLog(`LISTENER DOWN: could not bind port ${p?.port ?? '?'} (${p?.code ?? 'error'}: ${p?.message ?? '?'}). NO camera event can reach this app — nothing will appear in this log until it is fixed.`
      + (p?.code === 'EADDRINUSE' ? ' Another qparking-local is probably already running (check for a packaged/portable copy in the tray).' : ''));
    audit({
      eventKey: 'device.lpr.listener_failed',
      action: 'edit',
      category: 'device',
      severity: 'critical',
      outcome: 'failed',
      resourceType: 'app_settings',
      description: `LPR webhook listener could NOT bind port ${p?.port ?? '?'} (${p?.code ?? 'error'}: ${p?.message ?? '?'}).`
        + ' No camera event can reach this app until it is fixed — entries and exits are silently NOT being recorded.'
        + (p?.code === 'EADDRINUSE' ? ' Another qparking-local is probably already running (check for the packaged portable).' : ''),
      changes: { port: p?.port ?? null, code: p?.code ?? null },
    });
  });

  // Arrival trace — one line per inbound plate POST, before any guard. Pairs
  // with the rejection row below: trace + no parking-flow line = we dropped it
  // (the next row says why); no trace at all = nothing reached this process.
  lprEvents.on('webhook-received', (p: any) => {
    const line = `PLATE POST RECEIVED from ${p?.remoteIp ?? '?'}${p?.sentIp && p.sentIp !== p.remoteIp ? ` (reports itself as ${p.sentIp})` : ''} · plate=${p?.plate ?? '(none read)'}${p?.direction ? ` · direction=${p.direction}` : ''} · path=${p?.path ?? '?'}`;
    flowLog(line);
    sendToRenderer('log', { terminalId: 0, direction: 'info', message: line, payload: p });
  });

  // The same read arriving again within seconds — the camera posting to two
  // endpoints, or re-reporting as its confidence settles. Logged rather than
  // dropped in silence, so "why did only one of my two posts do anything?" has
  // an answer sitting right there in the strip.
  lprEvents.on('webhook-duplicate', (p: any) => {
    flowLog(`DUPLICATE POST IGNORED: plate=${p?.plate} from "${p?.cameraName ?? `camera ${p?.cameraId}`}" via ${p?.path} — the same read already came through less than ${Math.round((p?.windowMs ?? 0) / 1000)}s ago. This is one car, not two; nothing was recorded twice.`);
  });

  // Reached the port but not POST /lpr/event — wrong path or wrong method.
  lprEvents.on('webhook-unroutable', (p: any) => {
    const line = `WRONG ENDPOINT: ${p?.method} ${p?.url} from ${p?.remoteIp} reached the LPR port but is not the plate endpoint — point the camera at POST /lpr/event`;
    flowLog(line);
    sendToRenderer('log', { terminalId: 0, direction: 'error', message: line, payload: p });
  });

  // A plate read that reached the webhook and was thrown away before it could
  // become a session: unmatched camera, disabled camera, or a secret mismatch.
  // Every one of these used to be (or still looked like) silence from inside the
  // app, which is the worst possible failure for a gate — the camera says it
  // read the plate, the app shows nothing, and there is no thread to pull.
  //
  // Throttled at the emitter (one row per camera per 10 min) because a
  // misconfigured camera re-posts on every single pass.
  lprEvents.on('webhook-rejected', (p: any) => {
    const who = p?.cameraName ? `"${p.cameraName}"` : p?.cameraId != null ? `camera ${p.cameraId}` : 'an unrecognised camera';
    const why = {
      unknown_camera: `no camera in qparking-local matches it. It posted from ${p?.remoteIp ?? 'an unknown IP'}${p?.sentIp ? ` and reported its own IP as ${p.sentIp}` : ''}, and the registered cameras are: ${p?.knownCameras ?? '—'}. Add it on the Cameras page, or correct the host/LAN IP so it matches exactly.`,
      camera_disabled: 'that camera is switched OFF on the Cameras page. Re-enable it.',
      missing_secret_header: 'no X-Webhook-Secret header was sent. Re-enter the secret on the camera, or clear it on the camera record.',
      wrong_secret: 'the X-Webhook-Secret did not match. Re-enter the secret on the camera, or clear it on the camera record.',
    }[p?.reason as string] ?? String(p?.reason ?? 'unknown reason');

    const line = `PLATE READ DISCARDED from ${who}${p?.plate ? ` (${p.plate})` : ''} — ${why}`;
    flowLog(line);
    sendToRenderer('log', { terminalId: 0, direction: 'error', message: line, payload: p });
    audit({
      eventKey: 'security.webhook.rejected',
      action: 'access',
      category: 'security',
      severity: 'high',
      outcome: 'blocked',
      resourceType: 'camera_device',
      resourceId: p?.cameraId != null ? String(p.cameraId) : null,
      description: `Plate read REJECTED from ${who} — ${why}`
        + ` The read was DISCARDED${p?.plate ? ` (latest: ${p.plate})` : ''}: no session, no barrier.`
        + ` Further rejections from this source are muted for ${p?.throttleMinutes ?? 10} minutes.`,
      changes: { cameraId: p?.cameraId ?? null, remoteIp: p?.remoteIp ?? null, reason: p?.reason ?? null },
    });
  });

  // No PayResult listener = no exit can be charged; every paid exit refuses.
  w4gEvents.on('listener-error', (p: any) => {
    audit({
      eventKey: 'device.tng.listener_failed',
      action: 'edit',
      category: 'device',
      severity: 'critical',
      outcome: 'failed',
      resourceType: 'local_terminal',
      description: `TNG PayResult listener could NOT bind port ${p?.port ?? '?'} (${p?.code ?? 'error'}: ${p?.message ?? '?'}).`
        + ' With no callback path, every paid exit is refused before any money can move.'
        + (p?.hint ? ` ${p.hint}` : ''),
      changes: { port: p?.port ?? null, code: p?.code ?? null },
    });
  });

  // A PayResult with no order waiting for it. The driver almost certainly WAS
  // deducted — there is just no attempt on our side to attach it to, so it can
  // never reach the ledger by itself. Highest-consequence row in the app.
  w4gEvents.on('orphan-result', (body: any) => {
    const approved = body?.state === '0';
    audit({
      eventKey: 'payment.orphan_result',
      action: 'payment',
      category: 'payment',
      severity: approved ? 'critical' : 'medium',
      outcome: 'failed',
      resourceType: 'transaction',
      correlationId: body?.orderId ?? null,
      description: approved
        ? `UNMATCHED APPROVED PAYMENT · order ${body?.orderId ?? '?'} · card ${body?.cardNo || '-'} · appr ${body?.apprCode || '-'}`
          + ' — the device reports a successful deduction for an order this app is no longer waiting on (late callback after a timeout/cancel, or a charge fired from outside the app).'
          + ' The money is NOT in the ledger and no session was closed by it. Reconcile against the device before refunding or re-charging.'
        : `Unmatched declined PayResult · order ${body?.orderId ?? '?'} — stale callback for an order this app already gave up on. No money moved.`,
      changes: {
        orderId: body?.orderId ?? null,
        state: body?.state ?? null,
        card: body?.cardNo ?? null,
        apprCode: body?.apprCode ?? null,
        payTime: body?.payTime ?? null,
      },
    });
  });
}

function sendToRenderer(channel: string, payload: unknown) {
  if (mainWindow?.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ─── IPC handlers (the bridge surface) ─────────────────────────────────────

// Payment terminals = Alarmtech W4G devices. CRUD only — the device is driven
// by the parking-flow (PayRequest) and the W4G callback server; there's no
// per-command console like the old ECPI reader had.
ipcMain.handle('terminals:list', () => listTerminals());
ipcMain.handle('terminals:save', (_e, input) => {
  // Local-only save. Cloud sync is manual now — the operator pushes from the
  // Terminals page's "Push to cloud" button.
  const saved = upsertTerminal(input);
  void sweepDeviceHealth().catch(() => null);
  return saved;
});
ipcMain.handle('terminals:delete', (_e, id: number) => {
  deleteTerminal(id);
  void sweepDeviceHealth().catch(() => null);
});
// TCP reachability probe by host:port — backs the per-device "Test connection".
ipcMain.handle('terminals:ping-host', (_e, input: { host: string; port: number }) => pingTerminalHost(input.host, input.port));

// LCD displays = qparking-lcd Android panels at the barrier. CRUD plus link
// health; the frames themselves are pushed by lcd-display.ts off parking-flow
// events, so there is no per-command console here either.
ipcMain.handle('lcds:list', () => listLcds());
ipcMain.handle('lcds:save', (_e, input) => {
  const saved = upsertLcd(input);
  // Reconcile immediately: an operator who just fixed a typo'd IP expects the
  // panel to come alive now, not after the next app restart.
  reloadLcdLinks();
  void sweepDeviceHealth().catch(() => null);
  return saved;
});
ipcMain.handle('lcds:delete', (_e, id: number) => {
  deleteLcd(id);
  reloadLcdLinks();
  void sweepDeviceHealth().catch(() => null);
});
ipcMain.handle('lcds:statuses', () => getLcdStatuses());
ipcMain.handle('device-health:get', () => snapshotDeviceHealth());
ipcMain.handle('device-health:refresh', () => sweepDeviceHealth());
// Report state + a manual "report now", so an installer can prove the cloud link
// from this box instead of asking someone to go and look at the SaaS.
ipcMain.handle('device-health:heartbeat-state', () => getHeartbeatState());
ipcMain.handle('device-health:report-now', () => postHeartbeat());
// Fires a real fare → thank-you → idle sequence at the address in the form,
// before it has been saved. Takes ~6s, which is the point — the installer walks
// to the panel and watches it.
ipcMain.handle('lcds:test', (_e, input: { host: string; port: number }) => testLcd(input.host, input.port));

ipcMain.handle('cameras:list', () => listCameras());
ipcMain.handle('cameras:save', async (_e, input) => {
  // C4: two ENABLED cameras on one host silently misroute — a vendor read from
  // either physical device resolves to a single camera row (lowest id), so one
  // direction's reads get processed as the other's and cars can never exit.
  // Refuse the save. A DISABLED duplicate is fine: it is skipped at resolve time.
  if (input.enabled && input.host && String(input.host).trim()) {
    const host = String(input.host).trim();
    const clash = listCameras().find((c) => c.id !== input.id && c.enabled && (c.host ?? '').trim() === host);
    if (clash) {
      throw new Error(
        `Host ${host} is already used by the enabled camera "${clash.name}". Two enabled cameras on one address `
        + 'get their reads misrouted to a single camera — give this one its own address, or disable the other first.',
      );
    }
  }
  const saved = upsertCamera(input);
  // Local-only save (cloud sync is manual via the Cameras page button). Still
  // refresh the RTSP video feed and warm relay connection if host/creds changed.
  resyncRtspGrabbers();
  resyncCameraRelay();
  // The webhook port lives on the camera, so saving one can introduce a port
  // nothing is listening on yet. Without this the operator sets the port, the
  // camera pushes to it, and the OS refuses the connection — the app's most
  // deceptive failure, since every screen looks healthy. Ports still in use by
  // another camera are left bound untouched (see startLprServers).
  startLprServers();
  // Re-probe: the address IS the health verdict's only input, so a saved edit
  // leaves every chip describing the OLD address until this runs. Fire-and-forget
  // — the operator's save must not wait on a socket timeout.
  void sweepDeviceHealth().catch(() => null);
  return saved;
});
ipcMain.handle('cameras:delete', (_e, id: number) => {
  // C3: refuse while this camera's lane has an exit mid-charge. Same reasoning
  // as sessions:delete — the in-flight PayRequest keys off the lane, and the
  // barrier pulse keys off this camera. Delete the camera now and a driver who
  // taps pays into a session whose exit boom no longer has a camera row to
  // pulse: money taken, car stuck, and the failure audit blames a camera that
  // is gone. Make the operator wait for the tap to settle (or release the car).
  const cam = getCamera(id);
  if (cam?.laneId) {
    const charging = findExitInFlightByLane(cam.laneId);
    if (charging) {
      throw new Error(
        `${charging.plate} is being charged at lane ${getLane(charging.laneId)?.name ?? charging.laneId} right now `
        + `(RM ${(charging.feeCents / 100).toFixed(2)}) — this camera serves that lane. Wait for the tap to settle, `
        + 'or release the car, before deleting the camera.',
      );
    }
  }
  deleteCamera(id);
  resyncRtspGrabbers();
  resyncCameraRelay();
  // Frees the port if no other camera pushes to it.
  startLprServers();
  void sweepDeviceHealth().catch(() => null);
});
// Latest frame the camera pushed with a plate event — Live display fallback
// for WebSocket/RTSP-only cameras with no pullable HTTP snapshot URL.
ipcMain.handle('cameras:latest-frame', (_e, cameraId: number) => getLatestFrame(cameraId));
ipcMain.handle('cameras:ping', (_e, cameraId: number) => pingCamera(cameraId));
ipcMain.handle('cameras:ping-host', (_e, input: { host: string; port?: number }) => pingHost(input.host, input.port));
// Live display → "Refresh cameras". Tear the video feeds down and build them
// back up, and re-attempt any barrier handle that never came up.
//
// This is the fix for a camera plugged in (or powered on) AFTER the app started:
// its ffmpeg is stuck in a connect/retry loop against a host that wasn't there,
// and its SDK handle never logged in. Neither notices the camera arriving,
// because nothing about their CONFIG changed — so resync() alone leaves both
// exactly as they are. A kill-and-respawn is what makes the feed come up now
// instead of on the next camera save or app restart.
ipcMain.handle('cameras:restart-streams', () => {
  const running = restartRtspFeeds();
  resyncCameraRelay();
  return { ok: true, feeds: running };
});

ipcMain.handle('lanes:list', () => listLanes());
ipcMain.handle('lanes:save', (_e, input: any) => {
  // The lane is the composition root: it carries the camera set (`cameraIds`)
  // and the terminal it charges on. Split the camera list off before the
  // upsert — it lives on the cameras table, not the lanes row.
  const { cameraIds, ...laneInput } = input ?? {};
  const saved = upsertLane(laneInput);

  // Persist the camera↔lane wiring from the lane side (cameras no longer
  // pick their own lane on the camera form).
  const changedCameras: number[] = Array.isArray(cameraIds) ? cameraIds.map(Number) : [];
  if (Array.isArray(cameraIds)) setLaneCameras(saved.id, changedCameras);

  // Local-only save. Cloud sync is manual via the Lanes / Cameras page buttons.
  return saved;
});
ipcMain.handle('lanes:delete', (_e, id: number) => {
  // C10: refuse while an exit is mid-charge on this lane — the same guard
  // sessions:delete and cameras:delete use. Deleting the lane out from under a
  // live charge orphans the in-flight entry and leaves a dangling exit_lane_id.
  const charging = findExitInFlightByLane(id);
  if (charging) {
    throw new Error(
      `${charging.plate} is being charged at this lane right now (RM ${(charging.feeCents / 100).toFixed(2)}). `
      + 'Wait for the tap to settle, or release the car, before deleting the lane.',
    );
  }
  return deleteLane(id);
});

ipcMain.handle('sessions:open', () => listOpenSessions());
// Today's headline figures, aggregated in SQL rather than filtered out of a
// 20-row display list in the renderer. The caller passes the GMT+8 day as UTC
// bounds — the renderer owns the timezone (see lib/datetime).
ipcMain.handle('sessions:day-totals', (_e, opts: { dayStartUtc: string; dayEndUtc: string }) =>
  dayTotals(opts.dayStartUtc, opts.dayEndUtc));
ipcMain.handle('sessions:recent', (_e, limit: number) => listRecentSessions(limit));
// Live "what does this car owe right now" preview for an OPEN session, using
// the SAME rules-aware computeFee the exit flow uses (the entry lane's policy
// governs, then the site default). The renderer can't run computeFee (it lives
// in the main process and honours the tariff_rules schedule), so we compute it
// here and attach it to each open row — otherwise the UI's simplified legacy
// calc shows RM0 for schedule-based policies.
function previewFeeForOpenSession(s: ReturnType<typeof listSessionsPage>[number]): number | null {
  if (s.exitAt) return null;
  const nowIso = new Date().toISOString();
  // A pass holder will exit free, so previewing a running fee for them is simply
  // wrong — it's what prompts "why is this VIP being charged?". Mirror the exit
  // flow's own pass shortcut (handleExit checks this BEFORE pricing) using the
  // same entry-or-exit-instant validity window.
  // Asked at THIS instant on both sides, exactly as handleExit's free-exit
  // shortcut does. It used to pass { entryAt: s.entryAt, exitAt: nowIso }, and
  // because findSeasonPassByPlate matches a pass covering EITHER end, a pass that
  // covered the entry and has since lapsed still returned a hit — so the panel
  // showed RM 0.00 for a car the barrier is about to bill for its uncovered tail.
  //
  // The recorded pass is honoured too, mirroring the same fallback the exit uses:
  // a near-miss holder WILL exit free, and showing them a running fare is the
  // same lie in the other direction.
  const passNow = findSeasonPassByPlate(s.plate, { entryAt: nowIso, exitAt: nowIso })
    ?? (s.passId ? findSeasonPassById(s.passId, { entryAt: nowIso, exitAt: nowIso }) : null);
  if (passNow) return 0;
  const entryLane = s.entryLaneId ? getLane(s.entryLaneId) : null;
  const exitLane = s.exitLaneId ? getLane(s.exitLaneId) : null;
  const policy = (entryLane?.policyId ? getRatePolicy(entryLane.policyId) : null)
    ?? (exitLane?.policyId ? getRatePolicy(exitLane.policyId) : null)
    ?? getSiteDefaultRatePolicy();
  if (!policy) return 0;
  const durationMinutes = stayDurationMinutes(s.entryAt, nowIso);
  const fee = computeFee(durationMinutes, policy, s.entryAt, nowIso);
  // No minimum-charge override — removed with the setting (see AppSettings), so
  // this preview and the gate compute the same number from the same plan.
  return fee;
}

ipcMain.handle('sessions:page', (_e, opts: {
  tab: 'open' | 'recent';
  limit: number;
  offset: number;
  plateSearch?: string | null;
  entryFrom?: string | null;
  entryTo?: string | null;
  exitFrom?: string | null;
  exitTo?: string | null;
  status?: string | null;
  paymentStatus?: string | null;
}) => ({
  rows: listSessionsPage(opts).map((s) => ({ ...s, livePreviewFeeCents: previewFeeForOpenSession(s) })),
  counts: countSessions({
    plateSearch: opts.plateSearch ?? null,
    entryFrom: opts.entryFrom ?? null,
    entryTo: opts.entryTo ?? null,
    exitFrom: opts.exitFrom ?? null,
    exitTo: opts.exitTo ?? null,
    status: opts.status ?? null,
    paymentStatus: opts.paymentStatus ?? null,
  }),
}));

// Transactions ledger — every payment attempt across all sessions, newest
// first, with the parent session's plate/lane joined for display.
ipcMain.handle('transactions:list-page', (_e, opts: { limit: number; offset: number; search?: string | null; status?: string | null; dateFrom?: string | null; dateTo?: string | null }) => ({
  rows: listTransactionsPage(opts),
  total: countTransactions({ search: opts.search ?? null, status: opts.status ?? null, dateFrom: opts.dateFrom ?? null, dateTo: opts.dateTo ?? null }),
}));

// Manual retrigger — synthesizes an exit LPR event for a session so the
// normal parking-flow can drive the terminal for a stuck / mis-read exit.
//
// Audited: this asks a driver to tap their card again, which is a money-moving
// operator decision. The flow's own rows then record what came back (paid /
// declined / timeout), so this row deliberately only says "staff asked for it".
ipcMain.handle('sessions:retrigger-payment', (_e, sessionId: number, laneId?: number | null) => {
  const result = retriggerSessionExit(sessionId, laneId);
  const session = getSessionById(sessionId);
  audit({
    eventKey: 'session.payment_retriggered',
    action: 'payment',
    category: 'payment',
    severity: 'medium',
    outcome: result.ok ? 'ok' : 'failed',
    resourceType: 'parking_record',
    resourceId: String(sessionId),
    description: result.ok
      ? `Operator retriggered the exit charge for ${session?.plate ?? `session #${sessionId}`}${laneId != null ? ` at lane ${getLane(laneId)?.name ?? laneId}` : ''} — terminal re-armed for another tap.`
      : `Operator retrigger REFUSED for ${session?.plate ?? `session #${sessionId}`} — ${result.error ?? 'unknown reason'}`,
  });
  return result;
});
// Live-display "retrigger payment" — operator types the plate they can read off
// the feed; we find that car's open session and re-run its exit-payment flow.
ipcMain.handle('sessions:retrigger-by-plate', (_e, plate: string, laneId?: number | null) => {
  const result = retriggerSessionExitByPlate(plate, laneId);
  audit({
    eventKey: 'session.payment_retriggered',
    action: 'payment',
    category: 'payment',
    severity: 'medium',
    outcome: result.ok ? 'ok' : 'failed',
    resourceType: 'parking_record',
    resourceId: null,
    description: result.ok
      ? `Operator retriggered the exit charge by plate "${plate}"${laneId != null ? ` at lane ${getLane(laneId)?.name ?? laneId}` : ''} — terminal re-armed for another tap.`
      : `Operator retrigger by plate "${plate}" REFUSED — ${result.error ?? 'unknown reason'}`,
  });
  return result;
});
ipcMain.handle('sessions:delete', (_e, id: number) => {
  // Refuse while this stay is being CHARGED. The release path cancels the charge
  // first (cancelExitInFlight); this path did neither — deleting a mid-tap stay
  // left the PayRequest live, and if the driver then tapped, the deduction
  // settled against a session that no longer existed: the paid ledger row could
  // never reach the cloud (the push needs the session's plate), so real money
  // existed only in the local Transactions page. Deleting a stay mid-payment is
  // almost certainly a mis-click; make the operator wait or release instead.
  const charging = findExitInFlightBySession(id);
  if (charging) {
    throw new Error(
      `${charging.plate} is being charged at lane ${getLane(charging.laneId)?.name ?? charging.laneId} right now `
      + `(RM ${(charging.feeCents / 100).toFixed(2)}). Wait for the tap to settle, or release the car instead — `
      + `deleting the stay mid-payment would leave the money with no record to land on.`,
    );
  }
  // Capture session BEFORE deleting so we have lane/plate/entryAt for the
  // qparking sync payload — otherwise the row is gone before we enqueue.
  const session = getSessionById(id);
  const ok = deleteSession(id);
  if (ok && session) enqueueDelete(session);
  // The row is gone, so a fare on the panel for it can never be settled — see
  // clearFareForSession, which no-ops unless this session is the one on screen.
  if (ok) clearFareForSession(id, 'session deleted by an operator');
  // S9: audit HERE, in the main process, not from the renderer after the fact —
  // a closed window or a direct IPC caller must not be able to delete a stay
  // with no trail. Written only on the path where the delete actually happened.
  if (ok && session) {
    audit({
      eventKey: 'session.delete', action: 'delete', category: 'session', severity: 'high',
      outcome: 'ok', resourceType: 'parking_record', resourceId: String(id),
      description: `Session deleted · ${session.plate}`,
    });
  }
  return ok;
});
ipcMain.handle('sessions:release', (_e, id: number, reason: string, laneId?: number | null) => {
  // A release without payment is a recorded, accountable act — it must carry a
  // reason. The modal already blocks an empty one, but the server is the real
  // gate (a direct IPC caller would otherwise release with an empty note).
  if (!reason || !String(reason).trim()) {
    throw new Error('reason_required — a manual release must state why (it is recorded as the reason no fee was taken).');
  }
  reason = String(reason).trim();
  // Abort any in-flight W4G exit charge FIRST, so a PayResult that lands after
  // this release can't flip the voided txn back to 'paid' and un-release the car.
  cancelExitInFlight(id);
  // Void any in-flight (pending) payment attempt so the ledger doesn't leave a
  // dangling 'pending' for a session released without a completed payment.
  const openTxn = getOpenTransactionForSession(id);
  const { session, changed } = manualReleaseSession(id, reason);
  if (session && changed) {
    if (openTxn) {
      const voided = updateTransaction(openTxn.id, { status: 'voided' });
      if (voided) enqueueTransaction(session, voided);
    }
    enqueueUpdate(session);
  } else if (session) {
    // Already closed — the payment beat the operator to it. Nothing was rewritten
    // (see manualReleaseSession) and no pending txn is voided, because the charge
    // that closed this session is exactly the one we must not undo. Still opens the
    // barrier below: the car is at the gate either way.
    sendToRenderer('log', {
      terminalId: 0,
      direction: 'info',
      message: `Manual release skipped for session #${id} (${session.plate}) — it was already closed as ${session.status}/${session.paymentStatus}. Record left intact; opening the barrier anyway.`,
      payload: { sessionId: id, status: session.status, paymentStatus: session.paymentStatus },
    });
  }
  // Let the car out — open the barrier at the operator-chosen lane (falling
  // back to the session's own exit/entry lane). Fire-and-forget so the release
  // returns promptly; the barrier open is best-effort.
  const gateLaneId = laneId ?? session?.exitLaneId ?? session?.entryLaneId ?? null;
  if (gateLaneId) openBarrier({ laneId: gateLaneId, reason: 'manual-release' }).catch(() => null);
  // Tell the driver, on the panel at the gate that is lifting. A release never
  // goes through the parking flow, so nothing else would clear the fare the panel
  // may still be showing — see showManualReleaseOnLane.
  if (session) showManualReleaseOnLane(gateLaneId, session);
  // S9: audit in the main process (was renderer-side, after the fact). A manual
  // release without payment is a critical action; it must be recorded even if
  // the window closes or the reason came from a direct IPC caller. reason is
  // validated below in the handler-guard added for empty strings.
  if (session) {
    audit({
      eventKey: 'session.manual_release', action: 'manual_release', category: 'session', severity: 'critical',
      outcome: 'ok', resourceType: 'parking_record', resourceId: String(id),
      description: `Session manually released without payment · ${session.plate} · ${reason}`,
    });
  }
  return session;
});
// DEV/QA: timed live flow — open a session at a chosen entry time, then exit at
// a chosen exit time (prices the stay + drives the terminal).
ipcMain.handle('sessions:simulate-entry', (_e, laneId: number, plate: string, entryIso: string) =>
  simulateEntryAt(laneId, plate, entryIso));
ipcMain.handle('sessions:simulate-exit', (_e, laneId: number, plate: string, exitIso: string) =>
  simulateExitAt(laneId, plate, exitIso));
// Read a session capture off disk for the renderer as base64 — the renderer
// runs over http(s)/app:// so a raw file:// <img> is blocked. Constrained to
// the plates dir; returns null if missing.
ipcMain.handle('sessions:image', (_e, filePath: string) => {
  try {
    if (!filePath) return null;
    const platesRoot = path.join(app.getPath('userData'), 'plates');
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(platesRoot)) return null;
    if (!fs.existsSync(resolved)) return null;
    return { base64: fs.readFileSync(resolved).toString('base64'), contentType: 'image/jpeg' };
  } catch { return null; }
});

/**
 * Admin session editor — recalculates duration + fee whenever entry/exit
 * times change so the operator can verify the live fee calc is right.
 * Body fields: plate, entryAt, exitAt, paymentStatus, notes. Fee/duration
 * are recomputed server-side using the session's exit-lane policy, OR a
 * policyIdOverride if passed (useful for "what would this cost under policy
 * X" exploration).
 */
ipcMain.handle('sessions:update', (_e, id: number, patch: {
  plate?: string;
  entryAt?: string;
  exitAt?: string | null;
  paymentStatus?: 'pending' | 'paid' | 'declined' | 'cancelled' | 'free' | 'manual_release';
  notes?: string;
  policyIdOverride?: string | null;
}) => {
  const session = getSessionById(id);
  if (!session) throw new Error('not_found');

  // ─── S3: a settled stay cannot be reopened ───────────────────────────────
  // Clearing the exit on a paid / free / released session flips it back to OPEN,
  // and the next LPR read (or a retrigger) finds an open session again and
  // charges the driver a SECOND time — two 'paid' rows for one stay. A closed,
  // settled stay is done: a paid car that still needs the boom is let out with
  // Open Barrier, which never touches the session. So block the reopen outright.
  const reopening = patch.exitAt !== undefined && !patch.exitAt && !!session.exitAt;
  const settled = session.paymentStatus === 'paid'
    || session.paymentStatus === 'free'
    || session.paymentStatus === 'manual_release';
  if (reopening && settled) {
    throw new Error(
      `${session.plate} is a settled ${session.paymentStatus} stay — its exit time can't be cleared. `
      + 'Reopening it would let the next camera read charge the driver a second time. '
      + 'If the car still needs to leave, use Open Barrier instead — it opens the gate without touching the stay.',
    );
  }

  // ─── S4: no edits while the stay is being charged ─────────────────────────
  // Same guard sessions:delete uses. A PayResult landing mid-edit would be
  // overwritten by recordExit, or — if the plate was corrected mid-charge —
  // settle onto the renamed session with nothing tying the ledger to the plate
  // the terminal displayed.
  const chargingNow = findExitInFlightBySession(id);
  if (chargingNow) {
    throw new Error(
      `${session.plate} is being charged at lane ${getLane(chargingNow.laneId)?.name ?? chargingNow.laneId} right now `
      + `(RM ${(chargingNow.feeCents / 100).toFixed(2)}). Wait for the tap to settle before editing this stay — an edit `
      + 'now would be overwritten when the payment lands, or settle onto the wrong plate.',
    );
  }

  // ─── S1 / S2: the timestamps the edit would produce must make sense ───────
  // Zone-aware parse: bare 'YYYY-MM-DD HH:MM:SS' rows mean UTC, but Date.parse
  // would read them as local — normalise the same way parseStoredInstant does.
  const parseInstant = (v: string | null | undefined): number => {
    if (!v) return NaN;
    let t = String(v).trim();
    const hasZone = /[zZ]$|[+-]\d\d:?\d\d$/.test(t);
    if (!hasZone) { t = t.replace(' ', 'T'); if (t.includes('T')) t += 'Z'; }
    return Date.parse(t);
  };
  // S2: a blank entry used to resolve to "now". The blank-means-still-inside
  // signal belongs to the EXIT field, never the entry.
  if (patch.entryAt !== undefined && !String(patch.entryAt).trim()) {
    throw new Error('entry_required — a stay must keep an entry time. To mark it still inside, clear the EXIT time instead.');
  }
  const effEntry = patch.entryAt ?? session.entryAt;
  const effExit = patch.exitAt !== undefined ? patch.exitAt : session.exitAt;
  const effEntryMs = parseInstant(effEntry);
  if (Number.isFinite(effEntryMs) && effEntryMs > Date.now() + 120_000) {
    throw new Error('entry_in_future — the entry time is in the future. Check the date; a stay cannot start after the current time.');
  }
  if (effExit) {
    const effExitMs = parseInstant(effExit);
    if (Number.isFinite(effEntryMs) && Number.isFinite(effExitMs) && effExitMs < effEntryMs) {
      throw new Error('exit_before_entry — the exit time is earlier than the entry time. A car cannot leave before it arrived.');
    }
  }

  // Canonicalise the plate exactly as the LPR ingest and the pass/blacklist
  // lookups do (shared/plate.ts). Without this, an operator typing "ABC 1234"
  // stored the space verbatim and the next camera read of ABC1234 no longer
  // matched the session — the car exited as 'exit-without-entry'.
  let plate: string | undefined;
  if (patch.plate !== undefined) {
    plate = canonicalPlate(patch.plate);
    if (!plate) throw new Error('plate_required — a plate must contain at least one letter or digit');
  }

  // ─── one open stay per plate ─────────────────────────────────────────────
  // Editing a plate onto a car that is ALREADY inside would leave two open
  // sessions for one plate, and every plate-keyed lookup after that picks by
  // "most recent open" — so the next exit would close the wrong stay, bill the
  // wrong entry time, and strand the other session open forever.
  //
  // Checked against the state the edit WOULD produce, not the current one, so it
  // also catches re-opening a closed stay (clearing the exit time) onto a plate
  // that has since come back in.
  //
  // Only ever a conflict when both stays would be OPEN: a closed stay for ABC123
  // and a car of the same plate inside right now is perfectly normal — it left
  // and returned.
  const willBeOpen = patch.exitAt !== undefined ? !patch.exitAt : !session.exitAt;
  if (willBeOpen) {
    const plateAfterEdit = plate ?? session.plate;
    const clash = findOpenSessionByPlate(plateAfterEdit);
    if (clash && clash.id !== id) {
      // GMT+8, spelled out. Sessions store UTC ISO, and pasting that raw into a
      // message an operator reads is how "entered 06:49" gets mistaken for the
      // small hours when the car actually arrived at 14:49.
      const enteredAt = new Date(clash.entryAt).toLocaleString('en-MY', {
        timeZone: 'Asia/Kuala_Lumpur',
        day: '2-digit', month: 'short',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      });
      throw new Error(
        `plate_in_use — ${plateAfterEdit} is already inside: session #${clash.id}, entered ${enteredAt}. `
        + 'Close that stay first, or correct this one to a different plate.',
      );
    }
  }

  // Apply the easy text/state fields first.
  let working = updateSessionFields(id, {
    plate,
    entryAt: patch.entryAt,
    exitAt: patch.exitAt,
    paymentStatus: patch.paymentStatus,
    notes: patch.notes,
  });
  if (!working) throw new Error('update_failed');

  // Keep the journey status consistent with exit_at. The editor can set or clear
  // an exit time, but never touched `status`, so a session closed by hand stayed
  // 'entered' (showing as still inside, and re-openable by a stray plate read)
  // and one re-opened by clearing exitAt stayed 'exited'. A manual_release keeps
  // its status while it still has an exit — that's a legitimate closed state.
  const desiredStatus = working.exitAt
    ? (working.status === 'entered' ? 'exited' : working.status)
    : 'entered';
  if (desiredStatus !== working.status) {
    working = updateSessionFields(id, { status: desiredStatus }) ?? working;
  }

  // Recompute duration + fee if BOTH ends are set. Rate resolution mirrors the
  // live exit flow (parking-flow.handleExit): the ENTRY lane governs the rate,
  // then the exit lane, then the site-default plan. A caller override wins for
  // admin "what would this cost under plan X" exploration.
  if (working.exitAt) {
    const durationMinutes = stayDurationMinutes(working.entryAt, working.exitAt);

    // Duration always follows the timestamps — it is a fact about the stay, not
    // money. Whether the FEE may be rewritten is a policy question with a history
    // behind it, so it lives in one testable place: see
    // shouldRepriceEditedSession in parking-flow.
    // S5: once a stay has actually collected money, its fee is LOCKED. Checked
    // against the ledger (a paid transaction), not the editable payment_status
    // field — so neither the flip-flop bypass (paid→pending→paid) nor a policy
    // pick can rewrite revenue that was already taken. Duration still follows
    // the timestamps below; only the fee is frozen.
    const reprice = !sessionHasPaidTransaction(id) && shouldRepriceEditedSession({
      patchEntryAt: patch.entryAt,
      patchExitAt: patch.exitAt,
      patchPolicyIdOverride: patch.policyIdOverride,
      entryAtBefore: session.entryAt,
      exitAtBefore: session.exitAt,
      paymentStatusAfter: working.paymentStatus,
    });

    if (!reprice) {
      working = updateSessionFields(id, { durationMinutes }) ?? working;
    } else {
      let policy = patch.policyIdOverride ? getRatePolicy(patch.policyIdOverride) : null;
      if (!policy) {
        const entryLane = working.entryLaneId ? getLane(working.entryLaneId) : null;
        const exitLane = working.exitLaneId ? getLane(working.exitLaneId) : null;
        policy =
          (entryLane?.policyId ? getRatePolicy(entryLane.policyId) : null)
          ?? (exitLane?.policyId ? getRatePolicy(exitLane.policyId) : null)
          ?? getSiteDefaultRatePolicy();
      }
      const feeCents = computeFee(durationMinutes, policy, working.entryAt, working.exitAt);
      working = updateSessionFields(id, { durationMinutes, feeCents }) ?? working;
    }
  }

  // Push the edit to qparking SaaS via the retry queue. The PRE-EDIT plate goes
  // with it: for a stay that was already open before this box gained
  // sessions.external_id, the old plate is the only handle the cloud still has on
  // the record it created — without it a correction forks a second record there
  // and the original never closes.
  if (working) enqueueUpdate(working, session.plate);

  // A panel showing this car's fare is now showing something untrue, but only for
  // edits that actually invalidate it: the stay was closed by hand (nothing left
  // to collect), or the plate was corrected (the glass names the old one). A fee,
  // note or entry-time edit deliberately does NOT clear it — an operator fixing a
  // note must not blank the screen of a driver who is mid-tap, and the amount in
  // flight at the terminal is the one already quoted either way.
  const closedByEdit = !!working?.exitAt && !session.exitAt;
  const plateCorrected = !!plate && plate !== session.plate;
  if (closedByEdit || plateCorrected) {
    clearFareForSession(id, closedByEdit ? 'stay closed by an operator edit' : 'plate corrected by an operator');
  }
  // S9: audit in the main process — an edit that rewrites a stay's plate, times
  // or payment must be recorded regardless of whether the renderer survived to
  // log it.
  if (working) {
    audit({
      eventKey: 'session.edited', action: 'edit', category: 'session', severity: 'high',
      outcome: 'ok', resourceType: 'parking_record', resourceId: String(id),
      description: `Session edited · ${working.plate} · ${working.paymentStatus}`,
    });
  }
  return working;
});

// ─── session → cloud delivery (Sessions page) ───────────────────────────────
// How many sessions the cloud doesn't have, or doesn't have the current version
// of. Drives the page's "Push to cloud (N)" badge.
ipcMain.handle('sessions:unsynced-count', () => countSessionsNeedingCloudPush());

// Re-enqueue every session the cloud is missing or holding stale, then drain.
// The queue is still the delivery mechanism (persistent, retrying) — this only
// decides WHAT goes into it, from the sessions' own watermark rather than from
// whatever happened to be enqueued at the time.
ipcMain.handle('sessions:push-unsynced', async () => {
  const pending = listSessionsNeedingCloudPush();
  for (const session of pending) {
    // An open session posts as an entry; a closed one posts its exit (which the
    // cloud upsert treats as closing the same record).
    if (session.exitAt) enqueueExit(session);
    else enqueueEntry(session);
  }
  const status = await drainNow();
  // Not audited, per the same rule as the mirror pull: a sync action is
  // bookkeeping, and the outcome is already on the row itself (each session's
  // Synced / Not-synced badge and its cloud_sync_error).
  return { queued: pending.length, remaining: countSessionsNeedingCloudPush(), status };
});

// Sync queue inspection + manual controls (Dashboard panel uses these).
ipcMain.handle('sync:status', () => getSyncStatus());
ipcMain.handle('sync:drain-now', () => drainNow());
ipcMain.handle('sync:retry-failed', () => ({ retried: retryAllFailedSync() }));
ipcMain.handle('sync:backfill-sessions', async () => {
  const result = backfillAllSessions();
  // Kick a drain right away so the queue starts flushing immediately.
  await drainNow();
  return result;
});
// Push every local transaction to the cloud ledger (Transactions page "Sync
// now"). Enqueues then drains, returning the count queued + resulting status.
ipcMain.handle('sync:backfill-transactions', async () => {
  const result = backfillAllTransactions();
  const status = await drainNow();
  return { ...result, status };
});

ipcMain.handle('policies:list', () => listRatePolicies());
ipcMain.handle('policies:sync', () => syncRatePolicies());

// Mirrored config from qparking SaaS — read-only locally. Sync handlers
// each force a fresh pull from the cloud + return the new count. The
// background sync also refreshes these on its 60s timer.
ipcMain.handle('parking-spaces:list', () => listParkingSpaces());
ipcMain.handle('parking-spaces:sync', () => syncParkingSpaces());
ipcMain.handle('season-passes:list', () => listSeasonPasses());
ipcMain.handle('season-passes:sync', () => syncSeasonPasses());
// The deny list, on its own. It had no handler at all: the ONLY way to refresh
// the list the gate enforces on was the global "Sync now", so the Vehicles page
// could freshen the red Blocked badges it displays while leaving the barrier's
// own copy stale — the UI showing a ban that was not being enforced.
ipcMain.handle('blocked-plates:sync', () => syncBlockedPlates());
ipcMain.handle('blocked-plates:list', () => listBlockedPlates());
ipcMain.handle('activity-logs:push', () => pushActivityLogsToCloud());
// Read-only directories. Deliberately NOT on the 60s background tick (they
// change rarely and only feed lookups, never a gate decision) — refreshed by
// "Sync now" in Settings or each page's own Sync-from-cloud button.
ipcMain.handle('cloud-customers:list', () => listCloudCustomers());
ipcMain.handle('cloud-customers:sync', () => syncCloudCustomers());
ipcMain.handle('cloud-vehicles:list', () => listCloudVehicles());
ipcMain.handle('cloud-vehicles:sync', () => syncCloudVehicles());
ipcMain.handle('activity-logs:list', () => ({ rows: listActivityLogs(), total: countActivityLogs() }));
ipcMain.handle('activity-logs:insert', (_e, payload: ActivityLogPayload) => insertActivityLog(payload));
// "Test price" — simulate the fee a rate plan charges for an entry→exit window.
ipcMain.handle('policies:simulate', (_e, input: { policyId: string; entry: string; exit: string }) =>
  simulateRatePolicyFee(input.policyId, input.entry, input.exit));

// Build version — used by the renderer sidebar to confirm the live build.
// Reads from package.json baked at build time via electron's app.getVersion().
ipcMain.handle('app:version', () => ({
  version: app.getVersion(),
  isPackaged: app.isPackaged,
  builtAt: process.env.BUILD_TIMESTAMP || 'unknown',
}));

/**
 * Operator-facing "Clear cache" action. Wipes everything Electron caches in
 * its session — HTTP responses, service workers, IndexedDB, localStorage,
 * cookies. Useful when the renderer is showing stale data after a version
 * bump (e.g. old API responses cached, or sticky settings from a previous
 * build).
 *
 * Does NOT touch the SQLite app DB — sessions, terminals, cameras, lanes,
 * policies, sync queue, settings all survive. That's intentional: a clear-
 * cache must never destroy operational data, only browser-layer state.
 *
 * After clearing, the window auto-reloads so the operator sees a fresh
 * fetch of everything.
 */
ipcMain.handle('app:clear-cache', async () => {
  const startedAt = Date.now();
  const ses = session.defaultSession;
  await ses.clearCache();
  await ses.clearStorageData({
    storages: ['cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'serviceworkers', 'cachestorage'],
  });
  // Reload the renderer so the freshly-emptied cache shows immediately.
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.reloadIgnoringCache(); } catch { /* ignore */ }
  }
  return {
    ok: true,
    elapsedMs: Date.now() - startedAt,
    clearedAt: new Date().toISOString(),
  };
});

ipcMain.handle('settings:get', () => getSettings());
ipcMain.handle('site:get-current', () => getCurrentSite());
ipcMain.handle('settings:save', (_e, patch) => {
  const prev = getSettings();
  // C2: never tear down the W4G callback listener while a card payment is
  // mid-tap. Turning the master switch off — or changing a callback port —
  // closes the ports immediately; if a driver then taps, the device deducts but
  // the PayResult has nowhere to land (money taken, no ledger row, and the
  // exit times out into an auto-retrigger). Checked BEFORE saveSettings so a
  // refusal leaves the settings untouched, not half-applied.
  const pending = w4gStatus().pending;
  if (pending.length > 0) {
    const tngWouldChange =
      (patch.tngEnabled !== undefined && patch.tngEnabled !== prev.tngEnabled) ||
      (patch.tngCallbackPort !== undefined && patch.tngCallbackPort !== prev.tngCallbackPort) ||
      (patch.tngCallbackPorts !== undefined
        && JSON.stringify(patch.tngCallbackPorts) !== JSON.stringify(prev.tngCallbackPorts));
    if (tngWouldChange) {
      const n = pending.length;
      throw new Error(
        `Can't change the payment terminal settings right now — ${n} card payment${n > 1 ? 's are' : ' is'} `
        + `mid-tap at the terminal. Wait for ${n > 1 ? 'them' : 'it'} to settle (or cancel at the device) first, `
        + 'or a driver could be deducted with the callback port already closed.',
      );
    }
  }
  const next = saveSettings(patch);
  // W4G TNG callback listener: same rule — only touch it when the master switch
  // or the callback port(s) actually change value.
  const tngChanged =
    next.tngEnabled !== prev.tngEnabled ||
    next.tngCallbackPort !== prev.tngCallbackPort ||
    JSON.stringify(next.tngCallbackPorts) !== JSON.stringify(prev.tngCallbackPorts);
  if (tngChanged) {
    if (next.tngEnabled) startW4gServer();
    else stopW4gServer();
  }
  return next;
});

// ─── site re-provision (changing the API key to a different site) ───────────
// The box is bound to ONE cloud site. Pointing the API key at a different site
// is a re-provision, not an ordinary settings edit: it must clear the old
// site's local data so nothing leaks/lingers. The renderer previews the
// candidate site first, and only calls site:rebind after the operator confirms.

// Resolve which site a candidate key belongs to (no persistence) and report
// whether it differs from the site this box is currently bound to.
ipcMain.handle('site:preview-rebind', async (_e, input: { baseUrl: string; apiKey: string }) => {
  try {
    const candidate = await fetchSiteWith(input.baseUrl, input.apiKey);
    const boundId = getBoundSiteId();
    const bound = boundId ? getSite(boundId) : null;
    return {
      ok: true,
      // "changed" only when the box is ALREADY bound to a different site.
      // An unbound box (first provisioning) just adopts the site on first sync.
      changed: !!boundId && boundId !== candidate.id,
      candidateSite: { id: candidate.id, name: candidate.name },
      boundSite: bound ? { id: bound.id, name: bound.name } : null,
      // C9: how many cars are still on site. A rebind wipes them, so the confirm
      // dialog warns with this count — it does not block (wiping is the point).
      openSessions: listOpenSessions().length,
    };
  } catch (error) {
    return { ok: false, error: describeRequestError(error) };
  }
});

// Commit the switch: persist the new credentials, wipe the old site's data
// (equipment optional) and pull the new site fresh (syncSite re-binds). Equipment
// is NOT auto-pushed — after a rebind the operator decides per device page
// whether to Push this box's equipment up or Pull the new site's down.
ipcMain.handle('site:rebind', async (_e, input: { baseUrl: string; apiKey: string; wipeEquipment: boolean }) => {
  // C9: refuse while a card payment is mid-tap. A rebind deletes sessions and
  // transactions; a PayResult landing after the wipe would settle against a row
  // that no longer exists — money taken, no record. Parked cars are different:
  // wiping is the purpose of moving to a new site, so those are warned in the
  // confirm dialog (open-session count) rather than blocked here.
  const pendingPay = w4gStatus().pending;
  if (pendingPay.length > 0) {
    const n = pendingPay.length;
    throw new Error(
      `Can't switch sites right now — ${n} card payment${n > 1 ? 's are' : ' is'} mid-tap at the terminal. `
      + `Wait for ${n > 1 ? 'them' : 'it'} to settle (or cancel at the device) first; a rebind would delete the `
      + 'stay the payment settles against.',
    );
  }
  const previousId = getBoundSiteId();
  const previousName = previousId ? getSite(previousId)?.name ?? null : null;
  saveSettings({ qparkingBaseUrl: input.baseUrl, qparkingApiKey: input.apiKey });
  resetLocalDataForRebind({ wipeEquipment: !!input.wipeEquipment });
  // Wiping equipment deletes the rows but not the live plumbing those rows
  // started, so tear all of it down — the same set devices:pull-cloud rebuilds,
  // for the same reason. The ffmpeg grabbers and the SDK relay handles would
  // otherwise keep streaming from, and holding a login against, cameras that
  // belong to the previous site; the LPR listeners would keep ports bound that
  // nothing asks for any more (all but the always-bound default are released);
  // and an LCD link left up would go on pushing frames to a panel this box no
  // longer owns.
  if (input.wipeEquipment) {
    resyncRtspGrabbers();
    resyncCameraRelay();
    startLprServers();
    reloadLcdLinks();
  }
  const pull = await syncAll();               // syncSite adopts + binds the new site
  const site = getCurrentSite();
  // The single most destructive thing an operator can do on this box — it wipes
  // the old site's local data — and it went completely unrecorded. Written AFTER
  // the pull on purpose: the wipe clears activity_logs, and syncAll's mirror-down
  // would replace anything written before it.
  audit({
    eventKey: 'config.site.rebound',
    action: 'edit',
    category: 'config',
    severity: 'critical',
    outcome: 'ok',
    resourceType: 'app_settings',
    resourceId: site?.id ?? null,
    description: `Box re-provisioned to site "${site?.name ?? '?'}"${previousName ? ` (was "${previousName}")` : ' (first binding)'}`
      + ` · local sessions/transactions/activity wiped${input.wipeEquipment ? ', equipment wiped too' : ', equipment kept'}`,
    changes: { previousSiteId: previousId, newSiteId: site?.id ?? null, wipeEquipment: !!input.wipeEquipment },
  });
  return {
    ok: true,
    boundSite: site ? { id: site.id, name: site.name } : null,
    ...pull, // site / policies / passes / spaces SyncResults for the report panel
  };
});

// ─── TNG W4G test triggers + status ────────────────────────────────────────
// Used by the Settings page panel so an operator can hit "Test PayRequest" /
// "Test PayCancel" / "Ping" without spinning up a real parking session, and
// see live result frames as they come back from the IO controller.
ipcMain.handle('tng:loopback', (_e, opts?: any) => tngLoopback(opts ?? {}));
ipcMain.handle('tng:status', () => w4gStatus());
ipcMain.handle('tng:test-pay-request', async (_e, opts?: {
  payAmount?: number; discountAmount?: number; enterTime?: number; payTime?: number; orderId?: string;
  host?: string; port?: number;
}) => {
  const setting = getSettings();
  if (!setting.tngEnabled) return { ok: false, orderId: '', error: 'tng_disabled — flip the master switch on first' };

  // A real charge in flight means a driver is standing at a barrier with their
  // card out. Firing a test PayRequest competes for that same reader, and once
  // both are live nobody can tell afterwards which tap paid for the car. Refuse.
  const inFlight = w4gStatus().pending;
  if (inFlight.length > 0) {
    const first = inFlight[0];
    return {
      ok: false,
      orderId: '',
      error: `a real charge is in flight (order ${first.orderId.slice(0, 8)}…, ${rm(first.payAmount)}) — wait for it to settle before firing a test charge`,
    };
  }

  // This used to call startW4gServer() unconditionally "to make sure the
  // listener is up". That was the opposite of safe: startW4gServer() BEGINS with
  // stopW4gServer(), so on a healthy box the button closed every bound callback
  // port. Two ways that hurt. A charge already awaiting its PayResult lost the
  // only path home — the device posts Connection: close, so its retry needs a
  // fresh socket on a port that is no longer bound. And the immediate rebind
  // races its own closing listener (libuv sets SO_EXCLUSIVEADDRUSE on Windows,
  // which makes that conflict MORE likely, not less); a rebind that loses leaves
  // activePorts EMPTY, and since only a listen callback ever refills it, every
  // paid exit then refuses at the boom until someone restarts the app or saves a
  // TNG setting.
  //
  // Lifecycle is not this handler's job. Boot and settings:save own it. So do
  // what tng:loopback already does — check, don't restart — and refuse with the
  // reason, which is exactly the contract the test panel already advertises
  // ("Requires the listener enabled above").
  const listener = payResultListenerReady();
  if (!listener.ok) {
    return {
      ok: false,
      orderId: '',
      error: `${listener.reason} — no test charge sent, because a tap would deduct money this app could never record`,
    };
  }

  // For the dev test panel, use a TEST<epoch> orderId. Matches the merchant's
  // reference tester's format and is easy to grep in the W4G device's own
  // debug log — production exits use the random hex orderId from
  // newTngOrderId() to avoid plate-keyed collisions. host/port target the
  // specific device picked in the panel (multi-device); omitted → settings.
  const orderId = opts?.orderId ?? `TEST${Math.floor(Date.now() / 1000)}`;
  try {
    const body = await tngPayRequest({
      orderId,
      payAmount: opts?.payAmount ?? 100,
      discountAmount: opts?.discountAmount ?? 0,
      enterTime: opts?.enterTime,
      payTime: opts?.payTime,
      host: opts?.host,
      port: opts?.port,
    });
    // A test PayRequest is a REAL request at a REAL device: if someone taps, they
    // are really deducted, against no parking session. That has to be in the
    // audit trail — otherwise a genuine deduction exists with no record on this
    // box explaining where it came from.
    audit({
      eventKey: 'device.tng.test_pay_request',
      action: 'payment',
      category: 'device',
      severity: 'medium',
      outcome: body.state === '0' ? 'ok' : 'failed',
      resourceType: 'local_terminal',
      correlationId: orderId,
      description: `TNG test charge from the Settings panel · ${rm(opts?.payAmount ?? 100)} · order ${orderId}`
        + ` · device ${opts?.host ?? 'settings default'}${opts?.port ? `:${opts.port}` : ''}`
        + ` · result state=${body.state}${body.cardNo ? ` card ${body.cardNo}` : ''}`
        + (body.state === '0' ? ' — A CARD WAS ACTUALLY CHARGED (no parking session attached).' : ''),
      changes: { orderId, payAmountCents: opts?.payAmount ?? 100, resultState: body.state, cardNo: body.cardNo ?? null },
    });
    return {
      ok: body.state === '0',
      orderId,
      resultState: body.state,
      payType: body.payType,
      cardNo: body.cardNo,
      balance: body.balance,
      stan: body.stan,
      apprCode: body.apprCode,
    };
  } catch (e: any) {
    audit({
      eventKey: 'device.tng.test_pay_request',
      action: 'payment',
      category: 'device',
      severity: 'medium',
      outcome: 'failed',
      resourceType: 'local_terminal',
      correlationId: orderId,
      description: `TNG test charge from the Settings panel FAILED · order ${orderId} · ${e?.message ?? String(e)}`,
    });
    return { ok: false, orderId, error: e?.message ?? String(e) };
  }
});
// ─── App self-update channel ───────────────────────────────────────────────
// Settings page calls these to check the qparking cloud for a newer
// build and download + apply it. Implementation lives in app-update.ts.
ipcMain.handle('app-update:check', () => checkForUpdate());
ipcMain.handle('app-update:download', async (_e, opts: { variant: 'portable' | 'installer'; expectedSha256?: string | null }) => {
  // expectedSha256 is the digest /latest-built published for this variant. The
  // renderer already has it from the check step, so it rides along rather than
  // costing a second cloud round-trip. Absent (older SaaS) = nothing to verify
  // against, which downloadUpdate reports as `verified: false`.
  const result = await downloadUpdate({
    variant: opts.variant,
    expectedSha256: opts.expectedSha256 ?? null,
    onProgress: (p) => sendToRenderer('app-update-progress', p),
  });
  if (!result.ok) {
    audit({
      eventKey: 'app.update.download_failed',
      action: 'edit', category: 'lifecycle', severity: 'high', outcome: 'failed',
      resourceType: 'app_settings',
      description: `Update download REJECTED — ${result.error ?? 'unknown error'}. Nothing was installed.`,
      changes: { variant: opts.variant, expected: result.expectedSha256 ?? null, actual: result.sha256 ?? null },
    });
  } else if (!result.verified) {
    // Not a failure, but it must not pass silently: this build is about to be
    // executed with no integrity check at all, because the cloud published none.
    audit({
      eventKey: 'app.update.unverified',
      action: 'edit', category: 'lifecycle', severity: 'high', outcome: 'ok',
      resourceType: 'app_settings',
      description: `Update downloaded but NOT verified — the cloud published no sha256 for the ${opts.variant} build,`
        + ` so its integrity could not be checked. Upgrade the SaaS to get a digest.`,
      changes: { variant: opts.variant, bytes: result.bytes ?? null, sha256: result.sha256 ?? null },
    });
  }
  return result;
});
ipcMain.handle('app-update:apply', (_e, opts: { path: string; expectedSha256?: string | null }) => {
  // Logged BEFORE applying: this call relaunches the app, so a row written after
  // it may never happen. Every parking-flow log line is stamped with the build
  // version, so knowing exactly when the build changed is what lets an operator
  // tie "it started misbehaving around 3pm" to an update.
  audit({
    eventKey: 'app.update.applied',
    action: 'edit',
    category: 'lifecycle',
    severity: 'high',
    outcome: 'ok',
    resourceType: 'app_settings',
    description: `Applying a downloaded update from ${opts?.path ?? '?'} · leaving version ${app.getVersion()} — the app restarts now.`,
  });
  // forceQuit, not app.quit(): the installer is about to replace this binary, so
  // the services must stop and the DB must checkpoint first — and once the VzLPR
  // SDK is loaded the ordinary quit path hangs in native teardown, which would
  // leave the wizard fighting a live process. See forceQuit.
  return applyUpdate({ ...opts, onQuit: forceQuit });
});

ipcMain.handle('tng:test-pay-cancel', async (_e, orderId: string, target?: { host?: string; port?: number }) => {
  if (!orderId) return { ok: false, error: 'orderId_required' };
  try {
    const ack = await tngPayCancel(orderId, target);
    audit({
      eventKey: 'device.tng.test_pay_cancel',
      action: 'payment',
      category: 'device',
      severity: 'low',
      outcome: ack.state === 0 ? 'ok' : 'failed',
      resourceType: 'local_terminal',
      correlationId: orderId,
      description: `TNG test PayCancel sent for order ${orderId} · device answered state=${ack.state}`,
    });
    return { ok: ack.state === 0, deviceState: ack.state };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
});

ipcMain.handle('diagnose:lpr', () => require('./services/lpr-webhook').diagnose());

// Open the barrier for a lane/camera by pulsing the camera's onboard relay (the
// real barrier wired to the LPR camera's IO output). Shared by the Live-display
// "Open barrier" button and the Sessions "Manual release" (which lets the car
// out on release).
//
// Unlike the automatic paths this pulses without asking any access question —
// no blacklist check, no pass check, no fee. An operator pressing the button has
// already made the decision and expects the boom to move.
async function openBarrier(opts: { cameraId?: number | null; laneId?: number | null; reason?: string } = {}) {
  let camera = opts.cameraId ? (listCameras().find((c) => c.id === opts.cameraId) ?? null) : null;
  const lane = opts.laneId ? getLane(opts.laneId) : (camera?.laneId ? getLane(camera.laneId) : null);
  // Given only a lane, resolve the camera whose relay is the boom we mean.
  //
  // This used to take `listCameras().find(c => c.laneId === lane.id && c.enabled)`
  // — any enabled camera — and listCameras() is ordered by id, so on a lane
  // holding both cameras it pulsed the ENTRY relay. The only caller that reaches
  // this branch is the manual release (both UI buttons pass an explicit
  // cameraId), and a release always means "let this car OUT", so the exit-facing
  // camera is the boom the operator is standing at.
  //
  // Falls back to any enabled camera rather than refusing: the operator has
  // already decided the car should go, and a lane wired entry-only still has a
  // relay worth pulsing. The fallback is named in the note and the audit row, so
  // "we opened a different boom than you meant" is never silent.
  let facingFallback = false;
  if (!camera && lane) {
    camera = laneCameraFacing(lane.id, 'exit');
    if (!camera) {
      camera = listCameras().find((c) => c.laneId === lane.id && c.enabled) ?? null;
      facingFallback = !!camera;
    }
  }
  const laneName = lane?.name ?? camera?.name ?? 'MANUAL OPEN';
  const reason = opts.reason ?? 'manual-operator-open';
  const relay = camera ? await pulseBarrier(camera.id) : { ok: false, error: 'no_camera' };
  // Audited HERE rather than in the pages that call it, so every caller is
  // covered by construction — the Live-display tile used to write this row
  // itself, which meant the identical action from the Cameras page ("test
  // barrier", which really does open the boom) recorded nothing at all.
  //
  // The manual-release path is exempt: session.manual_release already records
  // that decision, and this would be a second row for the same operator action.
  if (reason !== 'manual-release') {
    audit({
      eventKey: 'gate.manual.opened',
      action: 'access',
      category: 'gate',
      severity: 'high',
      outcome: relay.ok ? 'ok' : 'failed',
      resourceType: 'local_lane',
      resourceId: lane?.id != null ? String(lane.id) : null,
      description: `Barrier opened by hand · ${laneName}${camera ? ` · ${camera.name}` : ' · no camera resolved'}`
        + (facingFallback ? ` (no exit-facing camera on this lane — pulsed the ${camera?.direction} relay instead)` : '')
        + (relay.ok ? ' — relay pulsed' : ` — relay FAILED: ${relay.error ?? 'unknown'}`),
      changes: { laneId: lane?.id ?? null, cameraId: camera?.id ?? null, reason, facingFallback, relayError: relay.ok ? null : relay.error ?? null },
    });
  }
  return {
    ok: relay.ok,
    note: relay.ok
      ? `Barrier opened for ${laneName} · camera-relay pulsed`
        + (facingFallback ? ` (no exit camera on this lane — pulsed "${camera?.name}", which faces ${camera?.direction})` : '')
      : `Barrier did NOT open for ${laneName} · ${camera ? `relay ${relay.error}` : 'no camera resolved for this lane'}`,
  };
}

// Manual operator "open barrier" from the Live display.
ipcMain.handle('gate:manual-open', (_e, opts: { cameraId?: number | null; laneId?: number | null } = {}) => openBarrier(opts));
// Staff admitting a car by hand: the plate the camera could not read, or an entry
// camera that is down. Goes through the real flow — see admitVehicleByOperator.
ipcMain.handle('gate:admit-vehicle', (_e, input: { laneId: number; plate: string }) =>
  admitVehicleByOperator(input.laneId, input.plate));


ipcMain.handle('sync:all-tables', async () => {
  // Pull-only: cloud-owned config (site / policies / passes / spaces). Equipment
  // (cameras / lanes / terminals) is NO LONGER pushed here — it syncs manually,
  // per type, from each device page via the Push/Pull-to-cloud buttons.
  // Deliberately NOT audited. A sync is the one event that cannot log itself
  // cleanly: syncAll() pushes pending activity rows BEFORE it pulls, so a row
  // written here always misses that push and sits at "Not pushed yet" until the
  // NEXT sync — which writes another one. The pending count would never reach
  // zero, and the log would fill with its own bookkeeping.
  //
  // The outcome is already visible where it belongs: the header's "last synced"
  // stamp (deliberately NOT refreshed on a failed pull, see stampPullOutcome)
  // and the per-mirror report the Settings page renders from these results.
  return await syncAll();
});

// Initial state for the header's "last synced" stamp. Live updates then arrive
// on the 'cloud-pull' event, so this is only read once per window.
ipcMain.handle('sync:cloud-pull-state', () => getCloudPullState());

// ─── manual equipment sync (per device page: Push / Pull to cloud) ──────────
ipcMain.handle('devices:preview-sync', (_e, type: DeviceType, direction: 'push' | 'pull') =>
  previewDeviceSync(type, direction));

ipcMain.handle('devices:push-cloud', async (_e, type: DeviceType) => {
  const result = await pushDevicesToCloud(type);
  audit({
    eventKey: 'config.devices.pushed',
    action: 'edit',
    category: 'device',
    severity: 'medium',
    outcome: result.ok ? 'ok' : 'failed',
    resourceType: deviceResourceType(type),
    description: result.ok
      ? `Pushed this box's ${type} list to the cloud · ${result.items?.length ?? 0} sent${result.removed ? `, ${result.removed} soft-deleted in the cloud` : ''}`
      : `Push of the ${type} list to the cloud FAILED — ${result.error ?? 'unknown error'}`,
  });
  return result;
});

ipcMain.handle('devices:pull-cloud', async (_e, type: DeviceType) => {
  const result = await pullDevicesFromCloud(type);
  // A pull rewrites local camera/lane rows and their links — refresh the
  // capture pipelines so grabbers/relay track the new set, and rebind the
  // listeners: a pull can DELETE a camera (freeing its port) or re-create one on
  // the default port, and the webhook port is a local column the cloud never
  // sends.
  // The panel links are rebuilt too: a pull can add, move, disable or delete a
  // display, and a link left pointing at the old address would keep pushing
  // frames into the dark until the app restarted.
  if (result.ok) {
    resyncRtspGrabbers(); resyncCameraRelay(); startLprServers(); reloadLcdLinks();
    // A pull REPLACES the equipment set, so stale health rows would otherwise
    // describe devices that no longer exist. The sweep also prunes them.
    void sweepDeviceHealth().catch(() => null);
  }
  // A pull REPLACES this box's equipment config. Without a row, "who changed the
  // camera wiring?" had no answer — the per-device save rows only cover edits
  // made on the device pages themselves.
  audit({
    eventKey: 'config.devices.pulled',
    action: 'edit',
    category: 'device',
    severity: 'high',
    outcome: result.ok ? 'ok' : 'failed',
    resourceType: deviceResourceType(type),
    description: result.ok
      ? `Replaced this box's ${type} list with the cloud's · ${result.applied ?? 0} row(s) applied`
      : `Pull of the ${type} list from the cloud FAILED — ${result.error ?? 'unknown error'}`,
  });
  return result;
});
