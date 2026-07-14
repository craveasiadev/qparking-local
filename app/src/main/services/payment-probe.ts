/**
 * TCP reachability probe for ECPI payment terminals. Backs the "Test
 * connection" button on the terminals page — confirms the reader's host:port
 * accepts a TCP connection before the terminal is saved / connected.
 *
 * Deliberately does NOT speak the ECPI protocol: it opens a socket, and closes
 * it the instant the connection succeeds. That's enough to tell "port open and
 * reachable" from "wrong IP / port / reader off". Note the reader allows only
 * ONE session, so if a terminal is already connected this probe may report the
 * port as busy (ECONNREFUSED) rather than open — that's expected.
 */
import { Socket } from 'node:net';
import { explainNetError } from './payment-ecpi';

const PROBE_TIMEOUT_MS = 3_000;

export interface TerminalPingResult { ok: boolean; latencyMs?: number; error?: string }

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
