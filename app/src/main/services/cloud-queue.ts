/**
 * Outbound push queue to qparking SaaS. Every session state change
 * (entry / update / exit / delete) enqueues a row in `sync_queue` via
 * `db.enqueueSync()`. This module drains the queue with exponential
 * backoff:
 *
 *   attempt 1 → immediate
 *   attempt 2 → +10s
 *   attempt 3 → +30s
 *   attempt 4 → +2min
 *   attempt 5 → +10min
 *   attempt 6+ → marked status='failed'; needs operator retry from UI
 *
 * Why a persistent queue: the SaaS can be unreachable for minutes (VPS
 * reboot, network blip, ISP issue) but parking flow at the gate has to
 * keep working. We push best-effort and replay on recovery. A process
 * restart loses NO sync state because the queue is in SQLite.
 *
 * Exposes a status snapshot for the Dashboard so the operator can see
 * pending/failed counts at a glance.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import axios from 'axios';
import {
  enqueueSync, listDueSync, markSyncOk, markSyncRetry, markSyncFailed,
  syncQueueStats, getLane,
  type SyncOp,
} from './db';
import { getCloudApi } from './cloud-api';
import type { ParkingSession } from '../../shared/types';

const BACKOFF_MS = [0, 10_000, 30_000, 120_000, 600_000];
const MAX_ATTEMPTS = 6;
const DRAIN_INTERVAL_MS = 15_000;

export const syncEvents = new EventEmitter();
/**
 * Status snapshot.
 *   pending = rows in queue, will retry
 *   failed  = rows that exhausted retries; operator must intervene
 *   inFlight = true while a drain is mid-flight (status indicator can spin)
 *   lastDrainAt = ISO time of last drain completion
 *   lastSuccessAt = ISO time of the most recent successful push (any op)
 *   lastError = most recent failure message (cleared on success)
 */
export interface SyncStatus {
  pending: number;
  failed: number;
  inFlight: boolean;
  oldestPending: string | null;
  lastDrainAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
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
  };
}

/**
 * Read a plate-capture image off disk and return it as a base64 string ready
 * to embed in a session upsert payload. Returns null if the path is missing
 * or the file can't be read — best-effort so a missing image never blocks
 * the metadata sync. Also caps the size at 500KB so we don't blow up the
 * HTTP request; anything larger is skipped with a warning.
 */
function readImageAsBase64(imagePath: string | null | undefined): string | null {
  if (!imagePath) return null;
  try {
    const stat = fs.statSync(imagePath);
    const MAX_BYTES = 500 * 1024;
    if (stat.size > MAX_BYTES) {
      console.warn(`[sync-queue] skipping oversized plate image ${imagePath} (${stat.size} bytes, cap ${MAX_BYTES})`);
      return null;
    }
    const buf = fs.readFileSync(imagePath);
    return buf.toString('base64');
  } catch (e: any) {
    console.warn(`[sync-queue] failed to read plate image ${imagePath}: ${e?.message ?? e}`);
    return null;
  }
}

/**
 * Public enqueue helpers. parking-flow / IPC handlers call these instead of
 * fetching directly so retries are guaranteed.
 */
export function enqueueEntry(session: ParkingSession): void {
  const lane = session.entryLaneId ? getLane(session.entryLaneId) : null;
  if (!lane?.policyId) return; // skip — lane lacks a policy, can't attribute
  const entryImage = readImageAsBase64(session.entryImagePath);
  enqueueSync('session.entry', {
    site_id: lane.policyId,
    plate_number: session.plate,
    entry_time: session.entryAt,
    ...(entryImage ? { entry_image_base64: entryImage } : {}),
  });
  scheduleDrain();
}

/**
 * Common payment-detail block we send to qparking on every exit/update.
 * Keeps the payload shape consistent so a declined-then-paid retry
 * overwrites cleanly instead of leaving stale fields behind.
 */
function paymentFields(session: ParkingSession) {
  return {
    payment_status: session.paymentStatus,
    payment_method: session.cardScheme ?? null,
    terminal_txn_id: session.terminalTxnId ?? null,
    payment_timestamp: session.paymentTimestamp ?? null,
  };
}

// site_id must equal the ENTRY record's site_id — the cloud correlates
// entry↔exit by (site_id + plate_number). So resolve the lane ENTRY-first here
// (and in update/delete) even when the car exits through a different lane whose
// rate plan (scope) differs; otherwise the exit lands under a different site and
// never closes the open entry record.
export function enqueueExit(session: ParkingSession): void {
  const lane = session.entryLaneId ? getLane(session.entryLaneId)
    : (session.exitLaneId ? getLane(session.exitLaneId) : null);
  if (!lane?.policyId) return;
  // Ship BOTH the entry image (in case earlier entry-sync retries dropped it)
  // and the freshly-captured exit image. Cloud upsert is idempotent per column
  // so re-uploading the entry image is safe.
  const entryImage = readImageAsBase64(session.entryImagePath);
  const exitImage  = readImageAsBase64(session.exitImagePath);
  enqueueSync('session.exit', {
    site_id: lane.policyId,
    plate_number: session.plate,
    entry_time: session.entryAt,
    exit_time: session.exitAt,
    fee_amount: session.feeCents != null ? (session.feeCents / 100).toFixed(2) : 0,
    duration_minutes: session.durationMinutes ?? 0,
    ...paymentFields(session),
    ...(entryImage ? { entry_image_base64: entryImage } : {}),
    ...(exitImage  ? { exit_image_base64:  exitImage  } : {}),
  });
  scheduleDrain();
}

export function enqueueUpdate(session: ParkingSession): void {
  const lane = session.entryLaneId ? getLane(session.entryLaneId)
    : (session.exitLaneId ? getLane(session.exitLaneId) : null);
  if (!lane?.policyId) return;
  // The same upsertParkingRecord endpoint handles updates — re-posting an
  // open entry refreshes it; posting with an exit_time closes it. So an
  // edit can re-use the entry / exit shapes depending on whether exitAt
  // is set.
  if (session.exitAt) {
    enqueueSync('session.update', {
      site_id: lane.policyId,
      plate_number: session.plate,
      entry_time: session.entryAt,
      exit_time: session.exitAt,
      fee_amount: session.feeCents != null ? (session.feeCents / 100).toFixed(2) : 0,
      duration_minutes: session.durationMinutes ?? 0,
      ...paymentFields(session),
    });
  } else {
    enqueueSync('session.update', {
      site_id: lane.policyId,
      plate_number: session.plate,
      entry_time: session.entryAt,
    });
  }
  scheduleDrain();
}

export function enqueueDelete(session: ParkingSession): void {
  const lane = session.entryLaneId ? getLane(session.entryLaneId)
    : (session.exitLaneId ? getLane(session.exitLaneId) : null);
  if (!lane?.policyId) return;
  enqueueSync('session.delete', {
    site_id: lane.policyId,
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
  drainTimer = setInterval(() => { void drainOnce(); }, DRAIN_INTERVAL_MS);
}

export function stopSyncDrain(): void {
  if (drainTimer) { clearInterval(drainTimer); drainTimer = null; }
}

async function drainOnce(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  syncEvents.emit('status', getSyncStatus());

  try {
    const dueRows = listDueSync();
    if (dueRows.length === 0) return;

    if (!getCloudApi()) {
      // Not configured yet — leave rows pending; they'll retry once the
      // operator fills in URL + key in Settings.
      lastError = 'qparking_not_configured';
      return;
    }

    for (const row of dueRows) {
      const result = await sendParkingRecord(row.op, row.payload);
      if (result.ok) {
        markSyncOk(row.id);
        lastSuccessAt = new Date().toISOString();
        lastError = null;
      } else {
        const nextAttempt = row.attempts + 1;
        if (nextAttempt >= MAX_ATTEMPTS) {
          markSyncFailed(row.id, result.error || 'unknown_error');
        } else {
          const delay = BACKOFF_MS[Math.min(nextAttempt, BACKOFF_MS.length - 1)];
          markSyncRetry(row.id, result.error || 'unknown_error', delay);
        }
        lastError = result.error || 'unknown_error';
      }
      syncEvents.emit('status', getSyncStatus());
    }
  } catch (e: any) {
    lastError = e?.message ?? String(e);
  } finally {
    lastDrainAt = new Date().toISOString();
    inFlight = false;
    syncEvents.emit('status', getSyncStatus());
  }
}

async function sendParkingRecord(op: SyncOp, payload: Record<string, unknown>): Promise<{ ok: boolean; error?: string; status?: number }> {
  const cloud = getCloudApi();
  if (!cloud) return { ok: false, error: 'qparking_not_configured' };
  // All session ops currently hit the same parking-records upsert endpoint
  // — the server differentiates entry vs exit vs update by what fields are
  // present (exit_time present = closing record; absent = open/update).
  // Delete is the exception: we use a body flag the server recognises as
  // "mark this record cancelled".
  const body = op === 'session.delete' ? { ...payload, _delete: true } : payload;
  try {
    const response = await cloud.post('/parking-records/upsert', body);
    return { ok: true, status: response.status };
  } catch (error: any) {
    if (axios.isAxiosError(error) && error.response) {
      const responseBody: any = error.response.data;
      const message = responseBody?.message || responseBody?.error || error.response.statusText;
      return { ok: false, status: error.response.status, error: `${error.response.status} ${message}` };
    }
    const isTimeout = axios.isAxiosError(error) && error.code === 'ECONNABORTED';
    return { ok: false, error: isTimeout ? 'timeout (10s)' : (error?.message ?? String(error)) };
  }
}

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
  // pulled this in at module-load time (db.ts → sync-queue.ts → db.ts).
  const db = require('./db') as typeof import('./db');
  const allSessions = db.listRecentSessions(10_000);
  let entries = 0, exits = 0;
  for (const session of allSessions) {
    if (session.exitAt) {
      enqueueExit(session); exits++;
    } else {
      enqueueEntry(session); entries++;
    }
  }
  scheduleDrain();
  return { entries, exits };
}
