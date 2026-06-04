/**
 * Mirror local equipment (payment terminals + parking lanes) up to qparking
 * SaaS so HQ / multi-site dashboards can see what each branch has deployed.
 * Best-effort like camera-push.ts: a failure here doesn't block the operator
 * from saving the local change.
 *
 * Site attribution: a terminal/lane belongs to the cloud Site whose scope_id
 * matches the lane.scopeId. Terminals don't have their own scopeId, so we
 * resolve site via the lane that references them.
 */
import { getSettings, getLane, getTerminal, listLanes, listTerminals } from './db';

async function post(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; error?: string; status?: number }> {
  const s = getSettings();
  if (!s.qparkingBaseUrl || !s.qparkingApiKey) return { ok: false, error: 'qparking_not_configured' };
  try {
    const res = await fetch(`${s.qparkingBaseUrl.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${s.qparkingApiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: res.ok, status: res.status };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** Push a single terminal. Resolves site_id via any lane that references it.
 *  If no lane references the terminal yet, we skip (no cloud site to attribute to). */
export async function pushTerminal(terminalId: number): Promise<{ ok: boolean; error?: string }> {
  const term = getTerminal(terminalId);
  if (!term) return { ok: false, error: 'unknown_terminal' };
  const owningLane = listLanes().find((l) => l.terminalId === term.id);
  if (!owningLane?.scopeId) return { ok: false, error: 'terminal_not_attached_to_scoped_lane' };

  return post('/api/v1/local-server/terminals', {
    external_id: `local-${term.id}`,
    name: term.name,
    host: term.host,
    port: term.port,
    plaza_id: term.plazaId,
    lane_id_str: term.laneId,
    lane_type: term.laneType,
    mode: term.mode,
    operation_mode: term.operationMode,
    enabled: term.enabled,
  });
}

/** Push a single lane. */
export async function pushLane(laneId: number): Promise<{ ok: boolean; error?: string }> {
  const lane = getLane(laneId);
  if (!lane) return { ok: false, error: 'unknown_lane' };
  if (!lane.scopeId) return { ok: false, error: 'lane_has_no_scope' };
  const term = lane.terminalId ? getTerminal(lane.terminalId) : null;

  return post('/api/v1/local-server/lanes', {
    external_id: `local-${lane.id}`,
    name: lane.name,
    direction: lane.direction,
    terminal_external_id: term ? `local-${term.id}` : null,
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
  for (const term of listTerminals()) {
    await pushTerminal(term.id).catch(() => null);
  }
}
