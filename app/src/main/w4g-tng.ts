/**
 * Touch'n'Go W4G IO-controller integration.
 *
 * The W4G box (192.168.1.105 on the test rig) is a payment reader that
 * accepts TNG card / e-wallet / Visa / Master / MCCS taps and settles
 * through its own bank acquirer. It speaks a small HTTP protocol:
 *
 *   PMS  -> Device : POST http://<device>:<port>/w4g/PayRequest
 *   PMS  -> Device : POST http://<device>:<port>/w4g/PayCancel
 *   Device -> PMS  : POST http://<pms>:<callbackPort>/w4g/PayResult
 *
 * The device responds to PayRequest synchronously with a `State` field
 * that only confirms it accepted the request — the actual deduction
 * outcome arrives asynchronously on the PayResult callback. PMS must
 * acknowledge the callback with `{State:0, OrderId:...}` or the device
 * will retry it.
 *
 * Cancellation is non-immediate: per vendor docs, the device only honours
 * a PayCancel after its current deduction operation times out (~6s). We
 * still fire it as soon as the parking-flow decides to abandon the TNG
 * path (e.g. ECPI terminal got the tap first), and let the device sort
 * itself out.
 */
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { getSettings } from './db';

export interface PayResultBody {
  state: string;       // "0" success, anything else failed
  orderId: string;
  payType: number;     // 0 TNG card, 1 VISA, 2 MASTER, 3 MCCS, 4 TNG e-wallet
  cardNo: string;
  balance: number;
  payTime: number;
  stan: string;
  apprCode: string;
}

export interface PendingOrder {
  orderId: string;
  payAmount: number;
  discountAmount: number;
  enterTime: number;
  payTime: number;
  startedAt: number;
  resolve: (r: PayResultBody) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
}

export const w4gEvents = new EventEmitter();

const pendingByOrderId = new Map<string, PendingOrder>();
let server: http.Server | null = null;
let listenPort = 0;
let lastError: string | null = null;
let lastResult: { orderId: string; status: string; payType?: number; at: string } | null = null;

// ─── inbound callback server ────────────────────────────────────────────

export function startW4gServer(port: number): void {
  stopW4gServer();
  listenPort = port;
  server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url?.startsWith('/w4g/PayResult')) {
      handlePayResult(req, res).catch((e) => {
        lastError = e?.message ?? String(e);
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ State: 1, error: lastError }));
      });
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(`[w4g-tng] PayResult listener on :${port}`);
    w4gEvents.emit('log', { direction: 'info', message: `listener up on :${port}` });
  });
  server.on('error', (e) => {
    lastError = e.message;
    console.error(`[w4g-tng] server error: ${e.message}`);
    w4gEvents.emit('log', { direction: 'error', message: `server error: ${e.message}` });
  });
}

export function stopW4gServer(): void {
  if (server) {
    try { server.close(); } catch { /* ignore */ }
    server = null;
  }
  listenPort = 0;
}

async function handlePayResult(req: http.IncomingMessage, res: http.ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf-8');
  let payload: any;
  try { payload = JSON.parse(raw); }
  catch {
    w4gEvents.emit('log', { direction: 'error', message: 'PayResult: invalid JSON', payload: raw });
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ State: 1, error: 'invalid_json' }));
    return;
  }

  const body: PayResultBody = {
    state: String(payload.State ?? ''),
    orderId: String(payload.OrderId ?? ''),
    payType: Number(payload.PayType ?? -1),
    cardNo: String(payload.CardNo ?? ''),
    balance: Number(payload.Balance ?? 0),
    payTime: Number(payload.PayTime ?? 0),
    stan: String(payload.STAN ?? ''),
    apprCode: String(payload.APPR_CODE ?? ''),
  };

  w4gEvents.emit('log', { direction: 'recv', message: `PayResult orderId=${body.orderId} state=${body.state} payType=${body.payType}`, payload: body });
  lastResult = {
    orderId: body.orderId,
    status: body.state === '0' ? 'APPROVED' : 'DECLINED',
    payType: body.payType,
    at: new Date().toISOString(),
  };

  const pending = pendingByOrderId.get(body.orderId);
  if (pending) {
    pendingByOrderId.delete(body.orderId);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(body);
  } else {
    // No in-flight order matches — either a stale callback (we already
    // cancelled / timed out) or a manual test from outside this app. Log
    // and fan out via events so the Settings test panel can still display
    // it.
    w4gEvents.emit('orphan-result', body);
  }

  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ State: 0, OrderId: body.orderId }));
}

// ─── outbound client ────────────────────────────────────────────────────

/** Generate a fresh 32-char hex order id. Per vendor spec OrderId must
 *  be <= 32 chars; we use 16 random bytes = 32 hex chars. */
export function newOrderId(): string {
  return randomBytes(16).toString('hex');
}

/**
 * POST a PayRequest to the device and wait for the PayResult callback.
 * Resolves with the result body, or rejects on timeout / network error.
 * `payAmount` and `discountAmount` are in CENTS (matches our internal
 * representation; matches the W4G spec verbatim).
 */
export function payRequest(opts: {
  orderId?: string;
  payAmount: number;
  discountAmount?: number;
  enterTime?: number;
  payTime?: number;
  timeoutMs?: number;
}): Promise<PayResultBody> {
  const s = getSettings();
  const orderId = (opts.orderId ?? newOrderId()).slice(0, 32);
  const payAmount = Math.max(0, Math.round(opts.payAmount));
  const discountAmount = Math.max(0, Math.round(opts.discountAmount ?? 0));
  const enterTime = opts.enterTime ?? Math.floor(Date.now() / 1000);
  const payTime = opts.payTime ?? Math.floor(Date.now() / 1000);
  const timeoutMs = Math.max(2_000, (opts.timeoutMs ?? s.tngTimeoutSeconds * 1000));

  const body = {
    PayAmount: payAmount,
    DiscountAmount: discountAmount,
    EnterTime: enterTime,
    PayTime: payTime,
    OrderId: orderId,
  };

  return new Promise<PayResultBody>((resolve, reject) => {
    const pending: PendingOrder = {
      orderId,
      payAmount,
      discountAmount,
      enterTime,
      payTime,
      startedAt: Date.now(),
      resolve,
      reject,
      timer: null,
    };
    pendingByOrderId.set(orderId, pending);

    pending.timer = setTimeout(() => {
      if (!pendingByOrderId.has(orderId)) return;
      pendingByOrderId.delete(orderId);
      w4gEvents.emit('log', { direction: 'error', message: `PayRequest timed out after ${timeoutMs}ms`, payload: { orderId } });
      // Fire-and-forget cancel so the device doesn't keep holding the
      // card for the full reader-side timeout.
      payCancel(orderId).catch(() => null);
      reject(new Error('w4g_timeout'));
    }, timeoutMs);

    httpPost('/w4g/PayRequest', body)
      .then((deviceAck) => {
        w4gEvents.emit('log', { direction: 'send', message: `PayRequest sent orderId=${orderId} amount=${payAmount}c`, payload: body });
        w4gEvents.emit('log', { direction: 'recv', message: `PayRequest ack state=${deviceAck.state} orderId=${deviceAck.orderId}`, payload: deviceAck });
        if (deviceAck.state !== 0) {
          // Device refused to accept the request — no callback will ever
          // come, so resolve with a synthetic decline body now.
          pendingByOrderId.delete(orderId);
          if (pending.timer) clearTimeout(pending.timer);
          reject(new Error(`device_rejected_state_${deviceAck.state}`));
        }
      })
      .catch((err) => {
        lastError = err?.message ?? String(err);
        w4gEvents.emit('log', { direction: 'error', message: `PayRequest network error: ${lastError}`, payload: { orderId } });
        pendingByOrderId.delete(orderId);
        if (pending.timer) clearTimeout(pending.timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

/**
 * Cancel an in-flight order. Per spec, the device only honours this
 * after the current deduction operation times out (~6s). The local
 * pending promise is rejected immediately so the parking-flow can stop
 * waiting on it.
 */
export async function payCancel(orderId: string): Promise<{ state: number; orderId: string }> {
  const pending = pendingByOrderId.get(orderId);
  if (pending) {
    pendingByOrderId.delete(orderId);
    if (pending.timer) clearTimeout(pending.timer);
    pending.reject(new Error('w4g_cancelled'));
  }
  const ack = await httpPost('/w4g/PayCancel', { OrderId: orderId });
  w4gEvents.emit('log', { direction: 'send', message: `PayCancel sent orderId=${orderId}` });
  w4gEvents.emit('log', { direction: 'recv', message: `PayCancel ack state=${ack.state}`, payload: ack });
  return { state: ack.state, orderId };
}

/** TCP-connect to the device's HTTP port. Doesn't send anything — just
 *  verifies the box is reachable on the LAN. */
export function pingDevice(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const s = getSettings();
  const { Socket } = require('node:net') as typeof import('node:net');
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = new Socket();
    let settled = false;
    const done = (r: { ok: boolean; latencyMs?: number; error?: string }) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(r);
    };
    sock.setTimeout(5_000);
    sock.once('connect', () => done({ ok: true, latencyMs: Date.now() - start }));
    sock.once('timeout', () => done({ ok: false, error: 'connect_timeout (>5s)' }));
    sock.once('error', (e) => done({ ok: false, error: e.message }));
    try {
      sock.connect(s.tngPort, s.tngHost);
    } catch (e: any) {
      done({ ok: false, error: e?.message ?? String(e) });
    }
  });
}

interface DeviceAck { state: number; orderId: string }

function httpPost(pathname: string, body: unknown): Promise<DeviceAck> {
  const s = getSettings();
  const json = JSON.stringify(body);
  return new Promise<DeviceAck>((resolve, reject) => {
    const req = http.request({
      host: s.tngHost,
      port: s.tngPort,
      method: 'POST',
      path: pathname,
      timeout: 8_000,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(json),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode !== 200) {
          reject(new Error(`http_${res.statusCode}: ${raw.slice(0, 200)}`));
          return;
        }
        let parsed: any;
        try { parsed = JSON.parse(raw); }
        catch { reject(new Error(`bad_json: ${raw.slice(0, 200)}`)); return; }
        resolve({
          state: Number(parsed.State ?? 1),
          orderId: String(parsed.OrderId ?? ''),
        });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('request_timeout (>8s)')); });
    req.on('error', (e) => reject(e));
    req.write(json);
    req.end();
  });
}

// ─── status snapshot for Settings UI ────────────────────────────────────

export function w4gStatus(): {
  enabled: boolean;
  listening: boolean;
  listenPort: number;
  listenAddresses: string[];
  host: string;
  port: number;
  pending: { orderId: string; payAmount: number; startedAt: string }[];
  lastResult?: { orderId: string; status: string; payType?: number; at: string };
  lastError?: string;
} {
  const s = getSettings();
  const os = require('node:os') as typeof import('node:os');
  const addresses: string[] = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === 'IPv4' && !i.internal) addresses.push(i.address);
    }
  }
  return {
    enabled: s.tngEnabled,
    listening: server !== null,
    listenPort,
    listenAddresses: addresses,
    host: s.tngHost,
    port: s.tngPort,
    pending: [...pendingByOrderId.values()].map((p) => ({
      orderId: p.orderId,
      payAmount: p.payAmount,
      startedAt: new Date(p.startedAt).toISOString(),
    })),
    lastResult: lastResult ?? undefined,
    lastError: lastError ?? undefined,
  };
}

/** Map W4G PayType int → human card-scheme label stored on the session.
 *  Distinct suffix (`_W4G`) so finance reports can separate W4G-acquired
 *  Visa/Master taps from the ECPI terminal's normal Visa/Master flow. */
export function payTypeToCardScheme(payType: number): string {
  switch (payType) {
    case 0: return 'TNG_CARD';
    case 1: return 'VISA_W4G';
    case 2: return 'MASTER_W4G';
    case 3: return 'MCCS_W4G';
    case 4: return 'TNG_EWALLET';
    default: return `W4G_UNKNOWN_${payType}`;
  }
}
