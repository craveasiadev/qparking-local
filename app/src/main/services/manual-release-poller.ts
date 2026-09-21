/**
 * Collect operator-requested manual releases from the SaaS and run them here.
 *
 * WHY POLL AT ALL
 * ---------------
 * The cloud cannot reach this box's LAN — there is no inbound path to a site
 * network, which is why every other cloud exchange in this app is also a pull.
 * So a release requested in the web app lands in a queue and we come and get it.
 *
 * WHY NOT cloud-queue
 * -------------------
 * Same reasoning as health-heartbeat: cloud-queue is durable-with-backoff,
 * which is right for facts that must eventually land. A gate release is the
 * opposite — it is only meaningful NOW. A release replayed after the WAN
 * returns would lift a barrier for whatever car happens to be sitting there.
 * Hence: short interval, no retry, and a hard expiry.
 *
 * WHY WE RE-CHECK expires_at OURSELVES
 * ------------------------------------
 * The cloud will not hand out an expired command, but "not expired when the
 * cloud answered" is not "not expired when the relay fires" — the response may
 * have sat in a slow link, and this process may have been suspended between the
 * fetch and the loop. We are the side holding the clock at the moment the
 * barrier actually moves, so we check again immediately before opening it. A
 * late release is not a cosmetic problem: the car at the gate is no longer the
 * car the operator released, and it leaves without paying.
 *
 * WHY WE MATCH ON externalId
 * --------------------------
 * The cloud identifies a stay by `parking_records.external_id`, the UUID this
 * box mints at entry and never changes. Plate is the fallback only: a plate
 * corrected after entry would otherwise point a release at the wrong session.
 */
import { getCloudApi, describeRequestError } from './cloud-api';
import { isBoundToCurrentSite, findOpenSessionByPlate, findSessionByExternalId } from './db';

/**
 * The release routine, handed in at startup rather than imported.
 *
 * It lives in index.ts alongside the IPC surface, and importing it from here
 * would make index → poller → index a cycle. That happens to compile (the call
 * is deferred to runtime, and a function declaration is hoisted), but it is the
 * kind of thing that breaks silently the day the module graph is reordered.
 * Injection keeps the dependency one-way and obvious.
 */
type ReleaseFn = (sessionId: number, reason: string, laneId?: number | null) => unknown;
let releaseSession: ReleaseFn | null = null;

/**
 * How often we ask for work.
 *
 * Someone is standing at a barrier waiting for it to lift, so this is nothing
 * like the 60s config tick — that cadence would make the feature unusable. The
 * endpoint is indexed, tiny and almost always empty, which is what makes a gap
 * this short affordable.
 */
export const MANUAL_RELEASE_POLL_INTERVAL_MS = 3_000;

export interface ManualReleasePollerState {
  lastPollAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  /** Releases actually executed since start — surfaced in the Settings panel. */
  executed: number;
}
let state: ManualReleasePollerState = { lastPollAt: null, lastOkAt: null, lastError: null, executed: 0 };

export function getManualReleasePollerState(): ManualReleasePollerState {
  return state;
}

let timer: NodeJS.Timeout | null = null;
/** One poll at a time — a slow cloud reply must not let ticks stack up. */
let inFlight = false;
/**
 * Commands already acted on in this process.
 *
 * The cloud marks a command `delivered` when we collect it but only settles it
 * on our ack, so a command we have executed can legitimately come back in the
 * very next poll if the ack was still in flight. Without this the barrier would
 * open a second time for the same request.
 */
const handled = new Set<string>();

/** Wire shape from GET /local-server/gate-releases/pending. */
interface GateRelease {
  id: string;
  parking_record_external_id: string | null;
  plate_number: string | null;
  reason: string;
  expires_at: string | null;
}

function isExpired(expiresAt: string | null): boolean {
  // No expiry is treated as expired rather than as "never expires": a command
  // without a deadline is a malformed one, and the failure mode of honouring it
  // is a barrier opening at an arbitrary later time.
  if (!expiresAt) return true;
  return new Date(expiresAt).getTime() <= Date.now();
}

async function ack(id: string, status: 'processed' | 'failed', note: string): Promise<void> {
  const cloud = getCloudApi();
  if (!cloud) return;
  try {
    await cloud.post(`/gate-releases/${id}/settle`, { status, note: note.slice(0, 1000) });
  } catch {
    // Deliberately swallowed. The release has already happened (or already
    // failed) at the barrier; a lost ack only means the operator's screen falls
    // back to the cloud's own expiry. Retrying here would risk re-running the
    // loop against a command we have already acted on.
  }
}

/**
 * Resolve the cloud's command to one of our open sessions.
 *
 * Returns null when there is nothing to release — which is NOT an error in the
 * ordinary case: the car may have paid and exited normally in the seconds
 * between the operator pressing the button and us collecting it.
 */
function resolveSessionId(command: GateRelease): number | null {
  if (command.parking_record_external_id) {
    const byExternal = findSessionByExternalId(command.parking_record_external_id);
    if (byExternal && !byExternal.exitAt) return byExternal.id;
    if (byExternal) return null; // found, already closed — nothing to release
  }
  if (command.plate_number) {
    const byPlate = findOpenSessionByPlate(command.plate_number);
    if (byPlate) return byPlate.id;
  }
  return null;
}

/** Run one command to completion and tell the cloud what happened. */
async function execute(command: GateRelease): Promise<void> {
  handled.add(command.id);

  // Re-check against OUR clock, at the last possible moment. See the header.
  if (isExpired(command.expires_at)) {
    await ack(command.id, 'failed', 'Expired before this server could run it — the barrier was not opened.');
    return;
  }

  const sessionId = resolveSessionId(command);
  if (sessionId === null) {
    await ack(
      command.id,
      'failed',
      'No open session here for that vehicle — it may have paid and exited before the release was collected.',
    );
    return;
  }

  if (!releaseSession) {
    await ack(command.id, 'failed', 'This server is not ready to run releases yet.');
    return;
  }

  try {
    // The one and only release path: voids the pending payment, closes the
    // session, opens the real relay, updates the lane LCD and audits it.
    // Lane is left to the session's own exit/entry lane — the car is at the
    // barrier it entered or tried to leave by, and the cloud has no reliable
    // mapping to this box's lane ids.
    releaseSession(sessionId, command.reason, null);
    state = { ...state, executed: state.executed + 1 };
    await ack(command.id, 'processed', 'Session released and barrier opened.');
  } catch (error: any) {
    await ack(command.id, 'failed', String(error?.message ?? error).slice(0, 500));
  }
}

/**
 * One poll. Never throws — the caller is a timer.
 */
export async function pollManualReleases(): Promise<void> {
  if (inFlight) return;

  const cloud = getCloudApi();
  if (!cloud) return;
  // Same guard as every other cloud exchange: while this box is not bound to
  // the site its key resolves to, acting on that site's commands would open a
  // barrier here because someone pressed a button for somewhere else.
  if (!isBoundToCurrentSite()) return;

  inFlight = true;
  state = { ...state, lastPollAt: new Date().toISOString() };
  try {
    const results = await cloud.get('/gate-releases/pending');
    const gateReleases = results.data?.data ?? [];
    state = { ...state, lastOkAt: new Date().toISOString(), lastError: null };

    const gateReleasesMap = new Map<string, GateRelease>(
      gateReleases.map((gateRelease: any) => [gateRelease.id, {
        id: gateRelease.id,
        parking_record_external_id: gateRelease.parking_record?.external_id,
        plate_number: gateRelease.parking_record?.plate_number,
        reason: gateRelease.reason,
        expires_at: gateRelease.expires_at,
      }])
    ).values();

    for (const gateRelease of gateReleasesMap) {
      if (handled.has(gateRelease.id)) continue;
      await execute(gateRelease);
    }

    // Keep the dedupe set from growing for the life of the process. Anything
    // the cloud no longer offers is settled, so we can forget it.
    if (handled.size > 500) {
      const live = new Set(gateReleases.map((gateRelease: GateRelease) => gateRelease.id));
      for (const id of handled) if (!live.has(id)) handled.delete(id);
    }
  } catch (error) {
    state = { ...state, lastError: describeRequestError(error) };
  } finally {
    inFlight = false;
  }
}

export function startManualReleasePoller(release: ReleaseFn): void {
  releaseSession = release;
  if (timer) return;
  timer = setInterval(() => void pollManualReleases(), MANUAL_RELEASE_POLL_INTERVAL_MS);
  // No immediate first poll: startup is already the busiest moment for this
  // process, and a release that is 3 seconds old is not worth contending with
  // the initial sync for.
}

export function stopManualReleasePoller(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  handled.clear();
}
