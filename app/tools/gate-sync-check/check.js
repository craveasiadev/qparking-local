/**
 * Gate-critical sync checks, run inside a REAL electron main process
 * (better-sqlite3 is built for the electron ABI, so plain node can't open the DB).
 *
 *   electron tools/gate-sync-check/check.js <resultFile>
 *
 * THE regression this exists for: passes, bans and rate plans used to come down
 * on syncAll() ONLY — boot, "Sync now", a site rebind. So a pass issued or a
 * plate banned in the SaaS did not reach the barrier until somebody walked to
 * the box and pressed a button; staff were the sync mechanism, and a driver at
 * the gate paid for anyone forgetting. syncGateCritical() and its 5-minute timer
 * close that, and these checks pin both halves of the deal:
 *
 *   1. the tick really does bring those three mirrors down on its own, AND
 *   2. it stays cheap — it must never pull /activity-logs, the unbounded
 *      replace-all that got the old 60-second everything-tick deleted, nor the
 *      other syncAll()-only endpoints.
 *
 * It also pins the empty-wipe guard's new scope rule: an UNATTENDED tick may
 * never be the pull that confirms a destructive wipe, and may not bring one
 * closer either — otherwise the human confirmation that guard exists to demand
 * would be supplied by a timer running every 5 minutes.
 *
 * Talks to a stub cloud on 127.0.0.1 rather than mocking axios, so the real URL
 * building, Bearer header, envelope parsing and 404 fallbacks are all exercised.
 *
 * Launched by run.mjs. Results go to a JSON file rather than stdout because
 * electron is a Windows GUI-subsystem binary and its console output is unreliable
 * when spawned.
 */
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

process.env.TZ = 'Asia/Kuala_Lumpur';

const resultFile = process.argv[2];
const out = { ok: false, checks: [], error: null };
const check = (name, pass, detail = null) => out.checks.push({ name, pass, detail });

// --- stub cloud -------------------------------------------------------------
// `routes` is swapped between checks; `hits` records every path the box asked
// for, which is how the "stays cheap" half is proven.
let routes = {};
const hits = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const route = url.pathname.replace('/api/v1/local-server', '');
  hits.push(route);
  const handler = routes[route];
  if (!handler) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'no such endpoint' }));
    return;
  }
  const [status, body] = handler();
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
});

const ok = (body) => () => [200, body];
// `meta.total` is the shape the live SaaS actually sends (added 2026-09-01 to
// RatePolicyController / SeasonPassController / VehicleController::blacklisted).
// Passing no total models an OLDER backend, which is what the streak guard is for.
const list = (data, total) => ok(total === undefined ? { data } : { data, meta: { total } });
// The top-level `total` readCloudTotal also accepts, kept covered so the fallback
// order in that helper stays exercised.
const listFlatTotal = (data, total) => ok({ data, total });

const PASS_ROWS = [{
  id: 'pass-1', plates: ['GATE1234'], role: 'resident', status: 'active',
  start_date: '2026-01-01', end_date: '2099-12-31', concurrent_limit: 1, plan: 'Monthly',
}];
const BAN_ROWS = [{ plate_number: 'BANNED99', vehicle_id: 'veh-1', reason: 'unpaid' }];
const RATE_ROWS = [{ id: 'pol-1', name: 'Everyday', is_default: 1, tariff_rules: [] }];

const GOOD = () => ({
  '/season-passes/v2': list(PASS_ROWS, 1),
  '/vehicles/blacklisted': list(BAN_ROWS, 1),
  '/rate-policies': list(RATE_ROWS, 1),
});

function finish() {
  out.ok = out.checks.every((c) => c.pass) && !out.error;
  fs.writeFileSync(resultFile, JSON.stringify(out, null, 2));
  try { server.close(); } catch { /* ignore */ }
  app.exit(0);
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-gate-sync-'));
  app.setPath('userData', tmpDir);

  const db = require('../../dist/main/services/db');
  const sync = require('../../dist/main/services/cloud-sync');

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  db.saveSettings({ qparkingBaseUrl: `http://127.0.0.1:${port}`, qparkingApiKey: 'test-key' });

  // --- 1. the tick brings gate-critical data down on its own ----------------
  // Exactly the scenario that used to need a human: a pass and a ban exist in
  // the cloud, nobody has pressed anything, and this box has never seen them.
  routes = GOOD();
  hits.length = 0;
  check('precondition: box starts with an empty roster',
    db.mirrorRowCounts().passes === 0 && db.mirrorRowCounts().blockedPlates === 0,
    JSON.stringify(db.mirrorRowCounts()));

  const first = await sync.syncGateCritical();
  check('a gate tick succeeds on all three mirrors',
    first.passes.ok && first.blockedPlates.ok && first.policies.ok,
    JSON.stringify(first));
  check('a pass issued in the cloud reaches the barrier WITHOUT a full pull',
    !!db.findSeasonPassByPlate('GATE1234'),
    `roster now: ${JSON.stringify(db.listSeasonPasses().map((p) => p.plateNumber))}`);
  check('...so does a ban',
    db.listBlockedPlates().some((b) => b.plateNumber === 'BANNED99'),
    JSON.stringify(db.listBlockedPlates()));
  check('...and so does a rate plan',
    db.listRatePolicies().some((p) => p.policyId === 'pol-1'),
    JSON.stringify(db.listRatePolicies().map((p) => p.policyId)));

  // --- 2. ...and it stays cheap ---------------------------------------------
  // The old 60-second tick was deleted because it dragged /activity-logs — an
  // unbounded replace-all of the whole audit trail — down with it every minute.
  // If that endpoint ever reappears on THIS tick, the deletion was for nothing.
  check('the tick asks for exactly 3 endpoints', hits.length === 3, JSON.stringify(hits));
  check('...and NEVER /activity-logs (the unbounded mirror)',
    !hits.includes('/activity-logs'), JSON.stringify(hits));
  const syncAllOnly = ['/site', '/company/settings', '/customers', '/vehicles', '/parking-spaces', '/sessions/open'];
  check('...nor any other syncAll()-only endpoint',
    syncAllOnly.every((r) => !hits.includes(r)), JSON.stringify(hits));

  // --- 3. an unattended tick can NEVER confirm a wipe -----------------------
  // No `total` in the envelope = a SaaS too old to corroborate, which is the
  // only path the streak guard still governs. Before the scope rule, two ticks
  // ten minutes apart would have cleared the entire pass roster unwatched.
  routes = { '/season-passes/v2': list([]), '/vehicles/blacklisted': list([]), '/rate-policies': list([]) };
  const ticks = [];
  for (let i = 0; i < 4; i++) ticks.push(await sync.syncGateCritical());
  check('four consecutive empty TICKS all refuse the wipe',
    ticks.every((t) => !t.passes.ok && String(t.passes.error).startsWith('refused_empty_wipe')),
    JSON.stringify(ticks.map((t) => t.passes.error)));
  check('...and the roster is still intact after all of them',
    db.mirrorRowCounts().passes === 1, JSON.stringify(db.mirrorRowCounts()));
  check('...the refusal tells staff to press "Sync now", not to retry blindly',
    String(ticks[0].passes.error).includes('Sync now'), ticks[0].passes.error);

  // --- 4. ...and does not bring a deliberate wipe closer --------------------
  // The streak means TWO HUMAN DECISIONS. If a tick incremented it, the four
  // above would have pre-loaded the counter and this next deliberate pull —
  // the operator's FIRST — would apply the wipe on its own.
  const deliberate1 = await sync.syncSeasonPasses();
  check("the operator's FIRST deliberate empty pull still refuses",
    !deliberate1.ok && db.mirrorRowCounts().passes === 1,
    `${deliberate1.error} · counts=${JSON.stringify(db.mirrorRowCounts())}`);
  const deliberate2 = await sync.syncSeasonPasses();
  check('...and the SECOND applies it — the guard still has an exit',
    deliberate2.ok && db.mirrorRowCounts().passes === 0,
    `${JSON.stringify(deliberate2)} · counts=${JSON.stringify(db.mirrorRowCounts())}`);

  // --- 5. a cloud-CORROBORATED emptying still lands on a tick ---------------
  // Deliberately NOT blocked. `total: 0` is the cloud stating the site has no
  // passes, not an ambiguous blank; refusing it would leave the box honouring
  // passes the SaaS has retired until someone pressed a button — the very
  // staleness this tick exists to end.
  routes = GOOD();
  await sync.syncGateCritical();
  check('precondition: roster repopulated', db.mirrorRowCounts().passes === 1, JSON.stringify(db.mirrorRowCounts()));
  routes = { ...GOOD(), '/season-passes/v2': list([], 0) };
  const corroborated = await sync.syncGateCritical();
  check('a tick DOES apply an emptying the cloud corroborates with meta.total=0',
    corroborated.passes.ok && db.mirrorRowCounts().passes === 0,
    `${JSON.stringify(corroborated.passes)} · counts=${JSON.stringify(db.mirrorRowCounts())}`);

  // Same again through the OTHER envelope readCloudTotal accepts. The cloud sends
  // meta.total today; this keeps the top-level fallback from rotting unnoticed.
  routes = GOOD();
  await sync.syncGateCritical();
  check('precondition: roster repopulated for the flat-total case',
    db.mirrorRowCounts().passes === 1, JSON.stringify(db.mirrorRowCounts()));
  routes = { ...GOOD(), '/season-passes/v2': listFlatTotal([], 0) };
  const flat = await sync.syncGateCritical();
  check('...and a top-level total=0 corroborates it just as well',
    flat.passes.ok && db.mirrorRowCounts().passes === 0,
    `${JSON.stringify(flat.passes)} · counts=${JSON.stringify(db.mirrorRowCounts())}`);

  // A cloud that says it HAS rows but sends none is a broken response, not an
  // emptying — refuse regardless of scope, so a tick can never act on it.
  routes = GOOD();
  await sync.syncGateCritical();
  routes = { ...GOOD(), '/season-passes/v2': list([], 7) };
  const inconsistent = await sync.syncGateCritical();
  check('meta.total=7 beside an empty data is refused, not applied',
    !inconsistent.passes.ok && db.mirrorRowCounts().passes === 1,
    `${JSON.stringify(inconsistent.passes)} · counts=${JSON.stringify(db.mirrorRowCounts())}`);

  // --- 6. the header stamp --------------------------------------------------
  // The stamp is the only thing telling staff whether a cloud-issued ban has
  // actually reached this barrier. A gate tick is now the pull that makes that
  // true, so it must move the clock — otherwise staff keep pressing "Sync now"
  // against an already-current cache, which is the habit being retired.
  routes = GOOD();
  const before = sync.getCloudPullState().lastCloudPullAt;
  await new Promise((r) => setTimeout(r, 5));
  await sync.syncGateCritical();
  const after = sync.getCloudPullState().lastCloudPullAt;
  check('a clean gate tick refreshes the "Synced ..." stamp',
    !!after && after !== before, `${before} -> ${after}`);

  // ...but it must not clear an error it never re-tried. /activity-logs 500s
  // here, so the full pull fails and OWNS the error; the gate tick that follows
  // touches none of those mirrors and has no standing to clear it.
  routes = { ...GOOD(), '/activity-logs': () => [500, { message: 'boom' }] };
  await sync.syncAll();
  const fullErr = sync.getCloudPullState().lastCloudPullError;
  check('precondition: a failing full pull leaves an error on display', !!fullErr, fullErr);
  routes = GOOD();
  await sync.syncGateCritical();
  const afterGate = sync.getCloudPullState();
  check("a clean gate tick does NOT clear the full pull's error",
    afterGate.lastCloudPullError === fullErr, `${fullErr} -> ${afterGate.lastCloudPullError}`);
  check('...while still moving the clock it IS entitled to move',
    !!afterGate.lastCloudPullAt, afterGate.lastCloudPullAt);

  // --- 7. timer hygiene -----------------------------------------------------
  // The cadence is fixed and independent of company_settings.sync_interval_minutes:
  // how long a paying customer waits at a barrier must not be tunable into "an hour".
  // Timers do not appear in process._getActiveHandles() on modern node, so count
  // them through getActiveResourcesInfo() and work in DELTAS — electron's own
  // internals hold timers of their own that have nothing to do with us.
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const baseline = timers();
  sync.autoSyncGateCritical();
  check('autoSyncGateCritical() arms a timer', timers() === baseline + 1, `${baseline} -> ${timers()}`);
  sync.autoSyncGateCritical();
  check('...and is idempotent — a second call arms no second timer',
    timers() === baseline + 1, `${baseline} -> ${timers()}`);
  sync.stopAutoSyncGateCritical();
  check('stopAutoSyncGateCritical() clears it', timers() === baseline, `${baseline} -> ${timers()}`);

  // The cadence itself is a DECISION, not an implementation detail: how long a
  // paying customer waits at a barrier holding a valid pass must never become
  // company_settings.sync_interval_minutes, which an operator may raise to spare
  // a thin WAN. Read off the compiled output so a refactor that quietly swaps in
  // the tunable interval fails here rather than in a car park.
  const compiled = fs.readFileSync(path.join(__dirname, '../../dist/main/services/cloud-sync.js'), 'utf8');
  const armBody = compiled.slice(compiled.indexOf('function autoSyncGateCritical'));
  const arm = armBody.slice(0, armBody.indexOf('function stopAutoSyncGateCritical'));
  check('the gate tick is armed from the FIXED constant',
    /GATE_SYNC_INTERVAL_MIN\s*\*\s*60_?000/.test(arm), arm.slice(-120));
  check('...never from the operator-tunable sync_interval_minutes',
    !arm.includes('resolveSyncIntervalMin'), arm.slice(-120));
  check('...and that constant is 5 minutes',
    /GATE_SYNC_INTERVAL_MIN\s*=\s*5\b/.test(compiled),
    (compiled.match(/GATE_SYNC_INTERVAL_MIN\s*=\s*\d+/) || ['<not found>'])[0]);

  finish();
}

main().catch((e) => { out.error = String((e && e.stack) || e); finish(); });
