/**
 * Camera connectivity probe. Cameras are LAN-local hardware, so only the
 * on-prem qparking-local server can reach them. Backs the "Test connection"
 * button on the LPR cameras page — confirms the camera IP is reachable before
 * saving. (Live view + capture snapshots now come from the camera's RTSP feed
 * via ffmpeg, not an HTTP snapshot URL.)
 */
import axios from 'axios';
import { getCamera } from './db';

const PING_TIMEOUT_MS = 3_000;

export interface PingResult {
  ok: boolean;
  status?: number;
  latencyMs?: number;
  error?: string;
  /** True when the device answered but refused the request (401/403, or a login
   *  redirect). Reachable — which is the whole question here — but not open. */
  needsAuth?: boolean;
}

/**
 * Lightweight HTTP reachability probe against a camera host:port. Takes the
 * host directly (not a DB id) so the "Test connection" button can probe the
 * values typed into the Add/Edit form BEFORE the camera is ever saved.
 */
export async function pingHost(host: string, port?: number): Promise<PingResult> {
  if (!host) return { ok: false, error: 'no_host' };
  const url = port && port !== 80 ? `http://${host}:${port}/` : `http://${host}/`;
  const startedAt = Date.now();
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: PING_TIMEOUT_MS,
      validateStatus: () => true,
    });
    // ANY HTTP response proves the device is THERE, which is the only thing this
    // probe is asked. Counting only 2xx as reachable called a camera whose web
    // root answers 401 — or redirects to a login page — "unreachable", when the
    // answer itself is the proof it is on the network and listening. The operator
    // was then sent to check an IP that was correct all along.
    //
    // A 5xx is still the device talking, so it counts as reachable too; the status
    // rides along either way, and an auth refusal is flagged so the caller can say
    // "reachable, needs credentials" rather than pretending it is wide open.
    const status = response.status;
    const needsAuth = status === 401 || status === 403 || (status >= 300 && status < 400);
    return { ok: true, status, needsAuth, latencyMs: Date.now() - startedAt };
  } catch (error: any) {
    return { ok: false, error: error?.message ?? String(error), latencyMs: Date.now() - startedAt };
  }
}

/** Probe a saved camera by id. Delegates to pingHost. */
export async function pingCamera(cameraId: number): Promise<PingResult> {
  const camera = getCamera(cameraId);
  if (!camera) return { ok: false, error: 'unknown_camera' };
  return pingHost(camera.host ?? '', camera.devicePort ?? undefined);
}
