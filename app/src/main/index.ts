/**
 * Electron main process — single instance, one window, BackgroundService-style
 * IPC handlers. All long-lived background work (TCP terminals, LPR webhook
 * server, qparking sync) lives in here so the UI window can be closed without
 * stopping the parking flow. Re-opening the window just reconnects to the
 * already-running services.
 */
import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, session } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

// ─── userData isolation (dev mode) ─────────────────────────────────────────
// In packaged builds Electron derives userData from package.json's productName.
// In `npm run dev` the host process is just `electron.exe`, so app.getName()
// defaults to "Electron" and userData lands in %APPDATA%/Electron — a dir
// shared with EVERY other Electron app a developer has touched on this box.
// That shared dir caches cookies, localStorage, and (worst of all) Service
// Workers per-origin. If another local Electron project (face_auth/admin,
// etc.) ever registered a SW on http://localhost:5173, it intercepts every
// qparking-local fetch and shows ITS cached index.html instead of ours.
//
// Set the name BEFORE anyone reads getPath('userData'). One-shot migration
// below copies the SQLite DB across so existing terminals/cameras/sessions
// follow the operator to the new isolated path.
app.setName('qparking-local');
migrateUserData();

function migrateUserData() {
  try {
    const newDir = app.getPath('userData');
    const legacyDir = path.join(path.dirname(newDir), 'Electron');
    if (newDir === legacyDir) return;
    fs.mkdirSync(newDir, { recursive: true });
    for (const f of ['qparking-local.db', 'qparking-local.db-shm', 'qparking-local.db-wal']) {
      const from = path.join(legacyDir, f);
      const to = path.join(newDir, f);
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        fs.copyFileSync(from, to);
        console.log(`[boot] migrated ${f} from shared Electron dir → ${newDir}`);
      }
    }
  } catch (e: any) {
    console.warn(`[boot] userData migration skipped: ${e?.message ?? e}`);
  }
}
import {
  getDb, getSettings, saveSettings,
  listTerminals, getTerminal, upsertTerminal, deleteTerminal,
  listCameras, upsertCamera, deleteCamera,
  listLanes, upsertLane, deleteLane, getLane,
  listOpenSessions, listRecentSessions, manualReleaseSession, getSessionById,
  countSessions, listSessionsPage, deleteSession, deleteSessionsBulk,
  updateSessionFields,
  listScopes, getScope,
} from './db';
import { computeFee } from './parking-flow';
import {
  getTerminalInstance, disposeTerminalInstance, listTerminalInstances,
} from './ecpi-terminal';
import { startLprServer, lprEvents, simulatePlate } from './lpr-webhook';
import { startParkingFlow, parkingEvents } from './parking-flow';
import { startBackgroundSync, syncScopes, pushScopeRate } from './qparking-sync';
import { openGateSimulator, sendGateEvent } from './gate-simulator';
import { openFaceGate, pingFaceGate } from './face-gate';
import {
  startSyncDrain, syncEvents, getSyncStatus, drainNow,
  enqueueEntry, enqueueExit, enqueueUpdate, enqueueDelete,
  backfillAllSessions,
} from './sync-queue';
import {
  listFailedSync, retryAllFailedSync, clearFailedSync,
} from './db';
import { fetchSnapshot, pingCamera, startSnapshotUploader } from './camera-snapshots';
import { pushCamera, pushAllCameras } from './camera-push';
import { pushTerminal, pushLane, pushAllDevices } from './device-push';
import {
  startW4gServer, stopW4gServer, payRequest as tngPayRequest, payCancel as tngPayCancel,
  pingDevice as tngPing, w4gStatus, w4gEvents, newOrderId as newTngOrderId,
} from './w4g-tng';
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
  startLprServer(settings.lprWebhookPort);
  startParkingFlow();
  startBackgroundSync();
  startSnapshotUploader();
  startSyncDrain();
  // W4G PayResult callback listener — only start when the operator has
  // enabled the TNG integration. Toggling it on/off in Settings restarts
  // it via the settings:save handler below.
  if (settings.tngEnabled) startW4gServer(settings.tngCallbackPort);
  // First-time camera registry mirror — fire and forget so a slow WAN
  // doesn't block boot. Subsequent updates push on every save.
  pushAllCameras().catch(() => null);
  pushAllDevices().catch(() => null);

  // Stream parking + lpr events to renderer.
  wireRendererEvents();

  // Auto-reconnect enabled terminals on boot.
  for (const t of listTerminals().filter((t) => t.enabled)) {
    bootTerminal(t.id).catch(() => null);
  }

  createWindow();
  createTray();
});

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

// ─── per-terminal wiring ───────────────────────────────────────────────────

const terminalWired = new Set<number>();

async function bootTerminal(id: number) {
  const row = getTerminal(id);
  if (!row) return;
  const inst = getTerminalInstance(row);
  if (!terminalWired.has(id)) {
    inst.on('status', (s) => sendToRenderer('terminal-status', s));
    inst.on('log', (entry) => sendToRenderer('log', { terminalId: id, ...entry }));
    terminalWired.add(id);
  }
  inst.connect();
}

function shutdownTerminal(id: number) {
  disposeTerminalInstance(id);
  terminalWired.delete(id);
}

// ─── renderer event fan-out ────────────────────────────────────────────────

function wireRendererEvents() {
  lprEvents.on('plate', (event) => sendToRenderer('plate-detected', event));
  for (const ev of ['entry','exit-pending','exit-completed','warning','rescan-ignored'] as const) {
    parkingEvents.on(ev, (payload) => sendToRenderer('session', { kind: ev, payload }));
  }

  // Drive the gate-simulator window. Entry events open the gate inbound; a
  // successful exit (paid / free / manual_release) opens it outbound. Failed
  // exits keep the gate closed — the operator handles those manually.
  parkingEvents.on('entry', (p: any) => {
    const laneName = p?.session?.entryLaneId ? getLane(p.session.entryLaneId)?.name : undefined;
    sendGateEvent({ state: 'open', plate: p?.session?.plate, laneName, direction: 'in', holdMs: 4_000 });
    setTimeout(() => sendGateEvent({ state: 'closed' }), 4_000);
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
    if (kind === 'exit-without-entry') {
      sendGateEvent({ state: 'closed', plate: p?.plate, direction: 'out',
        reason: 'exit-without-entry', holdMs: 4_000 });
    } else if (kind === 'exit-no-lane') {
      sendGateEvent({ state: 'closed', direction: 'out', reason: 'no-lane', holdMs: 5_000 });
    } else if (kind === 'exit-no-terminal' || kind === 'exit-terminal-disabled') {
      sendGateEvent({ state: 'closed', direction: 'out', reason: 'no-terminal', holdMs: 5_000 });
    } else if (kind === 'exit-terminal-offline') {
      sendGateEvent({ state: 'closed', direction: 'out', reason: 'terminal-offline', holdMs: 5_000 });
    }
  });
  parkingEvents.on('exit-completed', (p: any) => {
    const session = p?.sessionId ? getSessionById(p.sessionId) : null;
    // Always mirror the exit to qparking SaaS — even on decline — so Finance
    // can show decline rates and operators can audit stuck transactions.
    // The gate-open + face-turnstile actions remain gated on a successful
    // outcome because a declined card MUST NOT raise the barrier.
    if (session) enqueueExit(session);
    const allowed = ['paid','free','manual_release'].includes(p?.outcome);
    if (!allowed) return;
    const laneName = session?.exitLaneId ? getLane(session.exitLaneId)?.name : undefined;
    sendGateEvent({
      state: 'open',
      plate: session?.plate,
      laneName,
      direction: 'out',
      reason: p?.outcome,
      holdMs: 4_000,
    });
    setTimeout(() => sendGateEvent({ state: 'closed' }), 4_000);
    // Also raise the physical face-auth turnstile, if configured. Best-effort
    // — a network failure here doesn't roll back the payment.
    openFaceGate({ plate: session?.plate ?? undefined, reason: `qparking-exit-${p?.outcome}` })
      .then((r) => sendToRenderer('log', { terminalId: 0, direction: r.ok ? 'info' : 'error', message: 'face-gate open', payload: r }))
      .catch(() => null);
  });

  // Sync status → renderer for the Dashboard panel.
  syncEvents.on('status', (status) => sendToRenderer('sync-status', status));

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

ipcMain.handle('terminals:list', () => listTerminals());
ipcMain.handle('terminals:save', (_e, input) => {
  const saved = upsertTerminal(input);
  // Best-effort cloud mirror — doesn't block the local save if WAN is offline.
  pushTerminal(saved.id).catch(() => null);
  return saved;
});
ipcMain.handle('terminals:delete', (_e, id: number) => { shutdownTerminal(id); deleteTerminal(id); });
ipcMain.handle('terminals:status', (_e, id: number) => {
  const row = getTerminal(id);
  if (!row) throw new Error('not_found');
  return getTerminalInstance(row).snapshot();
});
ipcMain.handle('terminals:connect', (_e, id: number) => bootTerminal(id));
ipcMain.handle('terminals:disconnect', (_e, id: number) => shutdownTerminal(id));
ipcMain.handle('terminals:getStatus', (_e, id: number) => {
  const row = getTerminal(id); if (!row) throw new Error('not_found');
  getTerminalInstance(row).getStatus();
});
// Per-API handlers — used by the TerminalTester modal so the operator can
// exercise every command in the protocol without writing any code. Body
// shapes match the ECPI PDF examples (titleTXT, messageTXT, fareAmount, …).
function withInst<T>(id: number, fn: (inst: ReturnType<typeof getTerminalInstance>) => T): T {
  const row = getTerminal(id);
  if (!row) throw new Error('not_found');
  return fn(getTerminalInstance(row));
}

ipcMain.handle('terminals:initTerminal', (_e, id: number, op?: '0'|'1'|'2') => withInst(id, (i) => i.initTerminal(op)));
ipcMain.handle('terminals:deinitTerminal', (_e, id: number) => withInst(id, (i) => i.deinitTerminal()));
ipcMain.handle('terminals:initCard', (_e, id: number, opts?: any) => withInst(id, (i) => i.initCard(opts)));
ipcMain.handle('terminals:initEntry', (_e, id: number, opts?: any) => withInst(id, (i) => i.initEntry(opts)));
ipcMain.handle('terminals:initExit', (_e, id: number, opts?: any) => withInst(id, (i) => i.initExit(opts)));
ipcMain.handle('terminals:initTxn', (_e, id: number, opts: any) => withInst(id, (i) => i.initTxn(opts)));
ipcMain.handle('terminals:proceedEntry', (_e, id: number, opts?: any) => withInst(id, (i) => i.proceedEntry(opts)));
ipcMain.handle('terminals:proceedExit', (_e, id: number, opts: any) => withInst(id, (i) => i.proceedExit(opts)));
ipcMain.handle('terminals:finTxn', (_e, id: number) => withInst(id, (i) => i.finTxn()));
ipcMain.handle('terminals:abort', (_e, id: number, reason?: 'success'|'failed'|'silent') => withInst(id, (i) => i.abortTxn(reason ?? 'silent')));
ipcMain.handle('terminals:showStatus', (_e, id: number, opts: any) => withInst(id, (i) => i.showStatus(opts)));

ipcMain.handle('cameras:list', () => listCameras());
ipcMain.handle('cameras:save', async (_e, input) => {
  const saved = upsertCamera(input);
  // Mirror to cloud — best-effort, doesn't block the local save.
  pushCamera(saved.id).catch(() => null);
  return saved;
});
ipcMain.handle('cameras:delete', (_e, id: number) => deleteCamera(id));
ipcMain.handle('cameras:simulate', (_e, cameraId: number, plate: string) => simulatePlate(cameraId, plate));

/**
 * Demo-mode helper: fire entry now, wait `holdMs`, fire exit. Lets an
 * operator click a single button on the Cameras page and watch the entire
 * parking flow end-to-end (gate opens for entry → session stored → fee
 * computed at exit → gate opens again → session closed → cloud mirror).
 *
 * Note: the same camera handles BOTH halves, so it must be direction=dual
 * (or the camera must be explicitly tagged dual). For entry-only or
 * exit-only cameras, only the matching half will fire.
 */
ipcMain.handle('cameras:simulateFullFlow', async (_e, cameraId: number, plate: string, holdMs = 3000) => {
  simulatePlate(cameraId, plate); // first call → opens a session (entry)
  await new Promise((r) => setTimeout(r, Math.max(500, holdMs)));
  simulatePlate(cameraId, plate); // second call → matches open session → closes it (exit)
  return { ok: true };
});
ipcMain.handle('cameras:snapshot', (_e, cameraId: number) => fetchSnapshot(cameraId));
ipcMain.handle('cameras:ping', (_e, cameraId: number) => pingCamera(cameraId));

ipcMain.handle('lanes:list', () => listLanes());
ipcMain.handle('lanes:save', (_e, input) => {
  const saved = upsertLane(input);
  pushLane(saved.id).catch(() => null);
  // Lanes are how terminals get attributed to a cloud site (the lane's
  // scopeId), so re-push the terminal too whenever the lane changes.
  if (saved.terminalId) pushTerminal(saved.terminalId).catch(() => null);
  return saved;
});
ipcMain.handle('lanes:delete', (_e, id: number) => deleteLane(id));

ipcMain.handle('sessions:open', () => listOpenSessions());
ipcMain.handle('sessions:recent', (_e, limit: number) => listRecentSessions(limit));
ipcMain.handle('sessions:page', (_e, opts: { tab: 'open' | 'recent'; limit: number; offset: number }) => ({
  rows: listSessionsPage(opts),
  counts: countSessions(),
}));
ipcMain.handle('sessions:delete', (_e, id: number) => {
  // Capture session BEFORE deleting so we have lane/plate/entryAt for the
  // qparking sync payload — otherwise the row is gone before we enqueue.
  const session = getSessionById(id);
  const ok = deleteSession(id);
  if (ok && session) enqueueDelete(session);
  return ok;
});
ipcMain.handle('sessions:delete-bulk', (_e, opts: { ids?: number[]; tab?: 'open' | 'recent' | 'all' }) => {
  // Snapshot sessions to be deleted so each can be enqueued for SaaS sync.
  let toSync: typeof opts.ids extends infer T ? any[] : any[] = [];
  if (opts.ids?.length) {
    toSync = opts.ids.map((sid) => getSessionById(sid)).filter(Boolean);
  } else if (opts.tab === 'open') {
    toSync = listOpenSessions();
  } else if (opts.tab === 'recent') {
    toSync = listRecentSessions(10_000).filter((s: any) => s.exitAt != null);
  } else if (opts.tab === 'all') {
    toSync = listRecentSessions(10_000);
  }
  const deleted = deleteSessionsBulk(opts);
  toSync.forEach((s: any) => { if (s) enqueueDelete(s); });
  return { deleted };
});
ipcMain.handle('sessions:release', (_e, id: number, reason: string) => {
  const session = manualReleaseSession(id, reason);
  if (session) enqueueUpdate(session);
  return session;
});

/**
 * Admin session editor — recalculates duration + fee whenever entry/exit
 * times change so the operator can verify the live fee calc is right.
 * Body fields: plate, entryAt, exitAt, paymentStatus, notes. Fee/duration
 * are recomputed server-side using the session's exit-lane scope, OR a
 * scopeIdOverride if passed (useful for "what would this cost under scope
 * X" exploration).
 */
ipcMain.handle('sessions:update', (_e, id: number, patch: {
  plate?: string;
  entryAt?: string;
  exitAt?: string | null;
  paymentStatus?: 'pending'|'paid'|'declined'|'cancelled'|'free'|'manual_release';
  notes?: string;
  scopeIdOverride?: string | null;
}) => {
  const session = getSessionById(id);
  if (!session) throw new Error('not_found');

  // Apply the easy text/state fields first.
  let working = updateSessionFields(id, {
    plate: patch.plate,
    entryAt: patch.entryAt,
    exitAt: patch.exitAt,
    paymentStatus: patch.paymentStatus,
    notes: patch.notes,
  });
  if (!working) throw new Error('update_failed');

  // Recompute duration + fee if BOTH ends are set. Pick the scope from:
  //   1. caller-supplied override (admin "what if" mode)
  //   2. the session's exit lane (production case)
  //   3. the session's entry lane (fallback if exit lane isn't set yet)
  if (working.exitAt) {
    const entryMs = Date.parse(working.entryAt);
    const exitMs  = Date.parse(working.exitAt);
    const durationMinutes = Math.max(0, Math.ceil((exitMs - entryMs) / 60_000));

    let scopeId: string | null = patch.scopeIdOverride ?? null;
    if (!scopeId) {
      const lane = working.exitLaneId
        ? getLane(working.exitLaneId)
        : (working.entryLaneId ? getLane(working.entryLaneId) : null);
      scopeId = lane?.scopeId ?? null;
    }
    const scope = scopeId ? getScope(scopeId) : null;
    const feeCents = computeFee(durationMinutes, scope, working.entryAt);

    working = updateSessionFields(id, { durationMinutes, feeCents });
  }

  // Push the edit to qparking SaaS via the retry queue.
  if (working) enqueueUpdate(working);
  return working;
});

// Sync queue inspection + manual controls (Dashboard panel uses these).
ipcMain.handle('sync:status', () => getSyncStatus());
ipcMain.handle('sync:drain-now', () => drainNow());
ipcMain.handle('sync:failed-list', (_e, limit?: number) => listFailedSync(limit ?? 50));
ipcMain.handle('sync:retry-failed', () => ({ retried: retryAllFailedSync() }));
ipcMain.handle('sync:clear-failed', () => ({ cleared: clearFailedSync() }));
ipcMain.handle('sync:backfill-sessions', async () => {
  const result = backfillAllSessions();
  // Kick a drain right away so the queue starts flushing immediately.
  await drainNow();
  return result;
});

ipcMain.handle('scopes:list', () => listScopes());
ipcMain.handle('scopes:sync', () => syncScopes());
ipcMain.handle('scopes:save-rate', (_e, input: {
  firstBlockCents: number; perBlockCents: number;
  blockMinutes: number; freeMinutes: number; dailyCapCents: number;
}) => pushScopeRate(input));

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
 * scopes, sync queue, settings all survive. That's intentional: a clear-
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
ipcMain.handle('settings:save', (_e, patch) => {
  const next = saveSettings(patch);
  // If the LPR port changed, restart the server.
  if (patch.lprWebhookPort !== undefined) startLprServer(next.lprWebhookPort);
  // W4G TNG: stop / start / restart the callback listener as needed when
  // the operator flips the master switch or changes the callback port.
  const tngTouched =
    patch.tngEnabled !== undefined || patch.tngCallbackPort !== undefined;
  if (tngTouched) {
    if (next.tngEnabled) startW4gServer(next.tngCallbackPort);
    else stopW4gServer();
  }
  return next;
});

// ─── TNG W4G test triggers + status ────────────────────────────────────────
// Used by the Settings page panel so an operator can hit "Test PayRequest" /
// "Test PayCancel" / "Ping" without spinning up a real parking session, and
// see live result frames as they come back from the IO controller.
ipcMain.handle('tng:ping', () => tngPing());
ipcMain.handle('tng:status', () => w4gStatus());
ipcMain.handle('tng:test-pay-request', async (_e, opts?: {
  payAmount?: number; discountAmount?: number; enterTime?: number; payTime?: number; orderId?: string;
}) => {
  // Make sure the listener is up — without it, no PayResult callback can
  // ever land and the request will time out at the device side.
  const s = getSettings();
  if (!s.tngEnabled) return { ok: false, orderId: '', error: 'tng_disabled — flip the master switch on first' };
  startW4gServer(s.tngCallbackPort);
  // For Settings → Test PayRequest, use a TEST<epoch> orderId. Matches the
  // merchant's reference tester's format and is easy to grep in the W4G
  // device's own debug log — production exits use the random hex orderId
  // from newTngOrderId() to avoid plate-keyed collisions.
  const orderId = opts?.orderId ?? `TEST${Math.floor(Date.now() / 1000)}`;
  try {
    const body = await tngPayRequest({
      orderId,
      payAmount: opts?.payAmount ?? 100,
      discountAmount: opts?.discountAmount ?? 0,
      enterTime: opts?.enterTime,
      payTime: opts?.payTime,
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

ipcMain.handle('tng:test-pay-cancel', async (_e, orderId: string) => {
  if (!orderId) return { ok: false, error: 'orderId_required' };
  try {
    const ack = await tngPayCancel(orderId);
    return { ok: ack.state === 0, deviceState: ack.state };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
});

ipcMain.handle('diagnose:lpr', () => require('./lpr-webhook').diagnose());

// Face-auth turnstile integration
ipcMain.handle('faceGate:ping', () => pingFaceGate());
ipcMain.handle('faceGate:open', (_e, opts?: { plate?: string; reason?: string }) => openFaceGate(opts ?? {}));

// Gate simulator — opens the always-on-top red/green window.
ipcMain.handle('gate:open', () => { openGateSimulator(isDev); });

// Fire a fake gate trigger for testing. The window will flash green for ~4s
// then return to red. Useful for sanity-checking the wiring before any
// camera or terminal is online.
ipcMain.handle('gate:test', (_e, opts: { plate?: string; direction?: 'in'|'out'|'test'; laneName?: string } = {}) => {
  openGateSimulator(isDev);
  sendGateEvent({
    state: 'open',
    plate: opts.plate ?? 'TEST',
    direction: opts.direction ?? 'test',
    laneName: opts.laneName,
    reason: 'manual test',
    holdMs: 4_000,
  });
  setTimeout(() => sendGateEvent({ state: 'closed' }), 4_000);
});
