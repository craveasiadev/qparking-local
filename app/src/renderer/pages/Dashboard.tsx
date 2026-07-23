import { useEffect, useState } from 'react';
import {
  Activity, Car, CreditCard, Camera, MonitorPlay, Bolt, Cloud, CloudOff, RefreshCw,
  Loader2, CheckCircle2, AlertTriangle, DollarSign, Layers, LogOut,
} from 'lucide-react';
import type { ParkingSession, PaymentTerminal, LprCamera, SyncStatus } from '@shared/types';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { useCurrentSite } from '../hooks/useCurrentSite';
import { fmtDateTime, fmtTime, fmtTimeSeconds, todayInAppTz, dateInAppTz } from '../lib/datetime';
import { toast } from '../toast';

export function Dashboard() {
  const [open, setOpen] = useState<ParkingSession[]>([]);
  const [recent, setRecent] = useState<ParkingSession[]>([]);
  const [terminals, setTerminals] = useState<PaymentTerminal[]>([]);
  const [cameras, setCameras] = useState<LprCamera[]>([]);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  // Shared with the global not-connected banner — gates the sync panel below so
  // "all caught up" never shows while this server is unlinked from a site.
  const site = useCurrentSite();

  async function refresh() {
    const [o, r, t, c, syncStatus] = await Promise.all([
      window.bridge.listOpenSessions(),
      window.bridge.listRecentSessions(20),
      window.bridge.listTerminals(),
      window.bridge.listCameras(),
      window.bridge.getSyncStatus(),
    ]);
    setOpen(o); setRecent(r); setTerminals(t); setCameras(c); setSync(syncStatus);
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
  const [backfillSessions, backfilling] = useAsyncAction(async () => {
    const r = await window.bridge.backfillSessions();
    toast({ tone: 'success', title: `Queued ${r.entries} entry + ${r.exits} exit record(s) for sync`, detail: 'Watch the sync panel for progress.' });
    setSync(await window.bridge.getSyncStatus());
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

  const enabledDevices = terminals.filter((t) => t.enabled).length;
  const today = todayInAppTz();
  const entriesToday = recent.filter((s) => dateInAppTz(new Date(s.entryAt)) === today).length;

  // Most recent completed exits (car has left) — the durable, meaningful feed
  // that replaced the transient "live plate events" tail.
  const recentExits = recent.filter((s) => s.exitAt).slice(0, 15);

  // Prefer the cloud-authoritative daily revenue; fall back to summing what we
  // collected locally today so the tile is still useful while unlinked.
  const localCollectedToday = recent
    .filter((s) => {
      if (s.paymentStatus !== 'paid') return false;
      const paidTs = s.paymentTimestamp ?? s.exitAt;
      return !!paidTs && dateInAppTz(new Date(paidTs)) === today;
    })
    .reduce((sum, s) => sum + (s.feeCents ?? 0), 0);
  const revenueCents = site ? site.revenueToday : localCollectedToday;

  const occupancyPct = site && site.totalSpaces > 0
    ? Math.round((site.occupiedSpaces / site.totalSpaces) * 100)
    : null;

  return (
    <div className="p-5 sm:p-8 max-w-7xl mx-auto">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-1">Live state of parking sessions, terminals and cameras on this site.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => window.bridge.openGateSimulator()}
            title="Open the gate-simulator window (red/green visual stand-in for a real gate-relay)"
            className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg border border-gray-200 hover:border-gray-900 bg-white text-xs font-bold uppercase tracking-wide text-gray-700"
          >
            <MonitorPlay size={14} /> Gate simulator
          </button>
          <button
            onClick={() => window.bridge.testGate({ plate: 'TEST123', direction: 'test', laneName: 'manual test' })}
            title="Fire a fake gate trigger — flashes the simulator green for 4 seconds"
            className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold uppercase tracking-wide"
          >
            <Bolt size={14} /> Test gate
          </button>
        </div>
      </header>

      {/* Cloud-sync health panel — surfaces failures to qparking SaaS so the
          operator notices a broken link before reconciliation hell sets in.
          Only meaningful once this local server is actually linked to a site;
          while unlinked the global NotConnectedNotice (App) covers it, so we
          just suppress the panel here rather than show a misleading
          "all caught up". */}
      {site && sync && <SyncPanel sync={sync} retrying={retrying} draining={draining} backfilling={backfilling}
        onRetry={() => retrySync()} onDrain={() => drainSync()} onBackfill={() => backfillSessions()} />}

      <div className="mt-5 grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile icon={Car} label="Cars inside" value={String(open.length)}
          sub={occupancyPct !== null ? `${occupancyPct}% of ${site!.totalSpaces} spaces` : 'open sessions'} />
        <Tile icon={DollarSign} label="Revenue today" value={formatCents(revenueCents)}
          sub={site ? 'from qparking SaaS' : 'collected locally'} />
        <Tile icon={Activity} label="Entries today" value={String(entriesToday)} sub="new sessions today" />
        <Tile icon={CreditCard} label="Payment devices" value={`${enabledDevices}/${terminals.length}`} sub="enabled"
          tone={terminals.length === 0 ? 'neutral' : enabledDevices === terminals.length ? 'ok' : 'warn'} />
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
            <h2 className="text-sm font-semibold flex items-center gap-2"><Car size={15} className="text-gray-400" /> Cars currently inside ({open.length})</h2>
          </header>
          {open.length === 0 ? (
            <div className="p-6 text-sm text-gray-500 text-center">No open sessions.</div>
          ) : (
            <ul className="divide-y divide-gray-100 max-h-96 overflow-y-auto">
              {open.map((s) => {
                const minutes = Math.max(0, Math.ceil((Date.now() - Date.parse(s.entryAt)) / 60_000));
                return (
                  <li key={s.id} className="px-4 py-3 flex items-center justify-between gap-3 text-sm">
                    <div className="min-w-0">
                      <div className="font-mono font-bold truncate">{s.plate}</div>
                      <div className="text-xs text-gray-500 truncate">entered {fmtDateTime(s.entryAt)}</div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className="font-mono text-sm">{formatDuration(minutes)}</div>
                      <div className="text-[10px] uppercase tracking-widest text-gray-400">parked</div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <header className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold flex items-center gap-2"><LogOut size={15} className="text-gray-400" /> Recent exits</h2>
            <span className="text-[10px] uppercase tracking-widest text-gray-400">last {recentExits.length}</span>
          </header>
          {recentExits.length === 0 ? (
            <div className="p-6 text-sm text-gray-500 text-center">No completed exits yet.</div>
          ) : (
            <ul className="divide-y divide-gray-100 max-h-96 overflow-y-auto">
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
      </div>

      {/* Equipment health — a compact roll-up of the terminals + cameras this
          site depends on, so the operator can spot a dead reader/camera at a
          glance without leaving the dashboard. */}
      <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <header className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold flex items-center gap-2"><CreditCard size={15} className="text-gray-400" /> Payment devices</h2>
            <span className="text-[10px] uppercase tracking-widest text-gray-400">{enabledDevices}/{terminals.length} enabled</span>
          </header>
          {terminals.length === 0 ? (
            <div className="p-6 text-sm text-gray-500 text-center">No payment devices configured.</div>
          ) : (
            <ul className="divide-y divide-gray-100 max-h-72 overflow-y-auto">
              {terminals.map((t) => (
                <li key={t.id} className="px-4 py-2.5 flex items-center justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <div className="font-semibold truncate">{t.name}</div>
                    <div className="text-xs text-gray-500 truncate font-mono">{t.host}:{t.port}</div>
                  </div>
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border ${t.enabled ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-gray-100 text-gray-500 border-gray-200'}`}>
                    {t.enabled ? 'enabled' : 'disabled'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <header className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold flex items-center gap-2"><Camera size={15} className="text-gray-400" /> LPR cameras</h2>
            <span className="text-[10px] uppercase tracking-widest text-gray-400">{cameras.filter((c) => c.enabled).length}/{cameras.length} enabled</span>
          </header>
          {cameras.length === 0 ? (
            <div className="p-6 text-sm text-gray-500 text-center">No cameras configured.</div>
          ) : (
            <ul className="divide-y divide-gray-100 max-h-72 overflow-y-auto">
              {cameras.map((c) => (
                <li key={c.id} className="px-4 py-2.5 flex items-center justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <div className="font-semibold truncate">{c.name}</div>
                    <div className="text-xs text-gray-500 truncate font-mono">{c.host ?? 'no host'}</div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className="text-[10px] uppercase tracking-wide text-gray-500">{c.direction}</span>
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${c.enabled ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-gray-100 text-gray-500 border border-gray-200'}`}>
                      {c.enabled ? 'on' : 'off'}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function SyncPanel({ sync, retrying, draining, backfilling, onRetry, onDrain, onBackfill }:
  { sync: SyncStatus; retrying: boolean; draining: boolean; backfilling: boolean;
    onRetry: () => void; onDrain: () => void; onBackfill: () => void }) {
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
          <button onClick={onDrain} disabled={draining || retrying || backfilling}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-gray-200 bg-white hover:border-gray-900 text-xs font-bold uppercase tracking-wide disabled:opacity-50">
            {draining ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            {draining ? 'Syncing…' : 'Sync now'}
          </button>
          <button onClick={onBackfill} disabled={draining || retrying || backfilling}
            title="One-shot: queue every existing local session for sync to qparking. Idempotent — safe to run repeatedly."
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-gray-200 bg-white hover:border-gray-900 text-xs font-bold uppercase tracking-wide disabled:opacity-50">
            {backfilling ? <Loader2 size={13} className="animate-spin" /> : <Cloud size={13} />}
            {backfilling ? 'Queuing…' : 'Backfill all sessions'}
          </button>
          {hasFailed && (
            <button onClick={onRetry} disabled={retrying || draining || backfilling}
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

function formatCents(cents: number): string {
  return `RM ${(cents / 100).toFixed(2)}`;
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
