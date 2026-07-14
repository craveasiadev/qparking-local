/**
 * TCP reachability probe for Alarmtech Touch'n'Go W4G payment devices. Backs
 * the "Test connection" button on the Payment terminals page — confirms the
 * device's host:port accepts a TCP connection before it's saved.
 *
 * Deliberately does NOT speak the W4G protocol: it opens a socket and closes it
 * the instant the connection succeeds. That's enough to tell "port open and
 * reachable" from "wrong IP / port / device off".
 */
import { Socket } from 'node:net';

const PROBE_TIMEOUT_MS = 3_000;

export interface TerminalPingResult { ok: boolean; latencyMs?: number; error?: string }

/** Translate a raw socket error code into an operator-readable reason. */
function explainNetError(raw: string): string {
  const s = String(raw);
  if (s.includes('ETIMEDOUT')) return 'timed out — no response (wrong IP, or device unreachable / firewalled)';
  if (s.includes('ECONNREFUSED')) return 'connection refused — nothing listening on that port (wrong port, or device off)';
  if (s.includes('EHOSTUNREACH')) return 'host unreachable — not on this LAN (check IP / routing)';
  if (s.includes('ENETUNREACH')) return 'network unreachable — check the LAN connection';
  if (s.includes('ENOTFOUND') || s.includes('EAI_AGAIN')) return 'host not found — check the IP / hostname';
  if (s.includes('ECONNRESET')) return 'connection reset by the device';
  return s;
}

export function pingTerminalHost(host: string, port: number): Promise<TerminalPingResult> {
  return new Promise((resolve) => {
    if (!host) { resolve({ ok: false, error: 'no_host' }); return; }
    const startedAt = Date.now();
    const sock = new Socket();
    let settled = false;
    const done = (r: TerminalPingResult) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(r);
    };
    sock.setTimeout(PROBE_TIMEOUT_MS);
    sock.once('connect', () => done({ ok: true, latencyMs: Date.now() - startedAt }));
    sock.once('timeout', () => done({ ok: false, error: explainNetError('ETIMEDOUT'), latencyMs: Date.now() - startedAt }));
    sock.once('error', (err: any) => done({ ok: false, error: explainNetError(err?.message ?? String(err)), latencyMs: Date.now() - startedAt }));
    try {
      sock.connect(port, host);
    } catch (err: any) {
      done({ ok: false, error: explainNetError(err?.message ?? String(err)), latencyMs: Date.now() - startedAt });
    }
  });
}
