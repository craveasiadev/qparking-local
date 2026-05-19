/**
 * Parking flow orchestrator. Subscribes to LPR plate events and drives the
 * payment terminal through the appropriate entry / exit sequence.
 *
 * Entry flow:
 *   1. plate event arrives on an entry-direction camera
 *   2. de-dup against any currently-open session for the same plate (gives the
 *      driver 5 minutes of "scanned again" tolerance before we open a 2nd one)
 *   3. create entry session, record entry_at
 *   4. (optional) trigger gate relay open — punted to a stub for now
 *
 * Exit flow:
 *   1. plate event arrives on an exit-direction camera
 *   2. look up open session, compute duration + fee from the lane's scope rate
 *   3. if fee == 0 → record exit immediately as "free", trigger gate
 *   4. otherwise → drive the payment terminal:
 *        kiosk-mode lane: terminal.initExit → waits for card tap → proceedExit
 *        lpr-mode lane: terminal.initTxn → reader runs EMV → txnResult arrives
 *   5. on APPROVED → record exit as paid, open gate
 *   6. on DECLINED/TIMEOUT/CANCELLED → session stays open; operator can
 *      manually release from the UI
 */
import { EventEmitter } from 'node:events';
import type { ParkingLane, PaymentTerminal, ScopeRate } from '../shared/types';
import {
  createEntrySession, findOpenSessionByPlate, getLane, getScope, getSettings, getTerminal,
  listLanes, recordExit,
} from './db';
import { lprEvents, type PlateEvent } from './lpr-webhook';
import { getTerminalInstance } from './ecpi-terminal';

export const parkingEvents = new EventEmitter();

interface ActiveExit {
  sessionId: number;
  plate: string;
  laneId: number;
  feeCents: number;
  durationMinutes: number;
  startedAt: number;
}
const exitsInFlight = new Map<number, ActiveExit>(); // keyed by laneId — one exit txn per lane

export function startParkingFlow() {
  lprEvents.on('plate', handlePlateEvent);
}

function handlePlateEvent(event: PlateEvent) {
  console.log(`[parking-flow] plate event: plate=${event.plate} camDirection=${event.direction} cameraId=${event.cameraId}`);
  // Route by camera direction:
  //   - dual:  open session present → exit, else entry
  //   - entry: normally always entry — UNLESS the operator has flipped on
  //            `entryCameraHandlesExit` in settings (single-lane sites where
  //            one camera covers both flows), in which case an open session
  //            for the same plate makes the second scan an exit.
  //   - exit:  always exit
  let direction: 'entry' | 'exit' = event.direction === 'exit' ? 'exit' : 'entry';
  if (event.direction === 'dual') {
    const open = findOpenSessionByPlate(event.plate);
    direction = open ? 'exit' : 'entry';
  } else if (event.direction === 'entry' && getSettings().entryCameraHandlesExit) {
    const open = findOpenSessionByPlate(event.plate);
    if (open) direction = 'exit';
    console.log(`[parking-flow] single-camera-mode: ${open ? 'open session found → EXIT' : 'no open session → ENTRY'}`);
  }

  // Find the lane for this camera.
  const lane = laneForCamera(event.cameraId);
  console.log(`[parking-flow] routed → ${direction}, lane=${lane?.id ?? 'null'} (terminalId=${lane?.terminalId ?? 'null'}, scopeId=${lane?.scopeId ?? 'null'})`);

  if (direction === 'entry') {
    handleEntry(event, lane);
  } else {
    handleExit(event, lane);
  }
}

function laneForCamera(cameraId: number): ParkingLane | null {
  const cam = require('./db').getCamera(cameraId);
  if (!cam?.laneId) return null;
  return getLane(cam.laneId);
}

function handleEntry(event: PlateEvent, lane: ParkingLane | null) {
  const existing = findOpenSessionByPlate(event.plate);
  if (existing) {
    // Already inside. Don't open a second session — that would let the same
    // car generate parallel "open" rows and confuse the fee/exit logic. Just
    // tell the renderer so the gate window can flash "ALREADY INSIDE" and
    // the operator/driver knows to use the exit lane.
    parkingEvents.emit('rescan-ignored', {
      plate: event.plate,
      sessionId: existing.id,
      entryAt: existing.entryAt,
    });
    return;
  }

  const session = createEntrySession(
    event.plate,
    lane?.id ?? null,
    event.cameraId,
    event.imagePath,
  );
  parkingEvents.emit('entry', { session, event });
  // TODO: pulse gate-relay if lane has gateRelayAddress configured.
}

async function handleExit(event: PlateEvent, lane: ParkingLane | null) {
  const session = findOpenSessionByPlate(event.plate);
  if (!session) {
    // Driver exiting without a recorded entry. Could be an LPR misread, OR
    // the entry camera was down. Surface to operator for manual handling.
    parkingEvents.emit('warning', {
      kind: 'exit-without-entry', plate: event.plate, cameraId: event.cameraId,
    });
    return;
  }

  if (!lane) {
    parkingEvents.emit('warning', { kind: 'exit-no-lane', plate: event.plate, sessionId: session.id });
    return;
  }

  // Compute fee from scope rate.
  const scope = lane.scopeId ? getScope(lane.scopeId) : null;
  const entryMs = Date.parse(session.entryAt);
  const exitMs = Date.now();
  const durationMinutes = Math.max(0, Math.ceil((exitMs - entryMs) / 60_000));
  let feeCents = computeFee(durationMinutes, scope);

  // Diagnostic — without this, a 0-fee exit looks identical to "terminal
  // didn't fire", which is exactly the support ticket we keep getting.
  console.log(`[parking-flow] fee math: plate=${event.plate} duration=${durationMinutes}min scope=${scope?.scopeName ?? 'NONE'} freeMin=${scope?.freeMinutes ?? '-'} firstBlock=${scope?.firstBlockCents ?? '-'}c perBlock=${scope?.perBlockCents ?? '-'}c → computedFee=${feeCents}c`);

  // Operator-set minimum charge — forces the terminal flow even when the
  // computed fee is 0 (useful for testing the EMV flow without waiting
  // for duration > freeMinutes). Defaults to 0 (no override).
  const settings = getSettings();
  const minCharge = settings.minimumChargeCents ?? 0;
  if (minCharge > 0 && feeCents < minCharge) {
    console.log(`[parking-flow] minimumChargeCents=${minCharge} overrides computed ${feeCents}`);
    feeCents = minCharge;
  }

  parkingEvents.emit('exit-pending', { session, lane, scope, durationMinutes, feeCents, event });

  if (feeCents === 0) {
    // Genuinely free — no rate configured, OR duration within freeMinutes,
    // OR lane has no scope. Gate opens immediately; no terminal call is
    // possible because there's nothing to charge. We DO surface this on
    // the gate screen so the operator doesn't think the system was silent.
    console.log(`[parking-flow] FREE EXIT (fee=0) — no terminal interaction. Reason: ${!scope ? 'no scope on lane' : durationMinutes < (scope.freeMinutes ?? 0) ? `duration ${durationMinutes}min < freeMinutes ${scope.freeMinutes}` : 'scope rate is RM 0 — check Scopes page'}`);
    recordExit(session.id, {
      exitAt: new Date(exitMs).toISOString(),
      exitLaneId: lane.id,
      exitCameraId: event.cameraId,
      exitImagePath: event.imagePath,
      durationMinutes,
      feeCents: 0,
      paymentStatus: 'free',
      terminalTxnId: null,
    });
    parkingEvents.emit('exit-completed', {
      sessionId: session.id,
      outcome: 'free',
      reason: !scope ? 'no-scope' : (durationMinutes < (scope.freeMinutes ?? 0) ? 'within-grace' : 'rate-zero'),
    });
    return;
  }

  // Paid exit — drive the payment terminal.
  if (!lane.terminalId) {
    parkingEvents.emit('warning', { kind: 'exit-no-terminal', laneId: lane.id });
    return;
  }
  const terminalRow = getTerminal(lane.terminalId);
  if (!terminalRow || !terminalRow.enabled) {
    parkingEvents.emit('warning', { kind: 'exit-terminal-disabled', terminalId: lane.terminalId });
    return;
  }

  if (exitsInFlight.has(lane.id)) {
    parkingEvents.emit('warning', { kind: 'exit-busy', laneId: lane.id });
    return;
  }

  exitsInFlight.set(lane.id, {
    sessionId: session.id, plate: event.plate, laneId: lane.id,
    feeCents, durationMinutes, startedAt: Date.now(),
  });

  // Fire-and-forget — startExitCharge is async but handleExit doesn't await
  // (handlePlateEvent is sync). Catch unhandled rejections so a buggy
  // promise doesn't crash the main process.
  startExitCharge(terminalRow, lane, session.plate, feeCents, session.entryAt, event)
    .catch((e) => {
      parkingEvents.emit('warning', {
        kind: 'exit-charge-crashed',
        sessionId: session.id, message: e?.message ?? String(e),
      });
      exitsInFlight.delete(lane.id);
    });
}

/**
 * Drive the reader through the exit transaction. Mirrors the Terminal
 * Tester's "Parking Flow Test" beat-for-beat:
 *
 *   1. Snapshot terminal state — bail if socket isn't open.
 *   2. Reset reader: abortTxn(silent) → 400ms → finTxn → 400ms.
 *   3. Subscribe to result listeners BEFORE sending initTxn (matches the
 *      Tester — comment in the Tester explicitly notes some firmware can
 *      push the response within ~50ms of the init ack, so subscribing
 *      after would race and miss it).
 *   4. Send initTxn — reader displays fare + "Tap card" prompt.
 *   5. Wait up to 60s for result.
 *   6. Record outcome, emit exit-completed, finTxn cleanup.
 */
async function startExitCharge(
  terminalRow: PaymentTerminal,
  lane: ParkingLane,
  plate: string,
  feeCents: number,
  entryAt: string,
  event: PlateEvent,
) {
  console.log(`\n[parking-flow] === ENTER startExitCharge plate=${plate} fare=${feeCents}c lane=${lane.id} term=${terminalRow.id} ===`);
  const term = getTerminalInstance(terminalRow);

  const snap = term.snapshot();
  console.log(`[parking-flow] terminal snapshot: conn=${snap.conn} readerState=${snap.readerState} lastError=${snap.lastError}`);
  const LIVE: Array<typeof snap.conn> = ['connected', 'initialising', 'ready', 'transacting'];
  if (!LIVE.includes(snap.conn)) {
    console.log(`[parking-flow] BAIL: terminal not live (conn=${snap.conn})`);
    parkingEvents.emit('warning', {
      kind: 'exit-terminal-offline',
      terminalId: terminalRow.id,
      connState: snap.conn,
      lastError: snap.lastError,
    });
    exitsInFlight.delete(lane.id);
    try { term.connect(); } catch { /* ignore */ }
    return;
  }

  // ─── Step 1: reset reader ────────────────────────────────────────────
  console.log('[parking-flow] STEP 1: abortTxn(silent)');
  try {
    term.abortTxn('silent');
    await sleep(400);
    console.log('[parking-flow] STEP 2: finTxn');
    term.finTxn();
    await sleep(400);
  } catch (e: any) {
    console.log(`[parking-flow] RESET FAILED: ${e?.message ?? e}`);
    parkingEvents.emit('warning', {
      kind: 'exit-terminal-send-failed',
      terminalId: terminalRow.id, message: e?.message ?? String(e),
    });
    exitsInFlight.delete(lane.id);
    return;
  }

  // ─── Step 3: initCard — prompt the driver to tap ─────────────────────
  // V1.17C LPR firmware is hardcoded to reject `initTxn` with errorCode
  // 2001/2003 regardless of preceding state (cold, after reset, after
  // cardRead, after deinit+init+warm-up — all fail). Empirically this
  // firmware never supports `initTxn` as a real-world command on this
  // hardware variant.
  //
  // What it DOES support is the standard Malaysian parking flow used
  // with Touch'n'Go and other auto-debit cards: when a card is tapped
  // during `initCard`, the reader internally settles the charge against
  // the card before returning the `cardRead` push. A cardRead with
  // errorCode=0000 therefore means BOTH "card read successfully" AND
  // "card debited by the reader". For declined cards the reader returns
  // a non-zero errorCode (3001 for blacklisted/insufficient, 3000 for
  // tap timeout) instead.
  //
  // So the exit flow is: prompt tap → wait for cardRead → if 0000 the
  // session is paid; otherwise declined. Then showStatus prints the
  // outcome on the reader's display so the driver sees confirmation
  // (matches what the Tester ENTRY direction does for entry registration).
  let resolved = false;
  let resolvePush!: (v: any) => void;
  const pushed = new Promise<any>((r) => { resolvePush = r; });
  const onFrame = (parsed: any) => {
    if (resolved) return;
    const msg = parsed?.message;
    if (msg === 'cardRead') {
      console.log(`[parking-flow] cardRead received maskPan=${parsed.body?.maskPan ?? '?'} errorCode=${parsed.body?.errorCode ?? '?'} — settling`);
      resolved = true;
      resolvePush(parsed);
    }
  };
  term.on('frame', onFrame);
  const timeoutHandle = setTimeout(() => {
    if (resolved) return;
    console.log('[parking-flow] TIMEOUT after 60s — no card tap');
    resolved = true;
    resolvePush(null);
  }, 60_000);

  // Now prompt the tap. Use the fare in the title so the driver sees
  // "Pay RM XX.XX" on the reader display while tapping.
  const fareDisplay = `Pay RM ${(feeCents / 100).toFixed(2)}`;
  console.log(`[parking-flow] STEP 3: initCard (prompting tap) — display="${fareDisplay}"`);
  try {
    term.initCard({
      fareClass: '1',
      retrigger: '1',
      titleTXT: fareDisplay,
      messageTXT: 'Please tap your card',
    });
  } catch (e: any) {
    console.log(`[parking-flow] initCard THREW: ${e?.message ?? e}`);
    clearTimeout(timeoutHandle);
    term.off('frame', onFrame);
    parkingEvents.emit('warning', {
      kind: 'exit-terminal-send-failed',
      terminalId: terminalRow.id, message: e?.message ?? String(e),
    });
    exitsInFlight.delete(lane.id);
    return;
  }

  // ─── Step 4: wait for the chain to complete (or timeout) ─────────────
  const push = await pushed;
  clearTimeout(timeoutHandle);
  term.off('frame', onFrame);

  // Translate cardRead into our { approved } shape. cardRead errorCode=0000
  // means the reader successfully read AND debited the card. Any non-zero
  // code means the tap failed (declined, timeout, blacklisted, etc).
  let result: { approved: boolean; status: string; maskPan?: string; cardScheme?: string } | null = null;
  if (push) {
    const body = push.body ?? {};
    const errorCode = String(body.errorCode ?? '');
    const approved = errorCode === '0000' && !!body.maskPan;
    result = {
      approved,
      status: approved ? 'APPROVED'
        : errorCode === '3001' ? 'DECLINED'
        : errorCode === '3000' ? 'TIMEOUT'
        : 'DECLINED',
      maskPan: body.maskPan as string | undefined,
      cardScheme: body.cardScheme as string | undefined,
    };
  }

  // ─── Step 4: record outcome ──────────────────────────────────────────
  const inflight = exitsInFlight.get(lane.id);
  if (!inflight) {
    try { term.finTxn(); } catch { /* ignore */ }
    return;
  }
  exitsInFlight.delete(lane.id);

  if (!result) {
    // 60s elapsed with no tap. Abort the reader and warn the operator.
    try { term.abortTxn('failed'); } catch { /* ignore */ }
    parkingEvents.emit('warning', { kind: 'exit-timeout', sessionId: inflight.sessionId });
    return;
  }

  const outcome = result.approved ? 'paid' : 'declined';
  console.log(`[parking-flow] exit outcome=${outcome} maskPan=${result.maskPan ?? '-'} status=${result.status}`);

  recordExit(inflight.sessionId, {
    exitAt: new Date().toISOString(),
    exitLaneId: lane.id,
    exitCameraId: event.cameraId,
    exitImagePath: event.imagePath,
    durationMinutes: inflight.durationMinutes,
    feeCents: inflight.feeCents,
    paymentStatus: outcome,
    terminalTxnId: result.maskPan ?? null, // use maskPan as the txn reference
  });

  // Close the reader transaction cleanly, then show "TQ" / "Failed" on
  // the reader display so the driver gets visual confirmation. Mirrors
  // exactly what the Tester ENTRY direction does after a successful
  // cardRead — it's a known-working sequence on this firmware.
  try { term.finTxn(); } catch { /* ignore */ }
  await sleep(500);
  const hhmm = (() => {
    const d = new Date(); const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  })();
  try {
    if (result.approved) {
      term.showStatus({
        titleTXT: 'Paid · TQ',
        messageTXT: `${inflight.plate} RM${(inflight.feeCents / 100).toFixed(2)} ${hhmm}`,
        sound: '01', image: '04',
      });
    } else {
      term.showStatus({
        titleTXT: 'Failed',
        messageTXT: `${inflight.plate} ${result.status} ${hhmm}`,
        sound: '02', image: '08',
      });
    }
  } catch { /* showStatus is best-effort */ }

  parkingEvents.emit('exit-completed', { sessionId: inflight.sessionId, outcome });
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// ─── fee calc ──────────────────────────────────────────────────────────────

/**
 * Block-based fee model matching how Malaysian car parks bill:
 *   - first `freeMinutes` are free (typically 10–15 mins for "drop off")
 *   - next `blockMinutes` (rounded up) costs `firstBlockCents`
 *   - every subsequent `blockMinutes` block (rounded up) costs `perBlockCents`
 *   - daily cap (in cents) applies if > 0
 */
export function computeFee(durationMinutes: number, scope: ScopeRate | null): number {
  if (!scope) return 0;
  const billable = Math.max(0, durationMinutes - scope.freeMinutes);
  if (billable === 0) return 0;
  const blocks = Math.ceil(billable / Math.max(1, scope.blockMinutes));
  let cents = scope.firstBlockCents + Math.max(0, blocks - 1) * scope.perBlockCents;
  if (scope.dailyCapCents > 0 && cents > scope.dailyCapCents) cents = scope.dailyCapCents;
  return cents;
}

/** Convert a stored ISO timestamp to the terminal-friendly "yyyy-MM-dd HH:mm:ss". */
function localDtFromIso(iso: string): string {
  try {
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  } catch { return ''; }
}

/** Used by the UI fee-preview panel — shows what the calculated charge WOULD be
 *  if a given plate were to exit right now. */
export function previewFee(plate: string): { found: boolean; sessionId?: number; durationMinutes?: number; feeCents?: number; scope?: ScopeRate | null } {
  const session = findOpenSessionByPlate(plate);
  if (!session) return { found: false };
  const lane = listLanes().find((l) => l.id === session.entryLaneId);
  const scope = lane?.scopeId ? getScope(lane.scopeId) : null;
  const durationMinutes = Math.max(0, Math.ceil((Date.now() - Date.parse(session.entryAt)) / 60_000));
  const feeCents = computeFee(durationMinutes, scope);
  return { found: true, sessionId: session.id, durationMinutes, feeCents, scope };
}
