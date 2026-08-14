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
	replaceAllBlockedPlates,
	replaceAllCloudCustomers,
	replaceAllCloudVehicles,
	replaceParkingSpaces,
	upsertCompanySetting,
	pruneStaleRatePolicies,
	replaceAllActivityLogs,
	importOpenSessionsFromCloud,
	getSettings,
	getBoundSiteId,
	setBoundSiteId,
	bindSiteApiKey,
	updateActivityLogs,
	markActivityLogsPushFailed,
	listActivityLogs,
	getCompanySetting,
	isBoundToCurrentSite,
} from "./db";
import { EventEmitter } from "node:events";
import { getCloudApi, buildCloudApi, isHttpStatus, describeRequestError } from "./cloud-api";
import { drainNow, getSyncStatus } from "./cloud-queue";
import type { RatePolicy, TariffRule, SeasonPass, BlockedPlate, CloudCustomer, CloudVehicle, ParkingSpace, Site, ActivityLog, CompanySetting, CloudMirror } from "../../shared/types";

export interface SyncResult {
	ok: boolean;
	fetched: number;
	error?: string;
}

/** The SaaS wraps every list payload in a `{ data: [...] }` envelope. */
interface CloudListBody {
	data?: any[];
}

const NOT_CONFIGURED: SyncResult = { ok: false, fetched: 0, error: "qparking_not_configured" };

/** Outcome of a full pull, for the header's "last synced" stamp. In-memory only
 *  — doesn't need to survive a restart, since syncAll() runs again at boot. */
export interface CloudPullState {
	lastCloudPullAt: string;
	lastCloudPullError: string;
}
let cloudPullState: CloudPullState = { lastCloudPullAt: "", lastCloudPullError: "" };

/** Emits 'pulled' with a CloudPullState after every syncAll(). index.ts forwards
 *  it to the renderer so the header updates without polling. */
export const cloudPullEvents = new EventEmitter();

export function getCloudPullState(): CloudPullState {
	return cloudPullState;
}

/** Convert any thrown error (HTTP failure, timeout, DNS, …) into a SyncResult. */
function toFailedSyncResult(error: any): SyncResult {
	return { ok: false, fetched: 0, error: describeRequestError(error) };
}

// ─── API row → local type mapping ────────────────────────────────────────────

/** Map the `rules` array on a cloud policy row to local TariffRule objects. */
function mapApiRowToTariffRules(policyRow: any): TariffRule[] {
	if (!Array.isArray(policyRow.rules)) return [];
	return policyRow.rules
		.map(
			(ruleRow: any): TariffRule => ({
				ruleId: String(ruleRow.rule_id ?? ruleRow.ruleId ?? ""),
				name: String(ruleRow.name ?? ""),
				priority: Number(ruleRow.priority ?? 0),
				daysOfWeek: Array.isArray(ruleRow.days_of_week ?? ruleRow.daysOfWeek)
					? (ruleRow.days_of_week ?? ruleRow.daysOfWeek).map((day: any) => Number(day))
					: null,
				timeFrom: String(ruleRow.time_from ?? ruleRow.timeFrom ?? "00:00:00"),
				timeTo: String(ruleRow.time_to ?? ruleRow.timeTo ?? "23:59:59"),
				validFrom: ruleRow.valid_from ?? ruleRow.validFrom ?? null,
				validTo: ruleRow.valid_to ?? ruleRow.validTo ?? null,
				ruleType: (ruleRow.rule_type ?? ruleRow.ruleType ?? "block_hourly") as "flat_rate" | "block_hourly",
				flatAmountCents: Number(ruleRow.flat_amount_cents ?? 0),
				firstBlockAmountCents: Number(ruleRow.first_block_amount_cents ?? 0),
				firstBlockMinutes: Number(ruleRow.first_block_minutes ?? 60),
				subsequentBlockAmountCents: Number(ruleRow.subsequent_block_amount_cents ?? 0),
				subsequentBlockMinutes: Number(ruleRow.subsequent_block_minutes ?? 60),
				dailyCapCents: Number(ruleRow.daily_cap_cents ?? 0),
				isOvernight: !!ruleRow.is_overnight,
				// Missing flag means the rule is active.
				isActive: ruleRow.is_active == null ? true : !!ruleRow.is_active,
			}),
		)
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
		currency: String(policyRow.currency ?? "MYR"),
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
		newDayFixedFeeCents: policyRow.new_day_fixed_fee_cents != null ? Number(policyRow.new_day_fixed_fee_cents) : null,
		rateBasis: (policyRow.rate_basis ?? policyRow.rateBasis ?? null) as any,
		flatMultiRate: (policyRow.flat_multi_rate ?? policyRow.flatMultiRate ?? null) as any,
		firstBlockOncePerEntry: !!(policyRow.first_block_once_per_entry ?? policyRow.firstBlockOncePerEntry ?? false),
		// /rate-policies sends the true policy cap as `daily_cap_cents` (not
		// policy_daily_cap_cents). Without this fallback the fee engine reads null
		// and leaves daily capping silently OFF.
		policyDailyCapCents:
			(policyRow.policy_daily_cap_cents ?? policyRow.policyDailyCapCents ?? policyRow.daily_cap_cents) != null
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
		const { data: responseBody } = await cloud.get<CloudListBody>("/rate-policies");
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
		} catch {
			/* pruning is best-effort; sync loop retries next tick */
		}

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
		passId: seasonPassRow.id,
		plateNumber: seasonPassRow.vehicle.plate_number,
		passType: seasonPassRow.pass_type,
		status: seasonPassRow.status,
		startDate: seasonPassRow.start_date ?? null,
		endDate: seasonPassRow.end_date ?? null,
		isFree: !!(seasonPassRow.is_free ?? false),
		spaceNumber: seasonPassRow.space_number ?? null,
		// v1 carries no pool — one plate, one car.
		concurrentLimit: 1,
		role: null,
		// v1 carries no plan — a SaaS that predates the reconstruct has no
		// pass_products to name.
		plan: null,
		fetchedAt,
	};
}

/**
 * v2 row → one cached row PER PLATE, all sharing the pass's id and limit.
 * The local table's PK is already (pass_id, plate_number), so the pool needs
 * no new table — and countPassPlatesInside() groups on pass_id.
 */
function mapV2RowToSeasonPasses(row: any, fetchedAt: string): SeasonPass[] {
	const plates: string[] = Array.isArray(row.plates) ? row.plates.filter(Boolean) : [];

	return plates.map((plateNumber) => ({
		passId: row.id,
		plateNumber,
		// pass_type is gone from the cloud model; the product's category is what
		// free_reason ('pass-<type>') records at exit.
		passType: row.role ?? "pass",
		status: row.status,
		startDate: row.start_date ?? null,
		endDate: row.end_date ?? null,
		// The cloud sends no is_free on v2 — a pass IS the entitlement, and the
		// exit is free because the pass covers it, not because of a flag.
		isFree: true,
		spaceNumber: null,
		concurrentLimit: Math.max(1, Number(row.concurrent_limit ?? 1)),
		role: row.role ?? null,
		plan: row.plan ?? null,
		fetchedAt,
	}));
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
	const fetchedAt = new Date().toISOString();

	// v2 first: it carries the plate POOL and a pre-computed concurrent_limit,
	// which is what the quota guard in parking-flow needs. A SaaS that predates
	// the pass reconstruct 404s here and we fall back to v1 — one plate per
	// pass, limit 1, i.e. exactly the old behaviour.
	try {
		const { data: v2Body } = await cloud.get<CloudListBody>("/season-passes/v2");
		const v2Rows = v2Body.data ?? [];
		const seasonPasses = v2Rows.flatMap((row: any) => mapV2RowToSeasonPasses(row, fetchedAt));
		replaceAllSeasonPasses(seasonPasses);
		return { ok: true, fetched: seasonPasses.length };
	} catch (error) {
		if (!isHttpStatus(error, 404)) return toFailedSyncResult(error);
	}

	try {
		const { data: responseBody } = await cloud.get<CloudListBody>("/season-passes");
		const seasonPassRows = responseBody.data ?? [];

		const seasonPasses = seasonPassRows
			.filter((seasonPassRow: any) => seasonPassRow.vehicle?.plate_number)
			.map((seasonPassRow: any) => mapApiRowToSeasonPass(seasonPassRow, fetchedAt));
		replaceAllSeasonPasses(seasonPasses);
		return { ok: true, fetched: seasonPasses.length };
	} catch (error) {
		// 404 means an older qparking SaaS without the endpoint — gracefully no-op.
		if (isHttpStatus(error, 404)) return { ok: true, fetched: 0 };
		return toFailedSyncResult(error);
	}
}

/**
 * Mirror the combined audit trail down from the cloud — PUSH FIRST, then pull.
 *
 * The pull is a replace-all (`replaceAllActivityLogs`), and the cloud's set is
 * the only thing it writes. Any local row the cloud hasn't acked yet is
 * therefore invisible to the pull, and pulling first would drop it: manual
 * releases, blacklist refusals and session edits would vanish the moment
 * someone pressed "Sync now" before "Push to cloud". Delivering them first means
 * they come straight back down as part of the cloud set.
 *
 * A failed push does NOT fail this sync: the cloud-owned mirrors (bans, passes)
 * still need to reach the barrier, the rows are preserved locally either way,
 * and the reason is stamped per-row for the Activity Log page to show.
 */
export async function syncActivityLogs(): Promise<SyncResult> {
	const cloud = getCloudApi();
	if (!cloud) return NOT_CONFIGURED;
	const push = await pushActivityLogsToCloud();
	if (!push.ok) {
		console.warn(`[cloud-sync] activity-log push before pull failed (${push.error ?? "unknown"}); unpushed local rows are preserved`);
	}
	try {
		const { data: responseBody } = await cloud.get<CloudListBody>("/activity-logs");
		const activityLogRows = responseBody.data ?? [];
		const activityLogs = activityLogRows.map((activityLogRow: any) => mapApiRowToActivityLogs(activityLogRow));
		replaceAllActivityLogs(activityLogs);
		return { ok: true, fetched: activityLogs.length };
	} catch (error) {
		// 404 means an older qparking SaaS without the endpoint — gracefully no-op.
		if (isHttpStatus(error, 404)) return { ok: true, fetched: 0 };
		return toFailedSyncResult(error);
	}
}

/**
 * Deliver local-origin rows to the cloud audit trail. Called two ways now — the
 * Activity Log page's "Push to cloud" button AND syncActivityLogs() ahead of its
 * pull — so concurrent callers share ONE in-flight push. Two overlapping pushes
 * would both read the same pending set and send it twice, and the cloud's
 * /activity-logs/sync re-uses the local row's id, so the second delivery
 * collides on the primary key and 500s a batch that had already landed.
 */
let activityPushInFlight: Promise<SyncResult> | null = null;

export function pushActivityLogsToCloud(): Promise<SyncResult> {
	if (activityPushInFlight) return activityPushInFlight;
	const push = pushActivityLogsOnce();
	activityPushInFlight = push;
	void push.catch(() => null).then(() => {
		if (activityPushInFlight === push) activityPushInFlight = null;
	});
	return push;
}

async function pushActivityLogsOnce(): Promise<SyncResult> {
	const cloud = getCloudApi();
	if (!cloud) return NOT_CONFIGURED;

	// Only ever push local-origin rows the cloud hasn't acked yet — rows
	// mirrored down FROM the cloud (source='cloud') must never be sent back.
	const unacked = listActivityLogs().filter((log) => log.source === "local" && !log.pushedToCloud);

	// The ingest endpoint requires each row's siteId to match the site the API key
	// belongs to, so a row written while this box was unbound (an app.started at
	// first launch, or anything logged before the first successful syncSite) can
	// NEVER be accepted. Hold them back instead of re-offering them on every sync
	// forever, and say so on the row.
	const boundSiteId = getBoundSiteId();
	const pending = unacked.filter((log) => !!log.siteId && log.siteId === boundSiteId);
	const unattributable = unacked.filter((log) => !pending.includes(log));
	if (unattributable.length) {
		markActivityLogsPushFailed(
			unattributable.map((log) => log.id),
			boundSiteId ? "logged_before_this_site_was_bound" : "box_not_bound_to_a_site_yet",
		);
	}
	if (!pending.length) return { ok: true, fetched: 0 };

	try {
		const { data: responseBody } = await cloud.post<CloudListBody>("/activity-logs/sync", { data: JSON.stringify(pending) });
		const activityLogRows = responseBody.data ?? [];

		const activityLogs = activityLogRows.map((activityLogRow: any) => mapApiRowToActivityLogs(activityLogRow));
		updateActivityLogs(activityLogs);
		// The cloud accepts a batch row-by-row and returns only what it stored
		// (rejects come back under `skipped`). Anything it didn't ack stays
		// pending — stamp WHY, or an unmappable row sits at "Not pushed yet"
		// forever with no clue and gets re-sent on every single sync.
		const acked = new Set(activityLogs.map((log: ActivityLog) => log.id));
		const rejected = pending.filter((log) => !acked.has(log.id));
		if (rejected.length) {
			const reasons = new Map<string, string>(
				((responseBody as any).skipped ?? [])
					.filter((entry: any) => entry?.id)
					.map((entry: any) => [String(entry.id), String(entry.reason ?? "rejected_by_cloud")]),
			);
			for (const log of rejected) {
				markActivityLogsPushFailed([log.id], reasons.get(log.id) ?? "rejected_by_cloud");
			}
			console.warn(`[cloud-sync] ${rejected.length} activity row(s) rejected by the cloud: ${rejected.map((log) => `${log.eventKey ?? "—"} (${reasons.get(log.id) ?? "no reason given"})`).join("; ")}`);
		}
		return { ok: true, fetched: activityLogs.length };
	} catch (error) {
		// 404 means an older qparking SaaS without the endpoint — gracefully no-op.
		if (isHttpStatus(error, 404)) return { ok: true, fetched: 0 };
		const failed = toFailedSyncResult(error);
		// Stamp the reason on the rows themselves. /activity-logs/sync is
		// all-or-nothing (one DB transaction server-side), so every row in the
		// batch is still pending — the operator sees WHY on each one instead of a
		// permanent, unexplained "Not pushed yet".
		markActivityLogsPushFailed(pending.map((log) => log.id), failed.error ?? "push_failed");
		return failed;
	}
}

/**
 * Pull the blacklist. Its own endpoint rather than a flag on the pass roster,
 * because a banned vehicle usually holds no pass at all — and the gate has to
 * stop it either way.
 *
 * An empty list is a completely normal state (most sites ban nobody), so it
 * still replaces the cache: that's how a LIFTED ban reaches the barrier. Note a
 * failed pull deliberately leaves the previous list in place — going offline
 * must not silently un-ban everyone.
 */
export async function syncBlockedPlates(): Promise<SyncResult> {
	const cloud = getCloudApi();
	if (!cloud) return NOT_CONFIGURED;
	try {
		const { data: responseBody } = await cloud.get<CloudListBody>("/vehicles/blacklisted");
		const rows = responseBody.data ?? [];
		const fetchedAt = new Date().toISOString();
		const blockedPlates: BlockedPlate[] = rows
			.filter((row: any) => row.plate_number)
			.map((row: any) => ({
				plateNumber: String(row.plate_number),
				vehicleId: row.vehicle_id ?? null,
				reason: row.reason ?? null,
				fetchedAt,
			}));
		replaceAllBlockedPlates(blockedPlates);
		return { ok: true, fetched: blockedPlates.length };
	} catch (error) {
		// 404 = an older qparking SaaS without the endpoint. Treat as a no-op and
		// KEEP the existing list rather than clearing it.
		if (isHttpStatus(error, 404)) return { ok: true, fetched: 0 };
		return toFailedSyncResult(error);
	}
}

/**
 * Restore OPEN sessions (cars currently inside) from the cloud's parking
 * records — the recovery pull for a rebound / reinstalled / wiped box, so cars
 * that entered before the reset can still exit. Import guards live in
 * importOpenSessionsFromCloud; `fetched` reports how many were actually
 * IMPORTED (already-known stays are skipped, which is the normal case on a
 * healthy box). Deliberately NOT on the 60s tick: a stale cloud record (its
 * exit push still in our outbound queue) must never re-open a stay the box
 * just closed — manual "Sync now" / post-rebind only.
 */
export async function syncOpenSessions(): Promise<SyncResult> {
	const cloud = getCloudApi();
	if (!cloud) return NOT_CONFIGURED;
	try {
		const { data: responseBody } = await cloud.get<CloudListBody>("/parking-records/open");
		const rows = responseBody.data ?? [];
		const { imported } = importOpenSessionsFromCloud(
			rows.filter((row: any) => row.plate_number && row.entry_time).map((row: any) => ({ plate: String(row.plate_number), entryAt: String(row.entry_time) })),
		);
		return { ok: true, fetched: imported };
	} catch (error) {
		// 404 = an older qparking SaaS without the endpoint — gracefully no-op.
		if (isHttpStatus(error, 404)) return { ok: true, fetched: 0 };
		return toFailedSyncResult(error);
	}
}

/**
 * Pull the read-only customer directory. Exists so site staff can look up an
 * owner at the gate without opening the cloud portal in a browser — the on-prem
 * app never writes these back.
 */
export async function syncCloudCustomers(): Promise<SyncResult> {
	const cloud = getCloudApi();
	if (!cloud) return NOT_CONFIGURED;
	try {
		const { data: responseBody } = await cloud.get<CloudListBody>("/customers");
		const rows = responseBody.data ?? [];
		const fetchedAt = new Date().toISOString();
		const customers: CloudCustomer[] = rows
			.filter((row: any) => row.id)
			.map((row: any) => ({
				id: String(row.id),
				fullName: row.full_name ?? null,
				email: row.email ?? null,
				phone: row.phone ?? null,
				// Absent from a SaaS that predates the reconstruct — the UI then
				// falls back to the legacy type, i.e. exactly the old behaviour.
				siteRole: row.site_role ?? null,
				isEnabled: row.is_enabled == null ? true : !!row.is_enabled,
				vehiclesCount: Number(row.vehicles_count ?? 0),
				activePassesCount: Number(row.active_passes_count ?? 0),
				lastSignIn: row.last_sign_in ?? null,
				createdAt: row.created_at ?? null,
				fetchedAt,
			}));
		replaceAllCloudCustomers(customers);
		return { ok: true, fetched: customers.length };
	} catch (error) {
		if (isHttpStatus(error, 404)) return { ok: true, fetched: 0 };
		return toFailedSyncResult(error);
	}
}

/**
 * Pull the read-only vehicle registry — the "who owns this plate?" lookup, and
 * the operator-facing view of the blacklist (enforcement itself runs off the
 * leaner /blocked-plates list, which refreshes on the same tick).
 */
export async function syncCloudVehicles(): Promise<SyncResult> {
	const cloud = getCloudApi();
	if (!cloud) return NOT_CONFIGURED;
	try {
		const { data: responseBody } = await cloud.get<CloudListBody>("/vehicles");
		const rows = responseBody.data ?? [];
		const fetchedAt = new Date().toISOString();
		const vehicles: CloudVehicle[] = rows
			.filter((row: any) => row.id && row.plate_number)
			.map((row: any) => ({
				id: String(row.id),
				plateNumber: String(row.plate_number),
				vehicleType: row.vehicle_type ?? null,
				color: row.color ?? null,
				model: row.model ?? null,
				ownerName: row.owner_name ?? null,
				ownerKind: row.owner_kind ?? null,
				isBlacklisted: !!row.is_blacklisted,
				blacklistReason: row.blacklist_reason ?? null,
				createdAt: row.created_at ?? null,
				fetchedAt,
			}));
		replaceAllCloudVehicles(vehicles);
		return { ok: true, fetched: vehicles.length };
	} catch (error) {
		if (isHttpStatus(error, 404)) return { ok: true, fetched: 0 };
		return toFailedSyncResult(error);
	}
}

/** Map the GET /site payload (snake_case SiteResource) to the local Site. */
function mapApiRowToSite(siteRow: any): Site {
	return {
		id: String(siteRow.id ?? ""),
		companyId: siteRow.company_id ?? null,
		name: String(siteRow.name ?? ""),
		address: siteRow.address ?? null,
		totalSpaces: Number(siteRow.total_spaces ?? 0),
		occupiedSpaces: Number(siteRow.occupied_spaces ?? 0),
		revenueToday: Number(siteRow.revenue_today ?? 0),
		status: (siteRow.status ?? "active") as Site["status"],
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
		const { data: responseBody } = await cloud.get<{ data?: any }>("/site");
		const siteRow = responseBody?.data;
		if (!siteRow?.id) return { ok: false, fetched: 0, error: "empty_site_payload" };
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
	if (!cloud) throw new Error("missing_credentials");
	const { data: responseBody } = await cloud.get<{ data?: any }>("/site");
	const siteRow = responseBody?.data;
	if (!siteRow?.id) throw new Error("empty_site_payload");
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
		// Absent from a SaaS that predates the reconstruct — the UI then falls
		// back to the legacy pass_type, i.e. exactly the old behaviour.
		bayType: parkingSpaceRow.bay_type ?? null,
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
		const { data: responseBody } = await cloud.get<CloudListBody>("/parking-spaces");
		const parkingSpaceRows = responseBody.data ?? [];
		const fetchedAt = new Date().toISOString();

		const parkingSpaces = parkingSpaceRows.map((parkingSpaceRow: any) => mapApiRowToParkingSpace(parkingSpaceRow, fetchedAt));

		replaceParkingSpaces(parkingSpaces);
		return { ok: true, fetched: parkingSpaces.length };
	} catch (error) {
		// 404 means an older qparking SaaS without the endpoint — gracefully no-op.
		if (isHttpStatus(error, 404)) return { ok: true, fetched: 0 };
		return toFailedSyncResult(error);
	}
}

/** Map the cloud's company-settings row to the local CompanySetting. Defaults
 *  mirror the column defaults in db.applySchema, so a payload missing a field
 *  lands on the same value a fresh row would. */
function mapApiRowToCompanySetting(settingRow: any): CompanySetting {
	return {
		id: String(settingRow.id ?? ""),
		companyId: settingRow.company_id ?? null,
		seasonPassGraceDays: Number(settingRow.season_pass_grace_days ?? 30),
		// The SaaS may send this as a JSON boolean or as 0/1 — `?? default` then
		// coerce handles both, and keeps an explicit `false`/`0` meaning false.
		syncCaptureImages: !!(settingRow.sync_capture_images ?? true),
		syncIntervalMinutes: Number(settingRow.sync_interval_minutes ?? 60),
	};
}

/**
 * Pull the company-wide settings record (GET /company/settings) into the local
 * `company_settings` mirror. A SINGLE record, not a list — same shape as
 * syncSite, so it uses the `{ data: {...} }` object envelope rather than
 * CloudListBody, and reports `fetched: 1`.
 */
export async function syncCompanySetting(): Promise<SyncResult> {
	const cloud = getCloudApi();
	if (!cloud) return NOT_CONFIGURED;
	try {
		const { data: responseBody } = await cloud.get<{ data?: CompanySetting }>("/company/settings");
		const settingRow = responseBody?.data;
		if (!settingRow?.id) return { ok: false, fetched: 0, error: "empty_company_settings_payload" };
		upsertCompanySetting(mapApiRowToCompanySetting(settingRow));
		return { ok: true, fetched: 1 };
	} catch (error) {
		// 404 means an older qparking SaaS without the endpoint — gracefully no-op.
		if (isHttpStatus(error, 404)) return { ok: true, fetched: 0 };
		return toFailedSyncResult(error);
	}
}

/** Run all pulls in parallel; one failing doesn't block the others. */
export async function syncAll(): Promise<{
	policies: SyncResult;
	passes: SyncResult;
	blockedPlates: SyncResult;
	customers: SyncResult;
	vehicles: SyncResult;
	spaces: SyncResult;
	site: SyncResult;
	activity: SyncResult; 
	sessions: SyncResult;
	companySetting: SyncResult;
}> {
	const [policies, passes, blockedPlates, customers, vehicles, spaces, site, activity, sessions, companySetting] = await Promise.all([
		syncRatePolicies().catch(toFailedSyncResult),
		syncSeasonPasses().catch(toFailedSyncResult),
		syncBlockedPlates().catch(toFailedSyncResult),
		syncCloudCustomers().catch(toFailedSyncResult),
		syncCloudVehicles().catch(toFailedSyncResult),
		syncParkingSpaces().catch(toFailedSyncResult),
		syncSite().catch(toFailedSyncResult),
		syncActivityLogs().catch(toFailedSyncResult),
		syncOpenSessions().catch(toFailedSyncResult),
		syncCompanySetting().catch(toFailedSyncResult),
	]);
	const results = { policies, passes, blockedPlates, customers, vehicles, spaces, site, activity, sessions, companySetting };
	stampPullOutcome(results, "full");
	announceRefreshedMirrors(results);
	return results;
}

// ─── the light recurring sync (what autoSync() runs) ─────────────────────────

/**
 * Deliver the outbound queue — parking activity (session.entry/exit/update/
 * delete) and payment transactions — by draining cloud-queue once, right now.
 *
 * cloud-queue owns the rows, the backoff and the endpoints; this is only a
 * "drain now" trigger wearing a SyncResult so it can sit alongside the pulls in
 * syncEssentials(). `fetched` = rows that left the queue during THIS drain.
 *
 * Not-ok only when there is still a backlog AND the queue recorded a reason for
 * it: rows merely waiting out their backoff window are a normal, healthy state
 * and must not paint the header red.
 */
async function pushQueuedRecordsToCloud(): Promise<SyncResult> {
	if (!getCloudApi()) return NOT_CONFIGURED;
	const pendingBefore = getSyncStatus().pending;
	const status = await drainNow();
	const pushed = Math.max(0, pendingBefore - status.pending);
	const backlog = status.pending + status.failed;
	if (backlog > 0 && status.lastError) return { ok: false, fetched: pushed, error: status.lastError };
	return { ok: true, fetched: pushed };
}

/** What one syncEssentials() tick did — three pulls down, one push up. */
export interface EssentialSyncResults {
	customers: SyncResult;
	vehicles: SyncResult;
	spaces: SyncResult;
	outbound: SyncResult;
}

/**
 * The recurring tick's sync — deliberately a SUBSET of syncAll().
 *
 * Down from the cloud (operator-facing directories that change often and cost
 * little): customers, vehicles, bays.
 * Up to the cloud: parking activity + transactions, via the outbound queue.
 *
 * Everything else syncAll() pulls — rate policies, season passes, the deny
 * list, the site record, company settings, the activity-log mirror, open-session
 * recovery — is left OUT on purpose. Two of those are the expensive ones
 * (/activity-logs is an unbounded replace-all that grows as the site ages), and
 * the rest change rarely.
 *
 * CONSEQUENCE, by design: a season pass issued or a plate banned in the cloud
 * does NOT reach the barrier on this tick. It arrives at boot, on a site rebind,
 * or when someone presses "Sync now" — which is why the header's "Synced …"
 * stamp keeps tracking full pulls only (see stampPullOutcome).
 *
 * Same shape as syncAll(): everything in parallel, each call's own
 * `.catch(toFailedSyncResult)` so one failure never blocks the others.
 */
export async function syncEssentials(): Promise<EssentialSyncResults> {
	const [customers, vehicles, spaces, outbound] = await Promise.all([
		syncCloudCustomers().catch(toFailedSyncResult),
		syncCloudVehicles().catch(toFailedSyncResult),
		syncParkingSpaces().catch(toFailedSyncResult),
		pushQueuedRecordsToCloud().catch(toFailedSyncResult),
	]);
	const results = { customers, vehicles, spaces, outbound };
	stampPullOutcome(results, "essential");
	announceRefreshedMirrors(results);
	return results;
}

// ─── periodic pull ───────────────────────────────────────────────────────────

/** Cadence bounds for company_settings.sync_interval_minutes. The floor matters:
 *  the SaaS can send 0 (or a non-numeric), and `setTimeout(fn, 0)` would re-run a
 *  ten-endpoint pull — one of them the unbounded /activity-logs replace-all
 *  mirror — every millisecond. The default matches the column default in
 *  db.applySchema and mapApiRowToCompanySetting. */
const MIN_SYNC_INTERVAL_MIN = 1;
const DEFAULT_SYNC_INTERVAL_MIN = 60;

/** Minutes between pulls, resolved once at autoSync() start. Anything unusable —
 *  missing row, 0, negative, NaN — falls back to the default rather than clamping
 *  to the floor: a nonsense value means "no cadence was really configured", not
 *  "sync as fast as allowed". Interval is fixed at boot — changing the setting
 *  takes effect on next app restart, same as before this function grew guards. */
function resolveSyncIntervalMin(): number {
	const configured = Number(getCompanySetting()?.syncIntervalMinutes);
	if (configured <= 0) return DEFAULT_SYNC_INTERVAL_MIN;
	return Math.max(MIN_SYNC_INTERVAL_MIN, configured);
}

let autoSyncTimer: NodeJS.Timeout | null = null;
let autoSyncInFlight = false;

/**
 * Periodic sync, cadence from company_settings.sync_interval_minutes.
 *
 * Runs syncEssentials(), NOT syncAll(): customers / vehicles / bays down,
 * parking activity + transactions up. The full ten-endpoint pull stays on the
 * three explicit moments — boot, "Sync now", site rebind — so the recurring tick
 * never carries the unbounded /activity-logs mirror.
 *
 * setInterval + an in-flight guard, the same shape cloud-queue.ts's drainOnce
 * uses for its 30s drain: a tick that lands while the previous one is still
 * running is skipped rather than queued, so a sync that outlasts the interval on
 * a slow link can't stack overlapping runs. Skipping costs nothing here — the
 * next tick is at most one interval away, same as a dropped drain tick.
 *
 * Idempotent — a call while the loop is already running is a no-op, so boot,
 * settings-save and site-rebind can all call it freely without stacking timers.
 */
export function autoSync(): void {
	if (autoSyncTimer) return;
	autoSyncTimer = setInterval(async () => {
		if (autoSyncInFlight) return;
		// Unconfigured or bound to another site: skip the tick outright. Running it
		// would fire requests that all fail the same way, and stampPullOutcome()
		// would paper over the last real pull's outcome with that error.
		if (!getCloudApi() || !isBoundToCurrentSite()) return;
		autoSyncInFlight = true;
		try {
			await syncEssentials();
		} catch {
			// swallow — same as the boot call site's syncAll().catch(() => null)
		} finally {
			autoSyncInFlight = false;
		}
	}, resolveSyncIntervalMin() * 60_000);
}

/** Stop the periodic pull (app quit). Safe to call when it was never started. */
export function stopAutoSync(): void {
	if (autoSyncTimer) {
		clearInterval(autoSyncTimer);
		autoSyncTimer = null;
	}
}

/** Which sync produced the error currently on display. A light tick must never
 *  clear a full pull's error — it didn't re-try those mirrors. */
type PullScope = "full" | "essential";
let pullErrorOwner: PullScope | null = null;

/**
 * Update + broadcast the outcome of a sync.
 *
 * A FAILED pull deliberately does NOT refresh `lastCloudPullAt`. The next
 * automatic retry is a whole sync_interval_minutes away, so that stamp is the
 * only thing telling staff whether a cloud-issued ban or season pass has
 * actually reached this barrier — showing a fresh time after a failed pull would
 * be a lie in exactly the situation where it matters.
 *
 * For the same reason a successful `essential` tick doesn't refresh it either:
 * syncEssentials() never pulls passes, the deny list or rates, so "Synced
 * 10:42" after one would claim something that didn't happen. It still REPORTS
 * its own failures (the operator has to see a dead link), and clears the error
 * again once it recovers — but only when the error was its own.
 */
function stampPullOutcome(results: Record<string, SyncResult>, scope: PullScope): void {
	const failed = Object.entries(results).filter(([, result]) => !result.ok);
	if (failed.length === 0) {
		if (scope === "full") {
			cloudPullState = { lastCloudPullAt: new Date().toISOString(), lastCloudPullError: "" };
			pullErrorOwner = null;
		} else if (pullErrorOwner === "essential") {
			cloudPullState = { ...cloudPullState, lastCloudPullError: "" };
			pullErrorOwner = null;
		} else {
			return; // clean light tick, nothing on display changed — don't re-emit
		}
	} else {
		const [mirror, first] = failed[0];
		const suffix = failed.length > 1 ? ` (+${failed.length - 1} more)` : "";
		cloudPullState = { ...cloudPullState, lastCloudPullError: `${mirror}: ${first.error ?? "failed"}${suffix}` };
		pullErrorOwner = scope;
	}
	cloudPullEvents.emit("pulled", cloudPullState);
}

/**
 * Announce WHICH mirrors just came down, so an open page can re-read the list
 * it is showing instead of rendering the rows it loaded on mount. index.ts
 * forwards this to the renderer as 'cloud-mirrors'.
 *
 * A separate event from 'pulled' on purpose. That one drives the header STAMP
 * and is deliberately silent after a clean light tick (see stampPullOutcome) —
 * yet that tick still rewrites customers, vehicles and bays, which is exactly
 * what a page would need to re-read. Tying page reloads to the stamp would
 * therefore miss the hourly refresh.
 *
 * Only mirrors that came back ok are announced: a failed pull left its cache
 * untouched, so there is nothing new to show. `fetched: 0` still counts —
 * every mirror is replace-all, so an empty payload means the list really is
 * empty now. 'outbound' is dropped: it's a push, not a mirror (the Dashboard
 * already tracks the queue on the 'sync-status' event).
 */
function announceRefreshedMirrors(results: Record<string, SyncResult>): void {
	const refreshed = Object.entries(results)
		.filter(([mirror, result]) => result.ok && mirror !== "outbound")
		.map(([mirror]) => mirror as CloudMirror);
	if (refreshed.length > 0) cloudPullEvents.emit("mirrors", refreshed);
}

// ─── when cloud-owned mirrors refresh ────────────────────────────────────────
//
// The old 60s polling tick (passes / deny list / spaces / activity logs) was
// REMOVED. It cost 4 requests a minute per site forever, and /activity-logs is
// an unbounded replace-all mirror of the whole audit trail — that request grows
// without limit as a site ages, so it must not run on a fast fixed tick.
//
// FULL pulls — syncAll(), every mirror including passes, deny list, rates,
// company settings and the /activity-logs replace-all — happen at exactly three
// points:
//   1. app boot            — index.ts
//   2. manual "Sync now"   — header / Settings page → ipc 'sync:all-tables'
//   3. site rebind         — ipc 'site:rebind'
//
// The recurring autoSync() tick runs syncEssentials() instead — every
// company_settings.sync_interval_minutes (60 default):
//   down: customers, vehicles, bays
//   up:   parking activity + transactions (one cloud-queue drain)
//
// Operational consequence, by design: a ban or season pass issued in the cloud
// reaches the barrier only at boot, on a rebind, or when staff press "Sync now"
// — the hourly tick no longer brings them down. Staff press the button when they
// need a cloud-side gating change enforced immediately.
//
// The session/transaction push queue still runs its OWN 30s drain in
// cloud-queue's startSyncDrain(), with per-row backoff — the tick's push is a
// nudge on top of it, not the only delivery path. Equipment (cameras / lanes /
// terminals) stays manual; see the boot comment in index.ts.

// Remote gate-open command poll REMOVED: the cloud can't reach a site's LAN,
// and the poll-based dispatch only fired the gate simulator — it never drove
// the real LPR barrier relay — so it did nothing useful for a physical-barrier
// site. Gates open locally (entry / paid-exit / manual).

// ─── push: rate edits up to the SaaS ─────────────────────────────────────────

// Map a cloud /activity-logs row (snake_case, per ActivityLogResource) to the
// camelCase shape replaceAllActivityLogs() writes into SQLite. Accepts either
// casing so a resource tweak doesn't silently null a column. `_fetchedAt` is
// unused — activity_logs tracks occurred_at/created_at, not a fetch stamp —
// but kept in the signature to match the pushActivityLogsToCloud() call site.
function mapApiRowToActivityLogs(activityLogRow: any): any {
	return {
		id: activityLogRow.id,
		eventKey: activityLogRow.event_key ?? null,
		action: activityLogRow.action,
		category: activityLogRow.category ?? null,
		severity: activityLogRow.severity ?? "low",
		outcome: activityLogRow.outcome ?? null,
		resourceType: activityLogRow.resource_type ?? activityLogRow.resourceType ?? null,
		resourceId: activityLogRow.resource_id ?? activityLogRow.resourceId ?? null,
		correlationId: activityLogRow.correlation_id ?? activityLogRow.correlationId ?? null,
		description: activityLogRow.description ?? null,
		changes: activityLogRow.changes ?? null,
		source: activityLogRow.source ?? "cloud",
		actorName: activityLogRow.actor_name ?? activityLogRow.actorName ?? null,
		siteId: activityLogRow.site_id ?? activityLogRow.siteId ?? null,
		occurredAt: activityLogRow.occurred_at ?? activityLogRow.occurredAt ?? null,
		createdAt: activityLogRow.created_at ?? activityLogRow.createdAt ?? null,
	};
}