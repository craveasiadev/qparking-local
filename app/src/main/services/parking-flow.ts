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
 *   2. look up open session, compute duration + fee from the lane's policy rate
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
import type { ParkingLane, ParkingSession, PaymentTerminal, RatePolicy, TariffRule } from '../../shared/types';
import {
  createEntrySession, findOpenSessionByPlate, getCamera, getLane, getRatePolicy, getSiteDefaultRatePolicy, getSettings, getTerminal,
  listLanes, listCameras, recordExit, updateSessionFields, findSeasonPassByPlate, getSessionById,
} from './db';
import { lprEvents, normalisePlate, captureFrameToFile, type PlateEvent } from './lpr-webhook';
import { getTerminalInstance } from './ecpi-terminal';
import { payRequest as tngPayRequest, payCancel as tngPayCancel, payTypeToCardScheme, newOrderId as newTngOrderId } from './w4g-tng';

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
  flog(`routed → ${direction}, lane=${lane?.id ?? 'null'} (terminalId=${lane?.terminalId ?? 'null'}, policyId=${lane?.policyId ?? 'null'})`);

  if (direction === 'entry') {
    handleEntry(event, lane);
  } else {
    handleExit(event, lane);
  }
}

function laneForCamera(cameraId: number): ParkingLane | null {
  const camera = getCamera(cameraId);
  if (!camera?.laneId) return null;
  return getLane(camera.laneId);
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

  // Rate is governed by where the car ENTERED (then this exit lane, then the
  // site-default plan) — NOT by which exit gate it uses. This matches
  // previewFee and keeps the charge deterministic no matter which exit lane
  // the driver picks. The exit is still RECORDED against this lane below.
  const entryLane = session.entryLaneId ? getLane(session.entryLaneId) : null;
  const policy =
    (entryLane?.policyId ? getRatePolicy(entryLane.policyId) : null)
    ?? (lane.policyId ? getRatePolicy(lane.policyId) : null)
    ?? getSiteDefaultRatePolicy();
  const entryMs = Date.parse(session.entryAt);
  // exitAtOverride lets the dev simulator price a controlled stay; real camera
  // events leave it undefined, so this stays "now".
  const exitMs = event.exitAtOverride ? Date.parse(event.exitAtOverride) : Date.now();
  const exitIso = new Date(exitMs).toISOString();
  const durationMinutes = Math.max(0, Math.ceil((exitMs - entryMs) / 60_000));
  let feeCents = computeFee(durationMinutes, policy, session.entryAt, exitIso);

  // ─── Active-pass shortcut ────────────────────────────────────────────
  // Before driving the terminal, see if this plate is on the cached pass
  // roster from qparking SaaS. A match means the SaaS already settled
  // payment (monthly/quarterly/yearly pre-paid, or VIP/staff/free_access
  // explicitly waived). Skip the charge and open the gate — but still
  // record the exit so the audit row exists.
  // Season passes are site-scoped (one site per install), so look the plate up
  // directly — no policy dimension.
  const seasonPass = findSeasonPassByPlate(event.plate);
  if (seasonPass) {
    flog(`PASS MATCH: plate=${event.plate} pass=${seasonPass.passType} id=${seasonPass.passId} → free exit (skip terminal)`);
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
      reason: `pass-${seasonPass.passType}`,
      passId: seasonPass.passId,
    });
    return;
  }

  // Diagnostic — without this, a 0-fee exit looks identical to "terminal
  // didn't fire", which is exactly the support ticket we keep getting.
  flog(`fee math: plate=${event.plate} duration=${durationMinutes}min policy=${policy?.policyName ?? 'NONE'} freeMin=${policy?.freeMinutes ?? '-'} firstBlock=${policy?.firstBlockCents ?? '-'}c perBlock=${policy?.perBlockCents ?? '-'}c → computedFee=${feeCents}c`);

  // Operator-set minimum charge — forces the terminal flow even when the
  // computed fee is 0 (useful for testing the EMV flow without waiting
  // for duration > freeMinutes). Defaults to 0 (no override).
  const settings = getSettings();
  const minCharge = settings.minimumChargeCents ?? 0;
  if (minCharge > 0 && feeCents < minCharge) {
    flog(`minimumChargeCents=${minCharge} overrides computed ${feeCents}`);
    feeCents = minCharge;
  }

  parkingEvents.emit('exit-pending', { session, lane, policy, durationMinutes, feeCents, event });

  if (feeCents === 0) {
    // Genuinely free — no rate configured, OR duration within freeMinutes,
    // OR lane has no policy. Gate opens immediately; no terminal call is
    // possible because there's nothing to charge. We DO surface this on
    // the gate screen so the operator doesn't think the system was silent.
    flog(`FREE EXIT (fee=0) — no terminal interaction. Reason: ${!policy ? 'no policy on lane' : durationMinutes < (policy.freeMinutes ?? 0) ? `duration ${durationMinutes}min < freeMinutes ${policy.freeMinutes}` : 'policy rate is RM 0 — check Parking Policies page'}`);
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
      reason: !policy ? 'no-policy' : (durationMinutes < (policy.freeMinutes ?? 0) ? 'within-grace' : 'rate-zero'),
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

  // ─── Step 3b: TNG W4G race ───────────────────────────────────────────
  // If TNG is enabled, fire a PayRequest at the W4G IO controller in parallel
  // with the ECPI initCard. The driver can tap on either device — whichever
  // settles first wins, the other gets cancelled. This is how multi-acquirer
  // exits work in real Malaysian parks: ECPI for Visa/Master/credit and W4G
  // for TNG card / e-wallet sharing the same fare prompt.
  const settings = getSettings();
  const tngEnabled = settings.tngEnabled && !!settings.tngHost;
  const tngOrderId = tngEnabled ? newTngOrderId() : '';
  let tngWinner: { resolved: boolean; body?: any } = { resolved: false };
  let tngPromise: Promise<any> | null = null;
  if (tngEnabled) {
    flog(`STEP 3b: PayRequest → TNG W4G @ ${settings.tngHost}:${settings.tngPort} orderId=${tngOrderId} fare=${feeCents}c`);
    tngPromise = tngPayRequest({
      orderId: tngOrderId,
      payAmount: feeCents,
      discountAmount: 0,
      enterTime: Math.floor(Date.parse(entryAt) / 1000) || Math.floor(Date.now() / 1000),
      payTime: Math.floor(Date.now() / 1000),
      timeoutMs: Math.max(15_000, (settings.tngTimeoutSeconds ?? 30) * 1000),
    }).then((body) => {
      tngWinner = { resolved: true, body };
      // If the ECPI side hasn't resolved yet, this wins the race — release
      // the awaiter so we can record the TNG outcome.
      if (!resolved) {
        resolved = true;
        resolvePush({ __tng: body });
      }
      return body;
    }).catch((e) => {
      flog(`TNG PayRequest rejected: ${e?.message ?? e}`);
      return null;
    });
  }

  // ─── Step 4: wait for the chain to complete (or timeout) ─────────────
  const push = await pushed;
  clearTimeout(timeoutHandle);
  term.off('frame', onFrame);
  term.off('frame', onAckLog);

  // If TNG won the race, cancel any pending ECPI tap and translate the W4G
  // PayResult into our { approved } shape. State="0" = success per spec.
  let result: { approved: boolean; status: string; maskPan?: string; cardScheme?: string; via?: 'ecpi'|'tng'; tngPayTime?: number } | null = null;
  if (push && (push as any).__tng) {
    const tngBody = (push as any).__tng as { state: string; payType: number; cardNo: string; apprCode: string; payTime: number };
    try { term.abortTxn('silent'); } catch { /* ignore */ }
    const approved = tngBody.state === '0';
    result = {
      approved,
      status: approved ? 'APPROVED' : `DECLINED_W4G_${tngBody.state}`,
      maskPan: tngBody.cardNo || undefined,
      cardScheme: payTypeToCardScheme(tngBody.payType),
      via: 'tng',
      tngPayTime: tngBody.payTime,
    };
    flog(`TNG won race — payType=${tngBody.payType} card=${tngBody.cardNo} appr=${tngBody.apprCode}`);
  } else if (push) {
    // ECPI cardRead settled — cancel any in-flight TNG order so the W4G
    // device doesn't double-charge if the driver also taps it.
    if (tngEnabled && !tngWinner.resolved) {
      tngPayCancel(tngOrderId).catch(() => null);
    }
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
      via: 'ecpi',
    };
  } else if (tngEnabled && !tngWinner.resolved) {
    // ECPI timed out (60s). Give the TNG promise its remaining budget — it
    // may still be waiting on a tap. Cancel only if it hasn't resolved by
    // then. This block runs only when both branches are still in flight.
    try {
      const tngBody = await Promise.race([
        tngPromise ?? Promise.resolve(null),
        new Promise<null>((r) => setTimeout(() => r(null), 5_000)),
      ]);
      if (tngBody) {
        const approved = tngBody.state === '0';
        result = {
          approved,
          status: approved ? 'APPROVED' : `DECLINED_W4G_${tngBody.state}`,
          maskPan: tngBody.cardNo || undefined,
          cardScheme: payTypeToCardScheme(tngBody.payType),
          via: 'tng',
          tngPayTime: tngBody.payTime,
        };
      } else {
        tngPayCancel(tngOrderId).catch(() => null);
      }
    } catch { /* ignore */ }
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
  // TNG path: use the W4G PayTime (epoch seconds) instead of txnDt.
  const paymentTimestamp = (() => {
    if (result?.via === 'tng' && result.tngPayTime) {
      return new Date(result.tngPayTime * 1000).toISOString();
    }
    const txnDtRaw = push?.body?.txnDt ? String(push.body.txnDt) : '';
    if (!txnDtRaw) return null;
    const t = Date.parse(txnDtRaw.replace(' ', 'T'));
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  })();

  recordExit(inflight.sessionId, {
    exitAt: event.exitAtOverride ?? new Date().toISOString(),
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
      const title = result.via === 'tng' ? 'Paid · TNG' : 'Paid · TQ';
      term.showStatus({
        titleTXT: title,
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
 * Time-aware fee calculator.
 *
 * When the policy carries a non-empty `rules[]` array (the new schedule
 * format from qparking SaaS), we segment the billable interval at every
 * boundary where a different rule takes effect (day-of-week change,
 * time window crossing) and bill each segment under its matching rule.
 * That makes weekday-vs-weekend, daytime-vs-night, and 24-hour modes
 * actually work — a car parked at 17:50 on a "RM5/hr daytime" rule and
 * exiting at 18:30 under "RM2/hr overnight" pays 10 min × RM5 + 30 min ×
 * RM2, not the wrong-by-construction 40 × RM5.
 *
 * Falls back to the legacy flat block model when `rules[]` is empty,
 * which is what older qparking-local installs and the legacy SaaS payload
 * shape still rely on.
 */
export function computeFee(
  durationMinutes: number,
  policy: RatePolicy | null,
  entryAt?: string | Date,
  /** Explicit exit instant for simulation/testing. Defaults to now (the real
   *  gate exit). Only affects the schedule-driven path. */
  exitAt?: string | Date,
): number {
  if (!policy) return 0;

  // Pure block model — no schedule available, use legacy math.
  if (!policy.rules || policy.rules.length === 0) {
    const billable = Math.max(0, durationMinutes - policy.freeMinutes);
    if (billable === 0) return 0;
    const blocks = Math.ceil(billable / Math.max(1, policy.blockMinutes));
    let cents = policy.firstBlockCents + Math.max(0, blocks - 1) * policy.perBlockCents;
    if (policy.dailyCapCents > 0 && cents > policy.dailyCapCents) cents = policy.dailyCapCents;
    return cents;
  }

  // Schedule-driven path. This is a 1:1 port of the qparking SaaS
  // App\Services\TariffCalculator so the on-prem gate charges exactly what the
  // cloud simulator / invoice would: grace behaviour, cut-off billing cycles,
  // rate_basis (entry vs occupancy), flat-rate combining modes, and per-rule +
  // policy daily caps. A parity harness lives in app/tools/tariff-parity.
  const exitMs = exitAt ? new Date(exitAt as any).getTime() : Date.now();
  const entryMs = entryAt ? new Date(entryAt as any).getTime() : exitMs - durationMinutes * 60_000;
  if (exitMs <= entryMs) return 0;

  // Grace: within the grace window the whole stay is free. Mirrors the cloud's
  // `duration_minutes <= grace_minutes` check (integer minutes).
  const durMin = diffFloorMinutes(entryMs, exitMs);
  const grace = Math.max(0, policy.freeMinutes || 0);
  if (durMin <= grace) return 0;

  // Billing start: ONLY 'charge_from_grace_end' bills from the grace boundary;
  // every other value (including the cloud default 'charge_from_entry') bills
  // from the entry instant once grace is exceeded.
  const billStartMs = policy.graceExceededBehavior === 'charge_from_grace_end'
    ? entryMs + grace * 60_000
    : entryMs;

  // rate_basis 'entry' — the rule covering the ENTRY moment governs the entire
  // stay (early-bird pricing). Clone it as an all-day rule.
  let rulesForStay = policy.rules;
  if ((policy.rateBasis ?? 'occupancy') === 'entry') {
    const entryRule = pickRuleAtMoment(entryMs, policy.rules, false);
    if (entryRule) {
      rulesForStay = [{
        ...entryRule,
        timeFrom: '00:00:00',
        timeTo: '23:59:59',
        daysOfWeek: null,
        validFrom: null,
        validTo: null,
        isOvernight: false,
      }];
    }
  }

  const cycles = buildBillingCycles(billStartMs, exitMs, policy);
  // first_block_once_per_entry only matters across cut-off cycles.
  const carryBlocks = !!policy.firstBlockOncePerEntry && !!policy.cutoffEnabled;
  const flatMode = ['sum', 'entry', 'highest', 'per_day'].includes(policy.flatMultiRate ?? 'sum')
    ? (policy.flatMultiRate ?? 'sum')
    : 'sum';
  // Policy-level cap = the TRUE policy daily cap (policyDailyCapCents), NOT the
  // legacy `dailyCapCents` mirror (which holds whichever RULE was effective at
  // sync time and would wrongly over-cap block_hourly stays). Per-rule caps are
  // applied separately inside priceBillingCycle. null/0 = uncapped.
  const policyCap = policy.policyDailyCapCents != null && policy.policyDailyCapCents > 0
    ? policy.policyDailyCapCents
    : null;

  let total = 0;
  let blockMinutes = 0;
  for (let idx = 0; idx < cycles.length; idx++) {
    const [cs, ce] = cycles[idx];
    // On every cut-off crossing under 'new_day_fixed_fee', charge the fixed fee
    // for the new day instead of pricing the cycle by time.
    if (idx > 0 && policy.cutoffBehavior === 'new_day_fixed_fee') {
      total += policy.newDayFixedFeeCents ?? 0;
      continue;
    }
    const preferOvernight = idx > 0 && policy.cutoffBehavior === 'overnight_tariff';
    const res = priceBillingCycle(
      cs, ce, rulesForStay, preferOvernight, policyCap,
      carryBlocks ? blockMinutes : 0, flatMode,
    );
    if (carryBlocks) blockMinutes = res.blockMinutesAfter;
    total += res.total;
  }
  return total;
}

// ─── fee-calc internals (1:1 mirror of SaaS App\Services\TariffCalculator) ───
// All date math is LOCAL-time (the site's timezone), matching how the on-prem
// gate perceives entry/exit. Kept intentionally close to the PHP structure so
// the two implementations can be diffed line-for-line.

/** yyyy-MM-dd in LOCAL time (not UTC — matters for day-of-week / validity). */
function ymdLocal(ms: number): string {
  const d = new Date(ms); const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** HH:mm:ss in LOCAL time. */
function hmsLocal(ms: number): string {
  const d = new Date(ms); const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function startOfNextDayMs(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
}
function setTimeOnMs(ms: number, h: number, m: number, s: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, s, 0).getTime();
}
function addOneDayMs(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, d.getHours(), d.getMinutes(), d.getSeconds(), 0).getTime();
}
/** Truncated (floor) whole minutes, matching Carbon's `(int) diffInMinutes`. */
function diffFloorMinutes(aMs: number, bMs: number): number {
  return Math.floor((bMs - aMs) / 60_000);
}
/** '23:59'/'23:59:59' → '24:00:00' (end-of-day sentinel); pad 'HH:mm'. */
function normTime(v: string): string {
  let s = String(v ?? '');
  if (s.length === 5) s += ':00';
  if (s === '23:59:00' || s === '23:59:59') return '24:00:00';
  return s;
}

/** Does `rule` cover the given moment? (validity / day-of-week / time window) */
function ruleMatchesAtMoment(r: TariffRule, atMs: number): boolean {
  if (r.isActive === false) return false;
  const date = ymdLocal(atMs);
  if (r.validFrom && date < r.validFrom) return false;
  if (r.validTo && date > r.validTo) return false;
  if (Array.isArray(r.daysOfWeek) && r.daysOfWeek.length > 0) {
    if (!r.daysOfWeek.includes(new Date(atMs).getDay())) return false;
  }
  const now = hmsLocal(atMs);
  const from = normTime(r.timeFrom);
  const to = normTime(r.timeTo);
  if (from === to) return true;
  if (from < to) return now >= from && now < to;
  return now >= from || now < to; // wraps past midnight
}

/** Highest-priority matching rule at `atMs`; ties broken by overnight. */
function pickRuleAtMoment(
  atMs: number, rules: TariffRule[], preferOvernight: boolean,
): TariffRule | null {
  let matches = rules.filter((r) => ruleMatchesAtMoment(r, atMs));
  if (matches.length === 0) return null;
  if (preferOvernight) {
    const on = matches.filter((r) => r.isOvernight);
    if (on.length > 0) matches = on;
  }
  return matches.slice().sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return (b.isOvernight ? 1 : 0) - (a.isOvernight ? 1 : 0);
  })[0];
}

/** Next moment in (cursor, cycleEnd] where the effective rule could change. */
function nextBoundaryMsV2(cursorMs: number, cycleEndMs: number, rule: TariffRule): number {
  const candidates: number[] = [cycleEndMs];
  const to = normTime(rule.timeTo);
  const from = normTime(rule.timeFrom);
  let ruleEnd: number;
  if (to === '24:00:00') {
    ruleEnd = startOfNextDayMs(cursorMs);
  } else {
    const [h, m, s] = to.split(':').map((n) => Number(n));
    ruleEnd = setTimeOnMs(cursorMs, h || 0, m || 0, s || 0);
  }
  if (from < to) {
    if (ruleEnd <= cursorMs) ruleEnd = addOneDayMs(ruleEnd);
  } else {
    // Wrapping window (e.g. 22:00 → 06:00).
    if (!(hmsLocal(cursorMs) < to)) ruleEnd = addOneDayMs(ruleEnd);
  }
  candidates.push(ruleEnd);
  candidates.push(startOfNextDayMs(cursorMs)); // re-check day-of-week / validity
  let earliest: number | null = null;
  for (const c of candidates) {
    if (c > cursorMs && (earliest === null || c < earliest)) earliest = c;
  }
  return earliest ?? cycleEndMs;
}

/** Cost of a block-hourly segment. `prior` = block-minutes already billed in
 *  the stay (so the first-block premium is charged at most once when carried). */
function priceBlockHourlyCents(minutes: number, rule: TariffRule, prior = 0): number {
  if (minutes <= 0) return 0;
  const firstAmt = rule.firstBlockAmountCents || 0;
  const firstMin = Math.max(1, rule.firstBlockMinutes || 60);
  const subAmt = rule.subsequentBlockAmountCents || 0;
  const subMin = Math.max(1, rule.subsequentBlockMinutes || 60);
  if (prior >= firstMin) return Math.ceil(minutes / subMin) * subAmt;
  if (prior + minutes <= firstMin) return firstAmt;
  const extra = (prior + minutes) - firstMin;
  return firstAmt + Math.ceil(extra / subMin) * subAmt;
}

/** Split [start, end] into billing cycles at each cut-off crossing. */
function buildBillingCycles(startMs: number, endMs: number, policy: RatePolicy): Array<[number, number]> {
  if (!policy.cutoffEnabled) return [[startMs, endMs]];
  const parts = String(policy.cutoffTime ?? '00:00:00').split(':');
  const h = Number(parts[0]) || 0, m = Number(parts[1]) || 0, s = Number(parts[2]) || 0;
  const cycles: Array<[number, number]> = [];
  let segStart = startMs;
  let next = setTimeOnMs(segStart, h, m, s);
  if (next <= segStart) next = addOneDayMs(next);
  let guard = 0;
  while (next < endMs && guard++ < 3660) {
    cycles.push([segStart, next]);
    segStart = next;
    next = addOneDayMs(next);
  }
  cycles.push([segStart, endMs]);
  return cycles;
}

/** Price one billing cycle, walking rule boundaries within it. */
function priceBillingCycle(
  cycleStartMs: number, cycleEndMs: number,
  rules: TariffRule[], preferOvernight: boolean,
  policyCapCents: number | null, priorBlockMinutes: number, flatMode: string,
): { total: number; blockMinutesAfter: number } {
  const segs: Array<{ ruleId: string; isFlat: boolean; amount: number }> = [];
  const flatSegIdx: number[] = [];
  const ruleCaps: Record<string, number> = {}; // block_hourly rule id → cap (>0)
  let blockMinutes = priorBlockMinutes;
  let hasHourly = false;
  let cursor = cycleStartMs;
  let guard = 0;
  while (cursor < cycleEndMs && guard++ < 100_000) {
    const rule = pickRuleAtMoment(cursor, rules, preferOvernight);
    if (!rule) {
      // The cloud THROWS on an uncovered moment (misconfiguration). The gate
      // must never crash mid-exit, so we skip the uncovered span as free time.
      cursor = Math.min(startOfNextDayMs(cursor), cycleEndMs);
      continue;
    }
    const boundary = nextBoundaryMsV2(cursor, cycleEndMs, rule);
    const segMinutes = diffFloorMinutes(cursor, boundary);
    const isFlat = rule.ruleType === 'flat_rate';
    let amount: number;
    if (isFlat) {
      amount = rule.flatAmountCents || 0;
    } else {
      amount = priceBlockHourlyCents(segMinutes, rule, blockMinutes);
      blockMinutes += segMinutes;
      hasHourly = true;
      if ((rule.dailyCapCents || 0) > 0) ruleCaps[rule.ruleId] = rule.dailyCapCents;
    }
    segs.push({ ruleId: rule.ruleId, isFlat, amount });
    if (isFlat) flatSegIdx.push(segs.length - 1);
    cursor = boundary;
  }

  // Combine flat charges across segments per flat_multi_rate.
  if (flatSegIdx.length > 0) {
    if (flatMode === 'per_day') {
      // keep every day-segment's flat charge
    } else if (flatMode === 'entry') {
      const keep = flatSegIdx[0];
      for (const si of flatSegIdx) if (si !== keep) segs[si].amount = 0;
    } else if (flatMode === 'highest') {
      let keep = flatSegIdx[0];
      for (const si of flatSegIdx) if (segs[si].amount > segs[keep].amount) keep = si;
      for (const si of flatSegIdx) if (si !== keep) segs[si].amount = 0;
    } else { // 'sum' — each distinct flat rule once
      const seen = new Set<string>();
      for (const si of flatSegIdx) {
        if (seen.has(segs[si].ruleId)) segs[si].amount = 0;
        else seen.add(segs[si].ruleId);
      }
    }
  }

  let total = segs.reduce((a, sg) => a + sg.amount, 0);

  // Caps apply to time-billed cycles only: min of every applied per-rule cap
  // and the policy cap.
  const caps: number[] = Object.values(ruleCaps);
  if (policyCapCents !== null) caps.push(policyCapCents);
  if (hasHourly && caps.length > 0) {
    const cap = Math.min(...caps);
    if (total > cap) total = cap;
  }

  return { total, blockMinutesAfter: blockMinutes };
}

/** Used by the UI fee-preview panel — shows what the calculated charge WOULD be
 *  if a given plate were to exit right now. */
export function previewFee(plate: string): { found: boolean; sessionId?: number; durationMinutes?: number; feeCents?: number; policy?: RatePolicy | null } {
  const session = findOpenSessionByPlate(plate);
  if (!session) return { found: false };
  const lane = listLanes().find((l) => l.id === session.entryLaneId);
  const policy = (lane?.policyId ? getRatePolicy(lane.policyId) : null) ?? getSiteDefaultRatePolicy();
  const durationMinutes = Math.max(0, Math.ceil((Date.now() - Date.parse(session.entryAt)) / 60_000));
  const feeCents = computeFee(durationMinutes, policy, session.entryAt);
  return { found: true, sessionId: session.id, durationMinutes, feeCents, policy };
}

/**
 * "Test price" — compute what a given rate plan (policy) would charge for an
 * explicit entry→exit window, without needing a live session. Mirrors the
 * qparking SaaS "Test a price" simulator so an operator can confirm the gate
 * charge matches the cloud for the same inputs.
 */
export function simulateRatePolicyFee(
  policyId: string,
  entryIso: string,
  exitIso: string,
): { ok: boolean; feeCents?: number; durationMinutes?: number; policyName?: string; currency?: string; error?: string } {
  const policy = getRatePolicy(policyId);
  if (!policy) return { ok: false, error: 'rate_plan_not_found' };
  const entryMs = Date.parse(entryIso);
  const exitMs = Date.parse(exitIso);
  if (Number.isNaN(entryMs) || Number.isNaN(exitMs)) return { ok: false, error: 'invalid_dates' };
  if (exitMs < entryMs) return { ok: false, error: 'exit_before_entry' };
  // Floor to whole minutes — matches the cloud TariffCalculator's integer
  // duration so the two produce identical block math.
  const durationMinutes = Math.max(0, Math.floor((exitMs - entryMs) / 60_000));
  const feeCents = computeFee(durationMinutes, policy, entryIso, exitIso);
  return { ok: true, feeCents, durationMinutes, policyName: policy.policyName, currency: policy.currency };
}

/**
 * Manual retrigger: fire the exit-payment flow for a specific session without
 * needing an LPR event. Used by the Sessions page "Retrigger payment" button
 * when the exit LPR misread the plate (or the operator wants to close a
 * stuck session by asking the driver to tap again).
 *
 * Implementation: synthesize an LPR plate event and re-emit it via the
 * existing `lprEvents` channel, so all the normal orchestration kicks in —
 * fee compute, W4G race, ECPI initCard, replay guards, session record.
 * The direction is forced to 'exit' so it never accidentally becomes an
 * entry retry.
 */
export function retriggerSessionExit(sessionId: number): { ok: boolean; error?: string } {
  const session = getSessionById(sessionId);
  if (!session) return { ok: false, error: 'session_not_found' };
  if (session.exitAt) return { ok: false, error: 'session_already_closed — nothing to retrigger' };

  const laneId = session.exitLaneId ?? session.entryLaneId;
  if (!laneId) return { ok: false, error: 'session_has_no_lane — attach the session to a lane in Edit first' };

  const lane = getLane(laneId);
  if (!lane) return { ok: false, error: 'lane_not_found' };
  if (!lane.terminalId) return { ok: false, error: `lane "${lane.name}" has no payment terminal wired — attach one in Lanes` };

  // Pick any enabled camera on that lane so laneForCamera() can resolve it
  // back to the same lane during the synthesized event dispatch.
  const cam = listCameras().find((c) => c.laneId === laneId && c.enabled);
  if (!cam) return { ok: false, error: `no enabled camera on lane "${lane.name}" — the parking-flow uses the camera to look up the lane` };

  flog(`RETRIGGER: session=${sessionId} plate=${session.plate} lane=${lane.name} terminal=${lane.terminalId} — synthesizing exit LPR event`);
  const event: PlateEvent = {
    cameraId: cam.id,
    plate: session.plate,
    confidence: 1.0,
    imagePath: null,
    timestamp: new Date().toISOString(),
    direction: 'exit',
  };
  lprEvents.emit('plate', event);
  return { ok: true };
}

/**
 * DEV/QA helper — fire a synthetic plate event on a LANE (not a camera) with
 * a forced direction, so a developer can exercise the real parking flow
 * end-to-end from the Sessions page without touching hardware. It resolves an
 * enabled camera on the lane (the flow routes camera → lane), so it genuinely
 * tests the wiring: routing, fee calc, gate, and terminal. Gated behind
 * devMode in the UI; harmless if called otherwise.
 */
export function simulateLaneEvent(
  laneId: number,
  plate: string,
  direction: 'entry' | 'exit',
): { ok: boolean; error?: string; cameraId?: number } {
  const lane = getLane(laneId);
  if (!lane) return { ok: false, error: 'lane_not_found' };
  const norm = normalisePlate(plate);
  if (!norm) return { ok: false, error: 'plate_required' };
  const cam = listCameras().find((c) => c.laneId === laneId && c.enabled);
  if (!cam) return { ok: false, error: `no enabled camera on lane "${lane.name}" — add or enable one on the Cameras page so the flow can route to this lane` };
  const event: PlateEvent = {
    cameraId: cam.id,
    plate: norm,
    confidence: 1.0,
    imagePath: null,
    timestamp: new Date().toISOString(),
    direction,
  };
  flog(`DEV SIMULATE: lane="${lane.name}" plate=${norm} direction=${direction} via camera=${cam.id}`);
  lprEvents.emit('plate', event);
  return { ok: true, cameraId: cam.id };
}

/**
 * DEV/QA helper — record a COMPLETE (already-exited) parking session with
 * explicit entry & exit times, so pricing can be verified over a real duration
 * without waiting or tapping a card. Unlike simulateLaneEvent (which fires the
 * LIVE flow at "now" and drives the terminal), this writes a closed session
 * straight to the local DB with the fee the lane's plan computes for that exact
 * window. It stays LOCAL — no terminal, no gate, no cloud push. Gated behind
 * devMode in the UI.
 */
export async function simulateCompletedSession(
  laneId: number,
  plate: string,
  entryIso: string,
  exitIso: string,
): Promise<{ ok: boolean; error?: string; sessionId?: number; durationMinutes?: number; feeCents?: number; scopeName?: string; currency?: string; paymentStatus?: string }> {
  const lane = getLane(laneId);
  if (!lane) return { ok: false, error: 'lane_not_found' };
  const norm = normalisePlate(plate);
  if (!norm) return { ok: false, error: 'plate_required' };
  const entryMs = Date.parse(entryIso);
  const exitMs = Date.parse(exitIso);
  if (Number.isNaN(entryMs) || Number.isNaN(exitMs)) return { ok: false, error: 'invalid_dates' };
  if (exitMs < entryMs) return { ok: false, error: 'exit_before_entry' };

  // Rate resolves the same way a real exit does: this lane plays the ENTRY role
  // (its plan governs pricing), falling back to the site-default plan.
  const policy = (lane.policyId ? getRatePolicy(lane.policyId) : null) ?? getSiteDefaultRatePolicy();
  const durationMinutes = Math.max(0, Math.ceil((exitMs - entryMs) / 60_000));
  const feeCents = computeFee(durationMinutes, policy, entryIso, exitIso);
  const paymentStatus: ParkingSession['paymentStatus'] = feeCents > 0 ? 'paid' : 'free';

  // Snapshot off the lane camera's live SDK feed (if any) so the record shows a
  // real capture. Reuse the live-flow DB primitives: open a session, backdate
  // its entry, then close it. No terminal, no gate, no cloud push.
  const cam = listCameras().find((c) => c.laneId === laneId && c.enabled);
  const imagePath = cam ? await captureFrameToFile(cam.id, norm) : null;
  const session = createEntrySession(norm, laneId, cam?.id ?? null, imagePath);
  updateSessionFields(session.id, { entryAt: new Date(entryMs).toISOString(), notes: 'Simulated (dev tool)' });
  recordExit(session.id, {
    exitAt: new Date(exitMs).toISOString(),
    exitLaneId: laneId,
    exitCameraId: cam?.id ?? null,
    exitImagePath: imagePath,
    durationMinutes,
    feeCents,
    paymentStatus,
    terminalTxnId: null,
    cardScheme: null,
    paymentTimestamp: paymentStatus === 'paid' ? new Date(exitMs).toISOString() : null,
  });
  flog(`DEV SIMULATE SESSION: lane="${lane.name}" plate=${norm} ${entryIso}→${exitIso} dur=${durationMinutes}min policy=${policy?.policyName ?? 'NONE'} img=${imagePath ? 'yes' : 'none'} → fee=${feeCents}c status=${paymentStatus}`);
  return { ok: true, sessionId: session.id, durationMinutes, feeCents, scopeName: policy?.policyName, currency: policy?.currency, paymentStatus };
}

/**
 * DEV/QA — open a session NOW but stamped with an operator-chosen entry time,
 * so a later timed Exit can price a controlled stay. Creates only the open
 * session (no gate/turnstile side effects) — the point is just to "store" the
 * entry. Gated behind devMode in the UI.
 */
export async function simulateEntryAt(
  laneId: number, plate: string, entryIso: string,
): Promise<{ ok: boolean; error?: string; sessionId?: number }> {
  const lane = getLane(laneId);
  if (!lane) return { ok: false, error: 'lane_not_found' };
  const norm = normalisePlate(plate);
  if (!norm) return { ok: false, error: 'plate_required' };
  const entryMs = Date.parse(entryIso);
  if (Number.isNaN(entryMs)) return { ok: false, error: 'invalid_entry_time' };
  if (findOpenSessionByPlate(norm)) {
    return { ok: false, error: 'already_inside — this plate has an open session; press Exit first' };
  }
  const cam = listCameras().find((c) => c.laneId === laneId && c.enabled);
  // Grab a snapshot off the camera's live SDK feed (if any) so the session has a
  // real capture image, not just a placeholder.
  const imagePath = cam ? await captureFrameToFile(cam.id, norm) : null;
  const session = createEntrySession(norm, laneId, cam?.id ?? null, imagePath);
  updateSessionFields(session.id, { entryAt: new Date(entryMs).toISOString() });
  flog(`DEV SIMULATE ENTRY: lane="${lane.name}" plate=${norm} entryAt=${entryIso} img=${imagePath ? 'yes' : 'none'} session=${session.id}`);
  return { ok: true, sessionId: session.id };
}

/**
 * DEV/QA — fire the REAL exit flow for an open session, but with an
 * operator-chosen exit time (fee window + recorded exit_at). This drives the
 * terminal exactly like a live exit — the only difference is the exit instant.
 * Requires an open session for the plate (press Entry first). Gated behind
 * devMode in the UI.
 */
export async function simulateExitAt(
  laneId: number, plate: string, exitIso: string,
): Promise<{ ok: boolean; error?: string; cameraId?: number }> {
  const lane = getLane(laneId);
  if (!lane) return { ok: false, error: 'lane_not_found' };
  const norm = normalisePlate(plate);
  if (!norm) return { ok: false, error: 'plate_required' };
  const exitMs = Date.parse(exitIso);
  if (Number.isNaN(exitMs)) return { ok: false, error: 'invalid_exit_time' };
  if (!findOpenSessionByPlate(norm)) {
    return { ok: false, error: 'no_open_session — press Entry for this plate first' };
  }
  const cam = listCameras().find((c) => c.laneId === laneId && c.enabled);
  if (!cam) return { ok: false, error: `no enabled camera on lane "${lane.name}" — add or enable one so the flow can route to this lane` };
  // Snapshot the exit off the camera's live SDK feed (if any).
  const imagePath = await captureFrameToFile(cam.id, norm);
  const event: PlateEvent = {
    cameraId: cam.id,
    plate: norm,
    confidence: 1.0,
    imagePath,
    timestamp: exitIso,
    direction: 'exit',
    exitAtOverride: new Date(exitMs).toISOString(),
  };
  flog(`DEV SIMULATE EXIT: lane="${lane.name}" plate=${norm} exitAt=${exitIso} img=${imagePath ? 'yes' : 'none'} via camera=${cam.id}`);
  lprEvents.emit('plate', event);
  return { ok: true, cameraId: cam.id };
}
