/**
 * Relay-latency checks, run inside a REAL electron main process (better-sqlite3
 * is built for the electron ABI, and the vendor SDK is loaded by koffi from
 * native/vzsdk — neither works under plain node).
 *
 *   electron tools/relay-latency-check/check.js <resultFile>
 *
 * What this exists to protect (a live defect on 2026-08-12):
 *
 *   VzLPRClient_Open is a SYNCHRONOUS native call. Pointed at an address that
 *   does not answer, it sat on the Electron main process for ~6 SECONDS — no IPC,
 *   no repaint, nothing — because it waits out the SDK's own TCP timeout. Two
 *   paths called it where a person was waiting:
 *
 *     1. Saving a camera. The cameras:save handler runs a relay resync, so saving
 *        a camera took six seconds. Worse, a failed Open recorded nothing, so
 *        `connections` stayed empty and EVERY later save paid it again — renaming
 *        an unrelated camera cost the same six seconds.
 *     2. Raising the barrier. A cold pulse opened a handle on the spot, so a car
 *        arriving at a lane whose camera was offline froze the entire app for six
 *        seconds to reach a failure a socket probe reaches in half a second.
 *
 * The fix gates both on tcpProbe() and makes the warm connect async + backed off.
 * These thresholds are what "fast" means here — they are deliberately an order of
 * magnitude above the measured times (single-digit ms per save) so this fails on
 * the bug coming back, not on a slow machine or a busy CI box.
 *
 * No camera is contacted: the fixture points at a TEST-NET-ish LAN address that
 * nothing answers on, which is exactly the state that used to be slow.
 *
 * Launched by run.mjs. Results go to a JSON file rather than stdout because
 * electron is a Windows GUI-subsystem binary and its console output is unreliable
 * when spawned.
 */
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TZ = 'Asia/Kuala_Lumpur';

const resultFile = process.argv[process.argv.length - 1];

/** Set in the try block; needed by the finally, which has to flush and exit. */
let db = null;
let relay = null;
const out = { ok: false, checks: [], timings: [], error: null };

const check = (name, pass, detail = '') => out.checks.push({ name, pass: !!pass, detail: String(detail) });

/** Run `fn`, record how long it blocked, and return the elapsed ms. */
function timed(label, fn) {
  const startedAt = Date.now();
  let note = '';
  try { note = fn() ?? ''; } catch (e) { note = `threw: ${e.message}`; }
  const ms = Date.now() - startedAt;
  out.timings.push({ label, ms, note: String(note) });
  return ms;
}

/** A save must never make an operator wait on the network. */
const SAVE_BUDGET_MS = 1_000;
/** A cold pulse may probe, but must not wait out a native SDK timeout. */
const PULSE_BUDGET_MS = 2_000;

app.whenReady().then(async () => {
  try {
    app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'qp-relay-latency-')));
    db = require('../../dist/main/services/db');
    relay = require('../../dist/main/services/camera-relay');
    const rtsp = require('../../dist/main/services/camera-rtsp');
    const lpr = require('../../dist/main/services/lpr-webhook');
    db.getDb();

    // Credentials present (so the camera DOES want a relay connection) and an
    // address nothing answers on — an ordinary camera mid-setup, or one unplugged.
    const fixture = {
      name: 'LATENCY-UNREACHABLE', laneId: null, direction: 'entry', accessMode: 'open',
      host: '192.168.243.244', deviceUser: 'admin', devicePassword: 'admin', devicePort: 80,
      webhookPort: 6099, webhookSecret: null, enabled: true,
    };
    const saved = db.upsertCamera(fixture);

    /** Everything cameras:save does after the write. */
    const saveSideEffects = () => { rtsp.resync(); relay.resync(); lpr.startLprServers(); };

    const first = timed('first save (cold: may load the SDK)', saveSideEffects);
    check(`first save side-effects finish inside ${SAVE_BUDGET_MS}ms`, first < SAVE_BUDGET_MS, `${first}ms`);

    // THE regression: a failed connect used to be retried on every resync, so the
    // second save was just as slow as the first.
    const second = timed('second save, nothing changed', () => {
      db.upsertCamera({ ...saved, name: 'LATENCY-RENAMED' });
      saveSideEffects();
    });
    check(`a repeat save is not re-charged for the failed connect (<${SAVE_BUDGET_MS}ms)`,
      second < SAVE_BUDGET_MS, `${second}ms`);

    const hostChanged = timed('save with a changed host (new connect attempt)', () => {
      db.upsertCamera({ ...saved, name: 'LATENCY-RENAMED', host: '192.168.243.245' });
      saveSideEffects();
    });
    check(`editing the host still returns immediately (<${SAVE_BUDGET_MS}ms)`,
      hostChanged < SAVE_BUDGET_MS, `${hostChanged}ms`);

    const removed = timed('delete + resync', () => {
      db.deleteCamera(saved.id);
      saveSideEffects();
    });
    check(`deleting a camera returns immediately (<${SAVE_BUDGET_MS}ms)`, removed < SAVE_BUDGET_MS, `${removed}ms`);

    // ─── the gate path ──────────────────────────────────────────────────────
    const gateCam = db.upsertCamera({ ...fixture, name: 'LATENCY-GATE' });
    const pulseStart = Date.now();
    const pulse = await relay.pulseBarrier(gateCam.id);
    const pulseMs = Date.now() - pulseStart;
    out.timings.push({ label: 'cold pulseBarrier on an unreachable camera', ms: pulseMs, note: JSON.stringify(pulse) });
    check(`a cold pulse on an unreachable camera gives up inside ${PULSE_BUDGET_MS}ms`,
      pulseMs < PULSE_BUDGET_MS, `${pulseMs}ms`);
    // It must FAIL — and say why in terms an operator can act on, since this is
    // the message that reaches the Activity Log when a boom doesn't move.
    check('…and reports the camera as unreachable rather than a bare open_failed',
      pulse.ok === false && /unreachable/i.test(pulse.error ?? ''), JSON.stringify(pulse));

    // Nothing may be left half-registered: a failed connect must not leave a
    // handle behind that a later pulse would try to reuse.
    check('no warm connection is recorded for a camera that never answered',
      relay.warmConnectionCount() === 0, String(relay.warmConnectionCount()));

    lpr.stopLprServers();
    relay.stopCameraRelay();

    // Quitting is itself part of what this harness protects. app.exit(0) does not
    // terminate a process that has loaded VzLPRSDK.dll — it hangs inside native
    // teardown, with the event loop already dead, so no later JS can rescue it.
    // A box left running that way still holds its LPR ports and the next launch
    // hears nothing. index.ts's forceQuit() picks the same escape hatch.
    check('the vendor SDK really was loaded (otherwise the next check proves nothing)',
      relay.isSdkLoaded(), String(relay.isSdkLoaded()));

    out.ok = out.checks.every((c) => c.pass);
  } catch (error) {
    out.error = error?.stack ?? String(error);
  } finally {
    fs.writeFileSync(resultFile, JSON.stringify(out, null, 2));
    db?.closeDb();
    if (relay?.isSdkLoaded()) {
      process.kill(process.pid, 'SIGKILL');   // see the note above
    } else {
      app.exit(0);
    }
  }
});
