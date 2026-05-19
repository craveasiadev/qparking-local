import { useEffect, useState } from 'react';
import { RefreshCw, AlertCircle, Pencil, X, Save, Loader2, CloudUpload } from 'lucide-react';
import type { ScopeRate } from '@shared/types';
import { useAsyncAction } from '../hooks/useAsyncAction';

export function Scopes() {
  const [list, setList] = useState<ScopeRate[]>([]);
  const [result, setResult] = useState<{ ok: boolean; fetched: number; error?: string } | null>(null);
  const [editing, setEditing] = useState<ScopeRate | null>(null);

  async function refresh() { setList(await window.bridge.listScopes()); }
  useEffect(() => { void refresh(); }, []);

  const [sync, syncing] = useAsyncAction(async () => {
    const r = await window.bridge.syncScopesNow();
    setResult(r as any);
    await refresh();
  });

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto">
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Scopes &amp; rates</h1>
          <p className="text-xs sm:text-sm text-gray-500 mt-1">Per-site rates — edit here to fix RM 0 rates without logging into the SaaS admin. Saving pushes to qparking and re-syncs.</p>
        </div>
        <button onClick={() => sync()} disabled={syncing}
          className="inline-flex items-center justify-center gap-1.5 h-10 px-4 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50 self-start">
          {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </header>

      {result && (
        <div className={`mb-4 rounded-lg border px-3 py-2 text-xs ${result.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700'}`}>
          {result.ok ? `Fetched ${result.fetched} scope(s).` : `Sync failed: ${result.error}`}
        </div>
      )}

      {list.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-sm text-gray-500 inline-flex items-center justify-center gap-2 w-full">
          <AlertCircle size={14} /> No scopes cached yet. Configure qparking URL + API key in Settings, then click Sync now.
        </div>
      ) : (
        <>
          {/* Desktop / tablet table */}
          <div className="hidden md:block rounded-xl border border-gray-200 bg-white overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-[10px] uppercase tracking-widest text-gray-500">
                  <tr>
                    <th className="text-left px-3 py-2 font-bold">Scope</th>
                    <th className="text-right px-3 py-2 font-bold">Free</th>
                    <th className="text-right px-3 py-2 font-bold">1st block</th>
                    <th className="text-right px-3 py-2 font-bold">Per block</th>
                    <th className="text-right px-3 py-2 font-bold">Block size</th>
                    <th className="text-right px-3 py-2 font-bold">Daily cap</th>
                    <th className="text-right px-3 py-2 font-bold">Fetched</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((s) => {
                    const zero = s.firstBlockCents === 0 && s.perBlockCents === 0;
                    return (
                      <tr key={s.scopeId} className={`border-t border-gray-100 ${zero ? 'bg-amber-50/40' : ''}`}>
                        <td className="px-3 py-2">
                          <div className="font-semibold">{s.scopeName}</div>
                          <div className="text-[11px] text-gray-500 font-mono">{s.scopeId}</div>
                        </td>
                        <td className="px-3 py-2 text-right font-mono">{s.freeMinutes} min</td>
                        <td className={`px-3 py-2 text-right font-mono ${zero ? 'text-amber-700 font-bold' : ''}`}>{fmtCents(s.firstBlockCents, s.currency)}</td>
                        <td className={`px-3 py-2 text-right font-mono ${zero ? 'text-amber-700 font-bold' : ''}`}>{fmtCents(s.perBlockCents, s.currency)}</td>
                        <td className="px-3 py-2 text-right font-mono">{s.blockMinutes} min</td>
                        <td className="px-3 py-2 text-right font-mono">{s.dailyCapCents > 0 ? fmtCents(s.dailyCapCents, s.currency) : '—'}</td>
                        <td className="px-3 py-2 text-right text-[11px] text-gray-500">{new Date(s.fetchedAt).toLocaleString()}</td>
                        <td className="px-3 py-2 text-right">
                          <button onClick={() => setEditing(s)} className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wide font-bold text-gray-700 hover:text-gray-900">
                            <Pencil size={11} /> Edit
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-2">
            {list.map((s) => {
              const zero = s.firstBlockCents === 0 && s.perBlockCents === 0;
              return (
                <div key={s.scopeId} className={`rounded-xl border bg-white p-3 ${zero ? 'border-amber-300 bg-amber-50/40' : 'border-gray-200'}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold">{s.scopeName}</div>
                      <div className="text-[11px] text-gray-500 font-mono break-all">{s.scopeId}</div>
                    </div>
                    <button onClick={() => setEditing(s)} className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wide font-bold text-gray-700 hover:text-gray-900">
                      <Pencil size={11} /> Edit
                    </button>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                    <div><span className="text-gray-500">Free:</span> <span className="font-mono">{s.freeMinutes} min</span></div>
                    <div><span className="text-gray-500">Block:</span> <span className="font-mono">{s.blockMinutes} min</span></div>
                    <div><span className="text-gray-500">1st:</span> <span className={`font-mono ${zero ? 'text-amber-700 font-bold' : ''}`}>{fmtCents(s.firstBlockCents, s.currency)}</span></div>
                    <div><span className="text-gray-500">Per:</span> <span className={`font-mono ${zero ? 'text-amber-700 font-bold' : ''}`}>{fmtCents(s.perBlockCents, s.currency)}</span></div>
                    <div className="col-span-2"><span className="text-gray-500">Daily cap:</span> <span className="font-mono">{s.dailyCapCents > 0 ? fmtCents(s.dailyCapCents, s.currency) : '—'}</span></div>
                  </div>
                </div>
              );
            })}
          </div>

          {list.some((s) => s.firstBlockCents === 0 && s.perBlockCents === 0) && (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 text-amber-900 text-[12px] px-3 py-2">
              <strong>Heads up:</strong> rows in amber have a RM 0 rate — the exit flow will skip the payment terminal and treat all parking as free. Click <strong>Edit</strong> to set real values; the change is pushed to qparking SaaS.
            </div>
          )}
        </>
      )}

      {editing && (
        <EditRateModal
          scope={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await refresh(); }}
        />
      )}
    </div>
  );
}

function EditRateModal({ scope, onClose, onSaved }: { scope: ScopeRate; onClose: () => void; onSaved: () => void }) {
  const [firstBlockRm, setFirstBlockRm] = useState((scope.firstBlockCents / 100).toFixed(2));
  const [perBlockRm, setPerBlockRm] = useState((scope.perBlockCents / 100).toFixed(2));
  const [freeMinutes, setFreeMinutes] = useState(String(scope.freeMinutes));
  const [blockMinutes, setBlockMinutes] = useState(String(scope.blockMinutes));
  const [dailyCapRm, setDailyCapRm] = useState((scope.dailyCapCents / 100).toFixed(2));
  const [error, setError] = useState<string | null>(null);

  const [save, saving] = useAsyncAction(async () => {
    setError(null);
    const r = await window.bridge.saveScopeRate({
      firstBlockCents: Math.round(parseFloat(firstBlockRm || '0') * 100),
      perBlockCents:   Math.round(parseFloat(perBlockRm   || '0') * 100),
      blockMinutes:    parseInt(blockMinutes || '60', 10),
      freeMinutes:     parseInt(freeMinutes  || '0', 10),
      dailyCapCents:   Math.round(parseFloat(dailyCapRm  || '0') * 100),
    });
    if (!r.ok) {
      setError(r.error || 'Save failed');
      return;
    }
    onSaved();
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg bg-white rounded-2xl shadow-2xl overflow-hidden">
        <header className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold">Edit rate — {scope.scopeName}</h2>
            <p className="text-xs text-gray-500 mt-0.5">Saves to qparking SaaS, then re-syncs the local cache.</p>
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-lg hover:bg-gray-100 inline-flex items-center justify-center text-gray-500"><X size={18} /></button>
        </header>
        <div className="p-5 space-y-3">
          {error && <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 text-xs px-3 py-2">{error}</div>}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="First block (RM)" hint="Flat fee for the first parking block">
              <input type="number" step="0.50" min="0" className="input font-mono" value={firstBlockRm} onChange={(e) => setFirstBlockRm(e.target.value)} />
            </Field>
            <Field label="Per block (RM)" hint="Charge for each block after the first">
              <input type="number" step="0.50" min="0" className="input font-mono" value={perBlockRm} onChange={(e) => setPerBlockRm(e.target.value)} />
            </Field>
            <Field label="Block size (minutes)" hint="Typical: 60">
              <input type="number" step="1" min="1" className="input font-mono" value={blockMinutes} onChange={(e) => setBlockMinutes(e.target.value)} />
            </Field>
            <Field label="Free minutes" hint="Grace period — 0 = charge immediately">
              <input type="number" step="1" min="0" className="input font-mono" value={freeMinutes} onChange={(e) => setFreeMinutes(e.target.value)} />
            </Field>
            <Field label="Daily cap (RM)" hint="0 = no cap">
              <input type="number" step="0.50" min="0" className="input font-mono" value={dailyCapRm} onChange={(e) => setDailyCapRm(e.target.value)} />
            </Field>
          </div>
          <p className="text-[11px] text-gray-500 mt-2">
            Example: <strong>First RM 5.00 + Per RM 3.00 + Block 60 min + Free 0 min</strong> → 1h = RM 5, 2h = RM 8, 3h = RM 11.
          </p>
        </div>
        <footer className="px-5 py-3 border-t border-gray-200 flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={saving} className="text-xs font-bold uppercase tracking-wide text-gray-600 hover:text-gray-900 px-3 disabled:opacity-50">Cancel</button>
          <button onClick={() => save()} disabled={saving}
            className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50">
            {saving ? <Loader2 size={13} className="animate-spin" /> : <CloudUpload size={13} />}
            {saving ? 'Saving + syncing…' : 'Save & push to qparking'}
          </button>
        </footer>
        <style>{`.input { height: 38px; padding: 0 0.625rem; border: 1px solid #d1d5db; border-radius: 0.5rem; outline: none; font-size: 13px; width: 100%; background: white; } .input:focus { border-color: #111827; }`}</style>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-600 mb-1">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}

function fmtCents(c: number, currency: string) {
  return `${currency} ${(c / 100).toFixed(2)}`;
}
