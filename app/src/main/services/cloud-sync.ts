/**
 * Sync layer between this on-prem server and the qparking SaaS cloud.
 *
 * Pulls policy+rate config, active passes and parking spaces from the cloud
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
 * policies table manually via the Parking Policies page in the UI.
 */
import {
  upsertRatePolicy,
  upsertSite,
  replaceAllSeasonPasses,
  replaceParkingSpaces,
  pruneStaleRatePolicies,
  replaceAllActivityLogs,
  getSettings,
  getBoundSiteId,
  setBoundSiteId,
  bindSiteApiKey,
} from './db';
import { getCloudApi, buildCloudApi, isHttpStatus, describeRequestError } from './cloud-api';
import type { RatePolicy, TariffRule, SeasonPass, ParkingSpace, Site } from '../../shared/types';


export interface SyncResult { ok: boolean; fetched: number; error?: string; }

/** The SaaS wraps every list payload in a `{ data: [...] }` envelope. */
interface CloudListBody { data?: any[] }

const NOT_CONFIGURED: SyncResult = { ok: false, fetched: 0, error: 'qparking_not_configured' };

/** Convert any thrown error (HTTP failure, timeout, DNS, …) into a SyncResult. */
function toFailedSyncResult(error: any): SyncResult {
  return { ok: false, fetched: 0, error: describeRequestError(error) };
}

// ─── API row → local type mapping ────────────────────────────────────────────

/** Map the `rules` array on a cloud policy row to local TariffRule objects. */
function mapApiRowToTariffRules(policyRow: any): TariffRule[] {
  if (!Array.isArray(policyRow.rules)) return [];
  return policyRow.rules.map((ruleRow: any): TariffRule => ({
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

/** Map one cloud policy row (snake_case API fields) to a local RatePolicy. */
function mapApiRowToRatePolicy(policyRow: any, fetchedAt: string): RatePolicy {
  const policyId = policyRow.id;
  const rules = mapApiRowToTariffRules(policyRow);

  // The /rate-policies endpoint doesn't send the legacy flat mirrors
  // (first_block_cents …) — those are computed on /scopes from the effective
  // rule. Mirror that here from the highest-priority active rule so the Parking Policies
  // overview shows a real headline rate instead of RM 0.00 + a false "zero
  // rate" warning. Fee math itself always reads rules[] per-moment, so these
  // three fields are display-only.
  const topRule = [...rules].filter((rule) => rule.isActive).sort((a, b) => b.priority - a.priority)[0];

  return {
    policyId,
    policyName: String(policyRow.policy_name ?? policyRow.policyName ?? policyRow.name ?? policyId),
    freeMinutes: Number(policyRow.grace_minutes ?? policyRow.free_minutes ?? policyRow.freeMinutes ?? 0),
    firstBlockCents: Number(policyRow.first_block_cents ?? policyRow.firstBlockCents ?? topRule?.firstBlockAmountCents ?? 0),
    perBlockCents: Number(policyRow.per_block_cents ?? policyRow.perBlockCents ?? topRule?.subsequentBlockAmountCents ?? topRule?.firstBlockAmountCents ?? 0),
    blockMinutes: Number(policyRow.block_minutes ?? policyRow.blockMinutes ?? topRule?.subsequentBlockMinutes ?? topRule?.firstBlockMinutes ?? 60),
    dailyCapCents: Number(policyRow.daily_cap_cents ?? policyRow.dailyCapCents ?? 0),
    currency: String(policyRow.currency ?? 'MYR'),
    fetchedAt,
    rules,
    // /rate-policies sends description (policyId/policyName are folded into the
    // canonical fields above, which already fall back to id/name).
    policyDescription: policyRow.policy_description ?? policyRow.description ?? null,
    isSiteDefault: !!policyRow.is_site_default,
    graceExceededBehavior: policyRow.grace_exceeded_behavior ?? null,
    cutoffEnabled: !!policyRow.cutoff_enabled,
    cutoffTime: policyRow.cutoff_time ?? null,
    cutoffBehavior: policyRow.cutoff_behavior ?? null,
    newDayFixedFeeCents: policyRow.new_day_fixed_fee_cents != null
      ? Number(policyRow.new_day_fixed_fee_cents)
      : null,
    rateBasis: (policyRow.rate_basis ?? policyRow.rateBasis ?? null) as any,
    flatMultiRate: (policyRow.flat_multi_rate ?? policyRow.flatMultiRate ?? null) as any,
    firstBlockOncePerEntry: !!(policyRow.first_block_once_per_entry ?? policyRow.firstBlockOncePerEntry ?? false),
    // /rate-policies sends the true policy cap as `daily_cap_cents` (not
    // policy_daily_cap_cents). Without this fallback the fee engine reads null
    // and leaves daily capping silently OFF.
    policyDailyCapCents: (policyRow.policy_daily_cap_cents ?? policyRow.policyDailyCapCents ?? policyRow.daily_cap_cents) != null
      ? Number(policyRow.policy_daily_cap_cents ?? policyRow.policyDailyCapCents ?? policyRow.daily_cap_cents)
      : null,
  };
}

// ─── pull sync: policies / passes / spaces ─────────────────────────────────────

/** Pull policy+rate config from the cloud and upsert into the local cache. */
export async function syncRatePolicies(): Promise<SyncResult> {
  const cloud = getCloudApi();
  if (!cloud) return NOT_CONFIGURED;
  try {
    const { data: responseBody } = await cloud.get<CloudListBody>('/rate-policies');
    const ratePolicyRows = responseBody.data ?? [];
    const fetchedAt = new Date().toISOString();

    // The backend flags one policy as is_site_default (RatePolicyController
    // marks the first by name), so isSiteDefault comes straight from the payload.
    const ratePolicies = ratePolicyRows.map((policyRow: any) => mapApiRowToRatePolicy(policyRow, fetchedAt));

    let savedCount = 0;
    for (const ratePolicy of ratePolicies) {
      upsertRatePolicy(ratePolicy);
      savedCount++;
    }

    // Drop local policies the cloud no longer returns.
    try {
      const cloudPolicyIds = ratePolicyRows.map((policyRow: any) => policyRow.id);
      pruneStaleRatePolicies(cloudPolicyIds);
    } catch { /* pruning is best-effort; sync loop retries next tick */ }

    return { ok: true, fetched: savedCount };
  } catch (error) {
    // 404 = this site has no active rate policies yet (RatePolicyController
    // returns 404, not an empty list). Treat as a benign no-op like the other
    // syncs, rather than surfacing an error in the sync report.
    if (isHttpStatus(error, 404)) return { ok: true, fetched: 0 };
    return toFailedSyncResult(error);
  }
}

function mapApiRowToSeasonPass(seasonPassRow: any, fetchedAt: string): SeasonPass {

  return {
      passId: seasonPassRow.pass_id,
        plateNumber:seasonPassRow.plate_number,
        passType: seasonPassRow.pass_type,
        status: seasonPassRow.status,
        startDate: seasonPassRow.start_date ?? null,
        endDate: seasonPassRow.end_date ?? null,
        isFree: !!(seasonPassRow.is_free ?? false),
        spaceNumber: seasonPassRow.space_number ?? null,
        fetchedAt,
  };
}

/**
 * Pull the active season-pass roster. The gate uses this to skip charging
 * plates that have a paid / VIP / corporate / staff pass. Passes are
 * site-scoped (one site per install), so they're cached as a single flat set
 * keyed by plate — replace-all, so a pass revoked on the cloud disappears
 * locally on the next sync. An empty roster is legitimate, not a failure.
 */
export async function syncSeasonPasses(): Promise<SyncResult> {
  const cloud = getCloudApi();
  if (!cloud) return NOT_CONFIGURED;
  try {
    const { data: responseBody } = await cloud.get<CloudListBody>('/season-passes');
    const seasonPassRows = responseBody.data ?? [];
    const fetchedAt = new Date().toISOString();

    const seasonPasses = seasonPassRows.filter((seasonPassRow: any) => seasonPassRow.plate_number).map((seasonPassRow: any) => mapApiRowToSeasonPass(seasonPassRow, fetchedAt));
    replaceAllSeasonPasses(seasonPasses);
    return { ok: true, fetched: seasonPasses.length };
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
    const site = mapApiRowToSite(siteRow);
    upsertSite(site);
    // First-time provisioning: an unbound box (fresh install, or an existing
    // one from before binding existed) adopts whatever site its current key
    // resolves to. This is NOT a site switch — no reset — so existing installs
    // keep their data and simply record which site they belong to. A DIFFERENT
    // key later resolving to a different site is caught by the site:rebind flow.
    if (!getBoundSiteId()) {
      setBoundSiteId(site.id);
      bindSiteApiKey(site.id, getSettings().qparkingApiKey);
    }
    return { ok: true, fetched: 1 };
  } catch (error) {
    // 404 means an older qparking SaaS without the endpoint — gracefully no-op.
    if (isHttpStatus(error, 404)) return { ok: true, fetched: 0 };
    return toFailedSyncResult(error);
  }
}

/**
 * Resolve WHICH site a candidate base-URL + API key belongs to, without
 * persisting anything. Used by the re-provision preview so the operator can be
 * warned before a key change wipes the box. Throws on network / auth / empty
 * payload so the caller can surface a precise reason.
 */
export async function fetchSiteWith(baseUrl: string, apiKey: string): Promise<Site> {
  const cloud = buildCloudApi(baseUrl, apiKey);
  if (!cloud) throw new Error('missing_credentials');
  const { data: responseBody } = await cloud.get<{ data?: any }>('/site');
  const siteRow = responseBody?.data;
  if (!siteRow?.id) throw new Error('empty_site_payload');
  return mapApiRowToSite(siteRow);
}

function mapApiRowToParkingSpace(parkingSpaceRow: any, fetchedAt: string): ParkingSpace {

  return {
       id: parkingSpaceRow.id,
        building: parkingSpaceRow.building ?? null,
        level: parkingSpaceRow.level ?? null,
        zone: parkingSpaceRow.zone ?? null,
        spaceNumber: parkingSpaceRow.space_number ?? null,
        spaceCode: parkingSpaceRow.space_code ?? null,
        status: parkingSpaceRow.status,
        customerName: parkingSpaceRow.customer_name ?? null,
        vehiclePlate: parkingSpaceRow.vehicle_plate ?? null,
        passType: parkingSpaceRow.pass_type ?? null,
        passId: parkingSpaceRow.pass_id ?? null,
        startDate: parkingSpaceRow.start_date ?? null,
        endDate: parkingSpaceRow.end_date ?? null,
        notes: parkingSpaceRow.notes ?? null,
        fetchedAt,
  };
}

/**
 * Pull the canonical parking-space inventory from the cloud. Read-only
 * mirror — the operator manages spaces in qparking SaaS, the on-prem app
 * just reflects them for visibility.
 */
export async function syncParkingSpaces(): Promise<SyncResult> {
  const cloud = getCloudApi();
  if (!cloud) return NOT_CONFIGURED;
  try {
    const { data: responseBody } = await cloud.get<CloudListBody>('/parking-spaces');
    const parkingparkingSpaceRows = responseBody.data ?? [];
    const fetchedAt = new Date().toISOString();

    const parkingSpaces = parkingparkingSpaceRows.map((parkingparkingSpaceRow: any) => mapApiRowToParkingSpace(parkingparkingSpaceRow, fetchedAt));

    replaceParkingSpaces(parkingSpaces);
    return { ok: true, fetched: parkingSpaces.length };
  } catch (error) {
    // 404 means an older qparking SaaS without the endpoint — gracefully no-op.
    if (isHttpStatus(error, 404)) return { ok: true, fetched: 0 };
    return toFailedSyncResult(error);
  }
}

/** Run all three pulls in parallel; one failing doesn't block the others. */
export async function syncAll(): Promise<{
  policies: SyncResult;
  passes: SyncResult;
  spaces: SyncResult;
  site: SyncResult;
}> {
  const [policies, passes, spaces, site] = await Promise.all([
    syncRatePolicies().catch(toFailedSyncResult),
    syncSeasonPasses().catch(toFailedSyncResult),
    syncParkingSpaces().catch(toFailedSyncResult),
    syncSite().catch(toFailedSyncResult),
    syncActivityLogs().catch(toFailedSyncResult),
  ]);
  return { policies, passes, spaces, site };
}

export async function handleDebug(): Promise<any> {
  return syncSite();
}

// ─── background sync timer ───────────────────────────────────────────────────

let backgroundSyncTimer: NodeJS.Timeout | null = null;

/** Run every pull, swallowing errors — the timer retries next tick. */
function runFullSyncQuietly(): void {
  syncSite().catch(() => null);
  syncRatePolicies().catch(() => null);
  syncSeasonPasses().catch(() => null);
  syncParkingSpaces().catch(() => null);
  // Activity logs are a site-scoped mirror too — pull them here so a site
  // change (or a rebind that didn't re-pull) self-heals within one cadence
  // instead of showing the previous site's audit trail until the next manual
  // "Sync now". replaceAllActivityLogs on an empty payload clears the cache.
  syncActivityLogs().catch(() => null);
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

/** Start the 20s gate-open command poller. Runs alongside the main policy/pass
 *  sync but on its own timer so a slow policy pull doesn't block gate opens. */
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
 * Push a rate edit up to the qparking SaaS (PUT /rate-policies/upsert). On success
 * we immediately re-pull the policies so the cached row reflects whatever
 * the SaaS canonicalised (and the rest of the app sees the new fee math).
 */
export async function pushRatePolicy(rateInput: {
  firstBlockCents: number;
  perBlockCents: number;
  blockMinutes: number;
  freeMinutes: number;
  dailyCapCents: number;
}): Promise<SyncResult> {
  const cloud = getCloudApi();
  if (!cloud) return NOT_CONFIGURED;
  try {
    await cloud.put('/rate-policies/upsert', {
      first_block_cents: rateInput.firstBlockCents,
      per_block_cents: rateInput.perBlockCents,
      block_minutes: rateInput.blockMinutes,
      free_minutes: rateInput.freeMinutes,
      daily_cap_cents: rateInput.dailyCapCents,
    });
    // Re-pull so the local cache reflects whatever the SaaS canonicalised.
    return await syncRatePolicies();
  } catch (error) {
    return toFailedSyncResult(error);
  }
}

// Map a cloud /activity-logs row (snake_case, per ActivityLogResource) to the
// camelCase shape replaceAllActivityLogs() writes into SQLite. Accepts either
// casing so a resource tweak doesn't silently null a column. `_fetchedAt` is
// unused — activity_logs tracks occurred_at/created_at, not a fetch stamp —
// but kept in the signature to match the syncActivityLogs() call site.
function mapApiRowToActivityLogs(activityLogRow: any, _fetchedAt: string): any {
  return {
    id: String(activityLogRow.id),
    eventKey: String(activityLogRow.event_key ?? activityLogRow.eventKey ?? ''),
    action: String(activityLogRow.action ?? ''),
    category: String(activityLogRow.category ?? ''),
    severity: activityLogRow.severity ?? 'low',
    outcome: activityLogRow.outcome ?? null,
    resourceType: activityLogRow.resource_type ?? activityLogRow.resourceType ?? null,
    resourceId: activityLogRow.resource_id ?? activityLogRow.resourceId ?? null,
    correlationId: activityLogRow.correlation_id ?? activityLogRow.correlationId ?? null,
    description: activityLogRow.description ?? null,
    // Cloud sends `changes` as an object/array; replaceAllActivityLogs()
    // JSON-stringifies it on the way into the TEXT column.
    changes: activityLogRow.changes ?? null,
    source: activityLogRow.source ?? 'cloud',
    actorName: activityLogRow.actor_name ?? activityLogRow.actorName ?? null,
    siteId: activityLogRow.site_id ?? activityLogRow.siteId ?? null,
    occurredAt: activityLogRow.occurred_at ?? activityLogRow.occurredAt ?? null,
    createdAt: activityLogRow.created_at ?? activityLogRow.createdAt ?? null,
  };
}


export async function syncActivityLogs(): Promise<SyncResult> {
  const cloud = getCloudApi();
  if (!cloud) return NOT_CONFIGURED;
  try {
    const { data: responseBody } = await cloud.get<CloudListBody>('/activity-logs');
    const activityLogRows = responseBody.data ?? [];
    const fetchedAt = new Date().toISOString();

    // Replace-all mirror of the cloud's audit trail. An empty payload is a
    // legitimate state (e.g. a freshly provisioned site), so we still clear the
    // local cache — otherwise the PREVIOUS site's logs would keep showing after
    // a re-provision to a site that has no logs yet.
    const activityLogs = activityLogRows.map((activityLogRow: any) => mapApiRowToActivityLogs(activityLogRow, fetchedAt));
    replaceAllActivityLogs(activityLogs);
    return { ok: true, fetched: activityLogs.length };
  } catch (error) {
    // 404 means an older qparking SaaS without the endpoint — gracefully no-op.
    if (isHttpStatus(error, 404)) return { ok: true, fetched: 0 };
    return toFailedSyncResult(error);
  }
}
