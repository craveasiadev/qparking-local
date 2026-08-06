/**
 * Local HTTP server that accepts plate-detection events from LPR cameras.
 *
 * Most ANPR cameras (Hikvision/Dahua/Uniview/etc.) can POST a JSON event to
 * a configurable URL when they read a plate. The exact payload shape varies
 * by vendor; we accept a vendor-agnostic envelope and let the user map fields
 * via the camera config:
 *
 *   POST /lpr/event
 *   X-Webhook-Secret: <camera.webhook_secret>
 *   {
 *     "cameraId": 1,                  // required — links to cameras table
 *     "plate": "VMM1234",             // required — already-recognised text
 *     "confidence": 0.92,             // optional
 *     "image": "<base64 jpeg>",       // optional — captured frame
 *     "timestamp": "2026-05-18T...",  // optional, falls back to now
 *     "direction": "entry"            // optional override of camera default
 *   }
 *
 * For vendors that don't speak JSON cleanly (form-encoded, xml, multipart),
 * write a small adapter that reshapes their payload before POSTing here.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { app } from 'electron';
import { getCamera, listCameras } from './db';
import { canonicalPlate } from '../../shared/plate';
import type { LprCamera } from '../../shared/types';

export interface PlateEvent {
  cameraId: number;
  plate: string;
  confidence?: number;
  imagePath: string | null;
  timestamp: string;
  /** entry | exit only. 'dual' was retired — see LprCamera.direction. Inbound
   *  payloads carrying it are coerced to the camera's own direction by
   *  resolveDirection() below, so an old integration can't inject a value the
   *  flow no longer routes. */
  direction: 'entry' | 'exit';
  /** DEV/QA only: force the exit moment (fee window + recorded exit_at) to this
   *  ISO instant instead of "now". Set by the Sessions simulator's timed Exit;
   *  undefined for real camera events, so the live flow is unaffected. */
  exitAtOverride?: string;
}

export const lprEvents = new EventEmitter();

/**
 * In-memory cache of the most recent frame each camera PUSHED with a plate
 * event (base64 JPEG). Cameras that only stream video over WebSocket/RTSP
 * expose no pullable HTTP snapshot, so the Live display falls back to this —
 * it refreshes on every plate the camera reads. Lost on restart (repopulates
 * on the next detection); that's fine for a live view.
 */
const latestFrames = new Map<number, { base64: string; contentType: string; at: string }>();
export function getLatestFrame(cameraId: number): { base64: string; contentType: string; at: string } | null {
  return latestFrames.get(cameraId) ?? null;
}
/** Set the latest frame for a camera — used by the RTSP feed (camera-rtsp.ts)
 *  to keep a ~1/s snapshot in the same cache the Live display and plate-event
 *  capture read. */
export function setLatestFrame(cameraId: number, frame: { base64: string; contentType: string; at: string }): void {
  latestFrames.set(cameraId, frame);
}

/**
 * MJPEG fan-out for the Live display. A GET /live/<id> response is an
 * `multipart/x-mixed-replace` stream; the RTSP feed (camera-rtsp.ts) calls
 * pushJpegFrame() as ffmpeg decodes frames, and every viewer of that camera gets
 * the frame pushed. No polling, no base64, no per-frame IPC — the browser renders
 * each part natively, which is what makes the wall smooth instead of a 1 fps
 * slideshow.
 */
const MJPEG_BOUNDARY = 'qpframe';
const MJPEG_TRAILER = Buffer.from('\r\n');
const mjpegClients = new Map<number, Set<http.ServerResponse>>();

/** Broadcast one JPEG frame to every open MJPEG viewer of a camera. */
export function pushJpegFrame(cameraId: number, jpeg: Buffer): void {
  const set = mjpegClients.get(cameraId);
  if (!set || set.size === 0) return;
  const head = Buffer.from(
    `--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`,
  );
  for (const res of set) {
    // A viewer that has gone away (rapid Refresh, closed window) can still be in
    // the set for a tick before its close handler runs — never write to a dead
    // socket, and never let a failed write bubble up (it would kill the grabber).
    if (res.destroyed || res.writableEnded) { set.delete(res); continue; }
    // Drop frames for a viewer that can't keep up rather than buffering without
    // bound (a stalled socket would otherwise grow memory forever).
    if (res.writableLength > 4 * 1024 * 1024) continue;
    try { res.write(head); res.write(jpeg); res.write(MJPEG_TRAILER); }
    catch { set.delete(res); try { res.destroy(); } catch { /* ignore */ } }
  }
}

function handleLiveStream(cameraId: number, req: http.IncomingMessage, res: http.ServerResponse) {
  res.writeHead(200, {
    'Content-Type': `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Connection': 'close',
  });
  let set = mjpegClients.get(cameraId);
  if (!set) { set = new Set(); mjpegClients.set(cameraId, set); }
  // A reconnect (the Refresh button remounts the tile) supersedes any existing
  // stream for this camera: close the old one(s) so connections don't pile up
  // against the browser's ~6-per-host limit when Refresh is pressed repeatedly.
  // Single operator screen → one viewer per camera, so closing stale ones is safe.
  for (const old of set) { try { old.end(); } catch { /* ignore */ } }
  set.clear();
  set.add(res);
  const cleanup = () => { set!.delete(res); try { res.end(); } catch { /* ignore */ } };
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}

let server: http.Server | null = null;
let activePort = 0;

// ─── rejected-webhook reporting throttle ────────────────────────────────────
// One audit row per camera per window. A camera with a stale secret re-posts on
// every single vehicle pass, so this is the difference between "a warning you
// can see" and "an Activity Log with nothing else left in it".
const REJECT_REPORT_WINDOW_MS = 10 * 60_000;
const lastRejectReportAt = new Map<number, number>();

function shouldReportRejection(cameraId: number): boolean {
  const last = lastRejectReportAt.get(cameraId) ?? 0;
  if (Date.now() - last < REJECT_REPORT_WINDOW_MS) return false;
  lastRejectReportAt.set(cameraId, Date.now());
  return true;
}

export function startLprServer(port: number) {
  stopLprServer();
  activePort = port;
  server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url?.startsWith('/lpr/event')) {
      handleEvent(req, res).catch((e) => {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: e.message }));
      });
      return;
    }
    // Live-display MJPEG stream: GET /live/<cameraId>
    const live = req.method === 'GET' && req.url ? /^\/live\/(\d+)/.exec(req.url) : null;
    if (live) { handleLiveStream(Number(live[1]), req, res); return; }
    res.statusCode = 404;
    res.end('not found');
  });
  // Graceful port-conflict handler. Without this, EADDRINUSE bubbles up as
  // an unhandled exception and crashes the whole main process (the operator
  // sees a JavaScript-error dialog with no obvious recovery). This is a real
  // hazard when a developer runs `npm run dev` alongside a packaged install
  // — both try to bind port 6001. We log a clear warning and continue; LPR
  // ingest is degraded but the rest of the app keeps working.
  server.on('error', (err: any) => {
    if (err?.code === 'EADDRINUSE') {
      console.warn(`[lpr] port ${port} already in use — LPR webhook listener not bound. Another qparking-local instance may be running (check for the packaged portable). LPR camera events will NOT reach this process until the port is free.`);
    } else {
      console.error(`[lpr] server error: ${err?.message ?? err}`);
    }
    // Say it where an operator will actually find it. This is the app's most
    // deceptive failure mode: nothing crashes, every screen looks healthy, and
    // not one car is recorded because no plate event can reach the process. A
    // console warning nobody reads is not a report. index.ts writes the row.
    lprEvents.emit('listener-error', {
      port,
      code: err?.code ?? null,
      message: err?.message ?? String(err),
    });
    // Discard the crashed server so subsequent startLprServer() calls can
    // retry cleanly. Don't rethrow — that's what causes the app-crash dialog.
    try { server?.close(); } catch { /* ignore */ }
    server = null;
    activePort = 0;
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(`[lpr] listening on :${port}`);
  });
}

export function stopLprServer() {
  if (server) {
    // Destroy any open /live MJPEG streams first. server.close() only stops
    // accepting NEW connections — these long-lived streams would otherwise keep
    // the socket (and the port) alive, so an immediate re-bind on the same port
    // hits EADDRINUSE. Clients (the Live display tiles) auto-reconnect.
    for (const set of mjpegClients.values()) {
      for (const res of set) { try { res.destroy(); } catch { /* ignore */ } }
      set.clear();
    }
    mjpegClients.clear();
    try { server.close(); } catch { /* ignore */ }
    server = null;
  }
}


async function handleEvent(req: http.IncomingMessage, res: http.ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString('utf-8');

  let payload: any;
  try { payload = JSON.parse(body); }
  catch {
    // Some ANPR firmwares (Hangzhou/Uniview clones) send relaxed JSON with
    // unquoted keys. Try a tolerant repair before giving up.
    try { payload = JSON.parse(loosenJson(body)); }
    catch { res.statusCode = 400; res.end(JSON.stringify({ error: 'invalid_json' })); return; }
  }

  // Normalise the vendor-specific envelope (AlarmInfoPlate / PlateResult /
  // license + ipaddr) into our internal shape. The camera firmware doesn't
  // let you inject arbitrary fields like `cameraId`, so we identify the
  // camera by its LAN IP, falling back to the connecting socket address.
  const remoteIp = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const extracted = extractEvent(payload, remoteIp);

  if (!extracted.plate) { res.statusCode = 400; res.end(JSON.stringify({ error: 'plate_required' })); return; }

  const camera = resolveCamera(extracted);
  if (!camera) {
    res.statusCode = 404;
    res.end(JSON.stringify({
      error: 'unknown_camera',
      hint: `No camera matched. Sent ipaddr=${extracted.ipaddr ?? '-'} remoteIp=${remoteIp}. Add a camera in qparking-local with host=${extracted.ipaddr ?? remoteIp}.`,
    }));
    return;
  }
  if (!camera.enabled) { res.statusCode = 403; res.end(JSON.stringify({ error: 'camera_disabled' })); return; }

  // Webhook secret check (skipped when camera has no secret set — useful for
  // dev / on-prem boxes behind a private VLAN). Vendor firmwares can't set
  // custom headers, so this only applies to apps using the generic shape.
  if (camera.webhookSecret) {
    const supplied = req.headers['x-webhook-secret'];
    if (supplied !== camera.webhookSecret) {
      // Worth an audit row — it's either a camera whose secret was rotated on one
      // side only (its reads are being dropped) or something on the LAN probing
      // the port. THROTTLED per camera: a misconfigured camera retries on every
      // pass, and a flood would bury the log it's trying to warn you through.
      if (shouldReportRejection(camera.id)) {
        lprEvents.emit('webhook-rejected', {
          cameraId: camera.id,
          cameraName: camera.name,
          plate: extracted.plate,
          remoteIp,
          reason: supplied ? 'wrong_secret' : 'missing_secret_header',
          throttleMinutes: REJECT_REPORT_WINDOW_MS / 60_000,
        });
      }
      res.statusCode = 401; res.end(JSON.stringify({ error: 'bad_secret' })); return;
    }
  }

  const plate = normalisePlate(extracted.plate);

  // Cache the pushed frame so the Live display can show a near-live view for
  // WebSocket/RTSP-only cameras that have no HTTP snapshot URL. Done before the
  // no-read guard so the operator still sees the feed even on a failed read.
  if (extracted.image) {
    const raw = extracted.image.replace(/^data:image\/[a-z]+;base64,/i, '');
    latestFrames.set(camera.id, { base64: raw, contentType: 'image/jpeg', at: new Date().toISOString() });
  }

  // The ANPR camera pushes a frame even when it CAN'T read a plate — the plate
  // comes through as 'NONE' / '' / 'UNKNOWN'. Ignore those: don't save an image,
  // don't emit, don't create a session. Otherwise the DB fills with phantom
  // no-plate rows. The camera still gets a 200 so it doesn't retry.
  if (isNoReadPlate(plate)) {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, ignored: 'no_plate', cameraId: camera.id }));
    return;
  }

  const imagePath = extracted.image
    ? await saveImage(plate, extracted.image).catch(() => null)
    : null;

  const direction = resolveDirection(extracted.direction, camera);

  const event: PlateEvent = {
    cameraId: camera.id,
    plate,
    confidence: extracted.confidence,
    imagePath,
    timestamp: extracted.timestamp ?? new Date().toISOString(),
    direction,
  };

  lprEvents.emit('plate', event);

  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true, plate, cameraId: camera.id, direction }));
}

/**
 * Decide the direction for an inbound event. The payload MAY override the
 * camera's own direction (custom integrations and the dev simulator rely on
 * this), but only with a value the flow actually routes.
 *
 * Anything else — the retired 'dual', a typo, a vendor field we mis-mapped —
 * falls back to the camera's configured direction rather than being passed
 * through. Before this, an unrecognised string reached handlePlateEvent and was
 * silently treated as 'entry' by its `=== 'exit' ? 'exit' : 'entry'` default,
 * so a stale integration still POSTing "dual" would have opened entry sessions
 * on an EXIT camera. Falling back to the camera keeps the operator's own
 * configuration authoritative.
 */
function resolveDirection(supplied: string | undefined, camera: LprCamera): PlateEvent['direction'] {
  if (supplied === 'entry' || supplied === 'exit') return supplied;
  if (supplied) {
    console.warn(`[lpr] camera ${camera.id} sent unsupported direction "${supplied}" — using the camera's configured "${camera.direction}" instead`);
  }
  return camera.direction;
}

/**
 * Pull plate / camera-identity / metadata out of either:
 *   - our native shape:   { cameraId, plate, ... }
 *   - vendor envelope:    { AlarmInfoPlate: { ipaddr, result: { PlateResult: { license, ... } } } }
 *
 * The vendor (Hangzhou-family ANPR cams: Uniview/Dahua-clone/etc.) sends a
 * deeply-nested payload that uses its own field names. We translate it down
 * to flat fields here so the rest of the pipeline doesn't care.
 */
function extractEvent(payload: any, remoteIp: string): {
  cameraId?: number;
  ipaddr?: string;
  serialno?: string;
  plate: string;
  confidence?: number;
  image?: string;
  timestamp?: string;
  direction?: string;
} {
  // Vendor envelope first — it's the format real cameras send.
  const alarm = payload?.AlarmInfoPlate;
  if (alarm && typeof alarm === 'object') {
    const result = alarm.result?.PlateResult ?? {};
    return {
      ipaddr: alarm.ipaddr || remoteIp,
      serialno: alarm.serialno,
      plate: String(result.license ?? ''),
      confidence: typeof result.confidence === 'number' ? result.confidence : undefined,
      image: result.imageFile || result.imagefile, // base64 if "Send picture" enabled on cam
      timestamp: undefined, // camera timestamp is broken (epoch 1970), use server time
      direction: undefined, // camera doesn't know its lane direction
    };
  }
  // Native shape (used by simulate button + custom integrations).
  return {
    cameraId: Number(payload?.cameraId) || undefined,
    ipaddr: payload?.ipaddr || remoteIp,
    plate: String(payload?.plate ?? ''),
    confidence: typeof payload?.confidence === 'number' ? payload.confidence : undefined,
    image: payload?.image,
    timestamp: payload?.timestamp,
    direction: payload?.direction,
  };
}

/**
 * Match the inbound event to a configured camera. Priority:
 *   1. explicit cameraId in body (native shape)
 *   2. IP match against `cameras.host` (vendor shape — most real cameras)
 *   3. If only ONE camera is configured, use it (single-lane sites)
 */
function resolveCamera(extracted: { cameraId?: number; ipaddr?: string }): LprCamera | null {
  if (extracted.cameraId) {
    return getCamera(extracted.cameraId);
  }
  const cameras = listCameras();
  if (extracted.ipaddr) {
    const match = cameras.find((camera) => camera.host && camera.host.trim() === extracted.ipaddr!.trim());
    if (match) return match;
  }
  if (cameras.length === 1) return cameras[0];
  return null;
}

/**
 * Best-effort repair for unquoted-key JSON that some ANPR firmwares emit.
 * Quotes bare identifiers used as object keys, and quotes unquoted string
 * values that look like identifiers (e.g. `license:Test` → `"license":"Test"`).
 * Leaves numbers, true/false/null, arrays, and already-quoted strings alone.
 */
function loosenJson(rawJson: string): string {
  // Quote keys:  {foo: ...   →   {"foo": ...
  let repaired = rawJson.replace(/([{,])\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
  // Quote bare identifier values: : Test, → : "Test",   (skip numbers/bools/null)
  repaired = repaired.replace(/:\s*([A-Za-z_][A-Za-z0-9_\-]*)\s*([,}\]])/g, (_match, value, closer) => {
    if (value === 'true' || value === 'false' || value === 'null') return `:${value}${closer}`;
    return `:"${value}"${closer}`;
  });
  return repaired;
}

/** Strip separators, uppercase. Cameras have wildly inconsistent formatting and
 *  the same physical plate can come in as "vmm 1234" or "VMM-1234".
 *  Delegates to the shared canonical rule so the gate, the cloud-pass cache and
 *  the pass lookup can never drift apart again (see shared/plate.ts). */
export function normalisePlate(plate: string): string {
  return canonicalPlate(plate);
}

/** True when the ANPR camera reported no readable plate. Compared against the
 *  already-normalised plate (upper-cased, separators stripped), so 'NO PLATE'
 *  and 'NO_PLATE' both arrive here as 'NOPLATE'. */
export function isNoReadPlate(plate: string): boolean {
  const p = (plate ?? '').trim().toUpperCase();
  return p === '' || p === 'NONE' || p === 'UNKNOWN' || p === 'NOPLATE' || p === 'NULL';
}

/** Saves a base64 JPEG (with or without data: prefix) under userData/plates/<date>/<plate>-<ts>.jpg. */
async function saveImage(plate: string, base64Image: string): Promise<string> {
  const base64Payload = base64Image.replace(/^data:image\/[a-z]+;base64,/i, '');
  const imageBuffer = Buffer.from(base64Payload, 'base64');
  const dateFolder = new Date().toISOString().slice(0, 10);
  const imageDir = path.join(app.getPath('userData'), 'plates', dateFolder);
  await fs.promises.mkdir(imageDir, { recursive: true });
  const filePath = path.join(imageDir, `${plate}-${Date.now()}.jpg`);
  await fs.promises.writeFile(filePath, imageBuffer);
  return filePath;
}

/** Used by the renderer to show whether the server is up + how cameras would
 *  reach it. We expose all the NICs so the operator can pick the right LAN IP. */
export function diagnose() {
  const addresses: string[] = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const nic of interfaces ?? []) {
      if (nic.family === 'IPv4' && !nic.internal) addresses.push(nic.address);
    }
  }
  return { port: activePort, addresses, cameras: listCameras().length };
}
