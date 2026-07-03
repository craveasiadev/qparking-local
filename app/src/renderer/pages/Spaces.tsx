import { useEffect, useMemo, useState } from 'react';
import { Grid3x3, RefreshCw, Loader2 } from 'lucide-react';
import type { ParkingSpace } from '@shared/types';
import { useAsyncAction } from '../hooks/useAsyncAction';

/**
 * Parking space inventory — mirrored read-only from qparking SaaS.
 * Shows occupancy by building + level + zone, with status counts.
 * Edits happen in the cloud Operator → Space Management; this page is
 * for at-the-gate visibility.
 */
export function Spaces() {
  const [spaces, setSpaces] = useState<ParkingSpace[]>([]);
  const [result, setResult] = useState<{ ok: boolean; fetched: number; error?: string } | null>(null);

  async function refresh() { setSpaces(await window.bridge.listSpaces()); }
  useEffect(() => { void refresh(); }, []);

  const [sync, syncing] = useAsyncAction(async () => {
    const r = await window.bridge.syncSpacesNow();
    setResult(r as any);
    await refresh();
  });

  const stats = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of spaces) c[s.status] = (c[s.status] ?? 0) + 1;
    return c;
  }, [spaces]);

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
    <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto">
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight flex items-center gap-2">
            <Grid3x3 size={22} /> Space management
          </h1>
          <p className="text-xs sm:text-sm text-gray-500 mt-1">
            Live read-only view of the cloud's parking-space inventory. Edits happen in qparking SaaS — Operator → Space Management.
          </p>
        </div>
        <button onClick={() => sync()} disabled={syncing}
          className="inline-flex items-center justify-center gap-1.5 h-10 px-4 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50">
          {syncing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </header>

      {result && (
        <div className={`mb-4 rounded-lg border px-3 py-2 text-xs ${result.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700'}`}>
          {result.ok ? `Fetched ${result.fetched} space(s).` : `Sync failed: ${result.error}`}
        </div>
      )}

      {/* Status counts strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <StatCard label="Total spaces" value={spaces.length} tone="default" />
        <StatCard label="Occupied" value={stats.occupied ?? 0} tone="danger" />
        <StatCard label="Reserved / VIP" value={(stats.reserved ?? 0) + (stats.vip ?? 0)} tone="warning" />
        <StatCard label="Available" value={stats.available ?? 0} tone="success" />
      </div>

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
        <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-sm text-gray-500">
          No space inventory cached yet. Configure qparking URL + API key in Settings, then click Sync now.
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <div className="px-4 py-2 border-b border-gray-200 text-[10px] uppercase tracking-widest font-bold text-gray-500">
            All spaces ({spaces.length})
          </div>
          <div className="overflow-x-auto max-h-[60vh]">
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
                {spaces.map((s) => (
                  <tr key={s.id} className="border-t border-gray-100">
                    <td className="px-3 py-2 font-mono font-semibold">{s.spaceCode ?? s.spaceNumber ?? s.id.slice(0, 8)}</td>
                    <td className="px-3 py-2">{s.building ?? '—'}</td>
                    <td className="px-3 py-2">{s.level ?? '—'}</td>
                    <td className="px-3 py-2">{s.zone ?? '—'}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
                        s.status === 'occupied' ? 'bg-red-100 text-red-800'
                        : s.status === 'available' ? 'bg-emerald-100 text-emerald-800'
                        : s.status === 'reserved' || s.status === 'vip' ? 'bg-amber-100 text-amber-800'
                        : 'bg-gray-100 text-gray-700'
                      }`}>{s.status}</span>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {s.customerName && <div>{s.customerName}</div>}
                      {s.vehiclePlate && <div className="font-mono text-gray-500">{s.vehiclePlate}</div>}
                      {s.passType && <div className="text-[10px] text-purple-700">{s.passType}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
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
