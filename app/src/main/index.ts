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
import type { ActivityLogPayload } from '../shared/types';

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
  listCameras, upsertCamera, deleteCamera,
  listLanes, upsertLane, deleteLane, getLane, setLaneCameras,
  listOpenSessions, listRecentSessions, manualReleaseSession, getSessionById,
  countSessions, listSessionsPage, deleteSession,
  updateSessionFields,
  getTransactionById, getOpenTransactionForSession, updateTransaction,
  listTransactionsPage, countTransactions,
  listRatePolicies, getRatePolicy, getSiteDefaultRatePolicy,
  listParkingSpaces, listSeasonPasses, listCloudCustomers, listCloudVehicles,
  findSeasonPassByPlate,
  getCurrentSite, getSite, getBoundSiteId, resetLocalDataForRebind,
  listActivityLogs, insertActivityLog,
} from './services/db';
import { computeFee, stayDurationMinutes, retriggerSessionExit, retriggerSessionExitByPlate, simulateRatePolicyFee, simulateEntryAt, simulateExitAt, cancelExitInFlight, startParkingFlow, parkingEvents } from './services/parking-flow';
import { canonicalPlate } from '../shared/plate';
import { startLprServer, lprEvents, getLatestFrame } from './services/lpr-webhook';
import {
  syncRatePolicies, syncParkingSpaces, syncSeasonPasses,
  syncCloudCustomers, syncCloudVehicles,
  syncAll, syncSite, fetchSiteWith,
  cloudPullEvents, getCloudPullState,
  pushActivityLogsToCloud,
} from './services/cloud-sync';
import { describeRequestError } from './services/cloud-api';
import { openGateSimulator, sendGateEvent } from './gate-simulator';
import { openFaceGate } from './services/face-gate';
import {
  startSyncDrain, syncEvents, getSyncStatus, drainNow,
  enqueueEntry, enqueueExit, enqueueUpdate, enqueueDelete, enqueueTransaction,
  backfillAllSessions, backfillAllTransactions,
} from './services/cloud-queue';
import { retryAllFailedSync } from './services/db';
import { pingCamera, pingHost } from './services/camera-probe';
import { pingTerminalHost } from './services/payment-probe';
import { startCameraRelay, stopCameraRelay, resync as resyncCameraRelay, pulseBarrier } from './services/camera-relay';
import { startRtspGrabbers, stopRtspGrabbers, resync as resyncRtspGrabbers } from './services/camera-rtsp';
import { previewDeviceSync, pushDevicesToCloud, pullDevicesFromCloud, type DeviceType } from './services/device-sync';
import {
  startW4gServer, stopW4gServer, payRequest as tngPayRequest, payCancel as tngPayCancel,
  loopbackPayResult as tngLoopback,
  w4gStatus, w4gEvents, newOrderId as newTngOrderId,
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

  const settings = getSettings();
  // Dev and packaged builds both bind the operator-configured LPR port
  // (default 6001) so a camera pointed at 6001 works the same either way.
  // If a packaged install is already running when you start `npm run dev`,
  // the dev listener's bind fails with EADDRINUSE — startLprServer() logs
  // that and keeps the rest of the app working rather than crashing.
  const lprPort = settings.lprWebhookPort;
  console.log(`[boot] mode=${IS_DEV_MODE ? 'dev' : 'packaged'} · LPR listener → :${lprPort}`);
  startLprServer(lprPort);
  startParkingFlow();
  // One-shot cloud pull at boot — the recurring 60s tick was removed, so the
  // cloud-owned mirrors (passes, deny list, spaces, activity) refresh only here
  // and on the operator's manual "Sync now" / site rebind. The local SQLite
  // cache persists across restarts, so a failed boot pull just leaves the gate
  // pricing and gating from the last successful sync.
  void syncAll().catch(() => null);
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

  // Stream parking + lpr events to renderer.
  wireRendererEvents();

  createWindow();
  createTray();
});

app.on('before-quit', () => { stopRtspGrabbers(); stopCameraRelay(); });

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
      { label: 'Quit', click: () => { app.exit(0); } },
    ]));
    tray.on('double-click', showWindow);
  } catch { /* tray fails on some Linux DEs — non-fatal */ }
}

// ─── renderer event fan-out ────────────────────────────────────────────────

/**
 * Raise the physical barrier for an event this app authorised.
 *
 * Only fires when parking-flow marked the event `barrier: 'app'` — i.e. the
 * camera is in 'pass_only' mode and we made the access decision ourselves. An
 * 'open'-mode camera opens its own relay exactly as it always has, and must NOT
 * be pulsed here or every site would get a double fire.
 *
 * Best-effort by design: a failed pulse is logged for the operator but never
 * throws, because a dead relay must not take down the session flow. The usual
 * cause is missing device credentials — which the Cameras form now refuses to
 * save alongside 'pass_only' precisely so this can't happen silently.
 */
function pulseAppOwnedBarrier(payload: any, side: 'entry' | 'exit'): void {
  if (payload?.barrier !== 'app') return;
  const cameraId = payload?.cameraId ?? payload?.event?.cameraId ?? payload?.session?.entryCameraId;
  if (!cameraId) return;
  const relay = pulseBarrier(cameraId);
  sendToRenderer('log', {
    terminalId: 0,
    direction: relay.ok ? 'info' : 'error',
    message: relay.ok
      ? `Barrier opened for an authorised ${side} (camera ${cameraId})`
      : `Barrier pulse FAILED on ${side} (camera ${cameraId}): ${relay.error ?? 'unknown'} — the driver is authorised but the gate did not move. Check the camera's host / username / password.`,
    payload: { cameraId, side, relay },
  });
}

function wireRendererEvents() {
  lprEvents.on('plate', (event) => sendToRenderer('plate-detected', event));
  for (const ev of ['entry', 'exit-pending', 'exit-completed', 'exit-declined', 'warning', 'rescan-ignored', 'entry-ignored-recent-exit'] as const) {
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

  // Drive the gate-simulator window. Entry events open the gate inbound; a
  // successful exit (paid / free / manual_release) opens it outbound. Failed
  // exits keep the gate closed — the operator handles those manually.
  parkingEvents.on('entry', (p: any) => {
    const laneName = p?.session?.entryLaneId ? getLane(p.session.entryLaneId)?.name : undefined;
    // A blacklisted plate never reaches here — handleEntry refuses before it
    // creates a session or emits this event — so WELCOME, the turnstile and the
    // cloud mirror below are all unreachable for a banned vehicle by
    // construction, rather than by a conditional that could be missed.
    sendGateEvent({ state: 'open', plate: p?.session?.plate, laneName, direction: 'in', holdMs: 4_000 });
    setTimeout(() => sendGateEvent({ state: 'closed' }), 4_000);
    // Pass-only camera → THIS app authorised the entry, so this app raises the
    // barrier. Gated on barrier==='app' so an ordinary 'open' camera is
    // untouched: it still opens its own relay, and a pulse here would be a
    // second, redundant fire on every existing site.
    pulseAppOwnedBarrier(p, 'entry');
    // Raise the physical face-auth turnstile on entry — same moment the gate
    // window shows WELCOME, matching how real LPR-driven parks behave.
    // openFaceGate() respects the master `faceGateEnabled` toggle, so this
    // is a no-op when the operator has turned that off.
    openFaceGate({ plate: p?.session?.plate ?? undefined, reason: 'qparking-entry' })
      .then((r) => sendToRenderer('log', { terminalId: 0, direction: r.ok ? 'info' : 'error', message: 'face-gate open (entry)', payload: r }))
      .catch(() => null);
    // Mirror to qparking SaaS via the persistent sync queue (retries on
    // failure so a temporary outage doesn't drop the entry record).
    if (p?.session) enqueueEntry(p.session);
  });

  // Inform the driver when a re-scan was ignored (plate already has an open
  // session and the entry-handles-exit toggle is OFF). Without this they'd
  // see the gate sit closed silently and not know to use the exit lane.
  parkingEvents.on('rescan-ignored', (p: any) => {
    sendGateEvent({
      state: 'closed',
      plate: p?.plate,
      laneName: 'PLEASE PAY AT EXIT',
      direction: 'in',
      reason: 'duplicate-scan',
      holdMs: 3_000,
    });
  });

  // Exit just started — fee computed, terminal about to be driven. Show
  // "PLEASE PAY RM X.XX" on the gate screen so the driver knows to tap
  // their card. Stays on this screen until exit-completed fires (success
  // = COME AGAIN, failure = no change so the operator can intervene).
  parkingEvents.on('exit-pending', (p: any) => {
    // Free exits skip the terminal entirely → exit-completed fires almost
    // immediately. Suppress the PLEASE PAY flash in that case so the
    // driver sees a clean WELCOME → COME AGAIN transition.
    if (!p?.feeCents || p.feeCents <= 0) return;
    const laneName = p?.lane?.name;
    sendGateEvent({
      state: 'closed',
      plate: p?.session?.plate,
      laneName,
      direction: 'out',
      reason: 'please-pay',
      feeCents: p.feeCents,
      // No holdMs — stays on the screen until the terminal answers.
    });
  });

  // Operator-action warnings — surface them on the gate screen so a
  // misconfigured site is OBVIOUS instead of failing silently. These map
  // to specific renderer layouts (red banner + which thing is missing).
  parkingEvents.on('warning', (p: any) => {
    const kind = p?.kind as string;
    if (kind === 'exit-blacklisted' || kind === 'entry-blacklisted') {
      // Held at the barrier for staff attention. Long hold (12s) because this
      // screen exists to be READ by whoever walks over, not to flash past — and
      // no automatic recovery follows it.
      //
      // Single owner of the BLOCKED screen for BOTH directions. The entry path
      // emits this warning first and then paints nothing, so this survives; and
      // the dev simulator's Entry button reaches the operator through here too
      // (it bypasses handleEntry entirely).
      sendGateEvent({
        state: 'closed',
        plate: p?.plate,
        direction: kind === 'entry-blacklisted' ? 'in' : 'out',
        reason: 'blacklisted',
        detail: p?.reason ?? null,
        holdMs: 12_000,
      });
      sendToRenderer('log', {
        terminalId: 0,
        direction: 'error',
        message: `BLACKLISTED plate ${p?.plate} — ${kind === 'entry-blacklisted' ? 'entered (alert only; entry barrier is not app-driven)' : 'exit refused, car held at barrier'}`,
        payload: p,
      });
      // Audit trail: a refused gate attempt is exactly what the Activity Log
      // exists for — without this row the ban fires invisibly (gate screen +
      // device log only) and the operator can't review attempts after the
      // fact. try/catch so an audit-write hiccup can never break gate flow.
      try {
        const isEntry = kind === 'entry-blacklisted';
        insertActivityLog({
          eventKey: isEntry ? 'gate.entry.blacklisted' : 'gate.exit.blacklisted',
          action: isEntry ? 'entry' : 'exit',
          category: 'gate',
          severity: 'high',
          outcome: 'blocked',
          siteId: getBoundSiteId(),
          resourceType: 'vehicle',
          resourceId: p?.vehicleId != null ? String(p.vehicleId) : (p?.plate ?? null),
          description: `Blacklisted plate ${p?.plate ?? '?'} ${isEntry
            ? 'tried to enter — refused (no session created, barrier not opened)'
            : 'tried to exit — refused, car held at barrier'}${p?.reason ? ` · reason: ${p.reason}` : ''}`,
        });
      } catch (err) {
        console.error('[activity-log] failed to record blacklist refusal', err);
      }
    } else if (kind === 'entry-not-authorised' || kind === 'exit-not-authorised') {
      // Pass-only lane, plate holds no valid pass. Same treatment as a blacklist
      // refusal — long hold, because nothing recovers automatically and the
      // screen exists to be read by whoever walks over.
      const isEntry = kind === 'entry-not-authorised';
      sendGateEvent({
        state: 'closed',
        plate: p?.plate,
        direction: isEntry ? 'in' : 'out',
        reason: 'not-authorised',
        holdMs: 12_000,
      });
      sendToRenderer('log', {
        terminalId: 0,
        direction: 'error',
        message: `NOT AUTHORISED · ${p?.plate} has no valid pass — ${isEntry ? 'entry' : 'exit'} refused at "${p?.cameraName ?? `camera ${p?.cameraId}`}". Barrier stayed closed; operator must handle this manually.`,
        payload: p,
      });
      try {
        insertActivityLog({
          eventKey: isEntry ? 'gate.entry.not_authorised' : 'gate.exit.not_authorised',
          action: isEntry ? 'entry' : 'exit',
          category: 'gate',
          severity: 'medium',
          outcome: 'blocked',
          siteId: getBoundSiteId(),
          resourceType: 'vehicle',
          resourceId: p?.plate ?? null,
          description: `${p?.plate ?? '?'} tried to ${isEntry ? 'enter' : 'exit'} a pass-only lane without a valid pass — refused, barrier not opened`,
        });
      } catch (err) {
        console.error('[activity-log] failed to record pass-only refusal', err);
      }
    } else if (kind === 'exit-pass-holder-no-entry') {
      // Let out on the strength of the pass, but recorded: a run of these means
      // the ENTRY camera is dropping reads, which is worth chasing.
      sendToRenderer('log', {
        terminalId: 0,
        direction: 'error',
        message: `${p?.plate} exited a pass-only lane with a valid pass but NO entry on record — barrier opened. Check the entry camera is reading reliably.`,
        payload: p,
      });
      try {
        insertActivityLog({
          eventKey: 'gate.exit.pass_holder_no_entry',
          action: 'exit',
          category: 'gate',
          severity: 'medium',
          outcome: 'ok',
          siteId: getBoundSiteId(),
          resourceType: 'vehicle',
          resourceId: p?.plate ?? null,
          description: `${p?.plate ?? '?'} left a pass-only lane on pass ${p?.passId ?? '?'} with no entry recorded — released, no session to close`,
        });
      } catch (err) {
        console.error('[activity-log] failed to record pass-holder exit', err);
      }
    } else if (kind === 'exit-without-entry') {
      sendGateEvent({
        state: 'closed', plate: p?.plate, direction: 'out',
        reason: 'exit-without-entry', holdMs: 4_000
      });
    } else if (kind === 'exit-no-lane') {
      sendGateEvent({ state: 'closed', direction: 'out', reason: 'no-lane', holdMs: 5_000 });
    } else if (kind === 'exit-no-terminal' || kind === 'exit-terminal-disabled' || kind === 'exit-tng-not-configured') {
      sendGateEvent({ state: 'closed', direction: 'out', reason: 'no-terminal', holdMs: 5_000 });
    } else if (kind === 'exit-terminal-offline') {
      sendGateEvent({ state: 'closed', direction: 'out', reason: 'terminal-offline', holdMs: 5_000 });
    } else if (kind === 'exit-timeout') {
      // The charge attempt timed out — car stays inside (session 'entered').
      // Push the failed attempt to the ledger so the cloud sees the decline/
      // stuck transaction; the operator retriggers or manually releases.
      if (p?.sessionId && p?.transactionId) {
        const session = getSessionById(p.sessionId);
        const txn = getTransactionById(p.transactionId);
        if (session && txn) enqueueTransaction(session, txn);
      }
    }
  });
  parkingEvents.on('exit-declined', (p: any) => {
    // Card declined — the car is still inside (session stays 'entered'). Show
    // the decline on the gate screen and push the failed transaction to the
    // ledger. The barrier stays CLOSED — operator retriggers or releases.
    const session = p?.sessionId ? getSessionById(p.sessionId) : null;
    if (session && p?.transactionId) {
      const txn = getTransactionById(p.transactionId);
      if (txn) enqueueTransaction(session, txn);
    }
    sendGateEvent({
      state: 'closed',
      plate: session?.plate,
      direction: 'out',
      reason: 'declined',
      holdMs: 5_000,
    });
  });
  parkingEvents.on('exit-completed', (p: any) => {
    // sessionId is null for a pass-only exit by a holder whose entry was never
    // recorded — there's no row to mirror, but the barrier must still open.
    const session = p?.sessionId ? getSessionById(p.sessionId) : null;
    // The car has left: mirror the exit (status change) to qparking SaaS, and
    // push the payment transaction to the ledger if this exit carried one
    // (free / pass exits have no transaction).
    if (session) enqueueExit(session);
    if (session && p?.transactionId) {
      const txn = getTransactionById(p.transactionId);
      if (txn) enqueueTransaction(session, txn);
    }
    const allowed = ['paid', 'free', 'manual_release'].includes(p?.outcome);
    if (!allowed) return;
    const laneName = session?.exitLaneId ? getLane(session.exitLaneId)?.name : undefined;
    sendGateEvent({
      state: 'open',
      // `p.plate` is the fallback for a pass-only exit with no session row.
      plate: session?.plate ?? p?.plate,
      laneName,
      direction: 'out',
      reason: p?.outcome,
      holdMs: 4_000,
    });
    setTimeout(() => sendGateEvent({ state: 'closed' }), 4_000);
    pulseAppOwnedBarrier(p, 'exit');
    // Also raise the physical face-auth turnstile, if configured. Best-effort
    // — a network failure here doesn't roll back the payment.
    openFaceGate({ plate: session?.plate ?? p?.plate ?? undefined, reason: `qparking-exit-${p?.outcome}` })
      .then((r) => sendToRenderer('log', { terminalId: 0, direction: r.ok ? 'info' : 'error', message: 'face-gate open', payload: r }))
      .catch(() => null);
  });

  // Sync status → renderer for the Dashboard panel.
  syncEvents.on('status', (status) => sendToRenderer('sync-status', status));

  // Cloud PULL outcome → renderer. Drives the header's "last synced" stamp.
  // Event-driven rather than polled: with the 60s tick gone this only changes
  // on boot, a manual "Sync now", or a rebind.
  cloudPullEvents.on('pulled', (state) => sendToRenderer('cloud-pull', state));

  // Live parking-flow debug log → renderer. Lets the operator see exactly
  // which guard fired (or didn't) without needing to open DevTools — shown
  // in a sticky strip at the bottom of the app.
  parkingEvents.on('debug-log', (p: any) => sendToRenderer('parking-flow-log', p));

  // W4G TNG activity → renderer log stream (so the Settings test panel +
  // bottom log strip can show outbound / inbound / errors live).
  w4gEvents.on('log', (entry: any) => sendToRenderer('log', { terminalId: -1, ...entry, source: 'w4g' }));
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
  return upsertTerminal(input);
});
ipcMain.handle('terminals:delete', (_e, id: number) => { deleteTerminal(id); });
// TCP reachability probe by host:port — backs the per-device "Test connection".
ipcMain.handle('terminals:ping-host', (_e, input: { host: string; port: number }) => pingTerminalHost(input.host, input.port));

ipcMain.handle('cameras:list', () => listCameras());
ipcMain.handle('cameras:save', async (_e, input) => {
  const saved = upsertCamera(input);
  // Local-only save (cloud sync is manual via the Cameras page button). Still
  // refresh the RTSP video feed and warm relay connection if host/creds changed.
  resyncRtspGrabbers();
  resyncCameraRelay();
  return saved;
});
ipcMain.handle('cameras:delete', (_e, id: number) => { deleteCamera(id); resyncRtspGrabbers(); resyncCameraRelay(); });
// Latest frame the camera pushed with a plate event — Live display fallback
// for WebSocket/RTSP-only cameras with no pullable HTTP snapshot URL.
ipcMain.handle('cameras:latest-frame', (_e, cameraId: number) => getLatestFrame(cameraId));
ipcMain.handle('cameras:ping', (_e, cameraId: number) => pingCamera(cameraId));
ipcMain.handle('cameras:ping-host', (_e, input: { host: string; port?: number }) => pingHost(input.host, input.port));

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
ipcMain.handle('lanes:delete', (_e, id: number) => deleteLane(id));

ipcMain.handle('sessions:open', () => listOpenSessions());
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
  if (findSeasonPassByPlate(s.plate, { entryAt: s.entryAt, exitAt: nowIso })) return 0;
  const entryLane = s.entryLaneId ? getLane(s.entryLaneId) : null;
  const exitLane = s.exitLaneId ? getLane(s.exitLaneId) : null;
  const policy = (entryLane?.policyId ? getRatePolicy(entryLane.policyId) : null)
    ?? (exitLane?.policyId ? getRatePolicy(exitLane.policyId) : null)
    ?? getSiteDefaultRatePolicy();
  if (!policy) return 0;
  const durationMinutes = stayDurationMinutes(s.entryAt, nowIso);
  let fee = computeFee(durationMinutes, policy, s.entryAt, nowIso);
  const minCharge = getSettings().minimumChargeCents ?? 0;
  if (minCharge > 0 && fee < minCharge) fee = minCharge;
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
ipcMain.handle('sessions:retrigger-payment', (_e, sessionId: number, laneId?: number | null) => retriggerSessionExit(sessionId, laneId));
// Live-display "retrigger payment" — operator types the plate they can read off
// the feed; we find that car's open session and re-run its exit-payment flow.
ipcMain.handle('sessions:retrigger-by-plate', (_e, plate: string, laneId?: number | null) => retriggerSessionExitByPlate(plate, laneId));
ipcMain.handle('sessions:delete', (_e, id: number) => {
  // Capture session BEFORE deleting so we have lane/plate/entryAt for the
  // qparking sync payload — otherwise the row is gone before we enqueue.
  const session = getSessionById(id);
  const ok = deleteSession(id);
  if (ok && session) enqueueDelete(session);
  return ok;
});
ipcMain.handle('sessions:release', (_e, id: number, reason: string, laneId?: number | null) => {
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

  // Canonicalise the plate exactly as the LPR ingest and the pass/blacklist
  // lookups do (shared/plate.ts). Without this, an operator typing "ABC 1234"
  // stored the space verbatim and the next camera read of ABC1234 no longer
  // matched the session — the car exited as 'exit-without-entry'.
  let plate: string | undefined;
  if (patch.plate !== undefined) {
    plate = canonicalPlate(patch.plate);
    if (!plate) throw new Error('plate_required — a plate must contain at least one letter or digit');
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

    working = updateSessionFields(id, { durationMinutes, feeCents });
  }

  // Push the edit to qparking SaaS via the retry queue.
  if (working) enqueueUpdate(working);
  return working;
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
ipcMain.handle('activity-logs:push', () => pushActivityLogsToCloud());
// Read-only directories. Deliberately NOT on the 60s background tick (they
// change rarely and only feed lookups, never a gate decision) — refreshed by
// "Sync now" in Settings or each page's own Sync-from-cloud button.
ipcMain.handle('cloud-customers:list', () => listCloudCustomers());
ipcMain.handle('cloud-customers:sync', () => syncCloudCustomers());
ipcMain.handle('cloud-vehicles:list', () => listCloudVehicles());
ipcMain.handle('cloud-vehicles:sync', () => syncCloudVehicles());
ipcMain.handle('activity-logs:list', () => listActivityLogs());
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
  const next = saveSettings(patch);
  // Restart the LPR listener ONLY when the port actually changes value. The
  // renderer saves the whole settings object, so patch.lprWebhookPort is
  // present on every save — restarting each time needlessly drops the listener
  // and races the re-bind (close() doesn't free the port instantly while live
  // /live MJPEG streams are open → EADDRINUSE → ingest silently stops).
  if (next.lprWebhookPort !== prev.lprWebhookPort) {
    startLprServer(next.lprWebhookPort);
  }
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
  saveSettings({ qparkingBaseUrl: input.baseUrl, qparkingApiKey: input.apiKey });
  resetLocalDataForRebind({ wipeEquipment: !!input.wipeEquipment });
  const pull = await syncAll();               // syncSite adopts + binds the new site
  const site = getCurrentSite();
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
  // Make sure the listener is up — without it, no PayResult callback can
  // ever land and the request will time out at the device side.
  const setting = getSettings();
  if (!setting.tngEnabled) return { ok: false, orderId: '', error: 'tng_disabled — flip the master switch on first' };
  startW4gServer();
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
    return { ok: false, orderId, error: e?.message ?? String(e) };
  }
});
// ─── App self-update channel ───────────────────────────────────────────────
// Settings page calls these to check the qparking cloud for a newer
// build and download + apply it. Implementation lives in app-update.ts.
ipcMain.handle('app-update:check', () => checkForUpdate());
ipcMain.handle('app-update:download', async (_e, opts: { variant: 'portable' | 'installer' }) => {
  return downloadUpdate({
    variant: opts.variant,
    onProgress: (p) => sendToRenderer('app-update-progress', p),
  });
});
ipcMain.handle('app-update:apply', (_e, opts: { path: string }) => applyUpdate(opts));

ipcMain.handle('tng:test-pay-cancel', async (_e, orderId: string, target?: { host?: string; port?: number }) => {
  if (!orderId) return { ok: false, error: 'orderId_required' };
  try {
    const ack = await tngPayCancel(orderId, target);
    return { ok: ack.state === 0, deviceState: ack.state };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
});

ipcMain.handle('diagnose:lpr', () => require('./services/lpr-webhook').diagnose());

// Open the barrier for a lane/camera. Mirrors the remote gate-open path: flash
// the gate simulator so the operator sees it, pulse the camera's onboard relay
// (the real barrier wired to the LPR camera's IO output), and best-effort raise
// the face-auth turnstile. Shared by the Live-display "Open barrier" button and
// the Sessions "Manual release" (which lets the car out on release).
async function openBarrier(opts: { cameraId?: number | null; laneId?: number | null; reason?: string } = {}) {
  let camera = opts.cameraId ? (listCameras().find((c) => c.id === opts.cameraId) ?? null) : null;
  const lane = opts.laneId ? getLane(opts.laneId) : (camera?.laneId ? getLane(camera.laneId) : null);
  // Given only a lane, resolve one of its enabled cameras so we can pulse the
  // relay wired to it.
  if (!camera && lane) camera = listCameras().find((c) => c.laneId === lane.id && c.enabled) ?? null;
  const laneName = lane?.name ?? camera?.name ?? 'MANUAL OPEN';
  const direction = camera?.direction === 'entry' ? 'in' : 'out';
  const reason = opts.reason ?? 'manual-operator-open';
  openGateSimulator(isDev);
  sendGateEvent({ state: 'open', laneName, direction, reason, holdMs: 5_000 });
  setTimeout(() => sendGateEvent({ state: 'closed' }), 5_000);
  const relay = camera ? pulseBarrier(camera.id) : { ok: false, error: 'no_camera' };
  let face: { ok: boolean; status?: number; error?: string } | null = null;
  try { face = await openFaceGate({ reason: `${reason}:${laneName}` }); }
  catch (e: any) { face = { ok: false, error: e?.message ?? String(e) }; }
  return {
    ok: true,
    note: `Barrier opened for ${laneName}`
      + (relay.ok ? ' · camera-relay pulsed' : camera ? ` · relay ${relay.error}` : '')
      + (face?.ok ? ' · face-gate ok' : ''),
  };
}

// Manual operator "open barrier" from the Live display.
ipcMain.handle('gate:manual-open', (_e, opts: { cameraId?: number | null; laneId?: number | null } = {}) => openBarrier(opts));


ipcMain.handle('sync:all-tables', async () => {
  // Pull-only: cloud-owned config (site / policies / passes / spaces). Equipment
  // (cameras / lanes / terminals) is NO LONGER pushed here — it syncs manually,
  // per type, from each device page via the Push/Pull-to-cloud buttons.
  return await syncAll();
});

// Initial state for the header's "last synced" stamp. Live updates then arrive
// on the 'cloud-pull' event, so this is only read once per window.
ipcMain.handle('sync:cloud-pull-state', () => getCloudPullState());

// ─── manual equipment sync (per device page: Push / Pull to cloud) ──────────
ipcMain.handle('devices:preview-sync', (_e, type: DeviceType, direction: 'push' | 'pull') =>
  previewDeviceSync(type, direction));

ipcMain.handle('devices:push-cloud', (_e, type: DeviceType) => pushDevicesToCloud(type));

ipcMain.handle('devices:pull-cloud', async (_e, type: DeviceType) => {
  const result = await pullDevicesFromCloud(type);
  // A pull rewrites local camera/lane rows and their links — refresh the
  // capture pipelines so grabbers/relay track the new set.
  if (result.ok) { resyncRtspGrabbers(); resyncCameraRelay(); }
  return result;
});
