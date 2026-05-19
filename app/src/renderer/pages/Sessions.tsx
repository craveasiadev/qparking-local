import { useEffect, useMemo, useState } from 'react';
import {
  Car, RefreshCw, ShieldAlert, Pencil, X, Save, Calculator,
  Trash2, Loader2, ChevronLeft, ChevronRight, CheckSquare, Square,
} from 'lucide-react';
import type { ParkingLane, ParkingSession, ScopeRate } from '@shared/types';
import { useAsyncAction } from '../hooks/useAsyncAction';

const PAGE_SIZE = 20;

export function Sessions() {
  const [tab, setTab] = useState<'open' | 'recent'>('open');
  const [rows, setRows] = useState<ParkingSession[]>([]);
  const [counts, setCounts] = useState({ open: 0, total: 0 });
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<ParkingSession | null>(null);
  const [releasing, setReleasing] = useState<ParkingSession | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [scopes, setScopes] = useState<ScopeRate[]>([]);
  const [lanes, setLanes] = useState<ParkingLane[]>([]);
  // Tick every 30s so live fee previews on OPEN sessions advance.
  const [, setTick] = useState(0);
  useEffect(() => { const h = setInterval(() => setTick((n) => n + 1), 30_000); return () => clearInterval(h); }, []);

  const totalForTab = tab === 'open' ? counts.open : counts.total;
  const pageCount = Math.max(1, Math.ceil(totalForTab / PAGE_SIZE));
  const offset = page * PAGE_SIZE;

  async function fetchPage() {
    const result = await window.bridge.listSessionsPage({ tab, limit: PAGE_SIZE, offset });
    setRows(result.rows);
    setCounts(result.counts);
    // If we deleted enough rows to exit the current page's range, step back.
    const newTotal = tab === 'open' ? result.counts.open : result.counts.total;
    const lastValidPage = Math.max(0, Math.ceil(newTotal / PAGE_SIZE) - 1);
    if (page > lastValidPage) setPage(lastValidPage);
  }

  async function fetchAux() {
    setScopes(await window.bridge.listScopes());
    setLanes(await window.bridge.listLanes());
  }

  const [runRefresh, refreshing] = useAsyncAction(async () => {
    await Promise.all([fetchPage(), fetchAux()]);
  });

  // Reload when tab/page changes.
  useEffect(() => { void fetchPage(); void fetchAux(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tab, page]);
  // Reload on backend session events (entry/exit-completed/etc).
  useEffect(() => {
    const off = window.bridge.onEvent('session', () => { void fetchPage(); });
    return off;
  }, [tab, page]);
  // Clear selection when switching tab/page.
  useEffect(() => { setSelected(new Set()); }, [tab, page]);

  function scopeForSession(s: ParkingSession): ScopeRate | null {
    const laneId = s.exitLaneId ?? s.entryLaneId;
    if (!laneId) return null;
    const lane = lanes.find((l) => l.id === laneId);
    if (!lane?.scopeId) return null;
    return scopes.find((sc) => sc.scopeId === lane.scopeId) ?? null;
  }

  const allOnPageSelected = useMemo(
    () => rows.length > 0 && rows.every((r) => selected.has(r.id)),
    [rows, selected]
  );
  function togglePageSelection() {
    if (allOnPageSelected) {
      const next = new Set(selected);
      rows.forEach((r) => next.delete(r.id));
      setSelected(next);
    } else {
      const next = new Set(selected);
      rows.forEach((r) => next.add(r.id));
      setSelected(next);
    }
  }
  function toggleRow(id: number) {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  }

  const [runDeleteOne, deletingOne] = useAsyncAction(async (id: number) => {
    await window.bridge.deleteSession(id);
    await fetchPage();
  });

  const [runBulkDelete, bulkDeleting] = useAsyncAction(async () => {
    await window.bridge.deleteSessionsBulk({ ids: [...selected] });
    setSelected(new Set());
    setConfirmDelete(false);
    await fetchPage();
  });

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto">
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Sessions</h1>
          <p className="text-xs sm:text-sm text-gray-500 mt-1">Every parking entry/exit recorded by this server.</p>
        </div>
        <button
          onClick={() => runRefresh()}
          disabled={refreshing}
          className="inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-lg border border-gray-200 hover:border-gray-900 text-xs font-bold uppercase tracking-wide disabled:opacity-50 self-start sm:self-auto"
        >
          {refreshing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          Refresh
        </button>
      </header>

      {/* Tabs + bulk-action bar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-3">
        <div className="inline-flex bg-gray-100 rounded-lg p-1 gap-1 self-start">
          {(['open', 'recent'] as const).map((t) => (
            <button
              key={t}
              onClick={() => { setTab(t); setPage(0); }}
              className={`h-9 px-4 rounded-md text-xs font-bold uppercase tracking-wide transition-colors ${tab === t ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}
            >
              {t === 'open' ? `Open (${counts.open})` : `Recent (${counts.total})`}
            </button>
          ))}
        </div>

        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold text-gray-700">{selected.size} selected</span>
            <button
              onClick={() => setConfirmDelete(true)}
              disabled={bulkDeleting}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50"
            >
              {bulkDeleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
              Delete selected
            </button>
            <button onClick={() => setSelected(new Set())} className="text-xs font-bold uppercase tracking-wide text-gray-500 hover:text-gray-800 px-2">
              Clear
            </button>
          </div>
        )}
      </div>

      {/* DESKTOP/TABLET TABLE — hidden on mobile (md and up). */}
      <div className="hidden md:block rounded-xl border border-gray-200 bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[760px]">
            <thead className="bg-gray-50 text-[10px] uppercase tracking-widest text-gray-500">
              <tr>
                <th className="w-10 px-3 py-2">
                  <button onClick={togglePageSelection} className="inline-flex items-center text-gray-500 hover:text-gray-900" title={allOnPageSelected ? 'Deselect page' : 'Select page'}>
                    {allOnPageSelected ? <CheckSquare size={15} /> : <Square size={15} />}
                  </button>
                </th>
                <th className="text-left px-3 py-2 font-bold">Plate</th>
                <th className="text-left px-3 py-2 font-bold">Entered</th>
                <th className="text-left px-3 py-2 font-bold">Exited</th>
                <th className="text-right px-3 py-2 font-bold">Duration</th>
                <th className="text-right px-3 py-2 font-bold">Fee</th>
                <th className="text-left px-3 py-2 font-bold">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const mins = s.durationMinutes ?? (s.exitAt ? null : Math.ceil((Date.now() - Date.parse(s.entryAt)) / 60_000));
                let displayFeeCents: number | null = s.feeCents ?? null;
                let isLivePreview = false;
                if (displayFeeCents == null && !s.exitAt && mins != null) {
                  const sc = scopeForSession(s);
                  if (sc) { displayFeeCents = computeFeeFromScope(mins, sc); isLivePreview = true; }
                }
                const isSelected = selected.has(s.id);
                return (
                  <tr key={s.id} className={`border-t border-gray-100 ${isSelected ? 'bg-blue-50/40' : ''}`}>
                    <td className="px-3 py-2">
                      <button onClick={() => toggleRow(s.id)} className="inline-flex items-center text-gray-500 hover:text-gray-900">
                        {isSelected ? <CheckSquare size={15} /> : <Square size={15} />}
                      </button>
                    </td>
                    <td className="px-3 py-2 font-mono font-bold">{s.plate}</td>
                    <td className="px-3 py-2 text-xs text-gray-600">{new Date(s.entryAt).toLocaleString()}</td>
                    <td className="px-3 py-2 text-xs text-gray-600">{s.exitAt ? new Date(s.exitAt).toLocaleString() : '—'}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{mins != null ? `${Math.floor(mins / 60)}h ${mins % 60}m` : '—'}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {displayFeeCents != null
                        ? <span className={isLivePreview ? 'text-amber-700' : ''} title={isLivePreview ? 'Live preview — final fee charged at exit' : undefined}>
                            RM {(displayFeeCents / 100).toFixed(2)}{isLivePreview && '*'}
                          </span>
                        : '—'}
                    </td>
                    <td className="px-3 py-2"><StatusBadge status={s.paymentStatus} /></td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <button onClick={() => setEditing(s)} className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wide font-bold text-gray-600 hover:text-gray-900 mr-2">
                        <Pencil size={11} /> Edit
                      </button>
                      {!s.exitAt && (
                        <button onClick={() => setReleasing(s)} className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wide font-bold text-amber-700 hover:text-amber-900 mr-2">
                          <ShieldAlert size={11} /> Release
                        </button>
                      )}
                      <button
                        onClick={() => runDeleteOne(s.id)}
                        disabled={deletingOne}
                        className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wide font-bold text-red-700 hover:text-red-900 disabled:opacity-50"
                        title="Delete this session"
                      >
                        {deletingOne ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />} Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={8} className="p-8 text-center text-sm text-gray-500"><Car size={16} className="inline mr-1 text-gray-400" /> Nothing here yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* MOBILE CARDS — visible on small screens. */}
      <div className="md:hidden space-y-2">
        {rows.length === 0 && (
          <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
            <Car size={18} className="inline mr-1 text-gray-400" /> Nothing here yet.
          </div>
        )}
        {rows.map((s) => {
          const mins = s.durationMinutes ?? (s.exitAt ? null : Math.ceil((Date.now() - Date.parse(s.entryAt)) / 60_000));
          let displayFeeCents: number | null = s.feeCents ?? null;
          let isLivePreview = false;
          if (displayFeeCents == null && !s.exitAt && mins != null) {
            const sc = scopeForSession(s);
            if (sc) { displayFeeCents = computeFeeFromScope(mins, sc); isLivePreview = true; }
          }
          const isSelected = selected.has(s.id);
          return (
            <div key={s.id} className={`rounded-xl border bg-white p-3 ${isSelected ? 'border-blue-300 bg-blue-50/30' : 'border-gray-200'}`}>
              <div className="flex items-start gap-3">
                <button onClick={() => toggleRow(s.id)} className="mt-0.5 text-gray-500">
                  {isSelected ? <CheckSquare size={17} /> : <Square size={17} />}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono font-bold text-base">{s.plate}</span>
                    <StatusBadge status={s.paymentStatus} />
                  </div>
                  <div className="mt-1 text-[11px] text-gray-600 grid grid-cols-2 gap-x-3 gap-y-0.5">
                    <span><span className="text-gray-400">In:</span> {new Date(s.entryAt).toLocaleString()}</span>
                    <span><span className="text-gray-400">Out:</span> {s.exitAt ? new Date(s.exitAt).toLocaleString() : '—'}</span>
                    <span className="font-mono"><span className="text-gray-400">Dur:</span> {mins != null ? `${Math.floor(mins / 60)}h ${mins % 60}m` : '—'}</span>
                    <span className="font-mono">
                      <span className="text-gray-400">Fee:</span>{' '}
                      {displayFeeCents != null
                        ? <span className={isLivePreview ? 'text-amber-700' : ''}>RM {(displayFeeCents / 100).toFixed(2)}{isLivePreview && '*'}</span>
                        : '—'}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button onClick={() => setEditing(s)} className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wide font-bold text-gray-700 hover:text-gray-900">
                      <Pencil size={11} /> Edit
                    </button>
                    {!s.exitAt && (
                      <button onClick={() => setReleasing(s)} className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wide font-bold text-amber-700 hover:text-amber-900">
                        <ShieldAlert size={11} /> Release
                      </button>
                    )}
                    <button
                      onClick={() => runDeleteOne(s.id)}
                      disabled={deletingOne}
                      className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wide font-bold text-red-700 hover:text-red-900 disabled:opacity-50"
                    >
                      {deletingOne ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />} Delete
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Pagination + footnote */}
      <div className="mt-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <p className="text-[11px] text-gray-500">
          {rows.length > 0 && (
            <>Showing {offset + 1}–{offset + rows.length} of {totalForTab}</>
          )}
        </p>
        {pageCount > 1 && (
          <div className="inline-flex items-center gap-1 self-start sm:self-auto">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="inline-flex items-center justify-center h-9 w-9 rounded-lg border border-gray-200 hover:border-gray-900 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ChevronLeft size={15} />
            </button>
            <span className="text-xs font-bold tabular-nums px-3">Page {page + 1} / {pageCount}</span>
            <button
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={page >= pageCount - 1}
              className="inline-flex items-center justify-center h-9 w-9 rounded-lg border border-gray-200 hover:border-gray-900 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ChevronRight size={15} />
            </button>
          </div>
        )}
      </div>

      {rows.some((s) => !s.exitAt && s.feeCents == null) && (
        <p className="mt-3 text-[11px] text-gray-500">
          <span className="text-amber-700 font-bold">RM 0.00*</span> = live preview using the entry lane's current rate. Final fee is locked in at exit.
        </p>
      )}

      {editing && (
        <EditSessionModal
          session={editing}
          scopes={scopes}
          defaultScope={scopeForSession(editing)}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await fetchPage(); }}
        />
      )}

      {releasing && (
        <ReleaseSessionModal
          session={releasing}
          onClose={() => setReleasing(null)}
          onReleased={async () => { setReleasing(null); await fetchPage(); }}
        />
      )}

      {confirmDelete && (
        <ConfirmModal
          title={`Delete ${selected.size} session${selected.size === 1 ? '' : 's'}?`}
          body={`The selected session${selected.size === 1 ? '' : 's'} will be permanently removed from the local database. This cannot be undone.`}
          confirmLabel="Delete"
          confirmTone="red"
          busy={bulkDeleting}
          onClose={() => setConfirmDelete(false)}
          onConfirm={() => runBulkDelete()}
        />
      )}
    </div>
  );
}

function computeFeeFromScope(durationMinutes: number, sc: ScopeRate): number {
  const billable = Math.max(0, durationMinutes - sc.freeMinutes);
  if (billable === 0) return 0;
  const blocks = Math.ceil(billable / Math.max(1, sc.blockMinutes));
  let cents = sc.firstBlockCents + Math.max(0, blocks - 1) * sc.perBlockCents;
  if (sc.dailyCapCents > 0 && cents > sc.dailyCapCents) cents = sc.dailyCapCents;
  return cents;
}

/**
 * Inline manual-release modal (window.prompt is disabled in Electron's
 * renderer — silent returns make clicks look like no-ops).
 */
function ReleaseSessionModal({
  session, onClose, onReleased,
}: { session: ParkingSession; onClose: () => void; onReleased: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [go, busy] = useAsyncAction(async () => {
    if (!reason.trim()) { setError('Reason is required.'); return; }
    setError(null);
    await window.bridge.manualReleaseSession(session.id, reason.trim());
    onReleased();
  }, { onError: (e: any) => setError(e?.message ?? String(e)) });

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden">
        <header className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold inline-flex items-center gap-2"><ShieldAlert size={16} className="text-amber-600" /> Manual release</h2>
            <p className="text-xs text-gray-500 mt-0.5">Closes the session WITHOUT a terminal payment. Audit trail only — gate isn't opened.</p>
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-lg hover:bg-gray-100 inline-flex items-center justify-center text-gray-500"><X size={18} /></button>
        </header>
        <div className="p-5 space-y-3">
          {error && <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 text-xs px-3 py-2">{error}</div>}
          <div className="text-sm">
            <span className="text-gray-500">Plate:</span> <span className="font-mono font-bold">{session.plate}</span>
            <span className="text-gray-400 mx-2">·</span>
            <span className="text-gray-500">Entered:</span> <span className="font-mono text-xs">{new Date(session.entryAt).toLocaleString()}</span>
          </div>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-600 mb-1">Reason (required)</label>
            <textarea
              autoFocus
              className="w-full min-h-[80px] px-3 py-2 text-sm border border-gray-300 rounded-lg outline-none focus:border-gray-900"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder='e.g. "VIP override", "terminal offline", "duplicate plate detection"'
            />
          </div>
        </div>
        <footer className="px-5 py-3 border-t border-gray-200 flex items-center justify-end gap-2">
          <button onClick={onClose} className="text-xs font-bold uppercase tracking-wide text-gray-600 hover:text-gray-900 px-3">Cancel</button>
          <button onClick={() => go()} disabled={busy || !reason.trim()}
            className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50">
            {busy ? <Loader2 size={13} className="animate-spin" /> : <ShieldAlert size={13} />}
            {busy ? 'Releasing…' : 'Release session'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function EditSessionModal({
  session, scopes, defaultScope, onClose, onSaved,
}: { session: ParkingSession; scopes: ScopeRate[]; defaultScope: ScopeRate | null; onClose: () => void; onSaved: () => void }) {
  const [plate, setPlate] = useState(session.plate);
  const [entryAt, setEntryAt] = useState(toLocalInput(session.entryAt));
  const [exitAt, setExitAt] = useState(session.exitAt ? toLocalInput(session.exitAt) : toLocalInput(new Date().toISOString()));
  const [paymentStatus, setPaymentStatus] = useState<ParkingSession['paymentStatus']>(session.paymentStatus);
  const [notes, setNotes] = useState(session.notes ?? '');
  const [scopeOverride, setScopeOverride] = useState('');
  const [error, setError] = useState<string | null>(null);

  const previewDurationMinutes = (() => {
    if (!exitAt) return null;
    const e = Date.parse(toIso(entryAt));
    const x = Date.parse(toIso(exitAt));
    if (isNaN(e) || isNaN(x)) return null;
    return Math.max(0, Math.ceil((x - e) / 60_000));
  })();
  const previewScope = scopeOverride ? scopes.find((s) => s.scopeId === scopeOverride) ?? null : defaultScope;
  const previewFee = (() => {
    if (previewDurationMinutes == null) return null;
    if (!previewScope) return null;
    const billable = Math.max(0, previewDurationMinutes - previewScope.freeMinutes);
    if (billable === 0) return 0;
    const blocks = Math.ceil(billable / Math.max(1, previewScope.blockMinutes));
    let cents = previewScope.firstBlockCents + Math.max(0, blocks - 1) * previewScope.perBlockCents;
    if (previewScope.dailyCapCents > 0 && cents > previewScope.dailyCapCents) cents = previewScope.dailyCapCents;
    return cents;
  })();

  const [save, saving] = useAsyncAction(async () => {
    setError(null);
    await window.bridge.updateSession(session.id, {
      plate: plate.trim().toUpperCase(),
      entryAt: toIso(entryAt),
      exitAt: exitAt ? toIso(exitAt) : null,
      paymentStatus,
      notes: notes.trim() || undefined,
      scopeIdOverride: scopeOverride || null,
    });
    onSaved();
  }, { onError: (e: any) => setError(e?.message ?? String(e)) });

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-2xl bg-white rounded-2xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
        <header className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold">Edit session #{session.id}</h2>
            <p className="text-xs text-gray-500 mt-0.5">Tweak times to verify the fee calculation. Saving recomputes duration + fee server-side.</p>
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-lg hover:bg-gray-100 inline-flex items-center justify-center text-gray-500"><X size={18} /></button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {error && <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 text-xs px-3 py-2">{error}</div>}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Plate">
              <input className="input font-mono" value={plate} onChange={(e) => setPlate(e.target.value)} />
            </Field>
            <Field label="Payment status">
              <select className="input" value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value as any)}>
                <option value="pending">pending</option>
                <option value="paid">paid</option>
                <option value="declined">declined</option>
                <option value="cancelled">cancelled</option>
                <option value="free">free</option>
                <option value="manual_release">manual_release</option>
              </select>
            </Field>
            <Field label="Entry time">
              <input type="datetime-local" className="input" value={entryAt} onChange={(e) => setEntryAt(e.target.value)} step="1" />
            </Field>
            <Field label="Exit time (blank = still inside)">
              <input type="datetime-local" className="input" value={exitAt} onChange={(e) => setExitAt(e.target.value)} step="1" />
            </Field>
            <Field label={`Scope (default: ${defaultScope?.scopeName ?? 'lane has no scope'})`}>
              <select className="input" value={scopeOverride} onChange={(e) => setScopeOverride(e.target.value)}>
                <option value="">— use lane's scope ({defaultScope?.scopeName ?? 'none'}) —</option>
                {scopes.map((sc) => <option key={sc.scopeId} value={sc.scopeId}>{sc.scopeName}</option>)}
              </select>
            </Field>
            <div className="sm:col-span-2">
              <Field label="Notes">
                <textarea className="input min-h-[60px]" value={notes} onChange={(e) => setNotes(e.target.value)} />
              </Field>
            </div>
          </div>

          <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
            <div className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">
              <Calculator size={11} /> Preview
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-gray-500">Duration</div>
                <div className="font-mono font-bold mt-0.5">{previewDurationMinutes != null ? `${Math.floor(previewDurationMinutes / 60)}h ${previewDurationMinutes % 60}m (${previewDurationMinutes} min)` : '—'}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-gray-500">Fee</div>
                <div className="font-mono font-bold mt-0.5">
                  {previewFee != null
                    ? `RM ${(previewFee / 100).toFixed(2)}`
                    : <span className="text-gray-400 italic">{previewScope ? 'set entry & exit to preview' : 'session has no scope — pick one above'}</span>}
                </div>
              </div>
            </div>
          </div>
        </div>

        <footer className="px-5 py-3 border-t border-gray-200 flex items-center justify-end gap-2">
          <button onClick={onClose} className="text-xs font-bold uppercase tracking-wide text-gray-600 hover:text-gray-900 px-3">Cancel</button>
          <button onClick={() => save()} disabled={saving}
            className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50">
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            {saving ? 'Saving…' : 'Save + recalc'}
          </button>
        </footer>
        <style>{`.input { height: 38px; padding: 0 0.625rem; border: 1px solid #d1d5db; border-radius: 0.5rem; outline: none; font-size: 13px; width: 100%; background: white; } textarea.input { padding: 0.5rem 0.625rem; height: auto; } .input:focus { border-color: #111827; }`}</style>
      </div>
    </div>
  );
}

function ConfirmModal({
  title, body, confirmLabel, confirmTone, busy, onClose, onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  confirmTone: 'red' | 'amber' | 'gray';
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const toneClass = confirmTone === 'red'
    ? 'bg-red-600 hover:bg-red-700'
    : confirmTone === 'amber'
      ? 'bg-amber-600 hover:bg-amber-700'
      : 'bg-gray-900 hover:bg-gray-800';
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden">
        <header className="px-5 py-4 border-b border-gray-200">
          <h2 className="text-base font-bold">{title}</h2>
        </header>
        <div className="p-5">
          <p className="text-sm text-gray-700">{body}</p>
        </div>
        <footer className="px-5 py-3 border-t border-gray-200 flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="text-xs font-bold uppercase tracking-wide text-gray-600 hover:text-gray-900 px-3 disabled:opacity-50">Cancel</button>
          <button onClick={onConfirm} disabled={busy}
            className={`inline-flex items-center gap-1.5 h-10 px-4 rounded-lg ${toneClass} text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50`}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
            {busy ? 'Working…' : confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-600 mb-1">{label}</label>
      {children}
    </div>
  );
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function toIso(local: string): string {
  if (!local) return new Date().toISOString();
  return new Date(local).toISOString();
}

function StatusBadge({ status }: { status: ParkingSession['paymentStatus'] }) {
  const map: Record<ParkingSession['paymentStatus'], string> = {
    pending: 'bg-amber-50 text-amber-800 border-amber-200',
    paid: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    declined: 'bg-red-50 text-red-700 border-red-200',
    cancelled: 'bg-gray-100 text-gray-600 border-gray-200',
    free: 'bg-sky-50 text-sky-800 border-sky-200',
    manual_release: 'bg-purple-50 text-purple-800 border-purple-200',
  };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border ${map[status]}`}>{status.replace('_', ' ')}</span>;
}
