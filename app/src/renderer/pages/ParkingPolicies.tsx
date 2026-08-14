import { Fragment, useEffect, useMemo, useState } from 'react';
import { RefreshCw, AlertCircle, Loader2, ChevronDown, ChevronRight, Clock, Star, Calculator, Search, X } from 'lucide-react';
import { InfoTip } from '../components/InfoTip';
import type { RatePolicy, TariffRule } from '@shared/types';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { useReloadOnCloudSync } from '../hooks/useReloadOnCloudSync';
import { usePagedList } from '../hooks/usePagination';
import { PaginationBar } from '../components/Pagination';
import { fmtDateTime, dateInAppTz, APP_TZ } from '../lib/datetime';
import { toast } from '../toast';

const PAGE_SIZE = 10;

export function ParkingPolicies() {
  const [list, setList] = useState<RatePolicy[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<'all' | 'default' | 'zero'>('all');

  function toggle(id: string) { setExpanded((m) => ({ ...m, [id]: !m[id] })); }

  async function refresh() { setList(await window.bridge.listRatePolicies()); }
  useEffect(() => { void refresh(); }, []);
  // Rates only come down on a FULL pull (boot / "Sync now" / rebind), so this
  // is the one moment the list can change under the operator's feet.
  useReloadOnCloudSync(['policies'], refresh);

  const [sync, syncing] = useAsyncAction(async () => {
    const r = await window.bridge.syncRatePoliciesNow();
    if (r.ok) toast({ tone: 'success', title: `Fetched ${r.fetched} policy(s)` });
    else toast({ tone: 'error', title: 'Sync failed', detail: String(r.error) });
    await refresh();
  });

  const lastSynced = useMemo(
    () => list.reduce((m, s) => (s.fetchedAt && s.fetchedAt > m ? s.fetchedAt : m), ''),
    [list],
  );
  const withRulesCount = list.filter((s) => (s.rules?.length ?? 0) > 0).length;

  const q = search.trim().toLowerCase();
  const filterActive = q !== '' || kindFilter !== 'all';
  const isZero = (s: RatePolicy) => s.firstBlockCents === 0 && s.perBlockCents === 0;
  const filtered = list.filter((s) => {
    if (kindFilter === 'default' && !(s as any).isSiteDefault) return false;
    if (kindFilter === 'zero' && !isZero(s)) return false;
    if (q) {
      const hay = `${s.policyName ?? ''} ${s.policyId ?? ''} ${s.policyDescription ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const { pager, pageItems } = usePagedList(filtered, PAGE_SIZE);
  useEffect(() => { pager.reset(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [q, kindFilter]);

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto">
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight flex items-center gap-2">
            Parking Rates
            <InfoTip>
              Parking prices are set in the qparking cloud (Pricing &amp; Tariffs).
              Every active plan appears here automatically and is saved on this
              server, so the gate can still charge the right price even when the
              internet is down. To give a lane a different plan, use the Lanes
              page. To change a price, edit it in the cloud — it arrives here
              within a minute.
            </InfoTip>
          </h1>
          <p className="text-xs sm:text-sm text-gray-500 mt-1">
            Every active parking rate configured on the cloud, cached here so the gate can price sessions even if WAN is offline. Expand a rate to test a price.
          </p>
          {list.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-medium text-gray-500">
              <span className="inline-flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-gray-400" /> {list.length} plan{list.length === 1 ? '' : 's'}</span>
              <span className="inline-flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-blue-500" /> {withRulesCount} with rules</span>
              {lastSynced && <span className="inline-flex items-center gap-1.5"><Clock size={12} /> synced {fmtDateTime(lastSynced)}</span>}
            </div>
          )}
        </div>
        <button onClick={() => sync()} disabled={syncing}
          className="inline-flex items-center justify-center gap-1.5 h-10 px-4 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50 self-start">
          {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </header>

      {list.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-sm text-gray-500 inline-flex items-center justify-center gap-2 w-full">
          <AlertCircle size={14} /> No policies cached yet. Configure qparking URL + API key in Settings, then click Sync now.
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
                placeholder="Search plan name, id, or description…"
                className="w-full h-9 pl-8 pr-8 border border-gray-200 rounded-lg text-sm focus:border-gray-900 outline-none"
              />
              {search && (
                <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700">
                  <X size={13} />
                </button>
              )}
            </div>
            <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value as any)}
              className="h-9 px-2 rounded-lg border border-gray-200 text-sm focus:border-gray-900 outline-none bg-white">
              <option value="all">All plans</option>
              <option value="default">Site default</option>
              <option value="zero">Zero-rate (free)</option>
            </select>
            {filterActive && (
              <button onClick={() => { setSearch(''); setKindFilter('all'); }}
                className="h-9 px-3 text-xs font-bold uppercase tracking-wide text-gray-500 hover:text-gray-900 whitespace-nowrap">
                Clear
              </button>
            )}
          </div>

          {filtered.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-sm text-gray-500">
              <Search size={22} className="mx-auto text-gray-300" />
              <p className="mt-2">No plans match the current filters.</p>
              <button onClick={() => { setSearch(''); setKindFilter('all'); }}
                className="mt-3 text-[11px] font-bold uppercase tracking-wide text-gray-600 hover:text-gray-900">
                Clear filters
              </button>
            </div>
          ) : (
          <>
          {/* Desktop / tablet table */}
          <div className="hidden md:block rounded-xl border border-gray-200 bg-white overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-[10px] uppercase tracking-widest text-gray-500">
                  <tr>
                    <th className="text-left px-3 py-2 font-bold">Policy</th>
                    <th className="text-right px-3 py-2 font-bold">Free</th>
                    <th className="text-right px-3 py-2 font-bold">1st block</th>
                    <th className="text-right px-3 py-2 font-bold">Per block</th>
                    <th className="text-right px-3 py-2 font-bold">Block size</th>
                    <th className="text-right px-3 py-2 font-bold">Daily cap</th>
                    <th className="text-right px-3 py-2 font-bold">Fetched</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map((s) => {
                    const zero = s.firstBlockCents === 0 && s.perBlockCents === 0;
                    const ruleCount = s.rules?.length ?? 0;
                    const isOpen = !!expanded[s.policyId];
                    return (
                      <Fragment key={s.policyId}>
                        <tr className={`border-t border-gray-100 ${zero ? 'bg-amber-50/40' : ''}`}>
                          <td className="px-3 py-2">
                            <button
                              type="button"
                              onClick={() => toggle(s.policyId)}
                              className="inline-flex items-center gap-1.5 text-left hover:opacity-75"
                              title="Click to expand — view rules & test a price"
                            >
                              {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                              <div>
                                <div className="font-semibold">{s.policyName}</div>
                                <div className="text-[11px] text-gray-500 font-mono">{s.policyId}</div>
                              </div>
                            </button>
                            {ruleCount > 0 && (
                              <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-gray-100 text-gray-700 text-[10px] font-semibold px-2 py-0.5">
                                {ruleCount} rule{ruleCount === 1 ? '' : 's'}
                              </span>
                            )}
                            {s.policyName && (
                              <div className="text-[10px] text-gray-400 mt-0.5">Policy: {s.policyName}</div>
                            )}
                            {s.policyDescription && (
                              <div className="text-[10px] text-gray-500 mt-0.5 italic max-w-md">{s.policyDescription}</div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right font-mono">{s.freeMinutes} min</td>
                          <td className={`px-3 py-2 text-right font-mono ${zero ? 'text-amber-700 font-bold' : ''}`}>{fmtCents(s.firstBlockCents, s.currency)}</td>
                          <td className={`px-3 py-2 text-right font-mono ${zero ? 'text-amber-700 font-bold' : ''}`}>{fmtCents(s.perBlockCents, s.currency)}</td>
                          <td className="px-3 py-2 text-right font-mono">{s.blockMinutes} min</td>
                          <td className="px-3 py-2 text-right font-mono">{(s.policyDailyCapCents ?? 0) > 0 ? fmtCents(s.policyDailyCapCents!, s.currency) : '—'}</td>
                          <td className="px-3 py-2 text-right text-[11px] text-gray-500">{fmtDateTime(s.fetchedAt)}</td>
                          <td className="px-3 py-2 text-right">
                            {(s as any).isSiteDefault && (
                              <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-emerald-700">
                                <Star size={10} /> Default
                              </span>
                            )}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="bg-gray-50/60 border-t border-gray-100">
                            <td colSpan={8} className="px-3 py-3">
                              <RulesTable policy={s} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-2">
            {pageItems.map((s) => {
              const zero = s.firstBlockCents === 0 && s.perBlockCents === 0;
              const ruleCount = s.rules?.length ?? 0;
              const isOpen = !!expanded[s.policyId];
              return (
                <div key={s.policyId} className={`rounded-xl border bg-white p-3 ${zero ? 'border-amber-300 bg-amber-50/40' : 'border-gray-200'}`}>
                  <div className="flex items-start justify-between gap-2">
                    <button type="button" onClick={() => toggle(s.policyId)} className="min-w-0 text-left inline-flex items-start gap-1.5">
                      {isOpen ? <ChevronDown size={13} className="mt-1" /> : <ChevronRight size={13} className="mt-1" />}
                      <div>
                        <div className="font-semibold">{s.policyName}</div>
                        <div className="text-[11px] text-gray-500 font-mono break-all">{s.policyId}</div>
                        {ruleCount > 0 && (
                          <div className="mt-0.5 text-[10px] text-gray-500">{ruleCount} tariff rule{ruleCount === 1 ? '' : 's'} from cloud</div>
                        )}
                      </div>
                    </button>
                    {(s as any).isSiteDefault && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-emerald-700">
                        <Star size={10} /> Default
                      </span>
                    )}
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                    <div><span className="text-gray-500">Free:</span> <span className="font-mono">{s.freeMinutes} min</span></div>
                    <div><span className="text-gray-500">Block:</span> <span className="font-mono">{s.blockMinutes} min</span></div>
                    <div><span className="text-gray-500">1st:</span> <span className={`font-mono ${zero ? 'text-amber-700 font-bold' : ''}`}>{fmtCents(s.firstBlockCents, s.currency)}</span></div>
                    <div><span className="text-gray-500">Per:</span> <span className={`font-mono ${zero ? 'text-amber-700 font-bold' : ''}`}>{fmtCents(s.perBlockCents, s.currency)}</span></div>
                    <div className="col-span-2"><span className="text-gray-500">Daily cap:</span> <span className="font-mono">{(s.policyDailyCapCents ?? 0) > 0 ? fmtCents(s.policyDailyCapCents!, s.currency) : '—'}</span></div>
                  </div>
                  {isOpen && (
                    <div className="mt-3 pt-3 border-t border-gray-200">
                      <RulesTable policy={s} compact />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          </>
          )}

          <PaginationBar pager={pager} rowsOnPage={pageItems.length} />

          {list.some((s) => s.firstBlockCents === 0 && s.perBlockCents === 0) && (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 text-amber-900 text-[12px] px-3 py-2">
              <strong>Heads up:</strong> rows in amber have a RM 0 rate — the exit flow will skip the payment terminal and treat all parking as free. Set real values in <strong>qparking → Pricing &amp; Tariffs</strong>; the change syncs down within a minute.
            </div>
          )}
        </>
      )}
    </div>
  );
}

function fmtCents(c: number, currency: string) {
  return `${currency} ${(c / 100).toFixed(2)}`;
}

// ─── Tariff rules drawer ───────────────────────────────────────────────────
// Renders the full `rules[]` array fetched from qparking SaaS — vehicle
// type, day-of-week, time window, rule type (flat vs hourly), and amounts.
// Highlights the rule that matches RIGHT NOW so the operator can see at a
// glance which one would settle a current exit.

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function fmtDays(days: number[] | null): string {
  if (!days || days.length === 0 || days.length === 7) return 'Everyday';
  const sorted = [...days].sort();
  if (sorted.join(',') === '1,2,3,4,5') return 'Weekdays';
  if (sorted.join(',') === '0,6') return 'Weekends';
  return sorted.map((d) => DAY_LABELS[d]).join(', ');
}

function fmtTimeRange(from: string, to: string): string {
  const f = (from ?? '').slice(0, 5);
  const t = (to ?? '').slice(0, 5);
  if (f === '00:00' && (t === '23:59' || t === '24:00' || t === '00:00')) return 'All day';
  return `${f}–${t}`;
}

function fmtRuleAmounts(r: TariffRule, currency: string): string {
  if (r.ruleType === 'flat_rate') {
    return `Flat ${currency} ${(r.flatAmountCents / 100).toFixed(2)}`;
  }
  const fb = `First ${r.firstBlockMinutes}m ${currency} ${(r.firstBlockAmountCents / 100).toFixed(2)}`;
  const sb = `next ${r.subsequentBlockMinutes}m ${currency} ${(r.subsequentBlockAmountCents / 100).toFixed(2)}`;
  return `${fb}, ${sb}`;
}

/** Does this rule cover `now`? Mirrors the matching in parking-flow.ts so
 *  the highlight stays consistent with the actual fee math. */
function ruleMatchesNow(r: TariffRule): boolean {
  const now = new Date();
  // Evaluate in the app timezone (GMT+8) so this highlight matches the fee
  // calculator, whose main process is pinned to Asia/Kuala_Lumpur. Using the
  // host clock (getHours/getDay) or the UTC date would drift the "active now"
  // rule by up to 8 hours.
  const date = dateInAppTz(now); // YYYY-MM-DD in GMT+8
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  const time = now.toLocaleTimeString('en-GB', {
    timeZone: APP_TZ, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  if (r.validFrom && r.validFrom > date) return false;
  if (r.validTo && r.validTo < date) return false;
  if (Array.isArray(r.daysOfWeek) && r.daysOfWeek.length > 0 && !r.daysOfWeek.includes(weekday)) return false;
  const from = r.timeFrom;
  const to = r.timeTo === '23:59:59' || r.timeTo === '23:59:00' ? '24:00:00' : r.timeTo;
  if (from === to) return true;
  if (from < to) return time >= from && time < to;
  return time >= from || time < to;
}

function RulesTable({ policy, compact = false }: { policy: RatePolicy; compact?: boolean }) {
  const rules = [...(policy.rules ?? [])].sort((a, b) => b.priority - a.priority);

  // Find the single "active now" rule (highest-priority match amongst
  // is_active=true rules). Mirrors the exit-flow rule selection — pricing is
  // scoped by day/time/date only, no vehicle-type dimension.
  const activeIds = new Set<string>();
  const match = rules.find((r) => r.isActive !== false && ruleMatchesNow(r));
  if (match) activeIds.add(match.ruleId);

  return (
    <div className="space-y-3">
      {/* Setup & Rules summary — mirrors the cloud Setup & Rules tab so the
          on-prem operator sees the same context (grace, daily reset, etc). */}
      <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-[11px] text-gray-700 space-y-0.5">
        <div className="flex flex-wrap gap-x-4 gap-y-0.5">
          <span><span className="text-gray-500">Grace:</span> <span className="font-mono">{policy.freeMinutes} min</span></span>
          {policy.graceExceededBehavior && (
            <span><span className="text-gray-500">After grace:</span> <span className="font-mono">{policy.graceExceededBehavior.replace(/_/g, ' ')}</span></span>
          )}
          <span><span className="text-gray-500">Daily reset:</span>{' '}
            {policy.cutoffEnabled
              ? <span className="font-mono">{(policy.cutoffTime ?? '').slice(0, 5) || '00:00'} → {policy.cutoffBehavior?.replace(/_/g, ' ') ?? 'restart'}</span>
              : <span className="text-gray-400">off</span>}
          </span>
          {policy.cutoffEnabled && policy.cutoffBehavior === 'new_day_fixed_fee' && policy.newDayFixedFeeCents !== null && (
            <span><span className="text-gray-500">New-day fee:</span> <span className="font-mono">{policy.currency} {(policy.newDayFixedFeeCents / 100).toFixed(2)}</span></span>
          )}
          <span><span className="text-gray-500">Daily cap:</span>{' '}
            {(policy.policyDailyCapCents ?? 0) > 0
              ? <span className="font-mono">{policy.currency} {((policy.policyDailyCapCents ?? 0) / 100).toFixed(2)}</span>
              : <span className="text-gray-400">no cap</span>}
          </span>
        </div>
      </div>

      <div>
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="w-full text-[12px]">
              <thead className="bg-gray-50 text-[10px] uppercase tracking-widest text-gray-500">
                <tr>
                  <th className="text-left px-2 py-1.5 font-bold">Rule</th>
                  <th className="text-left px-2 py-1.5 font-bold">Days</th>
                  <th className="text-left px-2 py-1.5 font-bold">Time</th>
                  <th className="text-left px-2 py-1.5 font-bold">Type</th>
                  <th className="text-left px-2 py-1.5 font-bold">Amount</th>
                  {!compact && <th className="text-right px-2 py-1.5 font-bold">Pri.</th>}
                  {!compact && <th className="text-right px-2 py-1.5 font-bold">Cap</th>}
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => {
                  const active = activeIds.has(r.ruleId);
                  const disabled = r.isActive === false;
                  return (
                    <tr key={r.ruleId} className={`border-t border-gray-100 ${active ? 'bg-emerald-50' : ''} ${disabled ? 'opacity-50' : ''}`}>
                      <td className="px-2 py-1.5">
                        <div className="font-semibold inline-flex items-center gap-1.5">
                          {r.name}
                          {active && <span className="rounded-full bg-emerald-600 text-white text-[9px] font-bold uppercase px-1.5 py-0.5">Active now</span>}
                          {disabled && <span className="rounded-full bg-gray-200 text-gray-600 text-[9px] font-bold uppercase px-1.5 py-0.5">Off</span>}
                          {r.isOvernight && <span className="rounded-full bg-indigo-100 text-indigo-700 text-[9px] font-bold uppercase px-1.5 py-0.5">Overnight</span>}
                        </div>
                      </td>
                      <td className="px-2 py-1.5">{fmtDays(r.daysOfWeek)}</td>
                      <td className="px-2 py-1.5 font-mono"><Clock size={10} className="inline mr-1 text-gray-400" />{fmtTimeRange(r.timeFrom, r.timeTo)}</td>
                      <td className="px-2 py-1.5">
                        <span className={`rounded-full text-[10px] font-bold uppercase px-1.5 py-0.5 ${r.ruleType === 'flat_rate' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'}`}>
                          {r.ruleType === 'flat_rate' ? 'Flat' : 'Block hourly'}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 font-mono text-gray-700">{fmtRuleAmounts(r, policy.currency)}</td>
                      {!compact && <td className="px-2 py-1.5 text-right font-mono">{r.priority}</td>}
                      {!compact && <td className="px-2 py-1.5 text-right font-mono">{r.dailyCapCents > 0 ? `${policy.currency} ${(r.dailyCapCents / 100).toFixed(2)}` : '—'}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
      </div>
      <p className="text-[10px] text-gray-400">
        Rules are read-only here — edit them in qparking SaaS (Pricing &amp; Tariffs). The local exit-flow picks the highest-priority rule matching the session's moment.
      </p>

      <TestPrice policy={policy} />
    </div>
  );
}

/** Local datetime → "YYYY-MM-DDTHH:mm" for a <input type="datetime-local">. */
function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * "Test price" — mirrors the qparking SaaS "Test a price" simulator. Enter an
 * entry + exit, see the exact fee THIS rate plan would charge locally. Use it
 * to confirm the on-prem gate agrees with the cloud for the same inputs.
 */
function TestPrice({ policy }: { policy: RatePolicy }) {
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60_000);
  const [entry, setEntry] = useState(toLocalInput(hourAgo));
  const [exit, setExit] = useState(toLocalInput(now));
  const [res, setRes] = useState<{ feeCents: number; durationMinutes: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true); setErr(null); setRes(null);
    try {
      // datetime-local has no timezone; the ISO the input yields (":ss" absent)
      // is parsed as LOCAL time by the main process — same wall-clock the gate
      // and the cloud simulator use.
      const r = await window.bridge.simulateRatePolicyFee({ policyId: policy.policyId, entry, exit });
      if (!r.ok) { setErr(r.error ?? 'calc_failed'); return; }
      setRes({ feeCents: r.feeCents ?? 0, durationMinutes: r.durationMinutes ?? 0 });
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50/50 p-3">
      <div className="flex items-center gap-1.5 mb-2 text-[11px] font-bold uppercase tracking-wider text-blue-800">
        <Calculator size={12} /> Test price
      </div>
      <div className="flex flex-col sm:flex-row sm:items-end gap-2">
        <label className="text-[11px] text-gray-600 flex-1">
          <span className="block mb-0.5">Entry</span>
          <input type="datetime-local" value={entry} onChange={(e) => setEntry(e.target.value)}
            className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs font-mono" />
        </label>
        <label className="text-[11px] text-gray-600 flex-1">
          <span className="block mb-0.5">Exit</span>
          <input type="datetime-local" value={exit} onChange={(e) => setExit(e.target.value)}
            className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs font-mono" />
        </label>
        <button type="button" onClick={run} disabled={busy}
          className="inline-flex items-center justify-center gap-1.5 h-8 px-4 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold disabled:opacity-50">
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Calculator size={13} />} Calculate
        </button>
      </div>

      {err && (
        <div className="mt-2 text-[11px] text-red-700">{err === 'exit_before_entry' ? 'Exit must be after entry.' : err}</div>
      )}
      {res && (
        <div className="mt-2 flex items-baseline gap-3">
          <div>
            <div className="text-[9px] font-bold uppercase tracking-widest text-gray-500">Customer pays</div>
            <div className="text-2xl font-black tabular-nums text-blue-700">{fmtCents(res.feeCents, policy.currency)}</div>
          </div>
          <div className="text-[11px] text-gray-500">{res.durationMinutes} min · {policy.policyName}</div>
        </div>
      )}
      <p className="mt-2 text-[10px] text-gray-400">
        Enter the same entry/exit in qparking → Parking Rates → “Test a price” for this plan — the amounts should match exactly.
      </p>
    </div>
  );
}
