import { useEffect, useMemo, useState } from 'react';
import {
  UserPlus, RefreshCw, CloudDownload, Clock, Car, UserX, CheckCircle2, CircleSlash,
} from 'lucide-react';
import { InfoTip } from '../components/InfoTip';
import { ContactCell, CountChip, hasLivePass, isVisitor } from '../components/customer-directory';
import type { CloudCustomer } from '@shared/types';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { useReloadOnCloudSync } from '../hooks/useReloadOnCloudSync';
import { usePagedList } from '../hooks/usePagination';
import { PaginationBar } from '../components/Pagination';
import { toast } from '../toast';
import { fmtDateTime } from '../lib/datetime';

const PAGE_SIZE = 20;

/**
 * Visitors — the other half of the customer directory.
 *
 * A visitor is someone whose pass at THIS site carries the `visitor` role: a
 * dated pass, one car, no bay. They are ordinary customer rows in the mirror —
 * this page and Customers read the same `cloud_customers` cache and partition it
 * on role, so a person is on exactly one of the two. Split onto its own page
 * (2026-08-18) because the two populations answer different questions at a
 * barrier: Customers is "who is this resident and how do I reach them", this is
 * "is this guest expected, and is their pass still live".
 *
 * WHAT THIS PAGE CANNOT SHOW, and why. The cloud's own Visitors page reads
 * PASSES, so it also lists walk-ins registered at the counter — those carry the
 * name on the pass (`visitor_full_name`) and have no customer row at all. The
 * box's /customers feed requires a customer id, so a counter-registered walk-in
 * never reaches this cache and cannot appear here. Sponsored visitors do: the
 * resident portal creates a real customer for them first. Listing walk-ins too
 * would take a new site-scoped passes endpoint and a mirror of its own — worth
 * doing if the counter flow becomes the common one, but it is not a filter away.
 *
 * Read-only, like Customers: visitors are registered in the cloud portal or by a
 * resident from their own portal, never here.
 */
type Filter = 'all' | 'valid' | 'lapsed' | 'disabled';

export function VisitorManagement() {
  const [visitors, setVisitors] = useState<CloudCustomer[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  const [load, loading] = useAsyncAction(async () => {
    setVisitors((await window.bridge.listCloudCustomers()).filter(isVisitor));
  });

  // Same mirror as Customers, so the one pull refreshes both pages.
  const [syncFromCloud, syncing] = useAsyncAction(async () => {
    const result = await window.bridge.syncCloudCustomersNow();
    if (result.ok) toast({ tone: 'success', title: `Fetched ${result.fetched} customer(s) from cloud` });
    else toast({ tone: 'error', title: 'Sync failed', detail: String(result.error) });
    await load();
  });

  useEffect(() => { void load(); }, []);
  // A header "Sync now" (or the recurring tick) refreshes this mirror behind the
  // page's back — re-read it so the list on screen is the one just pulled.
  useReloadOnCloudSync(['customers'], load);

  const counts = useMemo(() => ({
    all: visitors.length,
    valid: visitors.filter(hasLivePass).length,
    lapsed: visitors.filter((v) => !hasLivePass(v)).length,
    disabled: visitors.filter((v) => !v.isEnabled).length,
  }), [visitors]);

  const filtered = visitors.filter((v) => {
    if (filter === 'valid' && !hasLivePass(v)) return false;
    if (filter === 'lapsed' && hasLivePass(v)) return false;
    if (filter === 'disabled' && v.isEnabled) return false;
    if (search) {
      const q = search.toLowerCase();
      const haystack = [v.fullName, v.email, v.phone].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
  const { pager, pageItems } = usePagedList(filtered, PAGE_SIZE);
  useEffect(() => { pager.reset(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filter, search]);

  const lastSynced = visitors.reduce((m, v) => (v.fetchedAt && v.fetchedAt > m ? v.fetchedAt : m), '');

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto">
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight flex items-center gap-2">
            <UserPlus size={22} /> Visitors
            <InfoTip>
              Guests holding a dated visitor pass at this site — one car, no
              reserved bay. They are registered in the qparking cloud portal, or
              by a resident from their own portal; this page is a read-only copy
              kept on this server so you can check a name at the barrier without
              logging into the cloud. "Valid now" is the cloud's own verdict on
              the pass; for its dates, look the car up on the Vehicles page. The
              cloud expires a lapsed pass on an hourly job and this box pulls on
              its own schedule, so a pass that just ran out can read as live for
              a short while; press "Sync from cloud" to settle it now.
            </InfoTip>
          </h1>
          <p className="text-xs sm:text-sm text-gray-500 mt-1">
            Who is expected as a guest, how to reach them, and whether their pass is still live.
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
          { key: 'all', label: 'All', icon: UserPlus },
          { key: 'valid', label: 'Valid now', icon: CheckCircle2 },
          { key: 'lapsed', label: 'No live pass', icon: CircleSlash },
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
          {visitors.length === 0
            ? 'No visitors cached for this site. Press "Sync from cloud" to pull them now.'
            : 'No visitors match the current filter.'}
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
                  <th className="text-left px-3 py-2 font-bold">Pass</th>
                  <th className="text-right px-3 py-2 font-bold">Vehicles</th>
                  <th className="text-right px-3 py-2 font-bold">Account</th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((v) => (
                  <tr key={v.id} className={`border-t border-gray-100 ${!v.isEnabled ? 'bg-gray-50' : ''}`}>
                    <td className="px-3 py-2 font-semibold">{v.fullName || '—'}</td>
                    <td className="px-3 py-2 text-[12px] text-gray-600">
                      <ContactCell email={v.email} phone={v.phone} />
                    </td>
                    <td className="px-3 py-2"><ValidityBadge valid={hasLivePass(v)} /></td>
                    <td className="px-3 py-2 text-right font-mono text-[12px]">
                      <CountChip icon={Car} n={v.vehiclesCount} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      {v.isEnabled
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
            {pageItems.map((v) => (
              <li key={v.id} className={`p-3 ${!v.isEnabled ? 'bg-gray-50' : ''}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{v.fullName || '—'}</span>
                  <ValidityBadge valid={hasLivePass(v)} />
                </div>
                <div className="mt-1.5 text-[11px] text-gray-600">
                  <ContactCell email={v.email} phone={v.phone} />
                </div>
                <div className="mt-1.5 flex items-center gap-3 text-[11px] text-gray-600">
                  <CountChip icon={Car} n={v.vehiclesCount} label="vehicles" />
                  {!v.isEnabled && <span className="uppercase font-bold text-gray-500">Disabled</span>}
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

/** Replaces the role chip Customers carries: on this page every row is a
 *  visitor, so the useful fact in that column is whether the pass is still live
 *  rather than a word repeated down the whole table. Amber matches the visitor
 *  role colour used on the Customers and Vehicles pages. */
function ValidityBadge({ valid }: { valid: boolean }) {
  return valid
    ? <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase bg-amber-100 text-amber-800">Valid now</span>
    : <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase bg-gray-100 text-gray-600">No live pass</span>;
}
