/**
 * Face-auth turnstile bridge. Calls faceapp_main's /api/external/open-gate
 * after a paid exit so the physical barrier raises in sync with the receipt
 * being printed.
 *
 * Disabled when faceappBaseUrl is empty — operator can configure later.
 * Best-effort: a failure here never blocks the parking flow, just logs.
 */
import axios from 'axios';
import type { AxiosInstance } from 'axios';
import { getSettings } from './db';

export interface OpenGateResult {
  ok: boolean;
  status?: number;
  error?: string;
  body?: unknown;
}

// Short timeout — turnstile open is a real-time action; if we don't get a
// response in 5s the gate isn't going to open anyway and the operator
// should fall back to manual.
const FACEAPP_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Build an axios client for the faceapp turnstile server, or return null
 * when the operator hasn't configured it yet. `validateStatus` accepts every
 * status so callers can report the HTTP code instead of catching a throw.
 */
function getFaceappApi(): AxiosInstance | null {
  const settings = getSettings();
  if (!settings.faceappBaseUrl || !settings.faceappApiToken) return null;
  return axios.create({
    baseURL: `${settings.faceappBaseUrl.replace(/\/+$/, '')}/api/external`,
    headers: { Authorization: `Bearer ${settings.faceappApiToken}` },
    timeout: FACEAPP_REQUEST_TIMEOUT_MS,
    validateStatus: () => true,
  });
}

export async function openFaceGate(opts: { plate?: string; reason?: string } = {}): Promise<OpenGateResult> {
  const settings = getSettings();
  // Master toggle — operator can disable faceapp integration entirely
  // without having to wipe the URL/token. Returns disabled (not an error)
  // so callers can quietly skip without logging noise.
  if (!settings.faceGateEnabled) {
    return { ok: false, error: 'face_gate_disabled' };
  }
  const faceapp = getFaceappApi();
  if (!faceapp) {
    return { ok: false, error: 'face_gate_not_configured' };
  }

  const requestBody: Record<string, unknown> = {
    reason: opts.reason ?? 'qparking-local',
    plate: opts.plate ?? null,
  };
  if (settings.faceappDeviceId && settings.faceappDeviceId > 0) {
    requestBody.device_id = settings.faceappDeviceId;
  }

  try {
    const response = await faceapp.post('/open-gate', requestBody);
    const responseBody: any = response.data ?? null;
    const httpOk = response.status >= 200 && response.status < 300;
    return { ok: httpOk && responseBody?.ok !== false, status: response.status, body: responseBody };
  } catch (error: any) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

