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
import { getCamera, listCameras } from './db';
import { getSettings } from './db';

export interface SnapshotResult {
  ok: boolean;
  contentType?: string;
  base64?: string;          // jpeg payload (no data: prefix)
  fetchedAt?: string;
  status?: number;
  error?: string;
}

export async function fetchSnapshot(cameraId: number): Promise<SnapshotResult> {
  const cam = getCamera(cameraId);
  if (!cam) return { ok: false, error: 'unknown_camera' };
  if (!cam.snapshotUrl) return { ok: false, error: 'snapshot_url_not_set' };
  try {
    const res = await fetch(cam.snapshotUrl, {
      signal: AbortSignal.timeout(5_000),
      // Camera HTTP endpoints often use basic auth — leave the URL to carry
      // user:pass@host or let the operator embed it in snapshotUrl directly.
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `http_${res.status}` };
    }
    const ct = res.headers.get('content-type') || 'image/jpeg';
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      ok: true,
      contentType: ct,
      base64: buf.toString('base64'),
      fetchedAt: new Date().toISOString(),
      status: res.status,
    };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** Lightweight TCP/HTTP reachability probe — uses snapshotUrl if set, else
 *  falls back to http://<host>/. Mainly used by the UI's "Test connection"
 *  button so the operator knows the IP is right before saving. */
export async function pingCamera(cameraId: number): Promise<{ ok: boolean; status?: number; latencyMs?: number; error?: string }> {
  const cam = getCamera(cameraId);
  if (!cam) return { ok: false, error: 'unknown_camera' };
  const url = cam.snapshotUrl || (cam.host ? `http://${cam.host}/` : null);
  if (!url) return { ok: false, error: 'no_host_or_snapshot_url' };
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(3_000),
    });
    return { ok: res.ok, status: res.status, latencyMs: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e), latencyMs: Date.now() - t0 };
  }
}

// ─── periodic upload to qparking SaaS ──────────────────────────────────────
//
// Every camera with a snapshotUrl uploads its latest snapshot to qparking
// every UPLOAD_INTERVAL_MS. The cloud dashboard reads from these stored
// snapshots to give SaaS users a near-live view without needing direct
// access to the branch LAN. Cheap — small jpeg, infrequent push, only when
// the cloud sync is configured.

const UPLOAD_INTERVAL_MS = 10_000;
let uploadTimer: NodeJS.Timeout | null = null;

export function startSnapshotUploader() {
  stopSnapshotUploader();
  uploadTimer = setInterval(() => { void uploadAllSnapshots(); }, UPLOAD_INTERVAL_MS);
  // First run immediately so the cloud sees the cameras quickly.
  void uploadAllSnapshots();
}

export function stopSnapshotUploader() {
  if (uploadTimer) clearInterval(uploadTimer);
  uploadTimer = null;
}

async function uploadAllSnapshots() {
  const s = getSettings();
  if (!s.qparkingBaseUrl || !s.qparkingApiKey) return; // not configured — silently skip

  for (const cam of listCameras()) {
    if (!cam.enabled || !cam.snapshotUrl) continue;
    const snap = await fetchSnapshot(cam.id);
    if (!snap.ok || !snap.base64) continue;
    try {
      await fetch(`${s.qparkingBaseUrl.replace(/\/+$/, '')}/api/v1/local-server/cameras/${cam.id}/snapshot`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${s.qparkingApiKey}`,
        },
        body: JSON.stringify({
          content_type: snap.contentType,
          base64: snap.base64,
          fetched_at: snap.fetchedAt,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // best-effort — if the cloud is unreachable, just skip this round
    }
  }
}
