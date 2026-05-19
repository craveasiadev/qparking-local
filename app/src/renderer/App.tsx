import { useState } from 'react';
import { LayoutDashboard, CreditCard, Camera, Map, ListOrdered, Tag, Settings as SettingsIcon } from 'lucide-react';
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

export function App() {
  const [page, setPage] = useState<Page>('dashboard');
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
        <div className="p-3 text-[10px] text-white/30 uppercase tracking-widest">v0.1.0</div>
      </aside>
      <main className="flex-1 min-w-0 overflow-y-auto">
        {page === 'dashboard' && <Dashboard />}
        {page === 'terminals' && <Terminals />}
        {page === 'cameras' && <Cameras />}
        {page === 'lanes' && <Lanes />}
        {page === 'scopes' && <Scopes />}
        {page === 'sessions' && <Sessions />}
        {page === 'settings' && <Settings />}
      </main>
    </div>
  );
}
