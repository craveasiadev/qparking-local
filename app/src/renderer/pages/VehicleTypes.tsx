import { useEffect, useState } from 'react';
import { Truck, RefreshCw, Loader2 } from 'lucide-react';
import type { VehicleType, VehicleGroup } from '@shared/types';
import { useAsyncAction } from '../hooks/useAsyncAction';

/**
 * Vehicle type taxonomy mirror — the categories the cloud recognises
 * (car, motorcycle, van, EV, …) and their fallback rate hints. Edits
 * live in qparking SaaS; this page is read-only visibility for the
 * on-prem operator.
 */
export function VehicleTypes() {
  const [types, setTypes] = useState<VehicleType[]>([]);
  const [groups, setGroups] = useState<VehicleGroup[]>([]);
  const [result, setResult] = useState<{ ok: boolean; fetched: number; error?: string } | null>(null);

  async function refresh() {
    const [t, g] = await Promise.all([
      window.bridge.listVehicleTypes(),
      window.bridge.listVehicleGroups(),
    ]);
    setTypes(t);
    setGroups(g);
  }
  useEffect(() => { void refresh(); }, []);

  const [sync, syncing] = useAsyncAction(async () => {
    const r = await window.bridge.syncVehicleTypesNow();
    setResult(r as any);
    await refresh();
  });

  // Group types by group_name for tidier display (matches cloud Vehicle Groups page).
  const byGroup = new Map<string, VehicleType[]>();
  for (const t of types) {
    const key = t.groupName || 'Ungrouped';
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key)!.push(t);
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto">
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight flex items-center gap-2">
            <Truck size={22} /> Vehicle types
          </h1>
          <p className="text-xs sm:text-sm text-gray-500 mt-1">
            Recognised vehicle categories and their default rate hints, mirrored from qparking SaaS. The actual fee at exit is driven by Scopes &amp; Rates (tariff rules); these per-type values are a fallback / classification reference.
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
          {result.ok ? `Fetched ${result.fetched} vehicle type(s).` : `Sync failed: ${result.error}`}
        </div>
      )}

      {types.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-sm text-gray-500">
          No vehicle types cached yet. Configure qparking URL + API key in Settings, then click Sync now.
        </div>
      ) : (
        <div className="space-y-4">
          {Array.from(byGroup.entries()).map(([groupName, list]) => (
            <div key={groupName} className="rounded-xl border border-gray-200 bg-white overflow-hidden">
              <div className="px-4 py-2 border-b border-gray-200 bg-gray-50 text-[10px] uppercase tracking-widest font-bold text-gray-500">
                Group · {groupName}
                <span className="ml-2 px-1.5 py-0.5 rounded bg-gray-200 text-gray-700 text-[9px] normal-case font-bold">{list.length} types</span>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-[10px] uppercase tracking-widest text-gray-500">
                  <tr>
                    <th className="text-left px-3 py-2 font-bold">Type</th>
                    <th className="text-right px-3 py-2 font-bold">Hourly</th>
                    <th className="text-right px-3 py-2 font-bold">Daily</th>
                    <th className="text-right px-3 py-2 font-bold">Monthly</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((t) => (
                    <tr key={t.id} className="border-t border-gray-100">
                      <td className="px-3 py-2 font-semibold">{t.typeName}</td>
                      <td className="px-3 py-2 text-right font-mono">{t.hourlyRate != null ? `RM ${Number(t.hourlyRate).toFixed(2)}` : '—'}</td>
                      <td className="px-3 py-2 text-right font-mono">{t.dailyRate != null ? `RM ${Number(t.dailyRate).toFixed(2)}` : '—'}</td>
                      <td className="px-3 py-2 text-right font-mono">{t.monthlyRate != null ? `RM ${Number(t.monthlyRate).toFixed(2)}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          {groups.length > 0 && (
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="text-[10px] uppercase tracking-widest font-bold text-gray-500 mb-2">
                Vehicle groups (global taxonomy)
              </div>
              <div className="flex flex-wrap gap-1.5">
                {groups.map((g) => (
                  <span key={g.id} className="inline-flex items-center px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 text-xs font-semibold">
                    {g.name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
