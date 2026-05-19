/**
 * Back-channel from qparking-local → qparking SaaS. Pushes every entry and
 * exit event so the SaaS-side dashboard (Sites → Parking Records) reflects
 * what's actually happening on the ground. Best-effort: if the SaaS is
 * unreachable, the local DB is still authoritative — we'll retry the next
 * time the same plate has an event.
 *
 * Each lane in qparking-local carries a `scopeId` (= qparking's site_id),
 * which is what links a local session to a qparking site.
 */
import { getSettings, getLane } from './db';
import type { ParkingSession } from '../shared/types';

interface PushResult { ok: boolean; status?: number; action?: string; error?: string; }

async function post(path: string, body: Record<string, unknown>): Promise<PushResult> {
  const s = getSettings();
  if (!s.qparkingBaseUrl || !s.qparkingApiKey) {
    return { ok: false, error: 'qparking_not_configured' };
  }
  const url = `${s.qparkingBaseUrl.replace(/\/+$/, '')}${path}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${s.qparkingApiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    let parsed: any = null;
    try { parsed = await res.json(); } catch { /* ignore */ }
    return { ok: res.ok, status: res.status, action: parsed?.action, error: !res.ok ? (parsed?.message ?? res.statusText) : undefined };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** Send the entry event to qparking. */
export async function pushEntry(session: ParkingSession): Promise<PushResult> {
  const lane = session.entryLaneId ? getLane(session.entryLaneId) : null;
  if (!lane?.scopeId) {
    return { ok: false, error: 'lane_has_no_scope' }; // skip — no qparking site to attribute to
  }
  return post('/api/v1/local-server/parking-records', {
    site_id: lane.scopeId,
    plate_number: session.plate,
    entry_time: session.entryAt,
  });
}

/** Send the exit event to qparking. Includes fee + duration. */
export async function pushExit(session: ParkingSession): Promise<PushResult> {
  const lane = session.exitLaneId ? getLane(session.exitLaneId) : (session.entryLaneId ? getLane(session.entryLaneId) : null);
  if (!lane?.scopeId) {
    return { ok: false, error: 'lane_has_no_scope' };
  }
  return post('/api/v1/local-server/parking-records', {
    site_id: lane.scopeId,
    plate_number: session.plate,
    entry_time: session.entryAt,
    exit_time: session.exitAt,
    fee_amount: session.feeCents != null ? (session.feeCents / 100).toFixed(2) : 0,
    duration_minutes: session.durationMinutes ?? 0,
  });
}
