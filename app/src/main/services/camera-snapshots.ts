/**
 * Camera connectivity probe. Cameras are LAN-local hardware, so only the
 * on-prem qparking-local server can reach them. Backs the "Test connection"
 * button on the LPR cameras page — confirms the camera IP is reachable before
 * saving. (Live view + capture snapshots now come from the device SDK, not an
 * HTTP snapshot URL.)
 */
import axios from 'axios';
import { getCamera } from './db';

const PING_TIMEOUT_MS = 3_000;

export interface PingResult { ok: boolean; status?: number; latencyMs?: number; error?: string }

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
    const httpOk = response.status >= 200 && response.status < 300;
    return { ok: httpOk, status: response.status, latencyMs: Date.now() - startedAt };
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
