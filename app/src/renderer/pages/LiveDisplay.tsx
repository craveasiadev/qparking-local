import { useEffect, useRef, useState } from 'react';
import { RefreshCw, CameraOff, DoorOpen, CreditCard, Loader2, ScanLine } from 'lucide-react';
import type { LprCamera, ParkingLane } from '@shared/types';
import { fmtTimeSeconds } from '../lib/datetime';
import { InfoTip } from '../components/InfoTip';

/** A plate read pushed by a camera over the LPR webhook — overlaid live on the
 *  matching tile so the wall shows the recognition result, not just video. */
interface PlateEvent {
  cameraId: number;
  plate: string;
  direction: 'entry' | 'exit';
  timestamp: string;
}

/**
 * Operations "video wall" — live video from every configured camera in a large
 * 3-column grid.
 *
 * VZ cameras with device credentials stream as MJPEG straight from the local
 * server: the main process runs FFmpeg to pull the camera's RTSP/H.264 feed
 * (rtsp://<host>:8557/h264), transcodes it to JPEG frames, and fans them out at
 * /live/<id>, and the browser renders that continuously in an <img> — a smooth
 * feed, not a 1 fps slideshow. Cameras with only an HTTP snapshot URL (or
 * webhook-only cameras) fall back to a ~1s polled frame.
 * Unreachable feeds surface the error so an operator can spot a dropped camera.
 */
export function LiveDisplay() {
  const [cameras, setCameras] = useState<LprCamera[]>([]);
  const [lanes, setLanes] = useState<ParkingLane[]>([]);
  const [loading, setLoading] = useState(false);
  // Every listener serves /live/<id>, so a tile prefers its OWN camera's port
  // and falls back to any bound one — a port that lost its bind (another copy of
  // the app holding it) shouldn't blank the whole wall.
  const [ports, setPorts] = useState<number[]>([]);
  const [nonce, setNonce] = useState(0); // bumped on refresh to remount tiles → reconnect feeds
  // Latest plate read per camera — overlaid on the matching tile. Keyed by
  // cameraId so a fresh read for cam A never clobbers cam B's readout.
  const [plates, setPlates] = useState<Record<number, PlateEvent>>({});

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
      if (diag?.ports) setPorts(diag.ports);
      setNonce((n) => n + 1);
    } finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);

  // Overlay the LPR result live: every camera pushes its plate reads through the
  // webhook, which the main process fans out as 'plate-detected'. Keep only the
  // latest per camera.
  useEffect(() => {
    const off = window.bridge.onEvent('plate-detected', (p: any) => {
      const ev = p as PlateEvent;
      setPlates((cur) => ({ ...cur, [ev.cameraId]: ev }));
    });
    return () => off();
  }, []);

  const enabledCount = cameras.filter((c) => c.enabled).length;
  const streamableCount = cameras.filter((c) => c.enabled && c.host).length;

  return (
    <div className="p-5 sm:p-8 max-w-7xl mx-auto">
      <header className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            Live display
            <InfoTip title="About this page" kind="info">
              Live video from every gate camera, with the latest plate read
              shown on each tile. From here you can also open a barrier for a
              car manually. If a camera's tile is missing or black, check its
              IP address on the LPR cameras page.
            </InfoTip>
          </h1>
          <p className="text-sm text-gray-500 mt-1">Live video streamed straight from each device over RTSP. A camera needs its IP address set on the LPR cameras page to appear here.</p>
          {cameras.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-medium text-gray-500">
              <span className="inline-flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> {streamableCount} live-streaming</span>
              <span className="inline-flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-gray-300" /> {enabledCount}/{cameras.length} enabled</span>
            </div>
          )}
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
            <LiveTile key={`${c.id}:${nonce}`} cam={c} port={ports.includes(c.webhookPort) ? c.webhookPort : (ports[0] ?? null)}
              lane={lanes.find((l) => l.id === c.laneId) ?? null}
              lastPlate={plates[c.id]} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Pick the delivery: any enabled camera with a host (IP) streams the RTSP feed
 *  as MJPEG from the local server; everything else uses the polled-frame
 *  fallback (webhook-only cameras with no host). */
function LiveTile({ cam, port, lane, lastPlate }: { cam: LprCamera; port: number | null; lane: ParkingLane | null; lastPlate?: PlateEvent }) {
  const streams = !!(cam.enabled && cam.host);
  if (streams && port) return <StreamTile cam={cam} port={port} lane={lane} lastPlate={lastPlate} />;
  return <PollTile cam={cam} lane={lane} lastPlate={lastPlate} />;
}

/** Continuous MJPEG stream via <img>. The browser holds one connection open and
 *  swaps frames as they arrive — no polling, no base64, smooth. On error we
 *  reconnect with a cache-busting query so a blipped feed recovers on its own. */
function StreamTile({ cam, port, lane, lastPlate }: { cam: LprCamera; port: number; lane: ParkingLane | null; lastPlate?: PlateEvent }) {
  const [attempt, setAttempt] = useState(0);
  const [ok, setOk] = useState(false);
  const src = `http://127.0.0.1:${port}/live/${cam.id}?a=${attempt}`;

  return (
    <div className={`rounded-xl border border-gray-200 bg-gray-950 overflow-hidden shadow-sm ${cam.enabled ? '' : 'opacity-60'}`}>
      <div className="relative aspect-video bg-black flex items-center justify-center">
        <img src={src} alt={`${cam.name} live`} className="w-full h-full object-contain"
          onLoad={() => setOk(true)}
          onError={() => { setOk(false); window.setTimeout(() => setAttempt((a) => a + 1), 2000); }} />
        {!ok && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/40 pointer-events-none">
            <Loader2 size={22} className="animate-spin" />
            <span className="text-xs">{attempt === 0 ? 'Connecting…' : `Reconnecting… (attempt ${attempt})`}</span>
          </div>
        )}
        <LiveBadge on={ok} />
        <PlateOverlay plate={lastPlate} />
      </div>
      <TileFooter cam={cam} lane={lane} />
    </div>
  );
}

/** Fallback: poll the main-process frame cache (HTTP snapshot URL, or the last
 *  frame the SDK/webhook pushed) every second — for cameras without device
 *  credentials. */
function PollTile({ cam, lane, lastPlate }: { cam: LprCamera; lane: ParkingLane | null; lastPlate?: PlateEvent }) {
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
    <div className={`rounded-xl border border-gray-200 bg-gray-950 overflow-hidden shadow-sm ${cam.enabled ? '' : 'opacity-60'}`}>
      <div className="relative aspect-video bg-black flex items-center justify-center">
        {src ? (
          <img src={src} alt={`${cam.name} live`} className="w-full h-full object-contain" />
        ) : (
          <div className="flex flex-col items-center gap-2 text-white/40 px-4 text-center">
            <CameraOff size={26} />
            <span className="text-xs">{cam.enabled ? (error ?? 'loading…') : 'camera disabled'}</span>
          </div>
        )}
        <LiveBadge on={!!src} />
        {fetchedAt && src && (
          <div className="absolute top-2 right-2 text-[10px] text-white/60 font-mono bg-black/60 px-2 py-1 rounded">
            {fmtTimeSeconds(fetchedAt)}
          </div>
        )}
        <PlateOverlay plate={lastPlate} />
      </div>
      <TileFooter cam={cam} lane={lane} />
    </div>
  );
}

/** Live LPR readout overlaid on a feed — the plate the camera last recognised,
 *  its direction and time. Appears on a fresh read (emerald ring) and clears
 *  itself after 5s so a stale plate doesn't linger over the live video. */
function PlateOverlay({ plate }: { plate?: PlateEvent }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!plate) return;
    setVisible(true);
    const t = window.setTimeout(() => setVisible(false), 5000);
    return () => window.clearTimeout(t);
  }, [plate?.plate, plate?.timestamp]);

  if (!plate || !visible) return null;
  const dirCls = plate.direction === 'entry' ? 'text-emerald-300'
    : plate.direction === 'exit' ? 'text-blue-300' : 'text-amber-300';
  return (
    <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 bg-black/70 backdrop-blur-sm border border-emerald-400 ring-1 ring-emerald-400/60">
      <span className="inline-flex items-center gap-1.5 min-w-0">
        <ScanLine size={13} className="text-white/50 shrink-0" />
        <span className="font-mono font-bold text-white text-base tracking-wider truncate">{plate.plate}</span>
      </span>
      <span className="flex items-center gap-2 shrink-0">
        <span className={`text-[10px] font-bold uppercase tracking-wide ${dirCls}`}>{plate.direction}</span>
        <span className="text-[10px] text-white/60 font-mono">{fmtTimeSeconds(plate.timestamp)}</span>
      </span>
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
 *   - Retrigger payment — exit-facing cameras with a wired terminal. Operator reads
 *     the plate off the feed and types it; we re-run that car's exit payment.
 */
function LaneActions({ cam, lane }: { cam: LprCamera; lane: ParkingLane | null }) {
  const [busy, setBusy] = useState<null | 'open' | 'pay'>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [plate, setPlate] = useState('');

  // Auto-dismiss the action result banner a few seconds after it appears so it
  // doesn't linger on the wall. Any new action replaces `result`, which resets
  // the timer via the dependency.
  useEffect(() => {
    if (!result) return;
    const t = window.setTimeout(() => setResult(null), 4000);
    return () => window.clearTimeout(t);
  }, [result]);

  // Retrigger is an EXIT action — show it on exit tiles. We don't gate on
  // a wired terminal: the fee may be collected via the TNG controller (no
  // terminal), and the retrigger-by-plate resolves the car's own session, so
  // the backend validates payment capability and returns a clear error if the
  // lane truly can't charge.
  const canRetrigger = cam.direction === 'exit';

  async function openBarrier() {
    setBusy('open'); setResult(null);
    try {
      // No insertActivityLog here — the main process audits every manual open
      // inside openBarrier() itself, so the Cameras page's "test barrier" (the
      // same call) is covered too instead of silently opening a boom.
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
