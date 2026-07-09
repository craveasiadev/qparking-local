/**
 * Camera live-preview + connectivity probe. Cameras are LAN-local hardware,
 * so only the on-prem qparking-local server can actually reach them. We:
 *   • fetch a snapshot from the camera's HTTP endpoint (most IP cameras
 *     expose http://<ip>/snapshot.jpg or a vendor-specific cgi path) and
 *     stream it to the renderer for the live-preview pane
 *   • probe TCP/HTTP reachability for the "test connection" button
 *   • push the most recent snapshot to qparking SaaS on a slow timer so
 *     the cloud dashboard can show what each camera sees, without needing
 *     a tunnel into the branch LAN
 */
import axios from 'axios';
import { getCamera, listCameras } from './db';
import { getCloudApi } from './cloud-api';

const SNAPSHOT_TIMEOUT_MS = 5_000;
const PING_TIMEOUT_MS = 3_000;
const UPLOAD_TIMEOUT_MS = 15_000;

export interface SnapshotResult {
  ok: boolean;
  contentType?: string;
  base64?: string;          // jpeg payload (no data: prefix)
  fetchedAt?: string;
  status?: number;
  error?: string;
}

export async function fetchSnapshot(cameraId: number): Promise<SnapshotResult> {
  const camera = getCamera(cameraId);
  if (!camera) return { ok: false, error: 'unknown_camera' };
  if (!camera.snapshotUrl) return { ok: false, error: 'snapshot_url_not_set' };
  try {
    // Camera HTTP endpoints often use basic auth — the operator can embed
    // user:pass@host directly in snapshotUrl (axios honours credentials in
    // the URL; Node's built-in fetch would reject them).
    const response = await axios.get(camera.snapshotUrl, {
      responseType: 'arraybuffer',
      timeout: SNAPSHOT_TIMEOUT_MS,
      validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, status: response.status, error: `http_${response.status}` };
    }
    const contentType = String(response.headers['content-type'] ?? 'image/jpeg');
    const imageBuffer = Buffer.from(response.data);
    return {
      ok: true,
      contentType,
      base64: imageBuffer.toString('base64'),
      fetchedAt: new Date().toISOString(),
      status: response.status,
    };
  } catch (error: any) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/** Lightweight HTTP reachability probe — uses snapshotUrl if set, else
 *  falls back to http://<host>/. Mainly used by the UI's "Test connection"
 *  button so the operator knows the IP is right before saving. */
export async function pingCamera(cameraId: number): Promise<{ ok: boolean; status?: number; latencyMs?: number; error?: string }> {
  const camera = getCamera(cameraId);
  if (!camera) return { ok: false, error: 'unknown_camera' };
  const url = camera.snapshotUrl || (camera.host ? `http://${camera.host}/` : null);
  if (!url) return { ok: false, error: 'no_host_or_snapshot_url' };
  const startedAt = Date.now();
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: PING_TIMEOUT_MS,
      validateStatus: () => true,
    });
    const httpOk = response.status >= 200 && response.status < 300;
    return { ok: httpOk, status: response.status, latencyMs: Date.now() - startedAt };
  } catch (error: any) {
    return { ok: false, error: error?.message ?? String(error), latencyMs: Date.now() - startedAt };
  }
}

// ─── periodic upload to qparking SaaS ────────────────────────────────────────
//
// Every camera with a snapshotUrl uploads its latest snapshot to qparking
// every UPLOAD_INTERVAL_MS. The cloud dashboard reads from these stored
// snapshots to give SaaS users a near-live view without needing direct
// access to the branch LAN. Cheap — small jpeg, infrequent push, only when
// the cloud sync is configured.

const UPLOAD_INTERVAL_MS = 10_000;
let uploadTimer: NodeJS.Timeout | null = null;

export function startSnapshotUploader(): void {
  stopSnapshotUploader();
  uploadTimer = setInterval(() => { void uploadAllSnapshots(); }, UPLOAD_INTERVAL_MS);
  // First run immediately so the cloud sees the cameras quickly.
  void uploadAllSnapshots();
}

export function stopSnapshotUploader(): void {
  if (uploadTimer) clearInterval(uploadTimer);
  uploadTimer = null;
}

async function uploadAllSnapshots(): Promise<void> {
  const cloud = getCloudApi();
  if (!cloud) return; // not configured — silently skip

  for (const camera of listCameras()) {
    if (!camera.enabled || !camera.snapshotUrl) continue;
    const snapshot = await fetchSnapshot(camera.id);
    if (!snapshot.ok || !snapshot.base64) continue;
    try {
      await cloud.post(`/cameras/${camera.id}/snapshot`, {
        content_type: snapshot.contentType,
        base64: snapshot.base64,
        fetched_at: snapshot.fetchedAt,
      }, { timeout: UPLOAD_TIMEOUT_MS });
    } catch {
      // best-effort — if the cloud is unreachable, just skip this round
    }
  }
}
