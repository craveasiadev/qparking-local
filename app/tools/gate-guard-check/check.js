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
    tngEnabled: false,
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
  check('pass-only: …and the entry event fires, so the barrier opens',
    entries.some((e) => e.session?.plate === 'RES0001'));

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
  check('exit with a pass: session closed', !isInside('RES0001'));
  check('exit with a pass: free, credited to the pass, no terminal involved',
    completed.some((c) => c.passId === 'p-res' && c.outcome === 'free')
    && !warned.some((w) => w.kind === 'exit-no-terminal' && w.plate === 'RES0001'));

  // 6. Exit with NO pass, on a pass-only camera. Since 2026-08-07 the exit flow
  //    ignores accessMode entirely: everyone may leave, pass holders free and
  //    everyone else priced. So this is NOT refused — it is charged like any
  //    transient. (It used to be held at the barrier, which stranded a tailgater
  //    AND a resident whose pass lapsed mid-stay.)
  //    This lane has no terminal wired, so a non-zero fee reports exit-no-terminal;
  //    what matters here is that the pass check, not the camera mode, decided it.
  const ghost = db.createEntrySession('GHOST01', poLane.id, poIn.id, null);
  readOn(poOut.id, 'GHOST01', 'exit');
  await new Promise((r) => setTimeout(r, 30));
  check('exit without a pass: NOT refused for lacking a pass',
    !warned.some((w) => w.kind === 'exit-not-authorised' && w.plate === 'GHOST01'));
  check('exit without a pass: priced as a transient, never credited to a pass',
    !completed.some((c) => c.sessionId === ghost.id && c.passId));

  // 7. Pass holder whose entry was never recorded still gets out (misread /
  //    entry camera down), and it's flagged so a failing camera surfaces.
  readOn(poOut.id, 'RES0001', 'exit');
  await new Promise((r) => setTimeout(r, 30));
  check('exit with a pass: pass holder with no open session is released',
    warned.some((w) => w.kind === 'exit-pass-holder-no-entry' && w.plate === 'RES0001'));

  // 8. Regression: an 'open' camera admits everyone with no pass, and the entry
  //    event fires — which is what makes the barrier open (index.ts pulses on
  //    every 'entry' event; there is no per-camera opt-out any more).
  readOn(cam.id, 'ORDINARY1', 'entry');
  check('open camera: unregistered plate still admitted (flow unchanged)', isInside('ORDINARY1'));
  check('open camera: the entry event fires, so the barrier opens',
    entries.some((e) => e.session?.plate === 'ORDINARY1'));

  // ─── the app always opens the barrier ────────────────────────────────────
  // barrierControl was removed 2026-08-07. Authorisation is now expressed purely
  // by WHICH event fires: 'entry' / 'exit-completed' mean the boom rises, a
  // 'warning' means it stays down. These checks pin that there is no second
  // opinion left to consult — no payload flag, no camera setting.
  const acLane = db.upsertLane({ name: 'L-APPCTRL', policyId: null, terminalId: null, gateRelayAddress: null, enabled: true });
  const acIn = db.upsertCamera({
    name: 'AC-IN', laneId: acLane.id, direction: 'entry',
    accessMode: 'open',
    host: '10.0.0.30', deviceUser: 'admin', devicePassword: 'admin', devicePort: 80,
    webhookSecret: null, enabled: true,
  });
  const acOut = db.upsertCamera({
    name: 'AC-OUT', laneId: acLane.id, direction: 'exit',
    accessMode: 'open',
    host: '10.0.0.31', deviceUser: 'admin', devicePassword: 'admin', devicePort: 80,
    webhookSecret: null, enabled: true,
  });

  readOn(acIn.id, 'ANYCAR01', 'entry');
  check('open access: any plate admitted', isInside('ANYCAR01'));
  check('open access: entry event carries no barrier-ownership flag',
    entries.some((e) => e.session?.plate === 'ANYCAR01' && e.barrier === undefined));

  readOn(acOut.id, 'ANYCAR01', 'exit');
  await new Promise((r) => setTimeout(r, 30));
  check('exit: session closed', !isInside('ANYCAR01'));
  check('exit: completion event fires with the exit camera id (the relay to pulse)',
    completed.some((c) => c.cameraId === acOut.id && c.barrier === undefined));

  // The blacklist is genuinely enforceable now the app owns every barrier.
  db.replaceAllBlockedPlates([{ plateNumber: 'BANNED99', vehicleId: 'v-9', reason: 'unpaid', fetchedAt: nowIso }]);
  readOn(acIn.id, 'BANNED99', 'entry');
  check('blacklisted plate creates no session and no pulse',
    !isInside('BANNED99') && !entries.some((e) => e.session?.plate === 'BANNED99'));
  db.replaceAllBlockedPlates([]);

  // ─── the simulator must route through the RIGHT camera ───────────────────
  // Root cause of "the exit didn't calculate a price, it just showed free":
  // simulateExitAt picked `listCameras().find(laneId && enabled)` — ANY camera
  // on the lane, which on a lane with both an entry and an exit camera is the
  // ENTRY one (lower id). Every access decision keys off event.cameraId, so the
  // exit was then judged by the ENTRY camera's settings: with Only Pass Allow
  // set there, a pass holder took the old pass-only exit branch and left free
  // with no fee computed at all.
  //
  // acLane has AC-IN (entry) and AC-OUT (exit), so it reproduces the shape.
  const simIn = await flow.simulateEntryAt(acLane.id, 'ROUTE001', nowIso);
  check('simulateEntryAt routes through the ENTRY-facing camera',
    simIn.ok && simIn.cameraId === acIn.id, JSON.stringify(simIn));
  const simOut = await flow.simulateExitAt(acLane.id, 'ROUTE001', new Date().toISOString());
  await new Promise((r) => setTimeout(r, 30));
  check('simulateExitAt routes through the EXIT-facing camera, not just "any camera"',
    simOut.ok && simOut.cameraId === acOut.id, JSON.stringify(simOut));
  check('…so the exit is recorded against the exit camera',
    completed.some((c) => c.cameraId === acOut.id));

  // ─── health check: the silent failure states ─────────────────────────────
  // These are invisible in the UI otherwise — the camera looks fine right up
  // until a car is sitting at a boom that will never lift.
  const noCreds = db.upsertCamera({
    name: 'RISKY', laneId: null, direction: 'entry',
    accessMode: 'open',
    host: '', deviceUser: null, devicePassword: null, devicePort: null,
    webhookSecret: null, enabled: true,
  });
  check('risk: a camera with no credentials is flagged',
    /will not open/i.test(db.describeCameraRisk(db.getCamera(noCreds.id)) ?? ''),
    String(db.describeCameraRisk(db.getCamera(noCreds.id))));
  check('risk: listCameras surfaces it on the row',
    !!db.listCameras().find((c) => c.id === noCreds.id)?.risk);
  check('risk: a properly configured camera is NOT flagged',
    db.describeCameraRisk(db.getCamera(acIn.id)) === null,
    String(db.describeCameraRisk(db.getCamera(acIn.id))));
  // Every camera needs credentials now — this app opens every barrier, so the
  // same missing password that used to be harmless is the reason the boom never
  // moves. Flagging it is the point: silence here is what "the trigger doesn't
  // work" actually looked like.
  check('risk: the default fixture camera (no password) IS flagged',
    /will not open/i.test(db.describeCameraRisk(db.getCamera(cam.id)) ?? ''),
    String(db.describeCameraRisk(db.getCamera(cam.id))));


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
  // The listen port belongs to the CAMERA now (2026-08-11), so the harness gets
  // its private port by putting the fixtures on it: startLprServers() binds
  // whatever set the cameras ask for. It also always binds 6001; a failed bind
  // there (a real install running on this machine) is reported and survived, so
  // it can't fail the run.
  const PORT = 6099;
  const ALT_PORT = 6098;
  for (const existing of db.listCameras()) db.upsertCamera({ ...existing, webhookPort: PORT });
  const boundPorts = webhook.startLprServers();
  check('webhook: the port the cameras ask for is the port that gets bound',
    boundPorts.includes(PORT), JSON.stringify(boundPorts));

  const postToPort = (port, path, body) => new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = require('node:http').request(
      { host: '127.0.0.1', port, path, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': payload.length } },
      (res) => {
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () => {
          const raw = Buffer.concat(c).toString() || '{}';
          let parsed = {};
          try { parsed = JSON.parse(raw); } catch { parsed = { raw }; }
          resolve({ ...parsed, statusCode: res.statusCode });
        });
      },
    );
    req.on('error', (e) => resolve({ error: e.code ?? String(e) }));
    req.end(payload);
  });
  const postTo = (path, body) => postToPort(PORT, path, body);
  const post = (body) => postTo('/lpr/event', body);

  // Give the listener a moment to bind before the first request.
  await new Promise((r) => setTimeout(r, 250));

  // …and only now is the bind result knowable: startLprServers() returns the set
  // it is holding, which is one tick optimistic (listen() is async), so a port
  // that lost its bind is still in that array. This is the honest check.
  check('webhook: the port is still held once the bind has resolved',
    webhook.activeLprPorts().includes(PORT), JSON.stringify(webhook.activeLprPorts()));

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

  // ─── the vendor's own push path (2026-08-07) ─────────────────────────────
  // Hangzhou-family firmware posts to /devicemanagement/php/quickplateresult.php
  // by default, and some builds have no field to change it. We used to 404 every
  // one of those, telling the operator to "point the camera at POST /lpr/event"
  // — advice that cannot be followed on firmware with no such setting.
  const vendorPath = await postTo('/devicemanagement/php/quickplateresult.php',
    { cameraId: camExit.id, plate: 'VENDOR01' });
  check('webhook: the vendor default push path is accepted, not 404d',
    vendorPath.ok === true && vendorPath.direction === 'exit', JSON.stringify(vendorPath));

  // …but an unrelated path is still refused, so this widened the door, not the trust.
  const notAPlatePath = await postTo('/admin/whatever', { cameraId: camExit.id, plate: 'VENDOR02' });
  check('webhook: an unrelated path is still rejected',
    notAPlatePath.statusCode === 404, JSON.stringify(notAPlatePath));

  // ─── the same read arriving twice (2026-08-07) ───────────────────────────
  // Accepting the vendor's default push path as well as /lpr/event means a
  // camera that posts to BOTH turns one car into two identical events, seconds
  // apart. Collapsed at the door so the flow's own guards stay reserved for real
  // second passes.
  const dedupeCam = db.upsertCamera({
    name: 'DEDUPE-CAM', laneId: null, direction: 'entry',
    accessMode: 'open', host: '10.0.0.88',
    deviceUser: 'admin', devicePassword: 'admin', devicePort: 80,
    webhookSecret: null, enabled: true,
  });
  const firstPost = await postTo('/lpr/event', { cameraId: dedupeCam.id, plate: 'TWICE001' });
  const secondPost = await postTo('/devicemanagement/php/quickplateresult.php',
    { cameraId: dedupeCam.id, plate: 'TWICE001' });
  check('webhook: the first of two identical reads is processed',
    firstPost.ok === true && !firstPost.ignored, JSON.stringify(firstPost));
  check('webhook: the second, on the OTHER path, is collapsed as a duplicate',
    secondPost.ok === true && secondPost.ignored === 'duplicate_read', JSON.stringify(secondPost));
  check('webhook: …and it opened exactly ONE session, not two',
    db.listOpenSessions().filter((s) => s.plate === 'TWICE001').length === 1);
  // A DIFFERENT plate on the same camera is never a duplicate.
  const otherPlate = await postTo('/lpr/event', { cameraId: dedupeCam.id, plate: 'TWICE002' });
  check('webhook: a different plate on the same camera still gets through',
    otherPlate.ok === true && !otherPlate.ignored, JSON.stringify(otherPlate));
  db.deleteCamera(dedupeCam.id);

  // ─── two rows, one physical camera: ENABLED wins (2026-08-07) ────────────
  // A camera set up twice at the same IP — a first attempt left switched off,
  // then a working row — used to resolve to whichever had the LOWER id. When
  // that was the disabled leftover, every read from the live camera was
  // discarded as 'camera_disabled', naming the wrong camera as the reason.
  const SHARED_IP = '10.0.0.77';
  const staleRow = db.upsertCamera({
    name: 'STALE-DUPLICATE', laneId: acLane.id, direction: 'entry',
    accessMode: 'open', host: SHARED_IP,
    deviceUser: 'admin', devicePassword: 'admin', devicePort: 80,
    webhookSecret: null, enabled: false,          // ← switched off, lower id
  });
  const liveRow = db.upsertCamera({
    name: 'LIVE-DUPLICATE', laneId: acLane.id, direction: 'exit',
    accessMode: 'open', host: SHARED_IP,
    deviceUser: 'admin', devicePassword: 'admin', devicePort: 80,
    webhookSecret: null, enabled: true,           // ← the one actually wired up
  });
  check('precondition: the disabled duplicate really does sort first',
    staleRow.id < liveRow.id);
  const dupe = await postTo('/lpr/event', {
    AlarmInfoPlate: { ipaddr: SHARED_IP, result: { PlateResult: { license: 'DUPE0001' } } },
  });
  check('webhook: an enabled camera wins over a disabled one at the same IP',
    dupe.cameraId === liveRow.id, JSON.stringify(dupe));
  check('webhook: …so the read is routed by the LIVE row\'s direction (exit)',
    dupe.direction === 'exit', JSON.stringify(dupe));
  db.deleteCamera(staleRow.id);
  db.deleteCamera(liveRow.id);

  // ─── one listener per camera port (2026-08-11) ────────────────────────────
  // The port was ONE box-wide value until cameras turned out to differ in what
  // their firmware will let you set. Two cameras on two ports must both be able
  // to push — and the port must be released when no camera wants it, or a box
  // would accumulate open listeners for every port ever typed.
  const altCam = db.upsertCamera({
    name: 'ALT-PORT-CAM', laneId: null, direction: 'exit',
    accessMode: 'open', host: '10.0.0.99',
    deviceUser: 'admin', devicePassword: 'admin', devicePort: 80,
    webhookPort: ALT_PORT, webhookSecret: null, enabled: true,
  });
  check('webhook: a camera saved with its own port persists it',
    db.getCamera(altCam.id).webhookPort === ALT_PORT, String(db.getCamera(altCam.id).webhookPort));
  const withAlt = webhook.startLprServers();
  check('webhook: rebinding adds the new port and KEEPS the existing one',
    withAlt.includes(ALT_PORT) && withAlt.includes(PORT), JSON.stringify(withAlt));
  await new Promise((r) => setTimeout(r, 250));
  const onAlt = await postToPort(ALT_PORT, '/lpr/event', { cameraId: altCam.id, plate: 'ALTPORT01' });
  check('webhook: a read pushed to the second port is accepted',
    onAlt.ok === true && onAlt.direction === 'exit', JSON.stringify(onAlt));
  // The first port must be untouched by the rebind — rebinding a live listener
  // would drop the /live video streams it carries and risk EADDRINUSE against
  // its own closing socket.
  const stillOnFirst = await postToPort(PORT, '/lpr/event', { cameraId: camExit.id, plate: 'ALTPORT02' });
  check('webhook: …and the first port still works after the rebind',
    stillOnFirst.ok === true, JSON.stringify(stillOnFirst));
  db.deleteCamera(altCam.id);
  const afterDelete = webhook.startLprServers();
  check('webhook: deleting the camera releases its port',
    !afterDelete.includes(ALT_PORT) && afterDelete.includes(PORT), JSON.stringify(afterDelete));
  const refused = await postToPort(ALT_PORT, '/lpr/event', { cameraId: camExit.id, plate: 'ALTPORT03' });
  check('webhook: …so nothing answers on it any more',
    !!refused.error, JSON.stringify(refused));

  webhook.stopLprServers();

  // ─── cloud pull: what survives and what doesn't ──────────────────────────
  // NOTE: reconcileCamerasFromCloud([]) DELETES EVERY CAMERA, so this block runs
  // last — anything after it would be testing against an empty table.
  // reconcileCamerasFromCloud deletes local rows the cloud doesn't have and
  // re-inserts the ones it does. Since 2026-08-12 the cloud also carries the LAN
  // wiring — SDK login + port, webhook port + secret — so a re-inserted camera
  // comes back USABLE. Before that it came back credential-less, which made it a
  // dead entrance: sessions recorded, boom never moved.
  //
  // The other half of that contract is pinned here too: a null from the cloud
  // means "nothing to say", never "clear it". An older SaaS that stores none of
  // these fields must not wipe a working camera on the first pull.
  const wlCam = db.upsertCamera({
    name: 'PULL-TEST', laneId: null, direction: 'entry',
    accessMode: 'pass_only',
    host: '10.0.0.40', deviceUser: 'admin', devicePassword: 's3cret', devicePort: 8080,
    // A NON-default webhook port on purpose: 6001 would pass the "left alone"
    // check below even if the pull had overwritten it with the column default.
    webhookPort: 6007, webhookSecret: 'hook-1', enabled: true,
  });
  const wlExternal = db.getCamera(wlCam.id).externalId;

  // access_mode now travels WITH the cloud row (2026-08-06), so a pull applies
  // whatever the cloud says rather than leaving the local value alone.
  db.reconcileCamerasFromCloud([
    { externalId: wlExternal, name: 'PULL-TEST', direction: 'entry', accessMode: 'pass_only', host: '10.0.0.40', enabled: true, laneExternalId: null },
  ]);
  const afterUpdate = db.listCameras().find((c) => c.externalId === wlExternal);
  check('cloud pull: access mode is restored from the cloud row',
    afterUpdate?.accessMode === 'pass_only',
    JSON.stringify({ a: afterUpdate?.accessMode }));
  check('cloud pull: credentials the cloud omits are LEFT ALONE, not wiped',
    afterUpdate?.deviceUser === 'admin' && afterUpdate?.devicePassword === 's3cret'
      && afterUpdate?.devicePort === 8080 && afterUpdate?.webhookSecret === 'hook-1'
      && afterUpdate?.webhookPort === 6007,
    JSON.stringify({ u: afterUpdate?.deviceUser, dp: afterUpdate?.devicePort, wp: afterUpdate?.webhookPort, ws: afterUpdate?.webhookSecret }));

  // …and when the cloud DOES carry them, they win — that is what makes a pull
  // enough to set a box up.
  db.reconcileCamerasFromCloud([
    {
      externalId: wlExternal, name: 'PULL-TEST', direction: 'entry', accessMode: 'pass_only',
      host: '10.0.0.40', enabled: true, laneExternalId: null,
      deviceUser: 'operator', devicePassword: 'rotated', devicePort: 8081,
      webhookPort: 6009, webhookSecret: 'hook-2',
    },
  ]);
  const afterMirror = db.listCameras().find((c) => c.externalId === wlExternal);
  check('cloud pull: credentials the cloud DOES carry are applied',
    afterMirror?.deviceUser === 'operator' && afterMirror?.devicePassword === 'rotated'
      && afterMirror?.devicePort === 8081 && afterMirror?.webhookPort === 6009
      && afterMirror?.webhookSecret === 'hook-2',
    JSON.stringify({ u: afterMirror?.deviceUser, dp: afterMirror?.devicePort, wp: afterMirror?.webhookPort, ws: afterMirror?.webhookSecret }));

  // The cloud turning it OFF must turn it off locally too — otherwise the mirror
  // is one-way and a lane could never be un-restricted from the portal.
  db.reconcileCamerasFromCloud([
    { externalId: wlExternal, name: 'PULL-TEST', direction: 'entry', accessMode: 'open', host: '10.0.0.40', enabled: true, laneExternalId: null },
  ]);
  const afterOff = db.listCameras().find((c) => c.externalId === wlExternal);
  check('cloud pull: access mode OFF in the cloud clears it locally',
    afterOff?.accessMode === 'open',
    JSON.stringify({ a: afterOff?.accessMode }));

  // A camera the cloud does NOT list is DELETED — documented, destructive, and
  // it takes the local-only settings with it. Pin the honest behaviour: the row
  // is gone, not silently reverted in place.
  db.reconcileCamerasFromCloud([]);
  check('cloud pull: a camera absent from the cloud is deleted outright',
    !db.listCameras().some((c) => c.externalId === wlExternal));

  // …and when that external_id returns carrying its wiring, the camera comes
  // back READY: access_mode, credentials, ports and secret all restored, and no
  // risk flag, because there is nothing left to type in. This is the case that
  // makes "reinstall the box, pull from cloud" a complete recovery.
  db.reconcileCamerasFromCloud([
    {
      externalId: wlExternal, name: 'PULL-TEST', direction: 'entry', accessMode: 'pass_only',
      host: '10.0.0.40', enabled: true, laneExternalId: null,
      deviceUser: 'admin', devicePassword: 's3cret', devicePort: 8080,
      webhookPort: 6007, webhookSecret: 'hook-1',
    },
  ]);
  const afterReinsert = db.listCameras().find((c) => c.externalId === wlExternal);
  check('cloud pull: a re-created camera gets its access mode back from the cloud',
    afterReinsert?.accessMode === 'pass_only',
    JSON.stringify({ a: afterReinsert?.accessMode }));
  check('cloud pull: …and its credentials, ports and secret, with no risk left to flag',
    afterReinsert?.deviceUser === 'admin' && afterReinsert?.devicePassword === 's3cret'
      && afterReinsert?.devicePort === 8080 && afterReinsert?.webhookPort === 6007
      && afterReinsert?.webhookSecret === 'hook-1' && !afterReinsert?.risk,
    JSON.stringify({ u: afterReinsert?.deviceUser, wp: afterReinsert?.webhookPort, risk: afterReinsert?.risk }));

  // A camera re-created by an OLDER SaaS that carries no wiring is still the
  // dead-entrance case, and the risk flag is the only thing that surfaces it.
  db.reconcileCamerasFromCloud([]);
  db.reconcileCamerasFromCloud([
    { externalId: wlExternal, name: 'PULL-TEST', direction: 'entry', accessMode: 'pass_only', host: '10.0.0.40', enabled: true, laneExternalId: null },
  ]);
  const bareReinsert = db.listCameras().find((c) => c.externalId === wlExternal);
  check('cloud pull: a re-created camera with NO cloud wiring is flagged as unusable',
    !bareReinsert?.deviceUser && !!bareReinsert?.risk,
    JSON.stringify({ u: bareReinsert?.deviceUser, risk: bareReinsert?.risk }));
  check('cloud pull: …and lands on the default webhook port rather than 0',
    bareReinsert?.webhookPort === 6001, String(bareReinsert?.webhookPort));

  // A camera the cloud introduces that this box has never seen, with no
  // access_mode on the row (an older SaaS), must land on the SAFE default.
  db.reconcileCamerasFromCloud([
    { externalId: wlExternal, name: 'PULL-TEST', direction: 'entry', accessMode: 'pass_only', host: '10.0.0.40', enabled: true, laneExternalId: null },
    { externalId: 'legacy-cam', name: 'LEGACY', direction: 'exit', host: '10.0.0.41', enabled: true, laneExternalId: null },
  ]);
  const legacy = db.listCameras().find((c) => c.externalId === 'legacy-cam');
  check('cloud pull: a row with no access_mode defaults to open (fail-open)',
    legacy?.accessMode === 'open',
    JSON.stringify({ a: legacy?.accessMode }));

  out.ok = out.checks.every((c) => c.pass);
} catch (e) {
  out.error = e && e.stack ? e.stack : String(e);
}
})().finally(() => {
  fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2));
  app.exit(out.ok ? 0 : 1);
});
