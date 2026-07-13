import { useEffect, useState } from 'react';
import { Plus, Trash2, Camera as CamIcon, X, Copy, Check, Activity, Loader2 } from 'lucide-react';
import type { LprCamera, ParkingLane } from '@shared/types';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { useConfirm } from '../hooks/useConfirm';

const EMPTY: Omit<LprCamera, 'id'|'createdAt'|'updatedAt'> = {
  name: '', laneId: null, direction: 'entry',
  host: '', deviceUser: '', devicePassword: '', devicePort: 80,
  webhookSecret: '', enabled: true,
};

export function Cameras() {
  const [list, setList] = useState<LprCamera[]>([]);
  const [lanes, setLanes] = useState<ParkingLane[]>([]);
  const [editing, setEditing] = useState<Partial<LprCamera> | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const [diag, setDiag] = useState<{ port: number; addresses: string[] } | null>(null);

  async function refresh() {
    setList(await window.bridge.listCameras());
    setLanes(await window.bridge.listLanes());
    setDiag(await window.bridge.diagnoseLpr() as any);
  }
  useEffect(() => { void refresh(); }, []);

  const [save, saving] = useAsyncAction(async () => {
    setFormError(null);
    if (!editing?.name) { setFormError('Name is required.'); return; }
    await window.bridge.saveCamera(editing as any);
    setEditing(null);
    await refresh();
  });

  const [runDelete, deleting] = useAsyncAction(async (id: number) => {
    if (!(await confirm({ title: 'Delete camera', message: 'Delete this camera?', danger: true, confirmLabel: 'Delete' }))) return;
    await window.bridge.deleteCamera(id);
    await refresh();
  });

  return (
    <div className="p-5 sm:p-8 max-w-7xl mx-auto">
      <header className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">LPR cameras</h1>
          <p className="text-sm text-gray-500 mt-1">Cameras POST plate detections to this server's webhook URL.</p>
        </div>
        <button onClick={() => { setFormError(null); setEditing({ ...EMPTY }); }} className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide">
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
                    {c.direction}
                    {c.host && <> · {c.host}</>}
                    {lane ? ` · lane: ${lane.name}` : ' · no lane assigned'}
                    {!c.enabled && ' · DISABLED'}
                  </div>
                  {c.webhookSecret && <div className="mt-1 text-[11px] text-gray-400">webhook secret: <span className="font-mono">{c.webhookSecret.slice(0, 6)}…</span></div>}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <button onClick={() => { setFormError(null); setEditing(c); }} className="text-xs font-bold uppercase tracking-wide text-gray-700 hover:text-gray-900 px-2">Edit</button>
                  <button onClick={() => runDelete(c.id)} disabled={deleting}
                    className="w-9 h-9 rounded-lg text-red-600 hover:bg-red-50 inline-flex items-center justify-center disabled:opacity-40">
                    {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
        {list.length === 0 && (
          <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-sm text-gray-500">
            No cameras yet.
          </div>
        )}
      </div>

      {editing && <CameraForm value={editing} onChange={setEditing} onCancel={() => { setFormError(null); setEditing(null); }} onSave={save} saving={saving} error={formError} />}
      {confirmDialog}
    </div>
  );
}

function CameraForm({ value, onChange, onCancel, onSave, saving, error }:
  { value: Partial<LprCamera>; onChange: (v: Partial<LprCamera>) => void; onCancel: () => void; onSave: () => void; saving: boolean; error: string | null }) {
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
          <p className="sm:col-span-2 text-xs text-gray-500">
            Assign this camera to a lane from the <strong>Lanes</strong> page — a lane owns the cameras that cover it.
          </p>
          <Field label="Display name"><input className="input" value={value.name ?? ''} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="Direction">
            <select className="input" value={value.direction ?? 'entry'} onChange={(e) => set('direction', e.target.value)}>
              <option value="entry">Entry</option><option value="exit">Exit</option><option value="dual">Dual</option>
            </select>
          </Field>
          {/* Camera LAN IP — used for the ping / test-connection check and as the
              SDK connect host for live video. */}
          <Field label="Camera host / LAN IP">
            <input className="input font-mono" value={value.host ?? ''} onChange={(e) => set('host', e.target.value)} placeholder="192.168.1.50" />
          </Field>
          {/* Device login for pulling live video off the camera via the VZ SDK.
              host (above) = camera IP; these feed VzLPRClient_OpenV2. */}
          <Field label="Device username (live video)">
            <input className="input" value={value.deviceUser ?? ''} onChange={(e) => set('deviceUser', e.target.value)} placeholder="admin" />
          </Field>
          <Field label="Device password">
            <input type="password" className="input" value={value.devicePassword ?? ''} onChange={(e) => set('devicePassword', e.target.value)} placeholder="camera login password" />
          </Field>
          <Field label="Device port">
            <input type="number" className="input" value={value.devicePort ?? 80} onChange={(e) => set('devicePort', Number(e.target.value))} />
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
          <Field label="Webhook secret">
            <div className="flex gap-2">
              <input className="input font-mono text-xs" value={value.webhookSecret ?? ''} onChange={(e) => set('webhookSecret', e.target.value)} />
              <button onClick={generateSecret} className="text-[11px] uppercase tracking-wide font-bold text-gray-600 px-2 hover:text-gray-900">Generate</button>
            </div>
          </Field>
          <Field label="Enabled">
            <label className="inline-flex items-center gap-2 mt-2 text-sm"><input type="checkbox" checked={value.enabled ?? true} onChange={(e) => set('enabled', e.target.checked)} /> accept events</label>
          </Field>
        </div>
        {error && (
          <div className="mx-5 mb-3 rounded-lg border border-red-200 bg-red-50 text-red-700 text-xs px-3 py-2">{error}</div>
        )}
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
