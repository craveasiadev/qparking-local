import { useEffect, useState } from 'react';
import { Plus, Trash2, Monitor, X, Loader2, Search, Wifi, WifiOff, FlaskConical, MapPin } from 'lucide-react';
import type { LcdDisplay, LcdDisplayStatus, ParkingLane } from '@shared/types';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { useConfirm } from '../hooks/useConfirm';
import { usePagedList } from '../hooks/usePagination';
import { PaginationBar } from '../components/Pagination';
import { InfoTip } from '../components/InfoTip';
import { fmtTimeSeconds } from '../lib/datetime';
import { useCurrentSite } from '../context/SiteContext';
import { toast } from '../toast';

/**
 * Driver-facing LCD panels running the qparking-lcd Android app.
 *
 * The panel listens; this box dials in and holds the connection open, pushing
 * plate / fare / thank-you frames as the parking flow decides them. A lane binds
 * to its panel on the Lanes page.
 *
 * Only two facts are needed per panel — its IP and its port — and both are
 * printed along the bottom of the panel's own idle screen, so commissioning is a
 * matter of reading them off the glass and typing them here.
 */

const PAGE_SIZE = 10;

const EMPTY: Omit<LcdDisplay, 'id' | 'externalId' | 'createdAt' | 'updatedAt'> = {
  name: '', host: '', port: 7070, enabled: true,
};

export function Lcds() {
  const [list, setList] = useState<LcdDisplay[]>([]);
  const [lanes, setLanes] = useState<ParkingLane[]>([]);
  const [statuses, setStatuses] = useState<LcdDisplayStatus[]>([]);
  const [editing, setEditing] = useState<Partial<LcdDisplay> | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'connected' | 'offline'>('all');

  const site = useCurrentSite();

  async function refresh() {
    setList(await window.bridge.listLcds());
    setLanes(await window.bridge.listLanes());
    try {
      setStatuses(await window.bridge.getLcdStatuses());
    } catch { /* link health is best-effort — never block the list on it */ }
  }
  useEffect(() => { void refresh(); }, []);

  // Poll link health so a panel that comes back on its own shows as connected
  // without the operator reloading the page.
  useEffect(() => {
    const t = setInterval(() => {
      window.bridge.getLcdStatuses().then(setStatuses).catch(() => null);
    }, 3000);
    return () => clearInterval(t);
  }, []);

  // Esc closes the add/edit modal (backdrop click already does).
  useEffect(() => {
    if (!editing) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setEditing(null); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [editing]);

  const [save, saving] = useAsyncAction(async () => {
    // Validation is native (required + type=number on the inputs), so the button
    // stays clickable and the browser points at the offending field.
    const isNew = !editing?.id;
    try {
      const saved = await window.bridge.saveLcd(editing as any);
      await window.bridge.insertActivityLog({
        eventKey: 'equipment.lcd.saved',
        action: isNew ? 'create' : 'edit',
        category: 'config',
        severity: 'high',
        siteId: site?.id ?? null,
        outcome: 'ok',
        resourceType: 'local_terminal',
        resourceId: String(saved.id),
        description: `LCD display ${isNew ? 'added' : 'updated'} · ${editing?.name} · ${editing?.host}:${editing?.port}`,
      });
      toast({ tone: 'success', title: isNew ? 'Display added' : 'Display saved', detail: `${saved.name} · ${saved.host}:${saved.port}` });
      setEditing(null);
      await refresh();
    } catch (e: any) {
      toast({ tone: 'error', title: 'Could not save the display', detail: e?.message ?? String(e) });
    }
  });

  const [runTest, testing] = useAsyncAction(async (host: string, port: number) => {
    toast({ tone: 'success', title: 'Testing…', detail: `Watch ${host}:${port} — it should show a fare, then a thank-you, then go idle.` });
    const result = await window.bridge.testLcd({ host, port });
    if (result.ok) {
      toast({ tone: 'success', title: 'Panel answered', detail: `${host}:${port} accepted the test sequence${result.latencyMs != null ? ` (${result.latencyMs} ms)` : ''}.` });
    } else {
      toast({ tone: 'error', title: 'No answer from the panel', detail: result.error ?? 'Unknown error.' });
    }
  });

  const [runDelete] = useAsyncAction(async (lcd: LcdDisplay) => {
    const boundLanes = lanes.filter((l) => l.lcdId === lcd.id);
    const message = boundLanes.length > 0
      ? `Delete "${lcd.name}"? ${boundLanes.length === 1 ? `Lane "${boundLanes[0].name}" is` : `${boundLanes.length} lanes are`} using it and will be left with no display.`
      : `Delete "${lcd.name}"?`;
    if (!(await confirm({ title: 'Delete display', message, danger: true, confirmLabel: 'Delete' }))) return;
    setDeletingId(lcd.id);
    try {
      await window.bridge.deleteLcd(lcd.id);
      await window.bridge.insertActivityLog({
        eventKey: 'equipment.lcd.removed',
        action: 'delete',
        category: 'config',
        severity: 'high',
        siteId: site?.id ?? null,
        outcome: 'ok',
        resourceType: 'local_terminal',
        resourceId: String(lcd.id),
        description: `LCD display removed · ${lcd.name}`,
      });
      toast({ tone: 'success', title: 'Display deleted', detail: lcd.name });
      await refresh();
    } catch (e: any) {
      toast({ tone: 'error', title: 'Could not delete the display', detail: e?.message ?? String(e) });
    } finally {
      setDeletingId(null);
    }
  });

  const statusFor = (id: number) => statuses.find((s) => s.lcdId === id) ?? null;

  const q = search.trim().toLowerCase();
  const filterActive = q !== '' || statusFilter !== 'all';
  const filtered = list.filter((d) => {
    const st = statusFor(d.id);
    if (statusFilter === 'connected' && !st?.connected) return false;
    if (statusFilter === 'offline' && st?.connected) return false;
    if (q) {
      const laneNames = lanes.filter((l) => l.lcdId === d.id).map((l) => l.name).join(' ');
      if (!`${d.name} ${d.host} ${d.port} ${laneNames}`.toLowerCase().includes(q)) return false;
    }
    return true;
  });
  const { pager, pageItems } = usePagedList(filtered, PAGE_SIZE);
  useEffect(() => { pager.reset(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [q, statusFilter]);

  const connectedCount = statuses.filter((s) => s.connected).length;

  return (
    <div className="p-5 sm:p-8 max-w-7xl mx-auto">
      {confirmDialog}
      <header className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            LCD Displays
            <InfoTip title="About this page" kind="info">
              These are the driver-facing screens at the barrier, running the
              QParking LCD app on an Android panel. When a camera reads a plate
              this server pushes it to the lane's panel — a welcome on the way
              in, the plate and the fare on the way out, then a thank-you once
              payment clears. Add the panel here, then pick it on the Lanes page.
            </InfoTip>
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Open the QParking LCD app on the panel: its IP and port are printed along the bottom of the idle screen. Type both in here.
          </p>
          {list.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-medium text-gray-500">
              <span className="inline-flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> {connectedCount} connected</span>
              <span className="inline-flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-gray-300" /> {list.length} total</span>
              {filterActive && <span className="text-gray-400">· showing {filtered.length}</span>}
            </div>
          )}
        </div>
        <button onClick={() => setEditing({ ...EMPTY })} className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide">
          <Plus size={14} /> Add display
        </button>
      </header>

      {list.length > 0 && (
        <div className="mb-3 flex flex-col sm:flex-row sm:items-center gap-2">
          <div className="relative flex-1 sm:max-w-sm">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, IP, or lane…"
              className="w-full h-9 pl-8 pr-8 border border-gray-200 rounded-lg text-sm focus:border-gray-900 outline-none"
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700">
                <X size={13} />
              </button>
            )}
          </div>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)}
            className="h-9 px-2 rounded-lg border border-gray-200 text-sm focus:border-gray-900 outline-none bg-white">
            <option value="all">All panels</option>
            <option value="connected">Connected</option>
            <option value="offline">Offline</option>
          </select>
          {filterActive && (
            <button onClick={() => { setSearch(''); setStatusFilter('all'); }}
              className="h-9 px-3 text-xs font-bold uppercase tracking-wide text-gray-500 hover:text-gray-900 whitespace-nowrap">
              Clear
            </button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3">
        {pageItems.map((d) => {
          const st = statusFor(d.id);
          const boundLanes = lanes.filter((l) => l.lcdId === d.id);
          return (
            <div key={d.id} className={`rounded-xl border bg-white p-4 flex flex-wrap items-start justify-between gap-3 ${d.enabled ? 'border-gray-200' : 'border-gray-200 opacity-70'}`}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <Monitor size={16} className="text-gray-400 flex-shrink-0" />
                  <h3 className="font-semibold truncate">{d.name}</h3>
                  <LinkBadge status={st} enabled={d.enabled} />
                  {!d.enabled && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border bg-gray-100 text-gray-500 border-gray-200">disabled</span>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <Chip mono>{d.host}:{d.port}</Chip>
                  <Chip icon={MapPin} muted={boundLanes.length === 0}>
                    {boundLanes.length === 0 ? 'not on any lane' : boundLanes.map((l) => l.name).join(', ')}
                  </Chip>
                  {st?.lastAckAt && <Chip>last frame {fmtTimeSeconds(st.lastAckAt)}{st.lastScreen ? ` · ${st.lastScreen}` : ''}</Chip>}
                </div>
                {/* The failure text carries the fix, not just the errno — see
                    describeSocketError in lcd-display.ts. */}
                {!st?.connected && st?.lastError && (
                  <p className="mt-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">{st.lastError}</p>
                )}
                {boundLanes.length === 0 && d.enabled && (
                  <p className="mt-2 text-[11px] text-gray-500">
                    Nothing will appear on this panel until a lane points at it — set that on the <strong>Lanes</strong> page.
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => runTest(d.host, d.port)}
                  className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-gray-200 text-xs font-bold uppercase tracking-wide text-gray-700 hover:bg-gray-50">
                  {testing ? <Loader2 size={13} className="animate-spin" /> : <FlaskConical size={13} />} Test
                </button>
                <button onClick={() => setEditing({ ...d })} className="text-xs font-bold uppercase tracking-wide text-gray-700 hover:text-gray-900 px-2">Edit</button>
                <button onClick={() => runDelete(d)}
                  className="w-9 h-9 rounded-lg text-red-600 hover:bg-red-50 inline-flex items-center justify-center">
                  {deletingId === d.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                </button>
              </div>
            </div>
          );
        })}
        {list.length === 0 && (
          <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center">
            <Monitor size={28} className="mx-auto text-gray-300" />
            <p className="mt-3 text-sm font-semibold text-gray-700">No LCD displays yet</p>
            <p className="mt-1 text-[13px] text-gray-500 max-w-md mx-auto">
              Install the QParking LCD app on the Android panel at the barrier. Its idle screen shows the IP and port to enter here.
            </p>
            <button onClick={() => setEditing({ ...EMPTY })} className="mt-4 inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide">
              <Plus size={13} /> Add display
            </button>
          </div>
        )}
        {list.length > 0 && filtered.length === 0 && (
          <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-sm text-gray-500">
            <Search size={22} className="mx-auto text-gray-300" />
            <p className="mt-2">No displays match the current filters.</p>
            <button onClick={() => { setSearch(''); setStatusFilter('all'); }}
              className="mt-3 text-[11px] font-bold uppercase tracking-wide text-gray-600 hover:text-gray-900">
              Clear filters
            </button>
          </div>
        )}
      </div>

      <PaginationBar pager={pager} rowsOnPage={pageItems.length} />

      {editing && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-start sm:items-center justify-center p-4 overflow-y-auto" onClick={() => setEditing(null)}>
          {/* A real <form> so the browser enforces required/min/max natively and
              Enter submits — Save stays clickable and the browser focuses the
              first offending field rather than us hand-rolling error strings. */}
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => { e.preventDefault(); void save(); }}
            className="w-full max-w-xl my-auto bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[calc(100vh-2rem)]"
          >
            <header className="shrink-0 px-5 py-4 border-b border-gray-200 flex items-center justify-between">
              <h2 className="text-base font-bold">{editing.id ? 'Edit' : 'Add'} LCD display</h2>
              <button type="button" onClick={() => setEditing(null)} className="w-9 h-9 rounded-lg hover:bg-gray-100 inline-flex items-center justify-center text-gray-500"><X size={18} /></button>
            </header>
            <div className="flex-1 min-h-0 overflow-y-auto p-5 grid grid-cols-1 sm:grid-cols-2 gap-3 content-start">
              <Field label="Display name">
                <input className="input" required value={editing.name ?? ''} placeholder="Exit A screen"
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              </Field>
              <Field label="Panel IP address">
                <input className="input font-mono" required value={editing.host ?? ''} placeholder="192.168.1.60"
                  onChange={(e) => setEditing({ ...editing, host: e.target.value.trim() })} />
              </Field>
              <Field label="Port">
                <input className="input font-mono" type="number" required min={1} max={65535} value={editing.port ?? 7070}
                  onChange={(e) => setEditing({ ...editing, port: Number(e.target.value) })} />
              </Field>
              <Field label="Enabled">
                <label className="inline-flex items-center gap-2 mt-2 text-sm">
                  <input type="checkbox" checked={editing.enabled ?? true} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} /> active
                </label>
              </Field>
              <div className="sm:col-span-2 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2.5 text-[11px] text-gray-600 leading-relaxed">
                Both values are printed along the bottom of the panel's idle screen. To change the
                port, open the QParking LCD app and tap the <strong>top-left corner five times</strong> to
                reach its setup screen. Default port is <strong>7070</strong>.
              </div>
            </div>
            <footer className="shrink-0 px-5 py-3 border-t border-gray-200 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => runTest(editing.host ?? '', Number(editing.port) || 0)}
                className="inline-flex items-center gap-1.5 h-10 px-3 rounded-lg border border-gray-200 text-xs font-bold uppercase tracking-wide text-gray-700 hover:bg-gray-50">
                {testing ? <Loader2 size={13} className="animate-spin" /> : <FlaskConical size={13} />} Test this address
              </button>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setEditing(null)} className="text-xs font-bold uppercase tracking-wide text-gray-600 hover:text-gray-900 px-3">Cancel</button>
                <button type="submit" className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide">
                  {saving && <Loader2 size={13} className="animate-spin" />} Save
                </button>
              </div>
            </footer>
          </form>
          <style>{`.input { height: 40px; padding: 0 0.75rem; border: 1px solid #d1d5db; border-radius: 0.5rem; outline: none; font-size: 14px; width: 100%; } .input:focus { border-color: #111827; }`}</style>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-semibold uppercase tracking-wide text-gray-600 mb-1">{label}</label>
      {children}
    </div>
  );
}

/** Live TCP link state for one panel. */
function LinkBadge({ status, enabled }: { status: LcdDisplayStatus | null; enabled: boolean }) {
  if (!enabled) return null;
  const connected = !!status?.connected;
  const cls = connected ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200';
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border ${cls}`}>
      {connected ? <Wifi size={10} /> : <WifiOff size={10} />}
      {connected ? 'connected' : 'offline'}
    </span>
  );
}

function Chip({ children, icon: Icon, mono, muted }: { children: React.ReactNode; icon?: any; mono?: boolean; muted?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-gray-200 bg-gray-50 text-[11px] ${muted ? 'text-gray-400' : 'text-gray-600'} ${mono ? 'font-mono' : ''}`}>
      {Icon && <Icon size={11} className="text-gray-400 flex-shrink-0" />}
      {children}
    </span>
  );
}
