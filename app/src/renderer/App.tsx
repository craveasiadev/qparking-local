import { useEffect, useRef, useState } from 'react';
import {
  LayoutDashboard, CreditCard, Camera, Map, ListOrdered, Tag, Settings as SettingsIcon,
  Terminal as TerminalIcon, ChevronUp, ChevronDown,
  Ticket, Grid3x3, Truck,
} from 'lucide-react';
import { Dashboard } from './pages/Dashboard';
import { Terminals } from './pages/Terminals';
import { Cameras } from './pages/Cameras';
import { Lanes } from './pages/Lanes';
import { Scopes } from './pages/Scopes';
import { Sessions } from './pages/Sessions';
import { Settings } from './pages/Settings';
import { Passes } from './pages/Passes';
import { Spaces } from './pages/Spaces';
import { VehicleTypes } from './pages/VehicleTypes';

type Page =
  | 'dashboard' | 'cameras' | 'terminals' | 'lanes' | 'sessions'
  // Parking Management
  | 'spaces' | 'passes'
  // Pricing & Tariffs
  | 'scopes' | 'vehicle-types'
  // System
  | 'settings';

interface NavItem { id: Page; label: string; icon: any }
interface NavSection { key: string; label: string; items: NavItem[] }

// Sidebar matches the cloud SaaS operator menu groupings so an operator who
// uses both surfaces sees the same mental map. Categories that don't exist
// locally (HQ-only: Refunds, Customer Mgmt, Corporate Billing, etc.) are
// deliberately omitted — they're admin workflows that live in the cloud.
const SECTIONS: NavSection[] = [
  {
    key: 'ops', label: 'Operations',
    items: [
      { id: 'dashboard',        label: 'Dashboard',         icon: LayoutDashboard },
      { id: 'sessions',         label: 'Sessions',          icon: ListOrdered },
      { id: 'cameras',          label: 'LPR cameras',       icon: Camera },
      { id: 'terminals',        label: 'Payment terminals', icon: CreditCard },
      { id: 'lanes',            label: 'Lanes',             icon: Map },
    ],
  },
  {
    key: 'mgmt', label: 'Parking management',
    items: [
      { id: 'spaces',           label: 'Space management',  icon: Grid3x3 },
      { id: 'passes',           label: 'Passes',            icon: Ticket },
    ],
  },
  {
    key: 'pricing', label: 'Pricing & tariffs',
    items: [
      { id: 'scopes',           label: 'Rate plans',        icon: Tag },
      { id: 'vehicle-types',    label: 'Vehicle types',     icon: Truck },
    ],
  },
  {
    key: 'system', label: 'System',
    items: [
      { id: 'settings',         label: 'Settings',          icon: SettingsIcon },
    ],
  },
];

interface DebugLogEntry {
  ts: string;
  text: string;
}

export function App() {
  const [page, setPage] = useState<Page>('dashboard');
  const [buildInfo, setBuildInfo] = useState<{ version: string; isPackaged: boolean } | null>(null);
  const [debugLog, setDebugLog] = useState<DebugLogEntry[]>([]);
  const [debugOpen, setDebugOpen] = useState(true);
  const logEndRef = useRef<HTMLDivElement>(null);

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

  return (
    <div className="min-h-full flex bg-gray-50">
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
                      className={`w-full flex items-center gap-3 px-3 h-9 rounded-lg text-[13px] font-medium transition-colors ${
                        active ? 'bg-white text-gray-900' : 'text-white/70 hover:bg-white/5 hover:text-white'
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
            <div>
              <div className="text-[9px] uppercase tracking-widest text-white/40 font-semibold">Build</div>
              <div className="text-sm font-bold font-mono text-white/90">
                v{buildInfo?.version ?? '…'}
              </div>
            </div>
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
      </aside>
      <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <div className="flex-1 min-h-0 overflow-y-auto">
          {page === 'dashboard' && <Dashboard />}
          {page === 'cameras' && <Cameras />}
          {page === 'terminals' && <Terminals />}
          {page === 'lanes' && <Lanes />}
          {page === 'sessions' && <Sessions />}
          {page === 'spaces' && <Spaces />}
          {page === 'passes' && <Passes />}
          {page === 'scopes' && <Scopes />}
          {page === 'vehicle-types' && <VehicleTypes />}
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
                  const time = new Date(entry.ts).toLocaleTimeString();
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
    </div>
  );
}
