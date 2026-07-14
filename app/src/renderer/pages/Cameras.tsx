import { useEffect, useState } from 'react';
import { Plus, Trash2, Camera as CamIcon, X, Copy, Check, Activity, Loader2, Webhook, MapPin, KeyRound, ChevronDown, Search } from 'lucide-react';
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
  const [webhookOpen, setWebhookOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [dirFilter, setDirFilter] = useState<'all' | 'entry' | 'exit' | 'dual'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'disabled'>('all');

  const q = search.trim().toLowerCase();
  const filterActive = q !== '' || dirFilter !== 'all' || statusFilter !== 'all';
  const filtered = list.filter((c) => {
    if (dirFilter !== 'all' && c.direction !== dirFilter) return false;
    if (statusFilter === 'enabled' && !c.enabled) return false;
    if (statusFilter === 'disabled' && c.enabled) return false;
    if (q) {
      const laneName = lanes.find((l) => l.id === c.laneId)?.name ?? '';
      const hay = `${c.name} ${c.host ?? ''} ${laneName} ${c.direction}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

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

  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [runDelete] = useAsyncAction(async (id: number) => {
    if (!(await confirm({ title: 'Delete camera', message: 'Delete this camera?', danger: true, confirmLabel: 'Delete' }))) return;
    setDeletingId(id);
    try {
      await window.bridge.deleteCamera(id);
      await refresh();
    } finally {
      setDeletingId(null);
    }
  });

  return (
    <div className="p-5 sm:p-8 max-w-7xl mx-auto">
      <header className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">LPR cameras</h1>
          <p className="text-sm text-gray-500 mt-1">Cameras POST plate detections to this server's webhook URL.</p>
          {list.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-medium text-gray-500">
              <span className="inline-flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> {list.filter((c) => c.enabled).length} enabled</span>
              <span className="inline-flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-gray-300" /> {list.length} total</span>
              {filterActive && <span className="text-gray-400">· showing {filtered.length}</span>}
            </div>
          )}
        </div>
        <button onClick={() => { setFormError(null); setEditing({ ...EMPTY }); }} className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide">
          <Plus size={14} /> Add camera
        </button>
      </header>

      {diag && (
        <div className="mb-4 rounded-xl border border-gray-200 bg-white overflow-hidden">
          <button
            onClick={() => setWebhookOpen((o) => !o)}
            aria-expanded={webhookOpen}
            className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-gray-50"
          >
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-gray-500">
              <Webhook size={12} className="text-gray-400" /> Webhook endpoint
            </span>
            <span className="inline-flex items-center gap-2 text-[11px] text-gray-400">
              <span className="font-mono">port {diag.port} · {diag.addresses.length} address{diag.addresses.length === 1 ? '' : 'es'}</span>
              <ChevronDown size={15} className={`transition-transform ${webhookOpen ? 'rotate-180' : ''}`} />
            </span>
          </button>
          {webhookOpen && (
            <div className="px-4 pb-4 border-t border-gray-100">
              <p className="mt-3 text-sm text-gray-700">Point your cameras at one of these URLs (use the IP that matches the camera's LAN):</p>
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
        </div>
      )}

      {list.length > 0 && (
        <div className="mb-3 flex flex-col sm:flex-row sm:items-center gap-2">
          <div className="relative flex-1 sm:max-w-sm">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, IP, or lane…"
              className="w-full h-9 pl-8 pr-8 border border-gray-200 rounded-lg text-sm focus:border-gray-900 outline-none"
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700">
                <X size={13} />
              </button>
            )}
          </div>
          <select value={dirFilter} onChange={(e) => setDirFilter(e.target.value as any)}
            className="h-9 px-2 rounded-lg border border-gray-200 text-sm focus:border-gray-900 outline-none bg-white">
            <option value="all">All directions</option>
            <option value="entry">Entry</option>
            <option value="exit">Exit</option>
            <option value="dual">Dual</option>
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)}
            className="h-9 px-2 rounded-lg border border-gray-200 text-sm focus:border-gray-900 outline-none bg-white">
            <option value="all">All status</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
          {filterActive && (
            <button
              onClick={() => { setSearch(''); setDirFilter('all'); setStatusFilter('all'); }}
              className="h-9 px-3 text-xs font-bold uppercase tracking-wide text-gray-500 hover:text-gray-900 whitespace-nowrap"
            >
              Clear
            </button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3">
        {filtered.map((c) => (
          <CameraCard
            key={c.id}
            cam={c}
            lane={lanes.find((l) => l.id === c.laneId) ?? null}
            deleting={deletingId === c.id}
            onEdit={() => { setFormError(null); setEditing(c); }}
            onDelete={() => runDelete(c.id)}
          />
        ))}
        {list.length === 0 && (
          <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center">
            <CamIcon size={28} className="mx-auto text-gray-300" />
            <p className="mt-3 text-sm font-semibold text-gray-700">No cameras yet</p>
            <p className="mt-1 text-[13px] text-gray-500">Add a camera and point it at the webhook URL above to start receiving plate events.</p>
            <button onClick={() => { setFormError(null); setEditing({ ...EMPTY }); }} className="mt-4 inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide">
              <Plus size={13} /> Add camera
            </button>
          </div>
        )}
        {list.length > 0 && filtered.length === 0 && (
          <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-sm text-gray-500">
            <Search size={22} className="mx-auto text-gray-300" />
            <p className="mt-2">No cameras match the current filters.</p>
            <button
              onClick={() => { setSearch(''); setDirFilter('all'); setStatusFilter('all'); }}
              className="mt-3 text-[11px] font-bold uppercase tracking-wide text-gray-600 hover:text-gray-900"
            >
              Clear filters
            </button>
          </div>
        )}
      </div>

      {editing && <CameraForm value={editing} onChange={setEditing} onCancel={() => { setFormError(null); setEditing(null); }} onSave={save} saving={saving} error={formError} />}
      {confirmDialog}
    </div>
  );
}

/** One camera in the list — config at a glance (color-coded direction, host,
 *  lane, secret) plus an on-demand reachability test that shows a result banner
 *  without leaving the page. */
function CameraCard({ cam, lane, deleting, onEdit, onDelete }:
  { cam: LprCamera; lane: ParkingLane | null; deleting: boolean; onEdit: () => void; onDelete: () => void }) {
  const [test, setTest] = useState<{ state: 'idle' | 'pinging' | 'ok' | 'err'; text: string | null }>({ state: 'idle', text: null });
  const hasHost = !!(cam.host && cam.host.trim());

  async function runTest() {
    setTest({ state: 'pinging', text: 'Pinging…' });
    try {
      const r = await window.bridge.pingCamera(cam.id);
      setTest(r.ok
        ? { state: 'ok', text: `Reachable · ${r.latencyMs ?? '—'}ms${r.status ? ` · status ${r.status}` : ''}` }
        : { state: 'err', text: r.error ?? `status ${r.status ?? '—'}` });
    } catch (e: any) {
      setTest({ state: 'err', text: e?.message ?? 'failed' });
    }
  }

  return (
    <div className={`rounded-xl border bg-white overflow-hidden ${cam.enabled ? 'border-gray-200' : 'border-gray-200 opacity-70'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <CamIcon size={16} className="text-gray-400 flex-shrink-0" />
            <h3 className="font-semibold truncate">{cam.name}</h3>
            <DirectionBadge direction={cam.direction} />
            {!cam.enabled && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border bg-gray-100 text-gray-500 border-gray-200">disabled</span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Chip mono muted={!hasHost}>{hasHost ? cam.host : 'no IP set'}</Chip>
            <Chip icon={MapPin} muted={!lane}>{lane ? lane.name : 'no lane'}</Chip>
            {cam.webhookSecret && <Chip icon={KeyRound} mono>{cam.webhookSecret.slice(0, 6)}…</Chip>}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={runTest} disabled={!hasHost || test.state === 'pinging'}
            title={hasHost ? 'Ping this camera' : 'Set a host / IP first'}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-gray-200 hover:border-gray-900 text-xs font-bold uppercase tracking-wide text-gray-700 disabled:opacity-40">
            {test.state === 'pinging' ? <Loader2 size={13} className="animate-spin" /> : <Activity size={13} />} Test
          </button>
          <button onClick={onEdit} className="text-xs font-bold uppercase tracking-wide text-gray-700 hover:text-gray-900 px-2">Edit</button>
          <button onClick={onDelete} disabled={deleting}
            className="w-9 h-9 rounded-lg text-red-600 hover:bg-red-50 inline-flex items-center justify-center disabled:opacity-40">
            {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
          </button>
        </div>
      </div>
      {test.text && (
        <div className={`px-4 py-2 text-[11px] font-mono border-t ${
          test.state === 'ok' ? 'bg-emerald-50 text-emerald-800 border-emerald-100'
          : test.state === 'err' ? 'bg-red-50 text-red-700 border-red-100'
          : 'bg-gray-50 text-gray-600 border-gray-100'
        }`}>
          {test.state === 'ok' ? '✓ ' : test.state === 'err' ? '✗ ' : ''}{test.text}
        </div>
      )}
    </div>
  );
}

function DirectionBadge({ direction }: { direction: LprCamera['direction'] }) {
  const map: Record<LprCamera['direction'], string> = {
    entry: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    exit: 'bg-blue-50 text-blue-700 border-blue-200',
    dual: 'bg-amber-50 text-amber-700 border-amber-200',
  };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border ${map[direction]}`}>{direction}</span>;
}

function Chip({ children, icon: Icon, mono, muted }: { children: React.ReactNode; icon?: any; mono?: boolean; muted?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-gray-200 bg-gray-50 text-[11px] ${muted ? 'text-gray-400' : 'text-gray-600'} ${mono ? 'font-mono' : ''}`}>
      {Icon && <Icon size={11} className="text-gray-400 flex-shrink-0" />}
      {children}
    </span>
  );
}

function CameraForm({ value, onChange, onCancel, onSave, saving, error }:
  { value: Partial<LprCamera>; onChange: (v: Partial<LprCamera>) => void; onCancel: () => void; onSave: () => void; saving: boolean; error: string | null }) {
  const set = (k: keyof LprCamera, v: any) => onChange({ ...value, [k]: v });
  const generateSecret = () => set('webhookSecret', Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
  const [pingResult, setPingResult] = useState<string | null>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onCancel]);

  const [pinging, setPinging] = useState(false);
  async function testConnection() {
    const host = (value.host ?? '').trim();
    if (!host) { setPingResult('Enter a camera host / LAN IP first.'); return; }
    setPinging(true);
    setPingResult('Pinging…');
    // Probe the form values directly so this works before the camera is saved.
    const r = await window.bridge.pingCameraHost({ host, port: value.devicePort ?? 80 });
    setPingResult(r.ok
      ? `✓ Reachable · status ${r.status} · ${r.latencyMs}ms`
      : `✗ ${r.error ?? `status ${r.status}`} · ${r.latencyMs ?? '—'}ms`);
    setPinging(false);
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
          {/* Camera LAN IP — all that live video needs. The main process pulls
              rtsp://<host>:8557/h264 and transcodes it for the Live display. */}
          <Field label="Camera host / LAN IP">
            <input className="input font-mono" value={value.host ?? ''} onChange={(e) => set('host', e.target.value)} placeholder="192.168.1.50" />
          </Field>
          {/* Device login is NOT needed for video (RTSP is token-free). It's used
              only to open the camera's onboard IO relay for "Open barrier" — leave
              blank if the barrier isn't wired to this camera. */}
          <p className="sm:col-span-2 text-xs text-gray-500 mt-1">
            <strong>Barrier relay (optional)</strong> — only if the barrier is wired to this camera's IO output. Live video doesn't need these.
          </p>
          <Field label="Device username">
            <input className="input" value={value.deviceUser ?? ''} onChange={(e) => set('deviceUser', e.target.value)} placeholder="admin" />
          </Field>
          <Field label="Device password">
            <input type="password" className="input" value={value.devicePassword ?? ''} onChange={(e) => set('devicePassword', e.target.value)} placeholder="camera login password" />
          </Field>
          <Field label="Device port">
            <input type="number" className="input" value={value.devicePort ?? 80} onChange={(e) => set('devicePort', Number(e.target.value))} />
          </Field>
          <div className="sm:col-span-2">
            <button type="button" onClick={testConnection} disabled={pinging}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-gray-200 hover:border-gray-900 text-xs font-bold uppercase tracking-wide text-gray-700 disabled:opacity-50">
              {pinging ? <Loader2 size={13} className="animate-spin" /> : <Activity size={13} />} Test connection
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
