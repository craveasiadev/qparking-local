/**
 * Sync layer between this on-prem server and the qparking SaaS cloud.
 *
 * Pulls scope+rate config, active passes and parking spaces from the cloud
 * and caches them in SQLite, so the exit flow can compute fees even when the
 * WAN is offline. Also polls for remote gate-open commands and pushes local
 * rate edits back up to the cloud.
 *
 * All HTTP goes through one shared axios client (see `getCloudApi`), built
 * from Settings:
 *   baseURL       = <qparkingBaseUrl>/api/v1/local-server
 *   Authorization = Bearer <qparkingApiKey>
 *
 * If the qparking SaaS isn't configured yet, every sync returns
 * `qparking_not_configured` and the app still works — operators can fill the
 * scopes table manually via the Scopes page in the UI.
 */
import {
  upsertScope,
  upsertSite,
  replaceActivePassesForScope,
  listScopes,
  replaceParkingSpaces,
  pruneStaleScopes,
} from './db';
import { getCloudApi, isHttpStatus, describeRequestError } from './cloud-api';
import type { ScopeRate, TariffRule, ActivePass, ParkingSpace, Site } from '../../shared/types';


export interface SyncResult { ok: boolean; fetched: number; error?: string; }

/** The SaaS wraps every list payload in a `{ data: [...] }` envelope. */
interface CloudListBody { data?: any[] }

const NOT_CONFIGURED: SyncResult = { ok: false, fetched: 0, error: 'qparking_not_configured' };

/** Convert any thrown error (HTTP failure, timeout, DNS, …) into a SyncResult. */
function toFailedSyncResult(error: any): SyncResult {
  return { ok: false, fetched: 0, error: describeRequestError(error) };
}

// ─── API row → local type mapping ────────────────────────────────────────────

/** Map the `rules` array on a cloud scope row to local TariffRule objects. */
function mapApiRowToTariffRules(scopeRow: any): TariffRule[] {
  if (!Array.isArray(scopeRow.rules)) return [];
  return scopeRow.rules
    .map((ruleRow: any): TariffRule => ({
      ruleId: String(ruleRow.rule_id ?? ruleRow.ruleId ?? ''),
      name: String(ruleRow.name ?? ''),
      priority: Number(ruleRow.priority ?? 0),
      daysOfWeek: Array.isArray(ruleRow.days_of_week ?? ruleRow.daysOfWeek)
        ? (ruleRow.days_of_week ?? ruleRow.daysOfWeek).map((day: any) => Number(day))
        : null,
      timeFrom: String(ruleRow.time_from ?? ruleRow.timeFrom ?? '00:00:00'),
      timeTo: String(ruleRow.time_to ?? ruleRow.timeTo ?? '23:59:59'),
      validFrom: ruleRow.valid_from ?? ruleRow.validFrom ?? null,
      validTo: ruleRow.valid_to ?? ruleRow.validTo ?? null,
      ruleType: (ruleRow.rule_type ?? ruleRow.ruleType ?? 'block_hourly') as 'flat_rate' | 'block_hourly',
      flatAmountCents: Number(ruleRow.flat_amount_cents ?? 0),
      firstBlockAmountCents: Number(ruleRow.first_block_amount_cents ?? 0),
      firstBlockMinutes: Number(ruleRow.first_block_minutes ?? 60),
      subsequentBlockAmountCents: Number(ruleRow.subsequent_block_amount_cents ?? 0),
      subsequentBlockMinutes: Number(ruleRow.subsequent_block_minutes ?? 60),
      dailyCapCents: Number(ruleRow.daily_cap_cents ?? 0),
      isOvernight: !!ruleRow.is_overnight,
      // Missing flag means the rule is active.
      isActive: ruleRow.is_active == null ? true : !!ruleRow.is_active,
    }))
    .filter((rule: TariffRule) => !!rule.ruleId);
}

/** Map one cloud scope row (snake_case API fields) to a local ScopeRate. */
function mapApiRowToScope(scopeRow: any, fetchedAt: string): ScopeRate {
  const scopeId = String(scopeRow.scope_id ?? scopeRow.scopeId ?? scopeRow.id ?? '');
  return {
    scopeId,
    scopeName: String(scopeRow.scope_name ?? scopeRow.scopeName ?? scopeRow.name ?? scopeId),
    freeMinutes: Number(scopeRow.grace_minutes ?? scopeRow.free_minutes ?? scopeRow.freeMinutes ?? 0),
    firstBlockCents: Number(scopeRow.first_block_cents ?? scopeRow.firstBlockCents ?? 0),
    perBlockCents: Number(scopeRow.per_block_cents ?? scopeRow.perBlockCents ?? 0),
    blockMinutes: Number(scopeRow.block_minutes ?? scopeRow.blockMinutes ?? 60),
    dailyCapCents: Number(scopeRow.daily_cap_cents ?? scopeRow.dailyCapCents ?? 0),
    currency: String(scopeRow.currency ?? 'MYR'),
    fetchedAt,
    rules: mapApiRowToTariffRules(scopeRow),
    policyId: scopeRow.policy_id ?? null,
    policyName: scopeRow.policy_name ?? null,
    policyDescription: scopeRow.policy_description ?? null,
    isSiteDefault: !!scopeRow.is_site_default,
    graceExceededBehavior: scopeRow.grace_exceeded_behavior ?? null,
    cutoffEnabled: !!scopeRow.cutoff_enabled,
    cutoffTime: scopeRow.cutoff_time ?? null,
    cutoffBehavior: scopeRow.cutoff_behavior ?? null,
    newDayFixedFeeCents: scopeRow.new_day_fixed_fee_cents != null
      ? Number(scopeRow.new_day_fixed_fee_cents)
      : null,
    rateBasis: (scopeRow.rate_basis ?? scopeRow.rateBasis ?? null) as any,
    flatMultiRate: (scopeRow.flat_multi_rate ?? scopeRow.flatMultiRate ?? null) as any,
    firstBlockOncePerEntry: !!(scopeRow.first_block_once_per_entry ?? scopeRow.firstBlockOncePerEntry ?? false),
    policyDailyCapCents: (scopeRow.policy_daily_cap_cents ?? scopeRow.policyDailyCapCents) != null
      ? Number(scopeRow.policy_daily_cap_cents ?? scopeRow.policyDailyCapCents)
      : null,
  };
}

// ─── pull sync: scopes / passes / spaces ─────────────────────────────────────

/** Pull scope+rate config from the cloud and upsert into the local cache. */
export async function syncScopes(): Promise<SyncResult> {
  const cloud = getCloudApi();
  if (!cloud) return NOT_CONFIGURED;
  try {
    const { data: responseBody } = await cloud.get<CloudListBody>('/scopes');
    const scopeRows = responseBody.data ?? [];
    const fetchedAt = new Date().toISOString();

    let savedCount = 0;
    for (const scopeRow of scopeRows) {
      const scope = mapApiRowToScope(scopeRow, fetchedAt);
      if (!scope.scopeId) continue;
      upsertScope(scope);
      savedCount++;
    }

    // Drop local scopes the cloud no longer returns.
    try {
      const cloudScopeIds = scopeRows.map((scopeRow: any) => String(scopeRow.scope_id ?? scopeRow.scopeId ?? scopeRow.id ?? ''))
        .filter(Boolean);
      pruneStaleScopes(cloudScopeIds);
    } catch { /* pruning is best-effort; sync loop retries next tick */ }

    return { ok: true, fetched: savedCount };
  } catch (error) {
    return toFailedSyncResult(error);
  }
}

/**
 * Pull the active pass roster for each cached scope. The gate uses this
 * to skip charging plates that have a paid / VIP / corporate / staff pass.
 * An empty roster is a legitimate result (no active passes), not a failure.
 */
export async function syncPasses(): Promise<SyncResult> {
  const cloud = getCloudApi();
  if (!cloud) return NOT_CONFIGURED;
  try {
    const { data: responseBody } = await cloud.get<CloudListBody>('/passes');
    const passRows = responseBody.data ?? [];
    const fetchedAt = new Date().toISOString();

    // Group passes by scope so we can do a single replace-all per scope.
    const passesByScopeId = new Map<string, ActivePass[]>();
    for (const passRow of passRows) {
      const scopeId = String(passRow.site_id ?? passRow.scope_id ?? '');
      const plateNumber = String(passRow.plate_number ?? '');
      if (!scopeId || !plateNumber) continue;

      const pass: ActivePass = {
        passId: String(passRow.pass_id ?? passRow.id ?? ''),
        scopeId,
        plateNumber,
        passType: String(passRow.pass_type ?? 'monthly'),
        status: String(passRow.status ?? 'active'),
        startDate: passRow.start_date ?? null,
        endDate: passRow.end_date ?? null,
        isFree: !!(passRow.is_free ?? false),
        spaceNumber: passRow.space_number ?? null,
        fetchedAt,
      };
      if (!passesByScopeId.has(scopeId)) passesByScopeId.set(scopeId, []);
      passesByScopeId.get(scopeId)!.push(pass);
    }

    // Refresh every scope we know about — including scopes that returned
    // zero passes (so a revoked pass actually disappears from local cache).
    for (const scope of listScopes()) {
      replaceActivePassesForScope(scope.scopeId, passesByScopeId.get(scope.scopeId) ?? []);
    }
    return { ok: true, fetched: passRows.length };
  } catch (error) {
    // 404 means an older qparking SaaS without the endpoint — gracefully no-op.
    if (isHttpStatus(error, 404)) return { ok: true, fetched: 0 };
    return toFailedSyncResult(error);
  }
}

/** Map the GET /site payload (snake_case SiteResource) to the local Site. */
function mapApiRowToSite(siteRow: any): Site {
  return {
    id: String(siteRow.id ?? ''),
    companyId: siteRow.company_id ?? null,
    name: String(siteRow.name ?? ''),
    address: siteRow.address ?? null,
    totalSpaces: Number(siteRow.total_spaces ?? 0),
    occupiedSpaces: Number(siteRow.occupied_spaces ?? 0),
    revenueToday: Number(siteRow.revenue_today ?? 0),
    status: (siteRow.status ?? 'active') as Site['status'],
    alarmCount: Number(siteRow.alarm_count ?? 0),
    contactPerson: siteRow.contact_person ?? null,
    telephone: siteRow.telephone ?? null,
    fax: siteRow.fax ?? null,
    country: siteRow.country ?? null,
    email: siteRow.email ?? null,
    parkingSiteType: siteRow.parking_site_type ?? null,
    logoUrl: siteRow.logo_url ?? null,
  };
}

/**
 * Pull THE site this install's API key belongs to (GET /site) and cache it
 * in the local `sites` table. The site is the root object — its identity,
 * occupancy and contact details are mirrored here for offline display.
 */
export async function syncSite(): Promise<SyncResult> {
  const cloud = getCloudApi();
  if (!cloud) return NOT_CONFIGURED;
  try {
    const { data: responseBody } = await cloud.get<{ data?: any }>('/site');
    const siteRow = responseBody?.data;
    if (!siteRow?.id) return { ok: false, fetched: 0, error: 'empty_site_payload' };
    upsertSite(mapApiRowToSite(siteRow));
    return { ok: true, fetched: 1 };
  } catch (error) {
    // 404 means an older qparking SaaS without the endpoint — gracefully no-op.
    if (isHttpStatus(error, 404)) return { ok: true, fetched: 0 };
    return toFailedSyncResult(error);
  }
}

/**
 * Pull the canonical parking-space inventory from the cloud. Read-only
 * mirror — the operator manages spaces in qparking SaaS, the on-prem app
 * just reflects them for visibility.
 */
export async function syncSpaces(): Promise<SyncResult> {
  const cloud = getCloudApi();
  if (!cloud) return NOT_CONFIGURED;
  try {
    const { data: responseBody } = await cloud.get<CloudListBody>('/spaces');
    const fetchedAt = new Date().toISOString();

    const spaces: ParkingSpace[] = (responseBody.data ?? [])
      .map((spaceRow: any): ParkingSpace => ({
        id: String(spaceRow.id ?? ''),
        building: spaceRow.building ?? null,
        level: spaceRow.level ?? null,
        zone: spaceRow.zone ?? null,
        spaceNumber: spaceRow.space_number ?? null,
        spaceCode: spaceRow.space_code ?? null,
        status: String(spaceRow.status ?? 'available'),
        customerName: spaceRow.customer_name ?? null,
        vehiclePlate: spaceRow.vehicle_plate ?? null,
        passType: spaceRow.pass_type ?? null,
        passId: spaceRow.pass_id ?? null,
        startDate: spaceRow.start_date ?? null,
        endDate: spaceRow.end_date ?? null,
        notes: spaceRow.notes ?? null,
        fetchedAt,
      }))
      .filter((space) => !!space.id);

    replaceParkingSpaces(spaces);
    return { ok: true, fetched: spaces.length };
  } catch (error) {
    // 404 means an older qparking SaaS without the endpoint — gracefully no-op.
    if (isHttpStatus(error, 404)) return { ok: true, fetched: 0 };
    return toFailedSyncResult(error);
  }
}

/** Run all three pulls in parallel; one failing doesn't block the others. */
export async function syncAll(): Promise<{
  scopes: SyncResult;
  passes: SyncResult;
  spaces: SyncResult;
  site: SyncResult;
}> {
  const [scopes, passes, spaces, site] = await Promise.all([
    syncScopes().catch(toFailedSyncResult),
    syncPasses().catch(toFailedSyncResult),
    syncSpaces().catch(toFailedSyncResult),
    syncSite().catch(toFailedSyncResult),
  ]);
  return { scopes, passes, spaces, site };
}

export async function handleDebug(): Promise<any> {
  return syncSite();
}

// ─── background sync timer ───────────────────────────────────────────────────

let backgroundSyncTimer: NodeJS.Timeout | null = null;

/** Run every pull, swallowing errors — the timer retries next tick. */
function runFullSyncQuietly(): void {
  syncSite().catch(() => null);
  syncScopes().catch(() => null);
  syncPasses().catch(() => null);
  syncSpaces().catch(() => null);
}

/**
 * Background sync. Default cadence: every 60 seconds — operators expect a
 * rate edit in qparking SaaS to apply at the gate within ~1 minute, not the
 * ~60 minutes the legacy interval enforced. Cheap (a handful of GETs),
 * self-healing, no operator action needed.
 */
export function startBackgroundSync(intervalMs = 60_000): void {
  stopBackgroundSync();
  backgroundSyncTimer = setInterval(runFullSyncQuietly, intervalMs);
  // Kick one off at startup, fire-and-forget.
  runFullSyncQuietly();
}

export function stopBackgroundSync(): void {
  if (backgroundSyncTimer) clearInterval(backgroundSyncTimer);
  backgroundSyncTimer = null;
}

// ─── remote gate-open command poll ───────────────────────────────────────────
// Independent timer running at 20-second cadence. Slower than 20s would make
// the operator wait too long between clicking "Open Barrier" in the cloud UI
// and the physical gate moving; faster is unnecessary chatter over WAN.
//
// One-shot flow per command: fetch pending → dispatch to gate handler → ack.
// Errors during dispatch are logged but the ack still fires (with a note)
// so the same command doesn't get processed twice on the next poll.

const GATE_REQUEST_TIMEOUT_MS = 8_000;

let gateCommandPollTimer: NodeJS.Timeout | null = null;

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
let gateOpenHandler: ((command: PendingGateCommand) => Promise<{ ok: boolean; note?: string }>) | null = null;

export function setGateOpenHandler(handler: typeof gateOpenHandler): void {
  gateOpenHandler = handler;
}

async function pollGateCommands(): Promise<void> {
  const cloud = getCloudApi();
  if (!cloud) return;
  try {
    const { data: responseBody } = await cloud.get<{ data?: PendingGateCommand[] }>(
      '/gate-commands/pending',
      { timeout: GATE_REQUEST_TIMEOUT_MS },
    );

    for (const command of responseBody.data ?? []) {
      const dispatchOutcome = gateOpenHandler
        ? await gateOpenHandler(command).catch((error: any) => ({
            ok: false,
            note: `dispatch error: ${error?.message ?? error}`,
          }))
        : { ok: false, note: 'no gate handler registered' };

      // Ack regardless of dispatch success — otherwise the same command
      // gets re-run every 20s indefinitely.
      const ackNote = dispatchOutcome.note ?? (dispatchOutcome.ok ? 'dispatched' : 'dispatch failed');
      try {
        await cloud.post(
          `/gate-commands/${command.id}/ack`,
          { note: ackNote },
          { timeout: GATE_REQUEST_TIMEOUT_MS },
        );
      } catch { /* ack failure is fine — cloud will expire the row after 5m */ }
    }
  } catch { /* poll failure is transient — retry on next tick */ }
}

/** Start the 20s gate-open command poller. Runs alongside the main scope/pass
 *  sync but on its own timer so a slow scope pull doesn't block gate opens. */
export function startGatePoll(intervalMs = 20_000): void {
  stopGatePoll();
  gateCommandPollTimer = setInterval(() => { void pollGateCommands(); }, intervalMs);
  // Also fire once immediately so a pending command from just before boot
  // doesn't wait a full interval.
  void pollGateCommands();
}

export function stopGatePoll(): void {
  if (gateCommandPollTimer) clearInterval(gateCommandPollTimer);
  gateCommandPollTimer = null;
}

// ─── push: rate edits up to the SaaS ─────────────────────────────────────────

/**
 * Push a rate edit up to the qparking SaaS (PUT /scopes/rate). On success
 * we immediately re-pull the scopes so the cached row reflects whatever
 * the SaaS canonicalised (and the rest of the app sees the new fee math).
 */
export async function pushScopeRate(rateInput: {
  firstBlockCents: number;
  perBlockCents: number;
  blockMinutes: number;
  freeMinutes: number;
  dailyCapCents: number;
}): Promise<SyncResult> {
  const cloud = getCloudApi();
  if (!cloud) return NOT_CONFIGURED;
  try {
    await cloud.put('/scopes/rate', {
      first_block_cents: rateInput.firstBlockCents,
      per_block_cents: rateInput.perBlockCents,
      block_minutes: rateInput.blockMinutes,
      free_minutes: rateInput.freeMinutes,
      daily_cap_cents: rateInput.dailyCapCents,
    });
    // Re-pull so the local cache reflects whatever the SaaS canonicalised.
    return await syncScopes();
  } catch (error) {
    return toFailedSyncResult(error);
  }
}
