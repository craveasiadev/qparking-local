import { useEffect, useState } from 'react';
import {
  Activity, Car, CreditCard, Camera, Cloud, CloudOff, RefreshCw,
  Loader2, CheckCircle2, XCircle, Clock, RotateCcw, Ban, AlertTriangle, DollarSign, Layers, LogOut, Receipt, Wifi, WifiOff,
} from 'lucide-react';
import type { ParkingSession, PaymentTerminal, LprCamera, SyncStatus } from '@shared/types';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { useCurrentSite } from '../../context/SiteContext';
import { fmtTime, fmtTimeSeconds, todayInAppTz, dateInAppTz } from '../lib/datetime';

/** Live reachability of one device: undefined = not probed yet, 'checking' =
 *  a probe is in flight, else the last ping result. */
type DeviceHealth = 'checking' | { online: boolean; latencyMs?: number };
/** Rendered status of a device row, after folding in whether it's enabled. */
type DeviceState = 'online' | 'offline' | 'checking' | 'disabled';

/** How often we re-ping every enabled device to refresh online/offline. */
const HEALTH_PING_INTERVAL_MS = 60_000;

/** How many rows the recent-activity feeds show. */
const RECENT_LIMIT = 10;

/** A ledger row as returned by the bridge — Transaction plus the parent
 *  session's plate. Derived from the bridge signature so it stays in sync. */
type TxnRow = Awaited<ReturnType<typeof window.bridge.listTransactionsPage>>['rows'][number];

export function Dashboard() {
  const [open, setOpen] = useState<ParkingSession[]>([]);
  const [recent, setRecent] = useState<ParkingSession[]>([]);
  const [txns, setTxns] = useState<TxnRow[]>([]);
  const [terminals, setTerminals] = useState<PaymentTerminal[]>([]);
  const [cameras, setCameras] = useState<LprCamera[]>([]);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  // Per-device reachability, keyed `t{id}` (terminal) / `c{id}` (camera).
  const [health, setHealth] = useState<Record<string, DeviceHealth>>({});
  // Shared with the global not-connected banner — gates the sync panel below so
  // "all caught up" never shows while this server is unlinked from a site.
  const site = useCurrentSite();

  async function refresh() {
    const [o, r, tx, t, c, syncStatus] = await Promise.all([
      window.bridge.listOpenSessions(),
      window.bridge.listRecentSessions(20),
      window.bridge.listTransactionsPage({ limit: RECENT_LIMIT, offset: 0 }),
      window.bridge.listTerminals(),
      window.bridge.listCameras(),
      window.bridge.getSyncStatus(),
    ]);
    setOpen(o); setRecent(r); setTxns(tx.rows); setTerminals(t); setCameras(c); setSync(syncStatus);
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
  // Ping every ENABLED terminal + camera now and every 60s. Disabled devices
  // are left alone (their "offline" would be meaningless). Each probe lands
  // independently so one slow device doesn't hold up the rest. `deviceKey`
  // re-arms the loop whenever the enabled set or a host/port changes.
  const enabledTerminals = terminals.filter((t) => t.enabled);
  const enabledCameras = cameras.filter((c) => c.enabled);
  const deviceKey = [
    ...enabledTerminals.map((t) => `t${t.id}@${t.host}:${t.port}`),
    ...enabledCameras.map((c) => `c${c.id}`),
  ].join('|');

  useEffect(() => {
    if (!deviceKey) return;
    let cancelled = false;
    const setOne = (key: string, v: DeviceHealth) =>
      { if (!cancelled) setHealth((h) => ({ ...h, [key]: v })); };

    function run() {
      for (const t of enabledTerminals) {
        setOne(`t${t.id}`, 'checking');
        window.bridge.pingTerminalHost({ host: t.host, port: t.port })
          .then((r) => setOne(`t${t.id}`, { online: r.ok, latencyMs: r.latencyMs }))
          .catch(() => setOne(`t${t.id}`, { online: false }));
      }
      for (const c of enabledCameras) {
        setOne(`c${c.id}`, 'checking');
        window.bridge.pingCamera(c.id)
          .then((r) => setOne(`c${c.id}`, { online: r.ok, latencyMs: r.latencyMs }))
          .catch(() => setOne(`c${c.id}`, { online: false }));
      }
    }
    run();
    const id = setInterval(run, HEALTH_PING_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceKey]);

  const termState = (t: PaymentTerminal): DeviceState => deviceState(t.enabled, health[`t${t.id}`]);
  const camState = (c: LprCamera): DeviceState => deviceState(c.enabled, health[`c${c.id}`]);

  const terminalRows = terminals.map((t) => ({
    id: t.id, name: t.name, sub: `${t.host}:${t.port}`, state: termState(t),
    latencyMs: healthLatency(health[`t${t.id}`]),
  }));
  const cameraRows = cameras.map((c) => ({
    id: c.id, name: c.name, sub: `${c.host ?? 'no host'} · ${c.direction}`, state: camState(c),
    latencyMs: healthLatency(health[`c${c.id}`]),
  }));

  // KPI roll-up across all enabled equipment.
  const allRows = [...terminalRows, ...cameraRows];
  const enabledRows = allRows.filter((r) => r.state !== 'disabled');
  const onlineCount = enabledRows.filter((r) => r.state === 'online').length;
  const offlineCount = enabledRows.filter((r) => r.state === 'offline').length;

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
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
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

      {/* Equipment health — live reachability of the terminals + cameras this
          site depends on. Anything OFFLINE floats to the top so a dead reader/
          camera is the first thing the operator sees. Re-probed every 60s. */}
      <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <HealthSection icon={CreditCard} title="Payment devices" rows={terminalRows}
          emptyText="No payment devices configured." />
        <HealthSection icon={Camera} title="LPR cameras" rows={cameraRows}
          emptyText="No cameras configured." />
      </div>
    </div>
  );
}

/** Fold enabled-ness + a probe result into the state the UI renders. */
function deviceState(enabled: boolean, h: DeviceHealth | undefined): DeviceState {
  if (!enabled) return 'disabled';
  if (h === undefined || h === 'checking') return 'checking';
  return h.online ? 'online' : 'offline';
}

function healthLatency(h: DeviceHealth | undefined): number | undefined {
  return h && h !== 'checking' && h.online ? h.latencyMs : undefined;
}

/** One equipment list (terminals or cameras) with live online/offline status,
 *  offline pinned to the top, in a scroll view so the list can't push the
 *  page. Header shows an online/offline roll-up. */
function HealthSection({ icon: Icon, title, rows, emptyText }: {
  icon: any; title: string; emptyText: string;
  rows: { id: number; name: string; sub: string; state: DeviceState; latencyMs?: number }[];
}) {
  const online = rows.filter((r) => r.state === 'online').length;
  const offline = rows.filter((r) => r.state === 'offline').length;
  // offline first (the alert), then still-checking, then online, disabled last.
  const rank: Record<DeviceState, number> = { offline: 0, checking: 1, online: 2, disabled: 3 };
  const sorted = [...rows].sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));

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
            <li key={r.id} className={`px-4 py-2.5 flex items-center justify-between gap-3 text-sm ${r.state === 'offline' ? 'bg-red-50/50' : ''}`}>
              <div className="min-w-0">
                <div className="font-semibold truncate">{r.name}</div>
                <div className="text-xs text-gray-500 truncate font-mono">{r.sub}</div>
              </div>
              <HealthPill state={r.state} latencyMs={r.latencyMs} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Status chip: green online (+latency), red offline, grey checking/disabled. */
function HealthPill({ state, latencyMs }: { state: DeviceState; latencyMs?: number }) {
  const base = 'inline-flex flex-shrink-0 items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border';
  if (state === 'disabled') return <span className={`${base} bg-gray-100 text-gray-500 border-gray-200`}>disabled</span>;
  if (state === 'checking') return <span className={`${base} bg-gray-50 text-gray-500 border-gray-200`}><Loader2 size={11} className="animate-spin" /> checking</span>;
  if (state === 'online') return <span className={`${base} bg-emerald-50 text-emerald-700 border-emerald-200`}><Wifi size={11} /> online{latencyMs != null ? ` · ${latencyMs}ms` : ''}</span>;
  return <span className={`${base} bg-red-50 text-red-700 border-red-200`}><WifiOff size={11} /> offline</span>;
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
