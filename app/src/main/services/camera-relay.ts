/**
 * Camera barrier-relay driver via the vendor's native SDK (VzLPRSDK, 64-bit,
 * bundled in native/vzsdk). On rigs where the barrier is physically wired to the
 * LPR camera's onboard IO output, we raise it by pulsing that relay:
 *
 *   VzLPRClient_Setup()                                  // once
 *   h = VzLPRClient_Open(ip, port, user, pass)           // LAN — NOT OpenV2 (cloud)
 *   wait for VzLPRClient_IsConnected(h) == 1             // connection is async
 *   VzLPRClient_SetIOOutputAuto(h, chan, durationMs)     // pulse the relay
 *
 * LIVE VIDEO IS NO LONGER HANDLED HERE. The Live-display wall and the plate-event
 * snapshot cache are both fed by the RTSP/ffmpeg feed (camera-rtsp.ts), which
 * needs only the camera IP. This module keeps one warm, connected SDK handle per
 * credentialed camera purely so an operator "Open barrier" pulses instantly; the
 * device credentials (user/password/port) exist ONLY for this relay path.
 *
 * The SDK is native code loaded via koffi FFI. `VzLPRClientHandle` is
 * `typedef int` (32-bit int on x86 AND x64), so every handle is a plain int.
 * We deliberately never call VzLPRClient_Cleanup() — it segfaults on process
 * teardown; skipping it lets the OS reap cleanly on quit.
 *
 * PRODUCTION NOTE: this runs in the main process. A native crash would take the
 * app down; if that proves an issue under load, move it to an isolated child.
 */
import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';
import { listCameras } from './db';
import type { LprCamera } from '../../shared/types';

let koffi: any = null;
let lib: any = null;
let fns: any = null;
let setupOk = false;
let setupTried = false;

function log(m: string) { console.log(`[vzsdk] ${m}`); }

/** Folder holding VzLPRSDK.dll + its dependency DLLs. In dev we launch
 *  `electron dist/main/index.js`, so app.getAppPath() points at dist/main —
 *  NOT the app root — and native/vzsdk wouldn't be found there. Probe the
 *  likely locations and use the first that actually contains the DLL. */
function sdkDir(): string {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'native', 'vzsdk')]          // electron-builder extraResources
    : [
        path.join(process.cwd(), 'native', 'vzsdk'),                // dev: `npm run dev` runs from app/
        path.join(__dirname, '..', '..', '..', 'native', 'vzsdk'),  // dev: dist/main/services -> app/
        path.join(app.getAppPath(), 'native', 'vzsdk'),             // fallback
      ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'VzLPRSDK.dll'))) return dir;
  }
  return candidates[0];
}

/** Load the SDK once. Returns false (and disables the relay) if unavailable
 *  — the rest of the app must keep running regardless. */
function ensureLib(): boolean {
  if (setupOk) return true;
  if (setupTried) return false;
  setupTried = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    koffi = require('koffi');
    const dir = sdkDir();
    // Let the loader find VzLPRSDK.dll's sibling dependency DLLs.
    process.env.PATH = dir + path.delimiter + (process.env.PATH || '');
    lib = koffi.load(path.join(dir, 'VzLPRSDK.dll'));
    fns = {
      Setup:   lib.func('int VzLPRClient_Setup()'),
      // LAN open — matches the vendor demo (VzLPRClient_Open(ip, 80, "admin", "admin")).
      // WORD wPort => uint16; returns a handle (>0), or 0 on failure.
      Open:    lib.func('int VzLPRClient_Open(str, uint16, str, str)'),
      Close:   lib.func('int VzLPRClient_Close(int)'),
      // BYTE *pStatus out-param: pass a 1-byte Buffer; 1 = connected.
      IsConnected: lib.func('int VzLPRClient_IsConnected(int, uint8_t *)'),
    };
    // Barrier relay: pulse the camera's onboard IO output, auto-resetting after
    // nDuration ms. VzLPRClient_SetIOOutputAuto(handle, uChnId, nDuration) — 0 =
    // success, -1 = fail; nDuration range [500, 5000]. Resolve defensively —
    // some firmware/DLL builds don't export it; degrade rather than disable the
    // whole SDK.
    try { fns.SetIOOutputAuto = lib.func('int VzLPRClient_SetIOOutputAuto(int, uint, int)'); }
    catch { fns.SetIOOutputAuto = null; log('VzLPRClient_SetIOOutputAuto unavailable — camera relay barrier disabled'); }
    const r = fns.Setup();
    setupOk = true;
    log(`SDK ready (Setup=${r}) from ${dir}`);
    return true;
  } catch (e: any) {
    log(`SDK unavailable — camera relay disabled: ${e?.message ?? e}`);
    return false;
  }
}

interface Conn {
  handle: number;
  timer: NodeJS.Timeout | null;
  key: string;
  stopped: boolean;
  connected: boolean;
}
const connections = new Map<number, Conn>();

/** Config signature — reconnect when any of the relay-connection inputs change. */
function camKey(c: LprCamera): string {
  return `${c.host}|${c.deviceUser}|${c.devicePassword}|${c.devicePort}`;
}

/** A camera can drive its onboard relay only if we can open an SDK handle to it
 *  — i.e. it has a host and device credentials. Cameras without credentials
 *  simply have no camera-relay barrier (video still works over RTSP). */
function usesRelay(c: LprCamera): boolean {
  return !!(c.enabled && c.host && c.deviceUser && c.devicePassword);
}

/** Open a warm, connected SDK handle for a camera and hold it so barrier pulses
 *  are instant. No frame grabbing — video comes from RTSP now. The 1s IsConnected
 *  poll doubles as a keepalive (same cadence the old grab loop ran at) and a
 *  drop detector; it never grabs, so the device is barely loaded. */
function openConnection(c: LprCamera) {
  if (!ensureLib()) return;
  const cid = c.id;
  try {
    const port = Number(c.devicePort) || 80;
    // Use the LAN open, NOT OpenV2. OpenV2 is the cloud/Internet path — it needs
    // the device serial number and network_type=1, so it returns 0 (fail) for a
    // plain LAN camera. The vendor demo connects with VzLPRClient_Open(ip, 80,
    // "admin", "admin").
    const handle = fns.Open(c.host, port, c.deviceUser ?? '', c.devicePassword ?? '');
    // SDK contract: 0 = failure, ANY non-zero value = valid handle. Handles are
    // large 32-bit tokens (the demo even uses one as 0x7bb86e85), so a NEGATIVE
    // signed value is a perfectly valid handle — never treat handle<0 as error.
    if (handle === 0) { log(`cam ${cid} Open failed (handle=0) — check IP ${c.host}:${port}, username, and password`); return; }
    const conn: Conn = { handle, timer: null, key: camKey(c), stopped: false, connected: false };
    connections.set(cid, conn);
    log(`cam ${cid} opened (handle=${handle}, ${c.host}:${port}) — waiting for connection`);

    // The connection is ASYNCHRONOUS — poll IsConnected. We keep polling after
    // connect (slow keepalive + drop detection); we never grab frames.
    const statusBuf = Buffer.alloc(1);
    conn.timer = setInterval(() => {
      if (conn.stopped) { if (conn.timer) clearInterval(conn.timer); return; }
      statusBuf[0] = 0;
      try { fns.IsConnected(handle, statusBuf); } catch { /* ignore */ }
      const up = statusBuf[0] === 1;
      if (up && !conn.connected) { conn.connected = true; log(`cam ${cid} connected — barrier relay ready`); }
      else if (!up && conn.connected) { conn.connected = false; log(`cam ${cid} connection dropped — relay will use a fresh handle until it recovers`); }
    }, 1000);
  } catch (e: any) {
    log(`cam ${cid} open failed: ${e?.message ?? e}`);
  }
}

function closeConnection(id: number) {
  const conn = connections.get(id);
  if (!conn) return;
  connections.delete(id);
  conn.stopped = true;
  if (conn.timer) clearInterval(conn.timer);
  // Defer the native Close a touch so nothing races an in-flight relay pulse.
  const handle = conn.handle;
  setTimeout(() => { try { fns.Close(handle); } catch { /* ignore */ } }, 600);
}

/** Open/close warm relay connections to match the cameras that can drive a relay
 *  (host + credentials). Call on boot and whenever cameras are saved/deleted. */
export function resync() {
  const wanted = listCameras().filter(usesRelay);
  for (const [id, conn] of [...connections]) {
    const c = wanted.find((x) => x.id === id);
    if (!c || camKey(c) !== conn.key) closeConnection(id);
  }
  for (const c of wanted) {
    if (!connections.has(c.id)) openConnection(c);
  }
}

export interface BarrierResult { ok: boolean; error?: string; via?: 'reused' | 'temp' }

/**
 * Open the barrier wired to a camera by pulsing that camera's onboard relay
 * (VzLPRClient_SetIOOutputAuto — energises the relay, auto-resets after
 * `durationMs`). `channel` is the IO output index (0 = the first/only relay on
 * single-barrier cameras). Reuses the warm, already-connected handle when we
 * have one (the fast common case); otherwise opens a short-lived handle just for
 * the pulse. Best-effort — returns { ok:false } (never throws) if the
 * SDK/camera/relay is unavailable, so a gate-open never crashes the flow.
 */
export function pulseBarrier(cameraId: number, opts: { channel?: number; durationMs?: number } = {}): BarrierResult {
  if (!ensureLib()) return { ok: false, error: 'sdk_unavailable' };
  if (!fns.SetIOOutputAuto) return { ok: false, error: 'SetIOOutputAuto_unavailable' };
  const channel = opts.channel ?? 0;
  const durationMs = Math.min(5000, Math.max(500, Math.round(opts.durationMs ?? 1000)));

  // Fast path: reuse the warm, already-connected handle.
  const conn = connections.get(cameraId);
  if (conn && !conn.stopped) {
    try {
      const r = fns.SetIOOutputAuto(conn.handle, channel, durationMs);
      return r === 0 ? { ok: true, via: 'reused' } : { ok: false, error: `SetIOOutputAuto=${r}`, via: 'reused' };
    } catch (e: any) { return { ok: false, error: e?.message ?? String(e), via: 'reused' }; }
  }

  // No warm connection — open a short-lived handle just to pulse the relay, then
  // close it after a margin (mirrors closeConnection's deferred Close).
  const cam = listCameras().find((c) => c.id === cameraId);
  if (!cam?.host) return { ok: false, error: 'camera_has_no_host' };
  const port = Number(cam.devicePort) || 80;
  let handle = 0;
  try {
    handle = fns.Open(cam.host, port, cam.deviceUser ?? '', cam.devicePassword ?? '');
    if (handle === 0) return { ok: false, error: 'open_failed' };
    const r = fns.SetIOOutputAuto(handle, channel, durationMs);
    return r === 0 ? { ok: true, via: 'temp' } : { ok: false, error: `SetIOOutputAuto=${r}`, via: 'temp' };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e), via: 'temp' };
  } finally {
    if (handle !== 0) {
      const h = handle;
      setTimeout(() => { try { fns.Close(h); } catch { /* ignore */ } }, 800);
    }
  }
}

/** Boot: open warm relay connections for all credentialed cameras. */
export function startCameraRelay() { resync(); }

export function stopCameraRelay() {
  for (const id of [...connections.keys()]) closeConnection(id);
  // NOTE: intentionally NOT calling VzLPRClient_Cleanup() — segfaults on teardown.
}
