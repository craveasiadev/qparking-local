import { useEffect, useMemo, useState } from 'react';
import {
  Car, RefreshCw, CloudDownload, Clock, Ban, Building2, User, Ticket,
} from 'lucide-react';
import { InfoTip } from '../components/InfoTip';
import type { CloudVehicle, SeasonPass } from '@shared/types';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { useReloadOnCloudSync } from '../hooks/useReloadOnCloudSync';
import { usePagedList } from '../hooks/usePagination';
import { PaginationBar } from '../components/Pagination';
import { toast } from '../toast';
import { fmtDateTime, todayInAppTz } from '../lib/datetime';
import { canonicalPlate } from '@shared/plate';

const PAGE_SIZE = 20;

/**
 * Vehicles — every registered plate, what it is, who owns it, whether it is
 * blocked, and the pass covering it.
 *
 * Merged from two pages (2026-08-11). "Vehicles" and "Passes" were both
 * plate-keyed lists of the same cars, so the same plate appeared on both with
 * half the answer each: one knew the owner and the ban, the other knew the pass.
 * At a barrier there is one question — "this plate in front of me: who is it, is
 * it blocked, is it paid for?" — and it is now answered in one row.
 *
 * This is also the operator-facing home of the BLACKLIST: the Blocked filter
 * lists every banned plate with its reason. Enforcement itself doesn't read this
 * table — the gate uses the leaner blocked_plates list, refreshed on the 60s
 * tick — but both derive from the same cloud `vehicles.is_blacklisted` column.
 *
 * A plate may appear with NO pass (registered, nothing bought) and a pass may
 * cover several plates, so each of its plates carries the same pass detail. The
 * cloud drops plateless passes from the payload, so nothing is hidden here.
 */
type Filter = 'all' | 'blocked';

/** Role chips — same four colours as the Customers and Bays pages. */
const ROLE_TONE: Record<string, string> = {
  resident: 'bg-sky-100 text-sky-800',
  staff: 'bg-violet-100 text-violet-800',
  season: 'bg-teal-100 text-teal-800',
  guest: 'bg-amber-100 text-amber-800',
};

export function VehicleManagement() {
  const [vehicles, setVehicles] = useState<CloudVehicle[]>([]);
  const [passes, setPasses] = useState<SeasonPass[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  const [load, loading] = useAsyncAction(async () => {
    const [vehicleRows, passRows] = await Promise.all([
      window.bridge.listCloudVehicles(),
      window.bridge.listSeasonPasses(),
    ]);
    setVehicles(vehicleRows);
    setPasses(passRows);
  });

  // The pass roster is stored one row PER PLATE, already canonical, so this is a
  // plain lookup rather than a join. Canonicalise the vehicle side too: the
  // registry and the roster are cached by separate syncs.
  const passByPlate = useMemo(() => {
    const map = new Map<string, SeasonPass>();
    for (const pass of passes) map.set(canonicalPlate(pass.plateNumber), pass);
    return map;
  }, [passes]);

  const today = todayInAppTz();

  // These directories are deliberately NOT on the background sync tick (they
  // feed lookups, never a gate decision), so the button is the main way to
  // freshen them.
  const [syncFromCloud, syncing] = useAsyncAction(async () => {
    // Two caches feed this page and they are refreshed separately, so pull both
    // — otherwise a freshened registry sits next to a stale pass roster.
    const [vehicleResult, passResult] = await Promise.all([
      window.bridge.syncCloudVehiclesNow(),
      window.bridge.syncSeasonPassesNow(),
    ]);
    if (vehicleResult.ok && passResult.ok) {
      toast({ tone: 'success', title: `Fetched ${vehicleResult.fetched} vehicle(s) and ${passResult.fetched} pass row(s)` });
    } else {
      toast({
        tone: 'error',
        title: 'Sync failed',
        detail: String(vehicleResult.error ?? passResult.error),
      });
    }
    await load();
  });

  useEffect(() => { void load(); }, []);
  // Both caches behind this page are cloud mirrors, and a header "Sync now"
  // refreshes them without the page knowing. Re-read on either — a pass issued
  // in the cloud must show up here as soon as it has been pulled, not only
  // after someone presses this page's own Refresh.
  useReloadOnCloudSync(['vehicles', 'passes'], load);


  const counts = useMemo(() => ({
    all: vehicles.length,
    blocked: vehicles.filter((v) => v.isBlacklisted).length,
  }), [vehicles]);

  const filtered = vehicles.filter((v) => {
    const pass = passByPlate.get(canonicalPlate(v.plateNumber));
    if (filter === 'blocked' && !v.isBlacklisted) return false;
    if (search) {
      const q = search.toLowerCase();
      const haystack = [v.plateNumber, v.ownerName, v.model, v.color, v.vehicleType, pass?.plan, pass?.role]
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
            <Car size={22} /> Vehicles
            <InfoTip>
              Every registered plate, plate-first: who owns it, whether it is
              blocked, and which pass covers it. This is the page to open with a
              car in front of you.
              {' '}A pass belongs to the HOLDER and covers a pool of their cars,
              so the same pass appears on each of its plates — "slots" is how many
              of them may be inside at once, one per bay.
              {' '}Everything here is managed in the qparking cloud (Parking
              Management → Customers, on the holder's row). The gate picks up a
              block within about a minute; the pass roster refreshes on the sync
              tick.
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
          // No with-pass / no-pass filter: the pass is not a property of the
          // plate. It belongs to the HOLDER and covers a pool of their cars, so
          // slicing the vehicle list by it invited exactly the wrong reading.
          { key: 'blocked', label: 'Blocked', icon: Ban },
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
          placeholder="Search plate, owner, model, pass…"
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
                  {/* WHICH pass covers this plate, in the operator's own words,
                      with the role it was sold under. */}
                  <th className="text-left px-3 py-2 font-bold">Pass</th>
                  <th className="text-left px-3 py-2 font-bold">Valid</th>
                  {/* Two states only: blocked at THIS site, or not. The
                      controller scopes vehicle_blacklists to the requesting
                      site, so this is what this barrier will actually do. */}
                  <th className="text-right px-3 py-2 font-bold">Blocked</th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((v) => {
                  const pass = passByPlate.get(canonicalPlate(v.plateNumber));
                  return (
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
                    <td className="px-3 py-2"><PassCell pass={pass} /></td>
                    <td className="px-3 py-2"><ValidCell pass={pass} today={today} /></td>
                    <td className="px-3 py-2 text-right">
                      {v.isBlacklisted
                        ? <BlockedBadge reason={v.blacklistReason} />
                        : <span title="Not blocked at this site" className="text-[10px] uppercase font-bold text-gray-400">No</span>}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* MOBILE CARDS */}
          <ul className="md:hidden divide-y divide-gray-100">
            {pageItems.map((v) => {
              const pass = passByPlate.get(canonicalPlate(v.plateNumber));
              return (
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
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <PassCell pass={pass} />
                  <ValidCell pass={pass} today={today} />
                </div>
              </li>
              );
            })}
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

/**
 * Which pass covers this plate: the plan name, with the role it was sold under.
 * The plan is the operator's own wording; `plan` is NULL on a v1 payload (a SaaS
 * with no plan catalogue), so the role stands in.
 */
function PassCell({ pass }: { pass?: SeasonPass }) {
  if (!pass) return <span className="text-[11px] text-gray-400">No pass</span>;
  const role = pass.role ?? undefined;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold uppercase text-blue-800">
        <Ticket size={9} /> {pass.plan ?? role ?? 'pass'}
      </span>
      {role && pass.plan && (
        <span className={`rounded-full px-1.5 py-px text-[9px] font-bold uppercase ${ROLE_TONE[role] ?? 'bg-gray-100 text-gray-700'}`}>
          {role}
        </span>
      )}
      {/* How many of the holder's cars may be inside at once — one per bay.
          Always shown: "1 slot" is the answer to "can their other car come in
          too?", and leaving it blank made that look unanswered. */}
      <span className="text-[10px] font-mono text-gray-500">
        {pass.concurrentLimit} slot{pass.concurrentLimit === 1 ? '' : 's'}
      </span>
    </span>
  );
}

/**
 * The pass's term, both ends of it.
 *
 * The start matters as much as the end: a pass can be sold today to run from the
 * 1st, so "does this car have a pass" and "does it have one YET" are different
 * questions at the barrier.
 *
 * A resident pass has no end date at all — that is "forever", not missing data,
 * so it says so rather than showing a dash.
 */
function ValidCell({ pass, today }: { pass?: SeasonPass; today: string }) {
  if (!pass) return <span className="text-[11px] text-gray-400">—</span>;
  const expired = !!pass.endDate && pass.endDate < today;
  const notYet = !!pass.startDate && pass.startDate > today;
  return (
    <span className="inline-flex flex-col items-start">
      <span className={`text-[10px] font-mono ${expired ? 'font-semibold text-amber-700' : 'text-gray-500'}`}>
        {pass.startDate ?? '—'} → {pass.endDate ?? '—'}
      </span>
      {!pass.endDate && <span className="text-[9px] font-bold uppercase text-sky-700">No expiry</span>}
      {expired && <span className="text-[9px] font-bold uppercase text-amber-700">Lapsed</span>}
      {notYet && <span className="text-[9px] font-bold uppercase text-gray-500">Starts later</span>}
    </span>
  );
}

/** The barrier refuses this plate outright — no charge, no pulse, staff deal
 *  with the owner in person. Hover for the reason the cloud recorded. */
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
