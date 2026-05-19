import { useEffect, useState } from 'react';
import { Plus, Trash2, Power, PowerOff, Activity, RefreshCw, CreditCard, X, Wrench, Loader2 } from 'lucide-react';
import type { PaymentTerminal, TerminalStatus, LaneType, LaneMode, OperationMode } from '@shared/types';
import { TerminalTester } from './TerminalTester';

const EMPTY: Omit<PaymentTerminal, 'id'|'createdAt'|'updatedAt'> = {
  name: '', host: '', port: 5000, secretKey: '', plazaId: 'P01', laneId: 'L01',
  laneType: 'dual', mode: 'kiosk', operationMode: 'live', enabled: true,
};

export function Terminals() {
  const [list, setList] = useState<PaymentTerminal[]>([]);
  const [statuses, setStatuses] = useState<Record<number, TerminalStatus>>({});
  const [editing, setEditing] = useState<Partial<PaymentTerminal> | null>(null);
  const [tester, setTester] = useState<PaymentTerminal | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: 'err' | 'ok'; text: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  function flash(tone: 'err' | 'ok', text: string) {
    setToast({ tone, text });
    setTimeout(() => setToast(null), 5_000);
  }

  /** Wrap a renderer action so any IPC throw is shown to the user instead of
   *  silently disappearing — the previous behaviour made buttons look frozen
   *  even when nothing was actually blocked. */
  async function guard<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(label);
    try { return await fn(); }
    catch (e: any) { flash('err', `${label}: ${e?.message ?? String(e)}`); return undefined; }
    finally { setBusy(null); }
  }

  async function refresh() {
    try {
      const l = await window.bridge.listTerminals();
      setList(l);
      // Fetch all statuses in parallel — a single slow one doesn't hold up the others.
      const next: Record<number, TerminalStatus> = {};
      await Promise.all(l.map(async (t) => {
        try { next[t.id] = await window.bridge.getTerminalStatus(t.id); } catch { /* ignore */ }
      }));
      setStatuses(next);
    } catch (e: any) {
      flash('err', `Load failed: ${e?.message ?? String(e)}`);
    }
  }
  useEffect(() => { void refresh(); }, []);

  useEffect(() => {
    const off = window.bridge.onEvent('terminal-status', (p: any) => {
      setStatuses((s) => ({ ...s, [p.terminalId]: p }));
      if (p.lastError && p.conn === 'error') flash('err', `${p.terminalId}: ${p.lastError}`);
    });
    return off;
  }, []);

  async function save() {
    setFormError(null);
    if (!editing?.name || !editing.host) {
      setFormError('Name and host are required.');
      return;
    }
    // Secret key may legitimately be empty — the C# reference client defaults
    // to "" and the reader accepts signatures computed over the bare JSON
    // with no prefix. Normalise to empty string so the DB column stays NOT NULL.
    if (editing.secretKey == null) editing.secretKey = '';
    const ok = await guard('Save terminal', () => window.bridge.saveTerminal(editing as any));
    if (ok) {
      setEditing(null);
      flash('ok', 'Saved.');
      await refresh();
    }
  }

  async function remove(id: number) {
    if (!confirm(`Delete this terminal? Any open transactions will abort.`)) return;
    if (await guard('Delete', () => window.bridge.deleteTerminal(id))) {
      await refresh();
    }
  }

  return (
    <div className="p-5 sm:p-8 max-w-5xl mx-auto">
      <header className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Payment terminals</h1>
          <p className="text-sm text-gray-500 mt-1">ECPI readers on the LAN. One row per gate / kiosk.</p>
        </div>
        <button onClick={() => { setFormError(null); setEditing({ ...EMPTY }); }}
          className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide">
          <Plus size={14} /> Add terminal
        </button>
      </header>

      {toast && (
        <div className={`mb-4 rounded-lg border px-3 py-2 text-xs ${toast.tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700'}`}>
          {toast.text}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3">
        {list.map((t) => {
          const s = statuses[t.id];
          // Static class map — Tailwind JIT can't resolve `bg-${tone}-50` at
          // build time, so dynamic templates produce unstyled elements. Each
          // tone needs its full class string present in the source as-is.
          const badgeCls = s?.conn === 'ready'        ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
            : s?.conn === 'transacting'                ? 'bg-blue-50 border-blue-200 text-blue-800'
            : s?.conn === 'connecting' || s?.conn === 'initialising' ? 'bg-amber-50 border-amber-200 text-amber-800'
            : s?.conn === 'error'                      ? 'bg-red-50 border-red-200 text-red-800'
            :                                            'bg-gray-100 border-gray-200 text-gray-700';
          const dotCls = s?.conn === 'ready'         ? 'bg-emerald-500'
            : s?.conn === 'transacting'               ? 'bg-blue-500'
            : s?.conn === 'connecting' || s?.conn === 'initialising' ? 'bg-amber-500'
            : s?.conn === 'error'                     ? 'bg-red-500'
            :                                           'bg-gray-400';
          return (
            <div key={t.id} className="rounded-xl border border-gray-200 bg-white overflow-hidden">
              <div className="p-4 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <CreditCard size={16} strokeWidth={2.25} className="text-gray-400" />
                    <h3 className="font-semibold">{t.name}</h3>
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border ${badgeCls}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${dotCls}`} /> {s?.conn ?? 'unknown'}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-gray-500 font-mono">
                    {t.host}:{t.port} · {t.plazaId}/{t.laneId} · {t.laneType} · {t.mode}
                    {s?.lastError && <span className="text-red-600 ml-2">err: {s.lastError}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button title="API tester (open per-terminal test console)" onClick={() => setTester(t)}
                    className="w-9 h-9 rounded-lg border border-gray-200 hover:border-gray-900 inline-flex items-center justify-center text-gray-700">
                    <Wrench size={14} />
                  </button>
                  <button title="Refresh status" disabled={!!busy} onClick={() => guard('Refresh status', () => window.bridge.terminalGetStatus(t.id))}
                    className="w-9 h-9 rounded-lg border border-gray-200 hover:border-gray-900 inline-flex items-center justify-center text-gray-700 disabled:opacity-40">
                    {busy === 'Refresh status' ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                  </button>
                  <button title="Test card scan" disabled={!!busy} onClick={() => guard('Init card', () => window.bridge.terminalInitCard(t.id))}
                    className="w-9 h-9 rounded-lg border border-gray-200 hover:border-gray-900 inline-flex items-center justify-center text-gray-700 disabled:opacity-40">
                    {busy === 'Init card' ? <Loader2 size={14} className="animate-spin" /> : <Activity size={14} />}
                  </button>
                  {(s?.conn === 'disconnected' || s?.conn === 'error' || !s) ? (
                    <button disabled={!!busy} onClick={() => guard('Connect', () => window.bridge.terminalConnect(t.id))}
                      className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-40">
                      {busy === 'Connect' ? <Loader2 size={13} className="animate-spin" /> : <Power size={13} />}
                      {busy === 'Connect' ? 'Connecting…' : 'Connect'}
                    </button>
                  ) : (
                    <button disabled={!!busy} onClick={() => guard('Disconnect', () => window.bridge.terminalDisconnect(t.id))}
                      className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-gray-200 hover:border-red-300 text-red-700 text-xs font-bold uppercase tracking-wide disabled:opacity-40">
                      {busy === 'Disconnect' ? <Loader2 size={13} className="animate-spin" /> : <PowerOff size={13} />}
                      {busy === 'Disconnect' ? 'Stopping…' : 'Stop'}
                    </button>
                  )}
                  <button onClick={() => { setFormError(null); setEditing(t); }} className="text-xs font-bold uppercase tracking-wide text-gray-700 hover:text-gray-900 px-2">Edit</button>
                  <button onClick={() => remove(t.id)} disabled={busy === 'Delete'} className="w-9 h-9 rounded-lg text-red-600 hover:bg-red-50 inline-flex items-center justify-center disabled:opacity-40">
                    {busy === 'Delete' ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
        {list.length === 0 && (
          <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-sm text-gray-500">
            No terminals yet. Click <strong>Add terminal</strong> to register your first ECPI reader.
          </div>
        )}
      </div>

      {editing && <TerminalForm value={editing} onChange={setEditing} onCancel={() => setEditing(null)} onSave={save} error={formError} busy={busy === 'Save terminal'} />}
      {tester && <TerminalTester terminal={tester} onClose={() => setTester(null)} />}
    </div>
  );
}

function TerminalForm({ value, onChange, onCancel, onSave, error, busy }:
  { value: Partial<PaymentTerminal>; onChange: (v: Partial<PaymentTerminal>) => void; onCancel: () => void; onSave: () => void; error: string | null; busy: boolean }) {
  const set = (k: keyof PaymentTerminal, v: any) => onChange({ ...value, [k]: v });
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-xl bg-white rounded-2xl shadow-2xl overflow-hidden">
        <header className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-base font-bold">{value.id ? 'Edit' : 'Add'} terminal</h2>
          <button onClick={onCancel} className="w-9 h-9 rounded-lg hover:bg-gray-100 inline-flex items-center justify-center text-gray-500"><X size={18} /></button>
        </header>
        <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Display name"><input className="input" value={value.name ?? ''} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="Host (LAN IP)"><input className="input" value={value.host ?? ''} onChange={(e) => set('host', e.target.value)} placeholder="192.168.1.199" /></Field>
          <Field label="Port"><input type="number" className="input" value={value.port ?? 5000} onChange={(e) => set('port', Number(e.target.value))} /></Field>
          <Field label="Secret key (optional)"><input className="input font-mono text-xs" value={value.secretKey ?? ''} onChange={(e) => set('secretKey', e.target.value)} placeholder="leave blank if reader has no shared secret" /></Field>
          <Field label="Plaza ID"><input className="input" value={value.plazaId ?? ''} onChange={(e) => set('plazaId', e.target.value)} /></Field>
          <Field label="Lane ID"><input className="input" value={value.laneId ?? ''} onChange={(e) => set('laneId', e.target.value)} /></Field>
          <Field label="Lane type">
            <select className="input" value={value.laneType ?? 'dual'} onChange={(e) => set('laneType', e.target.value as LaneType)}>
              <option value="entry">Entry</option><option value="exit">Exit</option>
              <option value="open">Open</option><option value="dual">Dual</option>
            </select>
          </Field>
          <Field label="Driver mode">
            <select className="input" value={value.mode ?? 'kiosk'} onChange={(e) => set('mode', e.target.value as LaneMode)}>
              <option value="kiosk">Kiosk (V3.9C — self-service)</option>
              <option value="lpr">LPR (V1.17C — gate-controlled)</option>
            </select>
          </Field>
          <Field label="Operation mode">
            <select className="input" value={value.operationMode ?? 'live'} onChange={(e) => set('operationMode', e.target.value as OperationMode)}>
              <option value="live">Live</option><option value="maintenance">Maintenance</option><option value="not_in_use">Not in use</option>
            </select>
          </Field>
          <Field label="Enabled">
            <label className="inline-flex items-center gap-2 mt-2 text-sm"><input type="checkbox" checked={value.enabled ?? true} onChange={(e) => set('enabled', e.target.checked)} /> auto-connect on boot</label>
          </Field>
        </div>
        {error && (
          <div className="mx-5 mb-3 rounded-lg border border-red-200 bg-red-50 text-red-700 text-xs px-3 py-2">{error}</div>
        )}
        <footer className="px-5 py-3 border-t border-gray-200 flex items-center justify-end gap-2">
          <button onClick={onCancel} disabled={busy} className="text-xs font-bold uppercase tracking-wide text-gray-600 hover:text-gray-900 px-3 disabled:opacity-50">Cancel</button>
          <button onClick={onSave} disabled={busy} className="h-10 px-4 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50">
            {busy ? 'Saving…' : 'Save'}
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
