/**
 * TCP reachability probe for Alarmtech Touch'n'Go W4G payment devices. Backs
 * the "Test connection" button on the Payment terminals page — confirms the
 * device's host:port accepts a TCP connection before it's saved.
 *
 * Deliberately does NOT speak the W4G protocol: it opens a socket and closes it
 * the instant the connection succeeds. That's enough to tell "port open and
 * reachable" from "wrong IP / port / device off".
 *
 * The socket work itself lives in tcp-probe.ts, shared with the camera relay;
 * what belongs HERE is the translation of a socket error code into something an
 * operator standing at a barrier can act on.
 */
import { tcpProbe } from './tcp-probe';

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

export async function pingTerminalHost(host: string, port: number): Promise<TerminalPingResult> {
  if (!host) return { ok: false, error: 'no_host' };
  const probe = await tcpProbe(host, port);
  return probe.ok
    ? { ok: true, latencyMs: probe.latencyMs }
    : { ok: false, error: explainNetError(probe.code ?? ''), latencyMs: probe.latencyMs };
}
