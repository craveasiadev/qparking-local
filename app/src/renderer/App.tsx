import { useEffect, useRef, useState } from 'react';
import {
  LayoutDashboard, CreditCard, Camera, Map, ListOrdered, Tag, Settings as SettingsIcon,
  Terminal as TerminalIcon, ChevronUp, ChevronDown, Activity,
  Grid3x3, MonitorPlay, MapPin, AlertTriangle, CheckCircle2, X, Receipt,
  Users, Car, RefreshCw, Loader2,
} from 'lucide-react';
import { Dashboard } from './pages/Dashboard';
import { Terminals } from './pages/Terminals';
import { Cameras } from './pages/Cameras';
import { Lanes } from './pages/Lanes';
import { ParkingPolicies } from './pages/ParkingPolicies';
import { Sessions } from './pages/Sessions';
import { Transactions } from './pages/Transactions';
import { Sites } from './pages/Sites';
import { LiveDisplay } from './pages/LiveDisplay';
import { Settings } from './pages/Settings';
import { ParkingSpaces } from './pages/ParkingSpaces';
import { CustomerManagement } from './pages/CustomerManagement';
import { VehicleManagement } from './pages/VehicleManagement';
import { ActivityLogs } from './pages/ActivityLogs';
import { NotConnectedNotice } from './components/NotConnectedNotice';
import { useCurrentSite } from '../context/SiteContext';
import { fmtTime, fmtTimeSeconds } from './lib/datetime';
import { subscribeToast } from './toast';

type Page =
  | 'dashboard' | 'live' | 'cameras' | 'terminals' | 'lanes' | 'sessions' | 'transactions'
  // Parking Management
  | 'parking-spaces' | 'customers' | 'vehicles'
  // Pricing & Tariffs
  | 'policies'
  // System
  | 'settings' | 'sites' | 'activity_logs';

interface NavItem { id: Page; label: string; icon: any }
interface NavSection { key: string; label: string; items: NavItem[] }

// Every page centres its content at this width (matches each page's root
// container). The global not-connected banner reuses it so it lines up with
// the page below instead of running full-bleed. Change here + in the page
// containers together if the app-wide content width ever changes.
const PAGE_MAX_WIDTH = 'max-w-7xl';

// Sidebar matches the cloud SaaS operator menu groupings so an operator who
// uses both surfaces sees the same mental map. Categories that don't exist
// locally (HQ-only: Refunds, Customer Mgmt, Corporate Billing, etc.) are
// deliberately omitted — they're admin workflows that live in the cloud.
const SECTIONS: NavSection[] = [
  {
    key: 'ops', label: 'Operations',
    items: [
      { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { id: 'live', label: 'Live display', icon: MonitorPlay },
      { id: 'sessions', label: 'Parking Activity', icon: ListOrdered },
      { id: 'transactions', label: 'Transactions', icon: Receipt },
      { id: 'cameras', label: 'LPR cameras', icon: Camera },
      { id: 'terminals', label: 'Payment terminals', icon: CreditCard },
      { id: 'lanes', label: 'Lanes', icon: Map },
    ],
  },
  {
    key: 'mgmt', label: 'Parking management',
    items: [
      // Same words, same order as the cloud operator menu, so staff switching
      // between the two surfaces read one mental map:
      //   Customers -> who parks here      Bays -> what we have
      // The cloud calls a physical slot a "bay" (code/routes/DB still say
      // `space`).
      { id: 'customers', label: 'Customers', icon: Users },
      { id: 'parking-spaces', label: 'Bays', icon: Grid3x3 },
      // Three entries, like the cloud — but the third is Vehicles, not Plans.
      //
      // The cloud's "Plans" is its pass_products CATALOGUE (name, price,
      // duration), which the box does not hold: it caches the passes people
      // HOLD so the gate can decide offline.
      //
      // And the old separate "Passes" page merged into this one (2026-08-11):
      // both were plate-keyed lists of the same cars, each holding half the
      // answer. At a barrier there is one question — "this plate: who is it, is
      // it blocked, is it paid for?" — so it is one page.
      { id: 'vehicles', label: 'Vehicles', icon: Car },
    ],
  },
  {
    key: 'pricing', label: 'Pricing & tariffs',
    items: [
      { id: 'policies', label: 'Parking Rates', icon: Tag },
    ],
  },
  {
    key: 'system', label: 'Administration',
    items: [
      { id: 'activity_logs', label: 'Activity Logs', icon: Activity },
      { id: 'sites', label: 'Sites', icon: MapPin },
      { id: 'settings', label: 'Settings', icon: SettingsIcon },
    ],
  },
];

interface DebugLogEntry {
  ts: string;
  text: string;
}

/**
 * Header cloud-pull stamp + manual "Sync now".
 *
 * There is no recurring pull timer any more (see cloud-sync.ts) — cloud-owned
 * data, the barrier's deny list and season passes included, refreshes only at
 * boot, on a site rebind, or when someone presses this button.
 */
function CloudSyncStamp() {
  const [pullState, setPullState] = useState<{ lastCloudPullAt: string; lastCloudPullError: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    window.bridge.getCloudPullState()
      .then((s) => { if (alive) setPullState(s); })
      .catch(() => null);
    const off = window.bridge.onEvent('cloud-pull', (p: any) => { if (alive) setPullState(p); });
    return () => { alive = false; off(); };
  }, []);

  async function syncNow() {
    setBusy(true);
    try { await window.bridge.syncAllNow(); }
    finally { setBusy(false); }
  }

  const pulledAt = pullState?.lastCloudPullAt || '';
  const pullError = pullState?.lastCloudPullError || '';
  const failed = !!pullError;
  const label = failed
    ? (pulledAt ? `Sync failed · last good ${fmtTime(pulledAt)}` : 'Sync failed · never synced')
    : (pulledAt ? `Synced ${fmtTime(pulledAt)}` : 'Never synced');

  return (
    <div className="flex items-center gap-3 min-w-0">
      <span
        className={`inline-flex items-center gap-1.5 text-[11px] font-medium min-w-0 ${failed ? 'text-red-600' : 'text-gray-500'}`}
        title={pullError || (pulledAt ? `Last clean cloud pull: ${pulledAt}` : 'No successful cloud pull yet')}
      >
        {failed ? <AlertTriangle size={12} className="flex-shrink-0" /> : <CheckCircle2 size={12} className="flex-shrink-0" />}
        <span className="truncate">{label}</span>
      </span>
      <button
        onClick={syncNow}
        disabled={busy}
        title="Pull passes, deny list, rates, bays and activity from the cloud now"
        className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-[11px] font-bold uppercase tracking-wide text-gray-700 disabled:opacity-50 flex-shrink-0"
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
        {busy ? 'Syncing' : 'Sync now'}
      </button>
    </div>
  );
}

/** A staff-facing alert toast. Distinct from the low-level parking-flow debug
 *  log — these are the few events an operator must ACT on. */
interface StaffAlert { id: number; tone: 'error' | 'warn' | 'success'; title: string; detail: string; }

/** Turn a raw parking-flow 'warning' kind into a plain-language message an
 *  on-site operator can act on. */
function describeWarning(kind: string, d: any): { title: string; detail: string } {
  switch (kind) {
    case 'exit-timeout':
      return { title: 'Payment device not responding', detail: 'No response from the card reader within 15s. Check the payment controller is powered on and reachable on the network (IP / port).' };
    case 'exit-no-terminal':
      return { title: 'No payment terminal on this lane', detail: 'Wire a payment terminal to this lane (Lanes → Terminal), then retrigger the exit.' };
    case 'exit-terminal-disabled':
      return { title: 'Payment terminal is disabled', detail: 'Enable this lane\'s terminal under Payment terminals, then retrigger.' };
    case 'exit-terminal-offline':
      return { title: 'Payment terminal offline', detail: 'The terminal isn\'t reachable. Check its power and network connection.' };
    case 'exit-tng-not-configured':
      return {
        title: 'Charge refused — payment callbacks are not running',
        detail: `${d?.reason ? `${String(d.reason).charAt(0).toUpperCase()}${String(d.reason).slice(1)}. ` : ''}Nothing was charged and the barrier stays closed: a tap would have deducted money this app could not record. Fix it in Settings, then retrigger the exit — or release the car manually from Parking Activity.`,
      };
    case 'exit-charge-crashed':
      return { title: 'Payment failed unexpectedly', detail: d?.message ? String(d.message) : 'The charge crashed mid-way. Retrigger the exit.' };
    case 'exit-busy':
      return { title: 'Payment already in progress', detail: 'A charge is already running on this lane — wait for it to finish.' };
    case 'exit-without-entry':
      return { title: 'Exit with no entry record', detail: `No open session for ${d?.plate ?? 'this plate'}. Check the plate reading or create an entry.` };
    case 'exit-no-lane':
      return { title: 'Exit on an unconfigured lane', detail: 'The exit camera isn\'t mapped to a lane. Assign it under Cameras / Lanes.' };
    case 'exit-blacklisted':
      return {
        title: `Blocked vehicle at the exit — ${d?.plate ?? 'unknown plate'}`,
        detail: `${d?.reason ? `Reason: ${d.reason}. ` : ''}The barrier stays closed and nothing was charged — the car is held. Speak to the driver, then either lift the ban in the cloud or release the session manually from Parking Activity.`,
      };
    case 'entry-blacklisted':
      return {
        title: `Blocked vehicle at the entry — ${d?.plate ?? 'unknown plate'}`,
        detail: `${d?.reason ? `Reason: ${d.reason}. ` : ''}Entry refused — no session was opened and the turnstile stayed down. If the vehicle barrier let it through anyway it will still be refused at the exit. Lift the ban in the cloud to admit it.`,
      };
    default:
      return { title: 'Parking-flow warning', detail: kind || 'Unknown warning' };
  }
}

export function App() {
  const [page, setPage] = useState<Page>('dashboard');
  const site = useCurrentSite();
  const [buildInfo, setBuildInfo] = useState<{ version: string; isPackaged: boolean } | null>(null);
  const [debugLog, setDebugLog] = useState<DebugLogEntry[]>([]);
  const [debugOpen, setDebugOpen] = useState(true);
  const logEndRef = useRef<HTMLDivElement>(null);
  const [devMode, setDevMode] = useState(false);
  const [devHint, setDevHint] = useState<string | null>(null);
  const devTapCount = useRef(0);
  const devTapTimer = useRef<number | null>(null);
  const [alerts, setAlerts] = useState<StaffAlert[]>([]);
  const alertId = useRef(0);

  function pushAlert(a: Omit<StaffAlert, 'id'>, ttlMs = 12_000) {
    const id = ++alertId.current;
    setAlerts((cur) => [...cur, { ...a, id }].slice(-4)); // keep the 4 most recent
    if (ttlMs > 0) window.setTimeout(() => setAlerts((cur) => cur.filter((x) => x.id !== id)), ttlMs);
  }
  const dismissAlert = (id: number) => setAlerts((cur) => cur.filter((x) => x.id !== id));

  useEffect(() => {
    window.bridge.getAppVersion()
      .then((info) => {
        setBuildInfo(info);
        console.log(`[qparking-local] running build v${info.version} (${info.isPackaged ? 'packaged' : 'dev'})`);
      })
      .catch(() => null);
  }, []);

  useEffect(() => {
    const off = window.bridge.onEvent('parking-flow-log', (p: any) => {
      setDebugLog((cur) => {
        const next = [...cur, p as DebugLogEntry];
        return next.length > 200 ? next.slice(next.length - 200) : next;
      });
    });
    return off;
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [debugLog]);

  // App-wide staff alerts. Surface the few parking-flow events an operator must
  // ACT on (payment device errors, declines) as toasts on ANY page — the
  // low-level debug log below is for diagnosis, this is for the person at the gate.
  useEffect(() => {
    const off = window.bridge.onEvent('session', (p: any) => {
      const kind = p?.kind; const d = p?.payload ?? {};
      if (kind === 'warning') {
        const m = describeWarning(d?.kind, d);
        pushAlert({ tone: 'error', title: m.title, detail: m.detail });
      } else if (kind === 'exit-declined') {
        pushAlert({ tone: 'error', title: 'Card declined', detail: 'The payment was declined — the barrier stays closed. Ask the driver to retry, or release the car manually from Parking Activity.' });
      }
    });
    return off;
  }, []);

  // Bridge the module-level toast bus (toast()) to the on-screen stack so any
  // component — e.g. the device Push/Pull buttons — can raise a toast.
  useEffect(() => subscribeToast(({ tone, title, detail, ttlMs }) =>
    pushAlert({ tone, title, detail: detail ?? '' }, ttlMs)), []);

  useEffect(() => {
    window.bridge.getSettings().then((s: any) => setDevMode(!!s.devMode)).catch(() => null);
  }, []);

  // Hidden dev-mode toggle: tap the build-version stamp 7× within ~2s. Kept
  // obscure so operators never stumble into it, but trivial for a developer
  // who knows the gesture. Persisted via settings so it survives reloads.
  function tapVersion() {
    devTapCount.current += 1;
    if (devTapTimer.current) window.clearTimeout(devTapTimer.current);
    devTapTimer.current = window.setTimeout(() => { devTapCount.current = 0; }, 2000);
    if (devTapCount.current >= 7) {
      devTapCount.current = 0;
      const next = !devMode;
      setDevMode(next);
      window.bridge.saveSettings({ devMode: next }).catch(() => null);
      // Audited: dev mode unlocks the session simulator, which writes real
      // session + transaction rows. Someone reviewing "why is there an entry
      // stamped 3am" needs to see that the gesture was used.
      window.bridge.insertActivityLog({
        eventKey: 'config.dev_mode.toggled',
        action: 'edit',
        category: 'config',
        severity: 'medium',
        outcome: 'ok',
        resourceType: 'app_settings',
        description: `Dev mode ${next ? 'ENABLED' : 'disabled'}${next ? ' — the session simulator is now available on the Parking Activity page' : ''}`,
        changes: { devMode: next },
      }).catch(() => null);
      setDevHint(next ? 'Dev mode ON' : 'Dev mode OFF');
      window.setTimeout(() => setDevHint(null), 2500);
    }
  }

  return (
    <div className="h-full flex bg-gray-50">
      <aside className="w-60 flex-shrink-0 bg-gray-950 text-white flex flex-col">
        <div className="px-5 h-14 flex items-center gap-2 border-b border-white/10">
          <div className="w-7 h-7 rounded-md bg-white text-gray-900 flex items-center justify-center font-bold">Q</div>
          <div>
            <div className="text-sm font-bold tracking-tight">QParking</div>
            <div className="text-[10px] text-white/40 uppercase tracking-widest">Local Server</div>
          </div>
        </div>
        <nav className="flex-1 p-2 space-y-3 overflow-y-auto">
          {SECTIONS.map((section) => (
            <div key={section.key}>
              <div className="px-3 pt-1 pb-1 text-[10px] uppercase tracking-widest text-white/30 font-semibold">
                {section.label}
              </div>
              <div className="space-y-0.5">
                {section.items.map((p) => {
                  const active = page === p.id;
                  return (
                    <button
                      key={p.id}
                      onClick={() => setPage(p.id)}
                      className={`w-full flex items-center gap-3 px-3 h-9 rounded-lg text-[13px] font-medium transition-colors ${active ? 'bg-white text-gray-900' : 'text-white/70 hover:bg-white/5 hover:text-white'
                        }`}
                    >
                      <p.icon size={15} strokeWidth={2.25} />
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
        {/* Version footer — kept prominent so an operator can instantly tell
            which build they're on, and a support engineer can eyeball dev vs
            packaged. If a v0.14.1 window is running side-by-side with a
            v0.14.8 window, the digit changes here make it obvious which is
            which. */}
        <div className="p-3 border-t border-white/10">
          <div className="flex items-center justify-between gap-2">
            <div onClick={tapVersion} className="cursor-default select-none">
              <div className="text-[9px] uppercase tracking-widest text-white/40 font-semibold">Build</div>
              <div className="text-sm font-bold font-mono text-white/90">
                v{buildInfo?.version ?? '…'}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {devMode && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-400/40">
                  QA
                </span>
              )}
              {buildInfo && (
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider ${
                  buildInfo.isPackaged
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-400/40'
                    : 'bg-amber-500/20 text-amber-300 border border-amber-400/40'
                }`}>
                  {buildInfo.isPackaged ? 'installed' : 'dev'}
                </span>
              )}
            </div>
          </div>
          {devHint && (
            <div className="mt-2 text-[10px] font-bold uppercase tracking-wider text-fuchsia-300">{devHint}</div>
          )}
        </div>
      </aside>
      <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {/* App-wide header. Present on every page so the cloud-pull stamp and
            "Sync now" are always one glance / one click away — the recurring
            60s pull was removed, so this is the operator's only routine way to
            refresh passes and the barrier deny list. */}
        <header className="flex-shrink-0 h-11 bg-white border-b border-gray-200 flex items-center justify-between gap-4 px-5 sm:px-8">
          <div className="flex items-center gap-1.5 min-w-0">
            <MapPin size={12} className="text-gray-400 flex-shrink-0" />
            <span className="text-[12px] font-semibold text-gray-800 truncate">
              {site?.name ?? 'No site linked'}
            </span>
          </div>
          <CloudSyncStamp />
        </header>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {/* Global connection banner — every page except Settings (where the
              operator fixes the link) gets the "not connected" notice until a
              site syncs down. */}
          {page !== 'settings' && !site && (
            <div className={`px-5 sm:px-8 pt-5 sm:pt-8 mx-auto ${PAGE_MAX_WIDTH}`}>
              <NotConnectedNotice />
            </div>
          )}
          {page === 'dashboard' && <Dashboard />}
          {page === 'live' && <LiveDisplay />}
          {page === 'cameras' && <Cameras />}
          {page === 'terminals' && <Terminals devMode={devMode} />}
          {page === 'lanes' && <Lanes />}
          {page === 'sessions' && <Sessions devMode={devMode} />}
          {page === 'transactions' && <Transactions />}
          {page === 'parking-spaces' && <ParkingSpaces />}
          {page === 'customers' && <CustomerManagement />}
          {page === 'vehicles' && <VehicleManagement />}
          {page === 'policies' && <ParkingPolicies />}
          {page === 'activity_logs' && <ActivityLogs />}
          {page === 'sites' && <Sites />}
          {page === 'settings' && <Settings />}
        </div>
        <div className="flex-shrink-0 bg-gray-950 text-white border-t border-white/10">
          <button
            onClick={() => setDebugOpen((o) => !o)}
            className="w-full flex items-center justify-between px-4 h-8 text-[11px] uppercase tracking-widest text-white/60 hover:text-white"
          >
            <span className="inline-flex items-center gap-2">
              <TerminalIcon size={12} />
              Parking-flow live log ({debugLog.length})
            </span>
            <span className="inline-flex items-center gap-2">
              {debugLog.length > 0 && (
                <span
                  onClick={(e) => { e.stopPropagation(); setDebugLog([]); }}
                  className="px-2 py-0.5 text-[10px] rounded bg-white/10 hover:bg-white/20 cursor-pointer"
                >Clear</span>
              )}
              {debugOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            </span>
          </button>
          {debugOpen && (
            <div className="max-h-48 overflow-y-auto px-4 pb-2 font-mono text-[11px] leading-relaxed">
              {debugLog.length === 0 ? (
                <div className="py-2 text-white/40">No parking-flow activity yet. Trigger an exit (real LPR or Demo flow) to see live decisions.</div>
              ) : (
                debugLog.map((entry, i) => {
                  const t = entry.text.toLowerCase();
                  const color = t.includes('ignored') || t.includes('replay') || t.includes('timeout') || t.includes('failed') || t.includes('rejected')
                    ? 'text-red-300'
                    : t.includes('settling') || t.includes('outcome=paid') || t.includes('received')
                      ? 'text-emerald-300'
                      : t.includes('step') || t.includes('initcard') || t.includes('aborttxn')
                        ? 'text-amber-200'
                        : 'text-white/70';
                  const time = fmtTimeSeconds(entry.ts);
                  return (
                    <div key={i} className={`whitespace-pre-wrap break-words ${color}`}>
                      <span className="text-white/30 mr-2">{time}</span>{entry.text}
                    </div>
                  );
                })
              )}
              <div ref={logEndRef} />
            </div>
          )}
        </div>
      </main>

      {/* App-wide staff alert toasts — float top-right over every page so a
          payment device error / decline is impossible to miss at the gate. */}
      {alerts.length > 0 && (
        <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 w-[360px] max-w-[calc(100vw-2rem)]">
          {alerts.map((a) => (
            <div
              key={a.id}
              className={`rounded-xl border shadow-lg p-3 flex items-start gap-3 animate-in ${
                a.tone === 'error'
                  ? 'bg-red-50 border-red-300 text-red-900'
                  : a.tone === 'warn'
                    ? 'bg-amber-50 border-amber-300 text-amber-900'
                    : 'bg-emerald-50 border-emerald-300 text-emerald-900'
              }`}
              role="alert"
            >
              {a.tone === 'success'
                ? <CheckCircle2 size={18} className="mt-0.5 flex-shrink-0" />
                : <AlertTriangle size={18} className="mt-0.5 flex-shrink-0" />}
              <div className="min-w-0 flex-1">
                <div className="text-sm font-bold">{a.title}</div>
                <div className="text-xs mt-0.5 leading-snug opacity-90">{a.detail}</div>
              </div>
              <button
                onClick={() => dismissAlert(a.id)}
                className="flex-shrink-0 opacity-60 hover:opacity-100"
                title="Dismiss"
              >
                <X size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
