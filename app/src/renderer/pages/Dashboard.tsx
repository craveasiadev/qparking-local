import { useEffect, useState } from 'react';
import {
  Activity, Car, CreditCard, Camera, Cloud, CloudOff, RefreshCw, Monitor,
  Loader2, CheckCircle2, XCircle, Clock, RotateCcw, Ban, AlertTriangle, DollarSign, Layers, LogOut, Receipt, Wifi, WifiOff,
} from 'lucide-react';
import type { ParkingSession, SyncStatus, DeviceHealth, DeviceHealthKind } from '@shared/types';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { useCurrentSite } from '../context/SiteContext';
import { InfoTip } from '../components/InfoTip';
import { fmtTime, fmtTimeSeconds, fmtSince, todayInAppTz, dateInAppTz } from '../lib/datetime';

/** How many rows the recent-activity feeds show. */
const RECENT_LIMIT = 10;

/** A ledger row as returned by the bridge — Transaction plus the parent
 *  session's plate. Derived from the bridge signature so it stays in sync. */
type TxnRow = Awaited<ReturnType<typeof window.bridge.listTransactionsPage>>['rows'][number];

export function Dashboard() {
  const [open, setOpen] = useState<ParkingSession[]>([]);
  const [recent, setRecent] = useState<ParkingSession[]>([]);
  const [txns, setTxns] = useState<TxnRow[]>([]);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  // Reachability as computed by the main process (services/device-health.ts).
  // This page does NOT probe: it used to, which meant health froze the moment the
  // operator navigated away, and the verdict existed nowhere the cloud could see.
  const [health, setHealth] = useState<DeviceHealth[]>([]);
  // Shared with the global not-connected banner — gates the sync panel below so
  // "all caught up" never shows while this server is unlinked from a site.
  const site = useCurrentSite();

  async function refresh() {
    const [o, r, tx, devices, syncStatus] = await Promise.all([
      window.bridge.listOpenSessions(),
      window.bridge.listRecentSessions(20),
      window.bridge.listTransactionsPage({ limit: RECENT_LIMIT, offset: 0 }),
      window.bridge.getDeviceHealth(),
      window.bridge.getSyncStatus(),
    ]);
    setOpen(o); setRecent(r); setTxns(tx.rows); setHealth(devices); setSync(syncStatus);
  }
  useEffect(() => { void refresh(); }, []);

  const [retrySync, retrying] = useAsyncAction(async () => {
    await window.bridge.retryFailedSync();
    await window.bridge.syncDrainNow();
    setSync(await window.bridge.getSyncStatus());
  });
  const [drainSync, draining] = useAsyncAction(async () => {
    const s = await window.bridge.syncDrainNow();
    setSync(s);
  });

  useEffect(() => {
    const off2 = window.bridge.onEvent('session', (p: any) => {
      if (p.kind === 'entry' || p.kind === 'exit-completed') void refresh();
    });
    const off3 = window.bridge.onEvent('sync-status', (p: any) => {
      setSync(p as SyncStatus);
    });
    return () => { off2(); off3(); };
  }, []);

  // ─── device reachability (online/offline) ──────────────────────────────────
  // Pushed from main after every sweep — no polling here. One subscription feeds
  // all three equipment panels and the KPI tile, so they can never disagree.
  useEffect(() => {
    const off = window.bridge.onEvent('device-health', (rows: any) => setHealth(rows as DeviceHealth[]));
    return () => off();
  }, []);

  const byKind = (kind: DeviceHealthKind) => health.filter((d) => d.kind === kind);

  // KPI roll-up across all ENABLED equipment. A disabled device is excluded on
  // purpose: an operator who switched a panel off for maintenance must not be
  // shown an alarm for it.
  const enabledRows = health.filter((d) => d.status !== 'disabled');
  const onlineCount = enabledRows.filter((d) => d.status === 'online').length;
  const offlineCount = enabledRows.filter((d) => d.status === 'offline').length;

  const today = todayInAppTz();
  const entriesToday = recent.filter((s) => dateInAppTz(new Date(s.entryAt)) === today).length;

  // Most recent completed exits (car has left) — the durable, meaningful feed
  // that replaced the transient "live plate events" tail.
  const recentExits = recent.filter((s) => s.exitAt).slice(0, RECENT_LIMIT);

  // Sum what we collected locally today. This used to prefer the synced
  // `site.revenueToday`, but that mirrors a cloud column nothing ever writes —
  // so a LINKED site showed RM 0.00 while this perfectly good local figure sat
  // unused. Our own sessions are the authority for gate takings at this site.
  const revenueCents = recent
    .filter((s) => {
      if (s.paymentStatus !== 'paid') return false;
      const paidTs = s.paymentTimestamp ?? s.exitAt;
      return !!paidTs && dateInAppTz(new Date(paidTs)) === today;
    })
    .reduce((sum, s) => sum + (s.feeCents ?? 0), 0);

  // Occupancy from our OWN open sessions, the same figure the "Cars inside"
  // tile shows. The synced `site.occupiedSpaces` is an event counter that
  // drifts, and the two sitting side by side used to contradict each other.
  const occupancyPct = site && site.totalSpaces > 0
    ? Math.min(100, Math.round((open.length / site.totalSpaces) * 100))
    : null;

  return (
    <div className="p-5 sm:p-8 max-w-7xl mx-auto">
      <header>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          Dashboard
          <InfoTip title="About this page" kind="info">
            Your at-a-glance view of the site right now — cars currently
            inside, today's activity, and whether the cameras, payment
            terminals and cloud connection are healthy. If something looks
            wrong here, open the matching page from the menu for the details.
          </InfoTip>
        </h1>
        <p className="text-sm text-gray-500 mt-1">Live state of parking sessions, terminals and cameras on this site.</p>
      </header>

      {/* Cloud-sync health panel — surfaces failures to qparking SaaS so the
          operator notices a broken link before reconciliation hell sets in.
          Only meaningful once this local server is actually linked to a site;
          while unlinked the global NotConnectedNotice (App) covers it, so we
          just suppress the panel here rather than show a misleading
          "all caught up". */}
      {site && sync && <SyncPanel sync={sync} retrying={retrying} draining={draining}
        onRetry={() => retrySync()} onDrain={() => drainSync()} />}

      <div className="mt-5 grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile icon={Car} label="Cars inside" value={String(open.length)}
          sub={occupancyPct !== null ? `${occupancyPct}% of ${site!.totalSpaces} spaces` : 'open sessions'} />
        <Tile icon={DollarSign} label="Revenue today" value={formatCents(revenueCents)}
          sub="collected on this site" />
        <Tile icon={Activity} label="Entries today" value={String(entriesToday)} sub="new sessions today" />
        <Tile icon={offlineCount > 0 ? WifiOff : Wifi} label="Devices online"
          value={enabledRows.length === 0 ? '0/0' : `${onlineCount}/${enabledRows.length}`}
          sub={enabledRows.length === 0 ? 'none enabled' : offlineCount > 0 ? `${offlineCount} offline` : 'all reachable'}
          tone={enabledRows.length === 0 ? 'neutral' : offlineCount > 0 ? 'bad' : onlineCount === enabledRows.length ? 'ok' : 'neutral'} />
      </div>

      {/* Occupancy bar — only meaningful when the site profile (and its space
          inventory) has synced from the cloud. */}
      {occupancyPct !== null && (
        <section className="mt-4 rounded-xl border border-gray-200 bg-white p-4">
          <div className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-2 font-semibold">
              <Layers size={15} className="text-gray-400" /> Occupancy
            </div>
            <div className="tabular-nums text-gray-600">
              <strong>{site!.occupiedSpaces.toLocaleString()}</strong> / {site!.totalSpaces.toLocaleString()} spaces
            </div>
          </div>
          <div className="mt-2.5 h-2.5 w-full rounded-full bg-gray-100 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${occupancyPct >= 90 ? 'bg-red-500' : occupancyPct >= 70 ? 'bg-amber-500' : 'bg-emerald-500'}`}
              style={{ width: `${Math.min(100, occupancyPct)}%` }}
            />
          </div>
        </section>
      )}

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <header className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold flex items-center gap-2"><LogOut size={15} className="text-gray-400" /> Recent exits</h2>
            <span className="text-[10px] uppercase tracking-widest text-gray-400">last {recentExits.length}</span>
          </header>
          {recentExits.length === 0 ? (
            <div className="p-6 text-sm text-gray-500 text-center">No completed exits yet.</div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {recentExits.map((s) => (
                <li key={s.id} className="px-4 py-2.5 flex items-center justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <div className="font-mono font-bold truncate">{s.plate}</div>
                    <div className="text-xs text-gray-500">
                      {fmtTime(s.exitAt)}
                      {s.durationMinutes != null && <span className="text-gray-400"> · {formatDuration(s.durationMinutes)}</span>}
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0 flex flex-col items-end gap-1">
                    <span className="font-mono text-sm tabular-nums">{s.feeCents != null ? formatCents(s.feeCents) : '—'}</span>
                    <PaymentBadge status={s.paymentStatus} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <header className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold flex items-center gap-2"><Receipt size={15} className="text-gray-400" /> Recent transactions</h2>
            <span className="text-[10px] uppercase tracking-widest text-gray-400">last {txns.length}</span>
          </header>
          {txns.length === 0 ? (
            <div className="p-6 text-sm text-gray-500 text-center">No transactions yet.</div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {txns.map((t) => (
                <li key={t.id} className="px-4 py-2.5 flex items-center justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <div className="font-mono font-bold truncate">{t.plate ?? '—'}</div>
                    <div className="text-xs text-gray-500 truncate">
                      {fmtTime(t.paymentTimestamp ?? t.createdAt)}
                      {(t.terminalName || t.paymentMethod) && (
                        <span className="text-gray-400"> · {t.terminalName ?? t.paymentMethod}</span>
                      )}
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0 flex flex-col items-end gap-1">
                    <span className="font-mono text-sm tabular-nums">{formatCents(t.amountCents)}</span>
                    <TxnBadge status={t.status} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Equipment health — live reachability of every device this site depends
          on. Anything OFFLINE floats to the top so a dead reader/camera/panel is
          the first thing the operator sees. Probed by the main process every 60s
          and pushed here; this page never pings anything itself. */}
      <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
        <HealthSection icon={CreditCard} title="Payment devices" rows={byKind('terminal')}
          emptyText="No payment devices configured." />
        <HealthSection icon={Camera} title="LPR cameras" rows={byKind('camera')}
          emptyText="No cameras configured." />
        {/* LCD panels were absent from this page entirely before health moved to
            main — their link state existed only on the Displays page. */}
        <HealthSection icon={Monitor} title="LCD displays" rows={byKind('lcd')}
          emptyText="No displays configured." />
      </div>
    </div>
  );
}

/** One equipment list with live online/offline status, offline pinned to the
 *  top, in a scroll view so the list can't push the page. Header shows an
 *  online/offline roll-up. */
function HealthSection({ icon: Icon, title, rows, emptyText }: {
  icon: any; title: string; emptyText: string; rows: DeviceHealth[];
}) {
  const online = rows.filter((r) => r.status === 'online').length;
  const offline = rows.filter((r) => r.status === 'offline').length;
  // offline first (the alert), then online, disabled last.
  const rank: Record<DeviceHealth['status'], number> = { offline: 0, online: 1, disabled: 2 };
  const sorted = [...rows].sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));

  return (
    <section className="rounded-xl border border-gray-200 bg-white overflow-hidden">
      <header className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
        <h2 className="text-sm font-semibold flex items-center gap-2"><Icon size={15} className="text-gray-400" /> {title}</h2>
        {rows.length > 0 && (
          <span className="text-[10px] uppercase tracking-widest inline-flex items-center gap-2">
            <span className="text-emerald-600 font-semibold">{online} online</span>
            {offline > 0 && <span className="text-red-600 font-semibold">{offline} offline</span>}
          </span>
        )}
      </header>
      {rows.length === 0 ? (
        <div className="p-6 text-sm text-gray-500 text-center">{emptyText}</div>
      ) : (
        <ul className="divide-y divide-gray-100 max-h-72 overflow-y-auto">
          {sorted.map((r) => (
            <li key={`${r.kind}${r.deviceId}`} className={`px-4 py-2.5 flex items-center justify-between gap-3 text-sm ${r.status === 'offline' ? 'bg-red-50/50' : ''}`}>
              <div className="min-w-0">
                <div className="font-semibold truncate">{r.name}</div>
                <div className="text-xs text-gray-500 truncate font-mono">{r.address}</div>
                {/* No failure-reason line here. These reasons are full sentences
                    ("timed out — no response (wrong IP, or device unreachable /
                    firewalled)"), so in a narrow dashboard column every one of them
                    truncated mid-clause into something unreadable. The Dashboard's
                    job is WHICH device is down; the reason lives on the pill's
                    tooltip, and in full on the device's own page. */}
              </div>
              <HealthPill row={r} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Status chip: green online (+latency), red "offline since <clock time>", grey
 * disabled.
 *
 * The offline label carries the ABSOLUTE instant the device went down, never a
 * relative age — see fmtSince. `via` is surfaced in the tooltip because a camera
 * that is 'online' via an HTTP ping has only proved that something answered on
 * that port, which is a weaker claim than the SDK's.
 */
function HealthPill({ row }: { row: DeviceHealth }) {
  const base = 'inline-flex flex-shrink-0 items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border';
  const evidence = row.via === 'sdk' ? 'camera SDK reports connected'
    : row.via === 'link' ? 'our socket to the panel is up'
    : row.via === 'http' ? 'HTTP port answered (does not prove the camera is working)'
    : row.via === 'tcp' ? 'TCP port is listening'
    : 'not probed';

  if (row.status === 'disabled') {
    return <span className={`${base} bg-gray-100 text-gray-500 border-gray-200`}>disabled</span>;
  }
  if (row.status === 'online') {
    return (
      <span className={`${base} bg-emerald-50 text-emerald-700 border-emerald-200`} title={evidence}>
        <Wifi size={11} /> online{row.latencyMs != null ? ` · ${row.latencyMs}ms` : ''}
      </span>
    );
  }
  return (
    <span className={`${base} bg-red-50 text-red-700 border-red-200 normal-case`}
      title={row.detail ?? evidence}>
      <WifiOff size={11} /> <span className="uppercase">offline</span> since {fmtSince(row.changedAt)}
    </span>
  );
}

function SyncPanel({ sync, retrying, draining, onRetry, onDrain }:
  { sync: SyncStatus; retrying: boolean; draining: boolean;
    onRetry: () => void; onDrain: () => void }) {
  const healthy = sync.failed === 0 && sync.pending === 0 && !sync.lastError;
  const hasFailed = sync.failed > 0;
  const tone = hasFailed ? 'red' : sync.pending > 0 ? 'amber' : 'emerald';
  const Icon = hasFailed ? CloudOff : sync.pending > 0 ? Cloud : CheckCircle2;

  return (
    <section className={`mt-5 rounded-xl border p-4 ${tone === 'red' ? 'border-red-200 bg-red-50/40' : tone === 'amber' ? 'border-amber-200 bg-amber-50/40' : 'border-emerald-200 bg-emerald-50/40'}`}>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-start gap-3">
          <Icon size={20} className={tone === 'red' ? 'text-red-600' : tone === 'amber' ? 'text-amber-600' : 'text-emerald-600'} />
          <div>
            <div className="text-sm font-bold">
              {healthy
                ? 'Cloud sync · all caught up'
                : hasFailed
                  ? `Cloud sync · ${sync.failed} record${sync.failed === 1 ? '' : 's'} FAILED`
                  : `Cloud sync · ${sync.pending} pending`}
            </div>
            <div className="mt-0.5 text-[11px] text-gray-600 flex flex-wrap gap-x-3 gap-y-0.5">
              <span>Pending: <strong>{sync.pending}</strong></span>
              <span>Failed: <strong className={hasFailed ? 'text-red-700' : ''}>{sync.failed}</strong></span>
              {sync.lastSuccessAt && <span>Last success: {fmtTimeSeconds(sync.lastSuccessAt)}</span>}
              {sync.lastDrainAt && <span>Last attempt: {fmtTimeSeconds(sync.lastDrainAt)}</span>}
            </div>
            {sync.lastError && (
              <div className="mt-1.5 text-[11px] text-red-700 inline-flex items-start gap-1">
                <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
                <span className="font-mono break-all">{sync.lastError}</span>
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={onDrain} disabled={draining || retrying}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-gray-200 bg-white hover:border-gray-900 text-xs font-bold uppercase tracking-wide disabled:opacity-50">
            {draining ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            {draining ? 'Syncing…' : 'Sync now'}
          </button>
          {hasFailed && (
            <button onClick={onRetry} disabled={retrying || draining}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50">
              {retrying ? <Loader2 size={13} className="animate-spin" /> : <CloudOff size={13} />}
              {retrying ? 'Retrying…' : `Retry ${sync.failed} failed`}
            </button>
          )}
        </div>
      </div>

      {/* Per-row failure detail — exactly which record couldn't sync and why,
          so a stuck queue is diagnosable without digging through logs. */}
      {sync.issues.length > 0 && (
        <ul className="mt-3 border-t border-black/5 divide-y divide-black/5 text-[11px]">
          {sync.issues.map((issue) => (
            <li key={issue.id} className="py-2 flex items-start gap-2">
              <span className={`mt-0.5 inline-flex flex-shrink-0 items-center px-1.5 py-0.5 rounded font-bold uppercase tracking-wide text-[9px] ${
                issue.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
              }`}>
                {issue.status === 'failed' ? 'failed' : `retry ${issue.attempts}/6`}
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-gray-700">
                  {OP_LABEL[issue.op] ?? issue.op}
                  {issue.ref && <span className="font-mono text-gray-500"> · {issue.ref}</span>}
                  {issue.status === 'pending' && issue.nextAttemptAt && (
                    <span className="font-normal text-gray-400"> · next try {fmtTimeSeconds(issue.nextAttemptAt)}</span>
                  )}
                </div>
                {issue.lastError && (
                  <div className="mt-0.5 font-mono text-red-600 break-all">{issue.lastError}</div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Friendly labels for the queue op codes shown in the sync-issue list. */
const OP_LABEL: Record<string, string> = {
  'session.entry': 'Entry',
  'session.exit': 'Exit',
  'session.update': 'Update',
  'session.delete': 'Delete',
  'transaction.upsert': 'Payment',
};

function Tile({ icon: Icon, label, value, sub, tone = 'neutral' }:
  { icon: any; label: string; value: string; sub?: string; tone?: 'neutral' | 'ok' | 'warn' | 'bad' }) {
  const tones = {
    neutral: 'border-gray-200',
    ok: 'border-emerald-300 bg-emerald-50/50',
    warn: 'border-amber-300 bg-amber-50/50',
    bad: 'border-red-300 bg-red-50/50',
  };
  return (
    <div className={`rounded-xl border p-4 bg-white ${tones[tone]}`}>
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-gray-500">
        <Icon size={13} strokeWidth={2.25} /> {label}
      </div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-gray-500 truncate">{sub}</div>}
    </div>
  );
}

/** Payment-status chip for the recent-exits feed. */
function PaymentBadge({ status }: { status: ParkingSession['paymentStatus'] }) {
  const styles: Record<ParkingSession['paymentStatus'], string> = {
    paid: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    free: 'bg-sky-50 text-sky-700 border-sky-200',
    pending: 'bg-amber-50 text-amber-700 border-amber-200',
    declined: 'bg-red-50 text-red-700 border-red-200',
    cancelled: 'bg-gray-100 text-gray-500 border-gray-200',
    manual_release: 'bg-violet-50 text-violet-700 border-violet-200',
  };
  const label = status === 'manual_release' ? 'manual' : status;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border ${styles[status]}`}>
      {label}
    </span>
  );
}

/** Compact transaction-status chip for the recent-transactions feed. */
function TxnBadge({ status }: { status: string }) {
  const map: Record<string, { cls: string; Icon: any }> = {
    paid: { cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', Icon: CheckCircle2 },
    failed: { cls: 'bg-red-50 text-red-700 border-red-200', Icon: XCircle },
    pending: { cls: 'bg-amber-50 text-amber-700 border-amber-200', Icon: Clock },
    refunded: { cls: 'bg-blue-50 text-blue-700 border-blue-200', Icon: RotateCcw },
    voided: { cls: 'bg-gray-100 text-gray-500 border-gray-200', Icon: Ban },
  };
  const { cls, Icon } = map[status] ?? map.pending;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-wide ${cls}`}>
      <Icon size={10} /> {status}
    </span>
  );
}

function formatCents(cents: number): string {
  return `RM ${(cents / 100).toFixed(2)}`;
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
