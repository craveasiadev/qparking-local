/**
 * Push camera registry metadata to qparking SaaS so the cloud dashboard
 * mirrors what each branch has configured locally. Cameras themselves are
 * still owned by the local server (LAN-local hardware); this is just a
 * read-only mirror on the cloud side.
 */
import { getCamera, getLane, listCameras, isBoundToCurrentSite } from './db';
import { getCloudApi, describeRequestError } from './cloud-api';
import { toEquipmentPushItem } from './device-push';
import type { EquipmentPushItem } from './device-push';

export async function pushCamera(cameraId: number): Promise<{ ok: boolean; error?: string }> {
  // Don't mirror equipment onto a site this box isn't provisioned for (e.g.
  // after the API key is pointed at a new site but before the operator confirms
  // the re-provision). Classified as a skip, not a failure, by SKIP_REASONS.
  if (!isBoundToCurrentSite()) return { ok: false, error: 'site_not_bound' };

  const cloud = getCloudApi();
  if (!cloud) return { ok: false, error: 'qparking_not_configured' };

  const camera = getCamera(cameraId);
  if (!camera) return { ok: false, error: 'unknown_camera' };

  // Pushed unconditionally — the cloud attributes the camera to the site behind
  // the bearer token, so it needs no rate-policy scope. site_id is omitted for
  // the same reason (ignored server-side). The lane link is sent when wired.
  const lane = camera.laneId ? getLane(camera.laneId) : null;

  try {
    await cloud.post('/camera-devices/upsert', {
      external_id: camera.externalId, // durable identity, stable across reinstalls
      name: camera.name,
      direction: camera.direction,
      host: camera.host,
      enabled: camera.enabled,
      has_snapshot: false,
      // Which lane this camera watches — cloud resolves to a UUID so
      // per-camera Open Barrier commands carry the target lane_id. Null when
      // the camera isn't assigned to a lane yet.
      lane_external_id: lane ? lane.externalId : null,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeRequestError(error) };
  }
}

/** Push every camera in one go — used on app boot and on manual "Sync now"
 *  to bring the cloud registry up-to-date. Returns a labelled per-item report
 *  so the Settings panel can show what landed and what didn't. */
export async function pushAllCameras(): Promise<{ cameras: EquipmentPushItem[] }> {
  const cameras: EquipmentPushItem[] = [];
  for (const camera of listCameras()) {
    const result = await pushCamera(camera.id).catch((error) => ({ ok: false, error: describeRequestError(error) }));
    cameras.push(toEquipmentPushItem(camera.id, camera.name, result));
  }
  return { cameras };
}
