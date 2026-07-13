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
    // A hidden field must never persist stale data: the rate plan only applies
    // to entry/dual lanes (it governs the fee), the payment terminal only to
    // exit/dual lanes (that's where payment is collected). Null whichever the
    // selected camera's direction doesn't use, so the DB can't carry a value
    // the form wouldn't even show.
    const camId = editing.cameraIds?.[0] ?? null;
    const dir = cameras.find((c) => c.id === camId)?.direction ?? null;
    const payload = {
      ...editing,
      policyId: (dir === 'entry' || dir === 'dual') ? (editing.policyId ?? null) : null,
      terminalId: (dir === 'exit' || dir === 'dual') ? (editing.terminalId ?? null) : null,
    };
    await window.bridge.saveLane(payload as any);
    setEditing(null);
    refresh();
  }

  // Single camera per lane — its direction decides which of rate-plan /
  // payment-terminal the form exposes (see the save() note above).
  const selectedCameraId = editing?.cameraIds?.[0] ?? null;
  const selectedDir = cameras.find((c) => c.id === selectedCameraId)?.direction ?? null;
  const showRatePlan = selectedDir === 'entry' || selectedDir === 'dual';
  const showTerminal = selectedDir === 'exit' || selectedDir === 'dual';

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
              {/* One camera per lane. Two cameras on the same lane would both
                  fire a plate event for the same car, forcing dedup guesswork —
                  so a lane binds to exactly one. Grouped by direction so the
                  right camera is easy to find when there are many. Picking a
                  camera sets its lane_id to this lane (stealing it off any
                  other). Direction itself is still set per-camera on the
                  Cameras page. */}
              <Field label="Camera">
                <select className="input" value={selectedCameraId ?? ''}
                  onChange={(e) => setEditing({ ...editing, cameraIds: e.target.value ? [Number(e.target.value)] : [] })}>
                  <option value="">— none —</option>
                  {(['entry', 'exit', 'dual'] as const).map((group) => {
                    const groupCams = cameras.filter((c) => c.direction === group);
                    if (groupCams.length === 0) return null;
                    return (
                      <optgroup key={group} label={group.toUpperCase()}>
                        {groupCams.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}{c.laneId != null && c.laneId !== editing.id ? ' (on another lane)' : ''}
                          </option>
                        ))}
                      </optgroup>
                    );
                  })}
                </select>
              </Field>
              <div className="sm:col-span-2 -mt-1">
                {cameras.length === 0 ? (
                  <p className="text-[11px] text-amber-600">No cameras yet — add one on the <strong>Cameras</strong> page first. A lane needs an LPR camera to do anything.</p>
                ) : (
                  <p className="text-[11px] text-gray-500">The camera's direction decides the rest: <strong>entry</strong> → set the rate plan; <strong>exit</strong> → set the payment terminal; <strong>dual</strong> → both.</p>
                )}
              </div>
              {showRatePlan && (
                <Field label="Rate plan">
                  {/* Points at a policy_id which now corresponds to a cloud
                      RatePolicy — different lanes can bind to different plans
                      (VIP → premium, general → standard). "— site default —"
                      falls back to the plan the cloud flagged as default. The
                      fee is governed by the ENTRY lane's plan, which is why
                      this only shows for entry/dual cameras. */}
                  <select className="input" value={editing.policyId ?? ''} onChange={(e) => setEditing({ ...editing, policyId: e.target.value || null })}>
                    <option value="">— site default —</option>
                    {policies.map((s) => (
                      <option key={s.policyId} value={s.policyId}>
                        {s.policyName}{(s as any).isSiteDefault ? ' (default)' : ''}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {showTerminal && (
                <Field label="Payment terminal">
                  <select className="input" value={editing.terminalId ?? ''} onChange={(e) => setEditing({ ...editing, terminalId: e.target.value ? Number(e.target.value) : null })}>
                    <option value="">— none —</option>
                    {terminals.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </Field>
              )}
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
