import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Car, RefreshCw, ShieldAlert, Pencil, X, Save, Calculator, Search,
  Trash2, Loader2, ChevronLeft, ChevronRight, CheckSquare, Square,
  Image as ImageIcon, Zap, ArrowDown, ArrowUp, Eye, Filter,
  LogIn, LogOut, Clock, Banknote,
} from 'lucide-react';
import type { ParkingLane, ParkingSession, RatePolicy, LprCamera } from '@shared/types';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { fmtDateTime, fmtTimeSeconds } from '../lib/datetime';

const PAGE_SIZE = 20;

/** A session row plus the server-computed live fee for OPEN sessions. The UI
 *  can't run the rules-aware fee calc (it lives in the main process and honours
 *  the tariff_rules schedule), so the page response attaches the real number. */
type SessionRow = ParkingSession & { livePreviewFeeCents?: number | null };

interface DateRangeFilters {
  entryFrom: string;
  entryTo: string;
  exitFrom: string;
  exitTo: string;
}

const EMPTY_RANGE: DateRangeFilters = { entryFrom: '', entryTo: '', exitFrom: '', exitTo: '' };

// ─── Esc-to-close, stacked ───────────────────────────────────────────────────
// A module-level stack so that when modals nest (e.g. the delete-confirm over
// the detail modal, or an enlarged capture over the detail modal), Escape only
// dismisses the TOP-most one. Each modal registers on mount and pops on unmount;
// the last registered wins.
const escapeStack: Array<() => void> = [];
function handleGlobalEsc(e: KeyboardEvent) {
  if (e.key === 'Escape' && escapeStack.length > 0) escapeStack[escapeStack.length - 1]();
}
function useEscapeToClose(onClose: () => void) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    const cb = () => ref.current();
    if (escapeStack.length === 0) window.addEventListener('keydown', handleGlobalEsc);
    escapeStack.push(cb);
    return () => {
      const i = escapeStack.lastIndexOf(cb);
      if (i >= 0) escapeStack.splice(i, 1);
      if (escapeStack.length === 0) window.removeEventListener('keydown', handleGlobalEsc);
    };
  }, []);
}

/**
 * Hidden dev/QA tool (rendered only when devMode is on). Drives the REAL
 * parking flow with operator-controlled times:
 *   - Entry → opens a session stamped with the chosen entry time.
 *   - Exit  → runs the real exit at the chosen exit time: prices the stay,
 *             prompts a wired terminal to tap, records + opens the gate.
 *   - Simulate session → one-shot completed stay (entry→exit) with the computed
 *             fee, no terminal/gate — for pure pricing checks.
 * Actions route through an enabled camera on the lane, exercising the actual
 * routing → fee → gate → terminal chain, not a mock.
 */
function DevSimulator({ lanes, onSessionCreated }: { lanes: ParkingLane[]; onSessionCreated?: () => void }) {
  const [plate, setPlate] = useState('');
  const [laneId, setLaneId] = useState<number | ''>('');
  const [busy, setBusy] = useState<string | null>(null);
  // Default to a 1-hour stay ending now, so the fee is non-zero out of the box.
  // (toLocalInput / toIso are the shared datetime-local <-> ISO helpers below.)
  const [entryLocal, setEntryLocal] = useState(() => toLocalInput(new Date(Date.now() - 60 * 60_000).toISOString()));
  const [exitLocal, setExitLocal] = useState(() => toLocalInput(new Date().toISOString()));
  const [log, setLog] = useState<{ ts: number; tone: 'in'|'pay'|'out'|'warn'|'info'; text: string }[]>([]);

  const push = (tone: 'in'|'pay'|'out'|'warn'|'info', text: string) =>
    setLog((cur) => [{ ts: Date.now(), tone, text }, ...cur].slice(0, 25));

  // Latest refresh callback — lets the async exit event stream refresh the
  // table without a stale closure.
  const refreshRef = useRef(onSessionCreated);
  refreshRef.current = onSessionCreated;

  // Translate the real parking-flow event stream (index.ts fans these out on
  // the 'session' channel) into a readable action timeline.
  useEffect(() => {
    const off = window.bridge.onEvent('session', (p: any) => {
      const kind = p?.kind; const d = p?.payload ?? {};
      if (kind === 'entry') push('in', `Entry recorded — barrier OPEN (${d?.session?.plate ?? '?'})`);
      else if (kind === 'rescan-ignored') push('info', 'Re-scan ignored — plate already inside');
      else if (kind === 'exit-pending') push('pay', `Payment pending — RM ${((d?.feeCents ?? 0) / 100).toFixed(2)} · ${d?.durationMinutes ?? '?'} min`);
      else if (kind === 'exit-completed') {
        const opened = ['paid','free','manual_release'].includes(d?.outcome);
        push('out', `Exit ${String(d?.outcome ?? '?').toUpperCase()} — barrier ${opened ? 'OPEN' : 'stays CLOSED'}`);
        refreshRef.current?.();
      } else if (kind === 'warning') push('warn', `⚠ ${d?.kind ?? 'warning'}${d?.connState ? ` (${d.connState})` : ''}`);
    });
    return off;
  }, []);

  function baseGuard(): number | null {
    if (!plate.trim()) { push('warn', '✗ Enter a plate first'); return null; }
    if (laneId === '') { push('warn', '✗ Select a lane first'); return null; }
    return Number(laneId);
  }

  // Entry — open a session stamped with the chosen entry time (no gate/terminal).
  async function fireEntry() {
    const lid = baseGuard(); if (lid === null) return;
    if (!entryLocal) { push('warn', '✗ Set an entry time'); return; }
    setBusy('entry');
    try {
      const r = await window.bridge.simulateEntry(lid, plate.trim(), toIso(entryLocal));
      if (!r?.ok) push('warn', `✗ entry: ${r?.error ?? 'failed'}`);
      else { push('in', `Entry stored — ${fmtDateTime(toIso(entryLocal))} (session #${r.sessionId})`); refreshRef.current?.(); }
    } finally { setBusy(null); }
  }

  // Exit — run the REAL exit flow at the chosen exit time (prices the stay +
  // prompts the terminal). Outcome arrives on the 'session' event stream above.
  async function fireExit() {
    const lid = baseGuard(); if (lid === null) return;
    if (!exitLocal) { push('warn', '✗ Set an exit time'); return; }
    setBusy('exit');
    try {
      const r = await window.bridge.simulateExit(lid, plate.trim(), toIso(exitLocal));
      if (!r?.ok) push('warn', `✗ exit: ${r?.error ?? 'failed'}`);
    } finally { setBusy(null); }
  }

  // One-shot: record a completed session over the entry→exit window — computes
  // the fee from the lane's plan (no terminal/gate; local only).
  async function fireSession() {
    const lid = baseGuard(); if (lid === null) return;
    const entryIso = toIso(entryLocal);
    const exitIso = toIso(exitLocal);
    if (Date.parse(exitIso) < Date.parse(entryIso)) { push('warn', '✗ Exit time is before entry time'); return; }
    setBusy('session');
    try {
      const r = await window.bridge.simulateSession(lid, plate.trim(), entryIso, exitIso);
      if (!r?.ok) { push('warn', `✗ session: ${r?.error ?? 'failed'}`); return; }
      const rm = ((r.feeCents ?? 0) / 100).toFixed(2);
      push('out', `Session #${r.sessionId} recorded — ${r.durationMinutes} min · ${r.scopeName ?? 'no plan'} · RM ${rm} · ${String(r.paymentStatus ?? '').toUpperCase()}`);
      refreshRef.current?.();
    } finally { setBusy(null); }
  }

  const toneCls: Record<string, string> = {
    in: 'text-emerald-700', pay: 'text-blue-700', out: 'text-emerald-700',
    warn: 'text-red-700', info: 'text-gray-500',
  };

  return (
    <div className="mb-4 rounded-xl border-2 border-dashed border-fuchsia-300 bg-fuchsia-50/40 p-4">
      <div className="flex items-center gap-2 mb-1">
        <Zap size={14} className="text-fuchsia-600" />
        <h3 className="text-sm font-bold text-fuchsia-800 uppercase tracking-wide">Dev simulator</h3>
        <span className="text-[10px] font-bold uppercase tracking-wider text-fuchsia-500">QA only</span>
      </div>
      <p className="text-[11px] text-gray-500 mb-3">
        Drives the <strong>real</strong> flow with times you control. <strong>Entry</strong> opens a session at the entry time;
        <strong> Exit</strong> prices the stay and prompts a wired terminal to tap. <strong>Simulate session</strong> writes a completed
        stay in one shot (no terminal). Pick the lane that has the plan + terminal you're testing.
      </p>
      <div className="flex flex-wrap items-end gap-2 mb-2">
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-wide text-gray-500 mb-1">Plate</label>
          <input value={plate} onChange={(e) => setPlate(e.target.value)} placeholder="VMM1234"
            className="h-9 w-36 px-2 rounded-lg border border-gray-300 text-sm font-mono uppercase" />
        </div>
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-wide text-gray-500 mb-1">Lane</label>
          <select value={laneId} onChange={(e) => setLaneId(e.target.value ? Number(e.target.value) : '')}
            className="h-9 px-2 rounded-lg border border-gray-300 text-sm min-w-[10rem]">
            <option value="">— select lane —</option>
            {lanes.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        {log.length > 0 && (
          <button onClick={() => setLog([])} className="h-9 px-2 text-[11px] font-bold uppercase tracking-wide text-gray-500 hover:text-gray-900">Clear log</button>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-2 mb-2">
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-wide text-gray-500 mb-1">Entry time</label>
          <input type="datetime-local" value={entryLocal} onChange={(e) => setEntryLocal(e.target.value)}
            className="h-9 px-2 rounded-lg border border-gray-300 text-sm" />
        </div>
        <button onClick={() => fireEntry()} disabled={!!busy}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50">
          {busy === 'entry' ? <Loader2 size={13} className="animate-spin" /> : <ArrowDown size={13} />} Entry
        </button>
        <span className="text-[11px] text-gray-400 pb-2">opens a session stamped at this time</span>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-wide text-gray-500 mb-1">Exit time</label>
          <input type="datetime-local" value={exitLocal} onChange={(e) => setExitLocal(e.target.value)}
            className="h-9 px-2 rounded-lg border border-gray-300 text-sm" />
        </div>
        <button onClick={() => fireExit()} disabled={!!busy}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50">
          {busy === 'exit' ? <Loader2 size={13} className="animate-spin" /> : <ArrowUp size={13} />} Exit
        </button>
        <button onClick={() => fireSession()} disabled={!!busy}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-700 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50">
          {busy === 'session' ? <Loader2 size={13} className="animate-spin" /> : <Car size={13} />} Simulate session
        </button>
      </div>

      {log.length > 0 && (
        <div className="mt-3 rounded-lg border border-gray-200 bg-white divide-y divide-gray-100 max-h-52 overflow-auto">
          {log.map((e, i) => (
            <div key={i} className="flex items-baseline gap-2 px-3 py-1.5 text-xs font-mono">
              <span className="text-gray-400 tabular-nums">{fmtTimeSeconds(new Date(e.ts).toISOString())}</span>
              <span className={toneCls[e.tone]}>{e.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Sessions({ devMode = false }: { devMode?: boolean }) {
  // Single list of every session (no open/recent tabs). The status filter below
  // scopes it — defaulting to "pending" so unpaid / still-inside cars surface
  // first, which is what an operator most often needs to act on.
  const tab = 'recent' as const;
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [counts, setCounts] = useState({ open: 0, total: 0 });
  const [page, setPage] = useState(0);
  const [plateSearch, setPlateSearch] = useState('');
  const [debouncedPlateSearch, setDebouncedPlateSearch] = useState('');
  const [range, setRange] = useState<DateRangeFilters>(EMPTY_RANGE);
  const [debouncedRange, setDebouncedRange] = useState<DateRangeFilters>(EMPTY_RANGE);
  const [statusFilter, setStatusFilter] = useState('pending');
  const [sessionStatusFilter, setSessionStatusFilter] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  useEffect(() => {
    const h = setTimeout(() => setDebouncedPlateSearch(plateSearch.trim()), 300);
    return () => clearTimeout(h);
  }, [plateSearch]);
  useEffect(() => {
    const h = setTimeout(() => setDebouncedRange(range), 300);
    return () => clearTimeout(h);
  }, [range]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [viewing, setViewing] = useState<SessionRow | null>(null);
  const [editing, setEditing] = useState<ParkingSession | null>(null);
  const [releasing, setReleasing] = useState<{ session: SessionRow; laneId: number | null } | null>(null);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [retriggerNotice, setRetriggerNotice] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [policies, setPolicies] = useState<RatePolicy[]>([]);
  const [lanes, setLanes] = useState<ParkingLane[]>([]);
  const [cameras, setCameras] = useState<LprCamera[]>([]);
  const [pageLoading, setPageLoading] = useState(false);
  const [, setTick] = useState(0);
  useEffect(() => { const h = setInterval(() => setTick((n) => n + 1), 30_000); return () => clearInterval(h); }, []);

  const totalForTab = counts.total;
  const pageCount = Math.max(1, Math.ceil(totalForTab / PAGE_SIZE));
  const offset = page * PAGE_SIZE;

  const activeFilterCount = useMemo(() => {
    return (['entryFrom', 'entryTo', 'exitFrom', 'exitTo'] as const)
      .filter((k) => debouncedRange[k]).length;
  }, [debouncedRange]);

  async function fetchPage() {
    setPageLoading(true);
    try {
      const result = await window.bridge.listSessionsPage({
        tab,
        limit: PAGE_SIZE,
        offset,
        plateSearch: debouncedPlateSearch || null,
        entryFrom: debouncedRange.entryFrom ? toIso(debouncedRange.entryFrom) : null,
        entryTo: debouncedRange.entryTo ? toIso(debouncedRange.entryTo) : null,
        exitFrom: debouncedRange.exitFrom ? toIso(debouncedRange.exitFrom) : null,
        exitTo: debouncedRange.exitTo ? toIso(debouncedRange.exitTo) : null,
        // A plate search always spans EVERY status — you're hunting a specific
        // car, so scoping to "pending" would hide it if it already paid/left.
        status: debouncedPlateSearch ? null : (sessionStatusFilter || null),
        paymentStatus: debouncedPlateSearch ? null : (statusFilter || null),
      });
      setRows(result.rows);
      setCounts(result.counts);
      const newTotal = result.counts.total;
      const lastValidPage = Math.max(0, Math.ceil(newTotal / PAGE_SIZE) - 1);
      if (page > lastValidPage) setPage(lastValidPage);
      if (viewing) {
        const fresh = result.rows.find((r) => r.id === viewing.id);
        if (fresh) setViewing(fresh);
      }
    } finally {
      setPageLoading(false);
    }
  }

  async function fetchAux() {
    setPolicies(await window.bridge.listRatePolicies());
    setLanes(await window.bridge.listLanes());
    setCameras(await window.bridge.listCameras());
  }

  // Exit-capable lanes for the manual-release gate picker. A lane's direction is
  // derived from its cameras (the source of truth): a car can leave through an
  // 'exit' or 'dual' lane. Fall back to all lanes if none qualify, so the
  // operator is never left with an empty picker.
  const exitLanes = (() => {
    const filtered = lanes.filter((l) => {
      const dirs = new Set(cameras.filter((c) => c.laneId === l.id).map((c) => c.direction));
      return dirs.has('exit') || dirs.has('dual');
    });
    return filtered.length > 0 ? filtered : lanes;
  })();

  const [runRefresh, refreshing] = useAsyncAction(async () => {
    await Promise.all([fetchPage(), fetchAux()]);
  });

  useEffect(() => { void fetchPage(); void fetchAux(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tab, page, debouncedPlateSearch, debouncedRange, statusFilter, sessionStatusFilter]);
  useEffect(() => {
    const off = window.bridge.onEvent('session', () => { void fetchPage(); });
    return off;
  }, [tab, page, debouncedPlateSearch, debouncedRange, statusFilter, sessionStatusFilter]);
  useEffect(() => { setPage(0); }, [debouncedPlateSearch, debouncedRange, statusFilter, sessionStatusFilter]);
  useEffect(() => { setSelected(new Set()); }, [tab, page]);

  function policyForSession(s: ParkingSession): RatePolicy | null {
    const laneId = s.exitLaneId ?? s.entryLaneId;
    if (!laneId) return null;
    const lane = lanes.find((l) => l.id === laneId);
    if (!lane?.policyId) return null;
    return policies.find((sc) => sc.policyId === lane.policyId) ?? null;
  }

  function laneNameForId(id?: number | null): string {
    if (!id) return '—';
    return lanes.find((l) => l.id === id)?.name ?? `Lane #${id}`;
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
    setViewing(null);
    await fetchPage();
  });

  const [runBulkDelete, bulkDeleting] = useAsyncAction(async () => {
    await window.bridge.deleteSessionsBulk({ ids: [...selected] });
    setSelected(new Set());
    setConfirmDelete(false);
    await fetchPage();
  });

  const [runRetrigger, retriggering] = useAsyncAction(async (id: number, plate: string, laneId: number | null) => {
    setRetriggerNotice(null);
    const r = await window.bridge.retriggerSessionPayment(id, laneId);
    if (r.ok) {
      setRetriggerNotice({ tone: 'ok', text: `Retrigger sent for ${plate}. If the fee is RM0 the barrier opens; otherwise the selected gate's terminal is armed for the driver to tap.` });
    } else {
      setRetriggerNotice({ tone: 'err', text: `Couldn't retrigger: ${r.error}` });
    }
    setTimeout(() => setRetriggerNotice(null), 8_000);
  });

  function clearAllFilters() {
    setPlateSearch('');
    setRange(EMPTY_RANGE);
    setStatusFilter('');
    setSessionStatusFilter('');
  }

  // Set the entry-date range to a common preset (local wall-clock → the
  // datetime-local strings RangeInput expects).
  function applyEntryPreset(kind: 'today' | '7d' | '30d') {
    const now = new Date();
    const from = new Date(now);
    if (kind === 'today') from.setHours(0, 0, 0, 0);
    else if (kind === '7d') from.setDate(now.getDate() - 7);
    else from.setDate(now.getDate() - 30);
    setRange((r) => ({ ...r, entryFrom: toLocalInput(from.toISOString()), entryTo: toLocalInput(now.toISOString()) }));
  }

  const hasAnyFilter = !!debouncedPlateSearch || activeFilterCount > 0 || !!statusFilter || !!sessionStatusFilter;

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto">
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

      {/* Search + status + date filters + bulk-action bar */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 mb-3">
        <div className="flex flex-1 items-center gap-2 min-w-0">
          <div className="relative flex-1 sm:max-w-sm">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            <input
              type="text"
              value={plateSearch}
              onChange={(e) => setPlateSearch(e.target.value)}
              placeholder="Search plate… (all statuses)"
              className="w-full h-9 pl-8 pr-8 border border-gray-200 rounded-lg text-sm focus:border-gray-900 outline-none"
            />
            {plateSearch && (
              <button
                onClick={() => setPlateSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700"
              >
                <X size={13} />
              </button>
            )}
          </div>
          <select
            value={sessionStatusFilter}
            onChange={(e) => setSessionStatusFilter(e.target.value)}
            disabled={!!plateSearch.trim()}
            title={plateSearch.trim() ? 'Plate search covers every status' : 'Filter by session status'}
            className="h-9 px-2 rounded-lg border border-gray-200 text-sm focus:border-gray-900 outline-none bg-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value="">All status</option>
            <option value="entered">Entered</option>
            <option value="exited">Exited</option>
            <option value="manual_release">Manual release</option>
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            disabled={!!plateSearch.trim()}
            title={plateSearch.trim() ? 'Plate search covers every payment status' : 'Filter by payment status'}
            className="h-9 px-2 rounded-lg border border-gray-200 text-sm focus:border-gray-900 outline-none bg-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value="">All payment</option>
            <option value="paid">Paid</option>
            <option value="pending">Pending</option>
            <option value="declined">Declined</option>
            <option value="free">Free</option>
            <option value="cancelled">Cancelled</option>
            <option value="manual_release">Manual release</option>
          </select>
          <button
            onClick={() => setFiltersOpen((o) => !o)}
            className={`inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border text-xs font-bold uppercase tracking-wide ${
              filtersOpen || activeFilterCount > 0
                ? 'border-gray-900 bg-gray-900 text-white'
                : 'border-gray-200 hover:border-gray-900'
            }`}
            title="Filter by entry/exit date range — use when the LPR mis-read at a known time"
          >
            <Filter size={13} />
            Filters
            {activeFilterCount > 0 && (
              <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-amber-400 text-gray-900 text-[10px] font-bold">
                {activeFilterCount}
              </span>
            )}
          </button>
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

      {/* Expandable date/time filter panel — for tracing LPR misreads by
          narrowing the search to the exact time window when the driver came
          in or out, even when the plate text is corrupted. */}
      {filtersOpen && (
        <div className="mb-3 rounded-xl border border-gray-200 bg-gray-50 p-4">
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <span className="text-[10px] font-bold uppercase tracking-wide text-gray-500">Quick entry range</span>
            {([['today', 'Today'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days']] as const).map(([k, label]) => (
              <button key={k} onClick={() => applyEntryPreset(k)}
                className="h-7 px-2.5 rounded-md border border-gray-200 bg-white hover:border-gray-900 text-[11px] font-bold uppercase tracking-wide text-gray-600">
                {label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <RangeInput
              label="Entry time"
              hint="e.g. driver entered ~14:30 today — set a ±5 min window"
              from={range.entryFrom}
              to={range.entryTo}
              onChange={(from, to) => setRange((r) => ({ ...r, entryFrom: from, entryTo: to }))}
            />
            <RangeInput
              label="Exit time"
              hint="e.g. exit LPR triggered at 15:07 — narrow to that minute"
              from={range.exitFrom}
              to={range.exitTo}
              onChange={(from, to) => setRange((r) => ({ ...r, exitFrom: from, exitTo: to }))}
            />
          </div>
          {hasAnyFilter && (
            <div className="mt-3 flex items-center justify-end">
              <button
                onClick={clearAllFilters}
                className="text-[11px] font-bold uppercase tracking-wide text-gray-600 hover:text-gray-900"
              >
                Clear all filters
              </button>
            </div>
          )}
        </div>
      )}

      {devMode && <DevSimulator lanes={lanes} onSessionCreated={() => runRefresh()} />}

      {retriggerNotice && (
        <div className={`mb-3 rounded-lg border px-3 py-2 text-xs ${
          retriggerNotice.tone === 'ok'
            ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
            : 'border-red-200 bg-red-50 text-red-800'
        }`}>
          {retriggerNotice.text}
        </div>
      )}

      {/* Results — desktop table + mobile cards share one relative wrapper so a
          single loading overlay can dim them during a fetch. */}
      <div className="relative">
        {pageLoading && (
          <div className="absolute inset-0 z-10 flex items-start justify-center pt-16 bg-white/50 backdrop-blur-[1px] pointer-events-none">
            <span className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-gray-500 bg-white border border-gray-200 rounded-full px-3 py-1.5 shadow-sm">
              <Loader2 size={13} className="animate-spin" /> Loading…
            </span>
          </div>
        )}

      {/* DESKTOP/TABLET TABLE */}
      <div className={`hidden md:block rounded-xl border border-gray-200 bg-white overflow-hidden transition-opacity ${pageLoading ? 'opacity-60' : ''}`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[820px]">
            <thead className="bg-gray-50 text-[10px] uppercase tracking-widest text-gray-500">
              <tr>
                <th className="w-10 px-3 py-2">
                  <button onClick={togglePageSelection} className="inline-flex items-center text-gray-500 hover:text-gray-900" title={allOnPageSelected ? 'Deselect page' : 'Select page'}>
                    {allOnPageSelected ? <CheckSquare size={15} /> : <Square size={15} />}
                  </button>
                </th>
                <th className="text-left px-3 py-2 font-bold">Plate</th>
                <th className="text-left px-3 py-2 font-bold">Captures</th>
                <th className="text-left px-3 py-2 font-bold">Entered</th>
                <th className="text-left px-3 py-2 font-bold">Exited</th>
                <th className="text-right px-3 py-2 font-bold">Duration</th>
                <th className="text-right px-3 py-2 font-bold">Fee</th>
                <th className="text-left px-3 py-2 font-bold">Status</th>
                <th className="text-left px-3 py-2 font-bold">Payment</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const mins = s.durationMinutes ?? (s.exitAt ? null : Math.ceil((Date.now() - Date.parse(s.entryAt)) / 60_000));
                let displayFeeCents: number | null = s.feeCents ?? null;
                let isLivePreview = false;
                if (displayFeeCents == null && !s.exitAt && s.livePreviewFeeCents != null) {
                  displayFeeCents = s.livePreviewFeeCents; isLivePreview = true;
                }
                const isSelected = selected.has(s.id);
                return (
                  <tr key={s.id} onClick={() => setViewing(s)}
                    className={`border-t border-gray-100 cursor-pointer hover:bg-gray-50 ${isSelected ? 'bg-blue-50/40 hover:bg-blue-50/60' : ''}`}>
                    <td className="px-3 py-2">
                      <button onClick={(e) => { e.stopPropagation(); toggleRow(s.id); }} className="inline-flex items-center text-gray-500 hover:text-gray-900">
                        {isSelected ? <CheckSquare size={15} /> : <Square size={15} />}
                      </button>
                    </td>
                    <td className="px-3 py-2 font-mono font-bold">{s.plate}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1">
                        <ThumbCell path={s.entryImagePath} kind="entry" plate={s.plate} onOpen={setPreviewImage} />
                        <ThumbCell path={s.exitImagePath} kind="exit" plate={s.plate} onOpen={setPreviewImage} />
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600">{fmtDateTime(s.entryAt)}</td>
                    <td className="px-3 py-2 text-xs text-gray-600">{fmtDateTime(s.exitAt)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{mins != null ? `${Math.floor(mins / 60)}h ${mins % 60}m` : '—'}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {displayFeeCents != null
                        ? <span className={isLivePreview ? 'text-amber-700' : ''} title={isLivePreview ? 'Live preview — final fee charged at exit' : undefined}>
                            RM {(displayFeeCents / 100).toFixed(2)}{isLivePreview && '*'}
                          </span>
                        : '—'}
                    </td>
                    <td className="px-3 py-2"><SessionStatusBadge status={s.status} /></td>
                    <td className="px-3 py-2"><StatusBadge status={s.paymentStatus} /></td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <button
                        onClick={() => setViewing(s)}
                        className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wide font-bold text-gray-700 hover:text-gray-900 border border-gray-200 hover:border-gray-900 rounded-md px-2 py-1"
                      >
                        <Eye size={12} /> View
                      </button>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={10} className="p-8 text-center text-sm text-gray-500"><Car size={16} className="inline mr-1 text-gray-400" /> {hasAnyFilter ? 'No sessions match the current filters.' : 'Nothing here yet.'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* MOBILE CARDS */}
      <div className={`md:hidden space-y-2 transition-opacity ${pageLoading ? 'opacity-60' : ''}`}>
        {rows.length === 0 && (
          <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
            <Car size={18} className="inline mr-1 text-gray-400" /> {hasAnyFilter ? 'No sessions match the current filters.' : 'Nothing here yet.'}
          </div>
        )}
        {rows.map((s) => {
          const mins = s.durationMinutes ?? (s.exitAt ? null : Math.ceil((Date.now() - Date.parse(s.entryAt)) / 60_000));
          let displayFeeCents: number | null = s.feeCents ?? null;
          let isLivePreview = false;
          if (displayFeeCents == null && !s.exitAt && s.livePreviewFeeCents != null) {
            displayFeeCents = s.livePreviewFeeCents; isLivePreview = true;
          }
          const isSelected = selected.has(s.id);
          return (
            <div key={s.id} onClick={() => setViewing(s)}
              className={`rounded-xl border bg-white p-3 cursor-pointer active:bg-gray-50 ${isSelected ? 'border-blue-300 bg-blue-50/30' : 'border-gray-200'}`}>
              <div className="flex items-start gap-3">
                <button onClick={(e) => { e.stopPropagation(); toggleRow(s.id); }} className="mt-0.5 text-gray-500">
                  {isSelected ? <CheckSquare size={17} /> : <Square size={17} />}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono font-bold text-base">{s.plate}</span>
                    <div className="flex items-center gap-1">
                      <SessionStatusBadge status={s.status} />
                      <StatusBadge status={s.paymentStatus} />
                    </div>
                  </div>
                  <div className="mt-1 text-[11px] text-gray-600 grid grid-cols-2 gap-x-3 gap-y-0.5">
                    <span><span className="text-gray-400">In:</span> {fmtDateTime(s.entryAt)}</span>
                    <span><span className="text-gray-400">Out:</span> {fmtDateTime(s.exitAt)}</span>
                    <span className="font-mono"><span className="text-gray-400">Dur:</span> {mins != null ? `${Math.floor(mins / 60)}h ${mins % 60}m` : '—'}</span>
                    <span className="font-mono">
                      <span className="text-gray-400">Fee:</span>{' '}
                      {displayFeeCents != null
                        ? <span className={isLivePreview ? 'text-amber-700' : ''}>RM {(displayFeeCents / 100).toFixed(2)}{isLivePreview && '*'}</span>
                        : '—'}
                    </span>
                  </div>
                  {(s.entryImagePath || s.exitImagePath) && (
                    <div className="mt-2 flex items-center gap-1">
                      <ThumbCell path={s.entryImagePath} kind="entry" plate={s.plate} onOpen={setPreviewImage} />
                      <ThumbCell path={s.exitImagePath} kind="exit" plate={s.plate} onOpen={setPreviewImage} />
                    </div>
                  )}
                  <div className="mt-2">
                    <button
                      onClick={() => setViewing(s)}
                      className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wide font-bold text-gray-700 hover:text-gray-900 border border-gray-200 hover:border-gray-900 rounded-md px-2 py-1"
                    >
                      <Eye size={12} /> View details
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
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

      {viewing && (
        <ViewSessionModal
          session={viewing}
          policy={policyForSession(viewing)}
          lanes={lanes}
          entryLaneName={laneNameForId(viewing.entryLaneId)}
          exitLaneName={laneNameForId(viewing.exitLaneId)}
          retriggering={retriggering}
          deleting={deletingOne}
          onClose={() => setViewing(null)}
          onOpenImage={setPreviewImage}
          onEdit={() => { setEditing(viewing); }}
          onRelease={(laneId) => { setReleasing({ session: viewing, laneId }); }}
          onRetrigger={(laneId) => runRetrigger(viewing.id, viewing.plate, laneId)}
          onDelete={() => runDeleteOne(viewing.id)}
        />
      )}

      {editing && (
        <EditSessionModal
          session={editing}
          policies={policies}
          defaultPolicy={policyForSession(editing)}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await fetchPage(); }}
        />
      )}

      {releasing && (
        <ReleaseSessionModal
          session={releasing.session}
          lanes={exitLanes}
          defaultLaneId={releasing.laneId}
          onClose={() => setReleasing(null)}
          onReleased={async () => { setReleasing(null); await fetchPage(); }}
        />
      )}

      {previewImage && (
        <ImagePreviewModal src={previewImage} onClose={() => setPreviewImage(null)} />
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

/**
 * Entry + exit datetime range pair. Uses <input type="datetime-local"> so the
 * operator picks a wall-clock instant; we translate to ISO before shipping
 * the query. Both bounds are optional — leaving one blank makes it half-open.
 */
function RangeInput({
  label, hint, from, to, onChange,
}: {
  label: string;
  hint: string;
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-700">{label}</label>
        {(from || to) && (
          <button
            onClick={() => onChange('', '')}
            className="text-[10px] font-bold uppercase tracking-wide text-gray-500 hover:text-gray-900"
          >
            Clear
          </button>
        )}
      </div>
      <p className="text-[10px] text-gray-500 mb-1.5">{hint}</p>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-[9px] uppercase tracking-wide text-gray-500 mb-0.5">From</label>
          <input
            type="datetime-local"
            className="w-full h-9 px-2 border border-gray-300 rounded-md text-xs focus:border-gray-900 outline-none bg-white"
            value={from}
            onChange={(e) => onChange(e.target.value, to)}
          />
        </div>
        <div>
          <label className="block text-[9px] uppercase tracking-wide text-gray-500 mb-0.5">To</label>
          <input
            type="datetime-local"
            className="w-full h-9 px-2 border border-gray-300 rounded-md text-xs focus:border-gray-900 outline-none bg-white"
            value={to}
            onChange={(e) => onChange(from, e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}

/** Load a session capture (stored as a file path) as a base64 data URL via the
 *  main process — the renderer can't load a raw file:// path over its origin. */
function useSessionImage(path: string | null): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setSrc(null);
    if (!path) return;
    window.bridge.readSessionImage(path)
      .then((r: any) => { if (alive) setSrc(r?.base64 ? `data:${r.contentType ?? 'image/jpeg'};base64,${r.base64}` : null); })
      .catch(() => { if (alive) setSrc(null); });
    return () => { alive = false; };
  }, [path]);
  return src;
}

function ThumbCell({
  path, kind, plate, onOpen,
}: { path: string | null; kind: 'entry' | 'exit'; plate: string; onOpen: (url: string) => void }) {
  const src = useSessionImage(path);
  const Icon = kind === 'entry' ? ArrowDown : ArrowUp;
  const accent = kind === 'entry' ? 'bg-emerald-600' : 'bg-blue-600';
  if (!path) {
    return (
      <div
        className="w-10 h-10 rounded border border-dashed border-gray-200 bg-gray-50 flex items-center justify-center"
        title={`No ${kind} capture`}
      >
        <ImageIcon size={12} className="text-gray-300" />
      </div>
    );
  }
  return (
    <button
      onClick={(e) => { e.stopPropagation(); if (src) onOpen(src); }}
      className="relative w-10 h-10 rounded overflow-hidden border border-gray-200 bg-gray-100 hover:ring-2 hover:ring-gray-400 focus:outline-none"
      title={`${kind === 'entry' ? 'Entry' : 'Exit'} capture — click to enlarge · ${plate}`}
    >
      {src && (
        <img src={src} alt={`${kind} ${plate}`} className="w-full h-full object-cover" />
      )}
      <span className={`absolute bottom-0 left-0 inline-flex items-center justify-center w-4 h-4 ${accent} text-white text-[8px]`}>
        <Icon size={8} strokeWidth={3} />
      </span>
    </button>
  );
}

/**
 * View-only detail modal for a session. Consolidates all per-session actions
 * (Edit, Retrigger pay, Manual release, Delete) so the table row can stay
 * simple with just a View button. Actions still delegate to their existing
 * modals — this is a hub, not a replacement.
 */
function ViewSessionModal({
  session, policy, lanes, entryLaneName, exitLaneName,
  retriggering, deleting,
  onClose, onOpenImage, onEdit, onRelease, onRetrigger, onDelete,
}: {
  session: SessionRow;
  policy: RatePolicy | null;
  lanes: ParkingLane[];
  entryLaneName: string;
  exitLaneName: string;
  retriggering: boolean;
  deleting: boolean;
  onClose: () => void;
  onOpenImage: (url: string) => void;
  onEdit: () => void;
  onRelease: (laneId: number | null) => void;
  onRetrigger: (laneId: number | null) => void;
  onDelete: () => void;
}) {
  useEscapeToClose(onClose);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const s = session;
  // Which gate the operator wants to act on (retrigger charge / release open).
  // Default to the session's exit lane, else a lane with a terminal wired, else
  // its entry lane / the first lane.
  const [actionLaneId, setActionLaneId] = useState<number | null>(
    s.exitLaneId ?? lanes.find((l) => l.terminalId != null)?.id ?? s.entryLaneId ?? lanes[0]?.id ?? null,
  );
  const mins = s.durationMinutes ?? (s.exitAt ? null : Math.ceil((Date.now() - Date.parse(s.entryAt)) / 60_000));
  let displayFeeCents: number | null = s.feeCents ?? null;
  let isLivePreview = false;
  if (displayFeeCents == null && !s.exitAt && s.livePreviewFeeCents != null) {
    displayFeeCents = s.livePreviewFeeCents;
    isLivePreview = true;
  }
  const isOpen = !s.exitAt;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-2xl bg-white rounded-2xl shadow-2xl overflow-hidden max-h-[92vh] flex flex-col">
        <header className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="text-base font-bold">Session #{s.id}</h2>
              <span className="font-mono font-bold text-lg">{s.plate}</span>
              <SessionStatusBadge status={s.status} />
              <StatusBadge status={s.paymentStatus} />
            </div>
            <p className="text-xs text-gray-500 mt-1 inline-flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${isOpen ? 'bg-emerald-500 animate-pulse' : 'bg-gray-400'}`} />
              {isOpen ? 'Vehicle currently on site.' : 'Closed / archived.'}
            </p>
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-lg hover:bg-gray-100 inline-flex items-center justify-center text-gray-500 flex-shrink-0"><X size={18} /></button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Timeline */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <DetailRow label="Entered" icon={LogIn} iconClass="text-emerald-600">
              <div className="font-mono text-sm font-semibold">{fmtDateTime(s.entryAt)}</div>
              <div className="text-[11px] text-gray-500 mt-0.5">Lane: {entryLaneName}</div>
            </DetailRow>
            <DetailRow label="Exited" icon={LogOut} iconClass={s.exitAt ? 'text-blue-600' : 'text-amber-500'}>
              {s.exitAt ? (
                <>
                  <div className="font-mono text-sm font-semibold">{fmtDateTime(s.exitAt)}</div>
                  <div className="text-[11px] text-gray-500 mt-0.5">Lane: {exitLaneName}</div>
                </>
              ) : (
                <div className="text-sm text-amber-700 font-bold">Still inside</div>
              )}
            </DetailRow>
            <DetailRow label="Duration" icon={Clock}>
              <div className="font-mono text-sm font-semibold">
                {mins != null ? `${Math.floor(mins / 60)}h ${mins % 60}m` : '—'}
                {mins != null && <span className="text-gray-400 font-normal"> ({mins} min)</span>}
              </div>
            </DetailRow>
            <DetailRow label="Fee" icon={Banknote} iconClass={isLivePreview ? 'text-amber-500' : displayFeeCents ? 'text-emerald-600' : 'text-gray-400'}>
              <div className="font-mono text-base font-bold">
                {displayFeeCents != null
                  ? <span className={isLivePreview ? 'text-amber-700' : ''}>RM {(displayFeeCents / 100).toFixed(2)}{isLivePreview && <span className="text-[11px] font-medium"> (live preview)</span>}</span>
                  : '—'}
              </div>
              {policy && (
                <div className="text-[11px] text-gray-500 mt-0.5">Policy: {policy.policyName}</div>
              )}
            </DetailRow>
          </div>

          {/* Captures */}
          <div>
            <div className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2"><ImageIcon size={12} className="text-gray-400" /> LPR captures</div>
            <div className="grid grid-cols-2 gap-3">
              <CaptureBlock label="Entry" kind="entry" path={s.entryImagePath} plate={s.plate} onOpen={onOpenImage} />
              <CaptureBlock label="Exit" kind="exit" path={s.exitImagePath} plate={s.plate} onOpen={onOpenImage} />
            </div>
          </div>

          {s.notes && (
            <DetailRow label="Notes">
              <p className="text-sm text-gray-800 whitespace-pre-wrap">{s.notes}</p>
            </DetailRow>
          )}

          {/* Action bar — everything an operator can do to this row. */}
          <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
            <div className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2"><Zap size={12} className="text-gray-400" /> Actions</div>
            {isOpen && (
              /* Which gate the retrigger charges on / the manual release opens.
                 Same idea as the Live-display tile, but here we already know the
                 plate from the session. */
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <label className="text-[10px] font-bold uppercase tracking-wide text-gray-500">Gate</label>
                <select
                  value={actionLaneId ?? ''}
                  onChange={(e) => setActionLaneId(e.target.value ? Number(e.target.value) : null)}
                  className="h-8 px-2 rounded-lg border border-gray-300 text-xs min-w-[11rem]"
                >
                  {lanes.length === 0 && <option value="">no lanes configured</option>}
                  {lanes.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}{l.terminalId != null ? ' · terminal' : ''}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                onClick={onEdit}
                className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-white border border-gray-300 hover:border-gray-900 text-xs font-bold uppercase tracking-wide"
              >
                <Pencil size={13} /> Edit
              </button>
              {isOpen && (
                <>
                  <button
                    onClick={() => onRetrigger(actionLaneId)}
                    disabled={retriggering || actionLaneId == null}
                    className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50"
                    title="Compute the fee for this car and charge it on the selected gate — RM0 opens the barrier, more than RM0 drives that gate's terminal"
                  >
                    {retriggering ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />} Retrigger pay
                  </button>
                  <button
                    onClick={() => onRelease(actionLaneId)}
                    className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold uppercase tracking-wide"
                  >
                    <ShieldAlert size={13} /> Manual release
                  </button>
                </>
              )}
              <button
                onClick={() => setConfirmDelete(true)}
                disabled={deleting}
                className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50 ml-auto"
              >
                {deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} Delete
              </button>
            </div>
            {isOpen && (
              <p className="mt-2 text-[10px] text-gray-500">
                <span className="font-bold">Retrigger pay</span> computes this car's fee and charges it on the selected gate (free → barrier opens). <span className="font-bold">Manual release</span> closes the session without payment AND opens the selected gate's barrier to let the car out.
              </p>
            )}
          </div>
        </div>
      </div>

      {confirmDelete && (
        <ConfirmModal
          title={`Delete session #${s.id}?`}
          body={`The session for plate ${s.plate} will be permanently removed from the local database. This cannot be undone.`}
          confirmLabel="Delete"
          confirmTone="red"
          busy={deleting}
          onClose={() => setConfirmDelete(false)}
          onConfirm={onDelete}
        />
      )}
    </div>
  );
}

/** Full-screen enlarged capture. Click anywhere / the X / Esc to dismiss. */
function ImagePreviewModal({ src, onClose }: { src: string; onClose: () => void }) {
  useEscapeToClose(onClose);
  return (
    <div
      className="fixed inset-0 z-[70] bg-black/80 flex items-center justify-center p-4 cursor-zoom-out"
      onClick={onClose}
    >
      <img
        src={src}
        alt="LPR capture preview"
        className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
      <button
        onClick={onClose}
        className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white inline-flex items-center justify-center"
      >
        <X size={20} />
      </button>
    </div>
  );
}

function DetailRow({ label, icon: Icon, iconClass, children }: { label: string; icon?: any; iconClass?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-1.5">
        {Icon && <Icon size={12} className={iconClass ?? 'text-gray-400'} />} {label}
      </div>
      {children}
    </div>
  );
}

function CaptureBlock({
  label, kind, path, plate, onOpen,
}: { label: string; kind: 'entry' | 'exit'; path: string | null; plate: string; onOpen: (url: string) => void }) {
  const accent = kind === 'entry' ? 'text-emerald-700' : 'text-blue-700';
  const src = useSessionImage(path);
  return (
    <div>
      <div className={`text-[10px] font-bold uppercase tracking-widest mb-1 ${accent}`}>{label}</div>
      {path && src ? (
        <button
          onClick={() => onOpen(src)}
          className="w-full aspect-video rounded-lg overflow-hidden border border-gray-200 hover:ring-2 hover:ring-gray-400 focus:outline-none block"
        >
          <img
            src={src}
            alt={`${label} ${plate}`}
            className="w-full h-full object-cover"
          />
        </button>
      ) : (
        <div className="w-full aspect-video rounded-lg border border-dashed border-gray-200 bg-gray-50 flex items-center justify-center">
          <div className="text-[11px] text-gray-400 flex items-center gap-1">
            <ImageIcon size={13} /> No {label.toLowerCase()} capture
          </div>
        </div>
      )}
    </div>
  );
}

function ReleaseSessionModal({
  session, lanes, defaultLaneId, onClose, onReleased,
}: { session: ParkingSession; lanes: ParkingLane[]; defaultLaneId: number | null; onClose: () => void; onReleased: () => void }) {
  useEscapeToClose(onClose);
  const [reason, setReason] = useState('');
  // Default to a lane that's actually in the (exit-only) list: the lane the
  // operator triggered from, else the session's own exit lane, else the first
  // exit lane. Never the entry lane — it's not a valid exit gate here.
  const [laneId, setLaneId] = useState<number | null>(() => {
    const inList = (id: number | null | undefined) => id != null && lanes.some((l) => l.id === id);
    if (inList(defaultLaneId)) return defaultLaneId!;
    if (inList(session.exitLaneId)) return session.exitLaneId!;
    return lanes[0]?.id ?? null;
  });
  const [error, setError] = useState<string | null>(null);
  const [go, busy] = useAsyncAction(async () => {
    if (!reason.trim()) { setError('Reason is required.'); return; }
    setError(null);
    await window.bridge.manualReleaseSession(session.id, reason.trim(), laneId);
    onReleased();
  }, { onError: (e: any) => setError(e?.message ?? String(e)) });

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden">
        <header className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold inline-flex items-center gap-2"><ShieldAlert size={16} className="text-amber-600" /> Manual release</h2>
            <p className="text-xs text-gray-500 mt-0.5">Closes the session WITHOUT a terminal payment, and opens the selected gate's barrier to let the car out.</p>
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-lg hover:bg-gray-100 inline-flex items-center justify-center text-gray-500"><X size={18} /></button>
        </header>
        <div className="p-5 space-y-3">
          {error && <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 text-xs px-3 py-2">{error}</div>}
          <div className="text-sm">
            <span className="text-gray-500">Plate:</span> <span className="font-mono font-bold">{session.plate}</span>
            <span className="text-gray-400 mx-2">·</span>
            <span className="text-gray-500">Entered:</span> <span className="font-mono text-xs">{fmtDateTime(session.entryAt)}</span>
          </div>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-600 mb-1">Open barrier at gate</label>
            <select
              className="w-full h-9 px-2 text-sm border border-gray-300 rounded-lg outline-none focus:border-gray-900 bg-white"
              value={laneId ?? ''}
              onChange={(e) => setLaneId(e.target.value ? Number(e.target.value) : null)}
            >
              {lanes.length === 0 && <option value="">no lanes configured</option>}
              {lanes.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
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
  session, policies, defaultPolicy, onClose, onSaved,
}: { session: ParkingSession; policies: RatePolicy[]; defaultPolicy: RatePolicy | null; onClose: () => void; onSaved: () => void }) {
  useEscapeToClose(onClose);
  const [plate, setPlate] = useState(session.plate);
  const [entryAt, setEntryAt] = useState(toLocalInput(session.entryAt));
  // Default exit BLANK when the session is still open — so an operator can't
  // accidentally stamp an exit just by opening the editor. The "Now" button
  // next to the field sets it deliberately.
  const [exitAt, setExitAt] = useState(session.exitAt ? toLocalInput(session.exitAt) : '');
  const [paymentStatus, setPaymentStatus] = useState<ParkingSession['paymentStatus']>(session.paymentStatus);
  const [notes, setNotes] = useState(session.notes ?? '');
  const [policyOverride, setScopeOverride] = useState('');
  const [error, setError] = useState<string | null>(null);

  const previewDurationMinutes = (() => {
    if (!exitAt) return null;
    const e = Date.parse(toIso(entryAt));
    const x = Date.parse(toIso(exitAt));
    if (isNaN(e) || isNaN(x)) return null;
    return Math.max(0, Math.ceil((x - e) / 60_000));
  })();
  const previewPolicy = policyOverride ? policies.find((s) => s.policyId === policyOverride) ?? null : defaultPolicy;

  // Accurate fee preview: the real charge honours the tariff-rule SCHEDULE
  // (time-of-day / weekday windows, caps, cutoffs), which only the main process
  // can evaluate. Ask it via simulateRatePolicyFee rather than re-deriving with
  // the legacy flat block math here (which ignored the schedule and could show
  // a fee that never matches what's actually charged at exit).
  const [feePreview, setFeePreview] = useState<{ loading: boolean; feeCents: number | null; durationMinutes: number | null; error: string | null }>(
    { loading: false, feeCents: null, durationMinutes: null, error: null },
  );
  const entryIso = toIso(entryAt);
  const exitIso = exitAt ? toIso(exitAt) : '';
  useEffect(() => {
    if (!exitAt || !previewPolicy) {
      setFeePreview({ loading: false, feeCents: null, durationMinutes: null, error: null });
      return;
    }
    let alive = true;
    setFeePreview((p) => ({ ...p, loading: true, error: null }));
    const h = setTimeout(async () => {
      try {
        const r = await window.bridge.simulateRatePolicyFee({ policyId: previewPolicy.policyId, entry: entryIso, exit: exitIso });
        if (!alive) return;
        if (r.ok) setFeePreview({ loading: false, feeCents: r.feeCents ?? null, durationMinutes: r.durationMinutes ?? null, error: null });
        else setFeePreview({ loading: false, feeCents: null, durationMinutes: null, error: r.error ?? 'preview unavailable' });
      } catch (e: any) {
        if (alive) setFeePreview({ loading: false, feeCents: null, durationMinutes: null, error: e?.message ?? String(e) });
      }
    }, 350);
    return () => { alive = false; clearTimeout(h); };
  }, [entryIso, exitIso, previewPolicy?.policyId, exitAt]);

  // Server duration (from the same calc) when available, else the local estimate.
  const shownDuration = feePreview.durationMinutes ?? previewDurationMinutes;

  const [save, saving] = useAsyncAction(async () => {
    setError(null);
    await window.bridge.updateSession(session.id, {
      plate: plate.trim().toUpperCase(),
      entryAt: toIso(entryAt),
      exitAt: exitAt ? toIso(exitAt) : null,
      paymentStatus,
      notes: notes.trim() || undefined,
      policyIdOverride: policyOverride || null,
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
              <div className="flex gap-2 min-w-0">
                <input type="datetime-local" className="input flex-1 min-w-0" value={exitAt} onChange={(e) => setExitAt(e.target.value)} step="1" />
                <button type="button" onClick={() => setExitAt(toLocalInput(new Date().toISOString()))}
                  title="Set exit time to now"
                  className="shrink-0 h-[38px] px-3 rounded-lg border border-gray-300 hover:border-gray-900 text-xs font-bold uppercase tracking-wide text-gray-700">
                  Now
                </button>
                {exitAt && (
                  <button type="button" onClick={() => setExitAt('')}
                    title="Clear exit time (mark still inside)"
                    className="shrink-0 h-[38px] px-3 rounded-lg border border-gray-300 hover:border-red-300 text-xs font-bold uppercase tracking-wide text-gray-500 hover:text-red-600">
                    Clear
                  </button>
                )}
              </div>
            </Field>
            <Field label={`Policy (default: ${defaultPolicy?.policyName ?? 'lane has no policy'})`}>
              <select className="input" value={policyOverride} onChange={(e) => setScopeOverride(e.target.value)}>
                <option value="">— use lane's policy ({defaultPolicy?.policyName ?? 'none'}) —</option>
                {policies.map((sc) => <option key={sc.policyId} value={sc.policyId}>{sc.policyName}</option>)}
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
                <div className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-gray-500"><Clock size={11} className="text-gray-400" /> Duration</div>
                <div className="font-mono font-bold mt-0.5">{shownDuration != null ? `${Math.floor(shownDuration / 60)}h ${shownDuration % 60}m (${shownDuration} min)` : '—'}</div>
              </div>
              <div>
                <div className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-gray-500"><Banknote size={11} className="text-gray-400" /> Fee</div>
                <div className="font-mono font-bold mt-0.5">
                  {feePreview.loading ? (
                    <span className="inline-flex items-center gap-1.5 text-gray-400 font-normal"><Loader2 size={12} className="animate-spin" /> calculating…</span>
                  ) : feePreview.error ? (
                    <span className="text-red-600 text-xs italic font-normal">{feePreview.error}</span>
                  ) : feePreview.feeCents != null ? (
                    `RM ${(feePreview.feeCents / 100).toFixed(2)}`
                  ) : (
                    <span className="text-gray-400 italic font-normal">{previewPolicy ? 'set entry & exit to preview' : 'session has no policy — pick one above'}</span>
                  )}
                </div>
              </div>
            </div>
            <p className="mt-2 text-[10px] text-gray-400">Uses the live rules-aware rate calc — matches the fee that would be charged at exit.</p>
          </div>
        </div>

        <footer className="px-5 py-3 border-t border-gray-200 flex items-center justify-end gap-2">
          <button onClick={onClose} className="text-xs font-bold uppercase tracking-wide text-gray-600 hover:text-gray-900 px-3">Cancel</button>
          <button onClick={() => save()} disabled={saving}
            className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50">
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            {saving ? 'Saving…' : 'Save'}
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
  useEscapeToClose(onClose);
  const toneClass = confirmTone === 'red'
    ? 'bg-red-600 hover:bg-red-700'
    : confirmTone === 'amber'
      ? 'bg-amber-600 hover:bg-amber-700'
      : 'bg-gray-900 hover:bg-gray-800';
  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
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

/** The car's journey status (entered / exited / manual release), distinct from
 *  the payment outcome shown by StatusBadge. */
function SessionStatusBadge({ status }: { status: ParkingSession['status'] }) {
  const map: Record<ParkingSession['status'], string> = {
    entered: 'bg-blue-50 text-blue-800 border-blue-200',
    exited: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    manual_release: 'bg-purple-50 text-purple-800 border-purple-200',
  };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border ${map[status] ?? 'bg-gray-100 text-gray-600 border-gray-200'}`}>{status.replace('_', ' ')}</span>;
}
