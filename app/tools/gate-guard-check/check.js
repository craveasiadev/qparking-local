/**
 * Drives the REAL parking-flow entry path (lprEvents → handlePlateEvent →
 * handleEntry) to test the exit re-scan grace guard, which decides whether an
 * inbound plate read is a genuine arrival or an ANPR camera firing the same plate
 * again moments after that car exited.
 *
 * Launched by run.mjs; see the README.
 */
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const out = { ok: false, checks: [], error: null };
const check = (name, pass, detail = null) => out.checks.push({ name, pass, detail });

try {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-gate-guard-'));
  app.setPath('userData', tmpDir);

  const db = require('../../dist/main/services/db');
  const flow = require('../../dist/main/services/parking-flow');
  const { lprEvents } = require('../../dist/main/services/lpr-webhook');

  // Keep every outward-facing side effect off: no cloud creds, no turnstile, no
  // payment device. We only care about whether a session row gets created.
  db.saveSettings({
    qparkingBaseUrl: '', qparkingApiKey: '',
    faceGateEnabled: false, tngEnabled: false,
    entryCameraHandlesExit: false,
    exitGracePeriodSeconds: 90,
  });

  const lane = db.upsertLane({ name: 'L1', policyId: null, terminalId: null, gateRelayAddress: null, enabled: true });
  const cam = db.upsertCamera({
    name: 'C1', laneId: lane.id, direction: 'entry', host: '10.0.0.9',
    deviceUser: null, devicePassword: null, devicePort: null, webhookSecret: null, enabled: true,
  });

  flow.startParkingFlow();

  const ignored = [];
  flow.parkingEvents.on('entry-ignored-recent-exit', (p) => ignored.push(p));

  /** Create an already-closed session for `plate` that exited `secondsAgo`. */
  function seedClosedSession(plate, secondsAgo) {
    const s = db.createEntrySession(plate, lane.id, cam.id, null);
    db.recordExit(s.id, {
      exitAt: new Date(Date.now() - secondsAgo * 1000).toISOString(),
      exitLaneId: lane.id, exitCameraId: cam.id, exitImagePath: null,
      durationMinutes: 30, feeCents: 0, paymentStatus: 'free', terminalTxnId: null,
      freeReason: 'rate-zero',
    });
    return s.id;
  }

  /** Fire an entry-direction plate read exactly as the LPR webhook would. */
  function readPlate(plate) {
    lprEvents.emit('plate', {
      cameraId: cam.id, plate, confidence: 1, imagePath: null,
      timestamp: new Date().toISOString(), direction: 'entry',
    });
  }

  const isInside = (plate) => !!db.findOpenSessionByPlate(plate);

  // 1. The bug: a duplicate read seconds after the exit must NOT open a session.
  seedClosedSession('DUP0001', 5);
  readPlate('DUP0001');
  check('duplicate read 5s after exit creates no session', !isInside('DUP0001'));
  check('…and reports entry-ignored-recent-exit', ignored.some((p) => p.plate === 'DUP0001'),
    JSON.stringify(ignored.map((p) => p.plate)));

  // 2. Past the window it's a real arrival again (300s > 90s grace).
  seedClosedSession('OLD0002', 300);
  readPlate('OLD0002');
  check('genuine re-entry after the grace window is admitted', isInside('OLD0002'));

  // 3. A plate with no history at all is unaffected.
  readPlate('NEW0003');
  check('first-time plate is admitted', isInside('NEW0003'));

  // 4. Grace 0 disables the guard entirely (operator opt-out).
  db.saveSettings({ exitGracePeriodSeconds: 0 });
  seedClosedSession('ZERO0004', 2);
  readPlate('ZERO0004');
  check('exitGracePeriodSeconds=0 disables the guard', isInside('ZERO0004'));
  db.saveSettings({ exitGracePeriodSeconds: 90 });

  // 5. A future-dated exit_at (hand-edited session / clock skew) must not swallow
  //    entries forever — the negative-age guard.
  const futureId = db.createEntrySession('FUT0005', lane.id, cam.id, null);
  db.recordExit(futureId.id, {
    exitAt: new Date(Date.now() + 3600_000).toISOString(),
    exitLaneId: lane.id, exitCameraId: cam.id, exitImagePath: null,
    durationMinutes: 1, feeCents: 0, paymentStatus: 'free', terminalTxnId: null,
  });
  readPlate('FUT0005');
  check('future-dated exit does not block entry', isInside('FUT0005'));

  // 6. Regression guard: a car that is genuinely still inside keeps reporting
  //    ALREADY INSIDE (rescan-ignored), not the new grace path.
  const rescans = [];
  flow.parkingEvents.on('rescan-ignored', (p) => rescans.push(p));
  readPlate('NEW0003'); // already open from case 3
  check('open session still yields rescan-ignored', rescans.some((p) => p.plate === 'NEW0003'),
    JSON.stringify(rescans.map((p) => p.plate)));
  check('…and did not double-open a session',
    db.listOpenSessions().filter((s) => s.plate === 'NEW0003').length === 1);

  // ─── Manual release must never rewrite a settled session ──────────────
  // A release can land moments after a payment closed the session (the driver taps
  // just as staff press the button). Overwriting then turns real revenue into a
  // waived 'manual_release'.
  const paid = db.createEntrySession('PAID0006', lane.id, cam.id, null);
  db.recordExit(paid.id, {
    exitAt: new Date().toISOString(), exitLaneId: lane.id, exitCameraId: cam.id,
    exitImagePath: null, durationMinutes: 90, feeCents: 500,
    paymentStatus: 'paid', terminalTxnId: 'card-123',
  });
  const late = db.manualReleaseSession(paid.id, 'operator override');
  check('manual release refuses an already-closed session', late.changed === false,
    `changed=${late.changed}`);
  check('…and leaves the paid record intact',
    late.session.paymentStatus === 'paid' && late.session.status === 'exited' && late.session.feeCents === 500,
    `${late.session.status}/${late.session.paymentStatus} fee=${late.session.feeCents}`);

  const stuck = db.createEntrySession('OPEN0007', lane.id, cam.id, null);
  const released = db.manualReleaseSession(stuck.id, 'barrier stuck');
  check('manual release still closes a genuinely open session',
    released.changed === true && released.session.status === 'manual_release',
    `changed=${released.changed} status=${released.session.status}`);

  // ─── Pass preference ordering ─────────────────────────────────────────
  // SQLite sorts NULL below every value, so `end_date DESC` alone ranked a
  // never-expiring pass LAST — the opposite of "longest coverage".
  const nowIso = new Date().toISOString();
  const mkPass = (passId, over = {}) => ({
    passId, plateNumber: 'PASS0008', passType: 'monthly', status: 'active',
    startDate: '2026-01-01', endDate: '2026-12-31', isFree: false,
    spaceNumber: null, fetchedAt: nowIso, ...over,
  });

  db.replaceAllSeasonPasses([
    mkPass('p-dated'),
    mkPass('p-forever', { passType: 'resident', endDate: null }),
  ]);
  const broadest = db.findSeasonPassByPlate('PASS0008', { entryAt: nowIso, exitAt: nowIso });
  check('open-ended pass preferred over a dated one', broadest?.passId === 'p-forever',
    broadest?.passId);

  db.replaceAllSeasonPasses([
    mkPass('p-forever2', { endDate: null }),
    mkPass('p-free', { isFree: true }),
  ]);
  const free = db.findSeasonPassByPlate('PASS0008', { entryAt: nowIso, exitAt: nowIso });
  check('free pass still outranks an open-ended paid one', free?.passId === 'p-free',
    free?.passId);

  // ─── One duration rule everywhere ─────────────────────────────────────
  // The gate used Math.ceil while "Test price" used floor, so a stay just past a
  // grace boundary was charged at the barrier but quoted free by the simulator.
  const t0 = Date.parse('2026-07-28T02:00:00Z');
  check('59m30s truncates to 59', flow.stayDurationMinutes(t0, t0 + 59 * 60_000 + 30_000) === 59,
    String(flow.stayDurationMinutes(t0, t0 + 59 * 60_000 + 30_000)));
  check('exact 60m is 60', flow.stayDurationMinutes(t0, t0 + 60 * 60_000) === 60);
  check('exit before entry clamps to 0', flow.stayDurationMinutes(t0, t0 - 60_000) === 0);

  // End-to-end: a legacy (no rules[]) plan with a 60-minute grace, stayed 60m30s.
  db.upsertRatePolicy({
    policyId: 'legacy-grace', policyName: 'Legacy grace', freeMinutes: 60,
    firstBlockCents: 300, perBlockCents: 200, blockMinutes: 60, dailyCapCents: 0,
    currency: 'MYR', fetchedAt: nowIso, rules: [],
    policyDescription: null, graceExceededBehavior: 'charge_from_entry',
    cutoffEnabled: false, cutoffTime: null, cutoffBehavior: null,
    newDayFixedFeeCents: null, rateBasis: 'occupancy', flatMultiRate: 'sum',
    firstBlockOncePerEntry: false, policyDailyCapCents: null, isSiteDefault: false,
  });
  const entryIso = '2026-07-28T10:00:00+08:00';
  const exitIso = '2026-07-28T11:00:30+08:00';
  const sim = flow.simulateRatePolicyFee('legacy-grace', entryIso, exitIso);
  check('Test price: 60m30s is inside a 60min grace (free)',
    sim.ok && sim.feeCents === 0 && sim.durationMinutes === 60, JSON.stringify(sim));
  check('gate duration agrees with Test price duration',
    flow.stayDurationMinutes(entryIso, exitIso) === sim.durationMinutes,
    `gate=${flow.stayDurationMinutes(entryIso, exitIso)} sim=${sim.durationMinutes}`);

  out.ok = out.checks.every((c) => c.pass);
} catch (e) {
  out.error = e && e.stack ? e.stack : String(e);
}

fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2));
app.exit(out.ok ? 0 : 1);
