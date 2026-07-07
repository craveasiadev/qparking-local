/**
 * ECPI payment-terminal driver. One instance per terminal row in the DB.
 *
 * Protocol contract (from V3.9C+ KioskEcpi and V1.17C+ LprEcpi PDFs):
 *  - TCP socket, default port 5000, one connection per terminal.
 *  - All payload frames are newline-terminated UTF-8 JSON envelopes.
 *  - Heartbeat = two null bytes (0x00 0x00) every ≤30s. We send every 25s.
 *  - Every request/ack/response carries a sha256(secretKey + cleanMessage)
 *    signature where `cleanMessage` is the JSON envelope WITHOUT the
 *    `signature` field. The reader rejects any payload whose signature
 *    doesn't match.
 *  - Reader pushes unsolicited status frames (initEntryStatus, txnResult, etc).
 *    We MUST send an ACK back with the same messageTraceID and errorCode 0000.
 *
 * Lifecycle:
 *  connect() → socket established (state: 'connecting' → 'connected')
 *  initTerminal() → reader switches to live mode (state: 'ready')
 *  initCard()/initEntry()/initExit()/proceedEntry()/proceedExit()/finTxn()/abortTxn()
 *  disconnect() → tear it all down
 *
 * The class is an EventEmitter — see `Events` interface for what consumers
 * listen for. Higher-level parking-session logic subscribes here instead of
 * dealing with raw frames itself.
 */
import { Socket } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { PaymentTerminal, TerminalConnState, TerminalStatus, EcpiEnvelope } from '../shared/types';
import { logTerminal } from './db';

const HEARTBEAT_INTERVAL_MS = 25_000;
const TXN_TIMEOUT_MS = 30_000;
const INIT_TIMEOUT_MS = 120_000;
const FINISH_DELAY_MS = 5_000;

/** Exponential-backoff schedule for auto-reconnect after an unexpected drop.
 *  Stops at 30s so a flapping reader doesn't sleep too long between retries. */
const RECONNECT_DELAYS_MS = [2_000, 5_000, 10_000, 15_000, 30_000];

/** Map raw Node socket errors to human-friendly explanations + hint. */
function explainNetError(msg: string): string {
  if (msg.includes('ECONNRESET')) {
    return 'reader dropped the connection (ECONNRESET) — usually a reader reboot, network blip, or another client (Unity / tcsSimulator) opened a session';
  }
  if (msg.includes('ECONNREFUSED')) {
    return 'reader refused the connection (ECONNREFUSED) — usually wrong port, reader powered off, or another client already holds the single allowed session';
  }
  if (msg.includes('EHOSTUNREACH') || msg.includes('ENETUNREACH')) {
    return 'no route to reader — wrong IP, wrong subnet, or LAN cable unplugged';
  }
  if (msg.includes('ETIMEDOUT')) {
    return 'TCP timeout — reader on the network but not responding (frozen firmware?)';
  }
  return msg;
}

export interface Events {
  status: (s: TerminalStatus) => void;
  /** Fires whenever the terminal pushes ANY message — gate-side state machine listens. */
  frame: (frame: EcpiEnvelope, raw: string) => void;
  /** Final result of a transaction: APPROVED / DECLINED / TIMEOUT / CANCELLED. */
  txnResult: (result: { approved: boolean; raw: string; status: string; txnID?: string }) => void;
  /** Init card / read card success — carries plate-card details. */
  cardRead: (body: Record<string, unknown>) => void;
  /** Init entry/exit status update — reflects card insertion outcome. */
  initEntryStatus: (body: Record<string, unknown>) => void;
  initExitStatus: (body: Record<string, unknown>) => void;
  proceedExitStatus: (body: Record<string, unknown>) => void;
  log: (entry: { direction: 'send'|'recv'|'error'|'info'; message: string; payload?: unknown }) => void;
}

export class EcpiTerminal extends EventEmitter {
  private socket: Socket | null = null;
  private buffer = '';
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private txnTimer: NodeJS.Timeout | null = null;
  private initTimer: NodeJS.Timeout | null = null;
  private finishDelayTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  /** True once the operator explicitly clicks Disconnect — suppresses
   *  auto-reconnect so the terminal STAYS disconnected until they click
   *  Connect again. Cleared on every connect() call. */
  private userDisconnected = false;

  private _state: TerminalConnState = 'disconnected';
  private _readerState: string | null = null;
  private _lastError: string | null = null;
  private _lastHeartbeatAt: string | null = null;
  private _lastSeenAt: string | null = null;
  /** Set at exit-flow start so proceedExit can echo the right entryDt back. */
  private lastEntryDt: string = '';

  constructor(public terminal: PaymentTerminal) {
    super();
  }

  // ─── public api ──────────────────────────────────────────────────────────

  connect(): void {
    if (this.socket) return;
    // Cancel any pending auto-reconnect — we're going active.
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.userDisconnected = false;
    this.setState('connecting');
    const sock = new Socket();
    this.socket = sock;
    this.buffer = '';
    this._lastError = null;

    sock.setNoDelay(true);
    sock.setKeepAlive(true, 10_000);

    // Fail fast on unreachable hosts. Without this, the OS waits the default
    // TCP SYN timeout (~75s on Windows) which makes the UI look frozen even
    // though it isn't actually blocked. 5s is plenty for a LAN box.
    const connectTimer = setTimeout(() => {
      if (this._state === 'connecting') {
        this._lastError = 'connect timeout (>5s) — check IP, port, and that the reader is powered on';
        this.log('error', this._lastError);
        try { sock.destroy(); } catch { /* ignore */ }
        this.setState('error');
      }
    }, 5_000);

    sock.on('connect', () => {
      clearTimeout(connectTimer);
      // Successful connection clears the back-off — next drop will retry
      // from the shortest delay.
      this.reconnectAttempt = 0;
      this.setState('connected');
      this.log('info', 'tcp connected');
      this.initTerminal();
      this.startHeartbeat();
    });

    sock.on('data', (chunk) => {
      // Log raw bytes so we can debug exactly what the reader sends — this
      // surfaces frames that AREN'T \n-terminated, gives us hex for any
      // non-printable control bytes, and shows partial chunks while large
      // frames are still in flight.
      this.log('info', `recv raw ${chunk.length}B`, {
        hex: chunk.toString('hex').slice(0, 120),
        text: chunk.toString('utf-8').slice(0, 160),
      });
      this.buffer += chunk.toString('utf-8');
      this.drainBuffer();
    });

    sock.on('error', (e) => {
      clearTimeout(connectTimer);
      this._lastError = explainNetError(e.message);
      this.log('error', `socket error: ${this._lastError}`);
      this.setState('error');
    });

    sock.on('close', () => {
      clearTimeout(connectTimer);
      this.log('info', 'tcp closed');
      this.cleanup();
      this.socket = null;
      if (this._state !== 'error') this.setState('disconnected');
      // Auto-reconnect if this wasn't a user-initiated disconnect and the
      // terminal is still enabled in the DB.
      if (!this.userDisconnected && this.terminal.enabled) {
        this.scheduleReconnect();
      }
    });

    try {
      sock.connect(this.terminal.port, this.terminal.host);
    } catch (e: any) {
      clearTimeout(connectTimer);
      this._lastError = e.message;
      this.log('error', `connect threw: ${e.message}`);
      this.setState('error');
    }
  }

  disconnect(): void {
    this.log('info', 'disconnect requested by user — auto-reconnect suppressed');
    this.userDisconnected = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.reconnectAttempt = 0;
    try { this.deinitTerminal(); } catch { /* ignore */ }
    this.cleanup();
    try { this.socket?.destroy(); } catch { /* ignore */ }
    this.socket = null;
    this.setState('disconnected');
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    const i = Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1);
    const delay = RECONNECT_DELAYS_MS[i];
    const attemptNum = this.reconnectAttempt + 1;
    const reason = this._lastError ?? 'connection dropped';
    this._lastError = `${reason} — auto-reconnect in ${delay / 1000}s (attempt ${attemptNum})`;
    this.log('info', `auto-reconnect in ${delay / 1000}s (attempt ${attemptNum})`);
    // Re-emit status so the UI updates with the new lastError message.
    this.emit('status', this.snapshot());
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempt++;
      this.connect();
    }, delay);
  }

  /** Send the initial registration frame. */
  initTerminal(operationMode: '0'|'1'|'2' = this.opMode()): void {
    this.send('initTerminal', {
      plazaID: this.terminal.plazaId,
      laneID: this.terminal.laneId,
      operationMode,
      laneType: laneTypeCode(this.terminal.laneType),
    });
  }

  /** Switch the reader to "not in use" before closing the socket so the next
   *  connection can re-init cleanly. */
  deinitTerminal(): void {
    this.send('initTerminal', {
      plazaID: this.terminal.plazaId,
      laneID: this.terminal.laneId,
      operationMode: '2',
      laneType: laneTypeCode(this.terminal.laneType),
    });
  }

  getStatus(): void {
    this.send('getStatus', {});
  }

  /** Start a card scan (no payment, just read card details). */
  initCard(opts: { fareClass?: string; retrigger?: '0'|'1'; titleTXT?: string; messageTXT?: string } = {}): void {
    this.send('initCard', {
      fareClass: opts.fareClass ?? '1',
      retrigger: opts.retrigger ?? '1',
      titleTXT: opts.titleTXT ?? 'Tap Card',
      messageTXT: opts.messageTXT ?? 'Please tap your card',
    });
    this.armInitTimeout();
  }

  /** Kiosk-mode: start entry flow (used when this terminal is at an entry kiosk). */
  initEntry(opts: { mode?: '0'|'1'|'2'; fareAmount?: number; fareClass?: string } = {}): void {
    this.send('initEntry', {
      mode: opts.mode ?? '1',
      fareAmount: String(opts.fareAmount ?? 0),
      fareClass: opts.fareClass ?? '1',
      title: 'Entry',
      message: 'Please tap card',
    });
    this.armInitTimeout();
  }

  /** Kiosk-mode: start exit flow with the parking fee already computed. */
  initExit(opts: { mode?: '0'|'1'|'2' } = {}): void {
    this.send('initExit', { mode: opts.mode ?? '1' });
    this.armInitTimeout();
  }

  /** Send the actual entry charge after initEntryStatus came back 0000. */
  proceedEntry(opts: { payFlag?: -1 | 0 | 1 } = {}): void {
    const body: Record<string, string> = {};
    if ((opts.payFlag ?? -1) >= 0) body.payFlag = String(opts.payFlag);
    this.send('proceedEntry', body);
    this.armTxnTimeout();
  }

  /** Send the actual exit charge after initExitStatus came back with entryDt. */
  proceedExit(opts: { fareAmount: number; fareClass?: string; fallTimeout?: number; payFlag?: -1|0|1 }): void {
    const body: Record<string, string> = {
      fareAmount: String(opts.fareAmount),
      fareClass: opts.fareClass ?? '1',
      fallTimeout: String(opts.fallTimeout ?? 0),
    };
    if (this.lastEntryDt) body.entryDt = this.lastEntryDt;
    if ((opts.payFlag ?? -1) >= 0) body.payFlag = String(opts.payFlag);
    this.send('proceedExit', body);
    this.armTxnTimeout();
  }

  /** LPR-mode (V1.17C): start a card scan for an exit transaction with full
   *  fare breakdown. The reader handles the EMV/host auth and pushes
   *  txnStatus back when done. */
  initTxn(opts: {
    fareAmount: number; fareClass?: string; entryDt?: string; vehicleNo?: string;
    entryLane?: string; gstAmount?: number; pAmount?: number;
  }): void {
    this.send('initTxn', {
      txnType: 'EXIT',
      fareAmount: String(opts.fareAmount),
      fareClass: opts.fareClass ?? '1',
      retrigger: '1',
      ...(opts.entryDt ? { entryDt: opts.entryDt } : {}),
      ...(opts.vehicleNo ? { vehicleNo: opts.vehicleNo } : {}),
      ...(opts.entryLane ? { entryLane: opts.entryLane } : {}),
      gstAmount: String(opts.gstAmount ?? 0),
      gstTaxAmount: '0',
      sAmount: '0',
      sTaxAmount: '0',
      pAmount: String(opts.pAmount ?? opts.fareAmount),
      pTaxAmount: '0',
      discAmount: '0',
      discTaxAmount: '0',
    });
    this.armTxnTimeout();
  }

  abortTxn(reason: 'success'|'failed'|'silent' = 'silent'): void {
    const soundID = reason === 'success' ? '01' : reason === 'failed' ? '02' : 'FF';
    this.send('abortTxn', { soundID });
    this.clearTxnTimeout();
    this.clearInitTimeout();
  }

  finTxn(): void {
    this.send('finTxn', {});
    // Clear BOTH timers — finTxn completes both initCard (if pending) and
    // any in-flight txn. Leaving the init timer running was causing a
    // 120-second-later abortTxn to ghost-abort the next driver's prompt.
    this.clearAllTxnTimers();
  }

  /**
   * Refresh the reader's display with a title + message and play a sound.
   * Use this after a transaction completes to give the cardholder visual
   * confirmation — without it the reader just sits on the last screen
   * (typically "tap card") even though the payment already succeeded.
   *
   * sound: 01 success beep · 02 failed beep · FF silent
   * image: 04 success icon · 08 failed icon
   */
  showStatus(opts: { titleTXT: string; messageTXT: string; sound?: '01'|'02'|'FF'; image?: '04'|'08' }): void {
    this.send('showStatus', {
      titleTXT: opts.titleTXT.slice(0, 18),
      messageTXT: opts.messageTXT.slice(0, 40),
      soundID: opts.sound ?? '01',
      imageID: opts.image ?? '04',
    });
  }

  // ─── status snapshot ─────────────────────────────────────────────────────

  snapshot(): TerminalStatus {
    return {
      terminalId: this.terminal.id,
      conn: this._state,
      readerState: this._readerState,
      lastError: this._lastError,
      lastHeartbeatAt: this._lastHeartbeatAt,
      lastSeenAt: this._lastSeenAt,
    };
  }

  // ─── internal ────────────────────────────────────────────────────────────

  private opMode(): '0'|'1'|'2' {
    return this.terminal.operationMode === 'live' ? '1'
      : this.terminal.operationMode === 'maintenance' ? '0' : '2';
  }

  private setState(s: TerminalConnState) {
    if (this._state === s) return;
    this._state = s;
    this.emit('status', this.snapshot());
  }

  private send(message: string, body: Record<string, unknown>) {
    if (!this.socket) {
      this.log('error', `cannot send ${message} — socket closed`);
      return;
    }
    const envelope: EcpiEnvelope = {
      apiVersion: '1.0',
      message,
      type: 'request',
      timestamp: tsNow(),
      messageTraceID: traceId(message),
      body,
    };
    const json = JSON.stringify(envelope);
    const signature = sha256Hex(this.terminal.secretKey + json);
    const signed = json.slice(0, -1) + `,"signature":"${signature}"}`;
    try {
      this.socket.write(signed + '\n');
      this.log('send', message, envelope);
    } catch (e: any) {
      this.log('error', `write failed: ${e.message}`);
    }
  }

  private ack(message: string, traceID: string, errorCode = '0000') {
    if (!this.socket) return;
    const envelope: EcpiEnvelope = {
      apiVersion: '1.0',
      message,
      type: 'ack',
      timestamp: tsNow(),
      messageTraceID: traceID,
      body: { errorCode },
    };
    const json = JSON.stringify(envelope);
    const signature = sha256Hex(this.terminal.secretKey + json);
    const signed = json.slice(0, -1) + `,"signature":"${signature}"}`;
    try { this.socket.write(signed + '\n'); } catch { /* ignore */ }
  }

  /**
   * Pull as many complete JSON frames as we can out of the incoming buffer.
   * Handles three real-world flavours seen across ECPI firmware versions:
   *   1. \n-terminated frames (Unity sample sends this way)
   *   2. Back-to-back JSON objects with NO separator
   *   3. Stray 0x00 control bytes / partial heartbeat acks between frames
   * We skip whitespace + null bytes, then brace-balance from the next `{`
   * (ignoring braces inside string literals). Anything left in the buffer
   * after the last successful extraction stays buffered for the next read.
   */
  private drainBuffer() {
    while (this.buffer.length > 0) {
      // Skip leading whitespace + null bytes (heartbeat-ack residue, etc.)
      let start = 0;
      while (start < this.buffer.length && /[\s\0]/.test(this.buffer[start])) start++;
      if (start >= this.buffer.length) { this.buffer = ''; return; }
      if (this.buffer[start] !== '{') {
        // Junk byte — drop one char and try again.
        this.buffer = this.buffer.slice(start + 1);
        continue;
      }

      let depth = 0;
      let inString = false;
      let escape = false;
      let end = -1;
      for (let i = start; i < this.buffer.length; i++) {
        const c = this.buffer[i];
        if (escape) { escape = false; continue; }
        if (c === '\\') { escape = true; continue; }
        if (c === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (c === '{') depth++;
        else if (c === '}') {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }

      if (end === -1) return; // incomplete frame — wait for more data
      const raw = this.buffer.slice(start, end + 1);
      this.buffer = this.buffer.slice(end + 1);
      this.handleFrame(raw);
    }
  }

  private handleFrame(raw: string) {
    this._lastSeenAt = new Date().toISOString();
    let parsed: any;
    try { parsed = JSON.parse(raw); }
    catch (e) {
      this.log('error', 'malformed frame', { raw });
      return;
    }
    const message = parsed.message as string | undefined;
    const traceID = parsed.messageTraceID as string | undefined;
    const type = parsed.type as string | undefined;
    this.log('recv', message ?? 'unknown', parsed);
    this.emit('frame', parsed, raw);

    // Initial initTerminal ack means we're ready.
    if (message === 'initTerminal' && type === 'ack') {
      const ec = parsed.body?.errorCode;
      if (ec === '0000') {
        this.setState('ready');
      } else {
        this._lastError = `initTerminal rejected (errorCode=${ec}) — usually a bad secret key, wrong plazaID/laneID, or operationMode mismatch`;
        this.log('error', this._lastError);
        this.setState('error');
      }
      return;
    }

    // Some firmware versions return card details inline in the initCard ack
    // body (PDF 4.3 response table lists maskPan/hashPan/cardScheme fields).
    // Forward as a synthetic cardRead so the tester banner pops the same way
    // it would for a separate cardRead push.
    if (message === 'initCard' && type === 'ack' && parsed.body?.maskPan) {
      this.emit('cardRead', parsed.body ?? {});
    }

    // Any non-0000 ack from an init/proceed command is the reader telling us
    // it rejected the request. Surface as a clear error so the operator sees
    // why nothing happened (instead of silent emptiness).
    if (type === 'ack' && parsed.body?.errorCode && parsed.body.errorCode !== '0000') {
      const ec = String(parsed.body.errorCode);
      const friendly = ec === '3001' ? 'invalid / blacklisted card'
        : ec === '3000' ? 'no card detected (timeout)'
        : ec === '2001' ? 'reader busy — abort the previous transaction first'
        : ec === '2002' ? 'reader in wrong state — try resetting (abortTxn + finTxn)'
        : ec === '2003' ? 'reader hasn\'t finished processing the previous message — give it more time'
        : ec === '9999' ? 'unknown error (firmware-side)'
        : `errorCode ${ec}`;
      this._lastError = `${message} rejected: ${friendly}`;
      this.log('error', this._lastError, parsed);
      this.emit('status', this.snapshot());
    }

    // Defensive net: if ANY frame carries card-tap details (maskPan or
    // cardScheme), surface it as cardRead. Some firmware variants name the
    // push message inconsistently — this catches them all and pops the
    // banner so the operator can see the tap landed.
    if (parsed.body && (parsed.body.maskPan || parsed.body.cardScheme)) {
      this.emit('cardRead', parsed.body);
    }

    // Pushed status updates need an ACK back.
    if (message && traceID) {
      switch (message) {
        case 'initEntryStatus':
          this.ack(message, traceID);
          this.clearInitTimeout();
          this.emit('initEntryStatus', parsed.body ?? {});
          return;
        case 'initExitStatus':
          this.ack(message, traceID);
          this.clearInitTimeout();
          if (parsed.body?.entryDt) this.lastEntryDt = String(parsed.body.entryDt);
          this.emit('initExitStatus', parsed.body ?? {});
          return;
        case 'proceedExitStatus':
          this.ack(message, traceID);
          this.clearTxnTimeout();
          this.emit('proceedExitStatus', parsed.body ?? {});
          return;
        case 'txnStatus':
          this.ack(message, traceID);
          this.clearTxnTimeout();
          this.emit('frame', parsed, raw);
          return;
        case 'cardRead':
          this.ack(message, traceID);
          // cardRead fulfills the initCard's purpose — clear its safety-net
          // timer so the 120-second auto-abortTxn('silent') doesn't fire
          // later and confuse the next transaction.
          this.clearInitTimeout();
          this.emit('cardRead', parsed.body ?? {});
          return;
        case 'txnResult': {
          this.clearTxnTimeout();
          const status = String(parsed.body?.status ?? '').toUpperCase();
          const approved = status === 'APPROVED';
          this.emit('txnResult', { approved, raw, status, txnID: parsed.body?.txnID });
          // No ack — txnResult is itself the response side.
          return;
        }
        case 'getStatus':
          this._readerState = String(parsed.body?.state ?? '');
          return;
      }
    }
  }

  // ─── timers ──────────────────────────────────────────────────────────────

  private startHeartbeat() {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.socket) return;
      try {
        this.socket.write(Buffer.from([0x00, 0x00]));
        this._lastHeartbeatAt = new Date().toISOString();
      } catch (e: any) {
        this.log('error', `heartbeat failed: ${e.message}`);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }
  private clearHeartbeat() { if (this.heartbeatTimer) clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }

  private armTxnTimeout() {
    this.clearTxnTimeout();
    this.txnTimer = setTimeout(() => {
      this.log('error', 'txn timeout — silent abort');
      // 'silent' instead of 'failed' so the reader LCD doesn't flash
      // "PAYMENT CANCELLED" when this safety-net timer fires. The higher
      // layer (parking-flow) already handles its own timeout messaging.
      this.abortTxn('silent');
    }, TXN_TIMEOUT_MS);
  }
  private clearTxnTimeout() { if (this.txnTimer) clearTimeout(this.txnTimer); this.txnTimer = null; }

  private armInitTimeout() {
    this.clearInitTimeout();
    this.initTimer = setTimeout(() => {
      this.log('error', 'init timeout — silent abort');
      // 'silent' — see armTxnTimeout comment above.
      this.abortTxn('silent');
    }, INIT_TIMEOUT_MS);
  }
  private clearInitTimeout() { if (this.initTimer) clearTimeout(this.initTimer); this.initTimer = null; }

  /** Cancel any pending safety-net timers. Called whenever the transaction
   *  is provably resolved (cardRead arrived, finTxn sent, abortTxn sent)
   *  so a stale timer doesn't fire and ghost-abort the NEXT transaction. */
  private clearAllTxnTimers() {
    this.clearInitTimeout();
    this.clearTxnTimeout();
  }

  scheduleFinishAfterDelay() {
    if (this.finishDelayTimer) clearTimeout(this.finishDelayTimer);
    this.finishDelayTimer = setTimeout(() => this.finTxn(), FINISH_DELAY_MS);
  }

  private cleanup() {
    this.clearHeartbeat();
    this.clearTxnTimeout();
    this.clearInitTimeout();
    if (this.finishDelayTimer) clearTimeout(this.finishDelayTimer);
    this.finishDelayTimer = null;
  }

  private log(direction: 'send'|'recv'|'error'|'info', message: string, payload?: unknown) {
    logTerminal(this.terminal.id, direction, message, payload);
    this.emit('log', { direction, message, payload });
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

function tsNow(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function traceId(prefix: string): string {
  return `${prefix.toUpperCase()}${randomBytes(6).toString('hex')}`;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

function laneTypeCode(t: PaymentTerminal['laneType']): string {
  return t === 'entry' ? '1' : t === 'exit' ? '2' : t === 'open' ? '3' : '4';
}

// ─── manager: one terminal per row ─────────────────────────────────────────

const instances = new Map<number, EcpiTerminal>();

export function getTerminalInstance(t: PaymentTerminal): EcpiTerminal {
  let existing = instances.get(t.id);
  if (existing) {
    // Update mutable fields without re-creating the socket.
    existing.terminal = t;
    return existing;
  }
  const inst = new EcpiTerminal(t);
  instances.set(t.id, inst);
  return inst;
}

export function disposeTerminalInstance(id: number) {
  const inst = instances.get(id);
  if (inst) { inst.disconnect(); instances.delete(id); }
}

export function listTerminalInstances(): EcpiTerminal[] {
  return [...instances.values()];
}
