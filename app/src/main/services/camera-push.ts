/**
 * Push camera registry metadata to qparking SaaS so the cloud dashboard
 * mirrors what each branch has configured locally. Cameras themselves are
 * still owned by the local server (LAN-local hardware); this is just a
 * read-only mirror on the cloud side.
 */
import { getCamera, getLane, listCameras } from './db';
import { getCloudApi, describeRequestError } from './cloud-api';

export async function pushCamera(cameraId: number): Promise<{ ok: boolean; error?: string }> {
  const cloud = getCloudApi();
  if (!cloud) return { ok: false, error: 'qparking_not_configured' };

  const camera = getCamera(cameraId);
  if (!camera) return { ok: false, error: 'unknown_camera' };

  // site_id is the lane's policy_id, which we sync from qparking. Without
  // it we can't attribute the camera to any cloud-side site so we skip.
  const lane = camera.laneId ? getLane(camera.laneId) : null;
  if (!lane?.policyId) return { ok: false, error: 'camera_lane_has_no_scope' };

  try {
    await cloud.post('/cameras', {
      external_id: `local-${camera.id}`, // stable across pushes
      site_id: lane.policyId,
      name: camera.name,
      direction: camera.direction,
      host: camera.host,
      snapshot_url: null, // HTTP snapshot URL retired — live view comes from the device SDK
      enabled: camera.enabled,
      has_snapshot: false,
      // Which lane this camera watches — cloud resolves to a UUID so
      // per-camera Open Barrier commands carry the target lane_id.
      lane_external_id: `local-${lane.id}`,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeRequestError(error) };
  }
}

/** Push every camera in one go — used on app boot to bring the cloud
 *  registry up-to-date after settings changes. */
export async function pushAllCameras(): Promise<void> {
  for (const camera of listCameras()) {
    await pushCamera(camera.id).catch(() => null);
  }
}
