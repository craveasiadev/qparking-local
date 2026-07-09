/**
 * Shared HTTP client for the qparking SaaS cloud API.
 *
 * Every service that talks to the cloud (config sync, session push, camera /
 * device registry mirroring, snapshot upload) builds its client here so the
 * base URL, Bearer auth and default timeout live in exactly one place.
 */
import axios from 'axios';
import type { AxiosInstance } from 'axios';
import { getSettings } from './db';

export const CLOUD_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Build an axios client from the current Settings, or return null when the
 * operator hasn't configured the qparking SaaS yet. Re-created on every call
 * so a base-URL / API-key change in Settings applies immediately.
 */
export function getCloudApi(): AxiosInstance | null {
  const settings = getSettings();
  if (!settings.qparkingBaseUrl || !settings.qparkingApiKey) return null;
  return axios.create({
    baseURL: `${settings.qparkingBaseUrl.replace(/\/+$/, '')}/api/v1/local-server`,
    headers: { Authorization: `Bearer ${settings.qparkingApiKey}` },
    timeout: CLOUD_REQUEST_TIMEOUT_MS,
  });
}

/** True when `error` is an HTTP response with the given status code. */
export function isHttpStatus(error: unknown, status: number): boolean {
  return axios.isAxiosError(error) && error.response?.status === status;
}

/**
 * Human-readable message from any thrown request error. Prefers the response
 * body's own `message` / `error` field, then falls back to `http_<status>`
 * or the raw network error text (timeout, DNS, refused, …).
 */
export function describeRequestError(error: any): string {
  if (axios.isAxiosError(error) && error.response) {
    const responseBody: any = error.response.data;
    return responseBody?.message || responseBody?.error || `http_${error.response.status}`;
  }
  return String(error?.message ?? error);
}
