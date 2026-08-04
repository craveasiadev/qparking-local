import { useEffect, useMemo, useState } from 'react';
import { Grid3x3, RefreshCw, Loader2, Search, X, Clock, Layers } from 'lucide-react';
import type { ParkingSpace } from '@shared/types';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { InfoTip } from '../components/InfoTip';
import { fmtDateTime } from '../lib/datetime';
import { toast } from '../toast';

/**
 * Bay inventory — mirrored read-only from qparking SaaS.
 * Mirrors the cloud Operator → Bay Management layout: bays grouped into a
 * panel per level, zone sections inside each level, and a compact status-
 * coloured card per bay. Edits happen in the cloud; this page is for
 * at-the-gate visibility.
 *
 * Naming: user-visible text says "bay" to match the cloud operator UI, while
 * identifiers / IPC channels / DB columns stay `space` (same split the cloud
 * uses, so the two codebases still line up).
 */

/** Status → card colours. Mirrors the cloud STATUS_CONFIG (light theme only —
 *  this app has no dark mode). `status` is free-form from the cloud, so 'vip'
 *  piggybacks on reserved and anything unknown falls back to neutral. */
const STATUS_CONFIG: Record<string, { label: string; bg: string; border: string; text: string; dot: string }> = {
  available:   { label: 'Available',   bg: 'bg-emerald-50', border: 'border-emerald-300', text: 'text-emerald-800', dot: 'bg-emerald-500' },
  occupied:    { label: 'Occupied',    bg: 'bg-rose-50',    border: 'border-rose-300',    text: 'text-rose-800',    dot: 'bg-rose-500' },
  reserved:    { label: 'Reserved',    bg: 'bg-amber-50',   border: 'border-amber-300',   text: 'text-amber-800',   dot: 'bg-amber-500' },
  vip:         { label: 'VIP',         bg: 'bg-amber-50',   border: 'border-amber-300',   text: 'text-amber-800',   dot: 'bg-amber-500' },
  maintenance: { label: 'Maintenance', bg: 'bg-sky-50',     border: 'border-sky-300',     text: 'text-sky-800',     dot: 'bg-sky-500' },
  disabled:    { label: 'Disabled',    bg: 'bg-gray-100',   border: 'border-gray-300',    text: 'text-gray-500',    dot: 'bg-gray-400' },
};
function statusConfig(status: string) {
  return STATUS_CONFIG[status] ?? { label: status, bg: 'bg-gray-50', border: 'border-gray-300', text: 'text-gray-600', dot: 'bg-gray-400' };
}

function fmtDate(v: string | null): string {
  if (!v) return '—';
  return new Date(v).toLocaleDateString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', day: '2-digit', month: 'short', year: 'numeric' });
}

/** Split a level's bays into zone sections — zones A→Z (numeric-aware),
 *  unzoned last — each section sorted by bay number. Same shaping as the
 *  cloud page's zoneSections(). */
function zoneSections(items: ParkingSpace[]): { zone: string; spaces: ParkingSpace[] }[] {
  const map = new Map<string, ParkingSpace[]>();
  for (const s of items) {
    const key = (s.zone ?? '').trim();
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(s);
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, undefined, { numeric: true })))
    .map(([zone, spaces]) => ({
      zone,
      spaces: spaces.slice().sort((x, y) =>
        (parseInt(x.spaceNumber ?? '', 10) || 0) - (parseInt(y.spaceNumber ?? '', 10) || 0)
        || (x.spaceNumber ?? '').localeCompare(y.spaceNumber ?? '')),
    }));
}

/** One bay — status-coloured card, same content as the cloud BayCard (code,
 *  status, tenant, plate, pass expiry, notes). Read-only here, so a div. */
function BayCard({ space }: { space: ParkingSpace }) {
  const cfg = statusConfig(space.status);
  const code = space.spaceCode ?? space.spaceNumber ?? space.id.slice(0, 8);
  return (
    <div title={code} className={`rounded-xl border-2 p-2.5 ${cfg.bg} ${cfg.border}`}>
      <p className={`font-mono text-[11px] font-bold leading-tight ${cfg.text}`}>{code}</p>
      <div className="mt-1.5 flex items-center gap-1">
        <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${cfg.dot}`} />
        <span className={`text-[10px] font-medium ${cfg.text}`}>{cfg.label}</span>
      </div>
      {space.customerName && (
        <p className={`mt-0.5 text-[10px] truncate font-medium ${cfg.text}`}>{space.customerName}</p>
      )}
      {space.vehiclePlate && (
        <p className={`text-[10px] font-mono truncate ${cfg.text} opacity-80`}>{space.vehiclePlate}</p>
      )}
      {space.endDate && ['occupied', 'reserved', 'vip'].includes(space.status) && (
        <p className={`text-[9px] mt-0.5 ${cfg.text} opacity-60`}>Exp: {fmtDate(space.endDate)}</p>
      )}
      {space.notes && (
        <p title={space.notes} className={`mt-0.5 text-[9px] italic truncate ${cfg.text} opacity-60`}>{space.notes}</p>
      )}
    </div>
  );
}

export function ParkingSpaces() {
  const [spaces, setSpaces] = useState<ParkingSpace[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [levelFilter, setLevelFilter] = useState('');

  async function refresh() { setSpaces(await window.bridge.listParkingSpaces()); }
  useEffect(() => { void refresh(); }, []);

  const [sync, syncing] = useAsyncAction(async () => {
    const r = await window.bridge.syncParkingSpacesNow();
    if (r.ok) toast({ tone: 'success', title: `Fetched ${r.fetched} bay(s)` });
    else toast({ tone: 'error', title: 'Sync failed', detail: String(r.error) });
    await refresh();
  });

  const stats = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of spaces) c[s.status] = (c[s.status] ?? 0) + 1;
    return c;
  }, [spaces]);

  // Distinct statuses actually present → the filter dropdown adapts to the data
  // instead of hard-coding a fixed set (status is free-form from the cloud).
  const statusOptions = useMemo(
    () => Array.from(new Set(spaces.map((s) => s.status))).sort(),
    [spaces],
  );

  // Distinct levels present (sorted, unset last) → the level tab strip.
  const levels = useMemo(() => {
    const set = new Set(spaces.map((s) => (s.level ?? '').trim()));
    return [...set].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, undefined, { numeric: true })));
  }, [spaces]);

  // Most recent fetch across the cached rows — a plain "last synced" cue.
  const lastSynced = useMemo(
    () => spaces.reduce((m, s) => (s.fetchedAt && s.fetchedAt > m ? s.fetchedAt : m), ''),
    [spaces],
  );

  const q = search.trim().toLowerCase();
  const filterActive = q !== '' || statusFilter !== 'all' || levelFilter !== '';
  const filteredSpaces = spaces.filter((s) => {
    if (statusFilter !== 'all' && s.status !== statusFilter) return false;
    if (levelFilter !== '' && (s.level ?? '').trim() !== levelFilter) return false;
    if (q) {
      const hay = `${s.spaceCode ?? ''} ${s.spaceNumber ?? ''} ${s.building ?? ''} ${s.level ?? ''} ${s.zone ?? ''} ${s.customerName ?? ''} ${s.vehiclePlate ?? ''} ${s.passType ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // Group the filtered bays by level for the panel-per-level layout (mirrors
  // the cloud's groupedByLevel). Key '' = level not set in the cloud.
  const groupedByLevel = useMemo(() => {
    const map = new Map<string, ParkingSpace[]>();
    for (const s of filteredSpaces) {
      const key = (s.level ?? '').trim();
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    return [...map.entries()]
      .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, undefined, { numeric: true })));
  }, [filteredSpaces]);

  // Group by building for the breakdown table. Counts are kept per distinct
  // status (status is free-form from the cloud) so the columns can be built
  // dynamically — a bay in 'maintenance' or some brand-new status is never
  // silently dropped from the rollup.
  const byBuilding = useMemo(() => {
    const map = new Map<string, { total: number; byStatus: Record<string, number> }>();
    for (const s of spaces) {
      const key = s.building || 'Unassigned';
      const e = map.get(key) ?? { total: 0, byStatus: {} };
      e.total++;
      e.byStatus[s.status] = (e.byStatus[s.status] ?? 0) + 1;
      map.set(key, e);
    }
    return Array.from(map.entries()).sort((a, b) => b[1].total - a[1].total);
  }, [spaces]);

  // Column order for the rollup: the familiar trio first, then whatever else
  // the data contains (maintenance, disabled, …) alphabetically.
  const rollupStatuses = useMemo(() => {
    const preferred = ['occupied', 'reserved', 'vip', 'available'];
    const rest = statusOptions.filter((st) => !preferred.includes(st));
    return [...preferred.filter((st) => statusOptions.includes(st)), ...rest];
  }, [statusOptions]);

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto">
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight flex items-center gap-2">
            <Grid3x3 size={22} /> Bay Management
            <InfoTip>
              Parking bays are created and edited in the qparking cloud
              (Operator → Bay Management) — including their building, level and
              zone. This page is a live copy so you can see which bays are
              taken, reserved or free. Press "Sync now" to get the latest.
            </InfoTip>
          </h1>
          <p className="text-xs sm:text-sm text-gray-500 mt-1">
            Every bay at this site, grouped by level and zone.
          </p>
          {lastSynced && (
            <p className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-gray-400">
              <Clock size={12} /> Last synced {fmtDateTime(lastSynced)}
            </p>
          )}
        </div>
        <button onClick={() => sync()} disabled={syncing}
          className="inline-flex items-center justify-center gap-1.5 h-10 px-4 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50 self-start sm:self-auto">
          {syncing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </header>

      {/* Overall utilisation bar */}
      {spaces.length > 0 && (() => {
        const used = (stats.occupied ?? 0) + (stats.reserved ?? 0) + (stats.vip ?? 0);
        const pct = Math.round((used / spaces.length) * 100);
        return (
          <div className="mb-5 rounded-xl border border-gray-200 bg-white p-4">
            <div className="flex items-center justify-between text-sm">
              <span className="font-semibold">Overall utilisation</span>
              <span className="tabular-nums text-gray-600"><strong>{used}</strong> / {spaces.length} in use</span>
            </div>
            <div className="mt-2.5 h-2.5 w-full rounded-full bg-gray-100 overflow-hidden">
              <div className={`h-full rounded-full transition-all ${pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
          </div>
        );
      })()}

      {/* Per-building rollup */}
      {byBuilding.length > 0 && (
        <div className="mb-5 rounded-xl border border-gray-200 bg-white overflow-hidden">
          <div className="px-4 py-2 border-b border-gray-200 text-[10px] uppercase tracking-widest font-bold text-gray-500">
            Occupancy by building
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-[10px] uppercase tracking-widest text-gray-500">
                <tr>
                  <th className="text-left px-3 py-2 font-bold">Building</th>
                  <th className="text-right px-3 py-2 font-bold">Total</th>
                  {rollupStatuses.map((st) => (
                    <th key={st} className="text-right px-3 py-2 font-bold capitalize">{st}</th>
                  ))}
                  <th className="text-right px-3 py-2 font-bold">Util %</th>
                </tr>
              </thead>
              <tbody>
                {byBuilding.map(([name, c]) => {
                  const inUse = (c.byStatus.occupied ?? 0) + (c.byStatus.reserved ?? 0) + (c.byStatus.vip ?? 0);
                  const util = c.total ? Math.round((inUse / c.total) * 100) : 0;
                  return (
                    <tr key={name} className="border-t border-gray-100">
                      <td className="px-3 py-2 font-semibold">{name}</td>
                      <td className="px-3 py-2 text-right font-mono">{c.total}</td>
                      {rollupStatuses.map((st) => {
                        const n = c.byStatus[st] ?? 0;
                        return (
                          <td key={st} className={`px-3 py-2 text-right font-mono ${n === 0 ? 'text-gray-300' : statusConfig(st).text}`}>
                            {n}
                          </td>
                        );
                      })}
                      <td className="px-3 py-2 text-right font-mono font-bold">{util}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* All bays — level panels + zone sections + bay cards */}
      {spaces.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center">
          <Grid3x3 size={28} className="mx-auto text-gray-300" />
          <p className="mt-3 text-sm font-semibold text-gray-700">No bay inventory cached yet</p>
          <p className="mt-1 text-[13px] text-gray-500">Configure the qparking URL + API key in Settings, then click <strong>Sync now</strong>.</p>
        </div>
      ) : (
        <>
          {/* Filter bar */}
          <div className="mb-3 flex flex-col sm:flex-row sm:items-center gap-2">
            <div className="relative flex-1 sm:max-w-sm">
              <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search code, building, plate, customer…"
                className="w-full h-9 pl-8 pr-8 border border-gray-200 rounded-lg text-sm focus:border-gray-900 outline-none"
              />
              {search && (
                <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700">
                  <X size={13} />
                </button>
              )}
            </div>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
              className="h-9 px-2 rounded-lg border border-gray-200 text-sm focus:border-gray-900 outline-none bg-white capitalize">
              <option value="all">All status</option>
              {statusOptions.map((st) => <option key={st} value={st}>{st}</option>)}
            </select>
            {filterActive && (
              <button onClick={() => { setSearch(''); setStatusFilter('all'); setLevelFilter(''); }}
                className="h-9 px-3 text-xs font-bold uppercase tracking-wide text-gray-500 hover:text-gray-900 whitespace-nowrap">
                Clear
              </button>
            )}
          </div>

          {/* Level tabs — mirrors the cloud's level strip */}
          {levels.length > 1 && (
            <div className="mb-4 flex flex-wrap gap-2">
              <button
                onClick={() => setLevelFilter('')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border ${
                  levelFilter === '' ? 'bg-gray-900 text-white border-transparent' : 'border-gray-200 text-gray-700 hover:border-gray-900'
                }`}
              >
                <Layers size={12} /> All levels
                <span className={`ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold ${
                  levelFilter === '' ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-700'
                }`}>{spaces.length}</span>
              </button>
              {levels.map((lvl) => {
                const active = levelFilter === lvl;
                const count = spaces.filter((s) => (s.level ?? '').trim() === lvl).length;
                return (
                  <button
                    key={lvl || '∅'}
                    onClick={() => setLevelFilter(active ? '' : lvl)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border ${
                      active ? 'bg-gray-900 text-white border-transparent' : 'border-gray-200 text-gray-700 hover:border-gray-900'
                    }`}
                  >
                    {lvl ? `Level ${lvl}` : 'No level'}
                    <span className={`ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold ${
                      active ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-700'
                    }`}>{count}</span>
                  </button>
                );
              })}
            </div>
          )}

          {filteredSpaces.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-sm text-gray-500">
              <Search size={22} className="mx-auto text-gray-300" />
              <p className="mt-2">No bays match the current filters.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {groupedByLevel.map(([level, items]) => {
                const lStats = {
                  available: items.filter((s) => s.status === 'available').length,
                  occupied: items.filter((s) => s.status === 'occupied').length,
                  reserved: items.filter((s) => s.status === 'reserved' || s.status === 'vip').length,
                  other: items.filter((s) => !['available', 'occupied', 'reserved', 'vip'].includes(s.status)).length,
                };
                return (
                  <div key={level || '∅'} className="rounded-xl border border-gray-200 bg-white overflow-hidden">
                    {/* Level header — name + at-a-glance status counts */}
                    <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 border-b border-gray-200 bg-gray-50/70">
                      <span className="font-bold text-sm">
                        {level ? <>Level <span className="font-mono">{level}</span></> : 'No level'}
                      </span>
                      <span className="text-xs text-gray-400">{items.length} bay{items.length === 1 ? '' : 's'}</span>
                      <div className="flex items-center gap-3">
                        <span className="flex items-center gap-1 text-xs text-emerald-700"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />{lStats.available} available</span>
                        <span className="flex items-center gap-1 text-xs text-rose-700"><span className="w-1.5 h-1.5 rounded-full bg-rose-500" />{lStats.occupied} occupied</span>
                        {lStats.reserved > 0 && <span className="flex items-center gap-1 text-xs text-amber-700"><span className="w-1.5 h-1.5 rounded-full bg-amber-500" />{lStats.reserved} reserved</span>}
                        {lStats.other > 0 && <span className="text-xs text-gray-400">{lStats.other} other</span>}
                      </div>
                    </div>
                    <div className="p-4 space-y-4">
                      {zoneSections(items).map(({ zone, spaces: zoneSpaces }, _i, sections) => (
                        <div key={zone || '∅'}>
                          {/* Hide the zone header when the level has no zones at all */}
                          {(sections.length > 1 || zone !== '') && (
                            <div className="mb-2 flex items-center gap-2">
                              <span className="inline-flex items-center rounded-md bg-teal-50 border border-teal-200 px-2 py-0.5 text-[11px] font-bold text-teal-700">
                                {zone ? `Zone ${zone}` : 'No zone'}
                              </span>
                              <span className="text-[11px] text-gray-400">
                                {zoneSpaces.length} bay{zoneSpaces.length === 1 ? '' : 's'} ·{' '}
                                {zoneSpaces.filter((s) => s.status === 'available').length} available
                              </span>
                            </div>
                          )}
                          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-9 gap-2">
                            {zoneSpaces.map((s) => <BayCard key={s.id} space={s} />)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
