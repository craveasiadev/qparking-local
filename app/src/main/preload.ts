/**
 * Preload script — runs in the renderer's process but with Node access,
 * before the page loads. We expose a typed `bridge` global via contextBridge
 * so the renderer never touches Node APIs directly (matches Electron's
 * security recommendations).
 */
import { contextBridge, ipcRenderer } from 'electron';

const api = {
  // terminals — config CRUD + connection lifecycle
  listTerminals: () => ipcRenderer.invoke('terminals:list'),
  saveTerminal: (input: unknown) => ipcRenderer.invoke('terminals:save', input),
  deleteTerminal: (id: number) => ipcRenderer.invoke('terminals:delete', id),
  getTerminalStatus: (id: number) => ipcRenderer.invoke('terminals:status', id),
  terminalConnect: (id: number) => ipcRenderer.invoke('terminals:connect', id),
  terminalDisconnect: (id: number) => ipcRenderer.invoke('terminals:disconnect', id),

  // terminals — full ECPI API surface (used by the TerminalTester modal)
  terminalInitTerminal: (id: number, op?: '0'|'1'|'2') => ipcRenderer.invoke('terminals:initTerminal', id, op),
  terminalDeinitTerminal: (id: number) => ipcRenderer.invoke('terminals:deinitTerminal', id),
  terminalGetStatus: (id: number) => ipcRenderer.invoke('terminals:getStatus', id),
  terminalInitCard: (id: number, opts?: { fareClass?: string; retrigger?: '0'|'1'; titleTXT?: string; messageTXT?: string }) =>
    ipcRenderer.invoke('terminals:initCard', id, opts),
  terminalInitEntry: (id: number, opts?: { mode?: '0'|'1'|'2'; fareAmount?: number; fareClass?: string }) =>
    ipcRenderer.invoke('terminals:initEntry', id, opts),
  terminalInitExit: (id: number, opts?: { mode?: '0'|'1'|'2' }) => ipcRenderer.invoke('terminals:initExit', id, opts),
  terminalInitTxn: (id: number, opts: { fareAmount: number; fareClass?: string; entryDt?: string; vehicleNo?: string; entryLane?: string; gstAmount?: number; pAmount?: number }) =>
    ipcRenderer.invoke('terminals:initTxn', id, opts),
  terminalProceedEntry: (id: number, opts?: { payFlag?: -1|0|1 }) => ipcRenderer.invoke('terminals:proceedEntry', id, opts),
  terminalProceedExit: (id: number, opts: { fareAmount: number; fareClass?: string; fallTimeout?: number; payFlag?: -1|0|1 }) =>
    ipcRenderer.invoke('terminals:proceedExit', id, opts),
  terminalFinTxn: (id: number) => ipcRenderer.invoke('terminals:finTxn', id),
  terminalAbort: (id: number, reason?: 'success'|'failed'|'silent') => ipcRenderer.invoke('terminals:abort', id, reason),
  terminalShowStatus: (id: number, opts: { titleTXT: string; messageTXT: string; sound?: '01'|'02'|'FF'; image?: '04'|'08' }) =>
    ipcRenderer.invoke('terminals:showStatus', id, opts),

  // cameras
  listCameras: () => ipcRenderer.invoke('cameras:list'),
  saveCamera: (input: unknown) => ipcRenderer.invoke('cameras:save', input),
  deleteCamera: (id: number) => ipcRenderer.invoke('cameras:delete', id),
  simulatePlate: (cameraId: number, plate: string) => ipcRenderer.invoke('cameras:simulate', cameraId, plate),
  simulateFullFlow: (cameraId: number, plate: string, holdMs?: number) => ipcRenderer.invoke('cameras:simulateFullFlow', cameraId, plate, holdMs ?? 3000),
  fetchCameraSnapshot: (cameraId: number) => ipcRenderer.invoke('cameras:snapshot', cameraId),
  pingCamera: (cameraId: number) => ipcRenderer.invoke('cameras:ping', cameraId),

  // lanes
  listLanes: () => ipcRenderer.invoke('lanes:list'),
  saveLane: (input: unknown) => ipcRenderer.invoke('lanes:save', input),
  deleteLane: (id: number) => ipcRenderer.invoke('lanes:delete', id),

  // sessions
  listOpenSessions: () => ipcRenderer.invoke('sessions:open'),
  listRecentSessions: (limit: number) => ipcRenderer.invoke('sessions:recent', limit),
  listSessionsPage: (opts: { tab: 'open' | 'recent'; limit: number; offset: number }) =>
    ipcRenderer.invoke('sessions:page', opts),
  deleteSession: (id: number) => ipcRenderer.invoke('sessions:delete', id),
  deleteSessionsBulk: (opts: { ids?: number[]; tab?: 'open' | 'recent' | 'all' }) =>
    ipcRenderer.invoke('sessions:delete-bulk', opts),
  manualReleaseSession: (id: number, reason: string) => ipcRenderer.invoke('sessions:release', id, reason),
  /** Edit entry/exit/plate/status/notes on a session. Server-side recomputes
   *  duration + fee from the new times against the session's scope rate. */
  updateSession: (id: number, patch: {
    plate?: string;
    entryAt?: string;
    exitAt?: string | null;
    paymentStatus?: 'pending'|'paid'|'declined'|'cancelled'|'free'|'manual_release';
    notes?: string;
    scopeIdOverride?: string | null;
  }) => ipcRenderer.invoke('sessions:update', id, patch),

  // scopes
  listScopes: () => ipcRenderer.invoke('scopes:list'),
  syncScopesNow: () => ipcRenderer.invoke('scopes:sync'),
  saveScopeRate: (input: {
    firstBlockCents: number; perBlockCents: number;
    blockMinutes: number; freeMinutes: number; dailyCapCents: number;
  }) => ipcRenderer.invoke('scopes:save-rate', input),

  // sync queue (outbound to qparking SaaS)
  getSyncStatus: () => ipcRenderer.invoke('sync:status'),
  syncDrainNow: () => ipcRenderer.invoke('sync:drain-now'),
  listFailedSync: (limit?: number) => ipcRenderer.invoke('sync:failed-list', limit),
  retryFailedSync: () => ipcRenderer.invoke('sync:retry-failed'),
  clearFailedSync: () => ipcRenderer.invoke('sync:clear-failed'),
  backfillSessions: () => ipcRenderer.invoke('sync:backfill-sessions'),

  // app metadata — used by the sidebar to surface the running build version
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  /** Wipe Electron's session cache + storage and reload the window. Safe —
   *  does NOT touch the SQLite app DB (sessions, terminals, settings persist). */
  clearAppCache: () => ipcRenderer.invoke('app:clear-cache'),

  // settings + diagnostics
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s: unknown) => ipcRenderer.invoke('settings:save', s),
  diagnoseLpr: () => ipcRenderer.invoke('diagnose:lpr'),

  // gate simulator
  openGateSimulator: () => ipcRenderer.invoke('gate:open'),
  testGate: (opts?: { plate?: string; direction?: 'in'|'out'|'test'; laneName?: string }) => ipcRenderer.invoke('gate:test', opts ?? {}),

  // face-auth turnstile (faceapp_main)
  pingFaceGate: () => ipcRenderer.invoke('faceGate:ping'),
  openFaceGate: (opts?: { plate?: string; reason?: string }) => ipcRenderer.invoke('faceGate:open', opts ?? {}),

  // pubsub — return an unsubscribe fn so React effects can clean up.
  onEvent: (channel: 'terminal-status'|'session'|'log'|'plate-detected'|'gate-state', cb: (payload: unknown) => void) => {
    const handler = (_: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => { ipcRenderer.off(channel, handler); };
  },
};

contextBridge.exposeInMainWorld('bridge', api);

declare global {
  interface Window { bridge: typeof api; }
}
