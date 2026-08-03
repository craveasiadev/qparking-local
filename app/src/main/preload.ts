/**
 * Preload script — runs in the renderer's process but with Node access,
 * before the page loads. We expose a typed `bridge` global via contextBridge
 * so the renderer never touches Node APIs directly (matches Electron's
 * security recommendations).
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { ActivityLogPayload, BridgeApi } from '../shared/types';

// Typed against the shared contract: add a method here without declaring it
// in BridgeApi (or vice versa) and this file stops compiling. That same
// interface is what gives every React page autocomplete on window.bridge.
const api: BridgeApi = {
  // terminals — Alarmtech W4G payment devices (config CRUD + reachability test)
  listTerminals: () => ipcRenderer.invoke('terminals:list'),
  saveTerminal: (input: unknown) => ipcRenderer.invoke('terminals:save', input),
  deleteTerminal: (id: number) => ipcRenderer.invoke('terminals:delete', id),
  pingTerminalHost: (input: { host: string; port: number }) => ipcRenderer.invoke('terminals:ping-host', input),

  // cameras
  listCameras: () => ipcRenderer.invoke('cameras:list'),
  saveCamera: (input: unknown) => ipcRenderer.invoke('cameras:save', input),
  deleteCamera: (id: number) => ipcRenderer.invoke('cameras:delete', id),
  getCameraLatestFrame: (cameraId: number) => ipcRenderer.invoke('cameras:latest-frame', cameraId),
  pingCamera: (cameraId: number) => ipcRenderer.invoke('cameras:ping', cameraId),
  pingCameraHost: (input: { host: string; port?: number }) => ipcRenderer.invoke('cameras:ping-host', input),

  // lanes
  listLanes: () => ipcRenderer.invoke('lanes:list'),
  saveLane: (input: unknown) => ipcRenderer.invoke('lanes:save', input),
  deleteLane: (id: number) => ipcRenderer.invoke('lanes:delete', id),

  // manual equipment sync (per device page)
  previewDeviceSync: (type: 'cameras' | 'lanes' | 'terminals', direction: 'push' | 'pull') => ipcRenderer.invoke('devices:preview-sync', type, direction),
  pushDevicesToCloud: (type: 'cameras' | 'lanes' | 'terminals') => ipcRenderer.invoke('devices:push-cloud', type),
  pullDevicesFromCloud: (type: 'cameras' | 'lanes' | 'terminals') => ipcRenderer.invoke('devices:pull-cloud', type),

  // sessions
  listOpenSessions: () => ipcRenderer.invoke('sessions:open'),
  listRecentSessions: (limit: number) => ipcRenderer.invoke('sessions:recent', limit),
  listSessionsPage: (opts: {
    tab: 'open' | 'recent';
    limit: number;
    offset: number;
    plateSearch?: string | null;
    entryFrom?: string | null;
    entryTo?: string | null;
    exitFrom?: string | null;
    exitTo?: string | null;
    paymentStatus?: string | null;
  }) => ipcRenderer.invoke('sessions:page', opts),
  /** Manually retrigger the exit-payment flow for a session — used by the
   *  Sessions page when the exit LPR misread the plate or the operator
   *  needs to close a stuck session by asking the driver to tap again. */
  retriggerSessionPayment: (id: number, laneId?: number | null) => ipcRenderer.invoke('sessions:retrigger-payment', id, laneId),
  retriggerSessionPaymentByPlate: (plate: string, laneId?: number | null) => ipcRenderer.invoke('sessions:retrigger-by-plate', plate, laneId),
  simulateEntry: (laneId: number, plate: string, entryIso: string) => ipcRenderer.invoke('sessions:simulate-entry', laneId, plate, entryIso),
  simulateExit: (laneId: number, plate: string, exitIso: string) => ipcRenderer.invoke('sessions:simulate-exit', laneId, plate, exitIso),
  readSessionImage: (filePath: string) => ipcRenderer.invoke('sessions:image', filePath),
  deleteSession: (id: number) => ipcRenderer.invoke('sessions:delete', id),
  manualReleaseSession: (id: number, reason: string, laneId?: number | null) => ipcRenderer.invoke('sessions:release', id, reason, laneId),
  /** Edit entry/exit/plate/status/notes on a session. Server-side recomputes
   *  duration + fee from the new times against the session's policy rate. */
  updateSession: (id: number, patch: {
    plate?: string;
    entryAt?: string;
    exitAt?: string | null;
    paymentStatus?: 'pending'|'paid'|'declined'|'cancelled'|'free'|'manual_release';
    notes?: string;
    policyIdOverride?: string | null;
  }) => ipcRenderer.invoke('sessions:update', id, patch),

  // transactions — payment ledger (every W4G attempt across all sessions)
  listTransactionsPage: (opts: { limit: number; offset: number; search?: string | null; status?: string | null; dateFrom?: string | null; dateTo?: string | null }) =>
    ipcRenderer.invoke('transactions:list-page', opts),

  // policies
  listRatePolicies: () => ipcRenderer.invoke('policies:list'),
  syncRatePoliciesNow: () => ipcRenderer.invoke('policies:sync'),
  syncAllNow: () => ipcRenderer.invoke('sync:all-tables'),
  getCloudPullState: () => ipcRenderer.invoke('sync:cloud-pull-state'),

  // Mirrored config from qparking SaaS (read-only locally)
  listParkingSpaces: () => ipcRenderer.invoke('parking-spaces:list'),
  syncParkingSpacesNow: () => ipcRenderer.invoke('parking-spaces:sync'),
  listSeasonPasses: () => ipcRenderer.invoke('season-passes:list'),
  syncSeasonPassesNow: () => ipcRenderer.invoke('season-passes:sync'),
  listCloudCustomers: () => ipcRenderer.invoke('cloud-customers:list'),
  syncCloudCustomersNow: () => ipcRenderer.invoke('cloud-customers:sync'),
  listCloudVehicles: () => ipcRenderer.invoke('cloud-vehicles:list'),
  syncCloudVehiclesNow: () => ipcRenderer.invoke('cloud-vehicles:sync'),
  listActivityLogs: () => ipcRenderer.invoke('activity-logs:list'),
  insertActivityLog: (payload: ActivityLogPayload) => ipcRenderer.invoke('activity-logs:insert', payload),
  syncActivityLogsNow: (payload: { data: string }) => ipcRenderer.invoke('activity-logs:sync', payload),
  simulateRatePolicyFee: (input: { policyId: string; entry: string; exit: string }) =>
    ipcRenderer.invoke('policies:simulate', input),

  // sync queue (outbound to qparking SaaS)
  getSyncStatus: () => ipcRenderer.invoke('sync:status'),
  syncDrainNow: () => ipcRenderer.invoke('sync:drain-now'),
  retryFailedSync: () => ipcRenderer.invoke('sync:retry-failed'),
  backfillSessions: () => ipcRenderer.invoke('sync:backfill-sessions'),
  syncTransactionsNow: () => ipcRenderer.invoke('sync:backfill-transactions'),

  // app metadata — used by the sidebar to surface the running build version
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  /** Wipe Electron's session cache + storage and reload the window. Safe —
   *  does NOT touch the SQLite app DB (sessions, terminals, settings persist). */
  clearAppCache: () => ipcRenderer.invoke('app:clear-cache'),

  // settings + diagnostics
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s: unknown) => ipcRenderer.invoke('settings:save', s),
  getCurrentSite: () => ipcRenderer.invoke('site:get-current'),
  previewSiteRebind: (input: { baseUrl: string; apiKey: string }) => ipcRenderer.invoke('site:preview-rebind', input),
  rebindSite: (input: { baseUrl: string; apiKey: string; wipeEquipment: boolean }) => ipcRenderer.invoke('site:rebind', input),
  diagnoseLpr: () => ipcRenderer.invoke('diagnose:lpr'),

  // gate simulator
  manualOpenGate: (opts: { cameraId?: number | null; laneId?: number | null }) => ipcRenderer.invoke('gate:manual-open', opts),

  // App self-update — check / download / apply against the qparking cloud.
  appUpdateCheck: () => ipcRenderer.invoke('app-update:check'),
  appUpdateDownload: (opts: { variant: 'portable' | 'installer' }) => ipcRenderer.invoke('app-update:download', opts),
  appUpdateApply: (opts: { path: string }) => ipcRenderer.invoke('app-update:apply', opts),

  // Touch'n'Go W4G IO-controller bridge (test triggers + live status)
  tngLoopbackPayResult: (opts?: { orderId?: string; state?: string; payType?: number; cardNo?: string; balance?: number }) => ipcRenderer.invoke('tng:loopback', opts),
  tngStatus: () => ipcRenderer.invoke('tng:status'),
  tngTestPayRequest: (opts?: {
    payAmount?: number; discountAmount?: number; enterTime?: number; payTime?: number; orderId?: string;
    host?: string; port?: number;
  }) => ipcRenderer.invoke('tng:test-pay-request', opts),
  tngTestPayCancel: (orderId: string, target?: { host?: string; port?: number }) => ipcRenderer.invoke('tng:test-pay-cancel', orderId, target),

  // pubsub — return an unsubscribe fn so React effects can clean up.
  onEvent: (channel: 'session'|'log'|'plate-detected'|'gate-state'|'sync-status'|'cloud-pull'|'parking-flow-log'|'app-update-progress', cb: (payload: unknown) => void) => {
    const handler = (_: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => { ipcRenderer.off(channel, handler); };
  },
};

contextBridge.exposeInMainWorld('bridge', api);
