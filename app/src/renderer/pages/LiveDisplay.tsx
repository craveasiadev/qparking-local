import { useEffect, useRef, useState } from 'react';
import { RefreshCw, CameraOff } from 'lucide-react';
import type { LprCamera } from '@shared/types';

/**
 * Operations "video wall" — live video from every configured camera in a large
 * 3-column grid.
 *
 * VZ cameras with device credentials stream as MJPEG straight from the local
 * server: the main process grabs frames off the device via the native SDK and
 * fans them out at /live/<id>, and the browser renders that continuously in an
 * <img> — a smooth feed, not a 1 fps slideshow. Cameras with only an HTTP
 * snapshot URL (or webhook-only cameras) fall back to a ~1s polled frame.
 * Unreachable feeds surface the error so an operator can spot a dropped camera.
 */
export function LiveDisplay() {
  const [cameras, setCameras] = useState<LprCamera[]>([]);
  const [loading, setLoading] = useState(false);
  const [port, setPort] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0); // bumped on refresh to remount tiles → reconnect feeds

  async function refresh() {
    setLoading(true);
    try {
      // Reload the camera list AND the stream port, then bump the nonce so every
      // tile remounts. Remounting reopens each MJPEG connection, so Refresh
      // genuinely reconnects a frozen/dropped feed — not just re-reads the list.
      const [cams, diag] = await Promise.all([
        window.bridge.listCameras(),
        window.bridge.diagnoseLpr().catch(() => null),
      ]);
      setCameras(cams);
      if (diag?.port) setPort(diag.port);
      setNonce((n) => n + 1);
    } finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);

  return (
    <div className="p-5 sm:p-8 max-w-7xl mx-auto">
      <header className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Live display</h1>
          <p className="text-sm text-gray-500 mt-1">Live video streamed straight from each device. A camera needs its username / password set on the LPR cameras page to appear here.</p>
        </div>
        <button onClick={() => refresh()} disabled={loading}
          className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg border border-gray-200 hover:border-gray-900 text-xs font-bold uppercase tracking-wide text-gray-700 disabled:opacity-50">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh cameras
        </button>
      </header>

      {cameras.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 p-12 text-center text-sm text-gray-500">
          No cameras yet. Add them on the <strong>LPR cameras</strong> page.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {cameras.map((c) => <LiveTile key={`${c.id}:${nonce}`} cam={c} port={port} />)}
        </div>
      )}
    </div>
  );
}

/** Pick the delivery: a credentialed VZ camera streams MJPEG from the local
 *  server; everything else uses the polled-frame fallback. */
function LiveTile({ cam, port }: { cam: LprCamera; port: number | null }) {
  const streams = !!(cam.enabled && cam.host && cam.deviceUser && cam.devicePassword);
  if (streams && port) return <StreamTile cam={cam} port={port} />;
  return <PollTile cam={cam} />;
}

/** Continuous MJPEG stream via <img>. The browser holds one connection open and
 *  swaps frames as they arrive — no polling, no base64, smooth. On error we
 *  reconnect with a cache-busting query so a blipped feed recovers on its own. */
function StreamTile({ cam, port }: { cam: LprCamera; port: number }) {
  const [attempt, setAttempt] = useState(0);
  const [ok, setOk] = useState(false);
  const src = `http://127.0.0.1:${port}/live/${cam.id}?a=${attempt}`;

  return (
    <div className="rounded-xl border border-gray-200 bg-gray-950 overflow-hidden shadow-sm">
      <div className="relative aspect-video bg-black flex items-center justify-center">
        <img src={src} alt={`${cam.name} live`} className="w-full h-full object-contain"
          onLoad={() => setOk(true)}
          onError={() => { setOk(false); window.setTimeout(() => setAttempt((a) => a + 1), 2000); }} />
        <LiveBadge on={ok} />
      </div>
      <TileFooter cam={cam} />
    </div>
  );
}

/** Fallback: poll the main-process frame cache (HTTP snapshot URL, or the last
 *  frame the SDK/webhook pushed) every second — for cameras without device
 *  credentials. */
function PollTile({ cam }: { cam: LprCamera }) {
  const REFRESH_MS = 1_000;
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    let timer: number | null = null;
    async function tick() {
      let b64: string | undefined, ct: string | undefined, at: string | undefined, err: string | undefined;
      const f = await window.bridge.getCameraLatestFrame(cam.id);
      if (f?.base64) { b64 = f.base64; ct = f.contentType; at = f.at; }
      else err = 'waiting for first capture…';
      if (!aliveRef.current) return;
      if (b64) {
        setSrc(`data:${ct ?? 'image/jpeg'};base64,${b64}`);
        setError(null);
        setFetchedAt(at ?? new Date().toISOString());
      } else {
        setError(err ?? 'no image');
      }
      timer = window.setTimeout(tick, REFRESH_MS);
    }
    void tick();
    return () => { aliveRef.current = false; if (timer) clearTimeout(timer); };
  }, [cam.id]);

  return (
    <div className="rounded-xl border border-gray-200 bg-gray-950 overflow-hidden shadow-sm">
      <div className="relative aspect-video bg-black flex items-center justify-center">
        {src ? (
          <img src={src} alt={`${cam.name} live`} className="w-full h-full object-contain" />
        ) : (
          <div className="flex flex-col items-center gap-2 text-white/40 px-4 text-center">
            <CameraOff size={26} />
            <span className="text-xs">{error ?? 'loading…'}</span>
          </div>
        )}
        <LiveBadge on={!!src} />
        {fetchedAt && src && (
          <div className="absolute top-2 right-2 text-[10px] text-white/60 font-mono bg-black/60 px-2 py-1 rounded">
            {new Date(fetchedAt).toLocaleTimeString()}
          </div>
        )}
      </div>
      <TileFooter cam={cam} />
    </div>
  );
}

function LiveBadge({ on }: { on: boolean }) {
  return (
    <div className="absolute top-2 left-2 inline-flex items-center gap-1.5 bg-black/60 text-white text-[10px] uppercase tracking-widest font-bold px-2 py-1 rounded">
      <span className={`w-1.5 h-1.5 rounded-full ${on ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
      Live
    </div>
  );
}

function TileFooter({ cam }: { cam: LprCamera }) {
  const dirCls = cam.direction === 'entry' ? 'text-emerald-300'
    : cam.direction === 'exit' ? 'text-blue-300' : 'text-amber-300';
  return (
    <div className="px-3 py-2 flex items-center justify-between bg-gray-900 text-white">
      <span className="font-semibold text-sm truncate">{cam.name}</span>
      <span className={`text-[10px] font-bold uppercase tracking-wider ${dirCls}`}>
        {cam.direction}{!cam.enabled && ' · off'}
      </span>
    </div>
  );
}
