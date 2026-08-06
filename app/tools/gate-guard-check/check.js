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

// Pin the site timezone exactly like src/main/tz.ts does in the real app —
// the pass-lapse billing boundary (site-local midnight) depends on it, and
// this harness requires the services directly without going through index.ts.
process.env.TZ = 'Asia/Kuala_Lumpur';

const out = { ok: false, checks: [], error: null };
const check = (name, pass, detail = null) => out.checks.push({ name, pass, detail });

// Wrapped in an async IIFE: the webhook-coercion checks at the end drive real
// HTTP requests, and this is a CommonJS module so top-level await isn't
// available. The result file is written from .finally() so a throw still
// reports whatever ran before it — same behaviour as the old bare try/catch.
(async () => {
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

  // ─── Open-session restore import ("Sync now" recovery) ────────────────
  // A wiped/rebound box pulls the cloud's open parking records so cars that
  // entered before the reset can still exit. The guards under test:
  //  (a) an unknown plate imports as an open session
  //  (b) a plate already inside keeps the box's own record
  //  (c) a stay the box already knows (entry within ±5 min, even CLOSED) is
  //      skipped — a stale cloud record must not re-open a stay this box just
  //      closed while its exit push sits in the outbound queue.
  const knownEntryIso = '2026-07-30T01:00:00.000Z';
  const closedStay = db.createEntrySession('CLOSED0010', lane.id, cam.id, null);
  db.updateSessionFields(closedStay.id, { entryAt: knownEntryIso });
  db.recordExit(closedStay.id, {
    exitAt: '2026-07-30T02:00:00.000Z', exitLaneId: lane.id, exitCameraId: cam.id,
    exitImagePath: null, durationMinutes: 60, feeCents: 300, paymentStatus: 'paid', terminalTxnId: 'c-1',
  });

  const restore = db.importOpenSessionsFromCloud([
    { plate: 'REST0009', entryAt: '2026-07-30T00:30:00.000Z' },                 // (a) fresh → import
    { plate: 'NEW0003', entryAt: '2026-07-30T00:00:00.000Z' },                  // (b) already inside → skip
    { plate: 'CLOSED0010', entryAt: '2026-07-30T01:03:00.000Z' },               // (c) known closed stay (+3min) → skip
  ]);
  check('restore: unknown plate imported as open session',
    restore.imported === 1 && !!db.findOpenSessionByPlate('REST0009'),
    JSON.stringify(restore));
  const restored = db.findOpenSessionByPlate('REST0009');
  check('restore: entry time and origin note preserved',
    restored?.entryAt === '2026-07-30T00:30:00.000Z' && /Restored from cloud/.test(restored?.notes ?? ''),
    `${restored?.entryAt} · ${restored?.notes}`);
  check('restore: plate already inside keeps the local record',
    db.listOpenSessions().filter((s) => s.plate === 'NEW0003').length === 1);
  check('restore: known closed stay is not re-opened (stale-cloud guard)',
    !db.findOpenSessionByPlate('CLOSED0010'));
  // Idempotence: a second Sync now imports nothing new.
  const again = db.importOpenSessionsFromCloud([
    { plate: 'REST0009', entryAt: '2026-07-30T00:30:00.000Z' },
  ]);
  check('restore: re-running the import is a no-op', again.imported === 0 && again.skipped === 1,
    JSON.stringify(again));
  // …and the restored session exits like any other.
  let restoreExitErr = null;
  try {
    db.recordExit(restored.id, {
      exitAt: '2026-07-30T03:00:00.000Z', exitLaneId: lane.id, exitCameraId: cam.id,
      exitImagePath: null, durationMinutes: 150, feeCents: 0, paymentStatus: 'free', terminalTxnId: null,
      freeReason: 'rate-zero',
    });
  } catch (e) { restoreExitErr = e.message; }
  check('restore: restored session can be closed by the exit flow', restoreExitErr === null && !db.findOpenSessionByPlate('REST0009'), restoreExitErr);

  // ─── Pass lapsed mid-stay → bill only the uncovered tail ──────────────
  // Enter on the pass's last valid day, exit after it expired: the stay's tail
  // (from site-local midnight after end_date) is priced as a transient stay;
  // a pass covering the EXIT day still means a fully free exit, even when the
  // covering pass is a different row than the lapsed one (renewed mid-stay).
  db.upsertRatePolicy({
    policyId: 'pass-tail', policyName: 'Pass tail', freeMinutes: 0,
    firstBlockCents: 500, perBlockCents: 300, blockMinutes: 60, dailyCapCents: 0,
    currency: 'MYR', fetchedAt: nowIso, rules: [],
    policyDescription: null, graceExceededBehavior: 'charge_from_entry',
    cutoffEnabled: false, cutoffTime: null, cutoffBehavior: null,
    newDayFixedFeeCents: null, rateBasis: 'occupancy', flatMultiRate: 'sum',
    firstBlockOncePerEntry: false, policyDailyCapCents: null, isSiteDefault: false,
  });
  const lane2 = db.upsertLane({ name: 'L2', policyId: 'pass-tail', terminalId: null, gateRelayAddress: null, enabled: true });
  const camExit = db.upsertCamera({
    name: 'C2', laneId: lane2.id, direction: 'exit', host: '10.0.0.10',
    deviceUser: null, devicePassword: null, devicePort: null, webhookSecret: null, enabled: true,
  });

  const mkPlatePass = (passId, plateNumber, over = {}) => ({
    passId, plateNumber, passType: 'monthly', status: 'active',
    startDate: '2026-07-01', endDate: '2026-07-31', isFree: false,
    spaceNumber: null, fetchedAt: nowIso, ...over,
  });
  db.replaceAllSeasonPasses([
    mkPlatePass('p-lapsed-a', 'PART0011'),
    mkPlatePass('p-lapsed-b', 'REN0012', { passType: 'free_access', isFree: true }),
    mkPlatePass('p-renew', 'REN0012', { startDate: '2026-08-01', endDate: '2026-08-31' }),
    mkPlatePass('p-full', 'FULL0013', { endDate: '2026-12-31' }),
  ]);

  const pendings = [];
  const completed = [];
  const warned = [];
  flow.parkingEvents.on('exit-pending', (p) => pendings.push(p));
  flow.parkingEvents.on('exit-completed', (p) => completed.push(p));
  flow.parkingEvents.on('warning', (p) => warned.push(p));

  /** Open a session on lane2 at `entryIso`, then fire a timed exit read. */
  function driveExit(plate, entryIso, exitIso) {
    const s = db.createEntrySession(plate, lane2.id, camExit.id, null);
    db.updateSessionFields(s.id, { entryAt: entryIso });
    lprEvents.emit('plate', {
      cameraId: camExit.id, plate, confidence: 1, imagePath: null,
      timestamp: exitIso, direction: 'exit', exitAtOverride: exitIso,
    });
    return s.id;
  }

  // Entry 31 Jul 10:00 MYT (last covered day), exit 1 Aug 12:00 MYT. Billable
  // window starts 1 Aug 00:00 MYT → 720 min → RM5 first hour + 11×RM3 = RM38.
  // (Full 26h stay would be RM80 — proves the covered head wasn't billed.)
  driveExit('PART0011', '2026-07-31T02:00:00.000Z', '2026-08-01T04:00:00.000Z');
  const partial = pendings.find((p) => p.session.plate === 'PART0011');
  check('lapsed pass: exit is NOT free (goes to payment)', !!partial && !completed.some((c) => c.reason?.startsWith('pass-') && c.sessionId === partial?.session.id));
  check('lapsed pass: only the uncovered tail is billed (RM38, not RM80)',
    partial?.feeCents === 3800, `feeCents=${partial?.feeCents}`);
  check('lapsed pass: audit duration stays the full stay (1560min)',
    partial?.durationMinutes === 1560, `duration=${partial?.durationMinutes}`);
  check('lapsed pass: session stays open awaiting the terminal',
    !!db.findOpenSessionByPlate('PART0011') && warned.some((w) => w.kind === 'exit-no-terminal'));

  // Renewed mid-stay: the lapsed free_access pass outranks the renewal in the
  // broad lookup, but the exit-day re-query must still find the renewal → free.
  driveExit('REN0012', '2026-07-31T02:00:00.000Z', '2026-08-01T04:00:00.000Z');
  const renewed = completed.find((c) => c.passId === 'p-renew');
  check('renewed mid-stay: still a free exit via the renewal pass',
    !!renewed && renewed.outcome === 'free' && !db.findOpenSessionByPlate('REN0012'),
    JSON.stringify(completed.map((c) => `${c.reason}/${c.passId ?? '-'}`)));

  // Plain valid pass covering the whole stay: unchanged free exit.
  driveExit('FULL0013', '2026-07-31T02:00:00.000Z', '2026-08-01T04:00:00.000Z');
  check('pass covering exit: free exit unchanged',
    completed.some((c) => c.passId === 'p-full' && c.outcome === 'free') && !db.findOpenSessionByPlate('FULL0013'));

  // ─── pass-holders-only access mode (2026-08-05) ──────────────────────────
  // A 'pass_only' camera asks ONE question at both ends: does this plate hold a
  // pass valid right now? Everything else — sessions, fees, terminals — is
  // irrelevant on such a lane.
  const poLane = db.upsertLane({ name: 'L-PASSONLY', policyId: 'pass-tail', terminalId: null, gateRelayAddress: null, enabled: true });
  const poIn = db.upsertCamera({
    name: 'PO-IN', laneId: poLane.id, direction: 'entry', accessMode: 'pass_only',
    host: '10.0.0.20', deviceUser: 'admin', devicePassword: 'admin', devicePort: 80,
    webhookSecret: null, enabled: true,
  });
  const poOut = db.upsertCamera({
    name: 'PO-OUT', laneId: poLane.id, direction: 'exit', accessMode: 'pass_only',
    host: '10.0.0.21', deviceUser: 'admin', devicePassword: 'admin', devicePort: 80,
    webhookSecret: null, enabled: true,
  });
  check('access mode persists as pass_only', db.getCamera(poIn.id).accessMode === 'pass_only');
  check('access mode defaults to open on an ordinary camera', db.getCamera(cam.id).accessMode === 'open');

  db.replaceAllSeasonPasses([
    mkPlatePass('p-res', 'RES0001', { passType: 'resident', startDate: null, endDate: null }),
    mkPlatePass('p-gone', 'OLD0099', { startDate: '2020-01-01', endDate: '2020-12-31' }),
    mkPlatePass('p-ban', 'BAN0042', { passType: 'resident', startDate: null, endDate: null }),
    mkPlatePass('p-lapsed-a', 'PART0011'),
    mkPlatePass('p-lapsed-b', 'REN0012', { passType: 'free_access', isFree: true }),
    mkPlatePass('p-renew', 'REN0012', { startDate: '2026-08-01', endDate: '2026-08-31' }),
    mkPlatePass('p-full', 'FULL0013', { endDate: '2026-12-31' }),
  ]);

  const entries = [];
  flow.parkingEvents.on('entry', (p) => entries.push(p));
  const readOn = (cameraId, plate, direction) => lprEvents.emit('plate', {
    cameraId, plate, confidence: 1, imagePath: null,
    timestamp: new Date().toISOString(), direction,
  });

  // 1. Resident with a valid open-ended pass → in.
  readOn(poIn.id, 'RES0001', 'entry');
  check('pass-only: valid pass is admitted', isInside('RES0001'));
  check('pass-only: …and the APP is marked as barrier owner',
    entries.some((e) => e.session?.plate === 'RES0001' && e.barrier === 'app'));

  // 2. Unregistered vehicle → refused outright. THE point of the feature.
  readOn(poIn.id, 'NOPASS01', 'entry');
  check('pass-only: unregistered plate creates NO session', !isInside('NOPASS01'));
  check('pass-only: …and reports entry-not-authorised',
    warned.some((w) => w.kind === 'entry-not-authorised' && w.plate === 'NOPASS01'));

  // 3. Expired pass is not a pass (operator decision 2026-08-05: they renew).
  readOn(poIn.id, 'OLD0099', 'entry');
  check('pass-only: an EXPIRED pass is refused like any stranger', !isInside('OLD0099'));

  // 4. Blacklist still wins over a valid pass — order matters.
  db.replaceAllBlockedPlates([{ plateNumber: 'BAN0042', vehicleId: 'v-1', reason: 'towed', fetchedAt: nowIso }]);
  readOn(poIn.id, 'BAN0042', 'entry');
  check('pass-only: blacklist beats a valid pass', !isInside('BAN0042'));
  check('pass-only: …and is reported as BLACKLISTED, not merely unauthorised',
    warned.some((w) => w.kind === 'entry-blacklisted' && w.plate === 'BAN0042')
    && !warned.some((w) => w.kind === 'entry-not-authorised' && w.plate === 'BAN0042'));
  db.replaceAllBlockedPlates([]);

  // 5. Exit: the pass holder leaves free, with no terminal wired to the lane.
  readOn(poOut.id, 'RES0001', 'exit');
  await new Promise((r) => setTimeout(r, 30));
  check('pass-only exit: session closed', !isInside('RES0001'));
  check('pass-only exit: free, credited to the pass, no terminal involved',
    completed.some((c) => c.passId === 'p-res' && c.outcome === 'free' && c.barrier === 'app')
    && !warned.some((w) => w.kind === 'exit-no-terminal' && w.plate === 'RES0001'));

  // 6. Exit with no pass → refused. Covers the tailgater and the lapsed
  //    resident alike: nothing recorded, barrier down, operator handles it.
  const ghost = db.createEntrySession('GHOST01', poLane.id, poIn.id, null);
  readOn(poOut.id, 'GHOST01', 'exit');
  await new Promise((r) => setTimeout(r, 30));
  check('pass-only exit: no pass → refused', !!db.findOpenSessionByPlate('GHOST01'));
  check('pass-only exit: …session left OPEN for the operator',
    db.getSessionById(ghost.id).status === 'entered');
  check('pass-only exit: …and reports exit-not-authorised',
    warned.some((w) => w.kind === 'exit-not-authorised' && w.plate === 'GHOST01'));

  // 7. Pass holder whose entry was never recorded still gets out (misread /
  //    entry camera down), and it's flagged so a failing camera surfaces.
  readOn(poOut.id, 'RES0001', 'exit');
  await new Promise((r) => setTimeout(r, 30));
  check('pass-only exit: pass holder with no open session is released',
    warned.some((w) => w.kind === 'exit-pass-holder-no-entry' && w.plate === 'RES0001'));

  // 8. Regression: an 'open' camera is completely untouched by all of this —
  //    no pass needed, and the app does NOT claim the barrier.
  readOn(cam.id, 'ORDINARY1', 'entry');
  check('open camera: unregistered plate still admitted (flow unchanged)', isInside('ORDINARY1'));
  check('open camera: barrier stays camera-owned (no new pulse)',
    entries.some((e) => e.session?.plate === 'ORDINARY1' && e.barrier === 'camera'));

  // ─── barrier control, independent of access mode ─────────────────────────
  // "Who may enter" and "who lifts the boom" are separate settings. A site that
  // has switched its camera's auto-open off still wants everyone admitted — but
  // now nothing opens unless THIS app pulses.
  const acLane = db.upsertLane({ name: 'L-APPCTRL', policyId: null, terminalId: null, gateRelayAddress: null, enabled: true });
  const acIn = db.upsertCamera({
    name: 'AC-IN', laneId: acLane.id, direction: 'entry',
    accessMode: 'open', barrierControl: 'app',
    host: '10.0.0.30', deviceUser: 'admin', devicePassword: 'admin', devicePort: 80,
    webhookSecret: null, enabled: true,
  });
  const acOut = db.upsertCamera({
    name: 'AC-OUT', laneId: acLane.id, direction: 'exit',
    accessMode: 'open', barrierControl: 'app',
    host: '10.0.0.31', deviceUser: 'admin', devicePassword: 'admin', devicePort: 80,
    webhookSecret: null, enabled: true,
  });
  check('barrierControl persists as app', db.getCamera(acIn.id).barrierControl === 'app');
  check('barrierControl defaults to camera', db.getCamera(cam.id).barrierControl === 'camera');

  readOn(acIn.id, 'ANYCAR01', 'entry');
  check('app-controlled + open access: any plate admitted', isInside('ANYCAR01'));
  check('app-controlled + open access: the APP owns the barrier',
    entries.some((e) => e.session?.plate === 'ANYCAR01' && e.barrier === 'app'));

  // The exit side must carry it too, or a car would be let out in the DB while
  // the boom stayed down.
  readOn(acOut.id, 'ANYCAR01', 'exit');
  await new Promise((r) => setTimeout(r, 30));
  check('app-controlled exit: session closed', !isInside('ANYCAR01'));
  check('app-controlled exit: barrier marked app-owned on the completion event',
    completed.some((c) => c.barrier === 'app' && c.cameraId === acOut.id));

  // Blacklist becomes genuinely enforceable once the app owns the barrier —
  // previously the camera opened regardless of what we decided.
  db.replaceAllBlockedPlates([{ plateNumber: 'BANNED99', vehicleId: 'v-9', reason: 'unpaid', fetchedAt: nowIso }]);
  readOn(acIn.id, 'BANNED99', 'entry');
  check('app-controlled: blacklisted plate creates no session and no pulse',
    !isInside('BANNED99') && !entries.some((e) => e.session?.plate === 'BANNED99'));
  db.replaceAllBlockedPlates([]);

  // pass_only must imply app control even if someone writes 'camera' — a pass
  // check on a camera that opens its own relay is decoration.
  const coerced = db.upsertCamera({
    name: 'COERCE-CAM', laneId: null, direction: 'entry',
    accessMode: 'pass_only', barrierControl: 'camera',
    host: '10.0.0.32', deviceUser: 'admin', devicePassword: 'admin', devicePort: 80,
    webhookSecret: null, enabled: true,
  });
  check('pass_only forces barrierControl=app even when told otherwise',
    db.getCamera(coerced.id).barrierControl === 'app');

  // Turning Only Pass Allow back OFF must release barrier control with it. The
  // form derives barrierControl from the toggle and sends it on save; if that
  // derivation were dropped, the row would keep barrier_control='app' with no
  // control left on screen able to clear it — and the credential validation
  // would then refuse to save the camera at all. A dead end, reachable by simply
  // unticking the box.
  db.upsertCamera({
    id: coerced.id, name: 'COERCE-CAM', laneId: null, direction: 'entry',
    accessMode: 'open', barrierControl: 'camera',
    host: '10.0.0.32', deviceUser: 'admin', devicePassword: 'admin', devicePort: 80,
    webhookSecret: null, enabled: true,
  });
  // `released` is already taken further up by the manual-release checks.
  const releasedCam = db.getCamera(coerced.id);
  check('turning pass_only OFF releases barrier control back to the camera',
    releasedCam.accessMode === 'open' && releasedCam.barrierControl === 'camera',
    JSON.stringify({ a: releasedCam.accessMode, b: releasedCam.barrierControl }));
  check('…and the camera is then flagged as no risk',
    db.describeCameraRisk(releasedCam) === null, String(db.describeCameraRisk(releasedCam)));

  // ─── health check: the silent failure states ─────────────────────────────
  // These are invisible in the UI otherwise — the camera looks fine right up
  // until a car is sitting at a boom that will never lift.
  const noCreds = db.upsertCamera({
    name: 'RISKY', laneId: null, direction: 'entry',
    accessMode: 'open', barrierControl: 'app',
    host: '', deviceUser: null, devicePassword: null, devicePort: null,
    webhookSecret: null, enabled: true,
  });
  check('risk: app-owned barrier with no credentials is flagged',
    /will not open/i.test(db.describeCameraRisk(db.getCamera(noCreds.id)) ?? ''),
    String(db.describeCameraRisk(db.getCamera(noCreds.id))));
  check('risk: listCameras surfaces it on the row',
    !!db.listCameras().find((c) => c.id === noCreds.id)?.risk);
  check('risk: a properly configured app-owned camera is NOT flagged',
    db.describeCameraRisk(db.getCamera(acIn.id)) === null,
    String(db.describeCameraRisk(db.getCamera(acIn.id))));
  check('risk: an ordinary camera-owned camera is NOT flagged',
    db.describeCameraRisk(db.getCamera(cam.id)) === null);


  // ─── webhook direction coercion (2026-08-05) ─────────────────────────────
  // The HTTP ingest used to trust whatever `direction` a payload supplied:
  //   const direction = (extracted.direction ?? camera.direction)
  // and handlePlateEvent then mapped anything that wasn't 'exit' to 'entry'. So
  // a stale integration still POSTing the retired "dual" would have opened an
  // ENTRY session on an EXIT camera. resolveDirection() now falls back to the
  // camera's own configured direction instead.
  //
  // Driven over real HTTP because that is the only path the coercion sits on —
  // the lprEvents.emit() helper the checks above use bypasses it entirely.
  const webhook = require('../../dist/main/services/lpr-webhook');
  const PORT = 6099;
  webhook.startLprServer(PORT);

  const post = (body) => new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = require('node:http').request(
      { host: '127.0.0.1', port: PORT, path: '/lpr/event', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': payload.length } },
      (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve(JSON.parse(Buffer.concat(c).toString() || '{}'))); },
    );
    req.on('error', () => resolve({}));
    req.end(payload);
  });

  // Give the listener a moment to bind before the first request.
  await new Promise((r) => setTimeout(r, 250));

  const dualOnExit = await post({ cameraId: camExit.id, plate: 'COERCE01', direction: 'dual' });
  check('webhook: retired "dual" is coerced to the camera direction',
    dualOnExit.direction === 'exit', JSON.stringify(dualOnExit));
  check('webhook: …so no entry session is opened on an EXIT camera',
    !db.findOpenSessionByPlate('COERCE01'));

  // A junk direction must behave the same way — fall back, never pass through.
  const junk = await post({ cameraId: camExit.id, plate: 'COERCE02', direction: 'sideways' });
  check('webhook: an unrecognised direction falls back to the camera',
    junk.direction === 'exit', JSON.stringify(junk));

  // The legitimate override still works: a payload MAY say 'entry'/'exit'.
  const explicit = await post({ cameraId: cam.id, plate: 'COERCE03', direction: 'entry' });
  check('webhook: a valid explicit direction is still honoured',
    explicit.direction === 'entry' && db.findOpenSessionByPlate('COERCE03'), JSON.stringify(explicit));

  // No direction at all → the camera's own.
  const implied = await post({ cameraId: camExit.id, plate: 'COERCE04' });
  check('webhook: omitting direction uses the camera default',
    implied.direction === 'exit', JSON.stringify(implied));

  webhook.stopLprServer();

  // ─── cloud pull: what survives and what doesn't ──────────────────────────
  // NOTE: reconcileCamerasFromCloud([]) DELETES EVERY CAMERA, so this block runs
  // last — anything after it would be testing against an empty table.
  // reconcileCamerasFromCloud deletes local rows the cloud doesn't have and
  // re-inserts the ones it does. The cloud carries no access_mode /
  // barrier_control / credentials, so a re-inserted row used to come back on the
  // column defaults. With the device's own auto-open switched off, reverting to
  // barrier_control='camera' means NOTHING opens the barrier — a dead entrance,
  // with no error to explain it.
  const wlCam = db.upsertCamera({
    name: 'PULL-TEST', laneId: null, direction: 'entry',
    accessMode: 'pass_only', barrierControl: 'app',
    host: '10.0.0.40', deviceUser: 'admin', devicePassword: 's3cret', devicePort: 8080,
    webhookSecret: 'hook-1', enabled: true,
  });
  const wlExternal = db.getCamera(wlCam.id).externalId;

  // access_mode now travels WITH the cloud row (2026-08-06), so a pull applies
  // whatever the cloud says rather than leaving the local value alone.
  db.reconcileCamerasFromCloud([
    { externalId: wlExternal, name: 'PULL-TEST', direction: 'entry', accessMode: 'pass_only', host: '10.0.0.40', enabled: true, laneExternalId: null },
  ]);
  const afterUpdate = db.listCameras().find((c) => c.externalId === wlExternal);
  check('cloud pull: access mode is restored from the cloud row',
    afterUpdate?.accessMode === 'pass_only' && afterUpdate?.barrierControl === 'app',
    JSON.stringify({ a: afterUpdate?.accessMode, b: afterUpdate?.barrierControl }));
  check('cloud pull: LAN-only credentials survive the update path',
    afterUpdate?.deviceUser === 'admin' && afterUpdate?.devicePassword === 's3cret',
    JSON.stringify({ u: afterUpdate?.deviceUser }));

  // The cloud turning it OFF must turn it off locally too — otherwise the mirror
  // is one-way and a lane could never be un-restricted from the portal.
  db.reconcileCamerasFromCloud([
    { externalId: wlExternal, name: 'PULL-TEST', direction: 'entry', accessMode: 'open', host: '10.0.0.40', enabled: true, laneExternalId: null },
  ]);
  const afterOff = db.listCameras().find((c) => c.externalId === wlExternal);
  check('cloud pull: access mode OFF in the cloud clears it locally',
    afterOff?.accessMode === 'open' && afterOff?.barrierControl === 'camera',
    JSON.stringify({ a: afterOff?.accessMode, b: afterOff?.barrierControl }));

  // barrier_control is derived, never mirrored — a cloud row carries no such
  // field, so it must always follow the access mode it arrived with.
  db.reconcileCamerasFromCloud([
    { externalId: wlExternal, name: 'PULL-TEST', direction: 'entry', accessMode: 'pass_only', host: '10.0.0.40', enabled: true, laneExternalId: null },
  ]);
  check('cloud pull: barrier control is re-derived, not mirrored',
    db.listCameras().find((c) => c.externalId === wlExternal)?.barrierControl === 'app');

  // A camera the cloud does NOT list is DELETED — documented, destructive, and
  // it takes the local-only settings with it. Pin the honest behaviour: the row
  // is gone, not silently reverted in place.
  db.reconcileCamerasFromCloud([]);
  check('cloud pull: a camera absent from the cloud is deleted outright',
    !db.listCameras().some((c) => c.externalId === wlExternal));

  // …and if that external_id later returns, access_mode comes back FROM THE
  // CLOUD (that's what mirroring bought us) — but the LAN-only credentials do
  // not, because they never left this box. A pass-only camera therefore returns
  // restricted-but-unreachable, which describeCameraRisk() is there to flag
  // rather than let it fail silently at the barrier.
  db.reconcileCamerasFromCloud([
    { externalId: wlExternal, name: 'PULL-TEST', direction: 'entry', accessMode: 'pass_only', host: '10.0.0.40', enabled: true, laneExternalId: null },
  ]);
  const afterReinsert = db.listCameras().find((c) => c.externalId === wlExternal);
  check('cloud pull: a re-created camera gets its access mode back from the cloud',
    afterReinsert?.accessMode === 'pass_only' && afterReinsert?.barrierControl === 'app',
    JSON.stringify({ a: afterReinsert?.accessMode, b: afterReinsert?.barrierControl }));
  check('cloud pull: …but NOT the LAN-only credentials, and the risk is flagged',
    !afterReinsert?.deviceUser && !!afterReinsert?.risk,
    JSON.stringify({ u: afterReinsert?.deviceUser, risk: afterReinsert?.risk }));

  // A camera the cloud introduces that this box has never seen, with no
  // access_mode on the row (an older SaaS), must land on the SAFE default.
  db.reconcileCamerasFromCloud([
    { externalId: wlExternal, name: 'PULL-TEST', direction: 'entry', accessMode: 'pass_only', host: '10.0.0.40', enabled: true, laneExternalId: null },
    { externalId: 'legacy-cam', name: 'LEGACY', direction: 'exit', host: '10.0.0.41', enabled: true, laneExternalId: null },
  ]);
  const legacy = db.listCameras().find((c) => c.externalId === 'legacy-cam');
  check('cloud pull: a row with no access_mode defaults to open (fail-open)',
    legacy?.accessMode === 'open' && legacy?.barrierControl === 'camera',
    JSON.stringify({ a: legacy?.accessMode, b: legacy?.barrierControl }));

  out.ok = out.checks.every((c) => c.pass);
} catch (e) {
  out.error = e && e.stack ? e.stack : String(e);
}
})().finally(() => {
  fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2));
  app.exit(out.ok ? 0 : 1);
});
