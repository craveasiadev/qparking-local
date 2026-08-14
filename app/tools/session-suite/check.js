/**
 * Full session-lifecycle + season-pass harness.
 *
 * Drives the REAL code paths — lprEvents → handlePlateEvent → handleEntry /
 * handleExit → recordExit / startTngExitCharge — for every state a parking
 * session can reach, and for every pass type qparking SaaS can issue
 * (App\Enum\SeasonPass\PassType: monthly, quarterly, yearly, staff, corporate,
 * free_access, vip, temporary, resident) plus every pass validity edge the
 * cached roster can present.
 *
 * The only stubs are the three payment-device seams — payResultListenerReady,
 * payRequest, payCancel — so a paid exit can be approved / declined / timed out
 * on demand without an Alarmtech W4G on the LAN. Everything else (fee math,
 * pass lookup, session rows, transaction ledger, auto-retrigger timers) is the
 * shipped implementation.
 *
 * Launched by run.mjs; see the README.
 */
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Pin the site timezone exactly like src/main/tz.ts does in the real app — pass
// validity days and the pass-lapse billing boundary are site-local midnights.
process.env.TZ = 'Asia/Kuala_Lumpur';

const out = { ok: false, checks: [], error: null };
let GROUP = '';
const G = (g) => { GROUP = g; };
const check = (name, pass, detail = null) => out.checks.push({
  group: GROUP, name, pass: !!pass,
  detail: detail == null ? null : String(detail),
});

const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

main().then(
  () => { fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2)); app.exit(out.ok ? 0 : 1); },
  (e) => {
    out.error = e && e.stack ? e.stack : String(e);
    fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2));
    app.exit(1);
  },
);

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-session-suite-'));
  app.setPath('userData', tmpDir);

  const db = require('../../dist/main/services/db');
  const tng = require('../../dist/main/services/payment-tng');
  const flow = require('../../dist/main/services/parking-flow');
  const { lprEvents } = require('../../dist/main/services/lpr-webhook');

  // ─── payment-device seam ────────────────────────────────────────────────
  // tsc emits cross-module calls as `payment_tng_1.payRequest(...)`, so
  // replacing the exported properties is enough to intercept them.
  let listenerReady = { ok: true };
  let payScript = () => null; // default: no response (device timeout)
  const payCalls = [];
  const payCancels = [];
  tng.payResultListenerReady = () => listenerReady;
  tng.payRequest = async (req) => {
    payCalls.push(req);
    const body = await payScript(req, payCalls.length);
    if (!body) throw new Error('simulated device timeout');
    return body;
  };
  tng.payCancel = async (orderId, opts) => { payCancels.push({ orderId, ...opts }); return true; };

  const APPROVE = (over = {}) => async () => ({
    state: '0', orderId: 'x', payType: 1, cardNo: '424242******4242',
    balance: 0, payTime: Math.floor(Date.parse('2026-08-10T06:00:00Z') / 1000),
    stan: '000123', apprCode: 'APPR01', ...over,
  });
  const DECLINE = () => async () => ({
    state: '1', orderId: 'x', payType: 1, cardNo: '400000******0002',
    balance: 0, payTime: 0, stan: '000124', apprCode: '', ...{},
  });
  const TIMEOUT = () => async () => null;
  const HANG = () => () => new Promise(() => {});

  // ─── site fixtures ──────────────────────────────────────────────────────
  db.saveSettings({
    qparkingBaseUrl: '', qparkingApiKey: '',       // keep the cloud queue inert
    tngEnabled: true,
    exitGracePeriodSeconds: 90,
    minimumChargeCents: 0,
    tngAutoRetrigger: false,
  });

  const nowIso = new Date().toISOString();
  const policy = (policyId, over = {}) => db.upsertRatePolicy({
    policyId, policyName: policyId, freeMinutes: 0,
    firstBlockCents: 500, perBlockCents: 300, blockMinutes: 60, dailyCapCents: 0,
    currency: 'MYR', fetchedAt: nowIso, rules: [],
    policyDescription: null, graceExceededBehavior: 'charge_from_entry',
    cutoffEnabled: false, cutoffTime: null, cutoffBehavior: null,
    newDayFixedFeeCents: null, rateBasis: 'occupancy', flatMultiRate: 'sum',
    firstBlockOncePerEntry: false, policyDailyCapCents: null, isSiteDefault: false,
    ...over,
  });
  // RM5 first hour + RM3/hour after. A 4h stay = RM14.
  policy('charge');
  // Everything free by rate.
  policy('zero', { firstBlockCents: 0, perBlockCents: 0 });
  // 24h grace — every test stay lands inside it.
  policy('grace', { freeMinutes: 1440 });

  const terminal = db.upsertTerminal({ name: 'W4G-1', host: '10.0.0.50', port: 80, timeoutSeconds: 30, enabled: true });
  const terminalOff = db.upsertTerminal({ name: 'W4G-off', host: '10.0.0.51', port: 80, timeoutSeconds: 30, enabled: false });

  const lane = (name, policyId, terminalId) => db.upsertLane({
    name, policyId, terminalId, enabled: true,
  });
  const L = {
    paid: lane('L-PAID', 'charge', terminal.id),          // charges, device wired
    noTerm: lane('L-NOTERM', 'charge', null),             // charges, no device
    devOff: lane('L-DEVOFF', 'charge', terminalOff.id),   // charges, device disabled
    grace: lane('L-GRACE', 'grace', terminal.id),         // 24h free
    zero: lane('L-ZERO', 'zero', terminal.id),            // rate is RM 0
    none: lane('L-NONE', null, null),                     // no plan at all
    dual: lane('L-DUAL', 'zero', terminal.id),            // shared barrier: entry + exit cams
    noCam: lane('L-NOCAM', 'charge', terminal.id),        // device but no camera
  };

  const cam = (name, laneId, direction, host) => db.upsertCamera({
    name, laneId, direction, host,
    deviceUser: null, devicePassword: null, devicePort: null, webhookSecret: null, enabled: true,
  });
  const C = {
    paidIn: cam('C-PAID-IN', L.paid.id, 'entry', '10.1.0.1'),
    paidOut: cam('C-PAID-OUT', L.paid.id, 'exit', '10.1.0.2'),
    noTermIn: cam('C-NT-IN', L.noTerm.id, 'entry', '10.1.0.3'),
    noTermOut: cam('C-NT-OUT', L.noTerm.id, 'exit', '10.1.0.4'),
    devOffOut: cam('C-DO-OUT', L.devOff.id, 'exit', '10.1.0.5'),
    graceOut: cam('C-GR-OUT', L.grace.id, 'exit', '10.1.0.6'),
    zeroIn: cam('C-ZR-IN', L.zero.id, 'entry', '10.1.0.7'),
    zeroOut: cam('C-ZR-OUT', L.zero.id, 'exit', '10.1.0.8'),
    noneIn: cam('C-NONE-IN', L.none.id, 'entry', '10.1.0.9'),
    noneOut: cam('C-NONE-OUT', L.none.id, 'exit', '10.1.0.10'),
    // A shared in/out barrier is TWO cameras on one lane — the camera direction
    // 'dual' was retired 2026-08-05 (a camera faces one way; a departing car is
    // only in frame after it has passed the barrier). This pair is what makes
    // the lane derive as 'dual', which is the surviving meaning of the word.
    dualIn: cam('C-DUAL-IN', L.dual.id, 'entry', '10.1.0.11'),
    dualOut: cam('C-DUAL-OUT', L.dual.id, 'exit', '10.1.0.14'),
    orphan: cam('C-ORPHAN', null, 'entry', '10.1.0.12'),   // camera on no lane
    orphanOut: cam('C-ORPHAN-OUT', null, 'exit', '10.1.0.13'),
  };

  flow.startParkingFlow();

  // ─── event bus capture ──────────────────────────────────────────────────
  const ev = {
    entry: [], rescan: [], ignoredExit: [],
    pending: [], completed: [], declined: [], warning: [],
  };
  flow.parkingEvents.on('entry', (p) => ev.entry.push(p));
  flow.parkingEvents.on('rescan-ignored', (p) => ev.rescan.push(p));
  flow.parkingEvents.on('entry-ignored-recent-exit', (p) => ev.ignoredExit.push(p));
  flow.parkingEvents.on('exit-pending', (p) => ev.pending.push(p));
  flow.parkingEvents.on('exit-completed', (p) => ev.completed.push(p));
  flow.parkingEvents.on('exit-declined', (p) => ev.declined.push(p));
  flow.parkingEvents.on('warning', (p) => ev.warning.push(p));

  const warnedFor = (kind, plate) => ev.warning.some((w) => w.kind === kind && w.plate === plate);
  const warnedSession = (kind, sessionId) => ev.warning.some((w) => w.kind === kind && w.sessionId === sessionId);
  const completedFor = (sessionId) => ev.completed.find((c) => c.sessionId === sessionId);
  const pendingFor = (plate) => ev.pending.filter((p) => p.session.plate === plate).pop();
  const inside = (plate) => !!db.findOpenSessionByPlate(plate);
  const openCount = (plate) => db.listOpenSessions().filter((s) => s.plate === plate).length;

  /** Fire a plate read exactly as the LPR webhook does. */
  function read(cameraId, plate, direction, at) {
    lprEvents.emit('plate', {
      cameraId, plate, confidence: 1, imagePath: null,
      timestamp: at ?? new Date().toISOString(), direction,
      ...(at ? { exitAtOverride: at } : {}),
    });
  }
  /** Open a session directly, optionally back-stamped to a chosen entry instant. */
  function open(plate, laneId, cameraId, entryIso) {
    const s = db.createEntrySession(plate, laneId ?? null, cameraId ?? null, null);
    if (entryIso) db.updateSessionFields(s.id, { entryAt: entryIso });
    return db.getSessionById(s.id);
  }
  /** Open a session then drive a timed exit read through the real flow. */
  async function drive(plate, entryIso, exitIso, laneId, entryCam, exitCam) {
    const s = open(plate, laneId, entryCam, entryIso);
    read(exitCam, plate, 'exit', exitIso);
    await tick();
    return s;
  }
  /** Seed an already-closed session that exited `secondsAgo`. */
  function seedClosed(plate, secondsAgo) {
    const s = db.createEntrySession(plate, L.zero.id, C.zeroIn.id, null);
    db.recordExit(s.id, {
      exitAt: new Date(Date.now() - secondsAgo * 1000).toISOString(),
      exitLaneId: L.zero.id, exitCameraId: C.zeroOut.id, exitImagePath: null,
      durationMinutes: 30, feeCents: 0, paymentStatus: 'free', terminalTxnId: null,
      freeReason: 'rate-zero',
    });
    return s.id;
  }

  // The canonical stay used by every pass test: 10:00 → 14:00 MYT on 10 Aug
  // 2026 (240 min). Under the 'charge' plan that is RM5 + 3×RM3 = RM14, so a
  // free exit can only come from a pass.
  const ENTRY = '2026-08-10T02:00:00.000Z';
  const EXIT = '2026-08-10T06:00:00.000Z';
  const FULL_FEE = 1400;
  // A retrigger has no exitAtOverride — it prices against the wall clock — so
  // its fixtures must be back-stamped relative to NOW, not to the fixed pass
  // window above (which may sit in the future or the past of the test machine).
  const AGO = (mins) => new Date(Date.now() - mins * 60_000).toISOString();
  const RETRIGGER_ENTRY = AGO(180);   // 3h → RM5 + 2×RM3 = RM11 under 'charge'
  const RETRIGGER_FEE = 1100;

  // ══════════════════════════════════════════════════════════════════════
  G('A · entry');
  // ══════════════════════════════════════════════════════════════════════
  read(C.zeroIn.id, 'AAA0001', 'entry');
  check('A1 first-time plate opens a session', inside('AAA0001'));
  check('A1b …and emits an entry event with status "entered"',
    ev.entry.some((e) => e.session.plate === 'AAA0001' && e.session.status === 'entered'));

  read(C.zeroIn.id, 'AAA0001', 'entry');
  check('A2 rescan while inside → rescan-ignored', ev.rescan.some((r) => r.plate === 'AAA0001'));
  check('A2b …and does not open a second session', openCount('AAA0001') === 1, openCount('AAA0001'));

  seedClosed('AAA0002', 5);
  read(C.zeroIn.id, 'AAA0002', 'entry');
  check('A3 duplicate read 5s after exit opens nothing (grace guard)', !inside('AAA0002'));
  check('A3b …and reports entry-ignored-recent-exit', ev.ignoredExit.some((p) => p.plate === 'AAA0002'));

  seedClosed('AAA0003', 300);
  read(C.zeroIn.id, 'AAA0003', 'entry');
  check('A4 genuine re-entry past the grace window is admitted', inside('AAA0003'));

  db.saveSettings({ exitGracePeriodSeconds: 0 });
  seedClosed('AAA0004', 2);
  read(C.zeroIn.id, 'AAA0004', 'entry');
  check('A5 exitGracePeriodSeconds=0 disables the guard', inside('AAA0004'));
  db.saveSettings({ exitGracePeriodSeconds: 90 });

  const fut = db.createEntrySession('AAA0005', L.zero.id, C.zeroIn.id, null);
  db.recordExit(fut.id, {
    exitAt: new Date(Date.now() + 3600_000).toISOString(),
    exitLaneId: L.zero.id, exitCameraId: C.zeroOut.id, exitImagePath: null,
    durationMinutes: 1, feeCents: 0, paymentStatus: 'free', terminalTxnId: null,
  });
  read(C.zeroIn.id, 'AAA0005', 'entry');
  check('A6 future-dated exit_at does not swallow entries forever', inside('AAA0005'));

  db.replaceAllBlockedPlates([{ plateNumber: 'BAN0001', vehicleId: 'v-ban-1', reason: 'unpaid fines', fetchedAt: nowIso }]);
  read(C.zeroIn.id, 'BAN0001', 'entry');
  check('A7 blacklisted plate creates NO session', !inside('BAN0001') && db.listOpenSessions().every((s) => s.plate !== 'BAN0001'));
  check('A7b …and reports entry-blacklisted with the reason',
    ev.warning.some((w) => w.kind === 'entry-blacklisted' && w.plate === 'BAN0001' && w.reason === 'unpaid fines'));

  // A8/A9 used to drive a single 'dual' camera. That direction was retired
  // 2026-08-05; a shared barrier is now two cameras on one lane, so the same
  // in-then-out journey is driven through the pair. The routing outcome must be
  // identical to what the dual camera produced.
  read(C.dualIn.id, 'AAA0006', 'entry');
  check('A8 shared barrier: entry camera opens the session', inside('AAA0006'));
  read(C.dualOut.id, 'AAA0006', 'exit');
  await tick();
  check('A9 shared barrier: exit camera closes it', !inside('AAA0006'));
  check('A9b …and the lane still derives as dual (entry + exit cameras)',
    db.deriveLaneDirection(L.dual.id) === 'dual', String(db.deriveLaneDirection(L.dual.id)));

  // A10 replaces the old `entryCameraHandlesExit` case (setting removed
  // 2026-08-05 along with camera direction 'dual'). The rule it now pins is the
  // opposite one, and it's the reason the setting could go: an ENTRY camera never
  // closes a session, no matter how many times it reads the same plate. A second
  // read is a duplicate/re-scan, which the rescan-ignored guard handles.
  read(C.zeroIn.id, 'AAA0007', 'entry');
  const singleCamOpen = inside('AAA0007');
  read(C.zeroIn.id, 'AAA0007', 'entry');
  await tick();
  check('A10 an entry camera never closes a session, however often it re-reads',
    singleCamOpen && inside('AAA0007'),
    `openAfterFirst=${singleCamOpen} stillInside=${inside('AAA0007')}`);
  check('A10b …and the 2nd read is reported as a duplicate, not an exit',
    ev.rescan.some((p) => p.plate === 'AAA0007'),
    JSON.stringify(ev.rescan.map((p) => p.plate)));

  read(C.orphan.id, 'AAA0008', 'entry');
  const orphanSess = db.findOpenSessionByPlate('AAA0008');
  check('A11 entry on a camera with no lane still records the session',
    !!orphanSess && orphanSess.entryLaneId === null, `lane=${orphanSess?.entryLaneId}`);

  const stamped = db.findOpenSessionByPlate('AAA0001');
  check('A12 entry_at is stored as UTC ISO with a Z marker',
    /Z$/.test(stamped?.entryAt ?? ''), stamped?.entryAt);

  // ══════════════════════════════════════════════════════════════════════
  G('B · exit routing & free exits');
  // ══════════════════════════════════════════════════════════════════════
  read(C.zeroOut.id, 'BBB0001', 'exit');
  await tick();
  check('B1 exit with no recorded entry → exit-without-entry', warnedFor('exit-without-entry', 'BBB0001'));
  check('B1b …and opens no session', !inside('BBB0001'));

  const noLane = open('BBB0002', L.zero.id, C.zeroIn.id);
  read(C.orphanOut.id, 'BBB0002', 'exit');
  await tick();
  check('B2 exit on a lane-less camera → exit-no-lane', warnedSession('exit-no-lane', noLane.id));
  check('B2b …and the session stays open', inside('BBB0002'));

  const grace = await drive('BBB0003', ENTRY, EXIT, L.grace.id, C.graceOut.id, C.graceOut.id);
  const graceRow = db.getSessionById(grace.id);
  check('B3 stay inside freeMinutes → free exit', graceRow.paymentStatus === 'free' && graceRow.feeCents === 0,
    `${graceRow.paymentStatus}/${graceRow.feeCents}`);
  check('B3b …with freeReason "within-grace"', graceRow.freeReason === 'within-grace', graceRow.freeReason);
  check('B3c …and the session is closed as "exited"', graceRow.status === 'exited' && !!graceRow.exitAt);

  const zero = await drive('BBB0004', ENTRY, EXIT, L.zero.id, C.zeroIn.id, C.zeroOut.id);
  const zeroRow = db.getSessionById(zero.id);
  check('B4 plan priced at RM 0 → free exit, freeReason "rate-zero"',
    zeroRow.paymentStatus === 'free' && zeroRow.freeReason === 'rate-zero', zeroRow.freeReason);

  const nopol = await drive('BBB0005', ENTRY, EXIT, L.none.id, C.noneIn.id, C.noneOut.id);
  const nopolRow = db.getSessionById(nopol.id);
  check('B5 no plan on the lane and no site default → freeReason "no-policy"',
    nopolRow.paymentStatus === 'free' && nopolRow.freeReason === 'no-policy', nopolRow.freeReason);

  const beforeNoTerm = payCalls.length;
  const noTerm = await drive('BBB0006', ENTRY, EXIT, L.noTerm.id, C.noTermIn.id, C.noTermOut.id);
  check('B6 chargeable exit with no device on the lane → exit-no-terminal',
    ev.warning.some((w) => w.kind === 'exit-no-terminal' && w.laneId === L.noTerm.id));
  check('B6b …the session stays OPEN awaiting the operator', inside('BBB0006'));
  check('B6c …and no PayRequest was sent', payCalls.length === beforeNoTerm);
  check('B6d …the quoted fee is the full RM14', pendingFor('BBB0006')?.feeCents === FULL_FEE,
    pendingFor('BBB0006')?.feeCents);

  const devOff = await drive('BBB0007', ENTRY, EXIT, L.devOff.id, C.devOffOut.id, C.devOffOut.id);
  check('B7 device disabled → exit-terminal-disabled, session stays open',
    ev.warning.some((w) => w.kind === 'exit-terminal-disabled' && w.terminalId === terminalOff.id) && inside('BBB0007'));

  listenerReady = { ok: false, reason: 'TNG payments are switched off in Settings' };
  const beforeNoListener = payCalls.length;
  const noListener = await drive('BBB0008', ENTRY, EXIT, L.paid.id, C.paidIn.id, C.paidOut.id);
  check('B8 no PayResult listener → exit-tng-not-configured',
    warnedSession('exit-tng-not-configured', noListener.id));
  check('B8b …refuses BEFORE any money can move (no PayRequest)', payCalls.length === beforeNoListener);
  check('B8c …and the car waits inside for a manual release', inside('BBB0008'));
  listenerReady = { ok: true };

  db.saveSettings({ minimumChargeCents: 100 });
  payScript = APPROVE();
  const minChg = await drive('BBB0009', ENTRY, EXIT, L.zero.id, C.zeroIn.id, C.zeroOut.id);
  await tick(12);
  const minChgRow = db.getSessionById(minChg.id);
  check('B9 minimumChargeCents forces the terminal flow on a RM 0 plan',
    minChgRow.paymentStatus === 'paid' && minChgRow.feeCents === 100,
    `${minChgRow.paymentStatus}/${minChgRow.feeCents}`);
  db.saveSettings({ minimumChargeCents: 0 });

  // Entered on the RM 0 lane, leaving through the charging lane: the ENTRY
  // lane's plan must govern, so this is still free.
  const crossLane = await drive('BBB0010', ENTRY, EXIT, L.zero.id, C.zeroIn.id, C.noTermOut.id);
  const crossRow = db.getSessionById(crossLane.id);
  check('B10 the fee follows the ENTRY lane plan, not the exit lane',
    crossRow.paymentStatus === 'free' && crossRow.feeCents === 0, `${crossRow.paymentStatus}/${crossRow.feeCents}`);
  check('B11 …but the exit is RECORDED against the lane actually used',
    crossRow.exitLaneId === L.noTerm.id && crossRow.exitCameraId === C.noTermOut.id,
    `lane=${crossRow.exitLaneId} cam=${crossRow.exitCameraId}`);

  db.replaceAllBlockedPlates([
    { plateNumber: 'BAN0001', vehicleId: 'v-ban-1', reason: 'unpaid fines', fetchedAt: nowIso },
    { plateNumber: 'BAN0002', vehicleId: 'v-ban-2', reason: 'abandoned vehicle', fetchedAt: nowIso },
  ]);
  const bannedOpen = open('BAN0002', L.paid.id, C.paidIn.id, ENTRY);
  const beforeBan = payCalls.length;
  read(C.paidOut.id, 'BAN0002', 'exit', EXIT);
  await tick();
  check('B12 blacklisted at exit → exit REFUSED, session stays OPEN',
    inside('BAN0002') && db.getSessionById(bannedOpen.id).status === 'entered');
  check('B12b …nothing charged and no gate pulse', payCalls.length === beforeBan);
  check('B12c …reported as exit-blacklisted with the reason',
    ev.warning.some((w) => w.kind === 'exit-blacklisted' && w.plate === 'BAN0002' && w.reason === 'abandoned vehicle'));

  read(C.paidOut.id, 'BAN0001', 'exit', EXIT);   // banned, never had an entry
  await tick();
  check('B13 banned plate with no entry names the ban, not "exit-without-entry"',
    ev.warning.some((w) => w.kind === 'exit-blacklisted' && w.plate === 'BAN0001')
    && !warnedFor('exit-without-entry', 'BAN0001'));
  db.replaceAllBlockedPlates([]);

  // ══════════════════════════════════════════════════════════════════════
  G('C · paid exit & the terminal');
  // ══════════════════════════════════════════════════════════════════════
  payScript = APPROVE();
  const paid = await drive('CCC0001', ENTRY, EXIT, L.paid.id, C.paidIn.id, C.paidOut.id);
  await tick(12);
  const paidRow = db.getSessionById(paid.id);
  check('C1 approved tap → status "exited", payment "paid"',
    paidRow.status === 'exited' && paidRow.paymentStatus === 'paid', `${paidRow.status}/${paidRow.paymentStatus}`);
  check('C1b …charged the computed RM14', paidRow.feeCents === FULL_FEE, paidRow.feeCents);
  check('C1c …emits exit-completed outcome=paid', completedFor(paid.id)?.outcome === 'paid');
  check('C1d …and the car is no longer inside', !inside('CCC0001'));
  check('C2 card scheme + txn reference land on the session',
    paidRow.cardScheme === 'VISA_W4G' && paidRow.terminalTxnId === '424242******4242',
    `${paidRow.cardScheme}/${paidRow.terminalTxnId}`);
  const paidTxn = db.getTransactionById(completedFor(paid.id).transactionId);
  check('C2b …and the ledger row settles as paid for the same amount',
    paidTxn?.status === 'paid' && paidTxn?.amountCents === FULL_FEE,
    `${paidTxn?.status}/${paidTxn?.amountCents}`);

  payScript = DECLINE();
  const decl = await drive('CCC0002', ENTRY, EXIT, L.paid.id, C.paidIn.id, C.paidOut.id);
  await tick(12);
  const declRow = db.getSessionById(decl.id);
  check('C3 declined card leaves the session OPEN (car still inside)',
    declRow.status === 'entered' && !declRow.exitAt && inside('CCC0002'), declRow.status);
  const declEvent = ev.declined.find((d) => d.sessionId === decl.id);
  check('C3b …emits exit-declined', !!declEvent);
  check('C3c …and the failed attempt is recorded in the ledger',
    db.getTransactionById(declEvent.transactionId)?.status === 'failed');

  payScript = TIMEOUT();
  const tmo = await drive('CCC0003', ENTRY, EXIT, L.paid.id, C.paidIn.id, C.paidOut.id);
  await tick(12);
  check('C4 device timeout → exit-timeout, session stays open',
    warnedSession('exit-timeout', tmo.id) && inside('CCC0003'));
  const tmoWarn = ev.warning.find((w) => w.kind === 'exit-timeout' && w.sessionId === tmo.id);
  check('C4b …and the attempt is marked failed, not paid',
    db.getTransactionById(tmoWarn.transactionId)?.status === 'failed');

  // Busy guard — a second read while the device is mid-transaction.
  payScript = HANG();
  const busy = await drive('CCC0004', ENTRY, EXIT, L.paid.id, C.paidIn.id, C.paidOut.id);
  await tick(12);
  const callsWhileBusy = payCalls.length;
  const inflightTxn = db.getOpenTransactionForSession(busy.id);
  check('C6 the attempt is opened as "pending" BEFORE the device is driven',
    inflightTxn?.status === 'pending' && inflightTxn?.amountCents === FULL_FEE, inflightTxn?.status);
  read(C.paidOut.id, 'CCC0004', 'exit', EXIT);
  await tick(12);
  check('C5 second read mid-transaction → exit-busy, no second PayRequest',
    ev.warning.some((w) => w.kind === 'exit-busy' && w.laneId === L.paid.id) && payCalls.length === callsWhileBusy,
    `calls ${callsWhileBusy}→${payCalls.length}`);

  // …and a manual release cancels that in-flight charge at the device.
  const cancelsBefore = payCancels.length;
  const cancelled = flow.cancelExitInFlight(busy.id);
  check('C10 cancelExitInFlight reports the in-flight charge cancelled', cancelled === true);
  await tick(12);
  check('C10b …and tells the device to abort the deduction (PayCancel)',
    payCancels.length === cancelsBefore + 1 && payCancels[payCancels.length - 1].orderId === inflightTxn.orderId,
    JSON.stringify(payCancels[payCancels.length - 1] ?? null));
  check('C10c …leaving the cancelled car inside for the operator', inside('CCC0004'));
  payScript = APPROVE();
  const afterCancel = await drive('CCC0008', ENTRY, EXIT, L.paid.id, C.paidIn.id, C.paidOut.id);
  await tick(12);
  check('C10d …and freeing the lane so the next car can pay',
    db.getSessionById(afterCancel.id).paymentStatus === 'paid',
    db.getSessionById(afterCancel.id).paymentStatus);

  // Auto-retrigger OFF (current default in these settings).
  payScript = DECLINE();
  const noRe = await drive('CCC0005', ENTRY, EXIT, L.paid.id, C.paidIn.id, C.paidOut.id);
  await tick(12);
  const callsAfterDecline = payCalls.length;
  await sleep(2600);
  check('C7 tngAutoRetrigger off → no automatic re-arm after a decline',
    payCalls.length === callsAfterDecline, `calls ${callsAfterDecline}→${payCalls.length}`);
  check('C7b …and no exit-auto-retrigger was announced',
    !ev.warning.some((w) => w.kind === 'exit-auto-retrigger' && w.sessionId === noRe.id));

  // Auto-retrigger ON — must re-arm and then STOP at the cap (1 + 3 attempts).
  db.saveSettings({ tngAutoRetrigger: true });
  const capBefore = payCalls.length;
  const capped = await drive('CCC0006', ENTRY, EXIT, L.paid.id, C.paidIn.id, C.paidOut.id);
  for (let i = 0; i < 40 && payCalls.length - capBefore < 4; i++) await sleep(400);
  await sleep(2800);   // long enough for a 5th attempt to have appeared
  check('C8 auto-retrigger re-arms the terminal after a decline',
    ev.warning.some((w) => w.kind === 'exit-auto-retrigger' && w.sessionId === capped.id));
  check('C8b …and stops at the 3-attempt cap (4 charges total, never more)',
    payCalls.length - capBefore === 4, `attempts=${payCalls.length - capBefore}`);
  check('C8c …leaving the car inside for a manual release', inside('CCC0006'));

  // A release inside the retrigger delay must abort the pending attempt.
  const abortBefore = payCalls.length;
  const aborted = await drive('CCC0007', ENTRY, EXIT, L.paid.id, C.paidIn.id, C.paidOut.id);
  await tick(12);
  const afterFirst = payCalls.length;
  db.manualReleaseSession(aborted.id, 'operator let the car out');
  await sleep(2800);
  check('C9 a release during the retrigger delay aborts the pending attempt',
    payCalls.length === afterFirst, `calls ${afterFirst}→${payCalls.length} (first attempt was ${afterFirst - abortBefore})`);
  check('C9b …and the release is not overwritten by the flow',
    db.getSessionById(aborted.id).status === 'manual_release');
  db.saveSettings({ tngAutoRetrigger: false });

  // ══════════════════════════════════════════════════════════════════════
  G('D · manual release & retrigger');
  // ══════════════════════════════════════════════════════════════════════
  const stuck = open('DDD0001', L.paid.id, C.paidIn.id, ENTRY);
  const rel = db.manualReleaseSession(stuck.id, 'barrier stuck');
  check('D1 manual release closes a genuinely open session',
    rel.changed === true && rel.session.status === 'manual_release' && rel.session.paymentStatus === 'manual_release',
    `${rel.session.status}/${rel.session.paymentStatus}`);
  check('D1b …and stores the operator reason', rel.session.notes === 'barrier stuck', rel.session.notes);

  const settled = open('DDD0002', L.paid.id, C.paidIn.id, ENTRY);
  db.recordExit(settled.id, {
    exitAt: EXIT, exitLaneId: L.paid.id, exitCameraId: C.paidOut.id, exitImagePath: null,
    durationMinutes: 240, feeCents: FULL_FEE, paymentStatus: 'paid', terminalTxnId: 'card-9',
  });
  const late = db.manualReleaseSession(settled.id, 'late release');
  check('D2 manual release refuses an already-settled session', late.changed === false);
  check('D2b …leaving the paid record and its revenue intact',
    late.session.status === 'exited' && late.session.paymentStatus === 'paid' && late.session.feeCents === FULL_FEE,
    `${late.session.status}/${late.session.paymentStatus}/${late.session.feeCents}`);

  check('D3 retrigger on a missing session → session_not_found',
    flow.retriggerSessionExit(999999).error === 'session_not_found');
  check('D4 retrigger on a closed session is refused',
    /already_closed/.test(flow.retriggerSessionExit(settled.id).error ?? ''),
    flow.retriggerSessionExit(settled.id).error);

  const laneless = open('DDD0003', null, null, ENTRY);
  check('D5 retrigger with no lane on the session is refused',
    /has_no_lane/.test(flow.retriggerSessionExit(laneless.id).error ?? ''),
    flow.retriggerSessionExit(laneless.id).error);

  const noDevice = open('DDD0004', L.noTerm.id, C.noTermIn.id, ENTRY);
  check('D6 retrigger on a lane with no payment device is refused',
    /no payment device/.test(flow.retriggerSessionExit(noDevice.id).error ?? ''),
    flow.retriggerSessionExit(noDevice.id).error);

  const noCamera = open('DDD0005', L.noCam.id, null, ENTRY);
  check('D7 retrigger on a lane with no enabled camera is refused',
    /no enabled camera/.test(flow.retriggerSessionExit(noCamera.id).error ?? ''),
    flow.retriggerSessionExit(noCamera.id).error);

  payScript = APPROVE();
  const retry = open('DDD0006', L.paid.id, C.paidIn.id, RETRIGGER_ENTRY);
  const retryRes = flow.retriggerSessionExit(retry.id);
  await tick(14);
  const retryRow = db.getSessionById(retry.id);
  check('D8 retrigger drives a real charge and closes the session',
    retryRes.ok === true && retryRow.paymentStatus === 'paid' && retryRow.status === 'exited',
    `ok=${retryRes.ok} err=${retryRes.error ?? '-'} ${retryRow.status}/${retryRow.paymentStatus}`);
  check('D8b …priced from the session entry to now (RM11 for a 3h stay)',
    retryRow.feeCents === RETRIGGER_FEE && retryRow.durationMinutes === 180,
    `${retryRow.feeCents}c/${retryRow.durationMinutes}min`);

  check('D9 retriggerSessionExitByPlate with an unreadable plate → plate_required',
    flow.retriggerSessionExitByPlate('--').error === 'plate_required');
  check('D10 retriggerSessionExitByPlate with nobody inside says so',
    /no car currently inside/.test(flow.retriggerSessionExitByPlate('ZZZ9999').error ?? ''));

  const typed = open('TYP0007', L.paid.id, C.paidIn.id, RETRIGGER_ENTRY);
  const typedRes = flow.retriggerSessionExitByPlate('typ 0007', L.paid.id);
  await tick(14);
  const typedRow = db.getSessionById(typed.id);
  check('D11 a plate typed with separators is canonicalised to find the session',
    typedRes.ok === true && typedRow.paymentStatus === 'paid',
    `ok=${typedRes.ok} err=${typedRes.error ?? '-'} ${typedRow.status}/${typedRow.paymentStatus} lastWarn=${ev.warning.slice(-1)[0]?.kind ?? '-'}`);

  // ══════════════════════════════════════════════════════════════════════
  G('E · every pass type SaaS can issue');
  // ══════════════════════════════════════════════════════════════════════
  // Prices from the SaaS catalogue decide is_free, but the LOCAL decision never
  // uses it: a pass covering the exit day means the cloud already settled, so
  // the gate waives the fare whatever the type. Each case runs on the charging
  // lane, so a free exit can only be the pass.
  const PASS_TYPES = [
    { type: 'monthly', plate: 'PMO0001', isFree: false },
    { type: 'quarterly', plate: 'PQU0002', isFree: false },
    { type: 'yearly', plate: 'PYE0003', isFree: false },
    { type: 'staff', plate: 'PST0004', isFree: false },
    { type: 'corporate', plate: 'PCO0005', isFree: false },
    { type: 'free_access', plate: 'PFA0006', isFree: true },
    { type: 'vip', plate: 'PVI0007', isFree: false },
    { type: 'temporary', plate: 'PTE0008', isFree: false },
    { type: 'resident', plate: 'PRE0009', isFree: true },
  ];

  const pass = (passId, plateNumber, over = {}) => ({
    passId, plateNumber, passType: 'monthly', status: 'active',
    startDate: '2026-08-01', endDate: '2026-08-31', isFree: false,
    spaceNumber: null, fetchedAt: nowIso, ...over,
  });

  const roster = [
    // E — one row per pass type
    ...PASS_TYPES.map((p) => pass(`pt-${p.type}`, p.plate, { passType: p.type, isFree: p.isFree })),
    // F — validity edges
    pass('f-expired', 'FEX0001', { status: 'expired' }),
    pass('f-suspended', 'FSU0002', { status: 'suspended' }),
    pass('f-pending', 'FPE0003', { status: 'pending' }),
    pass('f-rejected', 'FRE0004', { status: 'rejected' }),
    pass('f-otherplate', 'FOT9999'),
    pass('f-future', 'FFU0006', { startDate: '2026-09-01', endDate: '2026-09-30' }),
    pass('f-past', 'FPA0007', { startDate: '2026-06-01', endDate: '2026-06-30' }),
    pass('f-openend-null', 'FON0008', { passType: 'resident', endDate: null, isFree: true }),
    pass('f-openend-blank', 'FOB0009', { passType: 'free_access', endDate: '', isFree: true }),
    pass('f-nostart-null', 'FNS0010', { startDate: null }),
    pass('f-nostart-blank', 'FNB0011', { startDate: '' }),
    pass('f-boundary', 'FBO0012', { startDate: '2026-08-10', endDate: '2026-08-10' }),
    pass('f-separators', 'FIX-1234'),
    pass('f-revocable', 'FRV0014'),
    pass('f-banned', 'BAN0003'),
    pass('f-space', 'FSP0016', { spaceNumber: 'B2-114' }),
    // F preference ordering (same plate, several rows)
    pass('f-pref-dated', 'FPR0017', { endDate: '2026-08-20' }),
    pass('f-pref-forever', 'FPR0017-b', { plateNumber: 'FPR0017', endDate: null }),
    pass('f-pref-free', 'FPR0018', { isFree: true }),
    pass('f-pref-paid-forever', 'FPR0018-b', { plateNumber: 'FPR0018', endDate: null }),
    pass('f-pref-early', 'FPR0019', { endDate: '2026-08-15' }),
    pass('f-pref-late', 'FPR0019-b', { plateNumber: 'FPR0019', endDate: '2026-08-25' }),
    // G — lapse / renewal
    pass('g-lapsed', 'GLA0001', { startDate: '2026-07-01', endDate: '2026-07-31' }),
    pass('g-renew-old', 'GRE0002', { passType: 'free_access', isFree: true, startDate: '2026-07-01', endDate: '2026-07-31' }),
    pass('g-renew-new', 'GRE0002-b', { plateNumber: 'GRE0002', startDate: '2026-08-01', endDate: '2026-08-31' }),
    pass('g-tailzero', 'GTZ0003', { startDate: '2026-07-01', endDate: '2026-07-31' }),
    pass('g-exitonly', 'GEO0004', { startDate: '2026-08-10', endDate: '2026-08-31' }),
  ];
  db.replaceAllSeasonPasses(roster);
  check('E0 the whole roster cached locally', db.listSeasonPasses().length === roster.length,
    `${db.listSeasonPasses().length}/${roster.length}`);

  for (const p of PASS_TYPES) {
    const s = await drive(p.plate, ENTRY, EXIT, L.noTerm.id, C.noTermIn.id, C.noTermOut.id);
    const row = db.getSessionById(s.id);
    const label = `E "${p.type}" pass`;
    check(`${label} → free exit on a charging plan`,
      row.paymentStatus === 'free' && row.feeCents === 0 && row.status === 'exited',
      `${row.status}/${row.paymentStatus}/${row.feeCents}`);
    check(`${label} → freeReason "pass-${p.type}" and the pass id recorded`,
      row.freeReason === `pass-${p.type}` && row.passId === `pt-${p.type}`,
      `${row.freeReason}/${row.passId}`);
    check(`${label} → never touches the terminal (no exit-pending)`,
      !ev.pending.some((q) => q.session.plate === p.plate));
  }

  // ══════════════════════════════════════════════════════════════════════
  G('F · pass validity edges');
  // ══════════════════════════════════════════════════════════════════════
  /** Drive the stay on the charging lane and report how the exit resolved. */
  async function passExit(plate) {
    const s = await drive(plate, ENTRY, EXIT, L.noTerm.id, C.noTermIn.id, C.noTermOut.id);
    return { session: db.getSessionById(s.id), quoted: pendingFor(plate)?.feeCents ?? null };
  }
  const charged = (r) => r.session.status === 'entered' && r.quoted === FULL_FEE;
  const freeVia = (r, passId) => r.session.paymentStatus === 'free' && r.session.passId === passId;

  for (const [id, plate, status] of [
    ['F1', 'FEX0001', 'expired'], ['F2', 'FSU0002', 'suspended'],
    ['F3', 'FPE0003', 'pending'], ['F4', 'FRE0004', 'rejected'],
  ]) {
    const r = await passExit(plate);
    check(`${id} a "${status}" pass is NOT honoured — the stay is charged in full`,
      charged(r), `${r.session.status} quoted=${r.quoted}`);
  }

  const otherPlate = await passExit('FOT0005');
  check('F5 a pass issued to another plate does not cover this car',
    charged(otherPlate), `${otherPlate.session.status} quoted=${otherPlate.quoted}`);

  const future = await passExit('FFU0006');
  check('F6 a pass that starts next month does not cover today',
    charged(future), `${future.session.status} quoted=${future.quoted}`);

  const past = await passExit('FPA0007');
  check('F7 a pass that ended before the entry does not cover the stay',
    charged(past), `${past.session.status} quoted=${past.quoted}`);

  const foreverNull = await passExit('FON0008');
  check('F8 end_date NULL (never expires) → free exit', freeVia(foreverNull, 'f-openend-null'),
    `${foreverNull.session.paymentStatus}/${foreverNull.session.passId}`);

  const foreverBlank = await passExit('FOB0009');
  check('F9 end_date "" from a sloppy cloud row is treated as open-ended, not expired',
    freeVia(foreverBlank, 'f-openend-blank'), `${foreverBlank.session.paymentStatus}/${foreverBlank.session.passId}`);

  const noStartNull = await passExit('FNS0010');
  check('F10 start_date NULL covers any entry', freeVia(noStartNull, 'f-nostart-null'),
    `${noStartNull.session.paymentStatus}/${noStartNull.session.passId}`);

  const noStartBlank = await passExit('FNB0011');
  check('F11 start_date "" covers any entry', freeVia(noStartBlank, 'f-nostart-blank'),
    `${noStartBlank.session.paymentStatus}/${noStartBlank.session.passId}`);

  const boundary = await passExit('FBO0012');
  check('F12 a one-day pass covers its own last day (inclusive boundary)',
    freeVia(boundary, 'f-boundary'), `${boundary.session.paymentStatus}/${boundary.session.passId}`);

  const separators = await passExit('FIX1234');
  check('F13 a cloud plate stored as "FIX-1234" matches the gate read "FIX1234"',
    freeVia(separators, 'f-separators'), `${separators.session.paymentStatus}/${separators.session.passId}`);

  const spaced = await passExit('FSP0016');
  check('F16 a reserved space number does not change the exit decision',
    freeVia(spaced, 'f-space'), `${spaced.session.paymentStatus}/${spaced.session.passId}`);

  check('F17 free/waived pass outranks an open-ended paid one in the audit trail',
    db.findSeasonPassByPlate('FPR0018', { entryAt: ENTRY, exitAt: EXIT })?.passId === 'f-pref-free',
    db.findSeasonPassByPlate('FPR0018', { entryAt: ENTRY, exitAt: EXIT })?.passId);
  check('F18 an open-ended pass outranks a dated one (broadest coverage wins)',
    db.findSeasonPassByPlate('FPR0017', { entryAt: ENTRY, exitAt: EXIT })?.passId === 'f-pref-forever',
    db.findSeasonPassByPlate('FPR0017', { entryAt: ENTRY, exitAt: EXIT })?.passId);
  check('F19 between two dated passes the later end_date wins',
    db.findSeasonPassByPlate('FPR0019', { entryAt: ENTRY, exitAt: EXIT })?.passId === 'f-pref-late',
    db.findSeasonPassByPlate('FPR0019', { entryAt: ENTRY, exitAt: EXIT })?.passId);

  // A banned vehicle that still holds a valid pass must NOT be waved out.
  db.replaceAllBlockedPlates([{ plateNumber: 'BAN0003', vehicleId: 'v-ban-3', reason: 'ban outranks pass', fetchedAt: nowIso }]);
  const bannedPass = open('BAN0003', L.noTerm.id, C.noTermIn.id, ENTRY);
  read(C.noTermOut.id, 'BAN0003', 'exit', EXIT);
  await tick();
  check('F15 the blacklist beats a valid pass — exit refused, session still open',
    inside('BAN0003') && db.getSessionById(bannedPass.id).status === 'entered'
    && ev.warning.some((w) => w.kind === 'exit-blacklisted' && w.plate === 'BAN0003'));
  db.replaceAllBlockedPlates([]);

  // ══════════════════════════════════════════════════════════════════════
  G('G · pass lapse, renewal & partial cover');
  // ══════════════════════════════════════════════════════════════════════
  // Pass ends 31 Jul; stay runs 31 Jul 10:00 MYT → 1 Aug 12:00 MYT (1560 min).
  // Only the tail from 1 Aug 00:00 MYT is billable: 720 min → RM5 + 11×RM3 = RM38.
  // The full stay would be RM80, so RM38 proves the covered head was not billed.
  const lapsed = await drive('GLA0001', '2026-07-31T02:00:00.000Z', '2026-08-01T04:00:00.000Z',
    L.noTerm.id, C.noTermIn.id, C.noTermOut.id);
  const lapsedQuote = pendingFor('GLA0001');
  check('G1 a pass that lapsed mid-stay bills ONLY the uncovered tail (RM38, not RM80)',
    lapsedQuote?.feeCents === 3800, `feeCents=${lapsedQuote?.feeCents}`);
  check('G2 …while the audit duration keeps the TRUE 1560-minute stay',
    lapsedQuote?.durationMinutes === 1560, `duration=${lapsedQuote?.durationMinutes}`);
  check('G2b …and the exit is not free', db.getSessionById(lapsed.id).status === 'entered' && inside('GLA0001'));

  // Renewed mid-stay: the lapsed free_access row outranks the renewal in the
  // broad lookup, so the exit-day re-query is what must save this driver.
  const renewed = await drive('GRE0002', '2026-07-31T02:00:00.000Z', '2026-08-01T04:00:00.000Z',
    L.noTerm.id, C.noTermIn.id, C.noTermOut.id);
  const renewedRow = db.getSessionById(renewed.id);
  check('G3 renewed mid-stay → still a free exit, credited to the RENEWAL row',
    renewedRow.paymentStatus === 'free' && renewedRow.passId === 'g-renew-new',
    `${renewedRow.paymentStatus}/${renewedRow.passId}`);

  const covered = await drive('PMO0001B', ENTRY, EXIT, L.noTerm.id, C.noTermIn.id, C.noTermOut.id);
  check('G4 a pass covering the whole stay is unchanged (control case)',
    db.getSessionById(covered.id).status === 'entered', 'no pass for this plate → charged');

  // Lapsed pass whose uncovered tail prices to RM 0 under the lane's plan: free,
  // but the audit must say the RATE made it free, not the pass.
  const tailZero = await drive('GTZ0003', '2026-07-31T02:00:00.000Z', '2026-08-01T04:00:00.000Z',
    L.zero.id, C.zeroIn.id, C.zeroOut.id);
  const tailRow = db.getSessionById(tailZero.id);
  check('G5 lapsed pass + RM 0 tail → free exit attributed to the rate, not the pass',
    tailRow.paymentStatus === 'free' && tailRow.feeCents === 0 && tailRow.passId === null
    && tailRow.freeReason === 'rate-zero',
    `${tailRow.freeReason}/passId=${tailRow.passId}`);

  // Entered before the pass started, leaving on its first covered day: coverage
  // of the EXIT day is what buys a free exit.
  const exitOnly = await drive('GEO0004', '2026-08-09T02:00:00.000Z', EXIT,
    L.noTerm.id, C.noTermIn.id, C.noTermOut.id);
  const exitOnlyRow = db.getSessionById(exitOnly.id);
  check('G6 a pass covering only the EXIT day still buys a free exit',
    exitOnlyRow.paymentStatus === 'free' && exitOnlyRow.passId === 'g-exitonly',
    `${exitOnlyRow.paymentStatus}/${exitOnlyRow.passId}`);

  // Revocation: replace-all must make a cloud-revoked pass stop working here.
  const beforeRevoke = await passExit('FRV0014');
  db.replaceAllSeasonPasses(roster.filter((p) => p.passId !== 'f-revocable'));
  const afterRevoke = await passExit('FRV0014B');
  check('G7 a pass revoked in the cloud stops waiving the fare after the next sync',
    freeVia(beforeRevoke, 'f-revocable') && afterRevoke.quoted === FULL_FEE,
    `before=${beforeRevoke.session.passId} after=${afterRevoke.quoted}`);
  check('G7b …and it is gone from the local roster',
    !db.listSeasonPasses().some((p) => p.passId === 'f-revocable'));

  // ══════════════════════════════════════════════════════════════════════
  G('H · duration & fee integrity');
  // ══════════════════════════════════════════════════════════════════════
  const t0 = Date.parse('2026-08-10T02:00:00Z');
  check('H1 59m30s truncates to 59 minutes (one duration rule everywhere)',
    flow.stayDurationMinutes(t0, t0 + 59 * 60_000 + 30_000) === 59,
    flow.stayDurationMinutes(t0, t0 + 59 * 60_000 + 30_000));
  check('H2 exactly 60 minutes is 60', flow.stayDurationMinutes(t0, t0 + 60 * 60_000) === 60);
  check('H3 an exit before the entry clamps to 0', flow.stayDurationMinutes(t0, t0 - 60_000) === 0);
  check('H4 unparseable timestamps clamp to 0', flow.stayDurationMinutes('nonsense', EXIT) === 0);

  const sim = flow.simulateRatePolicyFee('charge', ENTRY, EXIT);
  check('H5 "Test price" quotes the same RM14 the gate charged',
    sim.ok && sim.feeCents === FULL_FEE && sim.durationMinutes === 240, JSON.stringify(sim));
  check('H6 …and agrees with the gate on the duration',
    flow.stayDurationMinutes(ENTRY, EXIT) === sim.durationMinutes);
  check('H7 the recorded duration on the paid exit matches that rule',
    db.getSessionById(paid.id).durationMinutes === 240, db.getSessionById(paid.id).durationMinutes);

  // ══════════════════════════════════════════════════════════════════════
  G('I · dev simulator & open-session restore');
  // ══════════════════════════════════════════════════════════════════════
  // The simulator is NOT a separate code path any more (2026-08-07). Both
  // helpers emit the exact PlateEvent the LPR webhook emits and return as soon
  // as it is dispatched, so a parking DECISION is never reported through the
  // return value — it is observed on the DB and the 'warning' channel, exactly
  // as it would be for a real car. `ok:false` now means only "bad simulator
  // input" (unknown lane, unparseable time, no camera to route through).
  //
  // That equivalence is the point: the old helpers wrote to the DB themselves
  // and re-implemented the guards, so they drifted — most visibly, a simulated
  // entry never pulsed the barrier.
  await flow.simulateEntryAt(L.zero.id, 'III0001', ENTRY);
  await tick(12);
  const simSession = db.findOpenSessionByPlate('III0001');
  check('I1 simulateEntryAt opens a session stamped with the chosen entry time',
    simSession?.entryAt === ENTRY, simSession?.entryAt);
  check('I1b …via the real entry event, so the barrier is pulsed like a live read',
    ev.entry.some((e) => e.session?.plate === 'III0001'));

  const beforeRescan = db.listOpenSessions().filter((s) => s.plate === 'III0001').length;
  await flow.simulateEntryAt(L.zero.id, 'III0001', ENTRY);
  await tick(12);
  check('I2 a plate already inside does not open a second session',
    db.listOpenSessions().filter((s) => s.plate === 'III0001').length === beforeRescan
    && ev.rescan.some((r) => r.plate === 'III0001'));
  check('I3 simulateEntryAt refuses an invalid entry time',
    (await flow.simulateEntryAt(L.zero.id, 'III0002', 'not-a-date')).error === 'invalid_entry_time');

  db.replaceAllBlockedPlates([{ plateNumber: 'BAN0004', vehicleId: 'v-ban-4', reason: 'sim ban', fetchedAt: nowIso }]);
  await flow.simulateEntryAt(L.zero.id, 'BAN0004', ENTRY);
  await tick(12);
  check('I4 simulateEntryAt honours the blacklist, exactly like the camera path',
    !inside('BAN0004') && warnedFor('entry-blacklisted', 'BAN0004'));
  db.replaceAllBlockedPlates([]);

  // I4b — Only Pass Allow must bite for a simulated read too. Its own lane: the
  // simulator resolves the ENTRY-facing camera on the lane, so a lane that
  // already has an ordinary entry camera would answer for that one instead.
  const simPassLane = db.upsertLane({
    name: 'L-SIM-PASSONLY', policyId: null, terminalId: null, enabled: true,
  });
  const simPassCam = db.upsertCamera({
    name: 'SIM-PASSONLY', laneId: simPassLane.id, direction: 'entry',
    accessMode: 'pass_only',
    host: '10.9.9.9', deviceUser: 'admin', devicePassword: 'admin', devicePort: 80,
    webhookSecret: null, enabled: true,
  });
  await flow.simulateEntryAt(simPassLane.id, 'SIMNOPASS', ENTRY);
  await tick(12);
  check('I4b simulateEntryAt refuses an unregistered plate on an Only Pass Allow lane',
    !inside('SIMNOPASS') && warnedFor('entry-not-authorised', 'SIMNOPASS'));
  check('I4c …and stores NO session for it',
    db.listOpenSessions().every((s) => s.plate !== 'SIMNOPASS'));

  db.replaceAllSeasonPasses([{
    passId: 'p-sim', plateNumber: 'SIMPASS01', passType: 'resident', status: 'active',
    startDate: null, endDate: null, isFree: false, spaceNumber: null, fetchedAt: nowIso,
  }]);
  await flow.simulateEntryAt(simPassLane.id, 'SIMPASS01', ENTRY);
  await tick(12);
  check('I4d …but admits a plate that does hold a valid pass', inside('SIMPASS01'));
  db.replaceAllSeasonPasses([]);
  db.deleteCamera(simPassCam.id);
  db.deleteLane(simPassLane.id);

  const banOpen = open('BAN0005', L.zero.id, C.zeroIn.id, ENTRY);
  db.replaceAllBlockedPlates([{ plateNumber: 'BAN0005', vehicleId: 'v-ban-5', reason: 'sim ban 2', fetchedAt: nowIso }]);
  await flow.simulateExitAt(L.zero.id, 'BAN0005', EXIT);
  await tick(12);
  check('I5 simulateExitAt refuses a banned plate before anything else',
    db.getSessionById(banOpen.id).status === 'entered' && warnedFor('exit-blacklisted', 'BAN0005'));
  db.replaceAllBlockedPlates([]);

  await flow.simulateExitAt(L.zero.id, 'III0003', EXIT);
  await tick(12);
  check('I6 an exit for a plate with no open session reports exit-without-entry',
    warnedFor('exit-without-entry', 'III0003'));

  const simExit = await flow.simulateExitAt(L.zero.id, 'III0001', EXIT);
  await tick(12);
  check('I7 simulateExitAt prices and closes the stay at the chosen instant',
    simExit.ok && db.getSessionById(simSession.id)?.exitAt === EXIT
    && db.getSessionById(simSession.id)?.durationMinutes === 240,
    `${db.getSessionById(simSession.id)?.exitAt}/${db.getSessionById(simSession.id)?.durationMinutes}`);

  // Restore path: a rebound box pulls the cloud's open records so cars that
  // drove in before the wipe can still exit.
  const knownEntry = '2026-08-12T01:00:00.000Z';
  const knownClosed = open('IRS0002', L.zero.id, C.zeroIn.id, knownEntry);
  db.recordExit(knownClosed.id, {
    exitAt: '2026-08-12T02:00:00.000Z', exitLaneId: L.zero.id, exitCameraId: C.zeroOut.id,
    exitImagePath: null, durationMinutes: 60, feeCents: 0, paymentStatus: 'free', terminalTxnId: null,
  });
  const restore = db.importOpenSessionsFromCloud([
    { plate: 'IRS0001', entryAt: '2026-08-12T00:30:00.000Z' },   // unknown → import
    { plate: 'AAA0001', entryAt: '2026-08-12T00:00:00.000Z' },   // already inside → skip
    { plate: 'IRS0002', entryAt: '2026-08-12T01:03:00.000Z' },   // known closed stay (+3min) → skip
  ]);
  check('I8 restore imports an unknown plate as an open session',
    restore.imported === 1 && inside('IRS0001'), JSON.stringify(restore));
  const restored = db.findOpenSessionByPlate('IRS0001');
  check('I8b …preserving the cloud entry time and marking the origin',
    restored?.entryAt === '2026-08-12T00:30:00.000Z' && /Restored from cloud/.test(restored?.notes ?? ''),
    `${restored?.entryAt} · ${restored?.notes}`);
  check('I8c …keeps the box\'s own record for a plate already inside', openCount('AAA0001') === 1);
  check('I8d …and refuses to re-open a stay this box already closed', !inside('IRS0002'));
  const again = db.importOpenSessionsFromCloud([{ plate: 'IRS0001', entryAt: '2026-08-12T00:30:00.000Z' }]);
  check('I8e re-running the import is a no-op', again.imported === 0 && again.skipped === 1, JSON.stringify(again));

  read(C.zeroOut.id, 'IRS0001', 'exit', '2026-08-12T03:00:00.000Z');
  await tick(12);
  check('I8f a restored session exits like any other', !inside('IRS0001'));

  out.ok = out.checks.every((c) => c.pass);
}
