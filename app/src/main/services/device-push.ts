/**
 * Mirror local equipment (payment terminals + parking lanes) up to qparking
 * SaaS so HQ / multi-site dashboards can see what each branch has deployed.
 * Best-effort like camera-push.ts: a failure here doesn't block the operator
 * from saving the local change.
 *
 * Site attribution: the cloud always attributes to the site behind the bearer
 * token, so we push every piece of equipment as soon as it exists — a lane
 * does NOT need a rate policy assigned first. Optional links (terminal, gate
 * relay, …) are sent as null when unset.
 */
import { getLane, getTerminal, listLanes, listTerminals, deriveLaneDirection } from './db';
import { getCloudApi, describeRequestError } from './cloud-api';
import type { EquipmentPushItem } from '../../shared/types';

interface PushResult { ok: boolean; error?: string }

export type { EquipmentPushItem };

/** Push `error` codes that mean "nothing to send yet", not a genuine failure. */
const SKIP_REASONS = new Set([
  'qparking_not_configured',
]);

/** Fold a raw PushResult into a labelled report item, classifying the known
 *  "not scoped / not configured" outcomes as skips rather than errors. */
export function toEquipmentPushItem(id: number, name: string, result: PushResult): EquipmentPushItem {
  if (result.ok) return { id, name, ok: true };
  return { id, name, ok: false, skipped: !!result.error && SKIP_REASONS.has(result.error), error: result.error };
}

async function postToCloud(path: string, body: Record<string, unknown>): Promise<PushResult> {
  const cloud = getCloudApi();
  if (!cloud) return { ok: false, error: 'qparking_not_configured' };
  try {
    await cloud.post(path, body);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeRequestError(error) };
  }
}

/** Push a single terminal. Pushed unconditionally — the cloud attributes it to
 *  the site behind the bearer token, so it needs no lane/policy linkage. */
export async function pushTerminal(terminalId: number): Promise<PushResult> {
  const terminal = getTerminal(terminalId);
  if (!terminal) return { ok: false, error: 'unknown_terminal' };

  // site_id is intentionally omitted — the cloud always attributes to the
  // site behind the bearer token and ignores any site_id in the body.
  return postToCloud('/terminals', {
    external_id: `local-${terminal.id}`,
    name: terminal.name,
    host: terminal.host,
    port: terminal.port,
    plaza_id: terminal.plazaId,
    lane_id_str: terminal.laneId,
    lane_type: terminal.laneType,
    mode: terminal.mode,
    operation_mode: terminal.operationMode,
    enabled: terminal.enabled,
  });
}

/** Push a single lane. Pushed unconditionally — a rate policy is NOT required;
 *  the cloud attributes it to the site behind the bearer token. */
export async function pushLane(laneId: number): Promise<PushResult> {
  const lane = getLane(laneId);
  if (!lane) return { ok: false, error: 'unknown_lane' };
  const terminal = lane.terminalId ? getTerminal(lane.terminalId) : null;

  // site_id omitted — the bearer token identifies the site (see pushTerminal).
  return postToCloud('/lanes', {
    external_id: `local-${lane.id}`,
    name: lane.name,
    // Derived from the lane's cameras (may be 'dual', or null if none wired).
    direction: deriveLaneDirection(lane.id),
    terminal_external_id: terminal ? `local-${terminal.id}` : null,
    gate_relay_address: lane.gateRelayAddress,
    enabled: lane.enabled,
  });
}

/** Bulk push on boot / on manual "Sync now" — keeps the cloud registry fresh
 *  after settings tweaks and after a local DB restore. Returns a labelled
 *  per-item report so the Settings panel can show what landed and what didn't. */
export async function pushAllDevices(): Promise<{ lanes: EquipmentPushItem[]; terminals: EquipmentPushItem[] }> {
  const lanes: EquipmentPushItem[] = [];
  for (const lane of listLanes()) {
    const result = await pushLane(lane.id).catch((error) => ({ ok: false, error: describeRequestError(error) }));
    lanes.push(toEquipmentPushItem(lane.id, lane.name, result));
  }
  const terminals: EquipmentPushItem[] = [];
  for (const terminal of listTerminals()) {
    const result = await pushTerminal(terminal.id).catch((error) => ({ ok: false, error: describeRequestError(error) }));
    terminals.push(toEquipmentPushItem(terminal.id, terminal.name, result));
  }
  return { lanes, terminals };
}
