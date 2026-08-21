/**
 * Outbound push queue to qparking SaaS. Every session state change enqueues a
 * `sync_queue` row (SQLite-backed, so a restart loses no state) and drains with
 * backoff (0/10s/30s/2min/10min, failing after 6 attempts) so the SaaS being
 * briefly unreachable never blocks parking flow at the gate.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import axios from "axios";
import {
	enqueueSync,
	listDueSync,
	markSyncOk,
	markSyncRetry,
	markSyncFailed,
	replaceSyncPayload,
	syncQueueStats,
	listSyncQueueIssues,
	getLane,
	getTerminal,
	isBoundToCurrentSite,
	getSiteDefaultRatePolicy,
	getCompanySetting,
	type SyncOp,
} from "./db";
import { getCloudApi, CLOUD_REQUEST_TIMEOUT_MS } from "./cloud-api";
import type { ParkingSession, Transaction, SyncIssue, SyncQueueRow } from "../../shared/types";

const BACKOFF_MS = [0, 10_000, 30_000, 120_000, 600_000];
const MAX_ATTEMPTS = 6;
const DRAIN_INTERVAL_MS = 30_000;

export const syncEvents = new EventEmitter();
/**
 * Status snapshot.
 *   pending = rows in queue, will retry
 *   failed  = rows that exhausted retries; operator must intervene
 *   inFlight = true while a drain is mid-flight (status indicator can spin)
 *   lastDrainAt = ISO time of last drain completion
 *   lastSuccessAt = ISO time of the most recent successful push (any op)
 *   lastError = most recent failure message (cleared on success)
 *   issues    = per-row detail for every push that failed at least once, so the
 *               Dashboard can show which record + why (not just the last error)
 */
export interface SyncStatus {
	pending: number;
	failed: number;
	inFlight: boolean;
	oldestPending: string | null;
	lastDrainAt: string | null;
	lastSuccessAt: string | null;
	lastError: string | null;
	issues: SyncIssue[];
}

/** The base64 image fields a payload can carry. */
const IMAGE_FIELDS = ["entry_image_base64", "exit_image_base64"] as const;

/** Bytes of base64 image riding in this payload; 0 when it carries none. */
function imageBytesIn(payload: Record<string, unknown>): number {
	let bytes = 0;
	for (const field of IMAGE_FIELDS) {
		const value = payload[field];
		if (typeof value === "string") bytes += value.length;
	}
	return bytes;
}

/**
 * Deadline for ONE push, scaled to what it is actually carrying.
 *
 * The shared client timeout is 10s, which is right for a JSON GET and wrong for
 * an upload: a plate capture is ~500KB of base64, an exit ships TWO of them, and
 * on a slow link that body cannot finish inside 10s no matter how healthy both
 * ends are. The queue then retried the whole megabyte six times and gave up —
 * spending 6MB to deliver nothing.
 *
 * Images get 5s per 100KB on top of the base, capped: a push that cannot finish
 * in two minutes is not going to, and holding the drain open longer just delays
 * every row behind it.
 */
function timeoutForPayload(payload: Record<string, unknown>): number {
	const bytes = imageBytesIn(payload);
	if (bytes === 0) return CLOUD_REQUEST_TIMEOUT_MS;
	return Math.min(120_000, CLOUD_REQUEST_TIMEOUT_MS + Math.ceil(bytes / 100_000) * 5_000);
}

/**
 * Take the photos off a push that timed out carrying them, and queue them
 * separately.
 *
 * The parking record and its photos have completely different worth: the record
 * is the audit trail and the revenue, the photo is nice to have. Shipping them in
 * one body meant a photo that could not be uploaded blocked the record too —
 * retried whole, six times, and then both were abandoned together.
 *
 * After ONE timeout the images come off. The row keeps its id, its attempt count
 * and its backoff, so the retry sends the record alone and it lands. The images
 * are re-queued as `session.images` — the same endpoint and the same identity
 * fields, so the cloud attaches them to the same stay whenever it can, and their
 * own failures no longer cost the record anything.
 *
 * The new row carries a distinct op ON PURPOSE: enqueueSync collapses an
 * identical (op, session, rev), so reusing the original op would have folded the
 * image row straight back into the row we just stripped.
 */
function splitImagesOff(row: SyncQueueRow): boolean {
	const images: Record<string, unknown> = {};
	for (const field of IMAGE_FIELDS) {
		if (typeof row.payload[field] === "string") images[field] = row.payload[field];
	}
	if (Object.keys(images).length === 0) return false;

	const withoutImages = { ...row.payload };
	for (const field of IMAGE_FIELDS) delete withoutImages[field];
	replaceSyncPayload(row.id, withoutImages);

	// Identity only — enough for the cloud to find the stay it belongs to. Never
	// status/fee/exit_time: this row must not be able to rewrite the record, only
	// to hang photos on it.
	const identity: Record<string, unknown> = {};
	for (const field of ["site_id", "external_id", "plate_number", "entry_time"]) {
		if (row.payload[field] !== undefined) identity[field] = row.payload[field];
	}
	enqueueSync("session.images", { ...identity, ...images }, row.sessionId, row.sessionRev);
	console.warn(
		`[cloud-queue] row ${row.id} (${row.op}) timed out carrying ${Math.round(imageBytesIn(row.payload) / 1024)}KB of photos`
		+ ` — retrying the record without them and queueing the photos separately`,
	);
	return true;
}

let inFlight = false;
let lastDrainAt: string | null = null;
let lastSuccessAt: string | null = null;
let lastError: string | null = null;

export function getSyncStatus(): SyncStatus {
	const stats = syncQueueStats();
	return {
		pending: stats.pending,
		failed: stats.failed,
		inFlight,
		oldestPending: stats.oldestPending,
		lastDrainAt,
		lastSuccessAt,
		lastError,
		issues: listSyncQueueIssues(),
	};
}

/** Reads a plate-capture image off disk as base64, capped at 500KB. Best-effort: returns null (never throws) so a missing/oversized image doesn't block the metadata sync. */
function readImageAsBase64(imagePath: string | null | undefined): string | null {
	if (!imagePath) return null;
	try {
		const stat = fs.statSync(imagePath);
		const MAX_BYTES = 500 * 1024;
		if (stat.size > MAX_BYTES) {
			console.warn(`[cloud-queue] skipping oversized plate image ${imagePath} (${stat.size} bytes, cap ${MAX_BYTES})`);
			return null;
		}
		const buf = fs.readFileSync(imagePath);
		return buf.toString("base64");
	} catch (e: any) {
		console.warn(`[cloud-queue] failed to read plate image ${imagePath}: ${e?.message ?? e}`);
		return null;
	}
}

/** Gates the upload on company_settings.sync_capture_images (disk save is unaffected). Read at enqueue time, so a flag flip doesn't touch already-queued rows. Missing setting defaults to ON, not off. */
function readImageForUpload(imagePath: string | null | undefined): string | null {
	const setting = getCompanySetting();
	const isEnabled = !setting || setting.syncCaptureImages;
	return isEnabled ? readImageAsBase64(imagePath) : null;
}

/** Legacy `site_id` field — informational only, must never gate a push (the endpoint derives site from the bearer token). Best-effort: absent when no policy resolves. Resolution order mirrors parking-flow.handleExit's rate lookup (entry lane → exit lane → site default). */
function resolveScopeId(session: ParkingSession): string | null {
	const entryLane = session.entryLaneId ? getLane(session.entryLaneId) : null;
	const exitLane = session.exitLaneId ? getLane(session.exitLaneId) : null;
	return entryLane?.policyId ?? exitLane?.policyId ?? getSiteDefaultRatePolicy()?.policyId ?? null;
}

/** The legacy `site_id` field, omitted entirely when no policy resolves. */
function scopeField(session: ParkingSession): { site_id?: string } {
	const siteId = resolveScopeId(session);
	return siteId ? { site_id: siteId } : {};
}

/**
 * The stay's durable identity, which is what lets the cloud UPDATE a record
 * instead of inserting a second one.
 *
 * Without it the cloud matched on plate + entry_time, so correcting a misread
 * plate (A1 → A11) found nothing and created a new record — leaving the original
 * open forever, because the car exits under the corrected plate. Sent on every
 * op, not just updates: the cloud can only match on an id it was given at insert.
 *
 * Omitted when null (a pre-migration row) so the cloud falls back to its old
 * matching rather than keying on the string "null".
 */
function identityField(session: ParkingSession): { external_id?: string } {
	return session.externalId ? { external_id: session.externalId } : {};
}

/**
 * Public enqueue helpers. parking-flow / IPC handlers call these instead of
 * fetching directly so retries are guaranteed.
 */
export function enqueueEntry(session: ParkingSession): void {
	const entryImage = readImageForUpload(session.entryImagePath);
	enqueueSync(
		"session.entry",
		{
			...scopeField(session),
			...identityField(session),
			plate_number: session.plate,
			entry_time: session.entryAt,
			...(entryImage ? { entry_image_base64: entryImage } : {}),
		},
		session.id,
		session.rev,
	);
	scheduleDrain();
}

export function enqueueExit(session: ParkingSession): void {
	// Ships both images (entry in case an earlier retry dropped it; safe to resend).
	// Payment outcome is NOT sent here — that's enqueueTransaction → /transactions.
	const entryImage = readImageForUpload(session.entryImagePath);
	const exitImage = readImageForUpload(session.exitImagePath);
	enqueueSync(
		"session.exit",
		{
			...scopeField(session),
			...identityField(session),
			plate_number: session.plate,
			entry_time: session.entryAt,
			exit_time: session.exitAt,
			fee_amount: session.feeCents != null ? (session.feeCents / 100).toFixed(2) : 0,
			duration_minutes: session.durationMinutes ?? 0,
			status: session.status,
			// Why this exit cost nothing ('pass-monthly' / 'within-grace' / 'rate-zero' /
			// 'no-policy'). Without it the cloud's Parking Activity page can only say
			// "free", and a legitimate pass exit is indistinguishable from a
			// misconfigured RM0 rate plan — the one distinction revenue assurance needs.
			free_reason: session.freeReason ?? null,
			...(entryImage ? { entry_image_base64: entryImage } : {}),
			...(exitImage ? { exit_image_base64: exitImage } : {}),
		},
		session.id,
		session.rev,
	);
	scheduleDrain();
}

/**
 * The plate this stay carried BEFORE the edit, sent only when it actually changed.
 *
 * Covers the one case `external_id` cannot: a stay that was already open when the
 * box upgraded has a cloud record created without an id, so an id lookup misses
 * and a lookup by the NEW plate misses too. The old plate is the only handle left
 * on that row, and the cloud uses it to adopt the record rather than fork it.
 * Unnecessary for stays that began after the upgrade, and harmless there.
 */
function previousPlateField(session: ParkingSession, previousPlate?: string | null): { previous_plate_number?: string } {
	if (!previousPlate || previousPlate === session.plate) return {};
	return { previous_plate_number: previousPlate };
}

export function enqueueUpdate(session: ParkingSession, previousPlate?: string | null): void {
	// Re-posting an open entry refreshes it; posting with exit_time closes it —
	// same upsert endpoint as enqueueEntry/enqueueExit, images included (safe to
	// resend: persistPlateImage overwrites the same object key).
	const entryImage = readImageForUpload(session.entryImagePath);
	if (session.exitAt) {
		const exitImage = readImageForUpload(session.exitImagePath);
		enqueueSync(
			"session.update",
			{
				...scopeField(session),
				...identityField(session),
				...previousPlateField(session, previousPlate),
				plate_number: session.plate,
				entry_time: session.entryAt,
				exit_time: session.exitAt,
				fee_amount: session.feeCents != null ? (session.feeCents / 100).toFixed(2) : 0,
				duration_minutes: session.durationMinutes ?? 0,
				status: session.status,
				free_reason: session.freeReason ?? null,
				...(entryImage ? { entry_image_base64: entryImage } : {}),
				...(exitImage ? { exit_image_base64: exitImage } : {}),
			},
			session.id,
			session.rev,
		);
	} else {
		enqueueSync(
			"session.update",
			{
				...scopeField(session),
				...identityField(session),
				...previousPlateField(session, previousPlate),
				plate_number: session.plate,
				entry_time: session.entryAt,
				...(entryImage ? { entry_image_base64: entryImage } : {}),
			},
			session.id,
			session.rev,
		);
	}
	scheduleDrain();
}

/**
 * Push a payment transaction to qparking SaaS (/transactions/upsert). Idempotent
 * on local_transaction_id, so re-sending the same attempt (pending → paid) just
 * updates the cloud row. The cloud correlates it to the parking record by plate.
 */
export function enqueueTransaction(session: ParkingSession, txn: Transaction): void {
	// Resolve the durable device identity so the cloud can attribute the charge
	// to a specific terminal even after a local id renumber / device delete.
	const terminal = txn.terminalId ? getTerminal(txn.terminalId) : null;
	enqueueSync("transaction.upsert", {
		local_transaction_id: txn.localTransactionId,
		plate_number: session.plate,
		status: txn.status,
		amount: (txn.amountCents / 100).toFixed(2),
		payment_method: txn.paymentMethod ?? null,
		card_number: txn.cardNumber ?? null,
		order_id: txn.orderId ?? null,
		payment_timestamp: txn.paymentTimestamp ?? null,
		appr_code: txn.apprCode ?? null,
		pay_type: txn.payType ?? null,
		// Which payment device rang up the charge — the cloud "source" column.
		terminal_name: txn.terminalName ?? null,
		terminal_external_id: terminal?.externalId ?? null,
	});
	scheduleDrain();
}

export function enqueueDelete(session: ParkingSession): void {
	// No session id attached: the row is being deleted locally, so there is nothing
	// left to stamp a sync watermark on by the time this drains.
	enqueueSync("session.delete", {
		...scopeField(session),
		plate_number: session.plate,
		entry_time: session.entryAt,
	});
	scheduleDrain();
}

let drainTimer: NodeJS.Timeout | null = null;
let scheduleHandle: NodeJS.Timeout | null = null;

/** Kick a drain on the next tick (debounced). */
function scheduleDrain() {
	if (scheduleHandle) return;
	scheduleHandle = setTimeout(() => {
		scheduleHandle = null;
		void drainOnce();
	}, 50);
}

/**
 * Start the background drain. Called once at boot. Safe to call multiple
 * times — subsequent calls are no-ops.
 */
export function startSyncDrain(): void {
	if (drainTimer) return;
	// Kick an initial drain so anything left over from the previous run
	// ships immediately on app start.
	scheduleDrain();
	drainTimer = setInterval(() => {
		void drainOnce();
	}, DRAIN_INTERVAL_MS);
}

async function drainOnce(): Promise<void> {
	if (inFlight) return;
	inFlight = true;
	syncEvents.emit("status", getSyncStatus());

	try {
		const dueRows = listDueSync();
		if (dueRows.length === 0) return;

		if (!getCloudApi()) {
			// Not configured yet — leave rows pending; they'll retry once the
			// operator fills in URL + key in Settings.
			lastError = "qparking_not_configured";
			return;
		}

		if (!isBoundToCurrentSite()) {
			// Key points at a site this box isn't provisioned for (pending
			// re-provision). Hold the queue rather than pushing the old site's
			// sessions to the new site. A confirmed rebind clears the queue anyway.
			lastError = "site_not_bound";
			return;
		}

		for (const row of dueRows) {
			const result = await sendParkingRecord(row.op, row.payload);
			if (result.ok) {
				markSyncOk(row.id);
				lastSuccessAt = new Date().toISOString();
				lastError = null;
			} else {
				// A push that TIMED OUT while carrying photos gets them taken off
				// before the next attempt, so the record is never held hostage by an
				// upload. Only on a timeout: a 4xx/5xx is the server rejecting the
				// record itself, and stripping images would not help it.
				if (result.timedOut) splitImagesOff(row);
				const nextAttempt = row.attempts + 1;
				if (nextAttempt >= MAX_ATTEMPTS) {
					markSyncFailed(row.id, result.error || "unknown_error");
				} else {
					const delay = BACKOFF_MS[Math.min(nextAttempt, BACKOFF_MS.length - 1)];
					markSyncRetry(row.id, result.error || "unknown_error", delay);
				}
				lastError = result.error || "unknown_error";
			}
			syncEvents.emit("status", getSyncStatus());
		}
	} catch (e: any) {
		lastError = e?.message ?? String(e);
	} finally {
		lastDrainAt = new Date().toISOString();
		inFlight = false;
		syncEvents.emit("status", getSyncStatus());
	}
}

async function sendParkingRecord(
	op: SyncOp,
	payload: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string; status?: number; timedOut?: boolean }> {
	const cloud = getCloudApi();
	if (!cloud) return { ok: false, error: "qparking_not_configured" };
	// Transactions have their own endpoint (the payment ledger). All session ops
	// hit parking-records/upsert — the server differentiates entry vs exit vs
	// update by what fields are present (exit_time present = closing record;
	// absent = open/update). Delete is the exception: a body flag the server
	// recognises as "soft-delete this record".
	if (op === "transaction.upsert") {
		try {
			const response = await cloud.post("/transactions/upsert", payload, { timeout: timeoutForPayload(payload) });
			return { ok: true, status: response.status };
		} catch (error: any) {
			if (axios.isAxiosError(error) && error.response) {
				const responseBody: any = error.response.data;
				const message = responseBody?.message || responseBody?.error || error.response.statusText;
				return { ok: false, status: error.response.status, error: `${error.response.status} ${message}` };
			}
			const isTimeout = axios.isAxiosError(error) && error.code === "ECONNABORTED";
			return { ok: false, timedOut: isTimeout, error: isTimeout ? `timeout (${Math.round(timeoutForPayload(payload) / 1000)}s)` : (error?.message ?? String(error)) };
		}
	}
	const body = op === "session.delete" ? { ...payload, _delete: true } : payload;
	try {
		const response = await cloud.post("/parking-records/upsert", body, { timeout: timeoutForPayload(body) });
		return { ok: true, status: response.status };
	} catch (error: any) {
		if (axios.isAxiosError(error) && error.response) {
			const responseBody: any = error.response.data;
			const message = responseBody?.message || responseBody?.error || error.response.statusText;
			return { ok: false, status: error.response.status, error: `${error.response.status} ${message}` };
		}
		const isTimeout = axios.isAxiosError(error) && error.code === "ECONNABORTED";
		return { ok: false, timedOut: isTimeout, error: isTimeout ? `timeout (${Math.round(timeoutForPayload(body) / 1000)}s)` : (error?.message ?? String(error)) };
	}
}

// Exposed for tools/session-sync-check: both are pure decisions about a payload,
// and the money-relevant half of this module is exactly those decisions. Prefixed
// so nothing in the app is tempted to call them.
export const __test_timeoutForPayload = timeoutForPayload;
export const __test_splitImagesOff = splitImagesOff;

/** Manual drain — called when operator hits "Retry now" on the dashboard. */
export async function drainNow(): Promise<SyncStatus> {
	await drainOnce();
	return getSyncStatus();
}

/**
 * Backfill: enqueue every existing local session into the sync queue so the
 * SaaS catches up on records that pre-date the auto-sync wiring. Idempotent
 * on the SaaS side (upsertParkingRecord matches by site_id + plate_number
 * with open exit_time), so re-running this is safe. Returns the count of
 * rows queued.
 */
export function backfillAllSessions(): { entries: number; exits: number } {
	// Import here to avoid the circular import that would trigger if we
	// pulled this in at module-load time (db.ts → cloud-queue.ts → db.ts).
	const db = require("./db") as typeof import("./db");
	const allSessions = db.listRecentSessions(10_000);
	let entries = 0,
		exits = 0;
	for (const session of allSessions) {
		if (session.exitAt) {
			enqueueExit(session);
			exits++;
		} else {
			enqueueEntry(session);
			entries++;
		}
	}
	scheduleDrain();
	return { entries, exits };
}

/**
 * Backfill: enqueue every local transaction into the sync queue so the cloud
 * ledger catches up on rows that never got pushed (pre-dating the auto-sync
 * wiring, imported/manual rows, or attempts made while the cloud was down).
 * Idempotent on the SaaS side (upsert keyed on local_transaction_id), so
 * re-running is safe — a "paid" row just updates its cloud twin. Transactions
 * whose session is gone are skipped (the cloud correlates by the session's
 * plate). Returns the count enqueued.
 */
export function backfillAllTransactions(): { transactions: number } {
	const db = require("./db") as typeof import("./db");
	const rows = db.listTransactionsPage({ limit: 100_000, offset: 0 });
	let transactions = 0;
	for (const txn of rows) {
		const session = db.getSessionById(txn.sessionId);
		if (!session) continue; // no session → can't correlate by plate
		enqueueTransaction(session, txn);
		transactions++;
	}
	scheduleDrain();
	return { transactions };
}
