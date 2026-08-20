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
import { EventEmitter } from 'node:events';
import type { LcdDisplay, LcdDisplayStatus, ParkingSession } from '../../shared/types';
import { getLaneLcd, getSessionById, listLcds } from './db';
import { parkingEvents } from './parking-flow';

/**
 * Emits 'link' the moment a panel's connection state (or its failure reason)
 * changes.
 *
 * Exists so the health monitor does not have to POLL for something this module
 * already knows exactly. device-health.ts subscribes; nothing else should need to.
 * Deliberately carries no payload — the subscriber re-reads getLcdStatuses(),
 * which is an in-memory read, so there is nothing to be gained by shipping state
 * through the event and going stale.
 */
export const lcdEvents = new EventEmitter();

function announceLinkChange(): void {
  // Never let a subscriber's failure reach the socket callbacks that call this:
  // a display is the least important device at a barrier (see the header) and
  // must not be able to break anything by reporting its own state.
  try {
    lcdEvents.emit('link');
  } catch { /* ignore */ }
}

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

/**
 * How long a fare stays on the glass after the charge for it FAILED (declined,
 * timed out, no terminal, callbacks not running) before the panel goes back to
 * idle.
 *
 * It is a dwell rather than an instant wipe for two reasons. The driver gets a
 * beat to see the screen they were reading is finished with, and — the load-bearing
 * one — the flow decides whether to auto-retry in the same tick it announces the
 * failure: 'exit-declined' arrives, then 'exit-auto-retrigger' immediately after
 * if another attempt is armed. Cancelling a scheduled idle is therefore free,
 * while an idle already sent would have to be undone with a second frame the
 * driver would see flicker.
 */
const FAILED_FARE_DWELL_MS = 4_000;

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
      // Tell the health monitor NOW. It sweeps on a 60s timer, and this socket
      // already knows the exact instant the link came up — leaving the monitor to
      // discover it a minute later was why the cloud lagged so far behind this
      // app's own Displays page.
      announceLinkChange();

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
      const wasConnected = this.connected;
      this.connected = false;
      this.connecting = false;
      if (wasConnected) announceLinkChange();
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
    const changed = this.lastError !== reason || this.connected;
    if (this.lastError !== reason) {
      llog(`"${this.lcd.name}" unreachable — ${reason}`);
    }
    this.lastError = reason;
    // Report a NEW failure reason as well as a lost connection: "wrong IP" and
    // "panel switched off" are different things for the operator to be told.
    if (changed) announceLinkChange();
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
  // Whatever we are about to show is newer than a queued blank-the-screen, so
  // drop that first: a retrigger's fresh fare must not be wiped 2s later by the
  // idle scheduled when the PREVIOUS attempt failed.
  if (frame.screen !== 'idle') cancelPendingIdle(laneId, `superseded by a ${frame.screen} frame`);
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
 * Exits whose fare we have already put on screen, by sessionId. It answers two
 * questions: at settlement time, has the driver already seen a price? And on a
 * failed charge, WHICH panel is showing it?
 *
 * A pass-holder exit settles in a single step and never emits 'exit-pending', so
 * without this we could not tell it apart from a paid exit and would jump
 * straight to THANK YOU — the driver would never learn why they were let out
 * for nothing. Entries are swept on settlement; the periodic sweep below
 * catches sessions that never settled at all.
 *
 * The lane is remembered because a failed exit leaves the session OPEN, so the
 * row has no exit_lane_id yet — recovering the gate from the database would fall
 * back to the ENTRY lane and blank a panel at the far side of the site while the
 * one in front of the driver kept its dead fare.
 */
const faresShown = new Map<number, { at: number; laneId: number }>();
const FARE_SHOWN_TTL_MS = 60 * 60_000;

function sweepFaresShown(): void {
  const cutoff = Date.now() - FARE_SHOWN_TTL_MS;
  for (const [id, shown] of faresShown) {
    if (shown.at < cutoff) faresShown.delete(id);
  }
}

// ─── clearing a dead fare ───────────────────────────────────────────────────

/** Idle frames waiting out FAILED_FARE_DWELL_MS, by laneId. At most one per lane
 *  — a second failure on the same gate just restarts the clock. */
const pendingIdle = new Map<number, NodeJS.Timeout>();

function cancelPendingIdle(laneId: number | null | undefined, why: string): void {
  if (laneId == null) return;
  const timer = pendingIdle.get(laneId);
  if (!timer) return;
  clearTimeout(timer);
  pendingIdle.delete(laneId);
  llog(`lane ${laneId}: pending idle cancelled — ${why}`);
}

/** Send this lane's panel back to idle shortly, unless something supersedes it
 *  first (a retry being armed, or any new frame — see showOnLane). */
function scheduleIdle(laneId: number | null | undefined, why: string): void {
  if (laneId == null) return;
  const existing = pendingIdle.get(laneId);
  if (existing) clearTimeout(existing);
  llog(`lane ${laneId}: clearing the fare in ${FAILED_FARE_DWELL_MS}ms — ${why}`);
  const timer = setTimeout(() => {
    pendingIdle.delete(laneId);
    showOnLane(laneId, { screen: 'idle' });
  }, FAILED_FARE_DWELL_MS);
  timer.unref?.();
  pendingIdle.set(laneId, timer);
}

/**
 * The lane whose panel is showing this session's fare.
 *
 * Prefers what the payload states outright, then the lane we actually sent the
 * fare to, and only then the session row — see faresShown for why that last
 * resort is a poor one.
 */
function laneShowingFare(payload: { laneId?: number | null; sessionId?: number | null }): number | null {
  if (payload?.laneId != null) return payload.laneId;
  const sessionId = payload?.sessionId;
  if (sessionId == null) return null;
  const shown = faresShown.get(sessionId);
  if (shown) return shown.laneId;
  const session = getSessionById(sessionId);
  return session?.exitLaneId ?? session?.entryLaneId ?? null;
}

/** FREE, held long enough to read, then THANK YOU. The sequence for any exit the
 *  driver pays nothing for — a pass holder, or an operator waiving the fee. */
function showFreeThenThankYou(laneId: number | null | undefined, session: ParkingSession): void {
  showOnLane(laneId, { screen: 'exit', plate: session.plate, free: true, amountCents: 0, durationMinutes: session.durationMinutes, holdMs: FREE_DWELL_MS });
  const t = setTimeout(() => showOnLane(laneId, { screen: 'thankyou', plate: session.plate }), FREE_DWELL_MS);
  t.unref?.();
}

/**
 * An operator released this car by hand — put that on the glass.
 *
 * Called directly by the release handler rather than driven by an event, because
 * a manual release never enters the parking flow: it rewrites the row and pulses
 * the boom itself, so the 'exit-completed' subscription above never fires and the
 * panel was left showing whatever it had — a fare the driver is no longer being
 * asked for, or the last car's thank-you.
 *
 * `laneId` is the gate the operator chose to open, so the message lands on the
 * panel at the barrier that is actually lifting.
 *
 * Fire-and-forget like everything else here (see the module header): the car is
 * already going out, and a display must never be able to hold that up.
 */
export function showManualReleaseOnLane(laneId: number | null | undefined, session: ParkingSession): void {
  // Any fare put on screen for this session is now void — drop the marker so a
  // later settlement (a PayResult that lost the race, say) cannot decide the
  // driver "already saw a price" for a stay that no longer exists.
  faresShown.delete(session.id);
  llog(`manual release · ${session.plate} → FREE then THANK YOU on lane ${laneId ?? '—'}`);
  showFreeThenThankYou(laneId, session);
}

/**
 * Warnings that mean the fare on screen will never be collected as it stands.
 *
 * `exit-busy` is deliberately absent: that is a duplicate read arriving while a
 * DIFFERENT car is mid-charge, and the fare on the glass belongs to that car.
 * `exit-auto-retrigger` is handled separately — it is the one warning that says
 * "keep it up".
 */
const FAILED_FARE_WARNINGS = new Set([
  'exit-timeout',              // no response from the terminal
  'exit-charge-crashed',       // the charge threw
  'exit-no-terminal',          // fare priced, nothing wired to take it
  'exit-terminal-disabled',    // terminal switched off
  'exit-tng-not-configured',   // refused before sending: callbacks not running
  'exit-auto-retrigger-capped',// out of automatic attempts; only staff can move it now
]);

/**
 * The record behind the fare on screen has just been deleted or rewritten by an
 * operator — take it off the glass now.
 *
 * Neither the session editor nor the delete button goes anywhere near the parking
 * flow, so no event announces them: without this, deleting a car that owes RM 5.00
 * leaves its fare on the panel with no record left to pay it, and it is still
 * there when the next driver pulls up.
 *
 * Unlike a failed charge this is immediate, not a dwell: there is nothing left to
 * wait for and no retry that could revive it.
 *
 * Acts ONLY if this session is the one whose fare we actually put up. That is the
 * whole safety condition — if it isn't, the panel is showing another car (or is
 * already idle) and blanking it would take out a live fare belonging to someone
 * else's stay.
 */
export function clearFareForSession(sessionId: number, why: string): void {
  const shown = faresShown.get(sessionId);
  if (!shown) return;
  faresShown.delete(sessionId);
  cancelPendingIdle(shown.laneId, 'the fare is being cleared now');
  llog(`session ${sessionId}: clearing the fare on lane ${shown.laneId} — ${why}`);
  showOnLane(shown.laneId, { screen: 'idle' });
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
      faresShown.set(session.id, { at: Date.now(), laneId: lane.id });
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
    showFreeThenThankYou(laneId, session);
  });

  // ─── charge failed: take the dead fare off the glass ──────────────────────
  // Nothing is collecting the amount on screen any more, so leaving it up asks a
  // driver to pay something no terminal is armed for — and it is still there when
  // the NEXT car pulls up. All of these leave the session open at the barrier;
  // staff either retrigger (the fare comes back, see showOnLane) or release.
  parkingEvents.on('exit-declined', (p: any) => {
    scheduleIdle(laneShowingFare(p ?? {}), 'card declined');
  });
  parkingEvents.on('warning', (p: any) => {
    const kind = String(p?.kind ?? '');

    // A retry is armed for THIS lane — the terminal is about to ask again, so the
    // fare stays exactly where it is. Emitted in the same tick as the failure
    // above, which is what makes the scheduled idle cancellable rather than a
    // visible flicker. Deliberately not keyed on the session: the panel belongs
    // to the lane.
    if (kind === 'exit-auto-retrigger') {
      cancelPendingIdle(p?.laneId, `auto-retrigger #${p?.attempt ?? '?'}/${p?.max ?? '?'} armed`);
      return;
    }

    if (!FAILED_FARE_WARNINGS.has(kind)) return;
    scheduleIdle(laneShowingFare(p ?? {}), kind);
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
