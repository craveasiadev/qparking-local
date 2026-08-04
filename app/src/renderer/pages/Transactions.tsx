import { useEffect, useState, type ReactNode } from 'react';
import {
  Receipt, RefreshCw, Search, X, Loader2,
  Eye, CheckCircle2, XCircle, Clock, RotateCcw, Ban, UploadCloud, CalendarDays,
} from 'lucide-react';
import type { Transaction, ParkingLane } from '@shared/types';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { usePagination } from '../hooks/usePagination';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { PaginationBar, PageLoadingOverlay } from '../components/Pagination';
import { InfoTip } from '../components/InfoTip';
import { fmtDateTime, appTzDayStartUtc, appTzDayEndUtc, todayInAppTz } from '../lib/datetime';
import { toast } from '../toast';

const PAGE_SIZE = 20;

/** A ledger row enriched (server-side) with the parent session's plate + lanes. */
type TxnRow = Transaction & {
  plate: string | null;
  sessionStatus: string | null;
  entryLaneId: number | null;
  exitLaneId: number | null;
};

/** Raw W4G pay-type int → human label (mirrors payment-tng's PAY_TYPE_LABEL). */
const PAY_TYPE_LABEL: Record<number, string> = {
  0: 'TNG card',
  1: 'Visa',
  2: 'Mastercard',
  3: 'MCCS',
  4: 'TNG e-wallet',
};
function payTypeLabel(t: number | null): string {
  if (t == null) return '—';
  return PAY_TYPE_LABEL[t] ?? `code ${t}`;
}

/** RM from cents. */
function rm(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return `RM ${(cents / 100).toFixed(2)}`;
}

const STATUS_OPTIONS = [
  { value: '', label: 'All status' },
  { value: 'paid', label: 'Paid' },
  { value: 'pending', label: 'Pending' },
  { value: 'failed', label: 'Failed' },
  { value: 'refunded', label: 'Refunded' },
  { value: 'voided', label: 'Voided' },
];

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { cls: string; Icon: any }> = {
    paid: { cls: 'bg-emerald-100 text-emerald-800 border-emerald-200', Icon: CheckCircle2 },
    failed: { cls: 'bg-red-100 text-red-800 border-red-200', Icon: XCircle },
    pending: { cls: 'bg-amber-100 text-amber-800 border-amber-200', Icon: Clock },
    refunded: { cls: 'bg-blue-100 text-blue-800 border-blue-200', Icon: RotateCcw },
    voided: { cls: 'bg-gray-100 text-gray-600 border-gray-200', Icon: Ban },
  };
  const { cls, Icon } = map[status] ?? map.pending;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-bold uppercase tracking-wide ${cls}`}>
      <Icon size={11} /> {status}
    </span>
  );
}

export function Transactions() {
  const [rows, setRows] = useState<TxnRow[]>([]);
  const pager = usePagination(PAGE_SIZE);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  // GMT+8 calendar dates ('YYYY-MM-DD'); mapped to a UTC range at fetch time.
  // Default to today's GMT+8 day so the ledger opens on the current shift;
  // clear the dates (✕) to see the full history.
  const [dateFrom, setDateFrom] = useState(() => todayInAppTz());
  const [dateTo, setDateTo] = useState(() => todayInAppTz());
  const [lanes, setLanes] = useState<ParkingLane[]>([]);
  const [viewing, setViewing] = useState<TxnRow | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const debouncedSearch = useDebouncedValue(search.trim());

  async function fetchPage() {
    setPageLoading(true);
    try {
      const result = await window.bridge.listTransactionsPage({
        limit: PAGE_SIZE,
        offset: pager.offset,
        search: debouncedSearch || null,
        status: statusFilter || null,
        dateFrom: appTzDayStartUtc(dateFrom),
        dateTo: appTzDayEndUtc(dateTo),
      });
      setRows(result.rows);
      pager.setTotal(result.total);
      if (viewing) setViewing(result.rows.find((r) => r.id === viewing.id) ?? viewing);
    } finally {
      setPageLoading(false);
    }
  }

  const [runRefresh, refreshing] = useAsyncAction(async () => {
    setLanes(await window.bridge.listLanes());
    await fetchPage();
  });

  const [runSync, syncing] = useAsyncAction(async () => {
    const r = await window.bridge.syncTransactionsNow();
    const s = r.status;
    if (r.transactions === 0) {
      toast({ tone: 'success', title: 'No transactions to sync' });
    } else if (s.lastError === 'qparking_not_configured') {
      toast({ tone: 'warn', title: `Queued ${r.transactions} transaction(s)`, detail: "qparking isn't configured (set the URL + API key in Settings). They'll push once connected." });
    } else if (s.lastError === 'site_not_bound') {
      toast({ tone: 'warn', title: `Queued ${r.transactions} transaction(s)`, detail: "This server isn't bound to the current site yet. They'll push after re-provisioning." });
    } else if (s.failed > 0 || s.pending > 0) {
      toast({ tone: 'warn', title: `Queued ${r.transactions} transaction(s)`, detail: `${s.pending} pending, ${s.failed} failed${s.lastError ? ` — ${s.lastError}` : ''}. Will retry automatically.` });
    } else {
      toast({ tone: 'success', title: `Synced ${r.transactions} transaction(s) to qparking` });
    }
    await fetchPage();
  });

  useEffect(() => { void fetchPage(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [pager.page, debouncedSearch, statusFilter, dateFrom, dateTo]);
  useEffect(() => { window.bridge.listLanes().then(setLanes).catch(() => null); }, []);
  // A completed/failed exit writes a transaction — refresh live off the same
  // 'session' event stream the Sessions page listens to.
  useEffect(() => {
    const off = window.bridge.onEvent('session', () => { void fetchPage(); });
    return off;
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [pager.page, debouncedSearch, statusFilter]);
  useEffect(() => { pager.reset(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [debouncedSearch, statusFilter]);

  function laneName(id: number | null): string {
    if (!id) return '—';
    return lanes.find((l) => l.id === id)?.name ?? `Lane #${id}`;
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto">
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight flex items-center gap-2">
            Transactions
            <InfoTip title="About this page" kind="info">
              Every card payment attempted at the exit terminals — successful,
              failed, refunded or cancelled. Click a row for the full receipt.
              "Sync now" sends these records to the qparking cloud so head
              office reports include them; it's safe to press any time.
            </InfoTip>
          </h1>
          <p className="text-xs sm:text-sm text-gray-500 mt-1">Every payment attempt (W4G PayRequest → PayResult) recorded by this server, newest first.</p>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto">
          <button
            onClick={() => runSync()}
            disabled={syncing}
            title="Push every local transaction to the qparking cloud ledger (idempotent — safe to re-run)"
            className="inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50"
          >
            {syncing ? <Loader2 size={13} className="animate-spin" /> : <UploadCloud size={13} />}
            Sync now
          </button>
          <button
            onClick={() => runRefresh()}
            disabled={refreshing}
            className="inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-lg border border-gray-200 hover:border-gray-900 text-xs font-bold uppercase tracking-wide disabled:opacity-50"
          >
            {refreshing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            Refresh
          </button>
        </div>
      </header>

      {/* Search + status + date-range filter */}
      <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2 mb-3">
        <div className="relative flex-1 sm:max-w-sm">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search order ID, plate, or card no…"
            className="w-full h-9 pl-8 pr-8 border border-gray-200 rounded-lg text-sm focus:border-gray-900 outline-none"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700">
              <X size={13} />
            </button>
          )}
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-9 px-2 rounded-lg border border-gray-200 text-sm focus:border-gray-900 outline-none bg-white"
        >
          {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        {/* Date range — GMT+8 calendar days. Empty = all dates. */}
        <div className="flex items-center gap-1.5">
          <CalendarDays size={15} className="text-gray-400 flex-shrink-0" />
          <input
            type="date"
            value={dateFrom}
            max={dateTo || undefined}
            onChange={(e) => { pager.reset(); setDateFrom(e.target.value); }}
            title="From date"
            className="h-9 px-2 rounded-lg border border-gray-200 text-sm focus:border-gray-900 outline-none bg-white"
          />
          <span className="text-gray-400 text-xs">→</span>
          <input
            type="date"
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(e) => { pager.reset(); setDateTo(e.target.value); }}
            title="To date"
            className="h-9 px-2 rounded-lg border border-gray-200 text-sm focus:border-gray-900 outline-none bg-white"
          />
          <button
            onClick={() => { pager.reset(); const t = todayInAppTz(); setDateFrom(t); setDateTo(t); }}
            className="h-9 px-2.5 rounded-lg border border-gray-200 hover:border-gray-900 text-xs font-bold uppercase tracking-wide text-gray-700"
          >
            Today
          </button>
          {(dateFrom || dateTo) && (
            <button
              onClick={() => { pager.reset(); setDateFrom(''); setDateTo(''); }}
              title="Clear dates"
              className="h-9 px-2 rounded-lg text-gray-400 hover:text-gray-700 inline-flex items-center"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="relative">
        <PageLoadingOverlay show={pageLoading} />

        {/* DESKTOP / TABLET TABLE */}
        <div className={`hidden md:block rounded-xl border border-gray-200 bg-white overflow-hidden transition-opacity ${pageLoading ? 'opacity-60' : ''}`}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[900px]">
              <thead className="bg-gray-50 text-[10px] uppercase tracking-widest text-gray-500">
                <tr>
                  <th className="text-left px-3 py-2 font-bold">Order ID</th>
                  <th className="text-left px-3 py-2 font-bold">Plate</th>
                  <th className="text-left px-3 py-2 font-bold">Status</th>
                  <th className="text-right px-3 py-2 font-bold">Amount</th>
                  <th className="text-left px-3 py-2 font-bold">Method</th>
                  <th className="text-left px-3 py-2 font-bold">Terminal</th>
                  <th className="text-left px-3 py-2 font-bold">Card no</th>
                  <th className="text-left px-3 py-2 font-bold">Appr</th>
                  <th className="text-left px-3 py-2 font-bold">Time</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} onClick={() => setViewing(t)} className="border-t border-gray-100 cursor-pointer hover:bg-gray-50">
                    <td className="px-3 py-2 font-mono text-[11px] text-gray-500" title={t.orderId ?? ''}>
                      {t.orderId ? `${t.orderId.slice(0, 8)}…` : <span className="text-gray-300">n/a</span>}
                    </td>
                    <td className="px-3 py-2 font-mono font-bold">{t.plate ?? '—'}</td>
                    <td className="px-3 py-2"><StatusBadge status={t.status} /></td>
                    <td className="px-3 py-2 text-right font-mono">{rm(t.amountCents)}</td>
                    <td className="px-3 py-2 text-xs">{t.paymentMethod ?? payTypeLabel(t.payType)}</td>
                    <td className="px-3 py-2 text-xs">{t.terminalName ?? '—'}</td>
                    <td className="px-3 py-2 font-mono text-xs">{t.cardNumber ?? '—'}</td>
                    <td className="px-3 py-2 font-mono text-xs">{t.apprCode || '—'}</td>
                    <td className="px-3 py-2 text-xs text-gray-600">{fmtDateTime(t.paymentTimestamp ?? t.createdAt)}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <button
                        onClick={(e) => { e.stopPropagation(); setViewing(t); }}
                        className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wide font-bold text-gray-700 hover:text-gray-900 border border-gray-200 hover:border-gray-900 rounded-md px-2 py-1"
                      >
                        <Eye size={12} /> View
                      </button>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={10} className="p-8 text-center text-sm text-gray-500"><Receipt size={16} className="inline mr-1 text-gray-400" /> {debouncedSearch || statusFilter ? 'No transactions match the current filters.' : 'No payment attempts recorded yet.'}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* MOBILE CARDS */}
        <div className={`md:hidden space-y-2 transition-opacity ${pageLoading ? 'opacity-60' : ''}`}>
          {rows.length === 0 && (
            <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
              <Receipt size={18} className="inline mr-1 text-gray-400" /> {debouncedSearch || statusFilter ? 'No transactions match the current filters.' : 'No payment attempts recorded yet.'}
            </div>
          )}
          {rows.map((t) => (
            <div key={t.id} onClick={() => setViewing(t)} className="rounded-xl border border-gray-200 bg-white p-3 cursor-pointer active:bg-gray-50">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono font-bold text-base">{t.plate ?? '—'}</span>
                <StatusBadge status={t.status} />
              </div>
              <div className="mt-1 text-[11px] text-gray-600 grid grid-cols-2 gap-x-3 gap-y-0.5">
                <span className="font-mono"><span className="text-gray-400">Amt:</span> {rm(t.amountCents)}</span>
                <span><span className="text-gray-400">Via:</span> {t.paymentMethod ?? payTypeLabel(t.payType)}</span>
                <span><span className="text-gray-400">Terminal:</span> {t.terminalName ?? '—'}</span>
                <span className="font-mono"><span className="text-gray-400">Card:</span> {t.cardNumber ?? '—'}</span>
                <span className="font-mono"><span className="text-gray-400">Appr:</span> {t.apprCode || '—'}</span>
                <span className="col-span-2 font-mono truncate"><span className="text-gray-400">Order:</span> {t.orderId ?? '—'}</span>
                <span className="col-span-2"><span className="text-gray-400">Time:</span> {fmtDateTime(t.paymentTimestamp ?? t.createdAt)}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <PaginationBar pager={pager} rowsOnPage={rows.length} />

      {viewing && (
        <TransactionModal txn={viewing} laneName={laneName} onClose={() => setViewing(null)} />
      )}
    </div>
  );
}

/** Full receipt-style detail for one payment attempt — every field of the W4G
 *  PayResult plus the ledger metadata. */
function TransactionModal({ txn, laneName, onClose }: { txn: TxnRow; laneName: (id: number | null) => string; onClose: () => void }) {
  useEffect(() => {
    const cb = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', cb);
    return () => window.removeEventListener('keydown', cb);
  }, [onClose]);

  const t = txn;
  const exitLane = t.exitLaneId ?? t.entryLaneId;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg bg-white rounded-2xl shadow-2xl overflow-hidden max-h-[92vh] flex flex-col">
        <header className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="text-base font-bold">Transaction #{t.id}</h2>
              <span className="font-mono font-bold text-lg">{t.plate ?? '—'}</span>
              <StatusBadge status={t.status} />
            </div>
            <p className="text-xs text-gray-500 mt-1">Session #{t.sessionId} · Lane {laneName(exitLane)}</p>
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-lg hover:bg-gray-100 inline-flex items-center justify-center text-gray-500 flex-shrink-0"><X size={18} /></button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          <Section title="Charge">
            <Row label="Amount charged" value={rm(t.amountCents)} mono strong />
            <Row label="Status" value={t.status} />
            <Row label="Terminal" value={t.terminalName ?? '—'} />
            <Row label="Paid at" value={fmtDateTime(t.paymentTimestamp)} />
          </Section>

          <Section title="W4G device response">
            <Row label="Pay type" value={`${payTypeLabel(t.payType)}${t.payType != null ? ` (${t.payType})` : ''}`} />
            <Row label="Card scheme" value={t.paymentMethod ?? '—'} />
            <Row label="Card no" value={t.cardNumber ?? '—'} mono />
            <Row label="Approval code" value={t.apprCode || '—'} mono />
          </Section>

          <Section title="Identity">
            <Row label="Order ID" value={t.orderId ?? '—'} mono wrap />
            <Row label="Local txn ID" value={t.localTransactionId} mono wrap />
            <Row label="Created" value={fmtDateTime(t.createdAt)} />
            <Row label="Updated" value={fmtDateTime(t.updatedAt)} />
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">{title}</div>
      <div className="rounded-xl border border-gray-200 divide-y divide-gray-100">{children}</div>
    </div>
  );
}

function Row({ label, value, mono, strong, wrap }: { label: string; value: string; mono?: boolean; strong?: boolean; wrap?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 px-3 py-2">
      <span className="text-xs text-gray-500 flex-shrink-0">{label}</span>
      <span className={`text-sm text-right ${mono ? 'font-mono' : ''} ${strong ? 'font-bold' : 'font-medium'} ${wrap ? 'break-all' : ''}`}>{value}</span>
    </div>
  );
}
