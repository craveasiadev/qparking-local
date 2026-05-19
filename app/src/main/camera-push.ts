/**
 * Push camera registry metadata to qparking SaaS so the cloud dashboard
 * mirrors what each branch has configured locally. Cameras themselves are
 * still owned by the local server (LAN-local hardware), this is just a
 * read-only mirror on the cloud side.
 */
import { getSettings, getLane, getCamera, listCameras } from './db';

export async function pushCamera(cameraId: number): Promise<{ ok: boolean; error?: string }> {
  const s = getSettings();
  if (!s.qparkingBaseUrl || !s.qparkingApiKey) return { ok: false, error: 'qparking_not_configured' };
  const cam = getCamera(cameraId);
  if (!cam) return { ok: false, error: 'unknown_camera' };
  const lane = cam.laneId ? getLane(cam.laneId) : null;
  // site_id is the lane's scope_id, which we sync from qparking. Without
  // it we can't attribute the camera to any cloud-side site so we skip.
  if (!lane?.scopeId) return { ok: false, error: 'camera_lane_has_no_scope' };

  try {
    const res = await fetch(`${s.qparkingBaseUrl.replace(/\/+$/, '')}/api/v1/local-server/cameras`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${s.qparkingApiKey}`,
      },
      body: JSON.stringify({
        external_id: `local-${cam.id}`, // stable across pushes
        site_id: lane.scopeId,
        name: cam.name,
        direction: cam.direction,
        host: cam.host,
        snapshot_url: cam.snapshotUrl ? '(see /snapshot)' : null, // never share LAN URL with cloud
        enabled: cam.enabled,
        has_snapshot: !!cam.snapshotUrl,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: res.ok };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** Push every camera in one go — used on app boot to bring the cloud
 *  registry up-to-date after settings changes. */
export async function pushAllCameras() {
  for (const cam of listCameras()) {
    await pushCamera(cam.id).catch(() => null);
  }
}
