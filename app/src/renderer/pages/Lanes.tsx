import { useEffect, useState } from 'react';
import { Plus, Trash2, Map as MapIcon, X, Camera as CamIcon, CreditCard, Gauge, Search, Monitor } from 'lucide-react';
import type { ParkingLane, PaymentTerminal, RatePolicy, LprCamera, LcdDisplay } from '@shared/types';
import { useConfirm } from '../hooks/useConfirm';
import { usePagedList } from '../hooks/usePagination';
import { PaginationBar } from '../components/Pagination';
import { InfoTip } from '../components/InfoTip';
import { DeviceSyncButtons } from '../components/DeviceSyncButtons';
import { useCurrentSite } from '../context/SiteContext';

const PAGE_SIZE = 10;

const EMPTY: Omit<ParkingLane, 'id' | 'externalId'> = {
  name: '', policyId: null, terminalId: null, lcdId: null, enabled: true,
};

/** A lane's direction is derived from its cameras (the single source of
 *  truth) — mirrors db.deriveLaneDirection for the read-only list display.
 *  'dual' here means the lane has BOTH an entry and an exit camera (one shared
 *  barrier, covered from both sides). Cameras themselves are never 'dual'. */
function laneDirectionLabel(cams: LprCamera[]): string {
  if (cams.length === 0) return 'no cameras';
  const dirs = new Set(cams.map((c) => c.direction));
  if (dirs.has('entry') && dirs.has('exit')) return 'dual';
  if (dirs.has('entry')) return 'entry';
  if (dirs.has('exit')) return 'exit';
  return '—';
}

export function Lanes() {
  const [list, setList] = useState<ParkingLane[]>([]);
  const [terminals, setTerminals] = useState<PaymentTerminal[]>([]);
  const [policies, setPolicies] = useState<RatePolicy[]>([]);
  const [cameras, setCameras] = useState<LprCamera[]>([]);
  const [lcds, setLcds] = useState<LcdDisplay[]>([]);
  // `cameraIds` rides alongside the lane fields — it's the set of cameras this
  // lane covers, persisted server-side against each camera's lane_id.
  const [editing, setEditing] = useState<(Partial<ParkingLane> & { cameraIds?: number[] }) | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const [search, setSearch] = useState('');
  const [dirFilter, setDirFilter] = useState<'all' | 'entry' | 'exit' | 'dual'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'disabled'>('all');

  const site = useCurrentSite();

  async function refresh() {
    setList(await window.bridge.listLanes());
    setTerminals(await window.bridge.listTerminals());
    setPolicies(await window.bridge.listRatePolicies());
    setCameras(await window.bridge.listCameras());
    setLcds(await window.bridge.listLcds());
  }
  useEffect(() => { void refresh(); }, []);

  // Esc closes the add/edit lane modal (backdrop click already does).
  useEffect(() => {
    if (!editing) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setEditing(null); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [editing]);

  async function save() {
    setFormError(null);
    if (!editing?.name) { setFormError('Name is required.'); return; }
    // A hidden field must never persist stale data: the rate plan only applies
    // to an entry lane (it governs the fee), the payment terminal only to an
    // exit lane (that's where payment is collected). Null whichever the lane's
    // cameras don't use, so the DB can't carry a value the form wouldn't show.
    //
    // Decided by the lane's WHOLE camera set, not by cameraIds[0].
    //
    // Keying it off the first camera silently destroyed working config on any
    // lane that still holds two cameras — the shape the backend calls 'dual' and
    // the one the README tells you to build for a shared barrier. The form shows
    // only cameraIds[0], and listCameras() is ordered by id, so on such a lane
    // the entry camera decided: `terminalId: null` on EVERY save. Renaming the
    // gate took its payment device away, the terminal field was not even
    // rendered so nobody could see it go, and every paid exit there then refused
    // with exit-no-terminal. (Reversed if the exit camera had the lower id: the
    // lane lost its RATE PLAN instead and started letting cars out free.)
    //
    // Testing the set means a lane covering both directions keeps both fields,
    // and a genuinely single-direction lane still gets the unused one cleared.
    const laneCameras = cameras.filter((c) => (editing.cameraIds ?? []).includes(c.id));
    const hasEntry = laneCameras.some((c) => c.direction === 'entry');
    const hasExit = laneCameras.some((c) => c.direction === 'exit');
    const payload = {
      ...editing,
      // No cameras yet (mid-setup) keeps whatever the operator typed rather than
      // wiping it — there is nothing to infer a direction from.
      policyId: hasEntry || laneCameras.length === 0 ? (editing.policyId ?? null) : null,
      terminalId: hasExit || laneCameras.length === 0 ? (editing.terminalId ?? null) : null,
    };
    
    const savedResult = await window.bridge.saveLane(payload as any);
    await window.bridge.insertActivityLog({
      eventKey: 'equipment.lane.saved',
      action: editing.id ? 'edit' : 'create',
      category: 'config',
      severity: 'high',
      siteId: site?.id ?? null,
      outcome: 'ok',
      resourceType: 'local_lane',
      resourceId: String(savedResult.id),
      description: `Lane ${(editing.id ? 'updated' : 'added')} · ${editing.name} · ${laneDirectionLabel(laneCameras)}`
    });
    setEditing(null);
    refresh();
  }

  /**
   * Split a legacy shared-barrier lane into an entry lane and an exit lane.
   *
   * This app models a lane as ONE camera — the form offers one, save() derives the
   * rate plan / payment device from it, and the help text tells you to build a
   * shared barrier as two lanes. Installs made before that still carry lanes with
   * both cameras on them, and editing one was a minefield: the form showed only
   * the first camera, so the other was invisible, and there was no way to reach a
   * two-lane shape except by hand in the right order.
   *
   * The rate plan governs the fee and belongs to the ENTRY lane (parking-flow
   * prices from session.entryLaneId); the payment device collects it and belongs
   * to the EXIT lane. So the original keeps its name, entry camera and plan, and a
   * new "<name> (exit)" lane takes the exit camera, the terminal and the panel.
   *
   * Order matters: creating the new lane with the exit camera detaches it from the
   * old one (setLaneCameras steals), so the original is rewritten second.
   */
  async function splitDualLane(lane: ParkingLane) {
    const laneCams = cameras.filter((c) => c.laneId === lane.id);
    const entryCam = laneCams.find((c) => c.direction === 'entry');
    const exitCam = laneCams.find((c) => c.direction === 'exit');
    if (!entryCam || !exitCam) return;
    if (!(await confirm({
      title: 'Split this lane',
      message: `"${lane.name}" covers both directions, which this app no longer models.

`
        + `It will become two lanes:
`
        + `  · "${lane.name}" — ${entryCam.name} (entry), keeping the rate plan
`
        + `  · "${lane.name} (exit)" — ${exitCam.name} (exit), taking the payment device

`
        + `Open sessions are unaffected; they are already recorded against lane ids that keep working.`,
      confirmLabel: 'Split',
    }))) return;

    // New EXIT lane: takes the exit camera, the terminal and the panel. No rate
    // plan — the exit never prices a stay (see parking-flow.handleExit).
    await window.bridge.saveLane({
      name: `${lane.name} (exit)`,
      policyId: null,
      terminalId: lane.terminalId ?? null,
      lcdId: lane.lcdId ?? null,
      enabled: lane.enabled,
      cameraIds: [exitCam.id],
    } as any);
    // Original stays the ENTRY lane: entry camera + rate plan, no terminal.
    await window.bridge.saveLane({
      ...lane,
      terminalId: null,
      cameraIds: [entryCam.id],
    } as any);
    await window.bridge.insertActivityLog({
      eventKey: 'equipment.lane.split',
      action: 'edit',
      category: 'config',
      severity: 'high',
      siteId: site?.id ?? null,
      outcome: 'ok',
      resourceType: 'local_lane',
      resourceId: String(lane.id),
      description: `Lane "${lane.name}" split into an entry lane (${entryCam.name}) and "${lane.name} (exit)" (${exitCam.name}),`
        + ` which took the payment device. Shared-barrier lanes are modelled as two lanes.`,
    });
    setEditing(null);
    await refresh();
  }

  // Which of rate-plan / payment-terminal the form exposes, from the lane's WHOLE
  // camera set — same rule save() uses, so a field is never hidden while its
  // value is still being kept (or shown while it is about to be cleared).
  //
  // On a lane that still covers both directions this shows BOTH. It used to key
  // off cameraIds[0] alone, which meant a dual lane's payment device was
  // un-editable and invisible while save() was quietly nulling it.
  const selectedCameraId = editing?.cameraIds?.[0] ?? null;
  const editingCameras = cameras.filter((c) => (editing?.cameraIds ?? []).includes(c.id));
  const showRatePlan = editingCameras.length === 0 || editingCameras.some((c) => c.direction === 'entry');
  const showTerminal = editingCameras.length === 0 || editingCameras.some((c) => c.direction === 'exit');

  const q = search.trim().toLowerCase();
  const filterActive = q !== '' || dirFilter !== 'all' || statusFilter !== 'all';
  const filtered = list.filter((l) => {
    if (statusFilter === 'enabled' && !l.enabled) return false;
    if (statusFilter === 'disabled' && l.enabled) return false;
    const laneCams = cameras.filter((c) => c.laneId === l.id);
    if (dirFilter !== 'all' && laneDirectionLabel(laneCams) !== dirFilter) return false;
    if (q) {
      const planName = policies.find((p) => p.policyId === l.policyId)?.policyName ?? '';
      const termName = terminals.find((t) => t.id === l.terminalId)?.name ?? '';
      const camNames = laneCams.map((c) => c.name).join(' ');
      const hay = `${l.name} ${planName} ${termName} ${camNames}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const { pager, pageItems } = usePagedList(filtered, PAGE_SIZE);
  useEffect(() => { pager.reset(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [q, dirFilter, statusFilter]);

  return (
    <div className="p-5 sm:p-8 max-w-7xl mx-auto">
      {confirmDialog}
      <header className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            Lanes
            <InfoTip title="About this page" kind="info">
              A lane is one gate where cars drive in or out. This page ties the
              equipment together: give each lane its camera, then a parking rate
              for entry lanes (what to charge) and a payment terminal for exit
              lanes (where drivers tap to pay). A lane's direction comes from
              the camera you assign to it.
            </InfoTip>
          </h1>
          <p className="text-sm text-gray-500 mt-1">Entry and exit gates. Each lane links cameras + a payment terminal + a policy rate.</p>
          {list.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-medium text-gray-500">
              <span className="inline-flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> {list.filter((l) => l.enabled).length} enabled</span>
              <span className="inline-flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-gray-300" /> {list.length} total</span>
              {filterActive && <span className="text-gray-400">· showing {filtered.length}</span>}
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <DeviceSyncButtons type="lanes" onDone={refresh} />
            <button onClick={() => { setFormError(null); setEditing({ ...EMPTY, cameraIds: [] }); }} className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide">
              <Plus size={14} /> Add lane
            </button>
          </div>
        </div>
      </header>

      {list.length > 0 && (
        <div className="mb-3 flex flex-col sm:flex-row sm:items-center gap-2">
          <div className="relative flex-1 sm:max-w-sm">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, camera, plan, or terminal…"
              className="w-full h-9 pl-8 pr-8 border border-gray-200 rounded-lg text-sm focus:border-gray-900 outline-none"
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700">
                <X size={13} />
              </button>
            )}
          </div>
          <select value={dirFilter} onChange={(e) => setDirFilter(e.target.value as any)}
            className="h-9 px-2 rounded-lg border border-gray-200 text-sm focus:border-gray-900 outline-none bg-white">
            <option value="all">All directions</option>
            <option value="entry">Entry</option>
            <option value="exit">Exit</option>
            <option value="dual">Dual</option>
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)}
            className="h-9 px-2 rounded-lg border border-gray-200 text-sm focus:border-gray-900 outline-none bg-white">
            <option value="all">All status</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
          {filterActive && (
            <button onClick={() => { setSearch(''); setDirFilter('all'); setStatusFilter('all'); }}
              className="h-9 px-3 text-xs font-bold uppercase tracking-wide text-gray-500 hover:text-gray-900 whitespace-nowrap">
              Clear
            </button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3">
        {pageItems.map((l) => {
          const t = terminals.find((x) => x.id === l.terminalId);
          const s = policies.find((x) => x.policyId === l.policyId);
          const laneCams = cameras.filter((c) => c.laneId === l.id);
          const dir = laneDirectionLabel(laneCams);
          const showPlan = dir === 'entry' || dir === 'dual';
          const showTerm = dir === 'exit' || dir === 'dual';
          return (
            <div key={l.id} className={`rounded-xl border bg-white p-4 flex flex-wrap items-start justify-between gap-3 ${l.enabled ? 'border-gray-200' : 'border-gray-200 opacity-70'}`}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <MapIcon size={16} className="text-gray-400 flex-shrink-0" />
                  <h3 className="font-semibold truncate">{l.name}</h3>
                  <DirectionBadge label={dir} />
                  {!l.enabled && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border bg-gray-100 text-gray-500 border-gray-200">disabled</span>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <Chip icon={CamIcon} muted={laneCams.length === 0}>
                    {laneCams.length === 0 ? 'no camera' : laneCams.length === 1 ? laneCams[0].name : `${laneCams.length} cameras`}
                  </Chip>
                  {showPlan && <Chip icon={Gauge}>plan: {s?.policyName ?? 'site default'}</Chip>}
                  {showTerm && <Chip icon={CreditCard} muted={!t}>device: {t?.name ?? 'none'}</Chip>}
                  {l.lcdId != null && <Chip icon={Monitor}>lcd: {lcds.find((d) => d.id === l.lcdId)?.name ?? 'unknown'}</Chip>}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => { setFormError(null); setEditing({ ...l, cameraIds: cameras.filter((c) => c.laneId === l.id).map((c) => c.id) }); }} className="text-xs font-bold uppercase tracking-wide text-gray-700 hover:text-gray-900 px-2">Edit</button>
                <button onClick={async () => { if (await confirm({ title: 'Delete lane', message: `Delete lane "${l.name}"?`, danger: true, confirmLabel: 'Delete' })) { await window.bridge.deleteLane(l.id); await window.bridge.insertActivityLog({ eventKey: 'equipment.lane.removed', action: 'delete', category: 'config', severity: 'high', siteId: site?.id ?? null, outcome: 'ok', resourceType: 'local_lane', resourceId: String(l.id), description: `Lane removed · ${l.name}` }); refresh(); } }}
                  className="w-9 h-9 rounded-lg text-red-600 hover:bg-red-50 inline-flex items-center justify-center"><Trash2 size={14} /></button>
              </div>
            </div>
          );
        })}
        {list.length === 0 && (
          <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center">
            <MapIcon size={28} className="mx-auto text-gray-300" />
            <p className="mt-3 text-sm font-semibold text-gray-700">No lanes yet</p>
            <p className="mt-1 text-[13px] text-gray-500">A lane links an LPR camera to a rate plan (entry) and/or a payment terminal (exit).</p>
            <button onClick={() => { setFormError(null); setEditing({ ...EMPTY, cameraIds: [] }); }} className="mt-4 inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide">
              <Plus size={13} /> Add lane
            </button>
          </div>
        )}
        {list.length > 0 && filtered.length === 0 && (
          <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-sm text-gray-500">
            <Search size={22} className="mx-auto text-gray-300" />
            <p className="mt-2">No lanes match the current filters.</p>
            <button onClick={() => { setSearch(''); setDirFilter('all'); setStatusFilter('all'); }}
              className="mt-3 text-[11px] font-bold uppercase tracking-wide text-gray-600 hover:text-gray-900">
              Clear filters
            </button>
          </div>
        )}
      </div>

      <PaginationBar pager={pager} rowsOnPage={pageItems.length} />

      {/* Same viewport cap as the Cameras modal — header and footer pinned, only
          the fields scroll, so Save can never be pushed off a short window. */}
      {editing && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-start sm:items-center justify-center p-4 overflow-y-auto" onClick={() => setEditing(null)}>
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-xl my-auto bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[calc(100vh-2rem)]"
          >
            <header className="shrink-0 px-5 py-4 border-b border-gray-200 flex items-center justify-between">
              <h2 className="text-base font-bold">{editing.id ? 'Edit' : 'Add'} lane</h2>
              <button onClick={() => setEditing(null)} className="w-9 h-9 rounded-lg hover:bg-gray-100 inline-flex items-center justify-center text-gray-500"><X size={18} /></button>
            </header>
            <div className="flex-1 min-h-0 overflow-y-auto p-5 grid grid-cols-1 sm:grid-cols-2 gap-3 content-start">
              <Field label="Display name"><input className="input" value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
              {/* One camera per lane. Two cameras on the same lane would both
                  fire a plate event for the same car, forcing dedup guesswork —
                  so a lane binds to exactly one. Grouped by direction so the
                  right camera is easy to find when there are many. Picking a
                  camera sets its lane_id to this lane (stealing it off any
                  other). Direction itself is still set per-camera on the
                  Cameras page. */}
              {/* A lane still covering BOTH directions is the legacy shape. The
                  single-camera picker below cannot represent it — it shows only the
                  first camera — so say what is really attached and offer the way
                  out, rather than letting the operator edit around an invisible
                  second camera. */}
              {editing.id != null && editingCameras.length > 1 && (
                <div className="sm:col-span-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
                  <p className="text-[11px] font-bold uppercase tracking-wide text-amber-800 mb-1">
                    This lane covers both directions
                  </p>
                  <p className="text-[11px] text-amber-900 leading-relaxed">
                    {editingCameras.map((c) => `${c.name} (${c.direction})`).join(' + ')} are both on this lane.
                    A shared barrier is modelled as two lanes now — one per direction — so the picker below
                    shows only the first camera. Split it and each gate gets its own rate plan and payment device.
                  </p>
                  <button
                    type="button"
                    onClick={() => { const l = list.find((x) => x.id === editing.id); if (l) void splitDualLane(l); }}
                    className="mt-2 inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-amber-700 hover:bg-amber-800 text-white text-[11px] font-bold uppercase tracking-wide"
                  >
                    Split into two lanes
                  </button>
                </div>
              )}
              <Field label="Camera">
                <select className="input" value={selectedCameraId ?? ''}
                  onChange={(e) => {
                    const picked = e.target.value ? [Number(e.target.value)] : [];
                    // Changing the selection REPLACES the lane's camera set, so on a
                    // lane that still holds two cameras this detaches the other one
                    // (lane_id = NULL) and its reads stop resolving to any lane.
                    // Worth saying out loud rather than doing quietly.
                    const dropped = (editing.cameraIds ?? []).filter((id) => !picked.includes(id));
                    if (dropped.length > 0) {
                      const names = cameras.filter((c) => dropped.includes(c.id)).map((c) => c.name).join(', ');
                      setFormError(`Saving will take ${names} off this lane. Reads from ${dropped.length > 1 ? 'those cameras' : 'that camera'} will no longer resolve to a lane until you attach ${dropped.length > 1 ? 'them' : 'it'} somewhere.`);
                    } else {
                      setFormError(null);
                    }
                    setEditing({ ...editing, cameraIds: picked });
                  }}>
                  <option value="">— none —</option>
                  {(['entry', 'exit'] as const).map((group) => {
                    const groupCams = cameras.filter((c) => c.direction === group);
                    if (groupCams.length === 0) return null;
                    return (
                      <optgroup key={group} label={group.toUpperCase()}>
                        {groupCams.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}{c.laneId != null && c.laneId !== editing.id ? ' (on another lane)' : ''}
                          </option>
                        ))}
                      </optgroup>
                    );
                  })}
                </select>
              </Field>
              <div className="sm:col-span-2 -mt-1">
                {cameras.length === 0 ? (
                  <p className="text-[11px] text-amber-600">No cameras yet — add one on the <strong>Cameras</strong> page first. A lane needs an LPR camera to do anything.</p>
                ) : (
                  <p className="text-[11px] text-gray-500">The camera's direction decides the rest: <strong>entry</strong> → set the rate plan; <strong>exit</strong> → set the payment device. For one barrier used both ways, make two lanes — an entry lane and an exit lane — each with its own camera.</p>
                )}
              </div>
              {showRatePlan && (
                <Field label="Rate plan">
                  {/* Points at a policy_id which now corresponds to a cloud
                      RatePolicy — different lanes can bind to different plans
                      (VIP → premium, general → standard). "— site default —"
                      falls back to the plan the cloud flagged as default. The
                      fee is governed by the ENTRY lane's plan, which is why
                      this only shows for an entry camera. */}
                  <select className="input" value={editing.policyId ?? ''} onChange={(e) => setEditing({ ...editing, policyId: e.target.value || null })}>
                    <option value="">— site default —</option>
                    {policies.map((s) => (
                      <option key={s.policyId} value={s.policyId}>
                        {s.policyName}{(s as any).isSiteDefault ? ' (default)' : ''}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {showTerminal && (
                <Field label="Payment device (Alarmtech W4G)">
                  <select className="input" value={editing.terminalId ?? ''} onChange={(e) => setEditing({ ...editing, terminalId: e.target.value ? Number(e.target.value) : null })}>
                    <option value="">— none —</option>
                    {terminals.map((t) => {
                      // C5: flag a terminal already wired to another lane. One reader
                      // serving two exit lanes can take two concurrent taps and
                      // cross-settle; the runtime guard blocks the second charge, and
                      // this warning stops the misconfiguration being made in the first
                      // place — same treatment the LCD picker below already gives.
                      const takenBy = list.find((l) => l.terminalId === t.id && l.id !== editing.id);
                      return <option key={t.id} value={t.id}>{t.name}{takenBy ? ` — on "${takenBy.name}"` : ''}</option>;
                    })}
                  </select>
                </Field>
              )}
              {/* Shown for BOTH directions, unlike the rate plan and the payment
                  device: an entry lane's panel greets the driver with the plate
                  it read, an exit lane's shows the plate and what they owe. */}
              <Field label="LCD display (optional)">
                <select className="input" value={editing.lcdId ?? ''} onChange={(e) => setEditing({ ...editing, lcdId: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">— none —</option>
                  {lcds.map((d) => {
                    const takenBy = list.find((l) => l.lcdId === d.id && l.id !== editing.id);
                    return (
                      <option key={d.id} value={d.id}>
                        {d.name} ({d.host}:{d.port}){!d.enabled ? ' — disabled' : ''}{takenBy ? ` — on "${takenBy.name}"` : ''}
                      </option>
                    );
                  })}
                </select>
              </Field>
              <div className="sm:col-span-2 -mt-1">
                {lcds.length === 0 ? (
                  <p className="text-[11px] text-gray-500">No panels yet — add one on the <strong>LCD Displays</strong> page. Optional: a lane works fine without one.</p>
                ) : (
                  <p className="text-[11px] text-gray-500">Give each lane its own panel. Two lanes sharing one screen would overwrite each other's fare mid-transaction.</p>
                )}
              </div>
              <Field label="Enabled">
                <label className="inline-flex items-center gap-2 mt-2 text-sm"><input type="checkbox" checked={editing.enabled ?? true} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} /> active</label>
              </Field>
            </div>
            {formError && (
              <div className="shrink-0 mx-5 mb-3 mt-3 rounded-lg border border-red-200 bg-red-50 text-red-700 text-xs px-3 py-2">{formError}</div>
            )}
            <footer className="shrink-0 px-5 py-3 border-t border-gray-200 flex items-center justify-end gap-2">
              <button onClick={() => setEditing(null)} className="text-xs font-bold uppercase tracking-wide text-gray-600 hover:text-gray-900 px-3">Cancel</button>
              <button onClick={save} className="h-10 px-4 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide">Save</button>
            </footer>
          </div>
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

/** Color-coded lane direction (derived from its cameras). */
function DirectionBadge({ label }: { label: string }) {
  const cls = label === 'entry' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : label === 'exit' ? 'bg-blue-50 text-blue-700 border-blue-200'
    : label === 'dual' ? 'bg-amber-50 text-amber-700 border-amber-200'
    : 'bg-gray-100 text-gray-500 border-gray-200';
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border ${cls}`}>{label}</span>;
}

function Chip({ children, icon: Icon, mono, muted }: { children: React.ReactNode; icon?: any; mono?: boolean; muted?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-gray-200 bg-gray-50 text-[11px] ${muted ? 'text-gray-400' : 'text-gray-600'} ${mono ? 'font-mono' : ''}`}>
      {Icon && <Icon size={11} className="text-gray-400 flex-shrink-0" />}
      {children}
    </span>
  );
}
