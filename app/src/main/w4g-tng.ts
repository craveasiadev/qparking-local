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
import { getSettings, logTerminal } from './db';

// ─── debug formatters ──────────────────────────────────────────────────────
// Every W4G send/recv goes through these so the live log panel + the
// SQLite terminal_log table both carry a self-contained, human-readable
// summary. Goal: an operator (or a remote support engineer) can read a
// single log line and tell exactly what was sent, where, and what came
// back — no need to cross-reference timestamps with the device log.

const PAY_TYPE_LABEL: Record<number, string> = {
  0: 'TNG card',
  1: 'Visa',
  2: 'Mastercard',
  3: 'MCCS',
  4: 'TNG e-wallet',
};

/** Decode the per-spec error codes from `Error Codes.pdf` so the operator
 *  sees "Insufficient funds" instead of just "state=18". Falls back to the
 *  raw code when unknown. */
function decodeState(state: string | number): string {
  const n = typeof state === 'string' ? parseInt(state, 10) : state;
  if (Number.isNaN(n)) return String(state);
  const map: Record<number, string> = {
    0: 'Success',
    16: 'Card already registered — entry not allowed',
    17: 'Card not registered — exit not allowed',
    18: 'Insufficient funds',
    19: 'Exceeded limit',
    20: 'Card not found',
    21: 'Invalid card',
    22: 'Card blacklisted',
    33: 'Declined by bank',
    34: 'Bank connection timeout',
    35: 'Internal connection timeout',
    49: 'Condition not satisfied',
    50: 'Invalid input',
    210: 'Transaction declined',
  };
  return `${n} (${map[n] ?? 'unknown'})`;
}

/** Render epoch seconds as a local-time stamp + the raw epoch, so the
 *  operator can see both the human and machine representations. */
function fmtEpoch(epoch: number): string {
  if (!epoch || Number.isNaN(epoch)) return `${epoch}`;
  const d = new Date(epoch * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${local} (epoch ${epoch})`;
}

/** Render cents as "RM 1.00 (100c)" so the operator can verify both
 *  representations match the receipt + the device LCD. */
function fmtCents(c: number): string {
  return `RM ${(c / 100).toFixed(2)} (${c}c)`;
}

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
let servers: http.Server[] = [];
let activePorts: number[] = [];
let lastError: string | null = null;
let lastResult: { orderId: string; status: string; payType?: number; at: string } | null = null;

/** Port the device firmware hardcodes for its PayResult callback. We
 *  ALWAYS try to listen here in addition to the configured port so a
 *  default device shipped with notify-URL `<pms-ip>:80` Just Works
 *  without the operator manually changing port settings on the box. */
const DEVICE_HARDCODED_CALLBACK_PORT = 80;

/**
 * Single funnel for every W4G log line. Emits to the in-memory event bus
 * (Settings panel subscribes to this via the renderer's 'log' channel) AND
 * persists to the `terminal_log` SQLite table under `terminal_id = -1`
 * (sentinel value reserved for W4G — the ECPI terminals use positive ids
 * so the two streams don't collide). That way the operator can scroll
 * back through W4G activity after an app restart without losing context.
 */
function w4gLog(direction: 'send' | 'recv' | 'error' | 'info', message: string, payload?: unknown): void {
  w4gEvents.emit('log', { direction, message, payload });
  try { logTerminal(-1, direction, message, payload); } catch { /* DB best-effort */ }
}

/**
 * Build the listener's HTTP request handler. Same logic regardless of
 * which port we bound — both the configured callback port and the
 * hardcoded device port 80 share this handler so the device can hit
 * either and we'll process the request identically.
 */
function buildListenerHandler(): http.RequestListener {
  return (req, res) => {
    const remoteAddr = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const url = req.url ?? '';
    // Case-insensitive + trailing-slash + query-string tolerant match.
    const pathOnly = url.split('?')[0].replace(/\/+$/, '');
    const isPayResult = req.method === 'POST' && /^\/w4g\/payresult$/i.test(pathOnly);

    if (isPayResult) {
      handlePayResult(req, res).catch((e) => {
        lastError = e?.message ?? String(e);
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ State: 1, error: lastError }));
      });
      return;
    }

    let bodyBytes = 0;
    req.on('data', (c) => { bodyBytes += (c as Buffer).length; });
    req.on('end', () => {
      w4gLog(
        'error',
        `Unhandled HTTP request on listener: ${req.method} ${url} from ${remoteAddr}. Expected POST /w4g/PayResult — check the device's PayResult URL config.`,
        { method: req.method, url, headers: req.headers, bodyBytes, remoteAddr },
      );
    });
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      error: 'not_found',
      hint: 'Send POST /w4g/PayResult with the standard W4G payload',
    }));
  };
}

// ─── inbound callback server ────────────────────────────────────────────

/**
 * Bind the PayResult listener on every port we want to be reachable on.
 * Always tries:
 *   - The operator-configured `tngCallbackPort` (default 80)
 *   - Port 80 (because the device firmware hardcodes that for callbacks)
 * If either is already in use, we log a clear error and continue with the
 * one that bound — so a port-80 conflict (IIS, Apache) doesn't break the
 * whole feature.
 */
export function startW4gServer(primaryPort: number): void {
  stopW4gServer();

  const ports = new Set<number>([primaryPort, DEVICE_HARDCODED_CALLBACK_PORT]);
  for (const port of ports) {
    const srv = http.createServer(buildListenerHandler());
    srv.listen(port, '0.0.0.0', () => {
      activePorts.push(port);
      console.log(`[w4g-tng] PayResult listener on :${port}`);
      const note = port === DEVICE_HARDCODED_CALLBACK_PORT
        ? ' (matches the W4G firmware\'s hardcoded callback port)'
        : '';
      w4gLog('info', `Listener UP on 0.0.0.0:${port}${note} — device callback URL: http://<your-lan-ip>:${port}/w4g/PayResult`);
    });
    srv.on('error', (e: any) => {
      lastError = e.message;
      console.error(`[w4g-tng] server error on :${port}: ${e.message}`);
      const isPort80 = port === DEVICE_HARDCODED_CALLBACK_PORT;
      const hint = e.code === 'EADDRINUSE'
        ? (isPort80
            ? ` Another service (IIS, Apache, Skype, etc.) is bound to port 80 — stop it, or set the device's SERVER PORT to ${primaryPort} via the DebugTool.`
            : ` Pick a different port in Settings → Touch'n'Go.`)
        : '';
      w4gLog('error', `Listener failed to bind 0.0.0.0:${port}: ${e.message}.${hint}`, { code: e.code, port });
    });
    servers.push(srv);
  }
}

export function stopW4gServer(): void {
  for (const srv of servers) {
    try { srv.close(); } catch { /* ignore */ }
  }
  servers = [];
  activePorts = [];
}

async function handlePayResult(req: http.IncomingMessage, res: http.ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf-8');
  const remoteAddr = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');

  // Surface the full inbound HTTP envelope so the operator can verify the
  // device is talking to us correctly (path, headers, body bytes).
  w4gLog('info', `PayResult ← ${req.method} ${req.url} from ${remoteAddr} · ${raw.length} bytes`, {
    headers: req.headers,
    body_raw: raw,
  });

  let payload: any;
  try { payload = JSON.parse(raw); }
  catch {
    w4gLog('error', `PayResult ← INVALID JSON from ${remoteAddr}. Raw body: ${raw.slice(0, 200)}`, { raw });
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

  const approved = body.state === '0';
  const payTypeLabel = PAY_TYPE_LABEL[body.payType] ?? `code ${body.payType}`;
  w4gLog(
    'recv',
    `PayResult ← ${approved ? 'APPROVED' : 'DECLINED'} orderId=${body.orderId} state=${decodeState(body.state)} payType=${body.payType} (${payTypeLabel}) card=${body.cardNo} balance=${fmtCents(body.balance)} payTime=${fmtEpoch(body.payTime)} STAN=${body.stan} APPR_CODE=${body.apprCode || '<empty>'}`,
    body,
  );
  lastResult = {
    orderId: body.orderId,
    status: approved ? 'APPROVED' : 'DECLINED',
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
    w4gLog('info', `PayResult orphan — no pending order matches orderId=${body.orderId}. Likely a stale callback after timeout/cancel.`, body);
    w4gEvents.emit('orphan-result', body);
  }

  const ackBody = { State: 0, OrderId: body.orderId };
  const ackJson = JSON.stringify(ackBody);
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(ackJson);
  w4gLog('send', `PayResult → ACK ${remoteAddr}: ${ackJson}`, ackBody);
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
  const payTime = opts.payTime ?? Math.floor(Date.now() / 1000);
  // Default EnterTime to 10 minutes before PayTime so the device sees a
  // plausible "parked at, then paid at" duration. Sending equal or
  // out-of-order timestamps may make the firmware silently skip the
  // terminal trigger even though it still returns State:0 to the request.
  const enterTime = opts.enterTime ?? (payTime - 600);
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
      w4gLog('error', `PayRequest TIMEOUT after ${timeoutMs}ms — no PayResult callback received from device. Check that the device's PayResult URL points at http://<this-host>:${getSettings().tngCallbackPort}/w4g/PayResult`, { orderId, timeoutMs });
      // Fire-and-forget cancel so the device doesn't keep holding the
      // card for the full reader-side timeout.
      payCancel(orderId).catch(() => null);
      reject(new Error('w4g_timeout'));
    }, timeoutMs);

    // Log the OUTBOUND request BEFORE firing it — that way if the HTTP
    // call hangs or throws, the operator can still see what was about to
    // be sent (amount, timestamps, target URL).
    const targetUrl = `http://${s.tngHost}:${s.tngPort}/w4g/PayRequest`;
    w4gLog(
      'send',
      `PayRequest → ${targetUrl} orderId=${orderId} amount=${fmtCents(payAmount)} discount=${fmtCents(discountAmount)} enterTime=${fmtEpoch(enterTime)} payTime=${fmtEpoch(payTime)} timeout=${timeoutMs}ms · body=${spacedJson(body)}`,
      body,
    );

    httpPost('/w4g/PayRequest', body)
      .then((deviceAck) => {
        const ok = deviceAck.state === 0;
        w4gLog(
          ok ? 'recv' : 'error',
          `PayRequest ack ← ${ok ? 'ACCEPTED' : 'REJECTED'} state=${decodeState(deviceAck.state)} orderId=${deviceAck.orderId}${ok ? ' — device confirmed receipt, waiting for PayResult callback…' : ' — device refused the request, no callback will follow'}`,
          deviceAck,
        );
        if (deviceAck.state !== 0) {
          pendingByOrderId.delete(orderId);
          if (pending.timer) clearTimeout(pending.timer);
          reject(new Error(`device_rejected_state_${deviceAck.state}`));
        }
      })
      .catch((err) => {
        lastError = err?.message ?? String(err);
        w4gLog(
          'error',
          `PayRequest network error → ${targetUrl}: ${lastError}. Verify W4G DEVICE IP + W4G HTTP PORT in Settings, and that the device is powered on.`,
          { orderId, target: targetUrl, error: lastError },
        );
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
  const s = getSettings();
  const pending = pendingByOrderId.get(orderId);
  if (pending) {
    pendingByOrderId.delete(orderId);
    if (pending.timer) clearTimeout(pending.timer);
    pending.reject(new Error('w4g_cancelled'));
  }
  const targetUrl = `http://${s.tngHost}:${s.tngPort}/w4g/PayCancel`;
  const body = { OrderId: orderId };
  w4gLog(
    'send',
    `PayCancel → ${targetUrl} orderId=${orderId} · body=${spacedJson(body)}. Per spec the device only honours cancel after current deduction times out (~6s).`,
    body,
  );
  try {
    const ack = await httpPost('/w4g/PayCancel', body);
    w4gLog(
      'recv',
      `PayCancel ack ← state=${decodeState(ack.state)} orderId=${ack.orderId}`,
      ack,
    );
    return { state: ack.state, orderId };
  } catch (err: any) {
    w4gLog('error', `PayCancel network error → ${targetUrl}: ${err?.message ?? err}`, { orderId, target: targetUrl });
    throw err;
  }
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

/**
 * Serialize a flat object as the EXACT JSON shape the W4G device's tester
 * produces — `{"key": value, "key": value}` with space after every colon
 * and comma. The device returns State:0 for compact JSON too, but its
 * firmware ONLY actually triggers the terminal flow when the body matches
 * this format (empirically verified against the merchant's reference
 * test tool). Without the spaces the device silently accepts the request
 * without ringing up the operator screen.
 */
function spacedJson(obj: Record<string, unknown>): string {
  const parts = Object.entries(obj).map(([k, v]) => `"${k}": ${JSON.stringify(v)}`);
  return `{${parts.join(', ')}}`;
}

function httpPost(pathname: string, body: Record<string, unknown>): Promise<DeviceAck> {
  const s = getSettings();
  const json = spacedJson(body);
  // 15s gives slow embedded HTTP stacks more room to respond. The earlier
  // 8s was tight enough that legitimate slow firmwares looked like outright
  // failures. Per-transaction overall budget is still capped by
  // tngTimeoutSeconds (default 30s) — this only bounds the SEND leg.
  const TIMEOUT_MS = 15_000;
  const target = `http://${s.tngHost}:${s.tngPort}${pathname}`;
  return new Promise<DeviceAck>((resolve, reject) => {
    const start = Date.now();
    const stage = (label: string, extra?: unknown) => {
      const elapsed = Date.now() - start;
      w4gLog('info', `HTTP ${pathname} · ${label} · +${elapsed}ms`, extra);
    };

    const req = http.request({
      host: s.tngHost,
      port: s.tngPort,
      method: 'POST',
      path: pathname,
      timeout: TIMEOUT_MS,
      headers: {
        // Header set + casing matches the merchant's working tester output
        // verbatim. The W4G firmware appears to be header-name lowercase-
        // tolerant but order-sensitive in some firmware revs — keep this
        // order. Connection: close is critical because the embedded HTTP
        // server doesn't speak HTTP/1.1 keep-alive cleanly and will leave
        // the socket half-open after the response if we don't tell it to
        // close.
        'Accept': '*/*',
        'Connection': 'close',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(json),
      },
    }, (res) => {
      stage(`response headers ← ${res.statusCode} ${res.statusMessage ?? ''}`, {
        statusCode: res.statusCode,
        headers: res.headers,
      });
      const chunks: Buffer[] = [];
      res.on('data', (c) => {
        chunks.push(c as Buffer);
        stage(`data chunk (+${(c as Buffer).length} bytes, total ${chunks.reduce((s, b) => s + b.length, 0)})`);
      });
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        stage(`response complete · ${raw.length} bytes body`, { body_raw: raw });
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

    // Lifecycle telemetry — pinpoints exactly where a hung request stalls:
    //   - 'socket' fires when the agent provides a socket (almost instant)
    //   - 'connect' on the socket fires when TCP SYN/ACK completes
    //   - 'response' fires when HTTP headers are received
    //   - 'data' on response fires as body bytes arrive
    //   - 'end' fires when body is fully buffered
    //   - 'timeout' fires after TIMEOUT_MS of socket inactivity
    req.on('socket', (sock) => {
      stage('socket allocated');
      sock.on('connect', () => stage('TCP connected ✓'));
      sock.on('close', (hadErr) => stage(`socket closed${hadErr ? ' (with error)' : ''}`));
    });
    req.on('timeout', () => {
      stage(`TIMEOUT — no socket activity in ${TIMEOUT_MS}ms`);
      req.destroy(new Error(`request_timeout (>${TIMEOUT_MS / 1000}s) — target ${target}. If the previous "TCP connected ✓" stage IS in the log, the device accepted the connection but never sent an HTTP response; otherwise the firewall / wrong IP / wrong port is dropping the connect attempt.`));
    });
    req.on('error', (e) => reject(e));
    req.write(json);
    req.end();
    stage('request sent — awaiting response');
  });
}

/**
 * Self-test: simulate a PayResult callback by POSTing a synthetic payload
 * to our OWN /w4g/PayResult listener on 127.0.0.1:tngCallbackPort. Proves
 * the listener is alive, the port is reachable on loopback, and the parser
 * handles the canonical W4G payload. If this passes but real device
 * callbacks still don't arrive, the issue is purely network (device-side
 * URL config, firewall, or routing) — NOT our app.
 */
export function loopbackPayResult(opts: {
  orderId?: string;
  state?: string;
  payType?: number;
  cardNo?: string;
  balance?: number;
} = {}): Promise<{
  ok: boolean;
  status?: number;
  responseBody?: string;
  elapsedMs?: number;
  sentBody?: string;
  error?: string;
}> {
  const s = getSettings();
  if (!s.tngEnabled || activePorts.length === 0) {
    return Promise.resolve({ ok: false, error: 'listener_not_running — enable TNG and save settings first' });
  }
  // Loopback prefers the configured port; falls back to whichever port is
  // actually listening if the configured one didn't bind.
  const loopbackPort = activePorts.includes(s.tngCallbackPort) ? s.tngCallbackPort : activePorts[0];
  const payload = {
    State: opts.state ?? '0',
    OrderId: opts.orderId ?? `LOOPBACK${Math.floor(Date.now() / 1000)}`,
    PayType: opts.payType ?? 0,
    CardNo: opts.cardNo ?? '1234567890',
    Balance: opts.balance ?? 9999,
    PayTime: Math.floor(Date.now() / 1000),
    STAN: '000001',
    APPR_CODE: 'LOOP01',
  };
  const json = JSON.stringify(payload);
  w4gLog('info', `Loopback → POST 127.0.0.1:${loopbackPort}/w4g/PayResult · body=${json}`, payload);
  return new Promise((resolve) => {
    const start = Date.now();
    const req = http.request({
      host: '127.0.0.1',
      port: loopbackPort,
      method: 'POST',
      path: '/w4g/PayResult',
      timeout: 5_000,
      headers: {
        'Accept': '*/*',
        'Connection': 'close',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(json),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        const elapsed = Date.now() - start;
        const ok = res.statusCode === 200;
        w4gLog(
          ok ? 'recv' : 'error',
          `Loopback ← ${res.statusCode} ${res.statusMessage ?? ''} body=${body} · ${elapsed}ms${ok ? ' — listener processed the synthetic PayResult correctly' : ''}`,
          { status: res.statusCode, body },
        );
        resolve({ ok, status: res.statusCode, responseBody: body, elapsedMs: elapsed, sentBody: json });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('loopback_timeout (>5s)')); });
    req.on('error', (e) => {
      w4gLog('error', `Loopback failed: ${e.message}`);
      resolve({ ok: false, error: e.message, sentBody: json });
    });
    req.write(json);
    req.end();
  });
}

/**
 * Diagnostic helper for the Settings "Probe HTTP" button. Sends a plain
 * GET / to the device and reports status + headers + first 400 bytes of
 * the body. Lets the operator confirm the box is speaking HTTP at all on
 * the configured IP+port, independent of whether the W4G API is reachable.
 */
export function probeHttp(): Promise<{
  ok: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string | string[] | undefined>;
  bodyPreview?: string;
  elapsedMs?: number;
  error?: string;
}> {
  const s = getSettings();
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    const done = (r: Awaited<ReturnType<typeof probeHttp>>) => {
      if (settled) return;
      settled = true;
      const elapsed = Date.now() - start;
      const final = { ...r, elapsedMs: elapsed };
      w4gLog(
        r.ok ? 'recv' : 'error',
        `Probe HTTP → http://${s.tngHost}:${s.tngPort}/ · ${r.ok ? `${r.status} ${r.statusText ?? ''}` : `FAILED: ${r.error}`} · ${elapsed}ms`,
        final,
      );
      resolve(final);
    };
    try {
      const req = http.request({
        host: s.tngHost,
        port: s.tngPort,
        method: 'GET',
        path: '/',
        timeout: 8_000,
        headers: { 'Accept': '*/*', 'Connection': 'close' },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          done({
            ok: true,
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: res.headers as any,
            bodyPreview: body.slice(0, 400),
          });
        });
      });
      req.on('timeout', () => { req.destroy(new Error('connect/response timeout (>8s)')); });
      req.on('error', (e) => done({ ok: false, error: e.message }));
      req.end();
    } catch (e: any) {
      done({ ok: false, error: e?.message ?? String(e) });
    }
  });
}

// ─── status snapshot for Settings UI ────────────────────────────────────

export function w4gStatus(): {
  enabled: boolean;
  listening: boolean;
  listenPort: number;          // backwards-compat (first active port)
  listenPorts: number[];       // every port we successfully bound
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
    listening: activePorts.length > 0,
    listenPort: activePorts[0] ?? 0,
    listenPorts: [...activePorts],
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
