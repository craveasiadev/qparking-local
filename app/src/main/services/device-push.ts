/**
 * Mirror local equipment (payment terminals + parking lanes) up to qparking
 * SaaS so HQ / multi-site dashboards can see what each branch has deployed.
 * Best-effort like camera-push.ts: a failure here doesn't block the operator
 * from saving the local change.
 *
 * Site attribution: a terminal/lane belongs to the cloud Site whose policy_id
 * matches the lane.policyId. Terminals don't have their own policyId, so we
 * resolve site via the lane that references them.
 */
import { getLane, getTerminal, listLanes, listTerminals, deriveLaneDirection } from './db';
import { getCloudApi, describeRequestError } from './cloud-api';

interface PushResult { ok: boolean; error?: string }

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

/** Push a single terminal. Resolves site_id via any lane that references it.
 *  If no lane references the terminal yet, we skip (no cloud site to attribute to). */
export async function pushTerminal(terminalId: number): Promise<PushResult> {
  const terminal = getTerminal(terminalId);
  if (!terminal) return { ok: false, error: 'unknown_terminal' };
  const owningLane = listLanes().find((lane) => lane.terminalId === terminal.id);
  if (!owningLane?.policyId) return { ok: false, error: 'terminal_not_attached_to_scoped_lane' };

  return postToCloud('/local-terminals/upsert', {
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

/** Push a single lane. */
export async function pushLane(laneId: number): Promise<PushResult> {
  const lane = getLane(laneId);
  if (!lane) return { ok: false, error: 'unknown_lane' };
  if (!lane.policyId) return { ok: false, error: 'lane_has_no_scope' };
  const terminal = lane.terminalId ? getTerminal(lane.terminalId) : null;

  return postToCloud('/local-lanes/upsert', {
    external_id: `local-${lane.id}`,
    name: lane.name,
    // Derived from the lane's cameras (may be 'dual', or null if none wired).
    direction: deriveLaneDirection(lane.id),
    terminal_external_id: terminal ? `local-${terminal.id}` : null,
    gate_relay_address: lane.gateRelayAddress,
    enabled: lane.enabled,
  });
}

/** Bulk push on boot — keep the cloud registry fresh after settings tweaks
 *  and after a local DB restore. */
export async function pushAllDevices(): Promise<void> {
  for (const lane of listLanes()) {
    await pushLane(lane.id).catch(() => null);
  }
  for (const terminal of listTerminals()) {
    await pushTerminal(terminal.id).catch(() => null);
  }
}
