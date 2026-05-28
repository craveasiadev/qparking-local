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
import { app } from 'electron';
import type { ParkingLane, PaymentTerminal, ScopeRate } from '../shared/types';
import {
  createEntrySession, findOpenSessionByPlate, getLane, getScope, getSettings, getTerminal,
  listLanes, recordExit,
} from './db';
import { lprEvents, type PlateEvent } from './lpr-webhook';
import { getTerminalInstance } from './ecpi-terminal';

// Stamped into every parking-flow log line so the operator can verify they're
// running the build that has the latest fix — vs an older cached installer.
const BUILD_VERSION = (() => {
  try { return app.getVersion(); } catch { return 'dev'; }
})();

/**
 * Mirror every parking-flow log line to the renderer via parkingEvents so
 * the operator can see the live decisions without opening DevTools. Drops
 * a "[parking-flow vX.X.X]" prefix on every message for parity with the
 * console output. Also still emits to console for dev runs.
 */
function flog(msg: string): void {
  const stamped = `[parking-flow v${BUILD_VERSION}] ${msg}`;
  console.log(stamped);
  parkingEvents.emit('debug-log', { ts: new Date().toISOString(), text: stamped });
}

/**
 * Reader-replay protection state. The V1.17C firmware caches the last
 * successful cardRead frame internally and can re-push it on the NEXT
 * initCard — same maskPan, same hashPan, no human tap involved. The
 * elapsed time between the new initCard and the replayed cardRead can
 * be anywhere from instant to several seconds, so a pure timing guard
 * (MIN_TAP_MS) isn't sufficient.
 *
 * We track the hashPan + completedAt of the most recent successfully-
 * settled tap. If a new cardRead arrives with the SAME hashPan within
 * REPLAY_WINDOW_MS of the previous settle, we treat it as a replay and
 * reject — even if MIN_TAP_MS has been satisfied. Cleared after the
 * window expires so a legitimate same-card retry later still works.
 */
// Window during which the same hashPan as the last settled tap is treated
// as a held-card replay. 15 seconds is the tradeoff sweet spot:
//   - SHORT enough to allow queues (multiple cars / drivers sharing one
//     TNG card at busy gates — typical car-to-car cycle is 20+ seconds).
//   - LONG enough to catch held-card auto-detection cycles (the V1.17C
//     firmware re-detects a stationary card every 1-6 seconds and
//     generates a fresh-looking cardRead frame).
// Combined with the post-tap deinit/reinit cleanup, this gives reliable
// "lift card, next driver taps" behavior without false-positive queue
// blocks.
const REPLAY_WINDOW_MS = 15_000;
let lastSettledHashPan = '';
let lastSettledTxnDt = '';
let lastSettledAt = 0;

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
  flog(`plate event: plate=${event.plate} camDirection=${event.direction} cameraId=${event.cameraId}`);
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
    flog(`single-camera-mode: ${open ? 'open session found → EXIT' : 'no open session → ENTRY'}`);
  }

  // Find the lane for this camera.
  const lane = laneForCamera(event.cameraId);
  flog(`routed → ${direction}, lane=${lane?.id ?? 'null'} (terminalId=${lane?.terminalId ?? 'null'}, scopeId=${lane?.scopeId ?? 'null'})`);

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
  flog(`fee math: plate=${event.plate} duration=${durationMinutes}min scope=${scope?.scopeName ?? 'NONE'} freeMin=${scope?.freeMinutes ?? '-'} firstBlock=${scope?.firstBlockCents ?? '-'}c perBlock=${scope?.perBlockCents ?? '-'}c → computedFee=${feeCents}c`);

  // Operator-set minimum charge — forces the terminal flow even when the
  // computed fee is 0 (useful for testing the EMV flow without waiting
  // for duration > freeMinutes). Defaults to 0 (no override).
  const settings = getSettings();
  const minCharge = settings.minimumChargeCents ?? 0;
  if (minCharge > 0 && feeCents < minCharge) {
    flog(`minimumChargeCents=${minCharge} overrides computed ${feeCents}`);
    feeCents = minCharge;
  }

  parkingEvents.emit('exit-pending', { session, lane, scope, durationMinutes, feeCents, event });

  if (feeCents === 0) {
    // Genuinely free — no rate configured, OR duration within freeMinutes,
    // OR lane has no scope. Gate opens immediately; no terminal call is
    // possible because there's nothing to charge. We DO surface this on
    // the gate screen so the operator doesn't think the system was silent.
    flog(`FREE EXIT (fee=0) — no terminal interaction. Reason: ${!scope ? 'no scope on lane' : durationMinutes < (scope.freeMinutes ?? 0) ? `duration ${durationMinutes}min < freeMinutes ${scope.freeMinutes}` : 'scope rate is RM 0 — check Scopes page'}`);
    recordExit(session.id, {
      exitAt: new Date(exitMs).toISOString(),
      exitLaneId: lane.id,
      exitCameraId: event.cameraId,
      exitImagePath: event.imagePath,
      durationMinutes,
      feeCents: 0,
      paymentStatus: 'free',
      terminalTxnId: null,
      cardScheme: null,
      paymentTimestamp: null,
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
  console.log(`\n[parking-flow v${BUILD_VERSION}] === ENTER startExitCharge plate=${plate} fare=${feeCents}c lane=${lane.id} term=${terminalRow.id} ===`);
  const term = getTerminalInstance(terminalRow);

  const snap = term.snapshot();
  flog(`terminal snapshot: conn=${snap.conn} readerState=${snap.readerState} lastError=${snap.lastError}`);
  const LIVE: Array<typeof snap.conn> = ['connected', 'initialising', 'ready', 'transacting'];
  if (!LIVE.includes(snap.conn)) {
    flog(`BAIL: terminal not live (conn=${snap.conn})`);
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

  // ─── Step 1: silent close of any pending transaction ─────────────────
  // finTxn is the only state-change command that's silent on the display
  // (no "CANCELLED" flash, no auto-clearing showStatus timer). It closes
  // any pending transaction so the next initCard is accepted cleanly.
  //
  // The long 1500ms wait is critical: empirically on V1.17C, sending
  // initCard too quickly after finTxn results in the display flashing
  // "Pay RM X.XX" for a split second then reverting to idle "Welcome".
  // The reader needs time to fully process finTxn's state change and
  // settle into idle BEFORE we send the new initCard. 400ms wasn't
  // enough; 1500ms reliably gives the firmware time to settle.
  flog(`STEP 1: finTxn (silent close any pending)`);
  try {
    term.finTxn();
    await sleep(1500);
  } catch (e: any) {
    flog(`RESET FAILED: ${e?.message ?? e}`);
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

  // Bonus listener: surface every reader response so the operator can see
  // exactly what the firmware is doing during the wait window. Critical
  // for diagnosing "prompt disappears" — if the reader silently aborted,
  // the ack will tell us why (errorCode 2001/2002/2003/etc).
  const onAckLog = (parsed: any) => {
    const msg = parsed?.message;
    const type = parsed?.type;
    if (type !== 'ack') return;
    if (msg === 'initCard' || msg === 'finTxn' || msg === 'abortTxn' || msg === 'initTxn') {
      const ec = String(parsed?.body?.errorCode ?? '0000');
      const tag = ec === '0000' ? 'OK' : `REJECTED ec=${ec}`;
      flog(`reader ack: ${msg} → ${tag}`);
    }
  };
  term.on('frame', onAckLog);
  // Anti-replay guard: V1.17C firmware can re-emit a cached cardRead from
  // a PREVIOUS tap on the next initCard if the prior transaction wasn't
  // fully closed at the firmware level. That would settle a fresh session
  // as "paid" with no real tap — operator nightmare. So:
  //   1. Track when initCard was sent (initCardSentAt = 0 means not yet).
  //   2. Drop any cardRead that arrives BEFORE initCard was sent (=0).
  //   3. Drop any cardRead that arrives within `MIN_TAP_MS` of initCard
  //      being sent — a real human tap takes >800ms (button-press latency
  //      + EMV/TNG read + reader-to-host serialisation). Anything faster
  //      is the reader replaying state.
  // Suspicious frames are logged but not settled; the timeout still fires
  // if no genuine tap follows.
  const MIN_TAP_MS = 800;
  let initCardSentAt = 0;
  let lastMaskPan = '';
  const onFrame = (parsed: any) => {
    if (resolved) return;
    const msg = parsed?.message;
    if (msg !== 'cardRead') return;

    const maskPan = String(parsed?.body?.maskPan ?? '');
    const errorCode = String(parsed?.body?.errorCode ?? '');

    // Guard 1: cardRead before initCard was even sent → stale, ignore.
    if (initCardSentAt === 0) {
      flog(`IGNORED stale cardRead (pre-init) maskPan=${maskPan} ec=${errorCode}`);
      return;
    }

    // Guard 2: too-fast cardRead → reader replay, not a real tap.
    const elapsed = Date.now() - initCardSentAt;
    if (elapsed < MIN_TAP_MS) {
      flog(`IGNORED suspicious cardRead (only ${elapsed}ms after initCard, min=${MIN_TAP_MS}ms) maskPan=${maskPan} ec=${errorCode} — reader is replaying cached state, NOT a real tap`);
      return;
    }

    const hashPan = String(parsed?.body?.hashPan ?? '');

    // Guard 2b — TXN-DATE FRESHNESS CHECK (the strongest replay defence).
    // Each cardRead frame carries a `txnDt` field set by the reader at
    // the moment the card was actually presented. If the firmware caches
    // and replays an old cardRead on a later initCard, the txnDt stays
    // pinned to the original tap time. So if txnDt is BEFORE initCard
    // was sent (or even a few seconds before — clocks drift), the frame
    // is provably a replay and we reject it. This works even when the
    // cache is hours/days old, unlike a fixed-window check.
    const txnDtStr = String(parsed?.body?.txnDt ?? '');
    if (txnDtStr) {
      const txnDtMs = Date.parse(txnDtStr.replace(' ', 'T'));
      // The reader's clock may drift up to ~5 seconds from ours — allow that
      // much slack so a tap that happens to land slightly BEFORE initCard's
      // wall-clock isn't false-flagged. Anything more than 5s before is a
      // genuine replay (txnDt locked to an earlier tap).
      const REPLAY_TXNDT_SLACK_MS = 5_000;
      if (!Number.isNaN(txnDtMs) && txnDtMs < initCardSentAt - REPLAY_TXNDT_SLACK_MS) {
        const stalenessMs = initCardSentAt - txnDtMs;
        flog(`IGNORED REPLAY cardRead — txnDt=${txnDtStr} is ${stalenessMs}ms BEFORE initCard was sent. Reader is replaying a cached frame, NOT a fresh tap. maskPan=${maskPan} hashPan=${hashPan}`);
        return;
      }
    }

    // Guard 2c — IDENTICAL txnDt as the last settled tap. If the reader
    // pushes the EXACT same txnDt string we already accepted, this is a
    // literal frame replay (the firmware re-emitted the cached cardRead
    // without updating its tap-time stamp). There's no legitimate reason
    // for two real taps to share a txnDt down to the second, so reject.
    if (lastSettledTxnDt && txnDtStr && txnDtStr === lastSettledTxnDt) {
      flog(`IGNORED REPLAY cardRead — txnDt ${txnDtStr} EXACTLY MATCHES the last settled tap. Firmware replayed the cached frame verbatim.`);
      return;
    }

    // Guard 2d — same hashPan within REPLAY_WINDOW_MS (5 minutes). Catches
    // the "card left on/near the reader" case: the firmware auto-detects
    // the held card on each fresh initCard and generates a NEW cardRead
    // frame with a fresh txnDt — looks legitimate but the driver never
    // physically lifted and re-tapped. A genuine same-driver re-tap later
    // (after the window) still goes through.
    const sinceLastSettle = Date.now() - lastSettledAt;
    if (
      lastSettledHashPan &&
      hashPan &&
      hashPan === lastSettledHashPan &&
      sinceLastSettle < REPLAY_WINDOW_MS
    ) {
      const remainingS = Math.round((REPLAY_WINDOW_MS - sinceLastSettle) / 1000);
      flog(`IGNORED suspected replay — same hashPan as last tap ${Math.round(sinceLastSettle / 1000)}s ago. Likely the reader is still holding the previous card frame. If this is a legitimate next-driver tap, wait ${remainingS}s and tap again — window auto-clears.`);
      return;
    }

    // Guard 3: same maskPan as the last successful tap WITHIN THE SAME
    // initCard prompt is unusual — log it but accept (the driver might
    // legitimately re-tap to retry after a comms blip). Cleared on each
    // new startExitCharge so it doesn't leak across sessions.
    if (lastMaskPan && lastMaskPan === maskPan) {
      flog(`note: same maskPan as previous read in this session (${maskPan}) — accepting`);
    }
    lastMaskPan = maskPan;

    flog(`cardRead received maskPan=${maskPan} errorCode=${errorCode} elapsed=${elapsed}ms — settling`);
    resolved = true;
    resolvePush(parsed);
  };
  term.on('frame', onFrame);
  const timeoutHandle = setTimeout(() => {
    if (resolved) return;
    flog(`TIMEOUT after 60s — no card tap`);
    resolved = true;
    resolvePush(null);
  }, 60_000);

  // Now prompt the tap. Use the fare in the title so the driver sees
  // "Pay RM XX.XX" on the reader display while tapping.
  const fareDisplay = `Pay RM ${(feeCents / 100).toFixed(2)}`;
  flog(`STEP 3: initCard (prompting tap) — display="${fareDisplay}"`);
  try {
    term.initCard({
      fareClass: '1',
      retrigger: '1',
      titleTXT: fareDisplay,
      messageTXT: 'Please tap your card',
    });
    initCardSentAt = Date.now();
  } catch (e: any) {
    flog(`initCard THREW: ${e?.message ?? e}`);
    clearTimeout(timeoutHandle);
    term.off('frame', onFrame);
    term.off('frame', onAckLog);
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
  term.off('frame', onAckLog);

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
    // 60s elapsed with no tap. Silent abort — using 'failed' would make
    // the reader flash "PAYMENT CANCELED" on its LCD which confuses the
    // next driver in the queue (they think their own transaction failed
    // when really the previous attempt just timed out cleanly).
    try { term.abortTxn('silent'); } catch { /* ignore */ }
    parkingEvents.emit('warning', { kind: 'exit-timeout', sessionId: inflight.sessionId });
    return;
  }

  const outcome = result.approved ? 'paid' : 'declined';
  flog(`exit outcome=${outcome} maskPan=${result.maskPan ?? '-'} status=${result.status}`);

  // Record the just-settled card so the next initCard's cardRead can be
  // checked against it for replay (see Guard 2b above). We use hashPan
  // because it's stable per-card; maskPan formatting may vary across
  // firmware variants. Only set on APPROVED — declined attempts shouldn't
  // count as "previously settled" for replay-detection purposes.
  if (result.approved && push?.body?.hashPan) {
    lastSettledHashPan = String(push.body.hashPan);
    lastSettledTxnDt = String(push.body.txnDt ?? '');
    lastSettledAt = Date.now();
  }

  // txnDt comes back like "yyyy-MM-dd HH:mm:ss"; convert to ISO so the SaaS
  // can parse it the same way as exit_time. Falls back to null on garbage.
  const txnDtRaw = push?.body?.txnDt ? String(push.body.txnDt) : '';
  const paymentTimestamp = (() => {
    if (!txnDtRaw) return null;
    const t = Date.parse(txnDtRaw.replace(' ', 'T'));
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  })();

  recordExit(inflight.sessionId, {
    exitAt: new Date().toISOString(),
    exitLaneId: lane.id,
    exitCameraId: event.cameraId,
    exitImagePath: event.imagePath,
    durationMinutes: inflight.durationMinutes,
    feeCents: inflight.feeCents,
    paymentStatus: outcome,
    terminalTxnId: result.maskPan ?? null, // use maskPan as the txn reference
    cardScheme: result.cardScheme ?? null,
    paymentTimestamp,
  });

  // Lightweight post-tap cleanup. Just finTxn — close the transaction so
  // the reader is ready for the next initCard. No abortTxn here (the txn
  // is succeeding, not being cancelled — abortTxn would flash "Canceled"
  // on the reader display for the next driver). No deinit/init either,
  // it's overkill and causes the reader to hiccup on the next initCard.
  // The cardRead-handler guards (txnDt freshness + hashPan window)
  // catch any cache replays the firmware tries on the next transaction.
  flog('post-tap cleanup: finTxn');
  try { term.finTxn(); } catch { /* ignore */ }
  await sleep(400);
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
