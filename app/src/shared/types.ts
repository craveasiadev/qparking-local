/**
 * Types shared between the main (Node/Electron) and renderer (React) processes.
 * Keep zero runtime dependencies in this file — it must be safely importable
 * from both sides.
 *
 * Split by role:
 *   db-models.ts → SQLite table row shapes (re-exported here, so importing
 *                  from './types' keeps working everywhere)
 *   this file    → runtime status objects, wire-protocol envelopes, and the
 *                  BridgeApi contract that types `window.bridge`
 */
export * from "./schema";

import type {
	SeasonPass,
	BlockedPlate,
	CloudCustomer,
	CloudVehicle,
	AppSettings,
	LcdDisplay,
	LcdDisplayStatus,
	LprCamera,
	ParkingLane,
	ParkingSession,
	ParkingSpace,
	PaymentTerminal,
	RatePolicy,
	Site,
	ActivityLog,
	Transaction,
} from "./schema";

// ─── runtime status objects (never persisted) ────────────────────────────────

/** One problem row in the outbound sync queue — a push that failed at least
 *  once (still retrying) or exhausted its retries. Surfaced per-row on the
 *  Dashboard so an operator/dev can see exactly WHICH record failed and WHY
 *  instead of only the single global last-error line. */
export interface SyncIssue {
	id: number;
	/** e.g. 'session.exit', 'transaction.upsert'. */
	op: string;
	/** A human handle for the record — plate number, or transaction id. */
	ref: string | null;
	status: "pending" | "failed";
	attempts: number;
	lastError: string | null;
	/** When the next auto-retry is due (pending rows only). */
	nextAttemptAt: string | null;
}

/** The three kinds of LAN equipment whose reachability we monitor. */
export type DeviceHealthKind = "camera" | "terminal" | "lcd";

/**
 * Reported reachability of one device.
 *
 * `disabled` is a first-class status, not a flavour of offline: an operator who
 * switched a panel off for maintenance must not see an alarm, and the cloud must
 * not count it against the site's "x/y online" roll-up.
 */
export type DeviceHealthStatus = "online" | "offline" | "disabled";

/**
 * How the verdict was reached — and therefore how much it is worth.
 *
 * This is not diagnostics trivia; it is the honesty marker on the status. A
 * camera reporting `online` via `http` means only "something answered on that
 * port", NOT "the camera is working" — only `sdk` proves that. The UI must not
 * present the two as the same claim.
 *
 *   sdk    — vendor SDK handle reports connected (authoritative, cameras)
 *   link   — our own persistent socket is up (authoritative, LCD panels)
 *   tcp    — a socket opened and closed; port is listening
 *   http   — an HTTP request came back
 *   config — no probe ran (device is disabled)
 */
export type DeviceHealthVia = "sdk" | "link" | "tcp" | "http" | "config";

/** Live reachability of one device, as owned by the main process. */
export interface DeviceHealth {
	kind: DeviceHealthKind;
	deviceId: number;
	/** Stable id shared with the cloud; null on a device never pushed up. */
	externalId: string | null;
	name: string;
	/** `host:port`, for display. */
	address: string;
	status: DeviceHealthStatus;
	/**
	 * ISO. When the CURRENT status began — the moment of the first failed probe,
	 * not the moment we last checked.
	 *
	 * This is the field the UI actually shows ("offline since 10:23:45"), and the
	 * local box owns it on purpose: the cloud only learns of an outage on the next
	 * successful heartbeat, so a cloud-side stamp would date every failure that
	 * happened during a WAN outage to whenever the WAN came back.
	 */
	changedAt: string;
	/** ISO. The most recent probe, whatever it found. */
	checkedAt: string;
	/** ISO. Last probe that found the device up; null if it never has been. */
	lastOnlineAt: string | null;
	latencyMs: number | null;
	/** Operator-readable reason, when there is one to give. */
	detail: string | null;
	via: DeviceHealthVia;
}

/** Status snapshot for the outbound sync queue (Dashboard panel). */
export interface SyncStatus {
	pending: number;
	failed: number;
	inFlight: boolean;
	oldestPending: string | null;
	lastDrainAt: string | null;
	lastSuccessAt: string | null;
	lastError: string | null;
	/** Rows that failed at least once (pending-with-error or failed), newest and
	 *  most-severe first. Empty when everything is flowing cleanly. */
	issues: SyncIssue[];
}

/** The cloud-owned caches a pull refreshes — one key per mirror in syncAll()'s
 *  report. Broadcast on the 'cloud-mirrors' event after every pull so a page
 *  showing one of these lists can re-read it instead of rendering whatever it
 *  loaded on mount. */
export type CloudMirror =
	| "site"
	| "companySetting"
	| "policies"
	| "passes"
	| "blockedPlates"
	| "customers"
	| "vehicles"
	| "spaces"
	| "activity"
	| "sessions";

/** Per-item outcome of pushing one local equipment row up to the cloud
 *  registry (lane / terminal / camera), surfaced in the Settings sync report. */
export interface EquipmentPushItem {
	id: number;
	name: string;
	ok: boolean;
	/** True when the push was intentionally skipped (e.g. the lane has no rate
	 *  policy), rather than a genuine failure — rendered as a warning, not error. */
	skipped?: boolean;
	error?: string;
}

/** One of the manually-synced equipment types (one per device page). */
export type DeviceSyncType = "cameras" | "lanes" | "terminals" | "lcds";

/** Diff counts shown in the Push/Pull confirmation modal before committing. */
export interface DeviceSyncPreview {
	ok: boolean;
	error?: string;
	localCount: number;
	cloudCount: number;
	/** Push: cloud rows to be soft-deleted. Pull: local rows to be deleted. */
	toRemove: number;
	toUpdate: number;
	toAdd: number;
}

/**
 * The vocabulary the cloud will accept for a pushed audit row.
 *
 * These MUST mirror qparking's `App\Enum\ActivityLog\{Action,Category,ResourceType}`.
 * They're unions rather than plain strings because the ingest endpoint maps every
 * incoming row onto those enums and REJECTS what it can't map — and for months
 * two writers here quietly emitted values that don't exist there
 * ('manual_open', 'app_settings' before it was added), which used to fail the
 * whole batch and blocked this box's entire audit trail from ever reaching the
 * cloud. A compile error is the right place to find that out.
 *
 * Adding a value here means adding the matching case in the cloud enum first.
 */
export type ActivityLogAction =
	| "create" | "edit" | "delete" | "approve" | "reject" | "status_change"
	| "login" | "logout" | "export" | "access"
	| "entry" | "exit" | "payment" | "manual_release";

export type ActivityLogCategory =
	| "parking" | "payment" | "gate" | "session"
	| "config" | "device" | "sync" | "lifecycle" | "security";

export type ActivityLogResourceType =
	| "adjustment" | "refund" | "role" | "impersonation"
	| "camera_device" | "local_lane" | "local_terminal" | "local_lcd"
	| "parking_record" | "rate_policy" | "transaction" | "vehicle" | "app_settings";

/** Free-text on the wire (a plain 16-char column), but keep to this set so the
 *  Activity Log page's outcome badge and filters stay meaningful. */
export type ActivityLogOutcome = "ok" | "failed" | "blocked" | "declined" | "timeout" | "skipped";

export interface ActivityLogPayload {
	eventKey: string;
	action: ActivityLogAction;
	category: ActivityLogCategory;
	severity?: ActivityLog["severity"];
	outcome?: ActivityLogOutcome | null;
	resourceType?: ActivityLogResourceType | null;
	resourceId?: string | null;
	correlationId?: string | null;
	description?: string | null;
	changes?: Record<string, unknown> | null;
	actorName?: string | null;
	siteId?: string | null;
	pushedToCloud?: boolean;
	pushedAt?: string | null;
	syncError?: string | null;
}

export interface DevicePushResult {
	ok: boolean;
	error?: string;
	items?: EquipmentPushItem[];
	removed?: number;
}
export interface DevicePullResult {
	ok: boolean;
	error?: string;
	applied?: number;
}

// ─── the bridge contract ─────────────────────────────────────────────────────

/** What the bridge exposes to the renderer. Every method returns a Promise. */
export interface BridgeApi {
	// Payment terminals (Alarmtech W4G devices) — CRUD
	listTerminals(): Promise<PaymentTerminal[]>;
	saveTerminal(input: Omit<PaymentTerminal, "id" | "externalId" | "createdAt" | "updatedAt"> & { id?: number }): Promise<PaymentTerminal>;
	deleteTerminal(id: number): Promise<void>;
	/** TCP reachability probe by host:port — backs the per-device "Test
	 *  connection" button (works against the form values before saving). */
	pingTerminalHost(input: { host: string; port: number }): Promise<{ ok: boolean; latencyMs?: number; error?: string }>;

	// ─── device health ───────────────────────────────────────────────────────
	// Reachability is owned by the MAIN process (services/device-health.ts) and
	// PUSHED here on the 'device-health' event. Pages must not run their own ping
	// loops: they used to, which is why health froze whenever the operator left
	// the Dashboard — and why the cloud had nothing to be told.
	/** Last known reachability of every device. Returns immediately, no probing. */
	getDeviceHealth(): Promise<DeviceHealth[]>;
	/** Force a sweep now and return its result — backs a manual "refresh" and is
	 *  worth calling straight after saving a device, so the operator sees the
	 *  consequence of an address change without waiting out the 60s tick. */
	refreshDeviceHealth(): Promise<DeviceHealth[]>;
	/** Last heartbeat attempt to the cloud — proves the reporting link, which is
	 *  a different question from whether the devices themselves are up. */
	getHeartbeatState(): Promise<{ lastPostAt: string | null; lastOkAt: string | null; lastError: string | null }>;
	/** Post the current snapshot to the cloud now. Lets an installer prove the
	 *  link from this box rather than going to look at the SaaS. */
	reportHealthNow(): Promise<{ ok: boolean; sent: number; skipped: number; error?: string }>;

	// Driver-facing LCD panels (the qparking-lcd Android app) — CRUD + link health
	listLcds(): Promise<LcdDisplay[]>;
	saveLcd(input: Omit<LcdDisplay, "id" | "externalId" | "createdAt" | "updatedAt"> & { id?: number }): Promise<LcdDisplay>;
	deleteLcd(id: number): Promise<void>;
	/** Live connection health for every configured panel. */
	getLcdStatuses(): Promise<LcdDisplayStatus[]>;
	/** Drive a sample fare → thank-you → idle sequence at an address, so the
	 *  wiring can be proved from the form before anything is saved. */
	testLcd(input: { host: string; port: number }): Promise<{ ok: boolean; latencyMs?: number; error?: string }>;

	// LPR cameras
	listCameras(): Promise<LprCamera[]>;
	saveCamera(input: Omit<LprCamera, "id" | "externalId" | "createdAt" | "updatedAt"> & { id?: number }): Promise<LprCamera>;
	deleteCamera(id: number): Promise<void>;
	/** Latest frame the camera PUSHED with a plate event (base64 JPEG). Live
	 *  display fallback for WebSocket/RTSP-only cameras with no snapshot URL.
	 *  Null until the camera has pushed at least one frame. */
	getCameraLatestFrame(cameraId: number): Promise<{ base64: string; contentType: string; at: string } | null>;
	/** Probe TCP/HTTP reachability — used by the "Test connection" button. */
	pingCamera(cameraId: number): Promise<{ ok: boolean; status?: number; latencyMs?: number; error?: string }>;
	/** Probe reachability by host:port directly — lets "Test connection" run
	 *  against the form values before the camera is saved. */
	/** `ok` means the device ANSWERED, not that the answer was 2xx — any HTTP reply
	 *  proves it is on the network, which is the only thing this probe establishes.
	 *  `needsAuth` marks a 401/403/login-redirect: reachable, but not open. */
	pingCameraHost(input: { host: string; port?: number }): Promise<{ ok: boolean; status?: number; latencyMs?: number; needsAuth?: boolean; error?: string }>;
	/** Kill and respawn every live video feed, and re-attempt any barrier handle
	 *  that never came up — what the Live display's "Refresh cameras" button does
	 *  before it remounts its tiles. `feeds` is how many are running afterwards.
	 *  Needed because a camera that comes online AFTER the app started is invisible
	 *  to the config-driven resync: nothing changed, so nothing gets retried. */
	restartCameraStreams(): Promise<{ ok: boolean; feeds: number }>;

	// Lanes
	listLanes(): Promise<ParkingLane[]>;
	/** The lane is the composition root: it owns which cameras cover it
	 *  (`cameraIds` → each camera's lane_id) and which payment terminal it
	 *  charges on (`terminalId`). Passing `cameraIds` reassigns exactly that
	 *  set of cameras to this lane and unassigns any others previously on it. */
	saveLane(input: Omit<ParkingLane, "id" | "externalId"> & { id?: number; cameraIds?: number[] }): Promise<ParkingLane>;
	deleteLane(id: number): Promise<void>;

	// Manual equipment sync (per device page): mirror local → cloud, or replace
	// local ← cloud. Both destructive; the UI previews the diff and confirms first.
	previewDeviceSync(type: DeviceSyncType, direction: "push" | "pull"): Promise<DeviceSyncPreview>;
	pushDevicesToCloud(type: DeviceSyncType): Promise<DevicePushResult>;
	pullDevicesFromCloud(type: DeviceSyncType): Promise<DevicePullResult>;

	// Sessions
	listOpenSessions(): Promise<ParkingSession[]>;
	listRecentSessions(limit: number): Promise<ParkingSession[]>;
	listSessionsPage(opts: {
		tab: "open" | "recent";
		limit: number;
		offset: number;
		/** Case-insensitive contains-match on plate — for reconciling
		 *  mis-read exits ("ABC" entry vs "ABX" exit). */
		plateSearch?: string | null;
		/** ISO datetime range on entry_at (inclusive). */
		entryFrom?: string | null;
		entryTo?: string | null;
		/** ISO datetime range on exit_at (inclusive). */
		exitFrom?: string | null;
		exitTo?: string | null;
		/** Exact journey-status match (entered / exited / manual_release). */
		status?: string | null;
		/** Exact payment-status match (paid / pending / declined / …). */
		paymentStatus?: string | null;
	}): Promise<{
		/** Open rows carry `livePreviewFeeCents` — the current fee computed
		 *  server-side with the real rules-aware calc (the UI can't run it). */
		rows: Array<ParkingSession & { livePreviewFeeCents?: number | null }>;
		counts: { open: number; total: number };
	}>;
	/** How many sessions qparking SaaS is missing, or holding a stale copy of
	 *  (never delivered, or changed locally since it was last acknowledged). */
	countUnsyncedSessions(): Promise<number>;
	/** Re-enqueue every one of those and drain the queue now. `remaining` is the
	 *  count still unacknowledged afterwards — non-zero means the cloud refused
	 *  or was unreachable, and each session carries its own error. */
	pushUnsyncedSessions(): Promise<{
		queued: number;
		remaining: number;
		status: SyncStatus;
	}>;
	/** Manually retrigger the exit payment flow for a stuck session. Fires
	 *  the terminal (ECPI initCard + W4G PayRequest race) using the lane +
	 *  terminal wired to the session's lane. Returns immediately; the actual
	 *  card tap resolves asynchronously through the normal parking-flow. */
	retriggerSessionPayment(id: number, laneId?: number | null): Promise<{ ok: boolean; error?: string }>;
	/** Retrigger exit payment for whichever open session holds this plate — the
	 *  Live-display action where the operator types the plate off the feed.
	 *  `laneId` is the exit lane the operator triggered from, so the exit runs on
	 *  that gate's controller. */
	retriggerSessionPaymentByPlate(plate: string, laneId?: number | null): Promise<{ ok: boolean; error?: string }>;
	/** DEV/QA: open a session stamped with a chosen entry time (no gate/terminal). */
	/** `ok` means the event was dispatched. What the FLOW decided is `sessionId`
	 *  (a car got in) or `refused` (the guard that turned it away) — both absent
	 *  when neither arrived inside the wait, which the flow log explains. */
	simulateEntry(laneId: number, plate: string, entryIso: string): Promise<{ ok: boolean; error?: string; sessionId?: number; refused?: string }>;
	/** DEV/QA: run the real exit flow (fee + terminal) at a chosen exit time. */
	simulateExit(laneId: number, plate: string, exitIso: string): Promise<{ ok: boolean; error?: string; cameraId?: number }>;
	/** Read a session capture (entry/exit image) off disk as base64 for display —
	 *  the renderer can't load the raw file:// path over its http/app origin. */
	readSessionImage(filePath: string): Promise<{ base64: string; contentType: string } | null>;
	deleteSession(id: number): Promise<boolean>;
	manualReleaseSession(id: number, reason: string, laneId?: number | null): Promise<void>;
	updateSession(
		id: number,
		patch: {
			plate?: string;
			entryAt?: string;
			exitAt?: string | null;
			paymentStatus?: "pending" | "paid" | "declined" | "cancelled" | "free" | "manual_release";
			notes?: string;
			policyIdOverride?: string | null;
		},
	): Promise<ParkingSession>;

	// Transactions — every payment attempt (W4G PayRequest → PayResult) across
	// all sessions, newest first. `search` matches orderId / plate / card number.
	listTransactionsPage(opts: {
		limit: number;
		offset: number;
		search?: string | null;
		status?: string | null;
		/** Inclusive lower / exclusive upper UTC ISO bounds. The Transactions page
		 *  maps the operator's GMT+8 day selection to this UTC range. */
		dateFrom?: string | null;
		dateTo?: string | null;
	}): Promise<{
		rows: Array<
			Transaction & {
				plate: string | null;
				sessionStatus: string | null;
				entryLaneId: number | null;
				exitLaneId: number | null;
			}
		>;
		total: number;
	}>;

	// Mirrored config from qparking SaaS (read-only locally)
	listParkingSpaces(): Promise<ParkingSpace[]>;
	syncParkingSpacesNow(): Promise<{ ok: boolean; fetched: number; error?: string }>;
	/** Read every active pass cached from the cloud. Already populated by the
	 *  periodic syncSeasonPasses(); this just lets the UI display them. */
	listSeasonPasses(): Promise<SeasonPass[]>;
	/** Force a fresh pull of the pass roster from the cloud. The 5-minute
	 *  gate-critical tick does this too — this is the operator's "I just issued a
	 *  pass and the holder is AT the barrier, get it down here now" button. */
	syncSeasonPassesNow(): Promise<{ ok: boolean; fetched: number; error?: string }>;
	/** Pull the deny list the GATE enforces on (blocked_plates). Separate from the
	 *  vehicle registry the Vehicles page displays: refreshing the badges without
	 *  this left the barrier working off a stale ban list. The 5-minute
	 *  gate-critical tick pulls it too; this forces it immediately. */
	syncBlockedPlatesNow(): Promise<{ ok: boolean; fetched: number; error?: string }>;
	/** All banned plates cached locally — the Admit box reads this to show a
	 *  plate's ban state before staff press Admit. */
	listBlockedPlates(): Promise<BlockedPlate[]>;
	/** Today's entry count and takings, aggregated in SQL over the whole table.
	 *  Bounds are the GMT+8 calendar day expressed as UTC instants — use
	 *  appTzDayStartUtc / appTzDayEndUtc from renderer/lib/datetime. Revenue comes
	 *  from the transactions ledger, so a stay that collected two payments counts
	 *  both and a voided attempt counts neither. */
	dayTotals(opts: { dayStartUtc: string; dayEndUtc: string }): Promise<{
		entries: number;
		revenueCents: number;
		paidCount: number;
	}>;
	pushActivityLogsToCloudNow(): Promise<{ ok: boolean; fetched: number; error?: string }>;
	/** Read-only customer + vehicle directories, so staff can look an owner up at
	 *  the gate without opening the cloud portal. Not on the background tick —
	 *  refresh via these sync calls or Settings → Sync now. */
	listCloudCustomers(): Promise<CloudCustomer[]>;
	syncCloudCustomersNow(): Promise<{ ok: boolean; fetched: number; error?: string }>;
	listCloudVehicles(): Promise<CloudVehicle[]>;
	syncCloudVehiclesNow(): Promise<{ ok: boolean; fetched: number; error?: string }>;

	// Rate policies
	listRatePolicies(): Promise<RatePolicy[]>;
	syncRatePoliciesNow(): Promise<{ ok: boolean; fetched: number; error?: string }>;

	syncAllNow(): Promise<{
		policies: { ok: boolean; fetched: number; error?: string };
		passes: { ok: boolean; fetched: number; error?: string };
		blockedPlates: { ok: boolean; fetched: number; error?: string };
		customers: { ok: boolean; fetched: number; error?: string };
		vehicles: { ok: boolean; fetched: number; error?: string };
		spaces: { ok: boolean; fetched: number; error?: string };
		site: { ok: boolean; fetched: number; error?: string };
		/** Local equipment pushed UP to the cloud registry, per item. */
		equipment: {
			lanes: EquipmentPushItem[];
			terminals: EquipmentPushItem[];
			cameras: EquipmentPushItem[];
		};
	}>;

	/** Persisted outcome of the last full cloud pull, for the header's "last
	 *  synced" stamp. `lastCloudPullAt` is '' until the first clean pull and is
	 *  NOT refreshed by a failed one; `lastCloudPullError` is '' when clean. */
	getCloudPullState(): Promise<{ lastCloudPullAt: string; lastCloudPullError: string }>;

	/** The site profile mirrored from qparking SaaS (one site per install).
	 *  Populated by the periodic syncSite(); null until the first sync lands. */
	getCurrentSite(): Promise<Site | null>;

	/** Resolve which site a candidate base-URL + API key belongs to WITHOUT
	 *  persisting it, and report whether that differs from the site this box is
	 *  currently bound to. Drives the re-provision confirmation. */
	previewSiteRebind(input: { baseUrl: string; apiKey: string }): Promise<{
		ok: boolean;
		changed?: boolean;
		candidateSite?: { id: string; name: string };
		boundSite?: { id: string; name: string } | null;
		/** Cars still on site right now — a rebind will wipe them; shown in the
		 *  confirm dialog as a warning (does not block the rebind). */
		openSessions?: number;
		error?: string;
	}>;
	/** Commit a re-provision: persist the new credentials, wipe the old site's
	 *  local data (equipment optional), pull the new site and push equipment up. */
	rebindSite(input: { baseUrl: string; apiKey: string; wipeEquipment: boolean }): Promise<{
		ok: boolean;
		site?: { id: string; name: string } | null;
		error?: string;
		[k: string]: unknown;
	}>;

	/** "Test price" — simulate a rate plan's fee for an entry→exit window. */
	simulateRatePolicyFee(input: { policyId: string; entry: string; exit: string }): Promise<{
		ok: boolean;
		feeCents?: number;
		durationMinutes?: number;
		policyName?: string;
		currency?: string;
		error?: string;
	}>;

	// App build metadata — operator-visible version stamp.
	getAppVersion(): Promise<{ version: string; isPackaged: boolean; builtAt: string }>;
	/** Wipe Electron's session cache + storage and reload the renderer. Does
	 *  NOT touch the SQLite app DB. */
	clearAppCache(): Promise<{ ok: boolean; elapsedMs: number; clearedAt: string }>;

	// Outbound sync to qparking SaaS (entry/exit/update/delete with retry).
	getSyncStatus(): Promise<SyncStatus>;
	syncDrainNow(): Promise<SyncStatus>;
	retryFailedSync(): Promise<{ retried: number }>;
	/** Push every existing local session to qparking — one-shot recovery
	 *  for sessions that pre-date the auto-sync wiring. */
	backfillSessions(): Promise<{ entries: number; exits: number }>;
	/** Push every local transaction to the cloud ledger — the Transactions
	 *  page "Sync now" button. Idempotent on local_transaction_id. */
	syncTransactionsNow(): Promise<{ transactions: number; status: SyncStatus }>;

	// Settings + diagnostics
	getSettings(): Promise<AppSettings>;
	saveSettings(s: Partial<AppSettings>): Promise<AppSettings>;
	/** LPR listener health — bound port, LAN addresses cameras can reach, camera count. */
	/** `ports` is the set actually LISTENING — a camera's port missing from it
	 *  failed to bind, which is the difference between "wired wrong" and
	 *  "something else holds the port". */
	diagnoseLpr(): Promise<{ ports: number[]; addresses: string[]; cameras: number }>;

	// Barrier
	/** Operator "open barrier" for a lane/camera — pulses that camera's onboard
	 *  IO relay unconditionally. `ok` reflects whether the relay actually fired. */
	manualOpenGate(opts: { cameraId?: number | null; laneId?: number | null }): Promise<{ ok: boolean; note?: string }>;
	/**
	 * Open a stay for a car BY HAND, for a plate the camera cannot read or an entry
	 * camera that is down. Runs the real entry flow (blacklist, quota, barrier pulse,
	 * cloud push, audit) and waives only Only Pass Allow.
	 *
	 * Still refuses a banned plate and a car already inside; entry time is always now.
	 */
	admitVehicle(input: { laneId: number; plate: string }): Promise<{ ok: boolean; error?: string; cameraId?: number; sessionId?: number; refused?: string }>;

	/** The newest slice of the audit trail plus the total held, so the page can say
	 *  when its view is truncated. Bounded on purpose: the table is filled by an
	 *  unbounded cloud replace-all. */
	listActivityLogs(): Promise<{ rows: ActivityLog[]; total: number }>;
	insertActivityLog(payload: ActivityLogPayload): Promise<void>;

	// App self-update — checks qparking cloud /latest-built endpoint.
	/** Probe the cloud for a newer published build. Reads version from
	 *  package.json on this side, compares semver-style, returns the manifest. */
	appUpdateCheck(): Promise<{
		ok: boolean;
		currentVersion: string;
		latestVersion?: string;
		isNewer?: boolean;
		releasedAt?: string | null;
		notes?: string | null;
		portable?: { filename: string; size: number | null; sha256: string | null; url: string } | null;
		installer?: { filename: string; size: number | null; sha256: string | null; url: string } | null;
		error?: string;
	}>;
	/** Download the chosen variant (portable | installer) to a temp file and
	 *  return its absolute path. Streams progress via 'app-update-progress'
	 *  event so the renderer can show a bar. */
	appUpdateDownload(opts: {
		variant: "portable" | "installer";
		/** The digest /latest-built published for this variant. Pass it and the
		 *  download is refused on mismatch; omit it and nothing can be checked. */
		expectedSha256?: string | null;
	}): Promise<{
		ok: boolean;
		path?: string;
		bytes?: number;
		sha256?: string;
		expectedSha256?: string | null;
		/** false = the cloud published no digest, so integrity was NOT checked. */
		verified?: boolean;
		error?: string;
	}>;
	/** Launch the downloaded build via the OS and quit the current app so the
	 *  installer/portable can replace it. For NSIS this triggers the standard
	 *  Windows installer wizard; for portable it just opens the new exe. */
	appUpdateApply(opts: { path: string; expectedSha256?: string | null }): Promise<{ ok: boolean; error?: string }>;

	// Touch'n'Go W4G IO-controller bridge
	/** POST a synthetic PayResult into our own listener to verify the receive
	 *  path works end-to-end. If this passes but real device callbacks don't
	 *  land, the issue is purely device-side (URL config / firewall). */
	tngLoopbackPayResult(opts?: { orderId?: string; state?: string; payType?: number; cardNo?: string; balance?: number }): Promise<{
		ok: boolean;
		status?: number;
		responseBody?: string;
		elapsedMs?: number;
		sentBody?: string;
		error?: string;
	}>;
	/** Fire a one-shot PayRequest and wait for the PayResult callback. Used
	 *  by the Settings "Test" trigger to exercise the full round-trip without
	 *  opening a real parking session. Defaults: 100c, no discount, now. */
	tngTestPayRequest(opts?: {
		payAmount?: number;
		discountAmount?: number;
		enterTime?: number;
		payTime?: number;
		orderId?: string;
		/** Target a specific device (multi-device); omitted → the settings device. */
		host?: string;
		port?: number;
	}): Promise<{
		ok: boolean;
		orderId: string;
		deviceState?: number;
		resultState?: string;
		payType?: number;
		cardNo?: string;
		balance?: number;
		stan?: string;
		apprCode?: string;
		error?: string;
	}>;
	/** Fire PayCancel against an order. The device only honours cancel after
	 *  the current deduction times out (~6s per vendor doc). */
	tngTestPayCancel(orderId: string, target?: { host?: string; port?: number }): Promise<{ ok: boolean; deviceState?: number; error?: string }>;
	/** Current state of the W4G integration — running, pending orders, last
	 *  callback at, last error. Used by the Settings page status panel. */
	tngStatus(): Promise<{
		enabled: boolean;
		listening: boolean;
		listenPort: number;
		listenPorts: number[];
		listenAddresses: string[];
		host: string;
		port: number;
		pending: { orderId: string; payAmount: number; startedAt: string }[];
		lastResult?: { orderId: string; status: string; payType?: number; at: string };
		lastError?: string;
	}>;

	// Stream events to renderer (returns an unsubscribe fn)
	onEvent(
		channel: "session" | "log" | "plate-detected" | "sync-status" | "cloud-pull" | "cloud-mirrors" | "parking-flow-log" | "app-update-progress" | "device-health",
		cb: (payload: unknown) => void,
	): () => void;
}

/**
 * Make `window.bridge` fully typed in the RENDERER. This file is included by
 * the renderer tsconfig, so every React page gets autocomplete + type-checking
 * on bridge calls. The implementation side is enforced in preload.ts, which
 * declares its `api` object as `BridgeApi` — if the two ever drift, the main
 * build fails instead of the renderer crashing at runtime.
 */
declare global {
	interface Window {
		bridge: BridgeApi;
	}
}
