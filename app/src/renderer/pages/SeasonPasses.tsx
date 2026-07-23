import { useEffect, useState } from 'react';
import { Ticket, RefreshCw, AlertCircle, Crown, Calendar, Car, Cloud, Clock } from 'lucide-react';
import type { SeasonPass } from '@shared/types';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { fmtDateTime, todayInAppTz, dateInAppTz } from '../lib/datetime';

/**
 * Season passes view — every plate the gate currently honours without
 * driving the payment terminal. Includes season passes (monthly /
 * quarterly / yearly), corporate fleet, staff, VIP, and free-access
 * permits. The list is cached locally from `/api/v1/local-server/passes`
 * (refreshed by the periodic sync); the operator can also force a
 * refresh here.
 */
export function SeasonPasses() {
  const [passes, setPasses] = useState<SeasonPass[]>([]);
  const [filter, setFilter] = useState<'all' | 'free' | 'paid' | 'expiring'>('all');
  const [search, setSearch] = useState('');

  const [load, loading] = useAsyncAction(async () => {
    setPasses(await window.bridge.listSeasonPasses());
  });

  useEffect(() => { void load(); }, []);

  const today = todayInAppTz();
  const in7Days = dateInAppTz(new Date(Date.now() + 7 * 86400_000));

  const filtered = passes.filter((p) => {
    if (filter === 'free' && !p.isFree) return false;
    if (filter === 'paid' && p.isFree) return false;
    if (filter === 'expiring' && (!p.endDate || p.endDate < today || p.endDate > in7Days)) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!p.plateNumber.toLowerCase().includes(q) &&
          !p.passType.toLowerCase().includes(q) &&
          !(p.spaceNumber ?? '').toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const counts = {
    all: passes.length,
    free: passes.filter((p) => p.isFree).length,
    paid: passes.filter((p) => !p.isFree).length,
    expiring: passes.filter((p) => p.endDate && p.endDate >= today && p.endDate <= in7Days).length,
  };

  const lastSynced = passes.reduce((m, p) => (p.fetchedAt && p.fetchedAt > m ? p.fetchedAt : m), '');

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto">
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight flex items-center gap-2">
            <Ticket size={22} /> Season Passes
          </h1>
          <p className="text-xs sm:text-sm text-gray-500 mt-1">
            Every plate the gate opens for without charging. Cached from the cloud.
          </p>
          {lastSynced && (
            <p className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-gray-400">
              <Clock size={12} /> Last synced {fmtDateTime(lastSynced)}
            </p>
          )}
        </div>
        <button onClick={() => load()} disabled={loading}
          className="inline-flex items-center justify-center gap-1.5 h-10 px-4 rounded-lg border border-gray-200 hover:border-gray-900 text-xs font-bold uppercase tracking-wide text-gray-700 disabled:opacity-50">
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </header>

      {/* Source-of-truth callout — passes are owned by qparking cloud (a
          customer buys them via the customer portal, an operator approves
          them in HQ / Operator UI). This page is a read-only mirror kept
          fresh by the periodic sync. Making that obvious here prevents
          operators from expecting an "Add pass" button that isn't coming. */}
      <div className="mb-4 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 flex items-start gap-2.5">
        <Cloud size={16} className="text-blue-600 mt-0.5 flex-shrink-0" />
        <div className="text-xs text-blue-900 leading-relaxed">
          <p className="font-bold uppercase tracking-wide text-[10px]">Managed in cloud</p>
          <p className="mt-1">
            Season passes are created by customers in the qparking cloud portal
            (the Passes tab → "Apply for a new pass", after adding a vehicle
            under Profile → My vehicles) and approved by operators. This local
            view refreshes every few minutes so the LPR gate always sees the
            latest roster.
          </p>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {([
          { key: 'all',      label: 'All',       icon: Ticket },
          { key: 'paid',     label: 'Paid',      icon: Calendar },
          { key: 'free',     label: 'Free/VIP',  icon: Crown },
          { key: 'expiring', label: 'Expiring 7d', icon: AlertCircle },
        ] as const).map((f) => {
          const active = filter === f.key;
          const Icon = f.icon;
          return (
            <button key={f.key} onClick={() => setFilter(f.key)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold ${
                active ? 'bg-gray-900 text-white' : 'border border-gray-200 text-gray-700 hover:border-gray-900'
              }`}>
              <Icon size={12} /> {f.label}
              <span className={`ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold ${
                active ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-700'
              }`}>{counts[f.key]}</span>
            </button>
          );
        })}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search plate, type, space…"
          className="flex-1 min-w-[200px] h-9 px-3 rounded-lg border border-gray-200 text-sm focus:border-gray-900 outline-none"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-sm text-gray-500">
          {passes.length === 0
            ? 'No passes cached yet. Make sure qparking SaaS is reachable and Sync is running.'
            : 'No passes match the current filter.'}
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          {/* DESKTOP TABLE */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-[10px] uppercase tracking-widest text-gray-500">
                <tr>
                  <th className="text-left px-3 py-2 font-bold">Plate</th>
                  <th className="text-left px-3 py-2 font-bold">Type</th>
                  <th className="text-left px-3 py-2 font-bold">Valid</th>
                  <th className="text-left px-3 py-2 font-bold">Space</th>
                  <th className="text-right px-3 py-2 font-bold">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => {
                  const expiringSoon = p.endDate && p.endDate >= today && p.endDate <= in7Days;
                  return (
                    <tr key={`${p.passId}-${p.plateNumber}`} className={`border-t border-gray-100 ${expiringSoon ? 'bg-amber-50/40' : ''}`}>
                      <td className="px-3 py-2 font-mono font-semibold flex items-center gap-1.5">
                        <Car size={11} className="text-gray-400" /> {p.plateNumber}
                      </td>
                      <td className="px-3 py-2">
                        <PassTypeBadge isFree={p.isFree} passType={p.passType} />
                      </td>
                      <td className="px-3 py-2 text-[12px] font-mono text-gray-700">
                        {p.startDate ?? '—'} → {p.endDate ?? '—'}
                        {expiringSoon && <span className="ml-1.5 text-amber-700 font-bold text-[10px]">EXPIRING</span>}
                      </td>
                      <td className="px-3 py-2 font-mono text-[12px]">{p.spaceNumber ?? '—'}</td>
                      <td className="px-3 py-2 text-right">
                        <PassStatusBadge status={p.status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* MOBILE CARDS */}
          <ul className="md:hidden divide-y divide-gray-100">
            {filtered.map((p) => {
              const expiringSoon = p.endDate && p.endDate >= today && p.endDate <= in7Days;
              return (
                <li key={`${p.passId}-${p.plateNumber}`} className={`p-3 ${expiringSoon ? 'bg-amber-50/40' : ''}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono font-bold inline-flex items-center gap-1.5">
                      <Car size={12} className="text-gray-400" /> {p.plateNumber}
                    </span>
                    <PassStatusBadge status={p.status} />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <PassTypeBadge isFree={p.isFree} passType={p.passType} />
                    {p.spaceNumber && <span className="text-[11px] font-mono text-gray-500">space {p.spaceNumber}</span>}
                  </div>
                  <div className="mt-1.5 text-[11px] font-mono text-gray-500">
                    {p.startDate ?? '—'} → {p.endDate ?? '—'}
                    {expiringSoon && <span className="ml-1.5 text-amber-700 font-bold">EXPIRING</span>}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function PassTypeBadge({ isFree, passType }: { isFree: boolean; passType: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
      isFree ? 'bg-purple-100 text-purple-800' : 'bg-blue-100 text-blue-800'
    }`}>
      {isFree && <Crown size={9} />} {passType}
    </span>
  );
}

function PassStatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
      status === 'active' ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-700'
    }`}>{status}</span>
  );
}
