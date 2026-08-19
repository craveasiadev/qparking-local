/**
 * Heartbeat: report this box's device reachability up to qparking SaaS every 60s
 * so the cloud's equipment pages can show live status, not just mirrored config.
 *
 * WHY THIS DOES NOT USE cloud-queue
 * ---------------------------------
 * cloud-queue is durable-with-backoff, which is exactly right for sessions and
 * transactions: they are facts that must eventually land, in order, whenever the
 * WAN returns. A heartbeat is the opposite kind of message. It is a statement
 * about NOW, and a stale one is actively harmful — replaying a queued "camera 3
 * online" ten minutes after the fact would resurrect a dead camera on the
 * operator's screen. So this is fire-and-forget: if the post fails, it is
 * dropped, and the next tick tells the truth about the new now.
 *
 * WHY THE CLOUD CANNOT JUST TRUST WHAT WE SEND
 * --------------------------------------------
 * This box cannot report its own death. If the PC is off, the app is closed, or
 * the WAN is down, no "offline" ever arrives — the last thing the cloud heard
 * would be "all online", and it would keep saying so forever. So the contract is
 * that the CLOUD derives status from heartbeat freshness (a dead-man switch) and
 * treats a site it has not heard from as unknown, never as healthy. Our job here
 * is only to be punctual and honest.
 *
 * WHY WE SEND `changed_at` RATHER THAN LETTING THE CLOUD STAMP IT
 * --------------------------------------------------------------
 * The operator is shown the absolute time a device went down. Only this box knows
 * that instant: if the WAN happens to be down when a camera dies, the cloud does
 * not find out until the link returns, and a cloud-side `now()` would date the
 * failure to the recovery instead of the outage. The local clock owns it.
 */
import { getCloudApi, describeRequestError } from './cloud-api';
import { isBoundToCurrentSite } from './db';
import { snapshotDeviceHealth, deviceHealthEvents } from './device-health';
import type { DeviceHealth } from '../../shared/types';
import { app } from 'electron';

/**
 * How often the heartbeat is posted. Matched to the probe sweep
 * (HEALTH_PROBE_INTERVAL_MS) — posting faster would just resend identical rows,
 * and posting slower would make the cloud's staleness window pointlessly wide.
 */
export const HEARTBEAT_INTERVAL_MS = 60_000;

/** In-memory report of the last attempt, for the Settings/Dashboard sync panel. */
export interface HeartbeatState {
  lastPostAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
}
let state: HeartbeatState = { lastPostAt: null, lastOkAt: null, lastError: null };

export function getHeartbeatState(): HeartbeatState {
  return state;
}

let timer: NodeJS.Timeout | null = null;
/** Pending trailing post, when changes arrived inside the coalescing window. */
let trailingPost: NodeJS.Timeout | null = null;
/** One post at a time: a 10s cloud timeout must not let ticks pile up. */
let inFlight = false;

/** Wire shape for one device. snake_case — this is the cloud's vocabulary. */
interface DeviceHealthWire {
  type: DeviceHealth['kind'];
  external_id: string;
  status: DeviceHealth['status'];
  via: DeviceHealth['via'];
  changed_at: string;
  checked_at: string;
  last_online_at: string | null;
  latency_ms: number | null;
  detail: string | null;
}

function toWire(row: DeviceHealth): DeviceHealthWire | null {
  // A device that has never been pushed to the cloud has no row there to attach
  // health to. Skipping it is correct: inventing an id would create a phantom
  // device the operator cannot reconcile against anything.
  if (!row.externalId) return null;
  return {
    type: row.kind,
    external_id: row.externalId,
    status: row.status,
    via: row.via,
    changed_at: row.changedAt,
    checked_at: row.checkedAt,
    last_online_at: row.lastOnlineAt,
    latency_ms: row.latencyMs,
    detail: row.detail,
  };
}

export interface HeartbeatResult {
  ok: boolean;
  /** Devices actually reported (those with a cloud identity). */
  sent: number;
  /** Devices held back because they have never been pushed to the cloud. */
  skipped: number;
  error?: string;
}

/**
 * Post the current snapshot once. Never throws — the caller is a timer.
 *
 * Uses the snapshot rather than forcing a sweep: device-health.ts is already
 * sweeping on its own 60s timer, and probing every device twice per minute to
 * satisfy a reporting concern would double the load on vendor hardware for no
 * extra information.
 */
export async function postHeartbeat(): Promise<HeartbeatResult> {
  if (inFlight) return { ok: false, sent: 0, skipped: 0, error: 'in_flight' };

  const cloud = getCloudApi();
  if (!cloud) return { ok: false, sent: 0, skipped: 0, error: 'qparking_not_configured' };
  // Same guard as device-push: while the box is not bound to the site its key
  // resolves to, anything we send would land on the wrong site's equipment.
  if (!isBoundToCurrentSite()) return { ok: false, sent: 0, skipped: 0, error: 'site_not_bound' };

  const rows = snapshotDeviceHealth();
  const devices = rows.map(toWire).filter((d): d is DeviceHealthWire => d !== null);
  const skipped = rows.length - devices.length;

  inFlight = true;
  state = { ...state, lastPostAt: new Date().toISOString() };
  try {
    // Sent even when `devices` is empty: an empty report still proves the box is
    // alive, which is the difference between "this site has no equipment" and
    // "we have no idea what is happening at this site".
    await cloud.post('/device-health', {
      reported_at: new Date().toISOString(),
      app_version: app.getVersion(),
      devices,
    });
    state = { ...state, lastOkAt: new Date().toISOString(), lastError: null };
    return { ok: true, sent: devices.length, skipped };
  } catch (error) {
    const message = describeRequestError(error);
    state = { ...state, lastError: message };
    return { ok: false, sent: 0, skipped, error: message };
  } finally {
    inFlight = false;
  }
}

/**
 * Shortest gap between two event-driven posts.
 *
 * The sweep also runs whenever equipment is saved, deleted or pulled from the
 * cloud, so a burst of edits emits a burst of 'health' events. The status barely
 * differs between them and the cloud only needs the latest, so collapse them.
 */
const MIN_EVENT_POST_GAP_MS = 5_000;

/** Age of the last post attempt, or Infinity if we have never posted. */
function msSinceLastPost(): number {
  if (!state.lastPostAt) return Number.POSITIVE_INFINITY;
  return Date.now() - new Date(state.lastPostAt).getTime();
}

export function startHealthHeartbeat(): void {
  if (timer) return;

  // PRIMARY path: post as soon as a sweep publishes, so a dropped device reaches
  // the cloud within seconds of being detected rather than waiting out a full
  // interval on top of the sweep's own.
  deviceHealthEvents.on('health', () => {
    const wait = MIN_EVENT_POST_GAP_MS - msSinceLastPost();
    if (wait <= 0) {
      void postHeartbeat();
      return;
    }
    // Inside the coalescing window: DEFER, never drop. Dropping was a latency
    // bug waiting to happen — a device that died a second after a heartbeat had
    // its change thrown away, and the cloud then waited out the whole fallback
    // interval to hear about it. One trailing post covers any number of changes
    // that land in the window.
    if (trailingPost) return;
    trailingPost = setTimeout(() => {
      trailingPost = null;
      void postHeartbeat();
    }, wait);
  });

  // FALLBACK path only. The sweep emits every 60s, so in normal operation this
  // finds a fresh post and does nothing — which is the point of the freshness
  // check. It exists for the case where a sweep throws before it can emit: the
  // box would otherwise go silent, and silence is exactly what the cloud reads as
  // "this site is dead". A heartbeat must not depend on the probe succeeding.
  timer = setInterval(() => {
    if (msSinceLastPost() < HEARTBEAT_INTERVAL_MS * 0.9) return;
    void postHeartbeat();
  }, HEARTBEAT_INTERVAL_MS);
}

export function stopHealthHeartbeat(): void {
  if (timer) { clearInterval(timer); timer = null; }
  if (trailingPost) { clearTimeout(trailingPost); trailingPost = null; }
}
