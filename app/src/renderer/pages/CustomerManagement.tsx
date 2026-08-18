import { useEffect, useMemo, useState } from 'react';
import {
  Users, RefreshCw, CloudDownload, Clock, Car, Ticket, UserX,
} from 'lucide-react';
import { InfoTip } from '../components/InfoTip';
import { ContactCell, CountChip, HolderTypeBadge, isVisitor, holderTypeOf } from '../components/customer-directory';
import type { CloudCustomer } from '@shared/types';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { useReloadOnCloudSync } from '../hooks/useReloadOnCloudSync';
import { usePagedList } from '../hooks/usePagination';
import { PaginationBar } from '../components/Pagination';
import { toast } from '../toast';
import { fmtDateTime } from '../lib/datetime';

const PAGE_SIZE = 20;

/**
 * Customer directory — read-only mirror of the cloud's customers, so site staff
 * can look up a contact number or check someone's pass count without logging
 * into the qparking cloud portal in a browser.
 *
 * Scope comes from the cloud endpoint: anyone holding a pass at this site. The
 * pass is the ONLY thing that links a person to a site, so "customer here" and
 * "holds a pass here" are the same statement.
 *
 * VISITORS ARE NOT LISTED HERE — they have their own page, the same way the
 * cloud operator portal splits Customers from Visitors. Someone at a barrier is
 * asking one of two different questions ("who is this resident?" vs "is this
 * visitor expected?"), and mixing both populations into one list made the answer
 * slower to find. The two pages read the SAME mirror and partition it on
 * holder type, so nobody can be on both and nobody falls between them.
 */
type Filter = 'all' | 'resident' | 'staff' | 'season' | 'disabled';

export function CustomerManagement() {
  const [customers, setCustomers] = useState<CloudCustomer[]>([]);
  // Only to tell the operator where the rest went — this page never shows them.
  const [visitorCount, setVisitorCount] = useState(0);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  // The mirror carries every holder type; this page owns the non-visitor half of it.
  // Partitioned at load rather than in each filter/count so `customers` means
  // one thing throughout the page — including the "nothing cached yet" test,
  // which must not report an empty page when the cache holds visitors only.
  const [load, loading] = useAsyncAction(async () => {
    const all = await window.bridge.listCloudCustomers();
    const mine = all.filter((c) => !isVisitor(c));
    setCustomers(mine);
    setVisitorCount(all.length - mine.length);
  });

  const [syncFromCloud, syncing] = useAsyncAction(async () => {
    const result = await window.bridge.syncCloudCustomersNow();
    if (result.ok) toast({ tone: 'success', title: `Fetched ${result.fetched} customer(s) from cloud` });
    else toast({ tone: 'error', title: 'Sync failed', detail: String(result.error) });
    await load();
  });

  useEffect(() => { void load(); }, []);
  // A header "Sync now" (or the recurring tick) refreshes this mirror behind
  // the page's back — re-read it so the list on screen is the one just pulled.
  useReloadOnCloudSync(['customers'], load);

  const counts = useMemo(() => ({
    all: customers.length,
    resident: customers.filter((c) => holderTypeOf(c) === 'resident').length,
    staff: customers.filter((c) => holderTypeOf(c) === 'staff').length,
    season: customers.filter((c) => holderTypeOf(c) === 'season').length,
    disabled: customers.filter((c) => !c.isEnabled).length,
  }), [customers]);

  const filtered = customers.filter((c) => {
    if (filter !== 'all' && filter !== 'disabled' && holderTypeOf(c) !== filter) return false;
    if (filter === 'disabled' && c.isEnabled) return false;
    if (search) {
      const q = search.toLowerCase();
      const haystack = [c.fullName, c.email, c.phone].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
  const { pager, pageItems } = usePagedList(filtered, PAGE_SIZE);
  useEffect(() => { pager.reset(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filter, search]);

  const lastSynced = customers.reduce((m, c) => (c.fetchedAt && c.fetchedAt > m ? c.fetchedAt : m), '');

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto">
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight flex items-center gap-2">
            <Users size={22} /> Customers
            <InfoTip>
              Customers are added and edited in the qparking cloud portal
              (Parking Management → Customers). This page is a copy kept on this
              server so you can look up a name or phone number quickly, without
              logging into the cloud. Holder type, vehicle and pass counts all cover THIS
              site only — someone is only listed here because they hold a pass
              here. For a pass's dates, look the car up on the Vehicles page —
              that is where the term lives. Visitors are on their own page.
              Press "Sync from cloud" to get the latest list.
            </InfoTip>
          </h1>
          <p className="text-xs sm:text-sm text-gray-500 mt-1">
            Residents, staff and season holders — how to reach them, and how many vehicles and passes they hold.
            {visitorCount > 0 && ` ${visitorCount} visitor${visitorCount === 1 ? '' : 's'} are on the Visitors page.`}
          </p>
          {lastSynced && (
            <p className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-gray-400">
              <Clock size={12} /> Last synced {fmtDateTime(lastSynced)}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => load()} disabled={loading}
            className="inline-flex items-center justify-center gap-1.5 h-10 px-4 rounded-lg border border-gray-200 hover:border-gray-900 text-xs font-bold uppercase tracking-wide text-gray-700 disabled:opacity-50">
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button onClick={() => syncFromCloud()} disabled={syncing}
            className="inline-flex items-center justify-center gap-1.5 h-10 px-4 rounded-lg bg-gray-900 text-white hover:bg-gray-700 text-xs font-bold uppercase tracking-wide disabled:opacity-50">
            <CloudDownload size={13} className={syncing ? 'animate-pulse' : ''} /> Sync from cloud
          </button>
        </div>
      </header>

      <div className="mb-4 flex flex-wrap gap-2">
        {([
          { key: 'all', label: 'All', icon: Users },
          { key: 'resident', label: 'Residents', icon: Users },
          { key: 'staff', label: 'Staff', icon: Users },
          { key: 'season', label: 'Season', icon: Users },
          { key: 'disabled', label: 'Disabled', icon: UserX },
        ] as const).map((f) => {
          const active = filter === f.key;
          const Icon = f.icon;
          return (
            <button key={f.key} onClick={() => setFilter(f.key)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border ${
                active ? 'bg-gray-900 text-white border-transparent' : 'border-gray-200 text-gray-700 hover:border-gray-900'
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
          placeholder="Search name, email, phone…"
          className="flex-1 min-w-[200px] h-9 px-3 rounded-lg border border-gray-200 text-sm focus:border-gray-900 outline-none"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-sm text-gray-500">
          {customers.length === 0
            ? 'No customers cached yet. Press "Sync from cloud" (these directories aren\'t auto-synced).'
            : 'No customers match the current filter.'}
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          {/* DESKTOP TABLE */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-[10px] uppercase tracking-widest text-gray-500">
                <tr>
                  <th className="text-left px-3 py-2 font-bold">Name</th>
                  <th className="text-left px-3 py-2 font-bold">Contact</th>
                  <th className="text-left px-3 py-2 font-bold">Holder type</th>
                  <th className="text-right px-3 py-2 font-bold">Vehicles</th>
                  <th className="text-right px-3 py-2 font-bold">Passes here</th>
                  {/* The ACCOUNT, not the pass — those are different facts and
                      one header called "Status" was read as the other. */}
                  <th className="text-right px-3 py-2 font-bold">Account</th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((c) => (
                  <tr key={c.id} className={`border-t border-gray-100 ${!c.isEnabled ? 'bg-gray-50' : ''}`}>
                    <td className="px-3 py-2 font-semibold">{c.fullName || '—'}</td>
                    <td className="px-3 py-2 text-[12px] text-gray-600">
                      <ContactCell email={c.email} phone={c.phone} />
                    </td>
                    <td className="px-3 py-2"><HolderTypeBadge holderType={holderTypeOf(c)} /></td>
                    <td className="px-3 py-2 text-right font-mono text-[12px]">
                      <CountChip icon={Car} n={c.vehiclesCount} />
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-[12px]">
                      <CountChip icon={Ticket} n={c.activePassesCount} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      {c.isEnabled
                        ? <span className="text-[10px] uppercase font-bold text-emerald-700">Active</span>
                        : <span className="text-[10px] uppercase font-bold text-gray-500">Disabled</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* MOBILE CARDS */}
          <ul className="md:hidden divide-y divide-gray-100">
            {pageItems.map((c) => (
              <li key={c.id} className={`p-3 ${!c.isEnabled ? 'bg-gray-50' : ''}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{c.fullName || '—'}</span>
                  <HolderTypeBadge holderType={holderTypeOf(c)} />
                </div>
                <div className="mt-1.5 text-[11px] text-gray-600">
                  <ContactCell email={c.email} phone={c.phone} />
                </div>
                <div className="mt-1.5 flex items-center gap-3 text-[11px] text-gray-600">
                  <CountChip icon={Car} n={c.vehiclesCount} label="vehicles" />
                  <CountChip icon={Ticket} n={c.activePassesCount} label="passes here" />
                  {!c.isEnabled && <span className="uppercase font-bold text-gray-500">Disabled</span>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <PaginationBar pager={pager} rowsOnPage={pageItems.length} />
    </div>
  );
}
