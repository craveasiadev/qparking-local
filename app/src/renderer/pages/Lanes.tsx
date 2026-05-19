import { useEffect, useState } from 'react';
import { Plus, Trash2, Map as MapIcon, X } from 'lucide-react';
import type { ParkingLane, PaymentTerminal, ScopeRate } from '@shared/types';

const EMPTY: Omit<ParkingLane, 'id'> = {
  name: '', direction: 'entry', scopeId: null, terminalId: null, gateRelayAddress: null, enabled: true,
};

export function Lanes() {
  const [list, setList] = useState<ParkingLane[]>([]);
  const [terminals, setTerminals] = useState<PaymentTerminal[]>([]);
  const [scopes, setScopes] = useState<ScopeRate[]>([]);
  const [editing, setEditing] = useState<Partial<ParkingLane> | null>(null);

  async function refresh() {
    setList(await window.bridge.listLanes());
    setTerminals(await window.bridge.listTerminals());
    setScopes(await window.bridge.listScopes());
  }
  useEffect(() => { void refresh(); }, []);

  async function save() {
    if (!editing?.name) { alert('Name required'); return; }
    await window.bridge.saveLane(editing as any);
    setEditing(null);
    refresh();
  }

  return (
    <div className="p-5 sm:p-8 max-w-5xl mx-auto">
      <header className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Lanes</h1>
          <p className="text-sm text-gray-500 mt-1">Entry and exit gates. Each lane links cameras + a payment terminal + a scope rate.</p>
        </div>
        <button onClick={() => setEditing({ ...EMPTY })} className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide">
          <Plus size={14} /> Add lane
        </button>
      </header>

      <div className="grid grid-cols-1 gap-3">
        {list.map((l) => {
          const t = terminals.find((x) => x.id === l.terminalId);
          const s = scopes.find((x) => x.scopeId === l.scopeId);
          return (
            <div key={l.id} className="rounded-xl border border-gray-200 bg-white p-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2"><MapIcon size={16} className="text-gray-400" /><h3 className="font-semibold">{l.name}</h3></div>
                <div className="mt-1 text-xs text-gray-500 font-mono">
                  {l.direction} · scope: {s?.scopeName ?? '—'} · terminal: {t?.name ?? '—'}
                  {!l.enabled && ' · DISABLED'}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => setEditing(l)} className="text-xs font-bold uppercase tracking-wide text-gray-700 hover:text-gray-900 px-2">Edit</button>
                <button onClick={async () => { if (confirm('Delete?')) { await window.bridge.deleteLane(l.id); refresh(); } }}
                  className="w-9 h-9 rounded-lg text-red-600 hover:bg-red-50 inline-flex items-center justify-center"><Trash2 size={14} /></button>
              </div>
            </div>
          );
        })}
        {list.length === 0 && <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-sm text-gray-500">No lanes yet.</div>}
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setEditing(null)}>
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-xl bg-white rounded-2xl shadow-2xl overflow-hidden">
            <header className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
              <h2 className="text-base font-bold">{editing.id ? 'Edit' : 'Add'} lane</h2>
              <button onClick={() => setEditing(null)} className="w-9 h-9 rounded-lg hover:bg-gray-100 inline-flex items-center justify-center text-gray-500"><X size={18} /></button>
            </header>
            <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Display name"><input className="input" value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
              <Field label="Direction">
                <select className="input" value={editing.direction ?? 'entry'} onChange={(e) => setEditing({ ...editing, direction: e.target.value as 'entry'|'exit' })}>
                  <option value="entry">Entry</option><option value="exit">Exit</option>
                </select>
              </Field>
              <Field label="Scope (rate set)">
                <select className="input" value={editing.scopeId ?? ''} onChange={(e) => setEditing({ ...editing, scopeId: e.target.value || null })}>
                  <option value="">— none —</option>
                  {scopes.map((s) => <option key={s.scopeId} value={s.scopeId}>{s.scopeName}</option>)}
                </select>
              </Field>
              <Field label="Payment terminal">
                <select className="input" value={editing.terminalId ?? ''} onChange={(e) => setEditing({ ...editing, terminalId: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">— none —</option>
                  {terminals.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </Field>
              <Field label="Gate relay (optional)"><input className="input font-mono" value={editing.gateRelayAddress ?? ''} onChange={(e) => setEditing({ ...editing, gateRelayAddress: e.target.value })} placeholder="GPIO addr / relay URL" /></Field>
              <Field label="Enabled">
                <label className="inline-flex items-center gap-2 mt-2 text-sm"><input type="checkbox" checked={editing.enabled ?? true} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} /> active</label>
              </Field>
            </div>
            <footer className="px-5 py-3 border-t border-gray-200 flex items-center justify-end gap-2">
              <button onClick={() => setEditing(null)} className="text-xs font-bold uppercase tracking-wide text-gray-600 hover:text-gray-900 px-3">Cancel</button>
              <button onClick={save} className="h-10 px-4 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide">Save</button>
            </footer>
          </div>
          <style>{`.input { height: 40px; padding: 0 0.75rem; border: 1px solid #d1d5db; border-radius: 0.5rem; outline: none; font-size: 14px; width: 100%; } .input:focus { border-color: #111827; }`}</style>
        </div>
      )}
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
