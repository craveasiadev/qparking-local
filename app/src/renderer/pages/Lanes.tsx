import { useEffect, useState } from 'react';
import { Plus, Trash2, Map as MapIcon, X } from 'lucide-react';
import type { ParkingLane, PaymentTerminal, RatePolicy, LprCamera } from '@shared/types';
import { useConfirm } from '../hooks/useConfirm';

const EMPTY: Omit<ParkingLane, 'id'> = {
  name: '', policyId: null, terminalId: null, gateRelayAddress: null, enabled: true,
};

/** A lane's direction is derived from its cameras (the single source of
 *  truth) — mirrors db.deriveLaneDirection for the read-only list display. */
function laneDirectionLabel(cams: LprCamera[]): string {
  if (cams.length === 0) return 'no cameras';
  const dirs = new Set(cams.map((c) => c.direction));
  if (dirs.has('dual') || (dirs.has('entry') && dirs.has('exit'))) return 'dual';
  if (dirs.has('entry')) return 'entry';
  if (dirs.has('exit')) return 'exit';
  return '—';
}

export function Lanes() {
  const [list, setList] = useState<ParkingLane[]>([]);
  const [terminals, setTerminals] = useState<PaymentTerminal[]>([]);
  const [policies, setPolicies] = useState<RatePolicy[]>([]);
  const [cameras, setCameras] = useState<LprCamera[]>([]);
  // `cameraIds` rides alongside the lane fields — it's the set of cameras this
  // lane covers, persisted server-side against each camera's lane_id.
  const [editing, setEditing] = useState<(Partial<ParkingLane> & { cameraIds?: number[] }) | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  async function refresh() {
    setList(await window.bridge.listLanes());
    setTerminals(await window.bridge.listTerminals());
    setPolicies(await window.bridge.listRatePolicies());
    setCameras(await window.bridge.listCameras());
  }
  useEffect(() => { void refresh(); }, []);

  async function save() {
    setFormError(null);
    if (!editing?.name) { setFormError('Name is required.'); return; }
    await window.bridge.saveLane(editing as any);
    setEditing(null);
    refresh();
  }

  return (
    <div className="p-5 sm:p-8 max-w-7xl mx-auto">
      {confirmDialog}
      <header className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Lanes</h1>
          <p className="text-sm text-gray-500 mt-1">Entry and exit gates. Each lane links cameras + a payment terminal + a policy rate.</p>
        </div>
        <button onClick={() => { setFormError(null); setEditing({ ...EMPTY, cameraIds: [] }); }} className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide">
          <Plus size={14} /> Add lane
        </button>
      </header>

      <div className="grid grid-cols-1 gap-3">
        {list.map((l) => {
          const t = terminals.find((x) => x.id === l.terminalId);
          const s = policies.find((x) => x.policyId === l.policyId);
          return (
            <div key={l.id} className="rounded-xl border border-gray-200 bg-white p-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <MapIcon size={16} className="text-gray-400" />
                  <h3 className="font-semibold">{l.name}</h3>
                </div>
                <div className="mt-1 text-xs text-gray-500 font-mono">
                  {laneDirectionLabel(cameras.filter((c) => c.laneId === l.id))} · plan: {s?.policyName ?? 'site default'} · terminal: {t?.name ?? '—'}
                  {!l.enabled && ' · DISABLED'}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => { setFormError(null); setEditing({ ...l, cameraIds: cameras.filter((c) => c.laneId === l.id).map((c) => c.id) }); }} className="text-xs font-bold uppercase tracking-wide text-gray-700 hover:text-gray-900 px-2">Edit</button>
                <button onClick={async () => { if (await confirm({ title: 'Delete lane', message: `Delete lane "${l.name}"?`, danger: true, confirmLabel: 'Delete' })) { await window.bridge.deleteLane(l.id); refresh(); } }}
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
              <Field label="Rate plan">
                {/* Points at a policy_id which now corresponds to a cloud
                    RatePolicy — different lanes can bind to different
                    plans (VIP → premium, general → standard). Leaving
                    it "— site default —" falls back to the plan the
                    cloud flagged as default. */}
                <select className="input" value={editing.policyId ?? ''} onChange={(e) => setEditing({ ...editing, policyId: e.target.value || null })}>
                  <option value="">— site default —</option>
                  {policies.map((s) => (
                    <option key={s.policyId} value={s.policyId}>
                      {s.policyName}{(s as any).isSiteDefault ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Payment terminal">
                <select className="input" value={editing.terminalId ?? ''} onChange={(e) => setEditing({ ...editing, terminalId: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">— none —</option>
                  {terminals.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </Field>
              <div className="sm:col-span-2">
                {/* The lane owns the cameras that cover it. Ticking a camera
                    sets its lane_id to this lane (moving it off any other
                    lane). Each camera's entry/exit/dual direction is still
                    set per-camera on the Cameras page — that's what routes a
                    plate scan to entry vs exit. */}
                <label className="block text-[11px] font-semibold uppercase tracking-wide text-gray-600 mb-1">Cameras</label>
                <div className="rounded-lg border border-gray-200 divide-y divide-gray-100 max-h-40 overflow-auto">
                  {cameras.length === 0 && (
                    <p className="px-3 py-2 text-xs text-gray-400">No cameras yet — add them on the Cameras page first.</p>
                  )}
                  {cameras.map((c) => {
                    const sel = editing.cameraIds ?? [];
                    const checked = sel.includes(c.id);
                    const onOtherLane = c.laneId != null && c.laneId !== editing.id;
                    return (
                      <label key={c.id} className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-gray-50">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const next = e.target.checked ? [...sel, c.id] : sel.filter((x) => x !== c.id);
                            setEditing({ ...editing, cameraIds: next });
                          }}
                        />
                        <span className="font-mono text-[10px] uppercase text-gray-400 w-10">{c.direction}</span>
                        <span className="flex-1 truncate">{c.name}</span>
                        {onOtherLane && !checked && <span className="text-[10px] text-amber-600">on another lane</span>}
                      </label>
                    );
                  })}
                </div>
              </div>
              <Field label="Gate relay (optional)"><input className="input font-mono" value={editing.gateRelayAddress ?? ''} onChange={(e) => setEditing({ ...editing, gateRelayAddress: e.target.value })} placeholder="GPIO addr / relay URL" /></Field>
              <Field label="Enabled">
                <label className="inline-flex items-center gap-2 mt-2 text-sm"><input type="checkbox" checked={editing.enabled ?? true} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} /> active</label>
              </Field>
            </div>
            {formError && (
              <div className="mx-5 mb-3 rounded-lg border border-red-200 bg-red-50 text-red-700 text-xs px-3 py-2">{formError}</div>
            )}
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
