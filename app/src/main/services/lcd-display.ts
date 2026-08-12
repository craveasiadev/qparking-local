/**
 * Driver-facing LCD panels (the qparking-lcd Android app).
 *
 * This box is the CLIENT: each configured panel listens on its own host:port and
 * we hold one long-lived TCP connection to it, pushing newline-delimited JSON
 * frames as the parking flow decides them. The panel acks each frame. The full
 * wire contract is qparking-lcd/PROTOCOL.md — change one, change both.
 *
 * What lands on the glass:
 *
 *   entry read      → ENTRY     plate + WELCOME
 *   exit, fee > 0   → EXIT      plate + "RM 5.00"
 *   exit, fee = 0   → EXIT      plate + FREE
 *   exit settled    → THANKYOU  plate + THANK YOU, then the panel idles itself
 *
 * The first rule of this module is that it CANNOT AFFECT THE PARKING FLOW. A
 * panel that is unplugged, wedged, or on the wrong IP must cost nothing but a
 * blank screen: every send is fire-and-forget, every failure is swallowed after
 * logging, and nothing here is ever awaited by the code that opens barriers or
 * charges cards. A display is the least important device at a barrier and must
 * never be able to strand a car at one.
 */
import net from 'node:net';
import type { LcdDisplay, LcdDisplayStatus, ParkingSession } from '../../shared/types';
import { getLaneLcd, getSessionById, listLcds } from './db';
import { parkingEvents } from './parking-flow';

// ─── tuning ─────────────────────────────────────────────────────────────────

/** Reconnect backoff. Starts fast (a panel rebooting is back in seconds) and
 *  caps low enough that a panel plugged back in comes alive without a restart. */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** Keepalive cadence. Comfortably inside the panel's 10-minute read timeout, and
 *  frequent enough that a silently-dead socket is found before a car arrives
 *  rather than at the moment one does. */
const PING_INTERVAL_MS = 30_000;

/** How long to wait for the TCP handshake before giving up and backing off. */
const CONNECT_TIMEOUT_MS = 5_000;

/**
 * A frame queued while the link was down is only worth sending if it is still
 * true. Past this age the car it described has gone, so we send idle instead —
 * a stale fare on the glass is worse than no fare at all.
 */
const STALE_FRAME_MS = 15_000;

/** How long FREE sits on screen before THANK YOU, on the pass-holder path where
 *  the flow settles the exit in a single step and there is no payment to wait
 *  for. Long enough to read, short enough not to hold up the next car. */
const FREE_DWELL_MS = 2_500;

// ─── logging ────────────────────────────────────────────────────────────────

/**
 * Mirrored into the renderer's live log alongside the parking-flow lines, so an
 * operator diagnosing "the screen is blank" sees the display decisions in the
 * same timeline as the plate reads that should have driven them.
 */
function llog(msg: string): void {
  const stamped = `[lcd] ${msg}`;
  console.log(stamped);
  parkingEvents.emit('debug-log', { ts: new Date().toISOString(), text: stamped });
}

// ─── frames ─────────────────────────────────────────────────────────────────

type ScreenName = 'idle' | 'entry' | 'exit' | 'thankyou';

interface Frame {
  screen: ScreenName;
  plate?: string | null;
  amountCents?: number | null;
  currency?: string | null;
  durationMinutes?: number | null;
  free?: boolean;
  holdMs?: number | null;
}

// ─── one connection ─────────────────────────────────────────────────────────

class LcdLink {
  private socket: net.Socket | null = null;
  private connecting = false;
  private closed = false;
  private seq = 0;
  private backoffMs = RECONNECT_MIN_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  /** Read buffer for the panel's ack lines. */
  private rx = '';
  /** Latest frame that could not be sent, held for the next successful connect. */
  private pending: { frame: Frame; at: number } | null = null;

  connected = false;
  lastAckAt: string | null = null;
  lastScreen: string | null = null;
  lastError: string | null = null;

  constructor(public lcd: LcdDisplay) {}

  status(): LcdDisplayStatus {
    return {
      lcdId: this.lcd.id,
      connected: this.connected,
      lastAckAt: this.lastAckAt,
      lastScreen: this.lastScreen,
      lastError: this.lastError,
    };
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    this.clearTimers();
    this.teardownSocket();
    this.connected = false;
  }

  private clearTimers(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  private teardownSocket(): void {
    const s = this.socket;
    this.socket = null;
    if (!s) return;
    // removeAllListeners first: destroy() fires 'close', which would otherwise
    // schedule a reconnect for a link we are deliberately tearing down.
    s.removeAllListeners();
    try { s.destroy(); } catch { /* already gone */ }
  }

  private connect(): void {
    if (this.closed || this.connecting || this.connected) return;
    this.connecting = true;

    const socket = new net.Socket();
    this.socket = socket;
    socket.setTimeout(CONNECT_TIMEOUT_MS);

    socket.once('connect', () => {
      this.connecting = false;
      this.connected = true;
      this.lastError = null;
      this.backoffMs = RECONNECT_MIN_MS;
      // The handshake budget is spent; from here the socket may legitimately sit
      // silent for as long as the car park is empty, so drop the idle timeout and
      // let the keepalive ping prove liveness instead.
      socket.setTimeout(0);
      socket.setNoDelay(true);
      socket.setKeepAlive(true, PING_INTERVAL_MS);
      llog(`connected to "${this.lcd.name}" (${this.lcd.host}:${this.lcd.port})`);

      this.startPinging();
      this.flushPending();
    });

    socket.on('data', (chunk) => this.onData(chunk));

    socket.once('timeout', () => {
      // Only reachable during the handshake — setTimeout(0) above disarms it.
      this.fail(`no answer from ${this.lcd.host}:${this.lcd.port} within ${CONNECT_TIMEOUT_MS}ms`);
    });

    socket.once('error', (err: NodeJS.ErrnoException) => {
      this.fail(describeSocketError(err, this.lcd));
    });

    socket.once('close', () => {
      if (this.closed) return;
      if (this.connected) llog(`lost connection to "${this.lcd.name}"`);
      this.connected = false;
      this.connecting = false;
      this.scheduleReconnect();
    });

    try {
      socket.connect(this.lcd.port, this.lcd.host);
    } catch (err) {
      // connect() throws synchronously on a malformed host, before any listener
      // can fire.
      this.fail(describeSocketError(err as NodeJS.ErrnoException, this.lcd));
    }
  }

  private fail(reason: string): void {
    // Log once per state change, not once per retry: a panel that is switched off
    // for the weekend would otherwise write a line every 30 seconds and bury
    // every real event in the operator's log.
    if (this.lastError !== reason) {
      llog(`"${this.lcd.name}" unreachable — ${reason}`);
    }
    this.lastError = reason;
    this.connected = false;
    this.connecting = false;
    this.clearTimers();
    this.teardownSocket();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    // Node keeps the process alive for a pending timer; on quit this would delay
    // shutdown by up to the backoff.
    this.reconnectTimer.unref?.();
  }

  private startPinging(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      this.write({ v: 1, seq: ++this.seq, type: 'ping' });
    }, PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  private onData(chunk: Buffer): void {
    this.rx += chunk.toString('utf8');
    // A panel that never sends a newline must not grow this buffer without
    // bound. Nothing legitimate comes close to this.
    if (this.rx.length > 64 * 1024) {
      llog(`"${this.lcd.name}" sent an oversized reply — dropping the connection`);
      this.fail('panel sent a malformed reply');
      return;
    }
    let nl: number;
    while ((nl = this.rx.indexOf('\n')) >= 0) {
      const line = this.rx.slice(0, nl).trim();
      this.rx = this.rx.slice(nl + 1);
      if (!line) continue;
      try {
        const ack = JSON.parse(line);
        if (ack?.type !== 'ack') continue;
        if (ack.ok) {
          this.lastAckAt = new Date().toISOString();
          this.lastScreen = ack.screen ?? null;
        } else {
          // The panel is alive and talking, so this is our bug, not the link's —
          // worth a line because it means a frame silently did nothing.
          llog(`"${this.lcd.name}" rejected frame seq=${ack.seq}: ${ack.error}`);
        }
      } catch {
        /* not JSON — a stray byte on the wire, ignore */
      }
    }
  }

  /** Serialise and write. Returns false when the link isn't usable. */
  private write(payload: Record<string, unknown>): boolean {
    const s = this.socket;
    if (!this.connected || !s || s.destroyed || !s.writable) return false;
    try {
      s.write(`${JSON.stringify(payload)}\n`);
      return true;
    } catch (err) {
      llog(`write to "${this.lcd.name}" failed: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Put a frame on the glass. Never throws and never blocks — a frame that
   * cannot be delivered is held for the next connect and dropped if it goes
   * stale before then.
   */
  show(frame: Frame): void {
    const payload: Record<string, unknown> = {
      v: 1,
      seq: ++this.seq,
      type: 'show',
      screen: frame.screen,
    };
    if (frame.plate != null) payload.plate = frame.plate;
    if (frame.amountCents != null) payload.amountCents = frame.amountCents;
    if (frame.currency != null) payload.currency = frame.currency;
    if (frame.durationMinutes != null) payload.durationMinutes = frame.durationMinutes;
    if (frame.free) payload.free = true;
    if (frame.holdMs != null) payload.holdMs = frame.holdMs;

    if (!this.write(payload)) {
      // Only the LATEST frame is worth keeping: the panel shows one screen, so a
      // backlog would replay a fare, a thank-you and an idle in a burst the
      // moment the link returned.
      this.pending = { frame, at: Date.now() };
    }
  }

  private flushPending(): void {
    const held = this.pending;
    this.pending = null;
    if (!held) return;
    if (Date.now() - held.at > STALE_FRAME_MS) {
      llog(`dropped a stale ${held.frame.screen} frame for "${this.lcd.name}" — showing idle instead`);
      this.show({ screen: 'idle' });
      return;
    }
    this.show(held.frame);
  }
}

/** Turn a socket errno into something an operator can act on. */
function describeSocketError(err: NodeJS.ErrnoException, lcd: LcdDisplay): string {
  switch (err?.code) {
    case 'ECONNREFUSED':
      return `nothing is listening on ${lcd.host}:${lcd.port} — check the panel is powered on and the qparking-lcd app is open, and that its Listen port matches ${lcd.port}`;
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `${lcd.host} is not reachable from this PC — check the cable, and that both are on the same network`;
    case 'ETIMEDOUT':
      return `${lcd.host}:${lcd.port} did not answer`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `"${lcd.host}" could not be resolved — enter the panel's IP address`;
    case 'ECONNRESET':
      return 'the panel closed the connection';
    default:
      return err?.code ? `${err.code}: ${err.message}` : (err?.message ?? 'unknown error');
  }
}

// ─── link registry ──────────────────────────────────────────────────────────

const links = new Map<number, LcdLink>();

/**
 * Reconcile the live links against the `lcds` table. Called on boot and after
 * every save/delete, so an operator's edit takes effect without a restart.
 *
 * A link is only torn down when its panel is genuinely gone or its address
 * moved — an unrelated edit (a rename, another panel added) must not drop a
 * connection that might be mid-transaction.
 */
export function reloadLcdLinks(): void {
  const configured = listLcds().filter((l) => l.enabled);
  const wanted = new Map(configured.map((l) => [l.id, l]));

  for (const [id, link] of links) {
    const next = wanted.get(id);
    if (!next) {
      link.stop();
      links.delete(id);
      llog(`stopped link to "${link.lcd.name}" (removed or disabled)`);
      continue;
    }
    if (next.host !== link.lcd.host || next.port !== link.lcd.port) {
      llog(`"${next.name}" moved to ${next.host}:${next.port} — reconnecting`);
      link.stop();
      links.delete(id);
      continue;
    }
    // Same address: keep the socket, just refresh the descriptive fields.
    link.lcd = next;
  }

  for (const lcd of configured) {
    if (links.has(lcd.id)) continue;
    const link = new LcdLink(lcd);
    links.set(lcd.id, link);
    link.start();
  }
}

/** Live link health for every configured panel, for the Displays page. */
export function getLcdStatuses(): LcdDisplayStatus[] {
  return listLcds().map(
    (lcd) =>
      links.get(lcd.id)?.status() ?? {
        lcdId: lcd.id,
        connected: false,
        lastAckAt: null,
        lastScreen: null,
        // A configured-but-disabled panel has no link, and saying so is more
        // useful than reporting a bare "not connected".
        lastError: lcd.enabled ? 'not started' : 'disabled',
      },
  );
}

// ─── sending ────────────────────────────────────────────────────────────────

/** Push a frame to the panel wired to this lane, if there is one. */
function showOnLane(laneId: number | null | undefined, frame: Frame): void {
  const lcd = getLaneLcd(laneId);
  if (!lcd) return;
  const link = links.get(lcd.id);
  if (!link) {
    // Configured but no live link — reloadLcdLinks hasn't caught up, or the row
    // was disabled between the lookup and here.
    llog(`no live link for "${lcd.name}" — ${frame.screen} frame dropped`);
    return;
  }
  link.show(frame);
}

/**
 * Fire a sample sequence at an address that may not be in the database yet —
 * backs the "Test" button on the LCD form, so an installer can prove the wiring
 * before saving anything. One-shot connection, torn down at the end.
 */
export function testLcd(host: string, port: number): Promise<{ ok: boolean; error?: string; latencyMs?: number }> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    const done = (result: { ok: boolean; error?: string; latencyMs?: number }) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* already gone */ }
      resolve(result);
    };

    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      resolve({ ok: false, error: 'Enter the panel\'s IP address and a port between 1 and 65535.' });
      return;
    }

    const socket = new net.Socket();
    socket.setTimeout(CONNECT_TIMEOUT_MS);

    socket.once('connect', () => {
      const send = (o: Record<string, unknown>) => socket.write(`${JSON.stringify(o)}\n`);
      send({ v: 1, seq: 1, type: 'show', screen: 'exit', plate: 'TEST 1234', amountCents: 500, durationMinutes: 135 });
      // Walk the panel through the real sequence rather than parking it on a
      // fake fare: the installer sees the fare, the thank-you and the return to
      // idle, which is the whole behaviour under test.
      setTimeout(() => send({ v: 1, seq: 2, type: 'show', screen: 'thankyou', plate: 'TEST 1234' }), 3_000);
      setTimeout(() => {
        send({ v: 1, seq: 3, type: 'idle' });
        done({ ok: true, latencyMs: Date.now() - startedAt });
      }, 6_000);
    });

    socket.once('timeout', () => done({ ok: false, error: `${host}:${port} did not answer within ${CONNECT_TIMEOUT_MS}ms.` }));
    socket.once('error', (err: NodeJS.ErrnoException) =>
      done({ ok: false, error: describeSocketError(err, { name: 'panel', host, port } as LcdDisplay) }));

    try {
      socket.connect(port, host);
    } catch (err) {
      done({ ok: false, error: describeSocketError(err as NodeJS.ErrnoException, { name: 'panel', host, port } as LcdDisplay) });
    }
  });
}

// ─── parking-flow subscriptions ─────────────────────────────────────────────

/**
 * Exits whose fare we have already put on screen, by sessionId. It answers one
 * question at settlement time: has the driver already seen a price?
 *
 * A pass-holder exit settles in a single step and never emits 'exit-pending', so
 * without this we could not tell it apart from a paid exit and would jump
 * straight to THANK YOU — the driver would never learn why they were let out
 * for nothing. Entries are swept on settlement; the periodic sweep below
 * catches sessions that never settled at all.
 */
const faresShown = new Map<number, number>();
const FARE_SHOWN_TTL_MS = 60 * 60_000;

function sweepFaresShown(): void {
  const cutoff = Date.now() - FARE_SHOWN_TTL_MS;
  for (const [id, at] of faresShown) {
    if (at < cutoff) faresShown.delete(id);
  }
}

export function startLcdDisplays(): void {
  reloadLcdLinks();

  // ─── entry: plate + WELCOME ───────────────────────────────────────────────
  parkingEvents.on('entry', (payload: { session: ParkingSession }) => {
    const session = payload?.session;
    if (!session) return;
    showOnLane(session.entryLaneId, { screen: 'entry', plate: session.plate });
  });

  // ─── exit priced: plate + fare (or FREE) ──────────────────────────────────
  parkingEvents.on(
    'exit-pending',
    (payload: { session: ParkingSession; lane: { id: number } | null; policy: { currency?: string } | null; durationMinutes: number; feeCents: number }) => {
      const { session, lane, policy, durationMinutes, feeCents } = payload ?? {};
      if (!session || !lane) return;
      faresShown.set(session.id, Date.now());
      showOnLane(lane.id, {
        screen: 'exit',
        plate: session.plate,
        // Send the amount even when it is zero AND set free: the panel prefers
        // the flag, and a sender that omitted the amount entirely would leave a
        // panel with a stricter reading of the spec showing nothing.
        amountCents: feeCents,
        free: feeCents === 0,
        currency: policy?.currency ?? null,
        durationMinutes,
      });
    },
  );

  // ─── exit settled: THANK YOU ──────────────────────────────────────────────
  parkingEvents.on('exit-completed', (payload: { sessionId: number; outcome: string }) => {
    const sessionId = payload?.sessionId;
    if (sessionId == null) return;
    const session = getSessionById(sessionId);
    if (!session) return;

    // exit-completed carries no lane, so recover it from the row the flow just
    // wrote. Falls back to the entry lane for the rare single-barrier site.
    const laneId = session.exitLaneId ?? session.entryLaneId;
    // delete() returns whether the key was there — the test and the cleanup in
    // one step, so a settled session can't leak into the map.
    const hadFareShown = faresShown.delete(sessionId);

    if (hadFareShown) {
      showOnLane(laneId, { screen: 'thankyou', plate: session.plate });
      return;
    }

    // No fare was ever shown — a season-pass exit, which the flow settles in one
    // step. Show FREE first so the driver sees why the barrier opened, then the
    // thank-you.
    showOnLane(laneId, { screen: 'exit', plate: session.plate, free: true, amountCents: 0, durationMinutes: session.durationMinutes, holdMs: FREE_DWELL_MS });
    const t = setTimeout(() => showOnLane(laneId, { screen: 'thankyou', plate: session.plate }), FREE_DWELL_MS);
    t.unref?.();
  });

  const sweep = setInterval(sweepFaresShown, FARE_SHOWN_TTL_MS);
  sweep.unref?.();

  llog(`display service started — ${links.size} panel(s) configured`);
}

/** Close every link. Called on app quit so sockets don't linger. */
export function stopLcdDisplays(): void {
  for (const link of links.values()) link.stop();
  links.clear();
}
