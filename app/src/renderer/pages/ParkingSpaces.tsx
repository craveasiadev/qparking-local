import { useEffect, useMemo, useState } from 'react';
import { Grid3x3, RefreshCw, Loader2, Search, X, Clock } from 'lucide-react';
import type { ParkingSpace } from '@shared/types';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { fmtDateTime } from '../lib/datetime';
import { toast } from '../toast';

/**
 * Parking space inventory — mirrored read-only from qparking SaaS.
 * Shows occupancy by building + level + zone, with status counts.
 * Edits happen in the cloud Operator → Space Management; this page is
 * for at-the-gate visibility.
 */
export function ParkingSpaces() {
  const [spaces, setSpaces] = useState<ParkingSpace[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  async function refresh() { setSpaces(await window.bridge.listParkingSpaces()); }
  useEffect(() => { void refresh(); }, []);

  const [sync, syncing] = useAsyncAction(async () => {
    const r = await window.bridge.syncParkingSpacesNow();
    if (r.ok) toast({ tone: 'success', title: `Fetched ${r.fetched} space(s)` });
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

  // Most recent fetch across the cached rows — a plain "last synced" cue.
  const lastSynced = useMemo(
    () => spaces.reduce((m, s) => (s.fetchedAt && s.fetchedAt > m ? s.fetchedAt : m), ''),
    [spaces],
  );

  const q = search.trim().toLowerCase();
  const filterActive = q !== '' || statusFilter !== 'all';
  const filteredSpaces = spaces.filter((s) => {
    if (statusFilter !== 'all' && s.status !== statusFilter) return false;
    if (q) {
      const hay = `${s.spaceCode ?? ''} ${s.spaceNumber ?? ''} ${s.building ?? ''} ${s.level ?? ''} ${s.zone ?? ''} ${s.customerName ?? ''} ${s.vehiclePlate ?? ''} ${s.passType ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // Group by building → level → zone for the breakdown table.
  const byBuilding = useMemo(() => {
    const map = new Map<string, { total: number; occupied: number; reserved: number; available: number; }>();
    for (const s of spaces) {
      const key = s.building || 'Unassigned';
      const e = map.get(key) ?? { total: 0, occupied: 0, reserved: 0, available: 0 };
      e.total++;
      if (s.status === 'occupied') e.occupied++;
      else if (s.status === 'reserved' || s.status === 'vip') e.reserved++;
      else if (s.status === 'available') e.available++;
      map.set(key, e);
    }
    return Array.from(map.entries()).sort((a, b) => b[1].total - a[1].total);
  }, [spaces]);

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto">
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight flex items-center gap-2">
            <Grid3x3 size={22} /> Parking Spaces
          </h1>
          <p className="text-xs sm:text-sm text-gray-500 mt-1">
            Live read-only view of the cloud's parking-space inventory. Edits happen in qparking SaaS — Operator → Space Management.
          </p>
          {lastSynced && (
            <p className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-gray-400">
              <Clock size={12} /> Last synced {fmtDateTime(lastSynced)}
            </p>
          )}
        </div>
        <button onClick={() => sync()} disabled={syncing}
          className="inline-flex items-center justify-center gap-1.5 h-10 px-4 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50">
          {syncing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </header>

      {/* Status counts strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
        <StatCard label="Total spaces" value={spaces.length} tone="default" />
        <StatCard label="Occupied" value={stats.occupied ?? 0} tone="danger" />
        <StatCard label="Reserved / VIP" value={(stats.reserved ?? 0) + (stats.vip ?? 0)} tone="warning" />
        <StatCard label="Available" value={stats.available ?? 0} tone="success" />
      </div>

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
                  <th className="text-right px-3 py-2 font-bold">Occupied</th>
                  <th className="text-right px-3 py-2 font-bold">Reserved/VIP</th>
                  <th className="text-right px-3 py-2 font-bold">Available</th>
                  <th className="text-right px-3 py-2 font-bold">Util %</th>
                </tr>
              </thead>
              <tbody>
                {byBuilding.map(([name, c]) => {
                  const util = c.total ? Math.round(((c.occupied + c.reserved) / c.total) * 100) : 0;
                  return (
                    <tr key={name} className="border-t border-gray-100">
                      <td className="px-3 py-2 font-semibold">{name}</td>
                      <td className="px-3 py-2 text-right font-mono">{c.total}</td>
                      <td className="px-3 py-2 text-right font-mono text-red-700">{c.occupied}</td>
                      <td className="px-3 py-2 text-right font-mono text-amber-700">{c.reserved}</td>
                      <td className="px-3 py-2 text-right font-mono text-emerald-700">{c.available}</td>
                      <td className="px-3 py-2 text-right font-mono font-bold">{util}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* All spaces */}
      {spaces.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center">
          <Grid3x3 size={28} className="mx-auto text-gray-300" />
          <p className="mt-3 text-sm font-semibold text-gray-700">No space inventory cached yet</p>
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
              <button onClick={() => { setSearch(''); setStatusFilter('all'); }}
                className="h-9 px-3 text-xs font-bold uppercase tracking-wide text-gray-500 hover:text-gray-900 whitespace-nowrap">
                Clear
              </button>
            )}
          </div>

          <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
            <div className="px-4 py-2 border-b border-gray-200 text-[10px] uppercase tracking-widest font-bold text-gray-500">
              {filterActive ? `${filteredSpaces.length} of ${spaces.length} spaces` : `All spaces (${spaces.length})`}
            </div>

            {filteredSpaces.length === 0 ? (
              <div className="p-8 text-center text-sm text-gray-500">No spaces match the current filters.</div>
            ) : (
              <>
                {/* DESKTOP TABLE */}
                <div className="hidden md:block overflow-x-auto max-h-[60vh]">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-[10px] uppercase tracking-widest text-gray-500 sticky top-0">
                      <tr>
                        <th className="text-left px-3 py-2 font-bold">Code</th>
                        <th className="text-left px-3 py-2 font-bold">Building</th>
                        <th className="text-left px-3 py-2 font-bold">Level</th>
                        <th className="text-left px-3 py-2 font-bold">Zone</th>
                        <th className="text-left px-3 py-2 font-bold">Status</th>
                        <th className="text-left px-3 py-2 font-bold">Assignment</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredSpaces.map((s) => (
                        <tr key={s.id} className="border-t border-gray-100">
                          <td className="px-3 py-2 font-mono font-semibold">{s.spaceCode ?? s.spaceNumber ?? s.id.slice(0, 8)}</td>
                          <td className="px-3 py-2">{s.building ?? '—'}</td>
                          <td className="px-3 py-2">{s.level ?? '—'}</td>
                          <td className="px-3 py-2">{s.zone ?? '—'}</td>
                          <td className="px-3 py-2"><SpaceStatusBadge status={s.status} /></td>
                          <td className="px-3 py-2 text-xs">
                            {s.customerName && <div>{s.customerName}</div>}
                            {s.vehiclePlate && <div className="font-mono text-gray-500">{s.vehiclePlate}</div>}
                            {s.passType && <div className="text-[10px] text-purple-700">{s.passType}</div>}
                            {!s.customerName && !s.vehiclePlate && !s.passType && <span className="text-gray-400">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* MOBILE CARDS */}
                <ul className="md:hidden divide-y divide-gray-100 max-h-[60vh] overflow-y-auto">
                  {filteredSpaces.map((s) => (
                    <li key={s.id} className="p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono font-bold">{s.spaceCode ?? s.spaceNumber ?? s.id.slice(0, 8)}</span>
                        <SpaceStatusBadge status={s.status} />
                      </div>
                      <div className="mt-1 text-[11px] text-gray-500">
                        {[s.building, s.level, s.zone].filter(Boolean).join(' · ') || 'no location'}
                      </div>
                      {(s.customerName || s.vehiclePlate || s.passType) && (
                        <div className="mt-1 text-xs">
                          {s.customerName && <span>{s.customerName} </span>}
                          {s.vehiclePlate && <span className="font-mono text-gray-500">{s.vehiclePlate} </span>}
                          {s.passType && <span className="text-[10px] text-purple-700">{s.passType}</span>}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function SpaceStatusBadge({ status }: { status: string }) {
  const cls = status === 'occupied' ? 'bg-red-100 text-red-800'
    : status === 'available' ? 'bg-emerald-100 text-emerald-800'
    : status === 'reserved' || status === 'vip' ? 'bg-amber-100 text-amber-800'
    : 'bg-gray-100 text-gray-700';
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${cls}`}>{status}</span>;
}

function StatCard({ label, value, tone }: { label: string; value: number; tone: 'default'|'success'|'warning'|'danger' }) {
  const colors = {
    default: 'border-gray-200 bg-white',
    success: 'border-emerald-200 bg-emerald-50/30',
    warning: 'border-amber-200 bg-amber-50/30',
    danger:  'border-red-200 bg-red-50/30',
  };
  const textColors = {
    default: 'text-gray-900',
    success: 'text-emerald-700',
    warning: 'text-amber-700',
    danger:  'text-red-700',
  };
  return (
    <div className={`rounded-xl border p-4 ${colors[tone]}`}>
      <div className="text-[10px] uppercase tracking-widest font-bold text-gray-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${textColors[tone]}`}>{value}</div>
    </div>
  );
}
