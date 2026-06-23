import { useEffect, useState } from 'react';
import { RefreshCw, AlertCircle, Pencil, X, Save, Loader2, CloudUpload, ChevronDown, ChevronRight, Clock, Car } from 'lucide-react';
import type { ScopeRate, TariffRule } from '@shared/types';
import { useAsyncAction } from '../hooks/useAsyncAction';

export function Scopes() {
  const [list, setList] = useState<ScopeRate[]>([]);
  const [result, setResult] = useState<{ ok: boolean; fetched: number; error?: string } | null>(null);
  const [editing, setEditing] = useState<ScopeRate | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  function toggle(id: string) { setExpanded((m) => ({ ...m, [id]: !m[id] })); }

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
                    const ruleCount = s.rules?.length ?? 0;
                    const isOpen = !!expanded[s.scopeId];
                    return (
                      <>
                        <tr key={s.scopeId} className={`border-t border-gray-100 ${zero ? 'bg-amber-50/40' : ''}`}>
                          <td className="px-3 py-2">
                            <button
                              type="button"
                              onClick={() => toggle(s.scopeId)}
                              className="inline-flex items-center gap-1.5 text-left hover:opacity-75"
                              title={ruleCount > 0 ? `${ruleCount} tariff rule${ruleCount === 1 ? '' : 's'} — click to expand` : 'No detailed rules from cloud'}
                            >
                              {ruleCount > 0
                                ? (isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />)
                                : <span className="w-[13px] inline-block" />}
                              <div>
                                <div className="font-semibold">{s.scopeName}</div>
                                <div className="text-[11px] text-gray-500 font-mono">{s.scopeId}</div>
                              </div>
                            </button>
                            {ruleCount > 0 && (
                              <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-gray-100 text-gray-700 text-[10px] font-semibold px-2 py-0.5">
                                {ruleCount} rule{ruleCount === 1 ? '' : 's'}
                              </span>
                            )}
                            {s.policyName && (
                              <div className="text-[10px] text-gray-400 mt-0.5">Policy: {s.policyName}</div>
                            )}
                            {s.policyDescription && (
                              <div className="text-[10px] text-gray-500 mt-0.5 italic max-w-md">{s.policyDescription}</div>
                            )}
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
                        {isOpen && ruleCount > 0 && (
                          <tr className="bg-gray-50/60 border-t border-gray-100">
                            <td colSpan={8} className="px-3 py-3">
                              <RulesTable scope={s} />
                            </td>
                          </tr>
                        )}
                      </>
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
              const ruleCount = s.rules?.length ?? 0;
              const isOpen = !!expanded[s.scopeId];
              return (
                <div key={s.scopeId} className={`rounded-xl border bg-white p-3 ${zero ? 'border-amber-300 bg-amber-50/40' : 'border-gray-200'}`}>
                  <div className="flex items-start justify-between gap-2">
                    <button type="button" onClick={() => toggle(s.scopeId)} className="min-w-0 text-left inline-flex items-start gap-1.5">
                      {ruleCount > 0
                        ? (isOpen ? <ChevronDown size={13} className="mt-1" /> : <ChevronRight size={13} className="mt-1" />)
                        : null}
                      <div>
                        <div className="font-semibold">{s.scopeName}</div>
                        <div className="text-[11px] text-gray-500 font-mono break-all">{s.scopeId}</div>
                        {ruleCount > 0 && (
                          <div className="mt-0.5 text-[10px] text-gray-500">{ruleCount} tariff rule{ruleCount === 1 ? '' : 's'} from cloud</div>
                        )}
                      </div>
                    </button>
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
                  {isOpen && ruleCount > 0 && (
                    <div className="mt-3 pt-3 border-t border-gray-200">
                      <RulesTable scope={s} compact />
                    </div>
                  )}
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

// ─── Tariff rules drawer ───────────────────────────────────────────────────
// Renders the full `rules[]` array fetched from qparking SaaS — vehicle
// type, day-of-week, time window, rule type (flat vs hourly), and amounts.
// Highlights the rule that matches RIGHT NOW so the operator can see at a
// glance which one would settle a current exit.

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function fmtDays(days: number[] | null): string {
  if (!days || days.length === 0 || days.length === 7) return 'Everyday';
  const sorted = [...days].sort();
  if (sorted.join(',') === '1,2,3,4,5') return 'Weekdays';
  if (sorted.join(',') === '0,6') return 'Weekends';
  return sorted.map((d) => DAY_LABELS[d]).join(', ');
}

function fmtTimeRange(from: string, to: string): string {
  const f = (from ?? '').slice(0, 5);
  const t = (to ?? '').slice(0, 5);
  if (f === '00:00' && (t === '23:59' || t === '24:00' || t === '00:00')) return 'All day';
  return `${f}–${t}`;
}

function fmtRuleAmounts(r: TariffRule, currency: string): string {
  if (r.ruleType === 'flat_rate') {
    return `Flat ${currency} ${(r.flatAmountCents / 100).toFixed(2)}`;
  }
  const fb = `First ${r.firstBlockMinutes}m ${currency} ${(r.firstBlockAmountCents / 100).toFixed(2)}`;
  const sb = `next ${r.subsequentBlockMinutes}m ${currency} ${(r.subsequentBlockAmountCents / 100).toFixed(2)}`;
  return `${fb}, ${sb}`;
}

/** Does this rule cover `now`? Mirrors the matching in parking-flow.ts so
 *  the highlight stays consistent with the actual fee math. */
function ruleMatchesNow(r: TariffRule): boolean {
  const now = new Date();
  const weekday = now.getDay();
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  const date = now.toISOString().slice(0, 10);

  if (r.validFrom && r.validFrom > date) return false;
  if (r.validTo && r.validTo < date) return false;
  if (Array.isArray(r.daysOfWeek) && r.daysOfWeek.length > 0 && !r.daysOfWeek.includes(weekday)) return false;
  const from = r.timeFrom;
  const to = r.timeTo === '23:59:59' || r.timeTo === '23:59:00' ? '24:00:00' : r.timeTo;
  if (from === to) return true;
  if (from < to) return time >= from && time < to;
  return time >= from || time < to;
}

function RulesTable({ scope, compact = false }: { scope: ScopeRate; compact?: boolean }) {
  const rules = [...(scope.rules ?? [])].sort((a, b) => b.priority - a.priority);

  // Group by vehicle_type for readability (matches the cloud UI layout).
  const groups = new Map<string, TariffRule[]>();
  for (const r of rules) {
    const key = r.vehicleType || 'All vehicles';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  // Find the single "active now" rule per vehicle group (highest priority match
  // AMONGST is_active=true rules). Mirrors the exit-flow rule selection.
  const activeIds = new Set<string>();
  for (const [, list] of groups) {
    const match = list.find((r) => r.isActive !== false && ruleMatchesNow(r));
    if (match) activeIds.add(match.ruleId);
  }

  return (
    <div className="space-y-3">
      {/* Setup & Rules summary — mirrors the cloud Setup & Rules tab so the
          on-prem operator sees the same context (grace, daily reset, etc). */}
      <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-[11px] text-gray-700 space-y-0.5">
        <div className="flex flex-wrap gap-x-4 gap-y-0.5">
          <span><span className="text-gray-500">Grace:</span> <span className="font-mono">{scope.freeMinutes} min</span></span>
          {scope.graceExceededBehavior && (
            <span><span className="text-gray-500">After grace:</span> <span className="font-mono">{scope.graceExceededBehavior.replace(/_/g, ' ')}</span></span>
          )}
          <span><span className="text-gray-500">Daily reset:</span>{' '}
            {scope.cutoffEnabled
              ? <span className="font-mono">{(scope.cutoffTime ?? '').slice(0, 5) || '00:00'} → {scope.cutoffBehavior?.replace(/_/g, ' ') ?? 'restart'}</span>
              : <span className="text-gray-400">off</span>}
          </span>
          {scope.cutoffEnabled && scope.cutoffBehavior === 'new_day_fixed_fee' && scope.newDayFixedFeeCents !== null && (
            <span><span className="text-gray-500">New-day fee:</span> <span className="font-mono">{scope.currency} {(scope.newDayFixedFeeCents / 100).toFixed(2)}</span></span>
          )}
          <span><span className="text-gray-500">Daily cap:</span>{' '}
            {scope.dailyCapCents > 0
              ? <span className="font-mono">{scope.currency} {(scope.dailyCapCents / 100).toFixed(2)}</span>
              : <span className="text-gray-400">no cap</span>}
          </span>
        </div>
      </div>

      {Array.from(groups.entries()).map(([vehicle, list]) => (
        <div key={vehicle}>
          <div className="flex items-center gap-1.5 mb-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-500">
            <Car size={11} /> {vehicle}
          </div>
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="w-full text-[12px]">
              <thead className="bg-gray-50 text-[10px] uppercase tracking-widest text-gray-500">
                <tr>
                  <th className="text-left px-2 py-1.5 font-bold">Rule</th>
                  <th className="text-left px-2 py-1.5 font-bold">Days</th>
                  <th className="text-left px-2 py-1.5 font-bold">Time</th>
                  <th className="text-left px-2 py-1.5 font-bold">Type</th>
                  <th className="text-left px-2 py-1.5 font-bold">Amount</th>
                  {!compact && <th className="text-right px-2 py-1.5 font-bold">Pri.</th>}
                  {!compact && <th className="text-right px-2 py-1.5 font-bold">Cap</th>}
                </tr>
              </thead>
              <tbody>
                {list.map((r) => {
                  const active = activeIds.has(r.ruleId);
                  const disabled = r.isActive === false;
                  return (
                    <tr key={r.ruleId} className={`border-t border-gray-100 ${active ? 'bg-emerald-50' : ''} ${disabled ? 'opacity-50' : ''}`}>
                      <td className="px-2 py-1.5">
                        <div className="font-semibold inline-flex items-center gap-1.5">
                          {r.name}
                          {active && <span className="rounded-full bg-emerald-600 text-white text-[9px] font-bold uppercase px-1.5 py-0.5">Active now</span>}
                          {disabled && <span className="rounded-full bg-gray-200 text-gray-600 text-[9px] font-bold uppercase px-1.5 py-0.5">Off</span>}
                          {r.isOvernight && <span className="rounded-full bg-indigo-100 text-indigo-700 text-[9px] font-bold uppercase px-1.5 py-0.5">Overnight</span>}
                        </div>
                      </td>
                      <td className="px-2 py-1.5">{fmtDays(r.daysOfWeek)}</td>
                      <td className="px-2 py-1.5 font-mono"><Clock size={10} className="inline mr-1 text-gray-400" />{fmtTimeRange(r.timeFrom, r.timeTo)}</td>
                      <td className="px-2 py-1.5">
                        <span className={`rounded-full text-[10px] font-bold uppercase px-1.5 py-0.5 ${r.ruleType === 'flat_rate' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'}`}>
                          {r.ruleType === 'flat_rate' ? 'Flat' : 'Block hourly'}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 font-mono text-gray-700">{fmtRuleAmounts(r, scope.currency)}</td>
                      {!compact && <td className="px-2 py-1.5 text-right font-mono">{r.priority}</td>}
                      {!compact && <td className="px-2 py-1.5 text-right font-mono">{r.dailyCapCents > 0 ? `${scope.currency} ${(r.dailyCapCents / 100).toFixed(2)}` : '—'}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      <p className="text-[10px] text-gray-400">
        Rules are read-only here — edit them in qparking SaaS (Pricing &amp; Tariffs). The local exit-flow picks the highest-priority rule matching the session's moment.
      </p>
    </div>
  );
}
