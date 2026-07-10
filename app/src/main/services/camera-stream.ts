/**
 * Live-video grabber via the vendor's native SDK (VzLPRSDK, 64-bit, bundled in
 * native/vzsdk). VZ LPR cameras (KLPR series) only stream H.264 over their
 * proprietary SDK/WebSocket — no HTTP snapshot, no usable RTSP URL. This is the
 * "video directly from the device" path the operator asked for:
 *
 *   VzLPRClient_Setup()                              // once
 *   h = VzLPRClient_Open(ip, port, user, pass)       // LAN — NOT OpenV2 (cloud)
 *   wait for VzLPRClient_IsConnected(h) == 1          // connection is async
 *   loop: VzLPRClient_GetSnapImage(h, buf, size)      // async, off the main thread
 *
 * Frames are pushed as MJPEG to the Live display (lpr-webhook.pushJpegFrame) for
 * a smooth feed, plus a throttled ~1/s copy into the latest-frame cache
 * (setLatestFrame) for records and non-streaming fallback tiles.
 *
 * NOTE: the decode-stream path (StartRealPlayDecData + GetJpegStreamFromRealPlayDec)
 * returns -1 and yields BLACK frames on these cameras — GetSnapImage is the
 * working headless grab. The decode path is kept only as a last-ditch fallback
 * for firmware/DLL builds that don't export GetSnapImage.
 *
 * The SDK is native code loaded via koffi FFI. `VzLPRClientHandle` is
 * `typedef int` (32-bit int on x86 AND x64), so every handle is a plain int.
 * We deliberately never call VzLPRClient_Cleanup() — it segfaults on process
 * teardown; skipping it lets the OS reap cleanly on quit.
 *
 * PRODUCTION NOTE: this runs in the main process. A native crash would take the
 * app down; if that proves an issue under load, move the grabber to an isolated
 * child process.
 */
import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';
import { listCameras } from './db';
import { setLatestFrame, pushJpegFrame, liveClientCount } from './lpr-webhook';
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

/** Load the SDK once. Returns false (and disables the grabber) if unavailable
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
      StartDec: lib.func('int VzLPRClient_StartRealPlayDecData(int)'),
      StopDec:  lib.func('int VzLPRClient_StopRealPlayDecData(int)'),
      GetJpeg:  lib.func('int VzLPRClient_GetJpegStreamFromRealPlayDec(int, void *, uint, int)'),
    };
    // Direct device snapshot to a memory buffer — takes the DEVICE handle, no
    // window/play-handle needed; the headless-friendly grab path. Optional: not
    // every firmware/DLL build exports it, so resolve defensively and degrade to
    // the decode-stream grab rather than disabling the whole SDK.
    try { fns.GetSnapImage = lib.func('int VzLPRClient_GetSnapImage(int, void *, int)'); }
    catch { fns.GetSnapImage = null; log('VzLPRClient_GetSnapImage unavailable — decode-stream grab only'); }
    const r = fns.Setup();
    setupOk = true;
    log(`SDK ready (Setup=${r}) from ${dir}`);
    return true;
  } catch (e: any) {
    log(`SDK unavailable — live video via SDK disabled: ${e?.message ?? e}`);
    return false;
  }
}

interface Grabber {
  handle: number;
  buf: Buffer;
  timer: NodeJS.Timeout | null;
  key: string;
  stopped: boolean;
}
const grabbers = new Map<number, Grabber>();

/** Config signature — restart the grabber when any of these change. */
function camKey(c: LprCamera): string {
  return `${c.host}|${c.deviceUser}|${c.devicePassword}|${c.devicePort}`;
}

function usesSdk(c: LprCamera): boolean {
  return !!(c.enabled && c.host && c.deviceUser && c.devicePassword);
}

/** Byte length of the JPEG at the start of buf (SOI…EOI), or 0 if buf doesn't
 *  begin with a JPEG. JPEG byte-stuffing guarantees 0xFFD9 never occurs inside
 *  entropy-coded data, so the first 0xFFD9 after the SOI is the true end — this
 *  stays correct even when buf still holds stale bytes from a previous, longer
 *  frame past that point. Lets us find the size without trusting the SDK call's
 *  (inconsistent) return-value meaning. */
function jpegEnd(buf: Buffer): number {
  if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return 0;
  const cap = buf.length - 1;
  for (let i = 2; i < cap; i++) {
    if (buf[i] === 0xFF && buf[i + 1] === 0xD9) return i + 2;
  }
  return 0;
}

function startGrabber(c: LprCamera) {
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
    const g: Grabber = { handle, buf: Buffer.allocUnsafe(4 * 1024 * 1024), timer: null, key: camKey(c), stopped: false };
    grabbers.set(cid, g);
    log(`cam ${cid} opened (handle=${handle}, ${c.host}:${port}) — waiting for connection`);

    // Phase 1: the connection is ASYNCHRONOUS — gate on IsConnected==1 like the
    // vendor demos (grabbing before connect yields black frames). Then Phase 2:
    // the continuous grab loop.
    const statusBuf = Buffer.alloc(1);
    let waited = 0;
    const connectTimer = setInterval(() => {
      if (g.stopped) { clearInterval(connectTimer); return; }
      statusBuf[0] = 0;
      try { fns.IsConnected(handle, statusBuf); } catch { /* ignore */ }
      waited++;
      const connected = statusBuf[0] === 1;
      if (connected || waited >= 20) {
        clearInterval(connectTimer);
        log(connected
          ? `cam ${cid} connected after ${waited}s — starting live grab`
          : `cam ${cid} not connected after 20s (IsConnected=0) — grabbing anyway; check network/credentials`);
        grabLoop(cid, g);
      }
    }, 1000);
    g.timer = connectTimer;
  } catch (e: any) {
    log(`cam ${cid} start failed: ${e?.message ?? e}`);
  }
}

/**
 * Continuous grab loop. Uses koffi's async call so the (potentially slow) native
 * snapshot runs on a worker thread and never blocks the main/UI thread; a single
 * in-flight call per camera (self-scheduling) prevents overlap on the shared
 * buffer. Grabs at full rate only while someone is watching that camera's MJPEG
 * stream — otherwise idles at ~1/s to keep the cache warm without loading the
 * device.
 */
function grabLoop(cid: number, g: Grabber) {
  const FAST_GAP = 60;    // someone watching → grab as fast as the device answers
  const IDLE_GAP = 1000;  // nobody watching → 1/s is plenty for the cache
  const snapAsync = fns.GetSnapImage && typeof fns.GetSnapImage.async === 'function';
  let gotFrame = false;
  let cachedAt = 0;

  // Publish a completed grab (if valid), then schedule the next one.
  const publish = (end: number, srcLabel: string) => {
    if (g.stopped) return;
    try {
      if (end > 0) {
        if (!gotFrame) { gotFrame = true; log(`cam ${cid} first frame via ${srcLabel} (${end} bytes) — live video flowing`); }
        const jpeg = Buffer.from(g.buf.subarray(0, end)); // copy: g.buf is reused on the next grab
        pushJpegFrame(cid, jpeg);
        const now = Date.now();
        if (now - cachedAt > 900) { // throttle the base64 cache to ~1/s (records + fallback tiles)
          cachedAt = now;
          setLatestFrame(cid, { base64: jpeg.toString('base64'), contentType: 'image/jpeg', at: new Date().toISOString() });
        }
      }
    } catch { /* a viewer socket dying mid-write (rapid Refresh) must never kill the loop */ }
    finally {
      // ALWAYS reschedule unless stopped. If publish ever throws and we skip
      // this, the camera silently stops rendering until the app restarts —
      // which is exactly the "refresh a few times and it dies" failure.
      if (!g.stopped) {
        const gap = liveClientCount(cid) > 0 ? FAST_GAP : IDLE_GAP;
        g.timer = setTimeout(tick, gap);
      }
    }
  };

  function tick() {
    if (g.stopped) return;
    if (fns.GetSnapImage) {
      if (snapAsync) {
        try {
          fns.GetSnapImage.async(g.handle, g.buf, g.buf.length, (err: any) => {
            publish(err ? 0 : jpegEnd(g.buf), 'snap');
          });
        } catch { publish(0, 'snap'); }
        return;
      }
      // koffi build without async — sync snapshot (still works, on main thread).
      let end = 0;
      try { fns.GetSnapImage(g.handle, g.buf, g.buf.length); end = jpegEnd(g.buf); } catch { /* ignore */ }
      publish(end, 'snap');
      return;
    }
    // Fallback: no GetSnapImage symbol — decode-stream pull (may be black on some
    // models, but keeps the pipe alive).
    let end = 0;
    try { fns.StartDec(g.handle); fns.GetJpeg(g.handle, g.buf, g.buf.length, 80); end = jpegEnd(g.buf); } catch { /* ignore */ }
    publish(end, 'dec');
  }

  tick();
}

function stopGrabber(id: number) {
  const g = grabbers.get(id);
  if (!g) return;
  grabbers.delete(id);
  g.stopped = true;
  if (g.timer) { clearTimeout(g.timer); clearInterval(g.timer); }
  // Defer the native teardown so any in-flight async GetSnapImage on a worker
  // thread finishes before we Close the handle (closing during an active native
  // read can crash the SDK). Snapshots return in tens of ms; 600ms is a wide
  // margin. On app-quit the process may exit first — fine, the OS reaps.
  const handle = g.handle;
  setTimeout(() => {
    try { fns.StopDec(handle); } catch { /* ignore */ }
    try { fns.Close(handle); } catch { /* ignore */ }
  }, 600);
}

/** Start/stop grabbers to match the current cameras that have SDK credentials.
 *  Call on boot and whenever cameras are saved/deleted. */
export function resync() {
  const wanted = listCameras().filter(usesSdk);
  for (const [id, g] of [...grabbers]) {
    const c = wanted.find((x) => x.id === id);
    if (!c || camKey(c) !== g.key) stopGrabber(id);
  }
  for (const c of wanted) {
    if (!grabbers.has(c.id)) startGrabber(c);
  }
}

export function startStreamGrabbers() { resync(); }

export function stopStreamGrabbers() {
  for (const id of [...grabbers.keys()]) stopGrabber(id);
  // NOTE: intentionally NOT calling VzLPRClient_Cleanup() — segfaults on teardown.
}
