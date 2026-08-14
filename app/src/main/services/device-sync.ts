/**
 * Manual, operator-driven equipment sync between this box and qparking SaaS.
 *
 * Two directions, both destructive and both fired from the device pages
 * (Cameras / Lanes / Terminals / LCD Displays), never automatically:
 *
 *   Push to cloud  — this PC is the source of truth. Upsert every local device
 *                    of the type, then reconcile: the cloud soft-deletes any of
 *                    its rows whose external_id we didn't send (so a local
 *                    delete finally propagates).
 *   Pull from cloud — the cloud is the source of truth. Reconcile the local
 *                     table to match the cloud set by external_id, preserving
 *                     numeric ids for surviving devices (session refs stay
 *                     valid) and relinking camera→lane→terminal/LCD afterwards.
 *
 * Both are gated on the site binding (isBoundToCurrentSite) so equipment can
 * never sync against the wrong site. LAN-only secrets (webhook / terminal
 * secret, SDK creds) are never on the cloud, so Pull does not restore them.
 */
import { getCloudApi, describeRequestError } from './cloud-api';
import {
  listCameras, listLanes, listTerminals, listLcds,
  reconcileCamerasFromCloud, reconcileLanesFromCloud, reconcileTerminalsFromCloud, reconcileLcdsFromCloud,
  relinkDevices,
  isBoundToCurrentSite,
  type CloudCameraRow, type CloudLaneRow, type CloudTerminalRow, type CloudLcdRow,
} from './db';
import { pushCamera } from './camera-push';
import { pushLane, pushTerminal, pushLcd, toEquipmentPushItem } from './device-push';
// The bridge contract in shared/types is the single definition of this module's
// vocabulary — the renderer and this implementation have to agree on it, and a
// second copy here only ever drifts.
import type {
  EquipmentPushItem,
  DeviceSyncType as DeviceType,
  DeviceSyncPreview as DevicePreview,
  DevicePushResult,
  DevicePullResult,
} from '../../shared/types';

export type { DeviceType, DevicePreview, DevicePushResult, DevicePullResult };

interface CloudListBody { data?: any[] }

const NOT_READY = (): { ok: false; error: string } | null => {
  if (!getCloudApi()) return { ok: false, error: 'qparking_not_configured' };
  if (!isBoundToCurrentSite()) return { ok: false, error: 'site_not_bound' };
  return null;
};

// ─── cloud fetch (list) → normalized rows ────────────────────────────────────

async function fetchCloudTerminals(): Promise<CloudTerminalRow[]> {
  const { data } = await getCloudApi()!.get<CloudListBody>('/local-terminals');
  return (data.data ?? []).map((r: any): CloudTerminalRow => ({
    externalId: String(r.external_id),
    name: String(r.name ?? ''),
    host: String(r.host ?? ''),
    port: Number(r.port ?? 5000),
    enabled: !!r.enabled,
  }));
}

async function fetchCloudLcds(): Promise<CloudLcdRow[]> {
  const { data } = await getCloudApi()!.get<CloudListBody>('/local-lcds');
  return (data.data ?? []).map((r: any): CloudLcdRow => ({
    externalId: String(r.external_id),
    name: String(r.name ?? ''),
    host: String(r.host ?? ''),
    // The panel's listen port. Coerced, then clamped again by the reconcile —
    // a nonsense value would leave the box dialling a port nothing answers on,
    // which looks exactly like a panel that is switched off.
    port: Number(r.port ?? 7070),
    enabled: !!r.enabled,
  }));
}

async function fetchCloudLanes(): Promise<CloudLaneRow[]> {
  const { data } = await getCloudApi()!.get<CloudListBody>('/local-lanes');
  return (data.data ?? []).map((r: any): CloudLaneRow => ({
    externalId: String(r.external_id),
    name: String(r.name ?? ''),
    enabled: !!r.enabled,
    terminalExternalId: r.terminal_external_id ?? null,
    // Absent on a cloud that predates the LCD mirror — reads as "no panel",
    // which is what such a cloud in fact knows.
    lcdExternalId: r.lcd_external_id ?? null,
    policyId: r.rate_policy_id ?? null,
  }));
}

async function fetchCloudCameras(): Promise<CloudCameraRow[]> {
  const { data } = await getCloudApi()!.get<CloudListBody>('/camera-devices');
  return (data.data ?? []).map((r: any): CloudCameraRow => ({
    externalId: String(r.external_id),
    name: String(r.name ?? ''),
    // Coerce rather than trust. The cloud dropped 'dual' from its validation at
    // the same time this app retired it, but rows written BEFORE that can still
    // carry it — and an unrecognised value would fail the cameras CHECK
    // constraint on a fresh install, aborting the entire pull.
    direction: r.direction === 'exit' ? 'exit' : 'entry',
    // Same fail-open rule the local rowToCamera applies: anything that isn't
    // exactly 'pass_only' reads as 'open'. A cloud row that predates the column
    // therefore admits everyone rather than locking a site out.
    accessMode: r.access_mode === 'pass_only' ? 'pass_only' : 'open',
    host: r.ip_address ?? null,
    enabled: !!r.is_enabled,
    // Absent on a cloud that predates the mirror, or empty on a camera that
    // never had them — reconcileCamerasFromCloud treats both as "the cloud has
    // nothing to say" and keeps whatever this box already holds.
    deviceUser: r.device_user ?? null,
    devicePassword: r.device_password ?? null,
    devicePort: Number.isFinite(Number(r.device_port)) && Number(r.device_port) > 0 ? Number(r.device_port) : null,
    webhookPort: Number.isFinite(Number(r.webhook_port)) && Number(r.webhook_port) > 0 ? Number(r.webhook_port) : null,
    webhookSecret: r.webhook_secret ?? null,
    laneExternalId: r.lane_external_id ?? null,
  }));
}

/** Local external_ids for a type — the "keep" set for a push reconcile. */
function localExternalIds(type: DeviceType): string[] {
  if (type === 'cameras') return listCameras().map((c) => c.externalId);
  if (type === 'lanes') return listLanes().map((l) => l.externalId);
  if (type === 'lcds') return listLcds().map((d) => d.externalId);
  return listTerminals().map((t) => t.externalId);
}

async function fetchCloudExternalIds(type: DeviceType): Promise<string[]> {
  if (type === 'cameras') return (await fetchCloudCameras()).map((r) => r.externalId);
  if (type === 'lanes') return (await fetchCloudLanes()).map((r) => r.externalId);
  if (type === 'lcds') return (await fetchCloudLcds()).map((r) => r.externalId);
  return (await fetchCloudTerminals()).map((r) => r.externalId);
}

const RECONCILE_PATH: Record<DeviceType, string> = {
  cameras: '/camera-devices/reconcile',
  lanes: '/local-lanes/reconcile',
  terminals: '/local-terminals/reconcile',
  lcds: '/local-lcds/reconcile',
};

// ─── preview (counts for the confirmation modal) ─────────────────────────────

export async function previewDeviceSync(type: DeviceType, direction: 'push' | 'pull'): Promise<DevicePreview> {
  const notReady = NOT_READY();
  if (notReady) return { ok: false, error: notReady.error, localCount: 0, cloudCount: 0, toRemove: 0, toUpdate: 0, toAdd: 0 };
  try {
    const local = new Set(localExternalIds(type));
    const cloud = new Set(await fetchCloudExternalIds(type));
    const inBoth = [...local].filter((id) => cloud.has(id)).length;
    if (direction === 'push') {
      const toRemove = [...cloud].filter((id) => !local.has(id)).length; // cloud-only → soft-deleted
      return { ok: true, localCount: local.size, cloudCount: cloud.size, toRemove, toUpdate: inBoth, toAdd: local.size - inBoth };
    }
    const toRemove = [...local].filter((id) => !cloud.has(id)).length; // local-only → deleted
    return { ok: true, localCount: local.size, cloudCount: cloud.size, toRemove, toUpdate: inBoth, toAdd: cloud.size - inBoth };
  } catch (error) {
    return { ok: false, error: describeRequestError(error), localCount: 0, cloudCount: 0, toRemove: 0, toUpdate: 0, toAdd: 0 };
  }
}

// ─── push (local → cloud, mirror) ────────────────────────────────────────────

export async function pushDevicesToCloud(type: DeviceType): Promise<DevicePushResult> {
  const notReady = NOT_READY();
  if (notReady) return notReady;
  try {
    const items: EquipmentPushItem[] = [];
    if (type === 'cameras') {
      for (const c of listCameras()) {
        const r = await pushCamera(c.id).catch((e) => ({ ok: false, error: describeRequestError(e) }));
        items.push(toEquipmentPushItem(c.id, c.name, r));
      }
    } else if (type === 'lanes') {
      for (const l of listLanes()) {
        const r = await pushLane(l.id).catch((e) => ({ ok: false, error: describeRequestError(e) }));
        items.push(toEquipmentPushItem(l.id, l.name, r));
      }
    } else if (type === 'lcds') {
      for (const d of listLcds()) {
        const r = await pushLcd(d.id).catch((e) => ({ ok: false, error: describeRequestError(e) }));
        items.push(toEquipmentPushItem(d.id, d.name, r));
      }
    } else {
      for (const t of listTerminals()) {
        const r = await pushTerminal(t.id).catch((e) => ({ ok: false, error: describeRequestError(e) }));
        items.push(toEquipmentPushItem(t.id, t.name, r));
      }
    }
    // Reconcile: soft-delete cloud rows whose external_id we no longer have.
    const { data } = await getCloudApi()!.post<{ removed?: number }>(RECONCILE_PATH[type], { keep: localExternalIds(type) });
    return { ok: true, items, removed: data?.removed ?? 0 };
  } catch (error) {
    return { ok: false, error: describeRequestError(error) };
  }
}

// ─── pull (cloud → local, replace) ───────────────────────────────────────────

export async function pullDevicesFromCloud(type: DeviceType): Promise<DevicePullResult> {
  const notReady = NOT_READY();
  if (notReady) return notReady;
  try {
    let applied = 0;
    if (type === 'cameras') {
      const rows = await fetchCloudCameras();
      reconcileCamerasFromCloud(rows);
      applied = rows.length;
    } else if (type === 'lanes') {
      const rows = await fetchCloudLanes();
      reconcileLanesFromCloud(rows);
      applied = rows.length;
    } else if (type === 'lcds') {
      const rows = await fetchCloudLcds();
      reconcileLcdsFromCloud(rows);
      applied = rows.length;
    } else {
      const rows = await fetchCloudTerminals();
      reconcileTerminalsFromCloud(rows);
      applied = rows.length;
    }
    // Re-derive numeric FKs from the external-id links now that this type's
    // rows changed (order-independent — completes once the other type is pulled).
    relinkDevices();
    return { ok: true, applied };
  } catch (error) {
    return { ok: false, error: describeRequestError(error) };
  }
}
