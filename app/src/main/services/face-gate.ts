/**
 * Face-auth turnstile bridge. Calls faceapp_main's /api/external/open-gate
 * after a paid exit so the physical barrier raises in sync with the receipt
 * being printed.
 *
 * Disabled when faceappBaseUrl is empty — operator can configure later.
 * Best-effort: a failure here never blocks the parking flow, just logs.
 */
import { getSettings } from './db';

export interface OpenGateResult {
  ok: boolean;
  status?: number;
  error?: string;
  body?: unknown;
}

export async function openFaceGate(opts: { plate?: string; reason?: string } = {}): Promise<OpenGateResult> {
  const s = getSettings();
  // Master toggle — operator can disable faceapp integration entirely
  // without having to wipe the URL/token. Returns disabled (not an error)
  // so callers can quietly skip without logging noise.
  if (!s.faceGateEnabled) {
    return { ok: false, error: 'face_gate_disabled' };
  }
  if (!s.faceappBaseUrl || !s.faceappApiToken) {
    return { ok: false, error: 'face_gate_not_configured' };
  }
  const url = `${s.faceappBaseUrl.replace(/\/+$/, '')}/api/external/open-gate`;
  const body: Record<string, unknown> = {
    reason: opts.reason ?? 'qparking-local',
    plate: opts.plate ?? null,
  };
  if (s.faceappDeviceId && s.faceappDeviceId > 0) body.device_id = s.faceappDeviceId;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${s.faceappApiToken}`,
      },
      body: JSON.stringify(body),
      // Short timeout — turnstile open is a real-time action; if we don't
      // get a response in 5s the gate isn't going to open anyway and the
      // operator should fall back to manual.
      signal: AbortSignal.timeout(5_000),
    });
    let parsed: any = null;
    try { parsed = await res.json(); } catch { /* ignore — non-json error pages */ }
    return { ok: res.ok && parsed?.ok !== false, status: res.status, body: parsed };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** Lightweight ping used by the Settings page to verify URL + token are correct
 *  before the operator commits the config. */
export async function pingFaceGate(): Promise<OpenGateResult> {
  const s = getSettings();
  if (!s.faceappBaseUrl || !s.faceappApiToken) {
    return { ok: false, error: 'face_gate_not_configured' };
  }
  const url = `${s.faceappBaseUrl.replace(/\/+$/, '')}/api/external/health`;
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${s.faceappApiToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    let parsed: any = null;
    try { parsed = await res.json(); } catch { /* ignore */ }
    return { ok: res.ok, status: res.status, body: parsed };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}
