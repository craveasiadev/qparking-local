/**
 * Per-terminal interactive tester — same purpose as Coherent's tcsSimulator,
 * but built into qparking-local with a nicer UI.
 *
 * Left column = collapsible cards for every ECPI command. Each card carries
 * its own params (fareClass, titleTXT, fareAmount, etc.) with sensible
 * defaults pulled from the PDF examples. Right column = live frame log
 * filtered to this terminal — see exactly what was sent + what the reader
 * replied with, including the signature bytes.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Play, RefreshCw, Power, PowerOff, ChevronDown, Send, Trash2, Search, ShieldAlert,
  ArrowRightCircle, ArrowLeftCircle, Receipt, Bolt, CreditCard, CircleAlert, CheckCircle2,
} from 'lucide-react';
import type { PaymentTerminal, TerminalStatus } from '@shared/types';

interface LogEntry {
  id: string;
  terminalId: number;
  direction: 'send' | 'recv' | 'error' | 'info';
  message: string;
  payload?: any;
  at: string;
}

/** "Pinned" event for the banner at the top of the tester. Derived from the
 *  log stream — picks the most-recent significant frame (cardRead, txnResult,
 *  initEntryStatus, initExitStatus, proceedExitStatus, txnStatus). Stays
 *  visible until a newer significant event arrives or the operator clears it. */
interface LastEvent {
  kind: 'cardRead' | 'txnResult' | 'initEntryStatus' | 'initExitStatus' | 'proceedExitStatus' | 'txnStatus';
  at: string;
  body: any;
}
const SIGNIFICANT_MESSAGES: LastEvent['kind'][] = [
  'cardRead', 'txnResult', 'initEntryStatus', 'initExitStatus', 'proceedExitStatus', 'txnStatus',
];

export function TerminalTester({ terminal, onClose }: { terminal: PaymentTerminal; onClose: () => void }) {
  const [status, setStatus] = useState<TerminalStatus | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState<'all' | 'send' | 'recv' | 'error'>('all');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: 'err' | 'ok'; text: string } | null>(null);
  const [lastEvent, setLastEvent] = useState<LastEvent | null>(null);
  const [flash, setFlash] = useState(false); // briefly highlight the banner when a new event arrives
  const logScrollRef = useRef<HTMLDivElement>(null);

  // ─── live status + log feed ──────────────────────────────────────────────
  useEffect(() => {
    window.bridge.getTerminalStatus(terminal.id).then(setStatus).catch(() => null);
    const off1 = window.bridge.onEvent('terminal-status', (p: any) => {
      if (p?.terminalId === terminal.id) setStatus(p);
    });
    const off2 = window.bridge.onEvent('log', (p: any) => {
      if (p?.terminalId !== terminal.id) return;
      setLogs((cur) => [
        ...cur,
        { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, terminalId: p.terminalId, direction: p.direction, message: p.message, payload: p.payload, at: new Date().toISOString() },
      ].slice(-500)); // cap to last 500

      // Pin significant reader-pushed events to the banner — this is the
      // "card tapped" / "payment approved" moment that the operator was
      // waiting for. The frame log on the right shows EVERYTHING; the
      // banner highlights JUST the moments that matter.
      if (p.direction === 'recv' && SIGNIFICANT_MESSAGES.includes(p.payload?.message)) {
        const kind = p.payload.message as LastEvent['kind'];
        setLastEvent({ kind, at: new Date().toISOString(), body: p.payload.body ?? {} });
        setFlash(true);
        setTimeout(() => setFlash(false), 1500);
      }
    });
    return () => { off1(); off2(); };
  }, [terminal.id]);

  // Auto-scroll log to bottom when new entries arrive.
  useEffect(() => {
    if (logScrollRef.current) logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight;
  }, [logs.length]);

  const filtered = useMemo(() => logs.filter((l) => {
    if (filter !== 'all' && l.direction !== filter) return false;
    if (search && !`${l.message} ${JSON.stringify(l.payload)}`.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }), [logs, filter, search]);

  function flashToast(tone: 'err' | 'ok', text: string) {
    setToast({ tone, text });
    setTimeout(() => setToast(null), 3500);
  }

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    try { await fn(); flashToast('ok', `${label} sent.`); }
    catch (e: any) { flashToast('err', `${label}: ${e?.message ?? String(e)}`); }
    finally { setBusy(null); }
  }

  const connected = status && ['connected', 'ready', 'transacting', 'initialising'].includes(status.conn);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-6xl h-[92vh] bg-gray-50 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        <header className="px-5 h-14 border-b border-gray-200 bg-white flex items-center justify-between gap-3 flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-gray-900 text-white flex items-center justify-center">
              <Bolt size={16} strokeWidth={2.5} />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-bold tracking-tight truncate">{terminal.name} · API tester</h2>
              <div className="text-[11px] text-gray-500 font-mono truncate">{terminal.host}:{terminal.port} · {terminal.plazaId}/{terminal.laneId} · {terminal.laneType} · {terminal.mode}</div>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <StatusPill status={status} />
            {!connected ? (
              <button onClick={() => run('Connect', () => window.bridge.terminalConnect(terminal.id))} disabled={!!busy}
                className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-40">
                <Power size={13} /> Connect
              </button>
            ) : (
              <button onClick={() => run('Disconnect', () => window.bridge.terminalDisconnect(terminal.id))} disabled={!!busy}
                className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-gray-200 hover:border-red-300 text-red-700 text-xs font-bold uppercase tracking-wide disabled:opacity-40">
                <PowerOff size={13} /> Disconnect
              </button>
            )}
            <button onClick={onClose} className="w-9 h-9 rounded-lg hover:bg-gray-100 inline-flex items-center justify-center text-gray-500"><X size={18} /></button>
          </div>
        </header>

        {toast && (
          <div className={`px-5 py-2 border-b text-xs ${toast.tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700'}`}>
            {toast.text}
          </div>
        )}

        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_460px] gap-0">
          {/* Left: API cards */}
          <div className="overflow-y-auto p-5 space-y-3">
            <LastEventBanner event={lastEvent} flashing={flash} onClear={() => setLastEvent(null)} />

            <ParkingFlowTest terminalId={terminal.id} busy={busy} runWrap={run} />

            <ApiCard title="Init Terminal" subtitle="Activate the reader for use. Re-send to change operation mode." defaultOpen
              actions={[
                { label: 'Live (1)',          run: () => window.bridge.terminalInitTerminal(terminal.id, '1') },
                { label: 'Maintenance (0)',  run: () => window.bridge.terminalInitTerminal(terminal.id, '0') },
                { label: 'Not in use (2)',   run: () => window.bridge.terminalInitTerminal(terminal.id, '2') },
              ]} busy={busy} runWrap={run} />

            <ApiCard title="Get Status" subtitle="Query reader for current state + last command/response."
              actions={[{ label: 'Send getStatus', run: () => window.bridge.terminalGetStatus(terminal.id) }]} busy={busy} runWrap={run} />

            <InitCardForm terminalId={terminal.id} busy={busy} runWrap={run} />

            <InitEntryForm terminalId={terminal.id} busy={busy} runWrap={run} />

            <InitExitForm terminalId={terminal.id} busy={busy} runWrap={run} />

            <InitTxnForm terminalId={terminal.id} busy={busy} runWrap={run} />

            <ProceedExitForm terminalId={terminal.id} busy={busy} runWrap={run} />

            <ApiCard title="Proceed Entry" subtitle="Manually fire proceedEntry (normally automatic after initEntryStatus)." icon={ArrowRightCircle}
              actions={[
                { label: 'Default (omit payFlag)', run: () => window.bridge.terminalProceedEntry(terminal.id, { payFlag: -1 }) },
                { label: 'TNG Purse (0)',         run: () => window.bridge.terminalProceedEntry(terminal.id, { payFlag: 0 }) },
                { label: 'TNG E-Wallet (1)',     run: () => window.bridge.terminalProceedEntry(terminal.id, { payFlag: 1 }) },
              ]} busy={busy} runWrap={run} />

            <ApiCard title="Abort Txn" subtitle="Cancel an in-flight transaction. Choose the beep tone."
              actions={[
                { label: 'Silent (FF)',  run: () => window.bridge.terminalAbort(terminal.id, 'silent') },
                { label: 'Success beep', run: () => window.bridge.terminalAbort(terminal.id, 'success') },
                { label: 'Failed beep',  run: () => window.bridge.terminalAbort(terminal.id, 'failed') },
              ]} busy={busy} runWrap={run} />

            <ApiCard title="Finish Txn" subtitle="Manually wrap up the current transaction." icon={Receipt}
              actions={[{ label: 'Send finTxn', run: () => window.bridge.terminalFinTxn(terminal.id) }]} busy={busy} runWrap={run} />

            <ShowStatusForm terminalId={terminal.id} busy={busy} runWrap={run} />
          </div>

          {/* Right: live log */}
          <aside className="border-l border-gray-200 bg-gray-950 text-gray-100 flex flex-col min-h-0">
            <div className="px-3 py-2 border-b border-white/10 flex items-center gap-2 flex-shrink-0">
              <span className="text-[10px] font-bold uppercase tracking-widest text-white/40">Frame log</span>
              <div className="ml-auto inline-flex bg-white/5 rounded-md text-[10px] font-bold uppercase tracking-wide overflow-hidden">
                {(['all','send','recv','error'] as const).map((f) => (
                  <button key={f} onClick={() => setFilter(f)}
                    className={`px-2 h-6 ${filter === f ? 'bg-white/10 text-white' : 'text-white/50 hover:text-white/80'}`}>{f}</button>
                ))}
              </div>
              <button onClick={() => setLogs([])} title="Clear log" className="w-6 h-6 rounded hover:bg-white/10 inline-flex items-center justify-center text-white/50 hover:text-white">
                <Trash2 size={11} />
              </button>
            </div>
            <div className="px-3 py-1.5 border-b border-white/5 flex items-center gap-2 flex-shrink-0">
              <Search size={11} className="text-white/30" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="filter…"
                className="flex-1 bg-transparent text-xs font-mono text-white placeholder-white/30 outline-none h-6" />
            </div>
            <div ref={logScrollRef} className="flex-1 min-h-0 overflow-y-auto font-mono text-[11px] leading-snug">
              {filtered.length === 0 && (
                <div className="text-white/30 text-center px-3 py-8">No frames yet. Send a command to see traffic.</div>
              )}
              {filtered.map((l) => (
                <div key={l.id} className="px-3 py-1.5 border-b border-white/5">
                  <div className="flex items-center gap-2">
                    <DirectionBadge dir={l.direction} />
                    <span className="text-white/40">{l.at.slice(11, 23)}</span>
                    <span className="text-white font-semibold">{l.message}</span>
                  </div>
                  {l.payload != null && (
                    <pre className="mt-1 text-white/60 whitespace-pre-wrap break-all">{JSON.stringify(l.payload, null, 2)}</pre>
                  )}
                </div>
              ))}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

// ─── last-event banner ─────────────────────────────────────────────────────
//
// Pinned card at the top of the tester showing the most-recent significant
// frame the reader pushed at us. Decodes the body fields per the ECPI PDF
// so the operator sees "VISA · 493531 ** 2683 · RM 12.50 balance" instead
// of having to squint at raw JSON in the frame log.

function LastEventBanner({
  event, flashing, onClear,
}: { event: LastEvent | null; flashing: boolean; onClear: () => void }) {
  if (!event) {
    return (
      <div className="rounded-xl border-2 border-dashed border-gray-300 bg-white p-4 flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-gray-100 text-gray-400 flex items-center justify-center flex-shrink-0">
          <CreditCard size={18} strokeWidth={2.25} />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-bold text-gray-700">Waiting for reader event…</div>
          <p className="text-[11px] text-gray-500 mt-0.5">
            Send a command below, then tap a card on the reader. Card reads, transaction results
            and entry/exit status updates will appear here in real time.
          </p>
        </div>
      </div>
    );
  }

  const errorCode = String(event.body?.errorCode ?? '0000');
  const ok = errorCode === '0000' || event.kind === 'cardRead';
  const tone = ok ? 'border-emerald-300 bg-emerald-50' : 'border-red-300 bg-red-50';
  const flashCls = flashing ? 'ring-4 ring-emerald-400/40 ring-offset-0' : '';
  const Icon = ok ? CheckCircle2 : CircleAlert;
  const iconColor = ok ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white';

  return (
    <div className={`relative rounded-xl border-2 ${tone} ${flashCls} p-4 transition-all`}>
      <button onClick={onClear} title="Dismiss" className="absolute top-2 right-2 w-7 h-7 rounded-md hover:bg-black/5 inline-flex items-center justify-center text-gray-500">
        <X size={14} />
      </button>
      <div className="flex items-start gap-3">
        <div className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 ${iconColor}`}>
          <Icon size={26} strokeWidth={2.5} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-bold uppercase tracking-widest text-gray-500">
            {kindLabel(event.kind)} · {new Date(event.at).toLocaleTimeString()}
          </div>
          <h3 className="text-lg font-bold tracking-tight text-gray-900 mt-0.5">
            {ok ? successHeading(event) : `Error ${errorCode}`}
          </h3>
          <DetailRows event={event} />
        </div>
      </div>
    </div>
  );
}

function kindLabel(k: LastEvent['kind']): string {
  return {
    cardRead: 'Card read',
    txnResult: 'Transaction result',
    initEntryStatus: 'Init entry status',
    initExitStatus: 'Init exit status',
    proceedExitStatus: 'Proceed exit status',
    txnStatus: 'Txn status',
  }[k];
}

function successHeading(e: LastEvent): string {
  const b = e.body ?? {};
  switch (e.kind) {
    case 'cardRead':       return cardSchemeLabel(b.cardScheme) + (b.maskPan ? ` · ${b.maskPan}` : '');
    case 'txnResult': {
      const status = String(b.status ?? '').toUpperCase();
      return status === 'APPROVED' ? 'Payment approved'
        : status === 'DECLINED' ? 'Payment declined'
        : status === 'TIMEOUT' ? 'Payment timeout'
        : status === 'CANCELLED' ? 'Payment cancelled'
        : `Txn ${status || '?'}`;
    }
    case 'initEntryStatus':
      return b.status === '01' ? 'Entry already exists for this card' : 'Entry ready';
    case 'initExitStatus':  return 'Exit ready — matched entry found';
    case 'proceedExitStatus': return 'Exit payment success';
    case 'txnStatus':       return 'Transaction success';
  }
}

function cardSchemeLabel(scheme: any): string {
  return {
    '01': 'MyDebit',
    '02': 'Mastercard',
    '03': 'Visa',
    '04': 'Amex',
    '11': 'TNG',
    '12': 'ezLink',
    '13': 'NETS',
    '14': 'TngAbt',
  }[String(scheme)] || `Scheme ${scheme || '?'}`;
}

function DetailRows({ event }: { event: LastEvent }) {
  const b = event.body ?? {};
  const rows: { label: string; value: string }[] = [];
  const add = (label: string, value: any) => {
    if (value === undefined || value === null || value === '') return;
    rows.push({ label, value: String(value) });
  };

  switch (event.kind) {
    case 'cardRead':
      add('Mask PAN', b.maskPan);
      add('Hash PAN', b.hashPan ? `${String(b.hashPan).slice(0, 16)}…` : null);
      if (b.cardBalance != null) add('Card balance', `RM ${(Number(b.cardBalance) / 100).toFixed(2)}`);
      add('Txn ID', b.txnID);
      add('Txn time', b.txnDt);
      if (b.entryDt) add('Entry time (from card)', b.entryDt);
      break;
    case 'txnResult':
      add('Status', b.status);
      add('Txn ID', b.txnID);
      if (b.fareAmount) add('Charged', `RM ${(Number(b.fareAmount) / 100).toFixed(2)}`);
      add('TID', b.tid);
      add('MID', b.mid);
      add('Batch', b.batchNo);
      break;
    case 'initEntryStatus':
      add('Status', b.status === '01' ? 'Entry already exists (anti-passback)' : 'Clear to proceed');
      add('Error', b.errorCode);
      break;
    case 'initExitStatus':
      add('Entry time', b.entryDt);
      add('Error', b.errorCode);
      break;
    case 'proceedExitStatus':
    case 'txnStatus':
      add('Payment mode', b.paymentMode);
      add('Txn ID', b.txnID);
      add('Error', b.errorCode);
      break;
  }

  if (rows.length === 0) return null;
  return (
    <dl className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-2 border-b border-black/5 last:border-0 py-0.5">
          <dt className="text-gray-500 uppercase tracking-wide text-[10px] font-semibold">{r.label}</dt>
          <dd className="text-gray-900 font-mono text-[11px] text-right break-all">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ─── status pill ───────────────────────────────────────────────────────────

function StatusPill({ status }: { status: TerminalStatus | null }) {
  const conn = status?.conn ?? 'unknown';
  const map: Record<string, string> = {
    ready: 'bg-emerald-50 border-emerald-200 text-emerald-800',
    connected: 'bg-emerald-50 border-emerald-200 text-emerald-800',
    transacting: 'bg-blue-50 border-blue-200 text-blue-800',
    connecting: 'bg-amber-50 border-amber-200 text-amber-800',
    initialising: 'bg-amber-50 border-amber-200 text-amber-800',
    error: 'bg-red-50 border-red-200 text-red-800',
    disconnected: 'bg-gray-100 border-gray-200 text-gray-700',
    unknown: 'bg-gray-100 border-gray-200 text-gray-700',
  };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border ${map[conn] ?? map.unknown}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${conn === 'ready' || conn === 'connected' ? 'bg-emerald-500' : conn === 'error' ? 'bg-red-500' : conn === 'transacting' ? 'bg-blue-500' : conn === 'connecting' || conn === 'initialising' ? 'bg-amber-500' : 'bg-gray-400'}`} />
      {conn}
    </span>
  );
}

function DirectionBadge({ dir }: { dir: LogEntry['direction'] }) {
  const map: Record<LogEntry['direction'], string> = {
    send: 'bg-blue-500/20 text-blue-300',
    recv: 'bg-emerald-500/20 text-emerald-300',
    error: 'bg-red-500/20 text-red-300',
    info: 'bg-white/10 text-white/60',
  };
  return <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider ${map[dir]}`}>{dir}</span>;
}

// ─── reusable API card ─────────────────────────────────────────────────────

function ApiCard({
  title, subtitle, actions, defaultOpen = true, children, icon: Icon = Send, busy, runWrap,
}: {
  title: string;
  subtitle?: string;
  actions?: { label: string; run: () => Promise<unknown> }[];
  defaultOpen?: boolean;
  children?: React.ReactNode;
  icon?: any;
  busy: string | null;
  runWrap: (label: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-gray-50 transition-colors">
        <Icon size={14} strokeWidth={2.25} className="text-gray-500 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-gray-900">{title}</div>
          {subtitle && <div className="text-[11px] text-gray-500 mt-0.5">{subtitle}</div>}
        </div>
        <ChevronDown size={14} className={`text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-gray-100">
          {children}
          {actions && actions.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-2">
              {actions.map((a) => (
                <button key={a.label} onClick={() => runWrap(`${title} → ${a.label}`, a.run)} disabled={!!busy}
                  className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-40">
                  <Play size={12} strokeWidth={2.5} /> {a.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── per-command parameter forms ───────────────────────────────────────────

/**
 * Parking Flow Test — orchestrates a complete entry or exit cycle exactly
 * the way the live parking-flow runs in production. Mirrors the V1.17C LPR
 * PDF process flow (sections 5.2 Entry / 5.3 Exit):
 *
 *   ENTRY:
 *     1. abortTxn + finTxn (reset reader to idle)
 *     2. initCard {fareClass, retrigger} — reader arms scanner, shows "tap"
 *     3. user taps → reader pushes `cardRead` with maskPan / cardScheme
 *     4. we send finTxn — reader returns to idle
 *
 *   EXIT:
 *     1. abortTxn + finTxn (reset)
 *     2. initTxn {vehicleNo, fareAmount, fareClass, pAmount, entryDt}
 *        — reader arms scanner with the charge amount, shows "tap card to pay"
 *     3. user taps → reader does EMV / TNG debit internally
 *     4. reader pushes `txnStatus` with APPROVED / DECLINED + txnID
 *     5. we send finTxn
 *
 * Subscribes to the log event stream and resolves on the first matching
 * push frame (cardRead for entry, txnStatus for exit), with a 60-second
 * timeout that aborts the flow if no card was tapped.
 */
type FlowPhase = 'idle' | 'resetting' | 'awaiting-tap' | 'completing' | 'success' | 'declined' | 'timeout' | 'error';

function ParkingFlowTest({ terminalId, busy, runWrap }: { terminalId: number; busy: string | null; runWrap: any }) {
  const [direction, setDirection] = useState<'entry' | 'exit'>('exit');
  const [plate, setPlate] = useState('VMM1234');
  const [fareAmount, setFareAmount] = useState('350');
  const [entryDt, setEntryDt] = useState(() => {
    const d = new Date(); const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  });
  const [phase, setPhase] = useState<FlowPhase>('idle');
  const [step, setStep] = useState<string>('');
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function runFlow() {
    setResult(null);
    setError(null);

    // ─── 1. reset reader ─────────────────────────────────────────────────
    setPhase('resetting');
    setStep('1/4 · resetting reader (abortTxn + finTxn)…');
    try {
      await window.bridge.terminalAbort(terminalId, 'silent');
      await sleep(400);
      await window.bridge.terminalFinTxn(terminalId);
      await sleep(400);
    } catch (e: any) {
      setPhase('error'); setError(`Reset failed: ${e?.message ?? e}`); return;
    }

    // ─── 2. set up the result listener BEFORE we send the init ──────────
    // The reader can push the tap response within ~50ms of the init ack on
    // some firmware. If we subscribed AFTER the send we'd race and miss it.
    const wanted = direction === 'entry' ? ['cardRead'] : ['txnStatus', 'txnResult', 'proceedExitStatus'];
    let resolved = false;
    let resolvePush: (v: any) => void = () => { /* set below */ };
    const pushed = new Promise<any>((r) => { resolvePush = r; });
    const offLog = window.bridge.onEvent('log', (p: any) => {
      if (resolved) return;
      if (p?.terminalId !== terminalId) return;
      if (p?.direction !== 'recv') return;
      const msg = p?.payload?.message;
      if (wanted.includes(msg)) {
        resolved = true;
        resolvePush(p.payload);
      }
    });

    // ─── 3. send the appropriate init ───────────────────────────────────
    setPhase('awaiting-tap');
    setStep(`2/4 · sent ${direction === 'entry' ? 'initCard' : 'initTxn'} → reader prompts "tap card" · waiting up to 60s for tap…`);
    try {
      if (direction === 'entry') {
        await window.bridge.terminalInitCard(terminalId, { fareClass: '1', retrigger: '1', titleTXT: `Entry · ${plate}`, messageTXT: 'Please tap your card' });
      } else {
        const fare = Math.max(0, Number(fareAmount) || 0);
        await window.bridge.terminalInitTxn(terminalId, {
          fareAmount: fare,
          fareClass: '1',
          vehicleNo: plate.slice(0, 10),
          entryDt: entryDt || undefined,
          pAmount: fare,
          gstAmount: 0,
        });
      }
    } catch (e: any) {
      offLog();
      setPhase('error'); setError(`Send failed: ${e?.message ?? e}`); return;
    }

    // ─── 4. wait for the reader's push (or timeout) ─────────────────────
    let push: any;
    try {
      push = await Promise.race([
        pushed,
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout — no card tapped in 60s')), 60_000)),
      ]);
    } catch (e: any) {
      offLog();
      try { await window.bridge.terminalAbort(terminalId, 'failed'); } catch { /* ignore */ }
      setPhase('timeout'); setError(e?.message ?? 'timeout'); return;
    }
    offLog();

    // ─── 5. decode result + wrap up ─────────────────────────────────────
    setStep('3/4 · received reader response · sending finTxn…');
    setPhase('completing');
    try { await window.bridge.terminalFinTxn(terminalId); } catch { /* ignore — best-effort */ }
    // Give the reader ~500ms to fully digest finTxn before pushing the
    // display refresh. Without this, the showStatus arrives while the
    // reader is still transitioning out of "host-authorising" state and
    // gets silently dropped — only visible on the 1st run because the
    // reader was already idle. Subsequent runs always race.
    await sleep(500);

    // ─── 6. show outcome on the reader's display ─────────────────────────
    let ok = false;
    if (direction === 'entry') {
      const ec = String(push?.body?.errorCode ?? '0000');
      ok = ec === '0000' && !!push?.body?.maskPan;
    } else {
      const status = String(push?.body?.status ?? '').toUpperCase();
      const ec = String(push?.body?.errorCode ?? '');
      ok = status === 'APPROVED' || ec === '0000';
    }

    // Append HH:mm:ss to the message — this forces the reader to refresh
    // even if the title + payload happen to match the previous successful
    // run's message exactly (some firmware versions skip "same content"
    // refreshes, leaving the previous showStatus visible).
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

    try {
      if (ok) {
        await window.bridge.terminalShowStatus(terminalId, {
          titleTXT: direction === 'entry' ? 'Entry OK' : 'Paid · TQ',
          messageTXT: direction === 'entry'
            ? `Welcome ${plate} ${hhmm}`
            : `${plate} RM${(Number(fareAmount) / 100).toFixed(2)} ${hhmm}`,
          sound: '01', image: '04',
        });
      } else {
        const reason = String(push?.body?.status ?? push?.body?.errorCode ?? 'declined').slice(0, 20);
        await window.bridge.terminalShowStatus(terminalId, {
          titleTXT: 'Failed',
          messageTXT: `${plate} ${reason} ${hhmm}`,
          sound: '02', image: '08',
        });
      }
    } catch { /* showStatus is best-effort — don't fail the whole flow if reader doesn't support it */ }

    // ─── 7. fire the gate simulator on success ───────────────────────────
    // Production drives this automatically when an LPR camera fires a plate
    // event through parking-flow.ts. The Parking Flow Test bypasses that
    // path (it talks directly to the reader for testing), so we trigger
    // the simulator manually here so the operator sees the gate animation
    // matching the reader's outcome.
    if (ok) {
      try {
        await window.bridge.testGate({
          plate,
          direction: direction === 'entry' ? 'in' : 'out',
          laneName: `parking flow test · ${direction}`,
        });
      } catch { /* simulator is best-effort */ }
    }

    setStep('4/4 · done · reader display + gate simulator updated');
    setResult(push);
    setPhase(ok ? 'success' : 'declined');
  }

  // Restart-from-zero helper so the operator can run multiple tests without
  // having to scroll up and click around.
  function reset() {
    setPhase('idle'); setStep(''); setResult(null); setError(null);
  }

  const running = phase === 'resetting' || phase === 'awaiting-tap' || phase === 'completing';

  return (
    <ApiCard
      title="Parking Flow Test (LPR end-to-end)"
      subtitle="Drives a complete entry or exit cycle exactly as production does. Pick a direction, set the plate (and fare for exit), click Run. Banner above shows what the reader read."
      defaultOpen
      busy={busy} runWrap={runWrap} icon={Receipt}>

      {/* status strip — phase + current step + clear visual feedback */}
      <div className={`rounded-lg border-2 px-3 py-2 text-[12px] ${
        phase === 'success' ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
        : phase === 'declined' ? 'border-red-300 bg-red-50 text-red-700'
        : phase === 'timeout' || phase === 'error' ? 'border-amber-300 bg-amber-50 text-amber-900'
        : running ? 'border-blue-300 bg-blue-50 text-blue-900'
        : 'border-gray-200 bg-gray-50 text-gray-700'
      }`}>
        <div className="flex items-center gap-2">
          <span className="font-bold uppercase tracking-wide text-[10px]">{phase}</span>
          {step && <span className="text-[11px]">{step}</span>}
        </div>
        {error && <div className="mt-1 text-[11px]">{error}</div>}
        {result && (
          <pre className="mt-1.5 text-[10px] font-mono whitespace-pre-wrap break-all bg-white/60 rounded p-1.5 max-h-32 overflow-y-auto">
{JSON.stringify(result.body ?? result, null, 2)}
          </pre>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Field label="Direction">
          <select className="input" value={direction} onChange={(e) => setDirection(e.target.value as 'entry'|'exit')} disabled={running}>
            <option value="entry">Entry (initCard)</option>
            <option value="exit">Exit (initTxn + charge)</option>
          </select>
        </Field>
        <Field label="Plate"><Input value={plate} onChange={setPlate} /></Field>
        {direction === 'exit' && (
          <>
            <Field label="Fare (cents)"><Input value={fareAmount} onChange={setFareAmount} type="number" /></Field>
            <Field label="Entry Dt (echo to reader)"><Input value={entryDt} onChange={setEntryDt} /></Field>
          </>
        )}
      </div>

      <div className="flex flex-wrap gap-2 pt-1">
        <button onClick={runFlow} disabled={!!busy || running}
          className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-40">
          <Play size={13} strokeWidth={2.5} /> Run {direction === 'entry' ? 'entry' : 'exit'} flow
        </button>
        {phase !== 'idle' && !running && (
          <button onClick={reset}
            className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg border border-gray-200 hover:border-gray-900 text-gray-700 text-xs font-bold uppercase tracking-wide">
            Reset
          </button>
        )}
        {running && (
          <button onClick={() => { window.bridge.terminalAbort(terminalId, 'failed').catch(() => null); reset(); }}
            className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg border border-red-200 hover:border-red-400 text-red-700 text-xs font-bold uppercase tracking-wide">
            Cancel
          </button>
        )}
      </div>

      <p className="text-[11px] text-gray-500 leading-relaxed">
        <strong>Entry</strong> — sends <code className="font-mono">initCard</code>, the reader prompts the user to tap, and on tap pushes <code className="font-mono">cardRead</code> with the masked PAN. No charge is made; the plate is associated locally with the card.<br />
        <strong>Exit</strong> — sends <code className="font-mono">initTxn</code> with the plate + fare. Reader handles the EMV / TNG debit internally and pushes <code className="font-mono">txnStatus</code> with APPROVED / DECLINED. Timeout: 60 seconds.
      </p>
    </ApiCard>
  );
}

function InitCardForm({ terminalId, busy, runWrap }: { terminalId: number; busy: string | null; runWrap: any }) {
  const [fareClass, setFareClass] = useState('1');
  const [retrigger, setRetrigger] = useState<'0'|'1'>('1');
  const [titleTXT, setTitleTXT] = useState('Sentuhkan Kad');
  const [messageTXT, setMessageTXT] = useState('Please tap your card');

  // Diagnostic: full reset → initCard → wait 2s → getStatus.
  // Reader's `body.state` field in the getStatus response tells us if the
  // scanner armed correctly:
  //   "01" = idle           → reader received initCard but didn't arm
  //   "02" = scanning card  → scanner armed; if tap still does nothing it's
  //                            a hardware issue (try another card type)
  //   "03" = card detecting  → reader sees something but can't read
  //   "04" = card detected   → tap was registered but response not sent yet
  //   "99" = not in use      → operationMode wrong; re-send initTerminal Live
  async function diagnose() {
    await window.bridge.terminalAbort(terminalId, 'silent');
    await new Promise((r) => setTimeout(r, 400));
    await window.bridge.terminalFinTxn(terminalId);
    await new Promise((r) => setTimeout(r, 400));
    await window.bridge.terminalInitCard(terminalId, { fareClass: '1', retrigger: '1' });
    await new Promise((r) => setTimeout(r, 2000));
    await window.bridge.terminalGetStatus(terminalId);
  }

  return (
    <ApiCard
      title="Init Card — tap-to-read flow (V1.17C LPR firmware)"
      subtitle="Your reader responds to initCard but ignored initEntry — that's V1.17C LPR firmware. Use this for tap testing. If display says 'tap card' but tap fires nothing, click Diagnostic below to see if the scanner actually armed."
      busy={busy} runWrap={runWrap} icon={Bolt}
      actions={[
        { label: 'Trigger (custom body)',                  run: () => window.bridge.terminalInitCard(terminalId, { fareClass, retrigger, titleTXT, messageTXT }) },
        { label: 'Minimal (fareClass + retrigger only)',   run: () => window.bridge.terminalInitCard(terminalId, { fareClass: '1', retrigger: '1' }) },
        { label: 'One-shot mode (retrigger=0)',            run: () => window.bridge.terminalInitCard(terminalId, { fareClass: '1', retrigger: '0' }) },
        { label: 'Diagnostic (init + getStatus after 2s)', run: diagnose },
      ]}>
      <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-[11px] text-amber-900 space-y-1">
        <div><strong>Tap not registering?</strong> Click <em>Diagnostic</em>. After 2s, look in the frame log on the right for the <code className="font-mono">getStatus</code> reply. Check <code className="font-mono">body.state</code>:</div>
        <div className="ml-3 font-mono">
          <div><code>"01"</code> = idle — scanner not armed. Try <em>Minimal body</em> or <em>One-shot mode</em>.</div>
          <div><code>"02"</code> or <code>"2A"</code> / <code>"2B"</code> = scanning — scanner IS armed.</div>
          <div><code>"03"</code> / <code>"04"</code> = card detecting / detected — tap registered.</div>
          <div><code>"05"</code> = host authorizing — payment in flight.</div>
          <div><code>"99"</code> = not in use — operationMode wrong. Re-send Init Terminal → Live.</div>
        </div>
        <div className="mt-1.5 pt-1.5 border-t border-amber-200"><strong>Scanner armed but tap fires nothing?</strong> Hardware/card issue, not protocol:</div>
        <div className="ml-3">
          <div>· Try a different card type (TNG, Visa contactless, MyDebit)</div>
          <div>· Hold card flat against the display face, wait 2 seconds</div>
          <div>· Remove from wallet — metal shields the RF</div>
          <div>· If tcsSimulator can't read it either, the antenna needs servicing</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Fare Class"><Input value={fareClass} onChange={setFareClass} /></Field>
        <Field label="Retrigger"><select className="input" value={retrigger} onChange={(e) => setRetrigger(e.target.value as any)}><option value="1">1 (re-trigger)</option><option value="0">0 (one-shot)</option></select></Field>
        <Field label="Title (≤18)"><Input value={titleTXT} onChange={setTitleTXT} /></Field>
        <Field label="Message (≤40)"><Input value={messageTXT} onChange={setMessageTXT} /></Field>
      </div>
    </ApiCard>
  );
}

function InitEntryForm({ terminalId, busy, runWrap }: { terminalId: number; busy: string | null; runWrap: any }) {
  const [mode, setMode] = useState<'0'|'1'|'2'>('2');
  const [fareAmount, setFareAmount] = useState('0');
  const [fareClass, setFareClass] = useState('1');

  // Full reset + initEntry sequence:
  //   1. abortTxn — cancels any in-flight scan
  //   2. finTxn  — wraps up any open transaction (some firmware needs this
  //                step even if abort succeeded; without it the reader stays
  //                "in transaction" internally and silently drops subsequent
  //                init commands)
  //   3. wait — 500ms between each so the frames don't collide on the wire
  //   4. initEntry — uses the Unity sample's known-working defaults:
  //      mode=1 (Sale Reversal), fareAmount=100 (RM 1.00), fareClass=1.
  //      Mode 2 (Card Validate) + fareAmount 0 confuses some firmware.
  async function quickTest() {
    await window.bridge.terminalAbort(terminalId, 'silent');
    await new Promise((r) => setTimeout(r, 500));
    await window.bridge.terminalFinTxn(terminalId);
    await new Promise((r) => setTimeout(r, 500));
    await window.bridge.terminalInitEntry(terminalId, { mode: '1', fareAmount: 100, fareClass: '1' });
  }

  return (
    <ApiCard
      title="Init Entry (kiosk mode) — the reliable card-tap test"
      subtitle="If Init Card doesn't push anything after a tap, use this. Quick test auto-resets the reader first (sends Abort Txn) so it's not stuck in a previous scanning state."
      busy={busy} runWrap={runWrap} icon={ArrowRightCircle}
      actions={[
        { label: 'Quick test (full reset + mode 1, fare RM 1.00)', run: () => quickTest() },
        { label: 'Send with current form (no reset)',              run: () => window.bridge.terminalInitEntry(terminalId, { mode, fareAmount: Number(fareAmount), fareClass }) },
      ]}>
      <div className="rounded-lg bg-blue-50 border border-blue-200 px-3 py-2 text-[11px] text-blue-900">
        <strong>Quick test does:</strong> 1) abortTxn → 2) finTxn → 3) initEntry mode 1 fare 100 (RM 1.00). The two-step reset clears stuck reader states; mode 1 + fare 100 are the Unity sample's proven defaults.
        <br /><strong>Watch the Frame log on the right.</strong> After "send initEntry" you should see a "recv initEntry" ack within 100ms. No ack = reader rejected (try checking laneType: try "open" instead of "dual") or signature mismatch (try empty secret key).
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Field label="Mode"><select className="input" value={mode} onChange={(e) => setMode(e.target.value as any)}><option value="0">0 Pre-Auth</option><option value="1">1 Sale Reversal</option><option value="2">2 Card Validate</option></select></Field>
        <Field label="Fare Amount (cents)"><Input value={fareAmount} onChange={setFareAmount} type="number" /></Field>
        <Field label="Fare Class"><Input value={fareClass} onChange={setFareClass} /></Field>
      </div>
    </ApiCard>
  );
}

function InitExitForm({ terminalId, busy, runWrap }: { terminalId: number; busy: string | null; runWrap: any }) {
  const [mode, setMode] = useState<'0'|'1'|'2'>('1');
  return (
    <ApiCard title="Init Exit (kiosk mode)" subtitle="Start exit transaction. Reader pushes initExitStatus with entryDt of the matched entry." busy={busy} runWrap={runWrap} icon={ArrowLeftCircle}
      actions={[{ label: 'Send initExit', run: () => window.bridge.terminalInitExit(terminalId, { mode }) }]}>
      <div className="grid grid-cols-1 gap-2">
        <Field label="Mode"><select className="input" value={mode} onChange={(e) => setMode(e.target.value as any)}><option value="0">0 Pre-Auth</option><option value="1">1 Sale Reversal</option><option value="2">2 Card Validate</option></select></Field>
      </div>
    </ApiCard>
  );
}

function InitTxnForm({ terminalId, busy, runWrap }: { terminalId: number; busy: string | null; runWrap: any }) {
  const [fareAmount, setFareAmount] = useState('350');
  const [fareClass, setFareClass] = useState('1');
  const [vehicleNo, setVehicleNo] = useState('VMM1234');
  const [entryDt, setEntryDt] = useState(() => {
    const d = new Date(); const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  });
  const [entryLane, setEntryLane] = useState('');
  const [gstAmount, setGstAmount] = useState('0');
  const [pAmount, setPAmount] = useState('350');
  return (
    <ApiCard title="Init Txn (LPR mode — full fare)" subtitle="Drives the full EMV flow with fare breakdown. Reader pushes txnStatus when payment lands." busy={busy} runWrap={runWrap} icon={Receipt}
      actions={[{
        label: 'Send initTxn',
        run: () => window.bridge.terminalInitTxn(terminalId, {
          fareAmount: Number(fareAmount), fareClass, vehicleNo,
          entryDt: entryDt || undefined,
          entryLane: entryLane || undefined,
          gstAmount: Number(gstAmount), pAmount: Number(pAmount),
        }),
      }]}>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Fare Amount (cents)"><Input value={fareAmount} onChange={setFareAmount} type="number" /></Field>
        <Field label="Fare Class"><Input value={fareClass} onChange={setFareClass} /></Field>
        <Field label="Vehicle No"><Input value={vehicleNo} onChange={setVehicleNo} /></Field>
        <Field label="Entry Dt"><Input value={entryDt} onChange={setEntryDt} /></Field>
        <Field label="Entry Lane"><Input value={entryLane} onChange={setEntryLane} /></Field>
        <Field label="P Amount"><Input value={pAmount} onChange={setPAmount} type="number" /></Field>
        <Field label="GST Amount"><Input value={gstAmount} onChange={setGstAmount} type="number" /></Field>
      </div>
    </ApiCard>
  );
}

function ProceedExitForm({ terminalId, busy, runWrap }: { terminalId: number; busy: string | null; runWrap: any }) {
  const [fareAmount, setFareAmount] = useState('350');
  const [fareClass, setFareClass] = useState('1');
  const [fallTimeout, setFallTimeout] = useState('0');
  const [payFlag, setPayFlag] = useState<-1|0|1>(-1);
  return (
    <ApiCard title="Proceed Exit" subtitle="Manually fire proceedExit (normally automatic after initExitStatus)." busy={busy} runWrap={runWrap} icon={ArrowLeftCircle}
      actions={[{
        label: 'Send proceedExit',
        run: () => window.bridge.terminalProceedExit(terminalId, {
          fareAmount: Number(fareAmount), fareClass, fallTimeout: Number(fallTimeout), payFlag,
        }),
      }]}>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Fare Amount (cents)"><Input value={fareAmount} onChange={setFareAmount} type="number" /></Field>
        <Field label="Fare Class"><Input value={fareClass} onChange={setFareClass} /></Field>
        <Field label="Fall Timeout (s)"><Input value={fallTimeout} onChange={setFallTimeout} type="number" /></Field>
        <Field label="Pay Flag">
          <select className="input" value={payFlag} onChange={(e) => setPayFlag(Number(e.target.value) as -1|0|1)}>
            <option value={-1}>omit</option>
            <option value={0}>0 TNG Purse</option>
            <option value={1}>1 TNG E-Wallet</option>
          </select>
        </Field>
      </div>
    </ApiCard>
  );
}

/**
 * showStatus — refresh the reader's display with a custom title + message
 * + sound + icon. Per V1.17C section 4.10, the reader screen otherwise
 * sits on the previous frame (typically "tap card") even AFTER a successful
 * transaction — the cardholder needs visual confirmation that the payment
 * went through. Quick presets cover the common cases; custom fields let
 * you push anything you want (lot full, maintenance, season pass welcome).
 */
function ShowStatusForm({ terminalId, busy, runWrap }: { terminalId: number; busy: string | null; runWrap: any }) {
  const [titleTXT, setTitleTXT] = useState('Thank you');
  const [messageTXT, setMessageTXT] = useState('Have a safe drive');
  const [sound, setSound] = useState<'01'|'02'|'FF'>('01');
  const [image, setImage] = useState<'04'|'08'>('04');

  return (
    <ApiCard
      title="Show Status — push a message to the reader's display"
      subtitle="Use this after a transaction so the cardholder sees what happened (success / declined / welcome). Reader otherwise stays on the last screen until the next init."
      busy={busy} runWrap={runWrap} icon={CheckCircle2}
      actions={[
        { label: 'Custom message',  run: () => window.bridge.terminalShowStatus(terminalId, { titleTXT, messageTXT, sound, image }) },
        { label: 'Success preset',  run: () => window.bridge.terminalShowStatus(terminalId, { titleTXT: 'Paid · TQ', messageTXT: 'Have a safe drive', sound: '01', image: '04' }) },
        { label: 'Declined preset', run: () => window.bridge.terminalShowStatus(terminalId, { titleTXT: 'Declined', messageTXT: 'Card not accepted', sound: '02', image: '08' }) },
        { label: 'Welcome preset',  run: () => window.bridge.terminalShowStatus(terminalId, { titleTXT: 'Welcome', messageTXT: 'Drive in slowly', sound: '01', image: '04' }) },
      ]}>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Title (≤18)"><Input value={titleTXT} onChange={setTitleTXT} /></Field>
        <Field label="Message (≤40)"><Input value={messageTXT} onChange={setMessageTXT} /></Field>
        <Field label="Sound">
          <select className="input" value={sound} onChange={(e) => setSound(e.target.value as any)}>
            <option value="01">01 Success beep</option>
            <option value="02">02 Failed beep</option>
            <option value="FF">FF Silent</option>
          </select>
        </Field>
        <Field label="Image">
          <select className="input" value={image} onChange={(e) => setImage(e.target.value as any)}>
            <option value="04">04 Success icon (tick)</option>
            <option value="08">08 Failed icon (cross)</option>
          </select>
        </Field>
      </div>
    </ApiCard>
  );
}

// ─── tiny form primitives ──────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[10px] font-semibold uppercase tracking-wide text-gray-600 mb-1">{label}</label>
      {children}
      <style>{`.input { height: 36px; padding: 0 0.625rem; border: 1px solid #d1d5db; border-radius: 0.5rem; outline: none; font-size: 13px; width: 100%; background: white; } .input:focus { border-color: #111827; }`}</style>
    </div>
  );
}

function Input({ value, onChange, type = 'text' }: { value: string; onChange: (v: string) => void; type?: string }) {
  return <input type={type} className="input font-mono" value={value} onChange={(e) => onChange(e.target.value)} />;
}
