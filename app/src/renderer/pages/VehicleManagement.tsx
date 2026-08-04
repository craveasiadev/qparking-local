import { useEffect, useMemo, useState } from 'react';
import {
  Car, RefreshCw, CloudDownload, Clock, Ban, Ticket, Building2, User,
} from 'lucide-react';
import { InfoTip } from '../components/InfoTip';
import type { CloudVehicle } from '@shared/types';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { usePagedList } from '../hooks/usePagination';
import { PaginationBar } from '../components/Pagination';
import { toast } from '../toast';
import { fmtDateTime, todayInAppTz } from '../lib/datetime';

const PAGE_SIZE = 20;

/**
 * Vehicle registry — read-only mirror of the cloud's registered vehicles, so
 * site staff can answer "who owns this plate?" at the gate without logging into
 * the qparking cloud portal in a browser.
 *
 * This is also the operator-facing home of the BLACKLIST: the Blocked filter
 * lists every banned plate with its reason. Enforcement itself doesn't read this
 * table — the gate uses the leaner blocked_plates list, refreshed on the 60s
 * tick — but both derive from the same cloud `vehicles.is_blacklisted` column.
 */
type Filter = 'all' | 'blocked' | 'with-pass' | 'no-pass';

export function VehicleManagement() {
  const [vehicles, setVehicles] = useState<CloudVehicle[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  const [load, loading] = useAsyncAction(async () => {
    setVehicles(await window.bridge.listCloudVehicles());
  });

  // These directories are deliberately NOT on the background sync tick (they
  // feed lookups, never a gate decision), so the button is the main way to
  // freshen them.
  const [syncFromCloud, syncing] = useAsyncAction(async () => {
    const result = await window.bridge.syncCloudVehiclesNow();
    if (result.ok) toast({ tone: 'success', title: `Fetched ${result.fetched} vehicle(s) from cloud` });
    else toast({ tone: 'error', title: 'Sync failed', detail: String(result.error) });
    await load();
  });

  useEffect(() => { void load(); }, []);

  const today = todayInAppTz();

  const counts = useMemo(() => ({
    all: vehicles.length,
    blocked: vehicles.filter((v) => v.isBlacklisted).length,
    'with-pass': vehicles.filter((v) => v.passType).length,
    'no-pass': vehicles.filter((v) => !v.passType).length,
  }), [vehicles]);

  const filtered = vehicles.filter((v) => {
    if (filter === 'blocked' && !v.isBlacklisted) return false;
    if (filter === 'with-pass' && !v.passType) return false;
    if (filter === 'no-pass' && v.passType) return false;
    if (search) {
      const q = search.toLowerCase();
      const haystack = [v.plateNumber, v.ownerName, v.model, v.color, v.vehicleType, v.passType]
        .filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
  const { pager, pageItems } = usePagedList(filtered, PAGE_SIZE);
  useEffect(() => { pager.reset(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filter, search]);

  const lastSynced = vehicles.reduce((m, v) => (v.fetchedAt && v.fetchedAt > m ? v.fetchedAt : m), '');

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto">
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight flex items-center gap-2">
            <Car size={22} /> Vehicle Management
            <InfoTip>
              Vehicles, their owners and the blocked list are managed in the
              qparking cloud portal. This page is a copy kept on this server so
              you can check who owns a plate right at the gate. To block or
              unblock a vehicle, do it in the cloud — the gate picks up the
              change within about a minute.
            </InfoTip>
          </h1>
          <p className="text-xs sm:text-sm text-gray-500 mt-1">
            Every registered vehicle, its owner, and its pass — plus which plates are blocked.
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
          { key: 'all', label: 'All', icon: Car },
          { key: 'blocked', label: 'Blocked', icon: Ban },
          { key: 'with-pass', label: 'With pass', icon: Ticket },
          { key: 'no-pass', label: 'No pass', icon: Car },
        ] as const).map((f) => {
          const active = filter === f.key;
          const Icon = f.icon;
          // Blocked is the one filter that should read as a warning even when idle.
          const idleTone = f.key === 'blocked'
            ? 'border-red-200 text-red-700 hover:border-red-500'
            : 'border-gray-200 text-gray-700 hover:border-gray-900';
          const activeTone = f.key === 'blocked' ? 'bg-red-600 text-white' : 'bg-gray-900 text-white';
          return (
            <button key={f.key} onClick={() => setFilter(f.key)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border ${
                active ? `${activeTone} border-transparent` : idleTone
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
          placeholder="Search plate, owner, model…"
          className="flex-1 min-w-[200px] h-9 px-3 rounded-lg border border-gray-200 text-sm focus:border-gray-900 outline-none"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-sm text-gray-500">
          {vehicles.length === 0
            ? 'No vehicles cached yet. Press "Sync from cloud" (these directories aren\'t auto-synced).'
            : 'No vehicles match the current filter.'}
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          {/* DESKTOP TABLE */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-[10px] uppercase tracking-widest text-gray-500">
                <tr>
                  <th className="text-left px-3 py-2 font-bold">Plate</th>
                  <th className="text-left px-3 py-2 font-bold">Owner</th>
                  <th className="text-left px-3 py-2 font-bold">Vehicle</th>
                  <th className="text-left px-3 py-2 font-bold">Pass</th>
                  <th className="text-right px-3 py-2 font-bold">Status</th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((v) => (
                  <tr key={v.id} className={`border-t border-gray-100 ${v.isBlacklisted ? 'bg-red-50/50' : ''}`}>
                    <td className="px-3 py-2 font-mono font-semibold">
                      <span className="inline-flex items-center gap-1.5">
                        <Car size={11} className="text-gray-400" /> {v.plateNumber}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <OwnerCell name={v.ownerName} kind={v.ownerKind} />
                    </td>
                    <td className="px-3 py-2 text-[12px] text-gray-600">
                      {[v.vehicleType, v.model, v.color].filter(Boolean).join(' · ') || '—'}
                    </td>
                    <td className="px-3 py-2">
                      <PassCell passType={v.passType} endDate={v.passEndDate} today={today} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      {v.isBlacklisted
                        ? <BlockedBadge reason={v.blacklistReason} />
                        : <span className="text-[10px] uppercase font-bold text-gray-400">OK</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* MOBILE CARDS */}
          <ul className="md:hidden divide-y divide-gray-100">
            {pageItems.map((v) => (
              <li key={v.id} className={`p-3 ${v.isBlacklisted ? 'bg-red-50/50' : ''}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono font-bold inline-flex items-center gap-1.5">
                    <Car size={12} className="text-gray-400" /> {v.plateNumber}
                  </span>
                  {v.isBlacklisted && <BlockedBadge reason={v.blacklistReason} />}
                </div>
                <div className="mt-1.5 text-[11px] text-gray-600">
                  <OwnerCell name={v.ownerName} kind={v.ownerKind} />
                </div>
                <div className="mt-1 text-[11px] text-gray-500">
                  {[v.vehicleType, v.model, v.color].filter(Boolean).join(' · ') || 'No vehicle details'}
                </div>
                <div className="mt-1.5">
                  <PassCell passType={v.passType} endDate={v.passEndDate} today={today} />
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

function OwnerCell({ name, kind }: { name: string | null; kind: string | null }) {
  if (!name) return <span className="text-gray-400 text-[12px]">Unassigned</span>;
  const Icon = kind === 'corporate' ? Building2 : User;
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px]">
      <Icon size={11} className="text-gray-400" /> {name}
    </span>
  );
}

function PassCell({
  passType, endDate, today,
}: { passType: string | null; endDate: string | null; today: string }) {
  if (!passType) return <span className="text-[11px] text-gray-400">No pass</span>;
  // A pass whose end_date has passed is still shown, flagged — the cloud expiry
  // job runs hourly so a just-lapsed pass can linger a little.
  const expired = !!endDate && endDate < today;
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase bg-blue-100 text-blue-800">
        <Ticket size={9} /> {passType}
      </span>
      <span className={`text-[10px] font-mono ${expired ? 'text-amber-700 font-semibold' : 'text-gray-500'}`}>
        {endDate ? `until ${endDate}${expired ? ' · lapsed' : ''}` : 'no end date'}
      </span>
    </span>
  );
}

function BlockedBadge({ reason }: { reason: string | null }) {
  return (
    <span
      title={reason ?? 'No reason recorded in cloud'}
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase bg-red-600 text-white"
    >
      <Ban size={9} /> Blocked
    </span>
  );
}
