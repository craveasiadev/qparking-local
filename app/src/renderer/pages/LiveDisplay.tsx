import { useEffect, useRef, useState } from 'react';
import { RefreshCw, CameraOff, DoorOpen, CreditCard, Loader2 } from 'lucide-react';
import type { LprCamera, ParkingLane } from '@shared/types';

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
  const [lanes, setLanes] = useState<ParkingLane[]>([]);
  const [loading, setLoading] = useState(false);
  const [port, setPort] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0); // bumped on refresh to remount tiles → reconnect feeds

  async function refresh() {
    setLoading(true);
    try {
      // Reload the camera list AND the stream port, then bump the nonce so every
      // tile remounts. Remounting reopens each MJPEG connection, so Refresh
      // genuinely reconnects a frozen/dropped feed — not just re-reads the list.
      // Lanes come along so each tile's operator actions know the wired terminal.
      const [cams, lns, diag] = await Promise.all([
        window.bridge.listCameras(),
        window.bridge.listLanes(),
        window.bridge.diagnoseLpr().catch(() => null),
      ]);
      setCameras(cams);
      setLanes(lns);
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
          {cameras.map((c) => (
            <LiveTile key={`${c.id}:${nonce}`} cam={c} port={port}
              lane={lanes.find((l) => l.id === c.laneId) ?? null} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Pick the delivery: a credentialed VZ camera streams MJPEG from the local
 *  server; everything else uses the polled-frame fallback. */
function LiveTile({ cam, port, lane }: { cam: LprCamera; port: number | null; lane: ParkingLane | null }) {
  const streams = !!(cam.enabled && cam.host && cam.deviceUser && cam.devicePassword);
  if (streams && port) return <StreamTile cam={cam} port={port} lane={lane} />;
  return <PollTile cam={cam} lane={lane} />;
}

/** Continuous MJPEG stream via <img>. The browser holds one connection open and
 *  swaps frames as they arrive — no polling, no base64, smooth. On error we
 *  reconnect with a cache-busting query so a blipped feed recovers on its own. */
function StreamTile({ cam, port, lane }: { cam: LprCamera; port: number; lane: ParkingLane | null }) {
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
      <TileFooter cam={cam} lane={lane} />
    </div>
  );
}

/** Fallback: poll the main-process frame cache (HTTP snapshot URL, or the last
 *  frame the SDK/webhook pushed) every second — for cameras without device
 *  credentials. */
function PollTile({ cam, lane }: { cam: LprCamera; lane: ParkingLane | null }) {
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
      <TileFooter cam={cam} lane={lane} />
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

function TileFooter({ cam, lane }: { cam: LprCamera; lane: ParkingLane | null }) {
  const dirCls = cam.direction === 'entry' ? 'text-emerald-300'
    : cam.direction === 'exit' ? 'text-blue-300' : 'text-amber-300';
  return (
    <>
      <div className="px-3 py-2 flex items-center justify-between bg-gray-900 text-white">
        <span className="font-semibold text-sm truncate">{cam.name}</span>
        <span className={`text-[10px] font-bold uppercase tracking-wider ${dirCls}`}>
          {cam.direction}{!cam.enabled && ' · off'}
        </span>
      </div>
      <LaneActions cam={cam} lane={lane} />
    </>
  );
}

/**
 * Operator controls under each live feed. Real-world manual interventions only
 * (no test/simulate helpers):
 *   - Open barrier — every lane. Raises this lane's gate.
 *   - Retrigger payment — exit/dual lanes with a wired terminal. Operator reads
 *     the plate off the feed and types it; we re-run that car's exit payment.
 */
function LaneActions({ cam, lane }: { cam: LprCamera; lane: ParkingLane | null }) {
  const [busy, setBusy] = useState<null | 'open' | 'pay'>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [plate, setPlate] = useState('');

  // Retrigger is an EXIT action — show it on exit/dual tiles. We don't gate on
  // a wired terminal: the fee may be collected via the TNG controller (no
  // terminal), and the retrigger-by-plate resolves the car's own session, so
  // the backend validates payment capability and returns a clear error if the
  // lane truly can't charge.
  const canRetrigger = cam.direction === 'exit' || cam.direction === 'dual';

  async function openBarrier() {
    setBusy('open'); setResult(null);
    try {
      const r = await window.bridge.manualOpenGate({ cameraId: cam.id, laneId: lane?.id ?? null });
      setResult({ ok: r.ok, text: r.note ?? (r.ok ? 'Barrier opened' : 'Failed to open') });
    } catch (e: any) {
      setResult({ ok: false, text: e?.message ?? String(e) });
    } finally { setBusy(null); }
  }

  async function retriggerPayment(e: React.FormEvent) {
    e.preventDefault();
    const p = plate.trim();
    if (!p) return;
    setBusy('pay'); setResult(null);
    try {
      const r = await window.bridge.retriggerSessionPaymentByPlate(p, lane?.id ?? null);
      setResult({ ok: r.ok, text: r.ok ? `Payment retriggered for ${p.toUpperCase()}` : (r.error ?? 'Failed') });
      if (r.ok) setPlate('');
    } catch (err: any) {
      setResult({ ok: false, text: err?.message ?? String(err) });
    } finally { setBusy(null); }
  }

  return (
    <div className="bg-gray-900 border-t border-white/10 px-3 py-2 space-y-2">
      <div className="flex flex-wrap gap-2">
        <button onClick={openBarrier} disabled={busy !== null}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-white/10 hover:bg-white/20 text-white text-[11px] font-bold uppercase tracking-wide disabled:opacity-40">
          {busy === 'open' ? <Loader2 size={12} className="animate-spin" /> : <DoorOpen size={12} />} Open barrier
        </button>
      </div>

      {canRetrigger && (
        <form onSubmit={retriggerPayment} className="flex gap-2">
          <input value={plate} onChange={(e) => setPlate(e.target.value)}
            placeholder="Plate to charge" spellCheck={false}
            className="flex-1 min-w-0 h-8 px-2 rounded-lg bg-black/40 border border-white/10 text-white text-xs font-mono uppercase placeholder:normal-case placeholder:text-white/30 outline-none focus:border-white/40" />
          <button type="submit" disabled={busy !== null || !plate.trim()}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-bold uppercase tracking-wide disabled:opacity-40 shrink-0">
            {busy === 'pay' ? <Loader2 size={12} className="animate-spin" /> : <CreditCard size={12} />} Retrigger payment
          </button>
        </form>
      )}

      {result && (
        <div className={`rounded-md px-2 py-1 text-[11px] ${result.ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'}`}>
          {result.text}
        </div>
      )}
    </div>
  );
}
