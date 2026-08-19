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
import { EventEmitter } from 'node:events';
import { app } from 'electron';
import { listCameras } from './db';
import { tcpProbe } from './tcp-probe';
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

/**
 * Emits 'relay' whenever a camera's warm-handle state changes — connected,
 * dropped, or a fresh Open failure.
 *
 * For the health monitor, so it never has to poll for a verdict this module
 * reaches on its own 1s tick. No payload: the subscriber calls
 * cameraRelayHealth(), which reads memory.
 */
export const cameraRelayEvents = new EventEmitter();

function announceRelayChange(): void {
  // The callers are a native-SDK poll tick and the connect path; a subscriber
  // throwing here must not be able to disturb either.
  try {
    cameraRelayEvents.emit('relay');
  } catch { /* ignore */ }
}

interface Conn {
  handle: number;
  timer: NodeJS.Timeout | null;
  key: string;
  stopped: boolean;
  connected: boolean;
  /** Has IsConnected ever reported this handle up? Distinguishes "still coming
   *  up" (normal, the first second after Open) from "was up and DROPPED" — only
   *  the latter means the handle is dead and must not be pulsed. */
  everConnected: boolean;
}
const connections = new Map<number, Conn>();

// ─── why connecting is gated ────────────────────────────────────────────────
// VzLPRClient_Open is a SYNCHRONOUS native call. Against an address that doesn't
// answer it blocked the Electron main process for ~6 seconds (measured) — no
// IPC, no repaint — and because a failed Open recorded nothing, every later
// resync() paid it again. Saving a camera runs a resync, so saving ANY camera
// while one was unreachable took six seconds, then another six on the next save.
//
// So: prove the port is open with an async socket probe first, and remember a
// failure for a while instead of retrying it on every save.

/** Socket-probe budget before we bother the SDK. A camera on the same LAN
 *  answers in single-digit ms; anything slower than this is not a camera that is
 *  about to hand us a working handle. */
const CONNECT_PROBE_TIMEOUT_MS = 500;

/** How long a failed connect is left alone. Long enough that repeated saves cost
 *  nothing, short enough that a camera plugged back in warms up on its own via
 *  the retry tick below. */
const CONNECT_RETRY_AFTER_MS = 30_000;

/** How often to re-examine cameras that have no warm handle, or a dropped one. */
const RECONNECT_TICK_MS = 60_000;

/** cameraId → the config that failed and when, so a dead camera is not re-probed
 *  on every resync. Cleared as soon as its config changes: an edited host is a
 *  new thing to try, not the same failure. */
const lastFailure = new Map<number, { key: string; at: number; why: string }>();

/** Cameras with a probe/Open in flight — overlapping resyncs must not stack. */
const connecting = new Set<number>();

let reconnectTimer: NodeJS.Timeout | null = null;

function noteFailure(c: LprCamera, why: string) {
  // `why` is kept, not just logged: it is the only place that knows the
  // DIFFERENCE between "nothing answered" and "the port answered but the
  // credentials were refused", and the health monitor reports it to the
  // operator (and up to the cloud) as the offline reason.
  lastFailure.set(c.id, { key: camKey(c), at: Date.now(), why });
  log(`cam ${c.id} relay unavailable — ${why} (not retried for ${CONNECT_RETRY_AFTER_MS / 1000}s)`);
  announceRelayChange();
}

/** True while a recent failure for this EXACT config should be left alone. */
function backingOff(c: LprCamera): boolean {
  const failure = lastFailure.get(c.id);
  if (!failure) return false;
  if (failure.key !== camKey(c)) { lastFailure.delete(c.id); return false; }
  return Date.now() - failure.at < CONNECT_RETRY_AFTER_MS;
}

/**
 * Warm this camera up WITHOUT blocking the caller.
 *
 * Callers are IPC handlers (saving a camera) and the boot sequence, so nothing
 * here may sit on the main thread. The socket probe is async; the native Open
 * that follows is synchronous but now only runs against a port that just
 * answered, where it returns promptly.
 */
function scheduleConnect(c: LprCamera) {
  if (connecting.has(c.id) || connections.has(c.id) || backingOff(c)) return;
  connecting.add(c.id);
  void (async () => {
    try {
      const port = Number(c.devicePort) || 80;
      const probe = await tcpProbe(c.host!, port, CONNECT_PROBE_TIMEOUT_MS);
      if (!probe.ok) {
        noteFailure(c, `nothing answered at ${c.host}:${port} (${probe.code}) in ${probe.latencyMs}ms`);
        return;
      }
      // The camera may have been edited or deleted while we were probing, and a
      // pulse may have opened a handle in the meantime.
      const current = listCameras().find((x) => x.id === c.id);
      if (!current || !usesRelay(current) || camKey(current) !== camKey(c)) return;
      if (connections.has(c.id)) return;
      openConnection(current);
    } finally {
      connecting.delete(c.id);
    }
  })();
}

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
    if (handle === 0) {
      // The port answered but the SDK refused — almost always the username or
      // password. Recorded like any other failure so it isn't retried on every
      // save; correcting the credentials changes camKey and clears it at once.
      noteFailure(c, `SDK Open refused at ${c.host}:${port} (handle=0) — check the username and password`);
      return;
    }
    lastFailure.delete(cid);
    const conn: Conn = { handle, timer: null, key: camKey(c), stopped: false, connected: false, everConnected: false };
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
      // Both branches announce: this 1s poll is the earliest anything in the app
      // knows a camera's relay came up or died, and the health monitor's own timer
      // is 60s. Leaving it to discover this on its next sweep is what made the
      // cloud lag a minute behind reality.
      if (up && !conn.connected) {
        conn.connected = true; conn.everConnected = true;
        log(`cam ${cid} connected — barrier relay ready`);
        announceRelayChange();
      } else if (!up && conn.connected) {
        conn.connected = false;
        log(`cam ${cid} connection dropped — relay will use a fresh handle until it recovers`);
        announceRelayChange();
      }
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
    // A handle that came up and then DROPPED cannot pulse anything, and holding
    // it made every barrier attempt fail until the next save. Drop it here so
    // the connect below can replace it.
    if (!c || camKey(c) !== conn.key || isDead(conn)) closeConnection(id);
  }
  // Forget failures for cameras that are gone, so the map can't grow forever.
  for (const id of [...lastFailure.keys()]) {
    if (!wanted.some((c) => c.id === id)) lastFailure.delete(id);
  }
  for (const c of wanted) {
    if (!connections.has(c.id)) scheduleConnect(c);
  }
}

/** A handle that was up and is now down — dead, not merely still connecting. */
function isDead(conn: Conn): boolean {
  return conn.everConnected && !conn.connected;
}

/**
 * Has the native SDK been loaded into this process?
 *
 * Matters only on the way out: once VzLPRSDK.dll is loaded, app.exit() HANGS in
 * teardown — measured, and the event loop is already dead by then, so no JS
 * backstop can run. Quitting has to know this BEFORE it commits (see forceQuit
 * in index.ts).
 */
export function isSdkLoaded(): boolean {
  return setupOk;
}

/**
 * What the warm-handle layer knows about ONE camera, for the health monitor.
 *
 * `known: false` is the important case — it means the SDK cannot answer for this
 * camera (DLL never loaded, no credentials configured, or the handle is still
 * coming up) and the caller MUST fall back to a network probe rather than
 * report a camera as offline on the strength of silence.
 *
 * When `known` is true this is the authoritative answer and beats any probe: a
 * camera whose port answers but whose credentials are refused is NOT a working
 * camera, and only this layer can tell the two apart.
 */
export interface CameraRelayHealth {
  known: boolean;
  up: boolean;
  detail: string | null;
}

export function cameraRelayHealth(c: LprCamera): CameraRelayHealth {
  const unknown: CameraRelayHealth = { known: false, up: false, detail: null };
  // No DLL (non-Windows dev box, missing SDK) or no credentials — there is no
  // SDK path for this camera at all, so it has no opinion to give.
  if (!setupOk || !usesRelay(c)) return unknown;

  const conn = connections.get(c.id);
  if (conn) {
    if (conn.connected) return { known: true, up: true, detail: null };
    // Was up, then dropped: a real, reportable outage.
    if (conn.everConnected) return { known: true, up: false, detail: 'SDK connection dropped' };
    // Opened but never yet reported connected — still warming up (normal for the
    // first second after Open). Not evidence of anything.
    return unknown;
  }

  // No handle. A recorded failure for this EXACT config is a genuine verdict —
  // and carries the only useful reason (bad credentials vs nothing listening).
  const failure = lastFailure.get(c.id);
  if (failure && failure.key === camKey(c)) return { known: true, up: false, detail: failure.why };
  return unknown;
}

/** How many warm SDK handles are held. Exposed for the relay-latency harness,
 *  which pins that a camera which never answered leaves NOTHING behind — a
 *  half-registered handle would be reused by the next barrier pulse. */
export function warmConnectionCount(): number {
  return connections.size;
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
 *
 * ASYNC only because of the cold path. The warm path pulses without awaiting
 * anything, and it is the path a working rig takes for every car. The cold path
 * has to socket-probe first: the native Open behind it blocks the whole main
 * process until the SDK's own timeout (~6s measured), which on a lane with an
 * offline camera meant every car froze the app — plate ingest, UI and all — to
 * arrive at the failure a probe reaches in half a second.
 */
export async function pulseBarrier(cameraId: number, opts: { channel?: number; durationMs?: number } = {}): Promise<BarrierResult> {
  if (!ensureLib()) return { ok: false, error: 'sdk_unavailable' };
  if (!fns.SetIOOutputAuto) return { ok: false, error: 'SetIOOutputAuto_unavailable' };
  const channel = opts.channel ?? 0;
  const durationMs = Math.min(5000, Math.max(500, Math.round(opts.durationMs ?? 1000)));

  // Fast path: reuse the warm, already-connected handle. A handle that came up
  // and then dropped is NOT usable — pulsing it fails on every car until
  // something reconnects — so it's discarded and the cold path taken instead.
  const conn = connections.get(cameraId);
  if (conn && !conn.stopped && !isDead(conn)) {
    try {
      const r = fns.SetIOOutputAuto(conn.handle, channel, durationMs);
      return r === 0 ? { ok: true, via: 'reused' } : { ok: false, error: `SetIOOutputAuto=${r}`, via: 'reused' };
    } catch (e: any) { return { ok: false, error: e?.message ?? String(e), via: 'reused' }; }
  }
  if (conn && isDead(conn)) {
    log(`cam ${cameraId} warm handle had dropped — pulsing over a fresh one`);
    closeConnection(cameraId);
  }

  // No warm connection — open a short-lived handle just to pulse the relay, then
  // close it after a margin (mirrors closeConnection's deferred Close).
  const cam = listCameras().find((c) => c.id === cameraId);
  if (!cam?.host) return { ok: false, error: 'camera_has_no_host' };
  const port = Number(cam.devicePort) || 80;

  // Confirm something is actually listening before the blocking Open. Deliberately
  // a FRESH probe rather than the connect backoff: refusing to raise a barrier
  // because of a failure recorded half a minute ago would leave a car sitting at a
  // camera that has since come back.
  const probe = await tcpProbe(cam.host, port, CONNECT_PROBE_TIMEOUT_MS);
  if (!probe.ok) {
    return { ok: false, error: `camera unreachable at ${cam.host}:${port} (${probe.code})`, via: 'temp' };
  }

  let handle = 0;
  try {
    handle = fns.Open(cam.host, port, cam.deviceUser ?? '', cam.devicePassword ?? '');
    if (handle === 0) return { ok: false, error: 'open_failed', via: 'temp' };
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

/**
 * Boot: warm up every credentialed camera, then keep checking.
 *
 * The tick is what makes recovery automatic. A camera that was unplugged at boot,
 * or whose connection dropped overnight, used to stay cold until somebody saved a
 * camera — meaning the barrier fell back to opening a fresh handle per car, and
 * did so via the same 6-second blocking call. It costs one socket probe per cold
 * camera per minute, and nothing at all for ones already connected.
 */
export function startCameraRelay() {
  resync();
  if (!reconnectTimer) {
    reconnectTimer = setInterval(resync, RECONNECT_TICK_MS);
    // Don't hold the event loop open on quit.
    reconnectTimer.unref?.();
  }
}

export function stopCameraRelay() {
  if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }
  connecting.clear();
  lastFailure.clear();
  for (const id of [...connections.keys()]) closeConnection(id);
  // NOTE: intentionally NOT calling VzLPRClient_Cleanup() — segfaults on teardown.
}
