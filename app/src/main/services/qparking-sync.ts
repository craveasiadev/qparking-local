/**
 * Pull scope+rate config from the qparking SaaS and cache it locally so the
 * exit flow can compute fees even if the WAN is offline.
 *
 * Expected endpoint (qparking backend should expose this):
 *   GET /api/local-server/scopes
 *   Authorization: Bearer <apiKey>
 *   →  { data: ScopeRate[] }
 *
 * If the qparking team hasn't surfaced this endpoint yet, the local server
 * still works — operators just have to fill the scopes table manually via the
 * Scopes page in the UI.
 */
import {
  getSettings, upsertScope, replaceActivePassesForScope, listScopes,
  replaceParkingSpaces, replaceVehicleTypes, replaceVehicleGroups,
  pruneStaleScopes,
} from './db';
import type { ScopeRate, TariffRule, ActivePass, ParkingSpace, VehicleType, VehicleGroup } from '../../shared/types';

export interface SyncResult { ok: boolean; fetched: number; error?: string; }

let syncTimer: NodeJS.Timeout | null = null;

export async function syncScopes(): Promise<SyncResult> {
  const s = getSettings();
  if (!s.qparkingBaseUrl || !s.qparkingApiKey) {
    return { ok: false, fetched: 0, error: 'qparking_not_configured' };
  }
  // qparking's API is prefixed /api/v1/. The local-server endpoint lives
  // under that prefix and is bearer-token authed (no sanctum session).
  const url = `${s.qparkingBaseUrl.replace(/\/+$/, '')}/api/v1/local-server/scopes`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${s.qparkingApiKey}` } });
    if (!res.ok) {
      return { ok: false, fetched: 0, error: `http_${res.status}` };
    }
    const body = await res.json() as { data?: any[] };
    const fetchedAt = new Date().toISOString();
    let count = 0;
    for (const row of body.data ?? []) {
      const scopeId = String(row.scope_id ?? row.scopeId ?? row.id ?? '');
      if (!scopeId) continue;
      const rules: TariffRule[] = Array.isArray(row.rules)
        ? row.rules.map((r: any) => ({
            ruleId: String(r.rule_id ?? r.ruleId ?? ''),
            name: String(r.name ?? ''),
            priority: Number(r.priority ?? 0),
            vehicleType: r.vehicle_type ?? r.vehicleType ?? null,
            daysOfWeek: Array.isArray(r.days_of_week ?? r.daysOfWeek)
              ? (r.days_of_week ?? r.daysOfWeek).map((n: any) => Number(n))
              : null,
            timeFrom: String(r.time_from ?? r.timeFrom ?? '00:00:00'),
            timeTo: String(r.time_to ?? r.timeTo ?? '23:59:59'),
            validFrom: r.valid_from ?? r.validFrom ?? null,
            validTo: r.valid_to ?? r.validTo ?? null,
            ruleType: (r.rule_type ?? r.ruleType ?? 'block_hourly') as 'flat_rate' | 'block_hourly',
            flatAmountCents: Number(r.flat_amount_cents ?? 0),
            firstBlockAmountCents: Number(r.first_block_amount_cents ?? 0),
            firstBlockMinutes: Number(r.first_block_minutes ?? 60),
            subsequentBlockAmountCents: Number(r.subsequent_block_amount_cents ?? 0),
            subsequentBlockMinutes: Number(r.subsequent_block_minutes ?? 60),
            dailyCapCents: Number(r.daily_cap_cents ?? 0),
            isOvernight: !!r.is_overnight,
            // 2026-06-22: per-rule activation flag. Older cloud builds
            // didn't send this field — default to active so a missing key
            // doesn't silently disable every rule.
            isActive: r.is_active === undefined || r.is_active === null
              ? true
              : !!r.is_active,
          })).filter((r: TariffRule) => !!r.ruleId)
        : [];

      const scope: ScopeRate = {
        scopeId,
        scopeName: String(row.scope_name ?? row.scopeName ?? row.name ?? scopeId),
        freeMinutes: Number(row.grace_minutes ?? row.free_minutes ?? row.freeMinutes ?? 0),
        firstBlockCents: Number(row.first_block_cents ?? row.firstBlockCents ?? 0),
        perBlockCents: Number(row.per_block_cents ?? row.perBlockCents ?? 0),
        blockMinutes: Number(row.block_minutes ?? row.blockMinutes ?? 60),
        dailyCapCents: Number(row.daily_cap_cents ?? row.dailyCapCents ?? 0),
        currency: String(row.currency ?? 'MYR'),
        fetchedAt,
        rules,
        policyId: row.policy_id ?? null,
        policyName: row.policy_name ?? null,
        policyDescription: row.policy_description ?? null,
        isSiteDefault: !!row.is_site_default,
        graceExceededBehavior: row.grace_exceeded_behavior ?? null,
        cutoffEnabled: !!row.cutoff_enabled,
        cutoffTime: row.cutoff_time ?? null,
        cutoffBehavior: row.cutoff_behavior ?? null,
        newDayFixedFeeCents: row.new_day_fixed_fee_cents !== undefined && row.new_day_fixed_fee_cents !== null
          ? Number(row.new_day_fixed_fee_cents)
          : null,
      };
      upsertScope(scope);
      count++;
    }
    // Prune scopes whose policy no longer exists (or was deactivated) on
    // the cloud side. Without this a deleted RatePolicy would stay cached
    // locally forever and lanes bound to it would still price sessions
    // under a policy that's been retired.
    try {
      const seenIds = (body.data ?? [])
        .map((row: any) => String(row.scope_id ?? row.scopeId ?? row.id ?? ''))
        .filter(Boolean);
      pruneStaleScopes(seenIds);
    } catch { /* pruning is best-effort; sync loop retries next tick */ }
    return { ok: true, fetched: count };
  } catch (e: any) {
    return { ok: false, fetched: 0, error: e.message ?? String(e) };
  }
}

/**
 * Pull the active pass roster for each cached scope. The gate uses this
 * to skip charging plates that have a paid / VIP / corporate / staff pass.
 * Empty roster is a legitimate result (no active passes), not a sync failure.
 */
export async function syncPasses(): Promise<SyncResult> {
  const s = getSettings();
  if (!s.qparkingBaseUrl || !s.qparkingApiKey) {
    return { ok: false, fetched: 0, error: 'qparking_not_configured' };
  }
  const url = `${s.qparkingBaseUrl.replace(/\/+$/, '')}/api/v1/local-server/passes`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${s.qparkingApiKey}` } });
    if (!res.ok) {
      // 404 means older qparking SaaS without the endpoint — gracefully no-op.
      if (res.status === 404) return { ok: true, fetched: 0 };
      return { ok: false, fetched: 0, error: `http_${res.status}` };
    }
    const body = await res.json() as { data?: any[] };
    const rows = body.data ?? [];

    // Group passes by scope so we can do a single replace-all per scope.
    const byScope = new Map<string, ActivePass[]>();
    for (const r of rows) {
      const scopeId = String(r.site_id ?? r.scope_id ?? '');
      const plate = String(r.plate_number ?? '');
      if (!scopeId || !plate) continue;
      const pass: ActivePass = {
        passId: String(r.pass_id ?? r.id ?? ''),
        scopeId,
        plateNumber: plate,
        passType: String(r.pass_type ?? 'monthly'),
        status: String(r.status ?? 'active'),
        startDate: r.start_date ?? null,
        endDate: r.end_date ?? null,
        isFree: !!(r.is_free ?? false),
        spaceNumber: r.space_number ?? null,
        fetchedAt: new Date().toISOString(),
      };
      if (!byScope.has(scopeId)) byScope.set(scopeId, []);
      byScope.get(scopeId)!.push(pass);
    }

    // Refresh every scope we know about — including scopes that returned
    // zero passes (so a revoked pass actually disappears from local cache).
    for (const scope of listScopes()) {
      replaceActivePassesForScope(scope.scopeId, byScope.get(scope.scopeId) ?? []);
    }
    return { ok: true, fetched: rows.length };
  } catch (e: any) {
    return { ok: false, fetched: 0, error: e?.message ?? String(e) };
  }
}

/** Pull the canonical parking-space inventory from the cloud. Read-only
 *  mirror — operator manages spaces in qparking SaaS, the on-prem app
 *  just reflects them for visibility. */
export async function syncSpaces(): Promise<SyncResult> {
  const s = getSettings();
  if (!s.qparkingBaseUrl || !s.qparkingApiKey) {
    return { ok: false, fetched: 0, error: 'qparking_not_configured' };
  }
  const url = `${s.qparkingBaseUrl.replace(/\/+$/, '')}/api/v1/local-server/spaces`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${s.qparkingApiKey}` } });
    if (!res.ok) {
      if (res.status === 404) return { ok: true, fetched: 0 };
      return { ok: false, fetched: 0, error: `http_${res.status}` };
    }
    const body = await res.json() as { data?: any[] };
    const rows: ParkingSpace[] = (body.data ?? []).map((r) => ({
      id: String(r.id ?? ''),
      building: r.building ?? null,
      level: r.level ?? null,
      zone: r.zone ?? null,
      spaceNumber: r.space_number ?? null,
      spaceCode: r.space_code ?? null,
      status: String(r.status ?? 'available'),
      customerName: r.customer_name ?? null,
      vehiclePlate: r.vehicle_plate ?? null,
      passType: r.pass_type ?? null,
      passId: r.pass_id ?? null,
      startDate: r.start_date ?? null,
      endDate: r.end_date ?? null,
      notes: r.notes ?? null,
      fetchedAt: new Date().toISOString(),
    })).filter((s) => !!s.id);
    replaceParkingSpaces(rows);
    return { ok: true, fetched: rows.length };
  } catch (e: any) {
    return { ok: false, fetched: 0, error: e?.message ?? String(e) };
  }
}

/** Pull vehicle type taxonomy from the cloud. */
export async function syncVehicleTypes(): Promise<SyncResult> {
  const s = getSettings();
  if (!s.qparkingBaseUrl || !s.qparkingApiKey) {
    return { ok: false, fetched: 0, error: 'qparking_not_configured' };
  }
  const url = `${s.qparkingBaseUrl.replace(/\/+$/, '')}/api/v1/local-server/vehicle-types`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${s.qparkingApiKey}` } });
    if (!res.ok) {
      if (res.status === 404) return { ok: true, fetched: 0 };
      return { ok: false, fetched: 0, error: `http_${res.status}` };
    }
    const body = await res.json() as { data?: any[] };
    const rows: VehicleType[] = (body.data ?? []).map((r) => ({
      id: String(r.id ?? ''),
      typeName: String(r.type_name ?? ''),
      hourlyRate: r.hourly_rate != null ? Number(r.hourly_rate) : null,
      dailyRate: r.daily_rate != null ? Number(r.daily_rate) : null,
      monthlyRate: r.monthly_rate != null ? Number(r.monthly_rate) : null,
      groupName: r.group_name ?? null,
      fetchedAt: new Date().toISOString(),
    })).filter((t) => !!t.id);
    replaceVehicleTypes(rows);
    return { ok: true, fetched: rows.length };
  } catch (e: any) {
    return { ok: false, fetched: 0, error: e?.message ?? String(e) };
  }
}

/** Pull vehicle group taxonomy from the cloud. */
export async function syncVehicleGroups(): Promise<SyncResult> {
  const s = getSettings();
  if (!s.qparkingBaseUrl || !s.qparkingApiKey) {
    return { ok: false, fetched: 0, error: 'qparking_not_configured' };
  }
  const url = `${s.qparkingBaseUrl.replace(/\/+$/, '')}/api/v1/local-server/vehicle-groups`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${s.qparkingApiKey}` } });
    if (!res.ok) {
      if (res.status === 404) return { ok: true, fetched: 0 };
      return { ok: false, fetched: 0, error: `http_${res.status}` };
    }
    const body = await res.json() as { data?: any[] };
    const rows: VehicleGroup[] = (body.data ?? []).map((r) => ({
      id: String(r.id ?? ''),
      name: String(r.name ?? ''),
      fetchedAt: new Date().toISOString(),
    })).filter((g) => !!g.id);
    replaceVehicleGroups(rows);
    return { ok: true, fetched: rows.length };
  } catch (e: any) {
    return { ok: false, fetched: 0, error: e?.message ?? String(e) };
  }
}

/** Background sync. Default cadence: every 60 seconds — operators expect a
 *  rate edit in qparking SaaS to apply at the gate within ~1 minute, not the
 *  ~60 minutes the legacy interval enforced. Cheap (a handful of GETs),
 *  self-healing, no operator action needed.
 */
export function startBackgroundSync(intervalMs = 60_000) {
  stopBackgroundSync();
  syncTimer = setInterval(() => {
    syncScopes().catch(() => null);
    syncPasses().catch(() => null);
    syncSpaces().catch(() => null);
    syncVehicleTypes().catch(() => null);
    syncVehicleGroups().catch(() => null);
  }, intervalMs);
  // Kick one off at startup, fire-and-forget.
  syncScopes().catch(() => null);
  syncPasses().catch(() => null);
  syncSpaces().catch(() => null);
  syncVehicleTypes().catch(() => null);
  syncVehicleGroups().catch(() => null);
}

export function stopBackgroundSync() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
}

// ─── remote gate-open command poll ─────────────────────────────────────────
// Independent timer running at 20-second cadence. Slower than 20s would make
// the operator wait too long between clicking "Open Barrier" in the cloud UI
// and the physical gate moving; faster is unnecessary chatter over WAN.
//
// One-shot flow per command: fetch pending → dispatch to gate handler → ack.
// Errors during dispatch are logged but the ack still fires (with a note)
// so the same command doesn't get processed twice on the next poll.

let gatePollTimer: NodeJS.Timeout | null = null;

interface PendingGateCommand {
  id: string;
  site_id: string;
  /** Cloud's own camera UUID — meaningless to local (which uses int PKs). */
  camera_id: string | null;
  /** The `external_id` cloud stored when local first pushed the camera up
   *  (currently formatted `local-{localId}`). This is the value local uses
   *  to look up which local camera → which local lane to target. */
  camera_external_id: string | null;
  /** Cloud-side lane UUID. Populated once lane sync (piece 2) is live. */
  lane_id: string | null;
  reason: string | null;
  requested_at: string;
}

/** Callback the main process registers so gate open dispatch stays out of
 *  this file (which is otherwise purely HTTP/sync). Set via
 *  `setGateOpenHandler()` at boot. */
let gateOpenHandler: ((cmd: PendingGateCommand) => Promise<{ ok: boolean; note?: string }>) | null = null;

export function setGateOpenHandler(fn: typeof gateOpenHandler): void {
  gateOpenHandler = fn;
}

async function pollGateCommands(): Promise<void> {
  const s = getSettings();
  if (!s.qparkingBaseUrl || !s.qparkingApiKey) return;
  const base = s.qparkingBaseUrl.replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/api/v1/local-server/gate-commands/pending`, {
      headers: { Authorization: `Bearer ${s.qparkingApiKey}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return;
    const body = await res.json() as { data?: PendingGateCommand[] };
    for (const cmd of body.data ?? []) {
      const outcome = gateOpenHandler
        ? await gateOpenHandler(cmd).catch((e: any) => ({ ok: false, note: `dispatch error: ${e?.message ?? e}` }))
        : { ok: false, note: 'no gate handler registered' };
      // Ack regardless of dispatch success — otherwise the same command
      // gets re-run every 20s indefinitely.
      try {
        await fetch(`${base}/api/v1/local-server/gate-commands/${cmd.id}/ack`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${s.qparkingApiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ note: outcome.note ?? (outcome.ok ? 'dispatched' : 'dispatch failed') }),
          signal: AbortSignal.timeout(8_000),
        });
      } catch { /* ack failure is fine — cloud will expire the row after 5m */ }
    }
  } catch { /* poll failure is transient — retry on next tick */ }
}

/** Start the 20s gate-open command poller. Runs alongside the main scope/pass
 *  sync but on its own timer so a slow scope pull doesn't block gate opens. */
export function startGatePoll(intervalMs = 20_000): void {
  stopGatePoll();
  gatePollTimer = setInterval(() => { void pollGateCommands(); }, intervalMs);
  // Also fire once immediately so a pending command from just before boot
  // doesn't wait a full interval.
  void pollGateCommands();
}

export function stopGatePoll(): void {
  if (gatePollTimer) clearInterval(gatePollTimer);
  gatePollTimer = null;
}

/**
 * Push a rate edit up to the qparking SaaS (PUT /scopes/rate). On success
 * we immediately re-pull the scopes so the cached row reflects whatever
 * the SaaS canonicalised (and the rest of the app sees the new fee math).
 */
export async function pushScopeRate(input: {
  firstBlockCents: number;
  perBlockCents: number;
  blockMinutes: number;
  freeMinutes: number;
  dailyCapCents: number;
}): Promise<SyncResult> {
  const s = getSettings();
  if (!s.qparkingBaseUrl || !s.qparkingApiKey) {
    return { ok: false, fetched: 0, error: 'qparking_not_configured' };
  }
  const url = `${s.qparkingBaseUrl.replace(/\/+$/, '')}/api/v1/local-server/scopes/rate`;
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${s.qparkingApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        first_block_cents: input.firstBlockCents,
        per_block_cents:   input.perBlockCents,
        block_minutes:     input.blockMinutes,
        free_minutes:      input.freeMinutes,
        daily_cap_cents:   input.dailyCapCents,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      let msg = `http_${res.status}`;
      try {
        const body: any = await res.json();
        msg = body?.message || body?.error || msg;
      } catch { /* ignore */ }
      return { ok: false, fetched: 0, error: msg };
    }
    // Re-pull so the local cache reflects whatever SaaS canonicalised.
    return await syncScopes();
  } catch (e: any) {
    return { ok: false, fetched: 0, error: e?.message ?? String(e) };
  }
}
