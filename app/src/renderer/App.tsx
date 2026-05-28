import { useEffect, useRef, useState } from 'react';
import { LayoutDashboard, CreditCard, Camera, Map, ListOrdered, Tag, Settings as SettingsIcon, Terminal as TerminalIcon, ChevronUp, ChevronDown } from 'lucide-react';
import { Dashboard } from './pages/Dashboard';
import { Terminals } from './pages/Terminals';
import { Cameras } from './pages/Cameras';
import { Lanes } from './pages/Lanes';
import { Scopes } from './pages/Scopes';
import { Sessions } from './pages/Sessions';
import { Settings } from './pages/Settings';

type Page = 'dashboard' | 'terminals' | 'cameras' | 'lanes' | 'scopes' | 'sessions' | 'settings';

const PAGES: { id: Page; label: string; icon: any }[] = [
  { id: 'dashboard', label: 'Dashboard',   icon: LayoutDashboard },
  { id: 'terminals', label: 'Terminals',   icon: CreditCard },
  { id: 'cameras',   label: 'LPR cameras', icon: Camera },
  { id: 'lanes',     label: 'Lanes',       icon: Map },
  { id: 'scopes',    label: 'Scopes',      icon: Tag },
  { id: 'sessions',  label: 'Sessions',    icon: ListOrdered },
  { id: 'settings',  label: 'Settings',    icon: SettingsIcon },
];

interface DebugLogEntry {
  ts: string;
  text: string;
}

export function App() {
  const [page, setPage] = useState<Page>('dashboard');
  const [buildInfo, setBuildInfo] = useState<{ version: string; isPackaged: boolean } | null>(null);
  // Live parking-flow log strip. Filled by main-process emit('debug-log').
  // Sticky bottom panel; operator can collapse it. Critical for diagnosing
  // "the reader auto-accepted without tapping" — every guard decision is
  // surfaced here so we don't need to chase DevTools.
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
        // Cap at 200 lines so memory stays bounded over a long shift.
        const next = [...cur, p as DebugLogEntry];
        return next.length > 200 ? next.slice(next.length - 200) : next;
      });
    });
    return off;
  }, []);

  useEffect(() => {
    // Auto-scroll the log to bottom whenever a new line comes in.
    logEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [debugLog]);

  return (
    <div className="min-h-full flex bg-gray-50">
      <aside className="w-56 flex-shrink-0 bg-gray-950 text-white flex flex-col">
        <div className="px-5 h-14 flex items-center gap-2 border-b border-white/10">
          <div className="w-7 h-7 rounded-md bg-white text-gray-900 flex items-center justify-center font-bold">Q</div>
          <div>
            <div className="text-sm font-bold tracking-tight">QParking</div>
            <div className="text-[10px] text-white/40 uppercase tracking-widest">Local Server</div>
          </div>
        </div>
        <nav className="flex-1 p-2 space-y-1">
          {PAGES.map((p) => {
            const active = page === p.id;
            return (
              <button
                key={p.id}
                onClick={() => setPage(p.id)}
                className={`w-full flex items-center gap-3 px-3 h-10 rounded-lg text-sm font-medium transition-colors ${
                  active ? 'bg-white text-gray-900' : 'text-white/70 hover:bg-white/5 hover:text-white'
                }`}
              >
                <p.icon size={16} strokeWidth={2.25} />
                {p.label}
              </button>
            );
          })}
        </nav>
        <div className="p-3 text-[10px] text-white/40 uppercase tracking-widest flex items-center justify-between">
          <span>v{buildInfo?.version ?? '…'}</span>
          {buildInfo && !buildInfo.isPackaged && <span className="text-amber-300/80">dev</span>}
        </div>
      </aside>
      <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <div className="flex-1 min-h-0 overflow-y-auto">
          {page === 'dashboard' && <Dashboard />}
          {page === 'terminals' && <Terminals />}
          {page === 'cameras' && <Cameras />}
          {page === 'lanes' && <Lanes />}
          {page === 'scopes' && <Scopes />}
          {page === 'sessions' && <Sessions />}
          {page === 'settings' && <Settings />}
        </div>
        {/* Live debug strip — sticky bottom panel showing every parking-flow
            decision in real-time. Operator can collapse if they don't want
            to look at it; data still streams in. */}
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
                  // Colour-code lines so the operator can spot rejections instantly:
                  //   red    — IGNORED / REPLAY / REJECTED / TIMEOUT / FAILED
                  //   green  — settling / received / cardRead / outcome=paid
                  //   amber  — STEP / initCard / abortTxn
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
