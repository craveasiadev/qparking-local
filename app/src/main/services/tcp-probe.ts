/**
 * "Is anything listening on host:port?" — one socket, opened and dropped the
 * instant it connects. No protocol is spoken, so it can front any device.
 *
 * This exists because the alternative is a BLOCKING native connect. The vendor
 * LPR SDK's Open() is a synchronous FFI call: against an address that doesn't
 * answer it sat on the Electron main process for ~6 seconds — no IPC, no repaint
 * — which is what made saving a camera feel broken. A socket probe answers the
 * same question asynchronously and gives up in a fraction of the time, so the
 * expensive call is only ever made when it stands a chance of succeeding.
 *
 * Shared by the camera relay (gating that native connect) and the payment
 * terminal "Test connection" button, which needs the same three facts.
 */
import { Socket } from 'node:net';

export interface TcpProbeResult {
	ok: boolean;
	latencyMs: number;
	/** Raw socket error code (ECONNREFUSED, ETIMEDOUT, …); absent when ok. */
	code?: string;
}

/**
 * Default timeout for an operator-facing "Test connection", where waiting is the
 * point. The relay's automatic probing passes something far shorter — see
 * CONNECT_PROBE_TIMEOUT_MS in camera-relay.ts.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 3_000;

export function tcpProbe(host: string, port: number, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<TcpProbeResult> {
	return new Promise((resolve) => {
		const startedAt = Date.now();
		if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
			resolve({ ok: false, latencyMs: 0, code: 'EINVAL' });
			return;
		}
		const socket = new Socket();
		let settled = false;
		const done = (result: TcpProbeResult) => {
			if (settled) return;
			settled = true;
			// destroy(), not end(): a half-open socket to a device that never
			// replies would otherwise hold the handle for the OS timeout.
			try { socket.destroy(); } catch { /* ignore */ }
			resolve(result);
		};
		socket.setTimeout(timeoutMs);
		socket.once('connect', () => done({ ok: true, latencyMs: Date.now() - startedAt }));
		socket.once('timeout', () => done({ ok: false, latencyMs: Date.now() - startedAt, code: 'ETIMEDOUT' }));
		socket.once('error', (err: any) => done({ ok: false, latencyMs: Date.now() - startedAt, code: err?.code ?? err?.message ?? 'EUNKNOWN' }));
		try {
			socket.connect(port, host);
		} catch (err: any) {
			// connect() can throw synchronously on a malformed host.
			done({ ok: false, latencyMs: Date.now() - startedAt, code: err?.code ?? 'EUNKNOWN' });
		}
	});
}
