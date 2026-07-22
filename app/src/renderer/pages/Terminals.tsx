import { useEffect, useState } from 'react';
import {
  Plus, Trash2, CreditCard, X, Activity, Loader2, Search, Radio, Copy, Check, MapPin,
  Wifi, XCircle, FlaskConical,
} from 'lucide-react';
import type { PaymentTerminal, ParkingLane } from '@shared/types';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { useConfirm } from '../hooks/useConfirm';
import { DeviceSyncButtons } from '../components/DeviceSyncButtons';

/**
 * Payment terminals = Alarmtech Touch'n'Go W4G devices. One device per exit
 * lane; a lane binds to its device on the Lanes page. On a paid exit the gate
 * fires a PayRequest at the device and settles from the PayResult callback that
 * the device POSTs back to this server's callback listener (shown below).
 */

const EMPTY: Omit<PaymentTerminal, 'id' | 'externalId' | 'createdAt' | 'updatedAt'> = {
  name: '', host: '', port: 80, timeoutSeconds: 30, enabled: true,
};

interface TngStatus {
  listening: boolean;
  listenPort: number;
  listenPorts: number[];
  listenAddresses: string[];
}

export function Terminals({ devMode = false }: { devMode?: boolean }) {
  const [list, setList] = useState<PaymentTerminal[]>([]);
  const [lanes, setLanes] = useState<ParkingLane[]>([]);
  const [status, setStatus] = useState<TngStatus | null>(null);
  const [callbackPorts, setCallbackPorts] = useState<string>('');
  const [enabled, setEnabled] = useState<boolean>(false);
  const [autoRetrigger, setAutoRetrigger] = useState<boolean>(true);
  const [editing, setEditing] = useState<Partial<PaymentTerminal> | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'disabled'>('all');

  async function refresh() {
    setList(await window.bridge.listTerminals());
    setLanes(await window.bridge.listLanes());
    try {
      const [st, settings] = await Promise.all([window.bridge.tngStatus(), window.bridge.getSettings()]);
      setStatus(st as any);
      setCallbackPorts(settings.tngCallbackPorts || String(settings.tngCallbackPort || 80));
      setEnabled(settings.tngEnabled);
      setAutoRetrigger(settings.tngAutoRetrigger ?? true);
    } catch { /* ignore */ }
  }
  useEffect(() => { void refresh(); }, []);
  // Poll the listener status so the operator sees it come up after enabling W4G.
  useEffect(() => {
    const t = setInterval(() => { window.bridge.tngStatus().then((s) => setStatus(s as any)).catch(() => null); }, 3000);
    return () => clearInterval(t);
  }, []);

  const [save, saving] = useAsyncAction(async () => {
    setFormError(null);
    if (!editing?.name) { setFormError('Name is required.'); return; }
    if (!editing?.host) { setFormError('Device IP is required.'); return; }
    await window.bridge.saveTerminal(editing as any);
    setEditing(null);
    await refresh();
  });

  const [runDelete] = useAsyncAction(async (id: number) => {
    if (!(await confirm({ title: 'Delete device', message: 'Delete this payment device? Any lane wired to it will need re-assigning.', danger: true, confirmLabel: 'Delete' }))) return;
    setDeletingId(id);
    try { await window.bridge.deleteTerminal(id); await refresh(); }
    finally { setDeletingId(null); }
  });

  // The enable switch + PayResult callback port drive the single shared listener
  // (one inbound server all devices POST to). Saving either restarts/stops the
  // listener via the main-process settings:save handler.
  async function persistListener(patch: { tngEnabled?: boolean; tngCallbackPort?: number; tngCallbackPorts?: string; tngAutoRetrigger?: boolean }) {
    await window.bridge.saveSettings(patch);
    try { setStatus(await window.bridge.tngStatus() as any); } catch { /* ignore */ }
  }
  const [saveCallbackPorts, savingCallbackPorts] = useAsyncAction(async () => {
    // Parse the comma list → valid, deduped ports (order kept), then normalise.
    const ports: number[] = [];
    for (const part of callbackPorts.split(',')) {
      const n = Number(part.trim());
      if (Number.isInteger(n) && n >= 1 && n <= 65535 && !ports.includes(n)) ports.push(n);
    }
    if (ports.length === 0) return;
    const normalized = ports.join(', ');
    setCallbackPorts(normalized);
    // Keep the legacy single field in sync (first port) for anything still reading it.
    await persistListener({ tngCallbackPorts: normalized, tngCallbackPort: ports[0] });
  });
  function toggleEnabled(v: boolean) { setEnabled(v); void persistListener({ tngEnabled: v }); }
  function toggleAutoRetrigger(v: boolean) { setAutoRetrigger(v); void persistListener({ tngAutoRetrigger: v }); }

  const q = search.trim().toLowerCase();
  const filterActive = q !== '' || statusFilter !== 'all';
  const filtered = list.filter((t) => {
    if (statusFilter === 'enabled' && !t.enabled) return false;
    if (statusFilter === 'disabled' && t.enabled) return false;
    if (q) {
      const laneNames = lanes.filter((l) => l.terminalId === t.id).map((l) => l.name).join(' ');
      if (!`${t.name} ${t.host} ${laneNames}`.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  return (
    <div className="p-5 sm:p-8 max-w-7xl mx-auto">
      <header className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Payment terminals</h1>
          <p className="text-sm text-gray-500 mt-1">Alarmtech Touch'n'Go W4G devices on the LAN. Wire one to each exit lane on the <strong>Lanes</strong> page.</p>
          {list.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-medium text-gray-500">
              <span className="inline-flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> {list.filter((t) => t.enabled).length} enabled</span>
              <span className="inline-flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-gray-300" /> {list.length} total</span>
              {filterActive && <span className="text-gray-400">· showing {filtered.length}</span>}
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <DeviceSyncButtons type="terminals" onDone={refresh} />
            <button onClick={() => { setFormError(null); setEditing({ ...EMPTY }); }}
              className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide">
              <Plus size={14} /> Add device
            </button>
          </div>
        </div>
      </header>

      <ListenerPanel status={status} enabled={enabled} onToggleEnabled={toggleEnabled}
        autoRetrigger={autoRetrigger} onToggleAutoRetrigger={toggleAutoRetrigger}
        callbackPorts={callbackPorts} onChangeCallbackPorts={setCallbackPorts}
        onSaveCallbackPorts={() => saveCallbackPorts()} savingCallbackPorts={savingCallbackPorts} />

      {devMode && list.length > 0 && <W4gTestPanel devices={list} />}

      {list.length > 0 && (
        <div className="mb-3 flex flex-col sm:flex-row sm:items-center gap-2">
          <div className="relative flex-1 sm:max-w-sm">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, IP, or lane…"
              className="w-full h-9 pl-8 pr-8 border border-gray-200 rounded-lg text-sm focus:border-gray-900 outline-none" />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700"><X size={13} /></button>
            )}
          </div>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)}
            className="h-9 px-2 rounded-lg border border-gray-200 text-sm focus:border-gray-900 outline-none bg-white">
            <option value="all">All status</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
          {filterActive && (
            <button onClick={() => { setSearch(''); setStatusFilter('all'); }}
              className="h-9 px-3 text-xs font-bold uppercase tracking-wide text-gray-500 hover:text-gray-900 whitespace-nowrap">Clear</button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3">
        {filtered.map((t) => (
          <DeviceCard
            key={t.id}
            device={t}
            lanes={lanes.filter((l) => l.terminalId === t.id)}
            deleting={deletingId === t.id}
            onEdit={() => { setFormError(null); setEditing(t); }}
            onDelete={() => runDelete(t.id)}
          />
        ))}
        {list.length === 0 && (
          <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center">
            <CreditCard size={28} className="mx-auto text-gray-300" />
            <p className="mt-3 text-sm font-semibold text-gray-700">No payment devices yet</p>
            <p className="mt-1 text-[13px] text-gray-500">Add an Alarmtech W4G device, then wire it to an exit lane on the Lanes page.</p>
            <button onClick={() => { setFormError(null); setEditing({ ...EMPTY }); }} className="mt-4 inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide">
              <Plus size={13} /> Add device
            </button>
          </div>
        )}
        {list.length > 0 && filtered.length === 0 && (
          <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-sm text-gray-500">
            <Search size={22} className="mx-auto text-gray-300" />
            <p className="mt-2">No devices match the current filters.</p>
            <button onClick={() => { setSearch(''); setStatusFilter('all'); }} className="mt-3 text-[11px] font-bold uppercase tracking-wide text-gray-600 hover:text-gray-900">Clear filters</button>
          </div>
        )}
      </div>

      {editing && <DeviceForm value={editing} onChange={setEditing} onCancel={() => { setFormError(null); setEditing(null); }} onSave={save} saving={saving} error={formError} />}
      {confirmDialog}
    </div>
  );
}

/** Global W4G callback listener — one inbound server ALL devices POST their
 *  PayResult to (matched by order id). The enable switch and callback port are
 *  shared, not per-device; changing them restarts/stops the listener. */
function ListenerPanel({ status, enabled, onToggleEnabled, autoRetrigger, onToggleAutoRetrigger, callbackPorts, onChangeCallbackPorts, onSaveCallbackPorts, savingCallbackPorts }: {
  status: TngStatus | null;
  enabled: boolean;
  onToggleEnabled: (v: boolean) => void;
  autoRetrigger: boolean;
  onToggleAutoRetrigger: (v: boolean) => void;
  callbackPorts: string;
  onChangeCallbackPorts: (v: string) => void;
  onSaveCallbackPorts: () => void;
  savingCallbackPorts: boolean;
}) {
  const listening = !!status?.listening;
  const ports = status?.listenPorts?.length ? status.listenPorts : (status?.listenPort ? [status.listenPort] : []);
  const addresses = status?.listenAddresses ?? [];
  return (
    <div className="mb-4 rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-center gap-2">
        <Radio size={15} className={listening ? 'text-emerald-600' : 'text-gray-400'} />
        <span className="text-[11px] font-semibold uppercase tracking-widest text-gray-500">W4G PayResult listener</span>
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border ${listening ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-gray-100 text-gray-500 border-gray-200'}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${listening ? 'bg-emerald-500 animate-pulse' : 'bg-gray-400'}`} /> {listening ? 'up' : 'down'}
        </span>
      </div>

      {/* Master enable switch — runs / stops the shared callback server. */}
      <label className="mt-3 flex items-start gap-3 p-3 rounded-lg border border-gray-200 hover:border-gray-300 cursor-pointer">
        <input type="checkbox" className="mt-0.5 w-4 h-4 accent-gray-900" checked={enabled} onChange={(e) => onToggleEnabled(e.target.checked)} />
        <div>
          <div className="text-sm font-semibold">Enable Touch'n'Go W4G payments</div>
          <div className="text-[11px] text-gray-500 mt-0.5">
            ON = the PayResult callback server runs and exits are charged on the lane's device. OFF = no listener; paid exits can't collect.
          </div>
        </div>
      </label>

      {/* Auto-retrigger — re-arm the terminal after a failed/timed-out tap so the
          driver can try again without staff intervention. Capped per session. */}
      <label className="mt-2 flex items-start gap-3 p-3 rounded-lg border border-gray-200 hover:border-gray-300 cursor-pointer">
        <input type="checkbox" className="mt-0.5 w-4 h-4 accent-gray-900" checked={autoRetrigger} onChange={(e) => onToggleAutoRetrigger(e.target.checked)} />
        <div>
          <div className="text-sm font-semibold">Auto-retrigger terminal after a failed / timed-out payment</div>
          <div className="text-[11px] text-gray-500 mt-0.5">
            ON = when an exit charge times out or is declined, the terminal is automatically re-armed after 2s (up to 3 tries) so the driver can tap again. OFF = a failed tap needs a manual retrigger.
          </div>
          <div className="text-[11px] text-amber-600 mt-0.5">
            ⚠️ Leave OFF until the PayResult callback path is confirmed working — a re-arm after a lost callback can charge a card twice.
          </div>
        </div>
      </label>

      {/* Shared callback port(s) — every device POSTs its PayResult here. A
          comma-separated list binds several ports at once (e.g. 80, 120, 240). */}
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-600 mb-1">Our callback port(s) (PayResult)</label>
          <input type="text" value={callbackPorts} onChange={(e) => onChangeCallbackPorts(e.target.value)}
            className="h-9 w-56 px-2 rounded-lg border border-gray-300 text-sm font-mono focus:border-gray-900 outline-none" placeholder="80, 120, 240" />
        </div>
        <button onClick={onSaveCallbackPorts} disabled={savingCallbackPorts}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-gray-200 hover:border-gray-900 text-xs font-bold uppercase tracking-wide text-gray-700 disabled:opacity-50">
          {savingCallbackPorts ? <Loader2 size={13} className="animate-spin" /> : null} Save &amp; restart listener
        </button>
        <span className="text-[11px] text-gray-400 pb-2">comma-separated for multiple · binds exactly these · open them on the host firewall</span>
      </div>

      {/* Listener status box — mirrors the Settings W4G status panel. */}
      <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-[11px] font-mono space-y-1">
        <div className="flex items-center gap-2">
          <span className={`inline-block w-2 h-2 rounded-full ${listening ? 'bg-emerald-500' : 'bg-gray-400'}`} />
          {listening
            ? <span>Listener UP on 0.0.0.0:{ports.join(', ')}</span>
            : <span>Listener DOWN — {enabled ? 'starting…' : 'flip the switch above to start'}</span>}
        </div>
        {listening && addresses.length > 0 && (
          <div className="text-gray-700">
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Configure the W4G device to POST PayResult to ONE of these URLs (the device firmware hardcodes port 80, so prefer that):</div>
            {addresses.flatMap((ip) =>
              ports.map((port) => (
                <div key={`${ip}:${port}`} className="flex items-center gap-1.5">
                  <span className={`inline-flex items-center px-1.5 rounded text-[10px] font-bold ${port === 80 ? 'bg-emerald-100 text-emerald-800' : 'bg-blue-100 text-blue-800'}`}>{ip}:{port}{port === 80 ? ' ★' : ''}</span>
                  <code className="text-gray-900 select-all">http://{ip}:{port}/w4g/PayResult</code>
                  <CopyButton text={`http://${ip}:${port}/w4g/PayResult`} />
                </div>
              ))
            )}
            <div className="text-[10px] text-gray-500 mt-0.5">★ = device default port. Use this entry in the device's SERVER IP setting via DebugTool. If Windows Firewall blocks inbound TCP, open it: <code className="select-all">New-NetFirewallRule -Direction Inbound -Protocol TCP -LocalPort 80 -Action Allow -DisplayName 'qparking-local W4G'</code></div>
          </div>
        )}
      </div>
    </div>
  );
}

/** One W4G device — config chips + an on-demand reachability test. */
function DeviceCard({ device, lanes, deleting, onEdit, onDelete }:
  { device: PaymentTerminal; lanes: ParkingLane[]; deleting: boolean; onEdit: () => void; onDelete: () => void }) {
  const [test, setTest] = useState<{ state: 'idle' | 'pinging' | 'ok' | 'err'; text: string | null }>({ state: 'idle', text: null });

  async function runTest() {
    setTest({ state: 'pinging', text: 'Testing…' });
    try {
      const r = await window.bridge.pingTerminalHost({ host: device.host, port: device.port });
      setTest(r.ok
        ? { state: 'ok', text: `Reachable · ${r.latencyMs ?? '—'}ms` }
        : { state: 'err', text: r.error ?? 'unreachable' });
    } catch (e: any) {
      setTest({ state: 'err', text: e?.message ?? 'failed' });
    }
  }

  return (
    <div className={`rounded-xl border bg-white overflow-hidden ${device.enabled ? 'border-gray-200' : 'border-gray-200 opacity-70'}`}>
      <div className="p-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <CreditCard size={16} strokeWidth={2.25} className="text-gray-400 flex-shrink-0" />
            <h3 className="font-semibold truncate">{device.name}</h3>
            {!device.enabled && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border bg-gray-100 text-gray-500 border-gray-200">disabled</span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Chip mono>{device.host}:{device.port}</Chip>
            <Chip>timeout {device.timeoutSeconds}s</Chip>
            <Chip icon={MapPin} tone={lanes.length === 0 ? 'muted' : 'default'}>
              {lanes.length === 0 ? 'no lane' : `lane: ${lanes.map((l) => l.name).join(', ')}`}
            </Chip>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={runTest} disabled={test.state === 'pinging'}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-gray-200 hover:border-gray-900 text-xs font-bold uppercase tracking-wide text-gray-700 disabled:opacity-40">
            {test.state === 'pinging' ? <Loader2 size={13} className="animate-spin" /> : <Activity size={13} />} Test connection
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

function DeviceForm({ value, onChange, onCancel, onSave, saving, error }:
  { value: Partial<PaymentTerminal>; onChange: (v: Partial<PaymentTerminal>) => void; onCancel: () => void; onSave: () => void; saving: boolean; error: string | null }) {
  const set = (k: keyof PaymentTerminal, v: any) => onChange({ ...value, [k]: v });
  const [pingResult, setPingResult] = useState<string | null>(null);
  const [pinging, setPinging] = useState(false);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onCancel]);

  async function testConnection() {
    const host = (value.host ?? '').trim();
    if (!host) { setPingResult('Enter a device IP first.'); return; }
    setPinging(true);
    setPingResult('Testing…');
    const r = await window.bridge.pingTerminalHost({ host, port: value.port ?? 80 });
    setPingResult(r.ok ? `✓ Reachable · ${r.latencyMs}ms` : `✗ ${r.error ?? 'unreachable'}`);
    setPinging(false);
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-xl bg-white rounded-2xl shadow-2xl overflow-hidden">
        <header className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-base font-bold">{value.id ? 'Edit' : 'Add'} payment device</h2>
          <button onClick={onCancel} className="w-9 h-9 rounded-lg hover:bg-gray-100 inline-flex items-center justify-center text-gray-500"><X size={18} /></button>
        </header>
        <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <p className="sm:col-span-2 text-xs text-gray-500">
            An Alarmtech Touch'n'Go W4G IO controller. Wire this device to an exit lane on the <strong>Lanes</strong> page — that lane's paid exits are charged here.
          </p>
          <Field label="Display name"><input className="input" value={value.name ?? ''} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Exit A — W4G" /></Field>
          <Field label="Device IP"><input className="input font-mono" value={value.host ?? ''} onChange={(e) => set('host', e.target.value)} placeholder="192.168.1.105" /></Field>
          <Field label="Device HTTP port"><input type="number" className="input" value={value.port ?? 80} onChange={(e) => set('port', Number(e.target.value))} /></Field>
          <Field label="Per-transaction timeout (seconds)"><input type="number" className="input" value={value.timeoutSeconds ?? 30} onChange={(e) => set('timeoutSeconds', Number(e.target.value))} /></Field>
          <div className="sm:col-span-2">
            <button type="button" onClick={testConnection} disabled={pinging}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-gray-200 hover:border-gray-900 text-xs font-bold uppercase tracking-wide text-gray-700 disabled:opacity-50">
              {pinging ? <Loader2 size={13} className="animate-spin" /> : <Activity size={13} />} Test connection
            </button>
            {pingResult && (
              <div className={`mt-2 rounded-md px-2 py-1.5 text-[11px] font-mono ${
                pingResult.startsWith('✓') ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                : pingResult.startsWith('✗') ? 'bg-red-50 text-red-700 border border-red-200'
                : 'bg-gray-100 text-gray-700'
              }`}>{pingResult}</div>
            )}
          </div>
          <Field label="Enabled">
            <label className="inline-flex items-center gap-2 mt-2 text-sm"><input type="checkbox" checked={value.enabled ?? true} onChange={(e) => set('enabled', e.target.checked)} /> accept charges on this device</label>
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

// ─── Dev-only W4G test tools (moved off the Settings page) ───────────────────

interface TngLogLine { at: string; kind: 'send' | 'recv' | 'error' | 'info'; text: string; payload?: unknown }
interface FullTngStatus {
  pending: { orderId: string; payAmount: number; startedAt: string }[];
  lastResult?: { orderId: string; status: string; payType?: number; at: string };
  lastError?: string;
}
const PAY_TYPE_LABEL: Record<number, string> = { 0: 'TNG card', 1: 'Visa', 2: 'Mastercard', 3: 'MCCS', 4: 'TNG e-wallet' };

/**
 * QA / commissioning tools for the W4G devices — Loopback (proves our callback
 * listener works), Test PayRequest (full round-trip against a chosen device),
 * PayCancel, plus a live status + frame log. Gated behind devMode; the master
 * enable + callback port live in the listener panel above.
 */
function W4gTestPanel({ devices }: { devices: PaymentTerminal[] }) {
  const [deviceId, setDeviceId] = useState<number | ''>(devices[0]?.id ?? '');
  const [amount, setAmount] = useState<number>(100);
  const [lastOrderId, setLastOrderId] = useState('');
  const [log, setLog] = useState<TngLogLine[]>([]);
  const [full, setFull] = useState<FullTngStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const device = devices.find((d) => d.id === deviceId) ?? null;

  useEffect(() => {
    let alive = true;
    const poll = () => window.bridge.tngStatus().then((s: any) => { if (alive) setFull(s); }).catch(() => null);
    poll();
    const t = setInterval(poll, 2000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  useEffect(() => {
    const off = window.bridge.onEvent('log', (p: any) => {
      if (p?.source !== 'w4g') return;
      setLog((cur) => [{ at: new Date().toLocaleTimeString(), kind: p.direction, text: p.message, payload: p.payload }, ...cur].slice(0, 100));
    });
    return () => off();
  }, []);

  const append = (kind: TngLogLine['kind'], text: string, payload?: unknown) =>
    setLog((cur) => [{ at: new Date().toLocaleTimeString(), kind, text, payload }, ...cur].slice(0, 100));
  const run = async (label: string, fn: () => Promise<void>) => { setBusy(label); try { await fn(); } finally { setBusy(null); } };

  const ping = () => device && run('ping', async () => {
    append('info', `Test connection → ${device.host}:${device.port}…`);
    const r = await window.bridge.pingTerminalHost({ host: device.host, port: device.port });
    append(r.ok ? 'recv' : 'error', r.ok ? `✓ Reachable · ${r.latencyMs}ms` : `✗ ${r.error ?? 'unreachable'}`);
  });
  const loopback = () => run('loopback', async () => {
    append('info', 'Loopback — POSTing a synthetic PayResult to our own listener…');
    const r = await window.bridge.tngLoopbackPayResult();
    append(r.ok ? 'recv' : 'error',
      r.ok ? `✓ Loopback OK · status ${r.status} · ${r.elapsedMs}ms — the listener is healthy and parsing correctly.` : `✗ ${r.error ?? 'failed'}`,
      { sent: r.sentBody, response: r.responseBody });
  });
  const payRequest = () => device && run('pay', async () => {
    append('send', `PayRequest → ${device.name} @ ${device.host}:${device.port} amount=${amount}c`);
    const r = await window.bridge.tngTestPayRequest({ payAmount: amount, host: device.host, port: device.port });
    setLastOrderId(r.orderId);
    if (r.ok) {
      const scheme = r.payType != null ? (PAY_TYPE_LABEL[r.payType] ?? `code ${r.payType}`) : '?';
      append('recv', `✓ APPROVED · ${scheme} · card=${r.cardNo ?? '-'} · appr=${r.apprCode ?? '-'}`);
    } else if (r.resultState) append('error', `✗ DECLINED state=${r.resultState}`);
    else append('error', `✗ ${r.error ?? 'failed'}`);
  });
  const payCancel = () => run('cancel', async () => {
    if (!lastOrderId) { append('error', 'No orderId yet — fire Test PayRequest first'); return; }
    append('send', `PayCancel orderId=${lastOrderId}`);
    const r = await window.bridge.tngTestPayCancel(lastOrderId, device ? { host: device.host, port: device.port } : undefined);
    append(r.ok ? 'recv' : 'error', r.ok ? `✓ Cancel accepted (state=${r.deviceState})` : `✗ ${r.error ?? `state=${r.deviceState}`}`);
  });

  return (
    <div className="mb-4 rounded-xl border-2 border-dashed border-fuchsia-300 bg-fuchsia-50/40 p-4">
      <div className="flex items-center gap-2 mb-1">
        <FlaskConical size={14} className="text-fuchsia-600" />
        <h3 className="text-sm font-bold text-fuchsia-800 uppercase tracking-wide">W4G test tools</h3>
        <span className="text-[10px] font-bold uppercase tracking-wider text-fuchsia-500">QA only · dev mode</span>
      </div>
      <p className="text-[11px] text-gray-500 mb-3">
        <strong>Loopback</strong> proves our PayResult listener works (no device needed). <strong>Test PayRequest</strong> fires a real charge at the selected device and waits for its callback. Requires the listener enabled above.
      </p>

      <div className="flex flex-wrap items-end gap-2 mb-2">
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-wide text-gray-500 mb-1">Device</label>
          <select value={deviceId} onChange={(e) => setDeviceId(e.target.value ? Number(e.target.value) : '')}
            className="h-9 px-2 rounded-lg border border-gray-300 text-sm min-w-[12rem]">
            {devices.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.host}:{d.port})</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-wide text-gray-500 mb-1">Amount (cents)</label>
          <input type="number" min={1} value={amount} onChange={(e) => setAmount(Math.max(1, Number(e.target.value) || 1))}
            className="h-9 w-28 px-2 rounded-lg border border-gray-300 text-sm font-mono" />
        </div>
        {log.length > 0 && (
          <button onClick={() => setLog([])} className="h-9 px-2 text-[11px] font-bold uppercase tracking-wide text-gray-500 hover:text-gray-900">Clear log</button>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button onClick={() => ping()} disabled={!device || !!busy}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-gray-200 hover:border-gray-900 text-xs font-bold uppercase tracking-wide text-gray-700 disabled:opacity-40">
          {busy === 'ping' ? <Loader2 size={13} className="animate-spin" /> : <Wifi size={13} />} Test connection
        </button>
        <button onClick={() => loopback()} disabled={!!busy}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-violet-200 hover:bg-violet-50 text-violet-700 text-xs font-bold uppercase tracking-wide disabled:opacity-40">
          {busy === 'loopback' ? <Loader2 size={13} className="animate-spin" /> : <Activity size={13} />} Test loopback
        </button>
        <button onClick={() => payRequest()} disabled={!device || !!busy}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-40">
          {busy === 'pay' ? <Loader2 size={13} className="animate-spin" /> : <CreditCard size={13} />} Test PayRequest
        </button>
        <button onClick={() => payCancel()} disabled={!!busy || !lastOrderId}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-red-200 hover:bg-red-50 text-red-700 text-xs font-bold uppercase tracking-wide disabled:opacity-40">
          {busy === 'cancel' ? <Loader2 size={13} className="animate-spin" /> : <XCircle size={13} />} Test PayCancel
        </button>
      </div>

      {full && (full.pending.length > 0 || full.lastResult || full.lastError) && (
        <div className="mt-3 rounded-lg border border-gray-200 bg-white px-3 py-2 text-[11px] font-mono space-y-0.5">
          {full.pending.length > 0 && <div>Pending: {full.pending.map((o) => `${o.orderId.slice(0, 8)}…(${o.payAmount}c)`).join(', ')}</div>}
          {full.lastResult && <div>Last result: {full.lastResult.orderId.slice(0, 8)}… {full.lastResult.status} payType={full.lastResult.payType ?? '-'} at {new Date(full.lastResult.at).toLocaleTimeString()}</div>}
          {full.lastError && <div className="text-red-700">Last error: {full.lastError}</div>}
        </div>
      )}

      {log.length > 0 && (
        <div className="mt-3 rounded-lg border border-gray-200 bg-black/95 text-gray-100 px-3 py-2 max-h-72 overflow-auto text-[11px] font-mono space-y-1">
          {log.map((line, idx) => {
            const kindColor = line.kind === 'error' ? 'text-red-400' : line.kind === 'send' ? 'text-sky-300' : line.kind === 'recv' ? 'text-emerald-300' : 'text-gray-400';
            const hasPayload = line.payload !== undefined && line.payload !== null;
            return (
              <div key={idx} className={kindColor}>
                <div className="break-all">
                  <span className="text-gray-500">{line.at}</span>{' '}
                  <span className="uppercase">{line.kind}</span>{' '}
                  {line.text}
                </div>
                {hasPayload && (
                  <details className="ml-12 mt-0.5">
                    <summary className="cursor-pointer text-gray-500 hover:text-gray-300 text-[10px] uppercase tracking-wider">payload ▾</summary>
                    <pre className="mt-1 px-2 py-1 rounded bg-gray-900/80 text-gray-300 text-[10px] whitespace-pre-wrap break-all leading-snug">
                      {(() => { try { return typeof line.payload === 'string' ? line.payload : JSON.stringify(line.payload, null, 2); } catch { return String(line.payload); } })()}
                    </pre>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Chip({ children, icon: Icon, mono, tone = 'default' }: { children: React.ReactNode; icon?: any; mono?: boolean; tone?: 'default' | 'muted' }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-gray-200 bg-gray-50 text-[11px] ${tone === 'muted' ? 'text-gray-400' : 'text-gray-600'} ${mono ? 'font-mono' : ''}`}>
      {Icon && <Icon size={11} className="text-gray-400 flex-shrink-0" />}
      {children}
    </span>
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
