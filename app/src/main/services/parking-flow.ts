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
import type { ParkingLane, ParkingSession, PaymentTerminal, RatePolicy, SeasonPass, TariffRule } from '../../shared/types';
import {
  createEntrySession, findOpenSessionByPlate, getCamera, getLane, getRatePolicy, getSiteDefaultRatePolicy, getSettings, getTerminal,
  listLanes, listCameras, recordExit, updateSessionFields, findSeasonPassByPlate, getSessionById,
  createTransaction, updateTransaction, findBlockedPlate, findLastClosedSessionByPlate,
  attachSessionCapture,
} from './db';
import { lprEvents, normalisePlate, type PlateEvent, type PlateCapture } from './lpr-webhook';
import { payRequest as tngPayRequest, payCancel as tngPayCancel, payTypeToCardScheme, newOrderId as newTngOrderId, w4gLog, payResultListenerReady, type PayResultBody } from './payment-tng';
import { enqueueEntry, enqueueExit, enqueueTransaction } from './cloud-queue';

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

export const parkingEvents = new EventEmitter();

interface ActiveExit {
  sessionId: number;
  plate: string;
  laneId: number;
  feeCents: number;
  durationMinutes: number;
  startedAt: number;
  // Set once the PayRequest is fired, so a manual release can cancel the
  // in-flight charge at the device (abort the deduction + reject the awaiting
  // PayRequest). Absent until startTngExitCharge reaches the device call.
  orderId?: string;
  deviceHost?: string;
  devicePort?: number;
}
const exitsInFlight = new Map<number, ActiveExit>(); // keyed by laneId — one exit txn per lane

// ─── auto-retrigger ─────────────────────────────────────────────────────────
// When a paid exit charge fails / times out / is declined, optionally re-fire
// the PayRequest at the same terminal after a short delay so the driver can tap
// again without staff intervention. Gated by settings.tngAutoRetrigger (default
// on). See maybeAutoRetrigger().
const AUTO_RETRIGGER_DELAY_MS = 2_000;
// Safety cap: an abandoned car at the gate must NOT re-arm the lane forever —
// each cycle also holds the lane's busy-guard, blocking every other exit. After
// this many auto attempts we stop and wait for a manual release/retrigger.
const MAX_AUTO_RETRIGGERS = 3;
// attempts counted per sessionId; cleared on success / exit / cap reached.
const autoRetriggerCounts = new Map<number, number>();
// Scheduled re-arm timers, keyed by sessionId, so a manual release can cancel a
// pending retrigger outright instead of letting it wake up and abort itself.
const autoRetriggerTimers = new Map<number, NodeJS.Timeout>();

/**
 * Can this session still be charged? Only while the car is genuinely still
 * inside: journey status 'entered', no exit recorded, and no settled payment.
 *
 * Testing `status === 'exited' || paymentStatus === 'paid'` — as the retrigger
 * guards used to — MISSED a manual release, which lands as status AND
 * payment_status 'manual_release'. A scheduled retrigger sailed past both tests
 * and re-armed the terminal for a car the operator had already let out; if the
 * next driver tapped, they paid the previous car's fare and recordExit()
 * overwrote the release with 'exited'/'paid'.
 */
function isStillChargeable(session: ParkingSession | null): boolean {
  return !!session
    && session.status === 'entered'
    && !session.exitAt
    && session.paymentStatus !== 'paid';
}

/** Why a session isn't chargeable, for the abort log line. */
function describeChargeability(session: ParkingSession | null): string {
  if (!session) return 'gone';
  return `status=${session.status} payment=${session.paymentStatus}${session.exitAt ? ' exitAt=set' : ''}`;
}

export function startParkingFlow() {
  lprEvents.on('plate', handlePlateEvent);
  lprEvents.on('plate-capture', handlePlateCapture);
}

// ─── Late-arriving plate captures ────────────────────────────────────────────
//
// On the vendor ANPR the JPEG rides a SECOND post, ~1s behind the plate-only
// one that actually drives the flow (see classifyPost in lpr-webhook). Where
// that picture belongs depends on what the first post did:
//
//   entry — the session row already exists, so attach straight to the DB.
//   exit  — the charge is still in flight and exit_at is NULL, so there is no
//           column to write yet. Park the path here and let recordExit pick it
//           up when the exit finally closes.
//
// Keyed by camera+plate and swept on read, so a capture whose exit never
// completed can't later graft itself onto a different stay.
const PENDING_CAPTURE_TTL_MS = 15 * 60_000;
const pendingCaptures = new Map<string, { imagePath: string; at: number }>();

function captureKey(cameraId: number, plate: string): string {
  return `${cameraId}|${plate}`;
}

/** Claim a parked capture for this (camera, plate), if one is still fresh. */
function takePendingCapture(cameraId: number | null, plate: string): string | null {
  const now = Date.now();
  for (const [k, v] of pendingCaptures) {
    if (now - v.at > PENDING_CAPTURE_TTL_MS) pendingCaptures.delete(k);
  }
  if (cameraId == null) return null;
  const key = captureKey(cameraId, plate);
  const hit = pendingCaptures.get(key);
  if (!hit) return null;
  pendingCaptures.delete(key);
  return hit.imagePath;
}

function handlePlateCapture(capture: PlateCapture) {
  // An OPEN session for this plate means an exit is mid-charge (or this is an
  // entry camera re-posting): in both cases the exit column isn't writable yet,
  // so park it rather than risk attaching to the previous stay.
  if (capture.direction === 'exit' && findOpenSessionByPlate(capture.plate)) {
    pendingCaptures.set(captureKey(capture.cameraId, capture.plate), { imagePath: capture.imagePath, at: Date.now() });
    flog(`CAPTURE PARKED: plate=${capture.plate} side=exit — exit still in flight, will attach when the charge closes`);
    return;
  }

  const session = attachSessionCapture(capture.plate, capture.direction, capture.imagePath);
  if (!session) {
    pendingCaptures.set(captureKey(capture.cameraId, capture.plate), { imagePath: capture.imagePath, at: Date.now() });
    flog(`CAPTURE PARKED: plate=${capture.plate} side=${capture.direction} — no session to attach to yet`);
    return;
  }

  // attachSessionCapture bumped rev, so this queues a genuinely new push rather
  // than collapsing into the imageless one already sent for this session. Both
  // shapes carry the base64 bytes, so the photo reaches DigitalOcean Spaces on
  // the normal sync path — no separate upload channel.
  if (capture.direction === 'entry') enqueueEntry(session);
  else enqueueExit(session);
  // Nudges the Sessions page to refetch so the thumbnail appears without a
  // manual refresh. The page's action timeline ignores kinds it doesn't know,
  // so this adds no noise there.
  parkingEvents.emit('capture-attached', { sessionId: session.id, plate: capture.plate, side: capture.direction });
  flog(`CAPTURE ATTACHED: plate=${capture.plate} side=${capture.direction} session=${session.id} → cloud`);
}

function handlePlateEvent(event: PlateEvent) {
  flog(`plate event: plate=${event.plate} camDirection=${event.direction} cameraId=${event.cameraId}${event.entryAtOverride ? ` entryAtOverride=${event.entryAtOverride}` : ''}${event.exitAtOverride ? ` exitAtOverride=${event.exitAtOverride}` : ''}`);
  // Routing is decided by camera direction ALONE: an entry camera does entries,
  // an exit camera does exits. There is no global override and no third value.
  //
  // Two things used to complicate this and both were retired 2026-08-05 — the
  // camera direction 'dual', and the `entryCameraHandlesExit` setting. They
  // implemented the identical rule ("open session → exit, else entry") for a
  // shared barrier covered by ONE camera, a configuration that doesn't occur in
  // practice and couldn't work properly regardless: a departing car only enters
  // the camera's frame after it has passed the barrier, so that second read could
  // record an exit but never authorise one. A shared barrier now takes two
  // cameras, one facing each way.
  const direction: 'entry' | 'exit' = event.direction === 'exit' ? 'exit' : 'entry';

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
    // car generate parallel "open" rows and confuse the fee/exit logic.
    //
    // ANPR cameras report the same plate two or three times per pass, so this is
    // the single most common thing the flow does after an entry — and it used to
    // log NOTHING, which made a normal duplicate look identical to a dropped
    // read. Both go in the live log now.
    const insideForMin = Math.max(0, Math.round((Date.now() - Date.parse(existing.entryAt)) / 60_000));
    flog(`DUPLICATED DETECT: plate=${event.plate} is already inside (session=${existing.id}, entered ${existing.entryAt}, ${insideForMin}min ago) → no new session, barrier NOT pulsed. Use the exit lane to close it.`);
    parkingEvents.emit('rescan-ignored', {
      plate: event.plate,
      sessionId: existing.id,
      entryAt: existing.entryAt,
    });
    return;
  }

  // ─── Exit re-scan grace ──────────────────────────────────────────────
  // ANPR cameras routinely report the same plate two or three times per pass. At a
  // shared barrier the exit camera closes the session on its first read, and the
  // entry camera can then see the SAME departing car — without this guard the next
  // a second later opens a BRAND-NEW entry: a phantom "car inside" for a car that
  // has just driven out, which then blocks its real next visit with ALREADY
  // INSIDE and inflates occupancy.
  //
  // This is what settings.exitGracePeriodSeconds (default 90) was always meant to
  // govern; it existed but was wired to nothing. 0 disables the guard. A window
  // this long is safe because re-entering within it is physically implausible at a
  // barrier — and it's operator-tunable for sites where it isn't.
  const graceSeconds = getSettings().exitGracePeriodSeconds ?? 0;
  if (graceSeconds > 0) {
    const lastClosed = findLastClosedSessionByPlate(event.plate);
    const exitedAtMs = lastClosed?.exitAt ? Date.parse(lastClosed.exitAt) : NaN;
    const sinceExitMs = Number.isNaN(exitedAtMs) ? null : Date.now() - exitedAtMs;
    // Guard against a future-dated exit (simulator / hand-edited session) reading
    // as a huge negative age and silently swallowing every entry.
    if (sinceExitMs !== null && sinceExitMs >= 0 && sinceExitMs < graceSeconds * 1000) {
      flog(`DUPLICATED DETECT: plate=${event.plate} exited ${Math.round(sinceExitMs / 1000)}s ago (session=${lastClosed!.id}), within exitGracePeriodSeconds=${graceSeconds} → treating as a duplicate camera read of the departing car, no new session, barrier NOT pulsed`);
      parkingEvents.emit('entry-ignored-recent-exit', {
        plate: event.plate,
        sessionId: lastClosed!.id,
        exitAt: lastClosed!.exitAt,
        secondsSinceExit: Math.round(sinceExitMs / 1000),
        graceSeconds,
      });
      return;
    }
  }

  // ─── Blacklist at entry ──────────────────────────────────────────────
  // A banned plate opens NOTHING: no session row, no cloud mirror, no WELCOME,
  // no turnstile. Checked before createEntrySession so the refusal leaves no
  // trace to clean up — "blocked" reading as "Entry stored" in the table was
  // exactly the wrong signal.
  //
  // The car may still roll in past a camera-driven barrier this app can't veto,
  // so the safety net is at the other end: handleExit checks the deny list
  // BEFORE it requires an open session, meaning a banned plate is identified as
  // BLOCKED at the exit whether or not an entry was ever recorded.
  const blockedOnEntry = findBlockedPlate(event.plate);
  if (blockedOnEntry) {
    flog(`ENTRY REFUSED (BLACKLISTED): plate=${event.plate} lane=${lane?.id ?? 'none'} reason=${blockedOnEntry.reason ?? 'none given'} → no session created, barrier NOT pulsed. Staff must open it by hand if this car is to come in.`);
    parkingEvents.emit('warning', {
      kind: 'entry-blacklisted',
      plate: event.plate,
      sessionId: null,
      reason: blockedOnEntry.reason ?? null,
      vehicleId: blockedOnEntry.vehicleId,
    });
    return;
  }

  // ─── Only Pass Allow (ENTRY ONLY) ────────────────────────────────────
  // On a camera set to 'pass_only', a plate with no currently-valid season pass
  // gets in NO further than the barrier. With the toggle off, everyone is
  // admitted. Placed here deliberately: AFTER the blacklist (a banned plate must
  // be reported as banned, not merely unregistered) and BEFORE
  // createEntrySession, so a refusal leaves nothing to clean up.
  //
  // This question is asked at ENTRY only. The exit side never consults
  // accessMode — see handleExit.
  //
  // Validity is read from the locally cached roster (no cloud round-trip), so
  // this keeps working through a WAN outage. The flip side, by design: a pass
  // issued in the cloud does NOT reach this box until someone presses "Sync
  // now" — see cloud-sync.ts. On a deny-by-default gate that means a brand-new
  // resident is refused until the operator syncs.
  const camera = getCamera(event.cameraId);
  if (camera?.accessMode === 'pass_only') {
    // No window argument = "valid at this instant" (see findSeasonPassByPlate).
    const pass = findSeasonPassByPlate(event.plate);
    if (!pass) {
      flog(`ENTRY REFUSED (NO PASS): plate=${event.plate} camera="${camera.name}" is set to Only Pass Allow and this plate holds no pass valid right now → no session created, barrier NOT pulsed. Issue a pass in the cloud and press Sync now, or turn the toggle off.`);
      parkingEvents.emit('warning', {
        kind: 'entry-not-authorised',
        plate: event.plate,
        cameraId: camera.id,
        cameraName: camera.name,
      });
      return;
    }
    flog(`PASS OK: plate=${event.plate} holds a valid ${pass.passType} pass (id=${pass.passId}, valid ${pass.startDate ?? '—'}→${pass.endDate ?? 'forever'}) on Only Pass Allow camera "${camera.name}" → admitted`);
  }

  const session = createEntrySession(
    event.plate,
    lane?.id ?? null,
    event.cameraId,
    // Normally the read's own picture. Falls back to a capture that arrived
    // ahead of this write — on the vendor cameras the two halves of one read
    // race, and either can land first.
    event.imagePath ?? takePendingCapture(event.cameraId, event.plate),
  );

  // DEV/QA timed entry — back-date the stored entry_at so a later exit prices a
  // controlled stay. Real camera events never set this.
  const stored = event.entryAtOverride
    ? (updateSessionFields(session.id, { entryAt: event.entryAtOverride }) ?? session)
    : session;

  flog(`ENTRY STORED: plate=${event.plate} session=${stored.id} lane=${lane?.id ?? 'none'} entryAt=${stored.entryAt} → opening barrier`);
  // Reaching this line means the entry was AUTHORISED, so the barrier opens.
  // index.ts pulses the relay on this event; there is no second opinion to ask.
  parkingEvents.emit('entry', { session: stored, event });
}

async function handleExit(event: PlateEvent, lane: ParkingLane | null) {
  const session = findOpenSessionByPlate(event.plate);

  // Opening line for the exit, mirroring ENTRY STORED on the way in. Every exit
  // outcome below logs its own result, but this fires FIRST and unconditionally
  // so "the exit camera read this plate and we matched it to session N" is
  // visible even when a later guard ends the flow quietly.
  flog(`EXIT DETECTED: plate=${event.plate} lane=${lane?.id ?? 'none'} `
    + (session
      ? `→ matched open session=${session.id} (entered ${session.entryAt})`
      : `→ NO open session for this plate (either it never entered, or the entry was recorded under a different reading of the plate)`));

  // ─── Blacklist: refuse the exit outright ─────────────────────────────
  // Deliberately does NOTHING except warn: no charge, no gate pulse, and any
  // open session stays OPEN (status 'entered'). Recording an exit here would be
  // a lie — the car hasn't left — and would also free the plate to open a fresh
  // entry session. Leaving it stuck at the barrier is the point: the operator
  // goes and speaks to the owner, then either lifts the ban in the cloud or
  // manually releases the car.
  //
  // FIRST guard on purpose, ahead of both the no-session and no-lane checks:
  //   - entry no longer creates a session for a banned plate, so one that rolled
  //     in past a camera-driven barrier has NO open session. Checking after the
  //     no-session guard would report a vague 'exit-without-entry' instead of
  //     naming the real reason.
  //   - it must also precede the pass shortcut, or a banned vehicle still
  //     holding a valid pass would be waved straight out.
  const blockedOnExit = findBlockedPlate(event.plate);
  if (blockedOnExit) {
    flog(`EXIT REFUSED (BLACKLISTED): plate=${event.plate} session=${session?.id ?? 'none'} reason=${blockedOnExit.reason ?? 'none given'} → nothing charged, barrier NOT pulsed${session ? ', session stays OPEN' : ', no entry on record'}. Staff must release this car by hand.`);
    parkingEvents.emit('warning', {
      kind: 'exit-blacklisted',
      plate: event.plate,
      sessionId: session?.id ?? null,
      reason: blockedOnExit.reason ?? null,
      vehicleId: blockedOnExit.vehicleId,
    });
    return;
  }

  // ─── Valid pass → free exit ──────────────────────────────────────────
  // Asked on EVERY exit, whatever the camera's Only Pass Allow setting says.
  // That toggle governs who may come IN; on the way out the only question is
  // "has this vehicle already paid for its stay?", and a season pass means yes.
  //
  // Checked at THIS instant, not against the stay window: a pass valid now is
  // what lets the car out now. (A pass that covered the entry but lapsed
  // mid-stay is billed for the uncovered tail — see PASS PARTIAL below.)
  //
  // Sits ahead of the no-session guard on purpose. A pass holder whose entry was
  // never recorded (misread, entry camera down, let in manually) must still get
  // out; requiring an open session would strand them.
  const exitIsoNow = event.exitAtOverride ?? new Date().toISOString();
  // Scoped to the EXIT instant (not bare "now") so a simulated exit at a chosen
  // time asks the same question a real exit at that time would.
  const passNow = findSeasonPassByPlate(event.plate, { entryAt: exitIsoNow, exitAt: exitIsoNow });
  if (passNow) {
    flog(`EXIT FREE (PASS): plate=${event.plate} holds a valid ${passNow.passType} pass (id=${passNow.passId}, valid ${passNow.startDate ?? '—'}→${passNow.endDate ?? 'forever'}) → no fee, no terminal → opening barrier`);

    if (!session) {
      // Pass holder with no entry on record. Let them out — we know who they
      // are — but say so loudly: a run of these means the entry camera is
      // missing reads, which is worth chasing.
      flog(`…and there is NO open session for it — opening the barrier anyway (entry was never recorded; check the entry camera). No exit row to write.`);
      parkingEvents.emit('warning', {
        kind: 'exit-pass-holder-no-entry',
        plate: event.plate,
        cameraId: event.cameraId,
        passId: passNow.passId,
      });
      parkingEvents.emit('exit-completed', {
        sessionId: null,
        outcome: 'free',
        reason: `pass-${passNow.passType}`,
        passId: passNow.passId,
        plate: event.plate,
        cameraId: event.cameraId,
      });
      return;
    }

    recordExit(session.id, {
      exitAt: exitIsoNow,
      exitLaneId: lane?.id ?? null,
      exitCameraId: event.cameraId,
      exitImagePath: event.imagePath ?? takePendingCapture(event.cameraId, event.plate),
      durationMinutes: stayDurationMinutes(session.entryAt, exitIsoNow),
      feeCents: 0,
      paymentStatus: 'free',
      terminalTxnId: null,
      cardScheme: null,
      paymentTimestamp: null,
      passId: passNow.passId,
      freeReason: `pass-${passNow.passType}`,
    });
    parkingEvents.emit('exit-completed', {
      sessionId: session.id,
      outcome: 'free',
      reason: `pass-${passNow.passType}`,
      passId: passNow.passId,
      cameraId: event.cameraId,
    });
    return;
  }

  if (!session) {
    // Driver exiting without a recorded entry. Could be an LPR misread, OR
    // the entry camera was down. Surface to operator for manual handling.
    // Naming the misread possibility explicitly: a one-character difference
    // between the entry and exit reading (W8838 vs W8838T) lands here, and it
    // looks nothing like a plate problem unless the log says so.
    flog(`EXIT REFUSED: plate=${event.plate} has no open session — nothing to price or close, barrier NOT pulsed. Either the entry read was missed, or the entry was stored under a slightly different reading of this plate. Check the Sessions list for a similar plate still inside.`);
    parkingEvents.emit('warning', {
      kind: 'exit-without-entry', plate: event.plate, cameraId: event.cameraId,
    });
    return;
  }

  if (!lane) {
    flog(`EXIT REFUSED: plate=${event.plate} session=${session.id} — the exit camera is not assigned to any lane, so there is no rate plan or terminal to work with. Assign it on the Lanes page. Session stays OPEN, barrier NOT pulsed.`);
    parkingEvents.emit('warning', { kind: 'exit-no-lane', plate: event.plate, sessionId: session.id });
    return;
  }

  // Rate is governed by where the car ENTERED (then this exit lane, then the
  // site-default plan) — NOT by which exit gate it uses. This keeps the charge
  // deterministic no matter which exit lane the driver picks. The exit is still
  // RECORDED against this lane below.
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
  const durationMinutes = stayDurationMinutes(entryMs, exitMs);
  let feeCents = computeFee(durationMinutes, policy, session.entryAt, exitIso);

  // ─── PASS PARTIAL: covered entry, lapsed before exit ─────────────────
  // A pass valid at the EXIT instant already took the free-exit path above, so
  // reaching here means no pass covers this car right now. It may still have
  // held one at ENTRY and lost it mid-stay — ask for that window specifically.
  const seasonPass = findSeasonPassByPlate(event.plate, {
    entryAt: session.entryAt,
    exitAt: session.entryAt,
  });
  if (seasonPass?.endDate) {
    // The pass paid for the stay up to the end of its last valid day; the tail
    // is a normal transient stay. Re-price ONLY the uncovered window — from
    // site-local midnight after end_date (clamped to the entry, belt-and-
    // braces) to the exit — under the same policy chain. Grace minutes and
    // caps apply to that window exactly as if the car had driven in at the
    // boundary. durationMinutes keeps the TRUE stay length for the audit row;
    // only the fee window shrinks. From here the exit proceeds like any
    // transient one (terminal tap, or free if the window prices to 0).
    // The `endDate` guard above is what makes this safe: an open-ended pass
    // ('' / NULL end_date) never expires, so it always took the free path.
    const billStartMs = Math.max(entryMs, startOfDayAfterKeyMs(seasonPass.endDate));
    const billedMinutes = stayDurationMinutes(billStartMs, exitMs);
    feeCents = computeFee(billedMinutes, policy, new Date(billStartMs).toISOString(), exitIso);
    flog(`PASS PARTIAL: plate=${event.plate} pass=${seasonPass.passType} id=${seasonPass.passId} lapsed ${seasonPass.endDate} mid-stay → billing ${billedMinutes}min of ${durationMinutes}min (from ${new Date(billStartMs).toISOString()}) as transient`);
  }

  // Diagnostic — without this, a 0-fee exit looks identical to "terminal
  // didn't fire", which is exactly the support ticket we keep getting.
  flog(`FEE MATH: plate=${event.plate} no valid pass → priced as a transient · stay=${durationMinutes}min · plan="${policy?.policyName ?? 'NONE ATTACHED'}" (grace=${policy?.freeMinutes ?? '-'}min, firstBlock=${policy?.firstBlockCents ?? '-'}c, perBlock=${policy?.perBlockCents ?? '-'}c) → fee=RM ${(feeCents / 100).toFixed(2)}`);

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
    flog(`EXIT FREE: plate=${event.plate} session=${session.id} ${durationMinutes}min, fee=RM 0.00 — no terminal involved → opening barrier. Reason: ${!policy ? 'this lane has NO rate plan attached, so nothing can be charged — attach one on the Lanes page if this should have cost money' : durationMinutes < (policy.freeMinutes ?? 0) ? `within the free grace window (${durationMinutes}min < ${policy.freeMinutes}min on "${policy.policyName}")` : `the rate plan "${policy.policyName}" prices this stay at RM 0 — check the Parking Policies page if that is wrong`}`);
    const zeroFeeReason = !policy
      ? 'no-policy'
      : (durationMinutes < (policy.freeMinutes ?? 0) ? 'within-grace' : 'rate-zero');
    recordExit(session.id, {
      exitAt: new Date(exitMs).toISOString(),
      exitLaneId: lane.id,
      exitCameraId: event.cameraId,
      exitImagePath: event.imagePath ?? takePendingCapture(event.cameraId, event.plate),
      durationMinutes,
      feeCents: 0,
      paymentStatus: 'free',
      terminalTxnId: null,
      cardScheme: null,
      paymentTimestamp: null,
      // No pass involved — this exit was free because of the rate plan.
      passId: null,
      freeReason: zeroFeeReason,
    });
    parkingEvents.emit('exit-completed', {
      sessionId: session.id,
      outcome: 'free',
      reason: zeroFeeReason,
      cameraId: event.cameraId,
    });
    return;
  }

  // Paid exit — charge the Alarmtech W4G device wired to this lane. The
  // busy-guard prevents a double-charge if a second scan lands mid-transaction.
  if (exitsInFlight.has(lane.id)) {
    const busy = exitsInFlight.get(lane.id)!;
    flog(`EXIT BUSY: plate=${event.plate} ignored — lane ${lane.id} is already charging ${busy.plate} (session=${busy.sessionId}, RM ${(busy.feeCents / 100).toFixed(2)}). This read is a duplicate or the next car; nothing charged twice.`);
    parkingEvents.emit('warning', { kind: 'exit-busy', laneId: lane.id });
    return;
  }

  const markInFlight = () => exitsInFlight.set(lane.id, {
    sessionId: session.id, plate: event.plate, laneId: lane.id,
    feeCents, durationMinutes, startedAt: Date.now(),
  });
  // Fire-and-forget — the charge helpers are async but handlePlateEvent is
  // sync. Catch rejections so a buggy promise never crashes the main process.
  const onChargeCrash = (e: any) => {
    flog(`EXIT CHARGE CRASHED: plate=${event.plate} session=${session.id} — ${e?.message ?? String(e)}. Session stays OPEN, barrier NOT pulsed. Check at the device whether the driver was actually deducted before retriggering.`);
    parkingEvents.emit('warning', {
      kind: 'exit-charge-crashed',
      sessionId: session.id, message: e?.message ?? String(e),
    });
    exitsInFlight.delete(lane.id);
  };

  // Resolve the Alarmtech W4G payment device wired to this lane.
  const device = lane.terminalId ? getTerminal(lane.terminalId) : null;
  if (!device) {
    flog(`EXIT REFUSED: plate=${event.plate} session=${session.id} owes RM ${(feeCents / 100).toFixed(2)} but lane "${lane.name}" has NO payment terminal wired to it — nothing can take the money. Attach one on the Lanes page. Session stays OPEN, barrier NOT pulsed.`);
    parkingEvents.emit('warning', { kind: 'exit-no-terminal', laneId: lane.id });
    return;
  }
  if (!device.enabled) {
    flog(`EXIT REFUSED: plate=${event.plate} session=${session.id} owes RM ${(feeCents / 100).toFixed(2)} but terminal "${device.name}" is switched OFF. Re-enable it on the Terminals page. Session stays OPEN, barrier NOT pulsed.`);
    parkingEvents.emit('warning', { kind: 'exit-terminal-disabled', terminalId: device.id });
    return;
  }
  // The device takes the money the moment the driver taps, but the charge only
  // becomes a recorded transaction when its PayResult callback reaches us. With
  // no listener bound, a tap is a real deduction we can never record — and the
  // resulting "timeout" would then auto-retrigger, asking for the same fare up
  // to MAX_AUTO_RETRIGGERS more times. Refuse BEFORE any money can move: the car
  // waits at the barrier for a manual release, exactly like a declined card.
  const listener = payResultListenerReady();
  if (!listener.ok) {
    flog(`EXIT REFUSED: plate=${event.plate} session=${session.id} owes RM ${(feeCents / 100).toFixed(2)} — ${listener.reason}. No PayRequest sent, because a tap would deduct money this app could never record. Session stays OPEN, barrier NOT pulsed.`);
    w4gLog('error', `EXIT CHARGE refused before send · plate=${event.plate} session=${session.id} lane=${lane.id} device="${device.name}" fare=RM ${(feeCents / 100).toFixed(2)} — ${listener.reason}. Gate stays CLOSED; no money was taken.`, { plate: event.plate, sessionId: session.id, laneId: lane.id, feeCents, reason: listener.reason });
    parkingEvents.emit('warning', {
      kind: 'exit-tng-not-configured',
      sessionId: session.id,
      laneId: lane.id,
      reason: listener.reason ?? null,
    });
    return;
  }
  flog(`EXIT AWAITING PAYMENT: plate=${event.plate} session=${session.id} owes RM ${(feeCents / 100).toFixed(2)} for ${durationMinutes}min → firing PayRequest at "${device.name}" (${device.host}:${device.port}). Barrier opens only when the payment is approved.`);
  markInFlight();
  startTngExitCharge(lane, device, session.plate, feeCents, session.entryAt, event).catch(onChargeCrash);
}


/**
 * Exit payment via the lane's Alarmtech W4G device. Fires a single PayRequest
 * at that device (host:port) and settles the session from its PayResult. The
 * gate opens via the existing 'exit-completed' listener on a 'paid' outcome —
 * a declined/timed-out charge leaves the barrier closed for operator retrigger.
 */
async function startTngExitCharge(
  lane: ParkingLane,
  device: PaymentTerminal,
  plate: string,
  feeCents: number,
  entryAt: string,
  event: PlateEvent,
) {
  const orderId = newTngOrderId();
  const inflight = exitsInFlight.get(lane.id);
  if (!inflight) return;
  // Record how to reach this charge so a manual release can cancel it in-flight.
  inflight.orderId = orderId;
  inflight.deviceHost = device.host;
  inflight.devicePort = device.port;

  // Open a payment attempt in the ledger BEFORE driving the device, so a crash
  // mid-charge still leaves a record of the attempt. It resolves to paid/failed
  // below; the session's journey status is only advanced to 'exited' on success.
  const txn = createTransaction({
    sessionId: inflight.sessionId,
    status: 'pending',
    amountCents: feeCents,
    orderId,
    terminalId: device.id,
    terminalName: device.name,
  });
  const attemptNo = (autoRetriggerCounts.get(inflight.sessionId) ?? 0) + 1;
  flog(`W4G exit: PayRequest → ${device.name} @ ${device.host}:${device.port} orderId=${orderId} plate=${plate} fare=${feeCents}c txn=${txn.id}`);
  // Correlation line into the W4G live log so every later device frame (which
  // only carries orderId) can be traced back to this plate / session / lane.
  w4gLog('info', `EXIT CHARGE start · attempt ${attemptNo}/${MAX_AUTO_RETRIGGERS + 1} · plate=${plate} session=${inflight.sessionId} lane=${lane.id} device="${device.name}" (${device.host}:${device.port}) fare=RM ${(feeCents / 100).toFixed(2)} orderId=${orderId} txn=${txn.id}`, { plate, sessionId: inflight.sessionId, laneId: lane.id, device: device.name, host: device.host, port: device.port, feeCents, orderId, txnId: txn.id, attemptNo });

  let body: PayResultBody | null = null;
  try {
    body = await tngPayRequest({
      orderId,
      payAmount: feeCents,
      discountAmount: 0,
      enterTime: Math.floor(Date.parse(entryAt) / 1000) || Math.floor(Date.now() / 1000),
      payTime: Math.floor(Date.now() / 1000),
      timeoutMs: Math.max(15_000, (device.timeoutSeconds ?? 30) * 1000),
      host: device.host,
      port: device.port,
    });
  } catch (e: any) {
    flog(`W4G PayRequest failed/timeout: ${e?.message ?? e}`);
  }

  // If the exit was cancelled while we were awaiting (e.g. manual release), bail
  // without touching the session; the manual-release path voids the attempt.
  if (!exitsInFlight.get(lane.id)) return;
  exitsInFlight.delete(lane.id);

  if (!body) {
    // Timeout / network error / device rejection — the ATTEMPT failed, but the
    // car is still inside: leave the session 'entered' and let the operator
    // retrigger (a fresh attempt = a new transaction). Record the failed attempt.
    updateTransaction(txn.id, { status: 'failed' });
    flog(`EXIT TIMEOUT: plate=${plate} session=${inflight.sessionId} RM ${(inflight.feeCents / 100).toFixed(2)} — no response from "${device.name}". Attempt marked FAILED, session stays OPEN, barrier NOT pulsed. ⚠️ If the card WAS deducted, the callback was lost — check the device before charging again.`);
    w4gLog('error', `EXIT CHARGE result=TIMEOUT/NO-RESPONSE · plate=${plate} session=${inflight.sessionId} orderId=${orderId} txn=${txn.id} — transaction marked FAILED, gate stays CLOSED. ⚠️ If the customer's card actually deducted, the callback was lost (money taken, not recorded).`, { plate, sessionId: inflight.sessionId, orderId, txnId: txn.id });
    parkingEvents.emit('warning', { kind: 'exit-timeout', sessionId: inflight.sessionId, transactionId: txn.id });
    maybeAutoRetrigger(lane, device, entryAt, event, inflight);
    return;
  }

  const approved = body.state === '0';
  const cardScheme = payTypeToCardScheme(body.payType);
  const paymentTimestamp = body.payTime ? new Date(body.payTime * 1000).toISOString() : null;

  if (approved) {
    // Paid → cancel any pending auto-retrigger cycle for this session.
    autoRetriggerCounts.delete(inflight.sessionId);
    updateTransaction(txn.id, {
      status: 'paid',
      cardNumber: body.cardNo || null,
      paymentMethod: cardScheme,
      paymentTimestamp,
      apprCode: body.apprCode || null,
      payType: body.payType,
    });
    // Payment went through → the car may leave: advance the journey to 'exited'.
    recordExit(inflight.sessionId, {
      exitAt: event.exitAtOverride ?? new Date().toISOString(),
      exitLaneId: lane.id,
      exitCameraId: event.cameraId,
      exitImagePath: event.imagePath ?? takePendingCapture(event.cameraId, event.plate),
      durationMinutes: inflight.durationMinutes,
      feeCents: inflight.feeCents,
      status: 'exited',
      paymentStatus: 'paid',
      terminalTxnId: body.cardNo || null,
      cardScheme,
      paymentTimestamp,
    });
    flog(`EXIT PAID: plate=${plate} session=${inflight.sessionId} RM ${(inflight.feeCents / 100).toFixed(2)} · ${cardScheme} · card=${body.cardNo || '-'} appr=${body.apprCode || '-'} · ${inflight.durationMinutes}min → opening barrier`);
    w4gLog('recv', `EXIT CHARGE result=PAID · plate=${plate} session=${inflight.sessionId} orderId=${orderId} txn=${txn.id} scheme=${cardScheme} card=${body.cardNo || '-'} appr=${body.apprCode || '-'} — recorded PAID, gate OPENING.`, { plate, sessionId: inflight.sessionId, orderId, txnId: txn.id, cardScheme });
    // The money is in — THIS is the moment the boom must rise, or the driver has
    // paid and is sitting at a closed gate.
    parkingEvents.emit('exit-completed', {
      sessionId: inflight.sessionId,
      outcome: 'paid',
      transactionId: txn.id,
      cameraId: event.cameraId,
    });
  } else {
    // Card declined → record the failed attempt but DO NOT close the session.
    // The car is still inside (status stays 'entered'); the driver can retry or
    // staff can manually release.
    updateTransaction(txn.id, {
      status: 'failed',
      cardNumber: body.cardNo || null,
      paymentMethod: cardScheme,
      paymentTimestamp,
      apprCode: body.apprCode || null,
      payType: body.payType,
    });
    flog(`EXIT DECLINED: plate=${plate} session=${inflight.sessionId} RM ${(inflight.feeCents / 100).toFixed(2)} · state=${body.state} card=${body.cardNo || '-'} — no money taken, session stays OPEN, barrier NOT pulsed.`);
    w4gLog('error', `EXIT CHARGE result=DECLINED · plate=${plate} session=${inflight.sessionId} orderId=${orderId} txn=${txn.id} state=${body.state} card=${body.cardNo || '-'} — no money taken, gate stays CLOSED.`, { plate, sessionId: inflight.sessionId, orderId, txnId: txn.id, state: body.state });
    parkingEvents.emit('exit-declined', { sessionId: inflight.sessionId, transactionId: txn.id });
    maybeAutoRetrigger(lane, device, entryAt, event, inflight);
  }
}

/**
 * After a failed / timed-out / declined paid exit, optionally re-fire the charge
 * at the same terminal so the driver can tap again without staff manually
 * retriggering. Controlled by settings.tngAutoRetrigger (default on) and capped
 * at MAX_AUTO_RETRIGGERS per session. Each retry is a brand-new transaction with
 * its own OrderId. No-ops (and clears the counter) when the toggle is off, the
 * cap is reached, or the session is no longer chargeable (already paid/exited or
 * released).
 *
 * ⚠️ Double-charge caveat: a *timeout* can mean "the tap actually succeeded but
 * its PayResult callback never reached us" (network/firewall). In that case a
 * retrigger asks the driver to tap again → a second real deduction. Only safe
 * once the callback path is reliable; that's why the operator can switch it off.
 */
function maybeAutoRetrigger(
  lane: ParkingLane,
  device: PaymentTerminal,
  entryAt: string,
  event: PlateEvent,
  prev: ActiveExit,
): void {
  const tag = `plate=${prev.plate} session=${prev.sessionId} lane=${lane.id}`;
  if (!getSettings().tngAutoRetrigger) {
    w4gLog('info', `AUTO-RETRIGGER off (toggle disabled) · ${tag} — not re-arming; awaiting manual retrigger.`);
    return;
  }

  const attempts = autoRetriggerCounts.get(prev.sessionId) ?? 0;
  if (attempts >= MAX_AUTO_RETRIGGERS) {
    w4gLog('error', `AUTO-RETRIGGER stopped · ${tag} — hit the ${MAX_AUTO_RETRIGGERS}-attempt cap; awaiting manual release/retrigger.`, { sessionId: prev.sessionId, attempts });
    autoRetriggerCounts.delete(prev.sessionId);
    // The give-up moment: from here nothing recovers on its own, so it belongs in
    // the Activity Log (index.ts writes the row). The individual attempts stay in
    // the W4G log only — 3 rows per stuck car would bury everything else.
    parkingEvents.emit('warning', {
      kind: 'exit-auto-retrigger-capped',
      sessionId: prev.sessionId,
      plate: prev.plate,
      laneId: lane.id,
      attempts,
    });
    return;
  }

  // Stop if the car is no longer inside — paid, exited, or manually released.
  const session = getSessionById(prev.sessionId);
  if (!isStillChargeable(session)) {
    w4gLog('info', `AUTO-RETRIGGER skipped · ${tag} — session no longer chargeable (${describeChargeability(session)}).`, { sessionId: prev.sessionId });
    autoRetriggerCounts.delete(prev.sessionId);
    return;
  }

  autoRetriggerCounts.set(prev.sessionId, attempts + 1);
  // One armed timer per session, ever. A manual retrigger can race the delay
  // window: its failed attempt lands here while the previous timer is still
  // pending, and a bare set() would orphan that timer — still armed, but no
  // longer in the map, so a manual release could never cancel it (and when it
  // fired, its own delete() would remove the NEW timer's entry instead).
  const stale = autoRetriggerTimers.get(prev.sessionId);
  if (stale) {
    clearTimeout(stale);
    autoRetriggerTimers.delete(prev.sessionId);
  }
  w4gLog('send', `AUTO-RETRIGGER scheduled #${attempts + 1}/${MAX_AUTO_RETRIGGERS} · ${tag} — re-arming "${device.name}" in ${AUTO_RETRIGGER_DELAY_MS}ms.`, { sessionId: prev.sessionId, attempt: attempts + 1, max: MAX_AUTO_RETRIGGERS, delayMs: AUTO_RETRIGGER_DELAY_MS });
  parkingEvents.emit('warning', { kind: 'exit-auto-retrigger', sessionId: prev.sessionId, laneId: lane.id, attempt: attempts + 1, max: MAX_AUTO_RETRIGGERS });

  const timer = setTimeout(() => {
    autoRetriggerTimers.delete(prev.sessionId);
    // Re-check at fire time — in the delay window the car may have been released
    // or another exit may have grabbed the lane.
    const s = getSessionById(prev.sessionId);
    if (!isStillChargeable(s)) {
      w4gLog('info', `AUTO-RETRIGGER aborted at fire · ${tag} — session no longer chargeable (${describeChargeability(s)}).`, { sessionId: prev.sessionId });
      autoRetriggerCounts.delete(prev.sessionId);
      return;
    }
    if (exitsInFlight.has(lane.id)) {
      w4gLog('info', `AUTO-RETRIGGER aborted at fire · ${tag} — lane already busy with another attempt.`, { sessionId: prev.sessionId, laneId: lane.id });
      return;
    }
    if (!device.enabled) {
      w4gLog('error', `AUTO-RETRIGGER aborted at fire · ${tag} — terminal "${device.name}" is disabled.`, { sessionId: prev.sessionId });
      autoRetriggerCounts.delete(prev.sessionId);
      return;
    }
    // The listener can go down between attempts (operator flips TNG off while a
    // car is stuck at the barrier). Re-check here too — a retry with no callback
    // path is a real deduction we could never record.
    const ready = payResultListenerReady();
    if (!ready.ok) {
      w4gLog('error', `AUTO-RETRIGGER aborted at fire · ${tag} — ${ready.reason}. No PayRequest sent.`, { sessionId: prev.sessionId, reason: ready.reason });
      autoRetriggerCounts.delete(prev.sessionId);
      return;
    }
    // Re-establish the in-flight guard (cleared on the previous attempt) and
    // reuse the ORIGINAL duration/fee snapshot so the charge amount doesn't
    // drift with the extra seconds spent retrying.
    w4gLog('send', `AUTO-RETRIGGER firing #${attempts + 1}/${MAX_AUTO_RETRIGGERS} · ${tag} — starting a fresh charge now.`, { sessionId: prev.sessionId, attempt: attempts + 1 });
    exitsInFlight.set(lane.id, { ...prev, startedAt: Date.now() });
    startTngExitCharge(lane, device, prev.plate, prev.feeCents, entryAt, event).catch((e) => {
      w4gLog('error', `AUTO-RETRIGGER crashed · ${tag} — ${e?.message ?? String(e)}`, { sessionId: prev.sessionId });
      parkingEvents.emit('warning', { kind: 'exit-charge-crashed', sessionId: prev.sessionId, message: e?.message ?? String(e) });
      exitsInFlight.delete(lane.id);
    });
  }, AUTO_RETRIGGER_DELAY_MS);
  autoRetriggerTimers.set(prev.sessionId, timer);
}

// ─── fee calc ──────────────────────────────────────────────────────────────

/**
 * Whole minutes between two instants, TRUNCATED — the ONE duration rule for the
 * whole app. Matches the cloud TariffCalculator's `(int) diffInMinutes` and
 * computeFee's own internal schedule math (diffFloorMinutes), so the gate charge,
 * the "Test price" simulator, the live open-session preview, the admin session
 * editor and the duration_minutes shipped to the cloud can no longer disagree.
 *
 * The gate and the session editor used Math.ceil while the simulator used floor,
 * so a stay 30s past a grace or block boundary was charged at the barrier but
 * quoted free by Test price — the exact parity confusion the simulator exists to
 * prevent. Floor is the correct direction: it's what the cloud invoices from.
 *
 * Only affects policies with an empty rules[] (the legacy block model) plus the
 * recorded/displayed duration; the schedule path recomputes internally either way.
 */
export function stayDurationMinutes(entryAt: string | number, exitAt: string | number): number {
  const entryMs = typeof entryAt === 'number' ? entryAt : Date.parse(entryAt);
  const exitMs = typeof exitAt === 'number' ? exitAt : Date.parse(exitAt);
  if (Number.isNaN(entryMs) || Number.isNaN(exitMs)) return 0;
  return Math.max(0, diffFloorMinutes(entryMs, exitMs));
}

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

/** Does this cached pass cover the given site-local yyyy-MM-dd day? Mirrors the
 *  SQL lookup in findSeasonPassByPlate, including its NULLIF guard ('' from a
 *  sloppy cloud row = open-ended, same as NULL). */
function passCoversDay(pass: SeasonPass, dayKey: string): boolean {
  const start = pass.startDate || null;
  const end = pass.endDate || null;
  return (!start || start <= dayKey) && (!end || end >= dayKey);
}

/** ms instant of site-local midnight AFTER the given yyyy-MM-dd day — the first
 *  chargeable moment once a pass whose end_date is that day has lapsed. Local
 *  Date construction is safe here: tz.ts pins the process to the site zone. */
function startOfDayAfterKeyMs(dayKey: string): number {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(y, m - 1, d + 1, 0, 0, 0, 0).getTime();
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

/**
 * When NO rule covers `cursorMs`, find the earliest moment in (cursor, cycleEnd]
 * where coverage could begin: any active rule's window start, or midnight (which
 * is when day-of-week / valid-from-to membership can change).
 *
 * Why not just jump to midnight: that's what this used to do, and it skipped every
 * COVERED hour of the following day too, not merely the gap. A policy whose only
 * rule is 08:00–22:00, entered 23:00 and exited noon the next day, walked
 * 23:00 → midnight (uncovered) → midnight → next midnight (jumping clean over the
 * exit) and charged RM 0 for four billable morning hours. Advancing to the next
 * window start bills the covered portion and treats only the true gap as free.
 *
 * The cloud TariffCalculator throws on an uncovered moment (it treats coverage
 * gaps as misconfiguration), so there is no cloud answer to match here — the gate
 * must never crash mid-exit, and undercharging by a whole day is the worse of the
 * two available local behaviours.
 */
function nextCoverageStartMs(cursorMs: number, cycleEndMs: number, rules: TariffRule[]): number {
  // Midnight covers day-of-week / validity rollovers; cycleEnd bounds the walk.
  const candidates: number[] = [startOfNextDayMs(cursorMs), cycleEndMs];
  for (const r of rules) {
    if (r.isActive === false) continue;
    const from = normTime(r.timeFrom);
    if (from === '24:00:00') continue; // degenerate window, never starts
    const [h, m, s] = from.split(':').map((n) => Number(n));
    let start = setTimeOnMs(cursorMs, h || 0, m || 0, s || 0);
    if (start <= cursorMs) start = addOneDayMs(start); // already passed today
    candidates.push(start);
  }
  let earliest: number | null = null;
  for (const c of candidates) {
    if (c > cursorMs && (earliest === null || c < earliest)) earliest = c;
  }
  // Always strictly advances (every candidate is > cursor), so the caller's walk
  // terminates even for a policy that covers nothing at all.
  return Math.min(earliest ?? cycleEndMs, cycleEndMs);
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
      // Uncovered moment: skip ONLY the gap (to the next rule-window start or
      // midnight, whichever comes first) as free time — not the rest of the day.
      // See nextCoverageStartMs.
      cursor = nextCoverageStartMs(cursor, cycleEndMs, rules);
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
  const durationMinutes = stayDurationMinutes(entryMs, exitMs);
  const feeCents = computeFee(durationMinutes, policy, entryIso, exitIso);
  return { ok: true, feeCents, durationMinutes, policyName: policy.policyName, currency: policy.currency };
}

/**
 * Abort any in-flight exit charge for this session (manual release). Clears the
 * lane busy-guard and the auto-retrigger counter, cancels a scheduled re-arm, then
 * best-effort cancels the charge at the device. Without this, a PayResult that
 * arrives AFTER the operator released the car would pass startTngExitCharge's
 * post-await guard (the lane was still marked in-flight) and flip the voided
 * transaction back to 'paid' + overwrite the session's 'manual_release' status
 * with 'exited'.
 *
 * Returns true if anything was actually cancelled — an in-flight charge OR a
 * pending retrigger. Note a release can land in the gap BETWEEN attempts, where
 * there is no in-flight charge but a timer is armed; isStillChargeable() would
 * catch that at fire time anyway, so clearing the timer here is about not waking
 * up to log a confusing abort 2s after the operator already let the car out.
 */
export function cancelExitInFlight(sessionId: number): boolean {
  autoRetriggerCounts.delete(sessionId);
  let cancelled = false;
  const pendingTimer = autoRetriggerTimers.get(sessionId);
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    autoRetriggerTimers.delete(sessionId);
    cancelled = true;
    flog(`pending auto-retrigger cancelled for session=${sessionId} (manual release)`);
  }
  for (const [laneId, exit] of exitsInFlight) {
    if (exit.sessionId !== sessionId) continue;
    exitsInFlight.delete(laneId);
    flog(`exit charge cancelled for session=${sessionId} lane=${laneId} (manual release)`);
    // Reject the awaiting PayRequest + tell the device to abort the deduction.
    if (exit.orderId) {
      tngPayCancel(exit.orderId, { host: exit.deviceHost, port: exit.devicePort }).catch(() => null);
    }
    return true;
  }
  return cancelled;
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
export function retriggerSessionExit(sessionId: number, laneOverride?: number | null): { ok: boolean; error?: string } {
  const session = getSessionById(sessionId);
  if (!session) return { ok: false, error: 'session_not_found' };
  if (session.exitAt) return { ok: false, error: 'session_already_closed — nothing to retrigger' };

  // laneOverride is the exit lane the operator is standing at (Live-display
  // tile). Prefer it so the exit runs on the RIGHT gate, not the car's entry
  // lane. Falls back to the session's own exit/entry lane (Sessions-page use).
  const laneId = laneOverride ?? session.exitLaneId ?? session.entryLaneId;
  if (!laneId) return { ok: false, error: 'session_has_no_lane — attach the session to a lane in Edit first' };

  const lane = getLane(laneId);
  if (!lane) return { ok: false, error: 'lane_not_found' };
  // The fee is collected by the lane's Alarmtech W4G device, so a retrigger
  // needs one wired — otherwise there's nothing to charge on.
  if (!lane.terminalId) {
    return { ok: false, error: `lane "${lane.name}" has no payment device wired — attach one in Lanes` };
  }

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
 * Retrigger the exit-payment flow for whichever open session currently holds
 * this plate. Backs the Live-display "retrigger payment" action, where the
 * operator reads the plate off the video feed and types it in. The plate is
 * normalised the same way the LPR pipeline normalises it, so it matches how
 * the open session was stored.
 */
export function retriggerSessionExitByPlate(plate: string, laneId?: number | null): { ok: boolean; error?: string } {
  const norm = normalisePlate(plate);
  if (!norm) return { ok: false, error: 'plate_required' };
  const session = findOpenSessionByPlate(norm);
  if (!session) return { ok: false, error: `no car currently inside with plate "${norm}"` };
  // laneId is the exit lane the operator triggered from (the Live-display tile),
  // so the exit runs on that gate's terminal / TNG controller.
  return retriggerSessionExit(session.id, laneId);
}

/**
 * Pick the camera on `laneId` that faces the given way — the one a real car
 * would trigger. Falls back to any enabled camera on the lane so a half-wired
 * test lane still routes somewhere.
 *
 * Getting this wrong is not cosmetic. Every access decision is keyed to
 * event.cameraId (Only Pass Allow at entry, the audit trail, the relay that gets
 * pulsed), so picking "any enabled camera" — as the exit simulator used to —
 * meant that on a lane with BOTH an entry and an exit camera it grabbed the
 * entry one, and the exit was then judged by the entry camera's settings.
 */
function laneCameraFacing(laneId: number, direction: 'entry' | 'exit') {
  const cams = listCameras().filter((c) => c.laneId === laneId && c.enabled);
  return cams.find((c) => c.direction === direction) ?? cams[0] ?? null;
}

/**
 * DEV/QA — simulate a plate read at an ENTRY camera on this lane.
 *
 * Emits the very same PlateEvent the LPR webhook emits, so it runs the identical
 * handlePlateEvent path: blacklist check, Only Pass Allow check, session write,
 * barrier pulse, audit row, cloud mirror. The ONLY difference is
 * entryAtOverride, which back-dates the stored entry_at so a later timed Exit
 * can price a controlled stay.
 *
 * It used to write to the DB directly and duplicate the guards, which meant it
 * silently drifted from the real flow — most visibly, it never pulsed the
 * barrier. Refusals now surface the same way a real refusal does: as a
 * parkingEvents 'warning' the UI shows as a staff alert.
 */
export async function simulateEntryAt(
  laneId: number, plate: string, entryIso: string,
): Promise<{ ok: boolean; error?: string; cameraId?: number }> {
  const lane = getLane(laneId);
  if (!lane) return { ok: false, error: 'lane_not_found' };
  const norm = normalisePlate(plate);
  if (!norm) return { ok: false, error: 'plate_required' };
  const entryMs = Date.parse(entryIso);
  if (Number.isNaN(entryMs)) return { ok: false, error: 'invalid_entry_time' };
  const cam = laneCameraFacing(laneId, 'entry');
  if (!cam) return { ok: false, error: `no enabled camera on lane "${lane.name}" — add or enable one so the flow can route to this lane` };

  const event: PlateEvent = {
    cameraId: cam.id,
    plate: norm,
    confidence: 1.0,
    // Synthetic test record — no captured frame, so a live-feed snapshot here
    // would be misleading.
    imagePath: null,
    timestamp: entryIso,
    direction: 'entry',
    entryAtOverride: new Date(entryMs).toISOString(),
  };
  flog(`DEV SIMULATE ENTRY: lane="${lane.name}" plate=${norm} entryAt=${entryIso} via camera=${cam.id} "${cam.name}" — dispatching as a real plate event`);
  lprEvents.emit('plate', event);
  return { ok: true, cameraId: cam.id };
}

/**
 * DEV/QA — simulate a plate read at an EXIT camera on this lane, with an
 * operator-chosen exit time (fee window + recorded exit_at).
 *
 * Same contract as simulateEntryAt: it emits the identical PlateEvent the
 * webhook would, so the pass check, fee math, terminal drive and barrier pulse
 * all run exactly as they do for a real car.
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
  // The EXIT-facing camera, not "any camera on the lane" — see laneCameraFacing.
  const cam = laneCameraFacing(laneId, 'exit');
  if (!cam) return { ok: false, error: `no enabled camera on lane "${lane.name}" — add or enable one so the flow can route to this lane` };

  const event: PlateEvent = {
    cameraId: cam.id,
    plate: norm,
    confidence: 1.0,
    imagePath: null,
    timestamp: exitIso,
    direction: 'exit',
    exitAtOverride: new Date(exitMs).toISOString(),
  };
  flog(`DEV SIMULATE EXIT: lane="${lane.name}" plate=${norm} exitAt=${exitIso} via camera=${cam.id} "${cam.name}" — dispatching as a real plate event`);
  lprEvents.emit('plate', event);
  return { ok: true, cameraId: cam.id };
}
