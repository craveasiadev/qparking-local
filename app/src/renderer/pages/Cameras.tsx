import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Camera as CamIcon, Zap, ZapOff, X, Copy, Check, Activity, RefreshCw, Eye, PlayCircle, Loader2 } from 'lucide-react';
import type { LprCamera, ParkingLane, LprIngestMode } from '@shared/types';
import { useAsyncAction } from '../hooks/useAsyncAction';

const EMPTY: Omit<LprCamera, 'id'|'createdAt'|'updatedAt'> = {
  name: '', laneId: null, direction: 'entry', ingestMode: 'webhook',
  host: '', snapshotUrl: '',
  webhookSecret: '', pollUrl: null, pollIntervalSeconds: null, enabled: true,
};

export function Cameras() {
  const [list, setList] = useState<LprCamera[]>([]);
  const [lanes, setLanes] = useState<ParkingLane[]>([]);
  const [editing, setEditing] = useState<Partial<LprCamera> | null>(null);
  const [diag, setDiag] = useState<{ port: number; addresses: string[] } | null>(null);
  const [simPlate, setSimPlate] = useState<Record<number, string>>({});
  const [simBusy, setSimBusy] = useState<Record<number, boolean>>({});

  async function refresh() {
    setList(await window.bridge.listCameras());
    setLanes(await window.bridge.listLanes());
    setDiag(await window.bridge.diagnoseLpr() as any);
  }
  useEffect(() => { void refresh(); }, []);

  const [save, saving] = useAsyncAction(async () => {
    if (!editing?.name) { alert('Name is required.'); return; }
    await window.bridge.saveCamera(editing as any);
    setEditing(null);
    await refresh();
  });

  const [runSim, simRunningSingle] = useAsyncAction(async (cameraId: number, plate: string) => {
    await window.bridge.simulatePlate(cameraId, plate);
  });

  const [runDelete, deleting] = useAsyncAction(async (id: number) => {
    if (!confirm('Delete this camera?')) return;
    await window.bridge.deleteCamera(id);
    await refresh();
  });

  return (
    <div className="p-5 sm:p-8 max-w-5xl mx-auto">
      <header className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">LPR cameras</h1>
          <p className="text-sm text-gray-500 mt-1">Cameras POST plate detections to this server's webhook URL.</p>
        </div>
        <button onClick={() => setEditing({ ...EMPTY })} className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide">
          <Plus size={14} /> Add camera
        </button>
      </header>

      {diag && (
        <div className="mb-4 rounded-xl border border-gray-200 bg-white p-4">
          <div className="text-[11px] font-semibold uppercase tracking-widest text-gray-500">Webhook endpoint</div>
          <p className="mt-1 text-sm text-gray-700">Point your cameras at one of these URLs (use the IP that matches the camera's LAN):</p>
          <ul className="mt-2 space-y-1 font-mono text-xs">
            {diag.addresses.map((ip) => (
              <li key={ip} className="flex items-center justify-between gap-2 bg-gray-50 rounded-md px-3 py-2">
                <code>POST http://{ip}:{diag.port}/lpr/event</code>
                <CopyButton text={`http://${ip}:${diag.port}/lpr/event`} />
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3">
        {list.map((c) => {
          const lane = lanes.find((l) => l.id === c.laneId);
          return (
            <div key={c.id} className="rounded-xl border border-gray-200 bg-white overflow-hidden">
              <div className="flex flex-wrap items-start justify-between gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2"><CamIcon size={16} className="text-gray-400" /><h3 className="font-semibold">{c.name}</h3></div>
                  <div className="mt-1 text-xs text-gray-500 font-mono break-all">
                    {c.direction} · {c.ingestMode}
                    {c.host && <> · {c.host}</>}
                    {lane ? ` · lane: ${lane.name}` : ' · no lane assigned'}
                    {!c.enabled && ' · DISABLED'}
                  </div>
                  {c.webhookSecret && <div className="mt-1 text-[11px] text-gray-400">webhook secret: <span className="font-mono">{c.webhookSecret.slice(0, 6)}…</span></div>}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <input
                    placeholder="VMM1234"
                    value={simPlate[c.id] ?? ''}
                    onChange={(e) => setSimPlate({ ...simPlate, [c.id]: e.target.value })}
                    className="h-9 w-32 px-2 rounded-lg border border-gray-200 text-xs font-mono"
                  />
                  <button
                    onClick={() => simPlate[c.id] && runSim(c.id, simPlate[c.id])}
                    disabled={simRunningSingle || !simPlate[c.id]}
                    title="Fire ONE plate event (entry first time, exit if a session is already open)"
                    className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50">
                    {simRunningSingle ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />}
                    {simRunningSingle ? 'Sending…' : 'Simulate'}
                  </button>
                  <button
                    onClick={async () => {
                      const plate = simPlate[c.id];
                      if (!plate) return;
                      setSimBusy((b) => ({ ...b, [c.id]: true }));
                      try {
                        // Full flow: entry → 3s hold → exit. Same camera fires
                        // both halves, so the camera should be direction=dual
                        // (otherwise only the matching half hits the flow).
                        await window.bridge.simulateFullFlow(c.id, plate, 3000);
                      } finally {
                        setSimBusy((b) => ({ ...b, [c.id]: false }));
                      }
                    }}
                    disabled={!simPlate[c.id] || simBusy[c.id]}
                    title="Run full entry → 3s wait → exit flow. Watch Sessions tab + gate window."
                    className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50">
                    {simBusy[c.id] ? <ZapOff size={13} className="animate-pulse" /> : <PlayCircle size={13} />}
                    {simBusy[c.id] ? 'Running…' : 'Demo flow'}
                  </button>
                  <button onClick={() => setEditing(c)} className="text-xs font-bold uppercase tracking-wide text-gray-700 hover:text-gray-900 px-2">Edit</button>
                  <button onClick={() => runDelete(c.id)} disabled={deleting}
                    className="w-9 h-9 rounded-lg text-red-600 hover:bg-red-50 inline-flex items-center justify-center disabled:opacity-40">
                    {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                  </button>
                </div>
              </div>
              {/* Live preview pane — only renders if snapshotUrl is set */}
              {c.snapshotUrl && <CameraPreview cam={c} />}
            </div>
          );
        })}
        {list.length === 0 && (
          <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-sm text-gray-500">
            No cameras yet.
          </div>
        )}
      </div>

      {editing && <CameraForm lanes={lanes} value={editing} onChange={setEditing} onCancel={() => setEditing(null)} onSave={save} saving={saving} />}
    </div>
  );
}

/**
 * Auto-refreshing live snapshot pane. Fetches the camera's JPEG every
 * REFRESH_MS via the main process (which has direct LAN access), decodes
 * the base64 in the renderer, and renders it as a data: URL. Cheap because
 * IP cameras' snapshot endpoints return well under 100KB JPEGs.
 */
function CameraPreview({ cam }: { cam: LprCamera }) {
  const REFRESH_MS = 2_000;
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    let timer: number | null = null;

    async function tick() {
      const r = await window.bridge.fetchCameraSnapshot(cam.id);
      if (!aliveRef.current) return;
      if (r.ok && r.base64) {
        setSrc(`data:${r.contentType ?? 'image/jpeg'};base64,${r.base64}`);
        setError(null);
        setFetchedAt(r.fetchedAt ?? new Date().toISOString());
      } else {
        setError(r.error ?? `status ${r.status}`);
      }
      timer = window.setTimeout(tick, REFRESH_MS);
    }
    void tick();
    return () => { aliveRef.current = false; if (timer) clearTimeout(timer); };
  }, [cam.id]);

  return (
    <div className="border-t border-gray-100 bg-gray-950 relative">
      {src ? (
        <img src={src} alt={`${cam.name} live`} className="w-full max-h-72 object-contain bg-black" />
      ) : (
        <div className="aspect-video flex items-center justify-center text-white/50 text-sm">
          {error ? `× ${error}` : 'loading snapshot…'}
        </div>
      )}
      <div className="absolute top-2 left-2 inline-flex items-center gap-1.5 bg-black/60 text-white text-[10px] uppercase tracking-widest font-bold px-2 py-1 rounded">
        <span className={`w-1.5 h-1.5 rounded-full ${error ? 'bg-red-500' : 'bg-emerald-500 animate-pulse'}`} />
        LIVE · {cam.name}
      </div>
      {fetchedAt && !error && (
        <div className="absolute top-2 right-2 text-[10px] text-white/60 font-mono bg-black/60 px-2 py-1 rounded">
          {new Date(fetchedAt).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}

function CameraForm({ value, onChange, onCancel, onSave, lanes, saving }:
  { value: Partial<LprCamera>; onChange: (v: Partial<LprCamera>) => void; onCancel: () => void; onSave: () => void; lanes: ParkingLane[]; saving: boolean }) {
  const set = (k: keyof LprCamera, v: any) => onChange({ ...value, [k]: v });
  const generateSecret = () => set('webhookSecret', Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
  const [pingResult, setPingResult] = useState<string | null>(null);

  async function testConnection() {
    if (!value.id) { setPingResult('Save the camera first, then test.'); return; }
    setPingResult('Pinging…');
    const r = await window.bridge.pingCamera(value.id);
    setPingResult(r.ok
      ? `✓ Reachable · status ${r.status} · ${r.latencyMs}ms`
      : `✗ ${r.error ?? `status ${r.status}`} · ${r.latencyMs ?? '—'}ms`);
  }
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-xl bg-white rounded-2xl shadow-2xl overflow-hidden">
        <header className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-base font-bold">{value.id ? 'Edit' : 'Add'} camera</h2>
          <button onClick={onCancel} className="w-9 h-9 rounded-lg hover:bg-gray-100 inline-flex items-center justify-center text-gray-500"><X size={18} /></button>
        </header>
        <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Display name"><input className="input" value={value.name ?? ''} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="Lane">
            <select className="input" value={value.laneId ?? ''} onChange={(e) => set('laneId', e.target.value ? Number(e.target.value) : null)}>
              <option value="">— none —</option>
              {lanes.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.direction})</option>)}
            </select>
          </Field>
          <Field label="Direction">
            <select className="input" value={value.direction ?? 'entry'} onChange={(e) => set('direction', e.target.value)}>
              <option value="entry">Entry</option><option value="exit">Exit</option><option value="dual">Dual</option>
            </select>
          </Field>
          <Field label="Ingest mode">
            <select className="input" value={value.ingestMode ?? 'webhook'} onChange={(e) => set('ingestMode', e.target.value as LprIngestMode)}>
              <option value="webhook">Webhook (camera POSTs to us)</option>
              <option value="poll">Poll (we pull on a timer)</option>
            </select>
          </Field>
          {/* LAN-side wiring — needed for ping + live preview. Both the local
              app and the user are on the same LAN as the camera at the branch. */}
          <Field label="Camera host / LAN IP">
            <input className="input font-mono" value={value.host ?? ''} onChange={(e) => set('host', e.target.value)} placeholder="192.168.1.50" />
          </Field>
          <Field label="Snapshot URL (live preview)">
            <input className="input font-mono text-xs" value={value.snapshotUrl ?? ''} onChange={(e) => set('snapshotUrl', e.target.value)} placeholder="http://192.168.1.50/snapshot.jpg" />
          </Field>
          <div className="sm:col-span-2">
            <button type="button" onClick={testConnection}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-gray-200 hover:border-gray-900 text-xs font-bold uppercase tracking-wide text-gray-700">
              <Activity size={13} /> Test connection
            </button>
            {pingResult && (
              <div className={`mt-2 rounded-md px-2 py-1.5 text-[11px] font-mono ${
                pingResult.startsWith('✓') ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                : pingResult.startsWith('×') || pingResult.startsWith('✗') ? 'bg-red-50 text-red-700 border border-red-200'
                : 'bg-gray-100 text-gray-700'
              }`}>{pingResult}</div>
            )}
          </div>
          {value.ingestMode === 'webhook' && (
            <Field label="Webhook secret">
              <div className="flex gap-2">
                <input className="input font-mono text-xs" value={value.webhookSecret ?? ''} onChange={(e) => set('webhookSecret', e.target.value)} />
                <button onClick={generateSecret} className="text-[11px] uppercase tracking-wide font-bold text-gray-600 px-2 hover:text-gray-900">Generate</button>
              </div>
            </Field>
          )}
          {value.ingestMode === 'poll' && (
            <>
              <Field label="Poll URL"><input className="input font-mono text-xs" value={value.pollUrl ?? ''} onChange={(e) => set('pollUrl', e.target.value)} placeholder="http://192.168.1.50/lpr/latest" /></Field>
              <Field label="Interval (s)"><input type="number" className="input" value={value.pollIntervalSeconds ?? 5} onChange={(e) => set('pollIntervalSeconds', Number(e.target.value))} /></Field>
            </>
          )}
          <Field label="Enabled">
            <label className="inline-flex items-center gap-2 mt-2 text-sm"><input type="checkbox" checked={value.enabled ?? true} onChange={(e) => set('enabled', e.target.checked)} /> accept events</label>
          </Field>
        </div>
        <footer className="px-5 py-3 border-t border-gray-200 flex items-center justify-end gap-2">
          <button onClick={onCancel} className="text-xs font-bold uppercase tracking-wide text-gray-600 hover:text-gray-900 px-3">Cancel</button>
          <button onClick={onSave} disabled={saving}
            className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50">
            {saving ? <Loader2 size={13} className="animate-spin" /> : null}
            {saving ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
      <style>{`.input { height: 40px; padding: 0 0.75rem; border: 1px solid #d1d5db; border-radius: 0.5rem; outline: none; font-size: 14px; width: 100%; } .input:focus { border-color: #111827; }`}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-semibold uppercase tracking-wide text-gray-600 mb-1">{label}</label>
      {children}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
      className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide font-bold text-gray-500 hover:text-gray-900">
      {copied ? <Check size={11} /> : <Copy size={11} />} {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
