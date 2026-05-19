import { useEffect, useState } from 'react';
import { Activity, Car, CreditCard, Camera, AlertCircle, MonitorPlay, Bolt, Cloud, CloudOff, RefreshCw, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import type { ParkingSession, PaymentTerminal, LprCamera, TerminalStatus, SyncStatus } from '@shared/types';
import { useAsyncAction } from '../hooks/useAsyncAction';

interface PlateEvent {
  cameraId: number;
  plate: string;
  direction: 'entry' | 'exit' | 'dual';
  timestamp: string;
}

export function Dashboard() {
  const [open, setOpen] = useState<ParkingSession[]>([]);
  const [recent, setRecent] = useState<ParkingSession[]>([]);
  const [terminals, setTerminals] = useState<PaymentTerminal[]>([]);
  const [cameras, setCameras] = useState<LprCamera[]>([]);
  const [statuses, setStatuses] = useState<Record<number, TerminalStatus>>({});
  const [recentPlates, setRecentPlates] = useState<PlateEvent[]>([]);
  const [sync, setSync] = useState<SyncStatus | null>(null);

  async function refresh() {
    const [o, r, t, c, syncStatus] = await Promise.all([
      window.bridge.listOpenSessions(),
      window.bridge.listRecentSessions(20),
      window.bridge.listTerminals(),
      window.bridge.listCameras(),
      window.bridge.getSyncStatus(),
    ]);
    setOpen(o); setRecent(r); setTerminals(t); setCameras(c); setSync(syncStatus);
    for (const term of t) {
      try {
        const status = await window.bridge.getTerminalStatus(term.id);
        setStatuses((s) => ({ ...s, [term.id]: status }));
      } catch { /* ignore */ }
    }
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
    alert(`Queued ${r.entries} entry record(s) and ${r.exits} exit record(s) for sync to qparking SaaS. Watch the panel for progress.`);
    setSync(await window.bridge.getSyncStatus());
  });

  useEffect(() => {
    const off1 = window.bridge.onEvent('terminal-status', (p: any) => {
      setStatuses((s) => ({ ...s, [p.terminalId]: p }));
    });
    const off2 = window.bridge.onEvent('session', (p: any) => {
      if (p.kind === 'entry' || p.kind === 'exit-completed') void refresh();
    });
    const off3 = window.bridge.onEvent('plate-detected', (p: any) => {
      setRecentPlates((cur) => [p as PlateEvent, ...cur].slice(0, 15));
    });
    const off4 = window.bridge.onEvent('sync-status', (p: any) => {
      setSync(p as SyncStatus);
    });
    return () => { off1(); off2(); off3(); off4(); };
  }, []);

  const onlineTerminals = Object.values(statuses).filter((s) => s.conn === 'ready' || s.conn === 'connected' || s.conn === 'transacting').length;

  return (
    <div className="p-5 sm:p-8 max-w-6xl mx-auto">
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
          operator notices a broken link before reconciliation hell sets in. */}
      {sync && <SyncPanel sync={sync} retrying={retrying} draining={draining} backfilling={backfilling}
        onRetry={() => retrySync()} onDrain={() => drainSync()} onBackfill={() => backfillSessions()} />}

      <div className="mt-5 grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile icon={Car}      label="Cars inside"      value={String(open.length)} sub="open sessions" />
        <Tile icon={CreditCard} label="Terminals online" value={`${onlineTerminals}/${terminals.length}`} sub="connected + ready" tone={onlineTerminals === terminals.length ? 'ok' : 'warn'} />
        <Tile icon={Camera}   label="Cameras"          value={String(cameras.filter((c) => c.enabled).length)} sub="enabled" />
        <Tile icon={Activity} label="Today"            value={String(recent.filter((s) => s.entryAt.slice(0,10) === new Date().toISOString().slice(0,10)).length)} sub="entries today" />
      </div>

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <header className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Cars currently inside ({open.length})</h2>
          </header>
          {open.length === 0 ? (
            <div className="p-6 text-sm text-gray-500 text-center">No open sessions.</div>
          ) : (
            <ul className="divide-y divide-gray-100 max-h-80 overflow-y-auto">
              {open.map((s) => {
                const minutes = Math.max(0, Math.ceil((Date.now() - Date.parse(s.entryAt)) / 60_000));
                return (
                  <li key={s.id} className="px-4 py-3 flex items-center justify-between text-sm">
                    <div>
                      <div className="font-mono font-bold">{s.plate}</div>
                      <div className="text-xs text-gray-500">entered {new Date(s.entryAt).toLocaleString()}</div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono text-sm">{Math.floor(minutes / 60)}h {minutes % 60}m</div>
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
            <h2 className="text-sm font-semibold">Live plate events</h2>
            <span className="text-[10px] uppercase tracking-widest text-gray-400">tail</span>
          </header>
          {recentPlates.length === 0 ? (
            <div className="p-6 text-sm text-gray-500 text-center inline-flex items-center justify-center gap-2 w-full"><AlertCircle size={14} /> Waiting for camera traffic…</div>
          ) : (
            <ul className="divide-y divide-gray-100 max-h-80 overflow-y-auto">
              {recentPlates.map((p, i) => (
                <li key={i} className="px-4 py-2.5 flex items-center justify-between text-sm">
                  <span className="font-mono font-bold">{p.plate}</span>
                  <span className="text-xs uppercase tracking-wide text-gray-500">{p.direction} · cam #{p.cameraId}</span>
                  <span className="text-[11px] text-gray-400">{new Date(p.timestamp).toLocaleTimeString()}</span>
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
              {sync.lastSuccessAt && <span>Last success: {new Date(sync.lastSuccessAt).toLocaleTimeString()}</span>}
              {sync.lastDrainAt && <span>Last attempt: {new Date(sync.lastDrainAt).toLocaleTimeString()}</span>}
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
    </section>
  );
}

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
      {sub && <div className="text-[11px] text-gray-500">{sub}</div>}
    </div>
  );
}
