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
	pruneStaleRatePolicies,
	replaceAllActivityLogs,
	importOpenSessionsFromCloud,
	getSettings,
	getBoundSiteId,
	setBoundSiteId,
	bindSiteApiKey,
	updateActivityLogs,
	listActivityLogs,
} from "./db";
import { EventEmitter } from "node:events";
import { getCloudApi, buildCloudApi, isHttpStatus, describeRequestError } from "./cloud-api";
import type { RatePolicy, TariffRule, SeasonPass, BlockedPlate, CloudCustomer, CloudVehicle, ParkingSpace, Site, ActivityLog } from "../../shared/types";

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
		const { data: responseBody } = await cloud.get<CloudListBody>("/season-passes");
		const seasonPassRows = responseBody.data ?? [];
		const fetchedAt = new Date().toISOString();

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

export async function syncActivityLogs(): Promise<SyncResult> {
	const cloud = getCloudApi();
	if (!cloud) return NOT_CONFIGURED;
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

export async function pushActivityLogsToCloud(): Promise<SyncResult> {
	const cloud = getCloudApi();
	if (!cloud) return NOT_CONFIGURED;

	// Only ever push local-origin rows the cloud hasn't acked yet — rows
	// mirrored down FROM the cloud (source='cloud') must never be sent back.
	const pending = listActivityLogs().filter((log) => log.source === "local" && !log.pushedToCloud);
	if (!pending.length) return { ok: true, fetched: 0 };

	try {
		const { data: responseBody } = await cloud.post<CloudListBody>("/activity-logs/sync", { data: JSON.stringify(pending) });
		const activityLogRows = responseBody.data ?? [];

		const activityLogs = activityLogRows.map((activityLogRow: any) => mapApiRowToActivityLogs(activityLogRow));
		updateActivityLogs(activityLogs);
		return { ok: true, fetched: activityLogs.length };
	} catch (error) {
		// 404 means an older qparking SaaS without the endpoint — gracefully no-op.
		if (isHttpStatus(error, 404)) return { ok: true, fetched: 0 };
		return toFailedSyncResult(error);
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
				type: row.type ?? null,
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
				passType: row.pass_type ?? null,
				passStatus: row.pass_status ?? null,
				passEndDate: row.pass_end_date ?? null,
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
}> {
	const [policies, passes, blockedPlates, customers, vehicles, spaces, site, activity, sessions] = await Promise.all([
		syncRatePolicies().catch(toFailedSyncResult),
		syncSeasonPasses().catch(toFailedSyncResult),
		syncBlockedPlates().catch(toFailedSyncResult),
		syncCloudCustomers().catch(toFailedSyncResult),
		syncCloudVehicles().catch(toFailedSyncResult),
		syncParkingSpaces().catch(toFailedSyncResult),
		syncSite().catch(toFailedSyncResult),
		syncActivityLogs().catch(toFailedSyncResult),
		syncOpenSessions().catch(toFailedSyncResult),
	]);
	const results = { policies, passes, blockedPlates, customers, vehicles, spaces, site, activity, sessions };
	stampPullOutcome(results);
	return results;
}

/**
 * Update + broadcast the outcome of a full pull.
 *
 * A FAILED pull deliberately does NOT refresh `lastCloudPullAt`. With the
 * recurring tick gone there's no automatic retry, so that stamp is the only
 * thing telling staff whether a cloud-issued ban or season pass has actually
 * reached this barrier — showing a fresh time after a failed pull would be a
 * lie in exactly the situation where it matters.
 */
function stampPullOutcome(results: Record<string, SyncResult>): void {
	const failed = Object.entries(results).filter(([, result]) => !result.ok);
	if (failed.length === 0) {
		cloudPullState = { lastCloudPullAt: new Date().toISOString(), lastCloudPullError: "" };
	} else {
		const [mirror, first] = failed[0];
		const suffix = failed.length > 1 ? ` (+${failed.length - 1} more)` : "";
		cloudPullState = { ...cloudPullState, lastCloudPullError: `${mirror}: ${first.error ?? "failed"}${suffix}` };
	}
	cloudPullEvents.emit("pulled", cloudPullState);
}

// ─── no recurring background sync ────────────────────────────────────────────
//
// The 60s polling tick (passes / deny list / spaces / activity logs) was
// REMOVED. It cost 4 requests a minute per site forever, and /activity-logs is
// an unbounded replace-all mirror of the whole audit trail — that request grows
// without limit as a site ages.
//
// Cloud-owned mirrors now refresh at exactly three points, all of them
// syncAll():
//   1. app boot            — index.ts
//   2. manual "Sync now"   — Settings page → ipc 'sync:all-tables'
//   3. site rebind         — ipc 'site:rebind'
//
// Operational consequence, by design: a ban or season pass issued in the cloud
// does NOT reach the barrier until one of those three happens. Site staff have
// to press "Sync now" after a cloud-side change they need enforced.

// Remote gate-open command poll REMOVED: the cloud can't reach a site's LAN,
// and the poll-based dispatch only fired the gate simulator + face turnstile —
// it never drove the real LPR barrier relay — so it did nothing useful for a
// physical-barrier site. Gates open locally (entry / paid-exit / manual).

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