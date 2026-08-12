/**
 * Live-video grabber via RTSP + FFmpeg. VZ LPR cameras also expose a plain
 * RTSP/H.264 endpoint (e.g. rtsp://<ip>:8557/h264) that plays in VLC with no
 * token — just the IP. Chromium (our renderer) can't decode RTSP/H.264 in an
 * <img>/<video>, so the main process runs FFmpeg to pull that stream and
 * transcode it to a stream of JPEG frames, which we fan out over the SAME
 * /live/<id> MJPEG endpoint the Live display already renders (lpr-webhook.ts).
 *
 *   ffmpeg -rtsp_transport tcp -i rtsp://<host>:8557/h264 \
 *          -an -f image2pipe -vcodec mjpeg -q:v <q> -r <fps> pipe:1
 *
 * The renderer's StreamTile is unchanged — it still opens one <img> against
 * /live/<id>; the frames just originate from FFmpeg now instead of the SDK
 * snapshot loop. This is the Live-display video source ONLY. Barrier open
 * (SetIOOutputAuto) and plate-event frame capture still come from the VZ SDK
 * (camera-relay.ts) exactly as before.
 *
 * FFmpeg is bundled via the `ffmpeg-static` package (no operator install).
 */
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { listCameras } from './db';
import { setLatestFrame, pushJpegFrame } from './lpr-webhook';
import type { LprCamera } from '../../shared/types';

/** RTSP endpoint shape for these cameras — VLC-verified as rtsp://<ip>:8557/h264
 *  with no credentials. Kept as constants so a different firmware's port/path is
 *  a one-line change; not yet exposed as a per-camera setting. */
const RTSP_PORT = 8557;
const RTSP_PATH = '/h264';
/** Transcode knobs. FFmpeg re-encodes every frame to JPEG, so we cap the frame
 *  rate and lean on a mid JPEG quality to keep CPU sane across several cameras
 *  on the on-prem box. A parking wall is perfectly smooth at ~15 fps. */
const FPS = 15;
const JPEG_Q = 6;          // ffmpeg -q:v: 2 (best) .. 31 (worst); 6 ≈ good/light
const CACHE_THROTTLE_MS = 900; // base64 latest-frame cache cadence (~1/s)
const RESTART_DELAY_MS = 2000; // backoff before re-spawning a died/exited ffmpeg

const SOI = Buffer.from([0xff, 0xd8]); // JPEG start-of-image
const EOI = Buffer.from([0xff, 0xd9]); // JPEG end-of-image
const MAX_ACC = 8 * 1024 * 1024;       // drop a runaway partial buffer (bad stream)

function log(m: string) { console.log(`[rtsp] ${m}`); }

/** Absolute path to the bundled ffmpeg binary. In a packaged asar build the
 *  module path points inside app.asar, but the binary is asarUnpack'd (see
 *  package.json build.asarUnpack), so redirect to app.asar.unpacked. */
function ffmpegPath(): string | null {
  const p = ffmpegStatic as unknown as string | null;
  if (!p) return null;
  return p.includes('app.asar') ? p.replace('app.asar', 'app.asar.unpacked') : p;
}

/** Which cameras drive a Live-display tile. RTSP needs only the IP — no
 *  credentials — so any enabled camera with a host gets an ffmpeg feed. Matches
 *  the renderer's StreamTile predicate. */
function usesRtsp(c: LprCamera): boolean {
  return !!(c.enabled && c.host);
}

function rtspUrl(c: LprCamera): string {
  return `rtsp://${c.host}:${RTSP_PORT}${RTSP_PATH}`;
}

/** Config signature — restart the feed when the host changes. */
function camKey(c: LprCamera): string {
  return `${c.host}|${RTSP_PORT}|${RTSP_PATH}`;
}

interface Feed {
  proc: ChildProcessWithoutNullStreams | null;
  acc: Buffer;
  key: string;
  stopped: boolean;
  restartTimer: NodeJS.Timeout | null;
  gotFrame: boolean;
  cachedAt: number;
  stderrTail: string;
}
const feeds = new Map<number, Feed>();

/** Split accumulated stdout into whole JPEGs (SOI…EOI), publish each, and keep
 *  any trailing partial frame for the next chunk. */
function drain(cid: number, f: Feed) {
  let start = f.acc.indexOf(SOI);
  while (start >= 0) {
    const end = f.acc.indexOf(EOI, start + 2);
    if (end < 0) break; // frame not complete yet
    const jpeg = Buffer.from(f.acc.subarray(start, end + 2)); // copy before we slice acc
    publish(cid, f, jpeg);
    f.acc = f.acc.subarray(end + 2);
    start = f.acc.indexOf(SOI);
  }
  // Drop leading garbage before the next SOI so acc doesn't grow unbounded, and
  // hard-reset if a broken stream never yields an EOI.
  if (start > 0) f.acc = f.acc.subarray(start);
  if (f.acc.length > MAX_ACC) f.acc = Buffer.alloc(0);
}

function publish(cid: number, f: Feed, jpeg: Buffer) {
  if (f.stopped) return;
  if (!f.gotFrame) { f.gotFrame = true; log(`cam ${cid} first frame (${jpeg.length} bytes) — RTSP video flowing`); }
  // Fan out to every Live-display viewer of this camera.
  pushJpegFrame(cid, jpeg);
  // Throttled copy into the latest-frame cache (records + non-streaming tiles).
  const now = Date.now();
  if (now - f.cachedAt > CACHE_THROTTLE_MS) {
    f.cachedAt = now;
    setLatestFrame(cid, { base64: jpeg.toString('base64'), contentType: 'image/jpeg', at: new Date().toISOString() });
  }
}

function startFeed(c: LprCamera) {
  const bin = ffmpegPath();
  if (!bin) { log('ffmpeg binary unavailable — RTSP live video disabled'); return; }
  const cid = c.id;
  const url = rtspUrl(c);
  const f: Feed = { proc: null, acc: Buffer.alloc(0), key: camKey(c), stopped: false, restartTimer: null, gotFrame: false, cachedAt: 0, stderrTail: '' };
  feeds.set(cid, f);

  const spawnOnce = () => {
    if (f.stopped) return;
    const args = [
      '-nostdin', '-loglevel', 'error',
      '-rtsp_transport', 'tcp',          // TCP is reliable on a LAN; UDP drops frames
      '-fflags', 'nobuffer', '-flags', 'low_delay',
      '-i', url,
      '-an',                             // no audio
      '-f', 'image2pipe', '-vcodec', 'mjpeg',
      '-q:v', String(JPEG_Q), '-r', String(FPS),
      'pipe:1',
    ];
    log(`cam ${cid} starting ffmpeg → ${url}`);
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(bin, args, { windowsHide: true });
    } catch (e: any) {
      log(`cam ${cid} ffmpeg spawn failed: ${e?.message ?? e}`);
      scheduleRestart();
      return;
    }
    f.proc = proc;

    proc.stdout.on('data', (chunk: Buffer) => {
      if (f.stopped) return;
      f.acc = f.acc.length ? Buffer.concat([f.acc, chunk]) : chunk;
      try { drain(cid, f); } catch { /* never let a parse hiccup kill the feed */ }
    });
    // Keep only the tail of stderr so a failure logs a useful reason without
    // spamming (ffmpeg is chatty on connect problems).
    proc.stderr.on('data', (b: Buffer) => { f.stderrTail = (f.stderrTail + b.toString()).slice(-500); });
    proc.on('error', (e) => { log(`cam ${cid} ffmpeg error: ${e?.message ?? e}`); });
    proc.on('close', (code) => {
      f.proc = null;
      if (f.stopped) return;
      const why = f.stderrTail.trim().split('\n').pop() ?? '';
      log(`cam ${cid} ffmpeg exited (code=${code})${why ? ` — ${why}` : ''} — restarting in ${RESTART_DELAY_MS}ms`);
      f.gotFrame = false;
      scheduleRestart();
    });
  };

  const scheduleRestart = () => {
    if (f.stopped) return;
    f.restartTimer = setTimeout(spawnOnce, RESTART_DELAY_MS);
  };

  spawnOnce();
}

function stopFeed(cid: number) {
  const f = feeds.get(cid);
  if (!f) return;
  feeds.delete(cid);
  f.stopped = true;
  if (f.restartTimer) clearTimeout(f.restartTimer);
  if (f.proc) { try { f.proc.kill('SIGKILL'); } catch { /* ignore */ } }
}

/** Start/stop feeds to match the cameras that should drive a Live-display tile.
 *  Call on boot and whenever cameras are saved/deleted. */
export function resync() {
  const wanted = listCameras().filter(usesRtsp);
  for (const [id, f] of [...feeds]) {
    const c = wanted.find((x) => x.id === id);
    if (!c || camKey(c) !== f.key) stopFeed(id);
  }
  for (const c of wanted) {
    if (!feeds.has(c.id)) startFeed(c);
  }
}

export function startRtspGrabbers() { resync(); }

export function stopRtspGrabbers() {
  for (const id of [...feeds.keys()]) stopFeed(id);
}

/**
 * Hard restart — kill every ffmpeg and spawn a fresh one. Backs the Live
 * display's "Refresh cameras" button.
 *
 * resync() deliberately LEAVES a running feed alone (it only starts what's
 * missing and stops what's unwanted or reconfigured), which is right after a
 * camera save but useless for the case this exists for: the app started before
 * the camera was on the network, so ffmpeg is sitting in its own connect/retry
 * loop against a host that wasn't there. Its `key` still matches, so resync()
 * considers it healthy and skips it — and remounting the tile in the renderer
 * only reopens the browser's MJPEG connection, which has nothing to deliver
 * while the process behind it is stuck. Killing the process is the only thing
 * that forces an immediate reconnect.
 *
 * Returns how many feeds are running afterwards, so the caller can report it.
 */
export function restartFeeds(): number {
  stopRtspGrabbers();
  log('restarting all RTSP feeds (manual refresh)');
  resync();
  return feeds.size;
}
