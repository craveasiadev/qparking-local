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
  /** DEV/QA only: force the entry moment (recorded entry_at, and therefore the
   *  stay length a later exit prices) to this ISO instant instead of "now". Set
   *  by the Sessions simulator's timed Entry. Undefined for real camera events.
   *
   *  This is the ONLY thing that makes a simulated entry differ from a real one
   *  — the simulator otherwise goes through the very same handlePlateEvent path,
   *  so every guard, session write, barrier pulse and audit row is identical. */
  entryAtOverride?: string;
  /**
   * A member of staff is admitting this car BY HAND, having looked at it.
   *
   * Skips the Only Pass Allow refusal and nothing else — the blacklist, the
   * already-inside guard, the pass quota, the session write, the barrier pulse and
   * the audit row all behave exactly as they do for a camera read, because this
   * goes through the same handlePlateEvent path.
   *
   * Exists because a plate the camera cannot read at all (not merely one character
   * out — see plate-match.ts for that) left staff with no way to admit a resident
   * except the DEV simulator, and the alternative escape hatch, a manual barrier
   * pulse, records no session: the driver is then stopped again on the way out.
   */
  operatorAdmit?: boolean;
}

/**
 * The picture belonging to a read the flow has already handled, emitted as
 * `plate-capture`. Deliberately NOT a PlateEvent: it must never route through
 * handlePlateEvent, because the entry/exit decision was made on the first post
 * of this same read. Consumed by parking-flow, which attaches it to the session
 * that read opened.
 */
export interface PlateCapture {
  cameraId: number;
  plate: string;
  /** Absolute path under userData/plates — always non-null when emitted. */
  imagePath: string;
  direction: 'entry' | 'exit';
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

/**
 * The port a camera pushes to when nothing says otherwise — the default of the
 * `cameras.webhook_port` column, and the box-wide setting that column replaced.
 *
 * ALWAYS bound, even with no camera registered on it, because the useful
 * diagnostic on a fresh install is the `unknown_camera` audit row telling the
 * operator which IP pushed and what host to register. Nothing bound means the
 * camera's push is refused by the OS and the box has nothing at all to say.
 */
export const DEFAULT_LPR_WEBHOOK_PORT = 6001;

/**
 * One listener per distinct port a camera pushes to.
 *
 * There USED to be a single box-wide port, which assumed every camera on a site
 * can be pointed at the same one. Firmware varies in what it will let you
 * change — some builds hard-code their push port the way others hard-code the
 * push PATH (see isPlateEndpoint) — so the port moved onto the camera and this
 * binds the whole set.
 *
 * Each entry keeps its own sockets so one port can be rebound (a camera's port
 * edited) without disturbing the others, or the /live MJPEG streams they carry.
 */
const servers = new Map<number, { server: http.Server; sockets: Set<import('node:net').Socket> }>();

// ─── rejected-webhook reporting throttle ────────────────────────────────────
// One audit row per camera per window. A camera with a stale secret re-posts on
// every single vehicle pass, so this is the difference between "a warning you
// can see" and "an Activity Log with nothing else left in it".
const REJECT_REPORT_WINDOW_MS = 10 * 60_000;
const lastRejectReportAt = new Map<string, number>();

/**
 * One audit row per SOURCE per window.
 *
 * Keyed by a string, not a camera id, because the id is not always the thing that
 * distinguishes one problem from another. An unregistered camera has no id at all,
 * so every unknown source used to share the single sentinel key `-1` — and during
 * the exact scenario the unknown_camera message describes (a second camera added,
 * both now having to match by IP) two misconfigured cameras produced ONE report
 * per ten minutes between them. The operator fixed whichever got reported and
 * never learned about the other.
 *
 * A registered camera still throttles per camera; an unknown one throttles per
 * remote IP, so each misconfigured device gets its own row.
 */
function shouldReportRejection(key: string): boolean {
  const last = lastRejectReportAt.get(key) ?? 0;
  if (Date.now() - last < REJECT_REPORT_WINDOW_MS) return false;
  lastRejectReportAt.set(key, Date.now());
  // A long-running box must not accumulate one entry per IP that ever probed the
  // port. Cheap: only walks the map once it is already large.
  if (lastRejectReportAt.size > 200) {
    const cutoff = Date.now() - REJECT_REPORT_WINDOW_MS;
    for (const [k, at] of lastRejectReportAt) {
      if (at < cutoff) lastRejectReportAt.delete(k);
    }
  }
  return true;
}

// ─── same-read de-duplication ───────────────────────────────────────────────
// One car passing a camera produces SEVERAL HTTP posts, from two independent
// causes that compound:
//
//   1. The firmware posts the same read to more than one endpoint — typically
//      its factory default /devicemanagement/php/quickplateresult.php AND a
//      configured URL. Accepting both paths (which we must, see isPlateEndpoint)
//      turns one physical read into two identical events.
//   2. ANPR firmware re-reports the same plate two or three times per pass as
//      its confidence settles.
//
// Both produce byte-identical (camera, plate) pairs within the same second or
// two. Collapsing them HERE, at the door, keeps every downstream stage honest:
// the flow's own guards (already-inside, exit grace, lane busy) exist for real
// second passes and shouldn't be doing double duty as a network de-duplicator.
//
// The window is deliberately short. Same camera + same plate inside a couple of
// seconds is one car, always — a genuine re-read that far apart is physically
// impossible, and a DIFFERENT car cannot share the plate.
const DUPLICATE_POST_WINDOW_MS = 3_000;
const lastAcceptedRead = new Map<string, { at: number; hadImage: boolean }>();

/**
 * What to do with an inbound post, given what we've already accepted for this
 * (camera, plate) inside the collapse window.
 *
 *   'accept'      — first post of this read; run the full flow.
 *   'capture'     — a repeat that carries the PICTURE the first one lacked.
 *                   Save the JPEG and attach it to the session the first post
 *                   opened, but do NOT re-run the flow.
 *   'drop'        — a genuine duplicate; nothing new to learn from it.
 *
 * The 'capture' case is not hypothetical, it is the normal behaviour of the
 * Hangzhou-family firmware: it posts a plate-only "quick result" to
 * /devicemanagement/php/quickplateresult.php and the full result carrying
 * `imageFile` a beat later. Collapsing purely on (camera, plate) meant the
 * imageless post won and the picture-bearing one was discarded — plates kept
 * working and every session silently lost its photo.
 *
 * Only ONE upgrade per read: `hadImage` flips on the first picture through, so
 * a camera that posts the image twice still costs one file.
 */
type PostVerdict = 'accept' | 'capture' | 'drop';

function classifyPost(cameraId: number, plate: string, hasImage: boolean): PostVerdict {
  const key = `${cameraId}|${plate}`;
  const now = Date.now();
  const mark = lastAcceptedRead.get(key);
  if (mark && now - mark.at < DUPLICATE_POST_WINDOW_MS) {
    if (hasImage && !mark.hadImage) {
      // Deliberately does NOT refresh `mark.at`: the collapse window stays
      // anchored to the first post, so a chatty camera can't walk it forward.
      mark.hadImage = true;
      return 'capture';
    }
    return 'drop';
  }
  lastAcceptedRead.set(key, { at: now, hadImage: hasImage });
  // Opportunistic sweep so a long-running box doesn't accumulate one entry per
  // plate seen, forever. Cheap: only runs once the map is already large.
  if (lastAcceptedRead.size > 500) {
    for (const [k, m] of lastAcceptedRead) {
      if (now - m.at > DUPLICATE_POST_WINDOW_MS) lastAcceptedRead.delete(k);
    }
  }
  return 'accept';
}

/**
 * Which POST paths carry a plate read.
 *
 * `/lpr/event` is ours. The rest are what the Hangzhou-family ANPR firmware
 * posts to WITHOUT being asked — `/devicemanagement/php/quickplateresult.php`
 * is its factory default push path, hard-coded in some builds with no field to
 * change it. Rejecting it meant a camera that was correctly wired, correctly
 * detecting, and genuinely sending its reads to this port got a 404 for every
 * car, and the operator was told to "point the camera at POST /lpr/event" —
 * advice that cannot be followed on firmware that has no such setting.
 *
 * Matching is on the path only; the body still has to parse and still has to
 * resolve to a registered camera, so this widens the door, not the trust.
 */
function isPlateEndpoint(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split('?')[0].toLowerCase();
  return path.startsWith('/lpr/event')
    // Vendor default push paths, seen in the wild on VzLPR/Uniview-clone builds.
    || path.includes('quickplateresult')
    || path.includes('plateresult');
}

/**
 * Bind (or rebind) the listeners so they match the cameras that are registered.
 *
 * Idempotent and safe to call on every camera change: a port already listening
 * is left strictly alone — rebinding it would drop the live MJPEG streams and
 * risk an EADDRINUSE against its own closing socket — while ports no longer
 * used by any camera are closed, and new ones bound.
 *
 * Disabled cameras are INCLUDED deliberately. Their reads are rejected further
 * in with a `camera_disabled` audit row, and that row is the only way an
 * operator ever finds out a camera they forgot to enable is otherwise wired
 * correctly. Not binding the port would turn that into silence.
 *
 * Returns the ports it is now HOLDING, which is optimistic by one tick: listen()
 * resolves asynchronously, so a port that loses its bind drops out a moment
 * later. activeLprPorts() / diagnose() are the authority after that.
 */
export function startLprServers(): number[] {
  const wanted = new Set<number>([DEFAULT_LPR_WEBHOOK_PORT]);
  for (const camera of listCameras()) {
    const port = Number(camera.webhookPort);
    if (Number.isInteger(port) && port > 0 && port < 65536) wanted.add(port);
  }

  for (const port of [...servers.keys()]) {
    if (!wanted.has(port)) closeLprServer(port);
  }
  for (const port of wanted) {
    if (!servers.has(port)) bindLprServer(port);
  }
  return [...servers.keys()].sort((a, b) => a - b);
}

function bindLprServer(port: number) {
  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && isPlateEndpoint(req.url)) {
      handleEvent(req, res).catch((e) => {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: e.message }));
      });
      return;
    }
    // Live-display MJPEG stream: GET /live/<cameraId>
    const live = req.method === 'GET' && req.url ? /^\/live\/(\d+)/.exec(req.url) : null;
    if (live) { handleLiveStream(Number(live[1]), req, res); return; }
    // Something reached the port but not the plate endpoint — almost always a
    // camera pointed at the wrong path (/lpr, /event, a trailing typo) or using
    // GET. Reported because it is otherwise invisible: the camera shows its
    // push as "sent", the app shows nothing, and the URL is the last thing
    // anyone thinks to re-check.
    lprEvents.emit('webhook-unroutable', {
      method: req.method ?? '?',
      url: req.url ?? '?',
      remoteIp: (req.socket.remoteAddress || '').replace(/^::ffff:/, ''),
    });
    res.statusCode = 404;
    res.end('not found');
  });
  // Track sockets so closeLprServer() can actually free the port: server.close()
  // only stops accepting NEW connections, and a /live MJPEG stream never ends on
  // its own — the port would stay held and an immediate rebind would hit
  // EADDRINUSE against ourselves.
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  // Registered before listen() resolves, so a second call in the same tick can't
  // bind the same port twice. A failed bind removes it again (see 'error').
  servers.set(port, { server, sockets });
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
    // Discard the crashed server so a later startLprServers() can retry this
    // port cleanly. Don't rethrow — that's what causes the app-crash dialog.
    try { server.close(); } catch { /* ignore */ }
    if (servers.get(port)?.server === server) servers.delete(port);
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(`[lpr] listening on :${port}`);
  });
}

/** Close one listener and free its port, streams and all. */
function closeLprServer(port: number) {
  const entry = servers.get(port);
  if (!entry) return;
  servers.delete(port);
  // Destroy the sockets before closing: the long-lived /live MJPEG streams would
  // otherwise hold the port open indefinitely. The Live display tiles
  // auto-reconnect, so a viewer sees a blink at worst.
  for (const socket of entry.sockets) {
    try { socket.destroy(); } catch { /* ignore */ }
  }
  entry.sockets.clear();
  try { entry.server.close(); } catch { /* ignore */ }
}

/** Close every listener — app shutdown, and the harnesses' teardown. */
export function stopLprServers() {
  for (const port of [...servers.keys()]) closeLprServer(port);
  for (const set of mjpegClients.values()) {
    for (const res of set) { try { res.destroy(); } catch { /* ignore */ } }
    set.clear();
  }
  mjpegClients.clear();
}

/** The ports currently bound, ascending. */
export function activeLprPorts(): number[] {
  return [...servers.keys()].sort((a, b) => a - b);
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

  // Unconditional arrival trace, emitted BEFORE any guard can drop this read.
  // This is the one line that answers "is the camera even talking to us?" — the
  // question every other log in the app assumes has already been settled. If
  // this appears and no parking-flow line follows, the app rejected the read and
  // the reason is in the very next log row. If it never appears at all, nothing
  // reached this process and the problem is the camera's push config or the
  // network, not qparking-local.
  lprEvents.emit('webhook-received', {
    remoteIp,
    sentIp: extracted.ipaddr ?? null,
    plate: extracted.plate || null,
    direction: extracted.direction ?? null,
    // The PATH matters for diagnosis: a camera posting the same read to both its
    // factory default endpoint and a configured one shows up here as two
    // otherwise-identical lines, and without this there is no way to tell that
    // apart from the camera genuinely firing twice.
    path: (req.url ?? '').split('?')[0] || '/',
  });

  if (!extracted.plate) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'plate_required' }));
    return;
  }

  const camera = resolveCamera(extracted);
  if (!camera) {
    // SILENT FAILURE, until 2026-08-07: this returned a 404 to the camera and
    // nothing else — no log line, no event, nothing in the Activity Log. From
    // inside the app an unmatched camera is indistinguishable from a camera that
    // never fired, which is exactly the "the plate is detected but the app sees
    // nothing" dead end.
    //
    // It bites hardest when a SECOND camera is added: with one camera registered
    // resolveCamera falls back to it regardless of IP, so everything works; add
    // an exit camera and both must now match by IP, and any mismatch starts
    // dropping reads without a word.
    const known = listCameras().map((c) => `${c.name}=${c.host || 'no host set'}`).join(', ') || 'none registered';
    if (shouldReportRejection(`unknown:${remoteIp || extracted.ipaddr || '?'}`)) {
      lprEvents.emit('webhook-rejected', {
        cameraId: null,
        cameraName: null,
        plate: extracted.plate,
        remoteIp,
        sentIp: extracted.ipaddr ?? null,
        knownCameras: known,
        reason: 'unknown_camera',
        throttleMinutes: REJECT_REPORT_WINDOW_MS / 60_000,
      });
    }
    res.statusCode = 404;
    res.end(JSON.stringify({
      error: 'unknown_camera',
      hint: `No camera matched. Sent ipaddr=${extracted.ipaddr ?? '-'} remoteIp=${remoteIp}. Add a camera in qparking-local with host=${extracted.ipaddr ?? remoteIp}. Registered: ${known}.`,
    }));
    return;
  }
  if (!camera.enabled) {
    // Same reasoning as unknown_camera: a disabled camera silently swallowed
    // every read, and "disabled" is easy to forget after a bit of testing.
    if (shouldReportRejection(`camera:${camera.id}`)) {
      lprEvents.emit('webhook-rejected', {
        cameraId: camera.id,
        cameraName: camera.name,
        plate: extracted.plate,
        remoteIp,
        reason: 'camera_disabled',
        throttleMinutes: REJECT_REPORT_WINDOW_MS / 60_000,
      });
    }
    res.statusCode = 403; res.end(JSON.stringify({ error: 'camera_disabled' })); return;
  }

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
      if (shouldReportRejection(`camera:${camera.id}`)) {
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

  // Collapse the same physical read arriving more than once — see classifyPost.
  // Placed AFTER the frame cache (the operator should still get the freshest
  // picture) and AFTER the no-read guard, but BEFORE the event is emitted: a
  // repeat must never cost a second trip through the flow.
  //
  // A repeat that carries the PICTURE the first post lacked is the exception —
  // it still costs a file, because that file is the whole point of it. It takes
  // the 'capture' branch below instead of the flow.
  //
  // Returns 200, not an error. The camera did nothing wrong, and a non-2xx makes
  // some firmware retry — which would manufacture the very duplicates this is
  // here to remove.
  const verdict = classifyPost(camera.id, plate, Boolean(extracted.image));
  if (verdict === 'drop') {
    lprEvents.emit('webhook-duplicate', {
      cameraId: camera.id,
      cameraName: camera.name,
      plate,
      path: (req.url ?? '').split('?')[0] || '/',
      windowMs: DUPLICATE_POST_WINDOW_MS,
    });
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, ignored: 'duplicate_read', cameraId: camera.id }));
    return;
  }

  const imagePath = extracted.image
    ? await saveImage(plate, extracted.image).catch(() => null)
    : null;

  const direction = resolveDirection(extracted.direction, camera);

  // The picture half of a read the flow has ALREADY acted on. It must not go
  // through handlePlateEvent: that would open a second session / re-pulse the
  // barrier for a car that was admitted a second ago. It carries no decision,
  // only the photo.
  if (verdict === 'capture') {
    if (imagePath) {
      lprEvents.emit('plate-capture', { cameraId: camera.id, plate, imagePath, direction } satisfies PlateCapture);
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, captured: Boolean(imagePath), plate, cameraId: camera.id }));
    return;
  }

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
    const wanted = extracted.ipaddr.trim();
    const atThisIp = cameras.filter((camera) => camera.host && camera.host.trim() === wanted);
    // ENABLED WINS. One physical camera is routinely registered more than once
    // — a first attempt, then a second row set up properly — and the old
    // `.find()` took whichever had the lower id. If that was a leftover the
    // operator had switched OFF, every read from a working, enabled camera at
    // the same IP was resolved to the dead row and thrown away as
    // 'camera_disabled'. The camera fired, the app reported the WRONG camera
    // as the reason, and the real one never saw a single plate.
    //
    // Disabled means "ignore this row", not "swallow reads on this IP".
    return atThisIp.find((camera) => camera.enabled) ?? atThisIp[0] ?? null;
  }
  // Last resort: a single registered camera takes everything, whatever IP it
  // reports. Only safe while there IS just one — with two, an unmatched IP has
  // to be an error rather than a coin toss.
  const enabled = cameras.filter((camera) => camera.enabled);
  if (enabled.length === 1) return enabled[0];
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
  const ports = activeLprPorts();
  // `ports` is the set actually LISTENING, which is not the same as the set the
  // cameras are configured for — a port that failed to bind is missing from it,
  // and that gap is exactly what the Cameras page needs to show.
  return { ports, addresses, cameras: listCameras().length };
}
