/**
 * Drives the REAL driver-facing display service (dist/main/services/lcd-display)
 * against a fake panel — a local TCP server speaking the qparking-lcd protocol —
 * and asserts what lands on the glass.
 *
 * Everything here is the genuine article except the panel itself: real SQLite rows,
 * real socket, real frames, real parkingEvents subscriptions. The events are
 * emitted directly rather than driven through a payment terminal because the
 * failures under test (declined card, dead device, callbacks not running) each need
 * hardware to refuse in a particular way; the flow's contract with the display is
 * the event, so the event is what we exercise.
 *
 * Launched by run.mjs; see the README.
 */
const { app } = require('electron');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

process.env.TZ = 'Asia/Kuala_Lumpur';

const out = { ok: false, checks: [], error: null };
const check = (name, pass, detail = null) => out.checks.push({ name, pass, detail });

/** Mirrors the dwell constants in lcd-display.ts. A deliberate second copy: if
 *  someone shortens a dwell there, these waits still bracket the old value, so the
 *  harness fails loudly instead of quietly testing nothing. */
const FREE_DWELL_MS = 2_500;
const FAILED_FARE_DWELL_MS = 4_000;
/** Slack for the socket round-trip on top of a dwell. */
const SETTLE_MS = 1_200;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A fake qparking-lcd panel: accepts the module's connection, records every frame
 * and acks it the way the real panel does (the module treats an ack as proof the
 * frame is on the glass).
 */
function startFakePanel(name) {
  const frames = [];
  const server = net.createServer((socket) => {
    let rx = '';
    socket.on('data', (chunk) => {
      rx += chunk.toString('utf8');
      let nl;
      while ((nl = rx.indexOf('\n')) >= 0) {
        const line = rx.slice(0, nl).trim();
        rx = rx.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        // Keepalives are not screens — ack and forget, or every assertion below
        // would have to filter them out.
        if (msg.type === 'ping') {
          socket.write(JSON.stringify({ v: 1, type: 'ack', seq: msg.seq, ok: true }) + '\n');
          continue;
        }
        frames.push(msg);
        socket.write(JSON.stringify({ v: 1, type: 'ack', seq: msg.seq, ok: true, screen: msg.screen, device: name }) + '\n');
      }
    });
    socket.on('error', () => { /* the module owns the link; nothing to do here */ });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      name,
      port: server.address().port,
      frames,
      mark: () => frames.length,
      /** Frames since a mark — every assertion here is "what happened after X". */
      since: (mark) => frames.slice(mark),
      close: () => server.close(),
    }));
  });
}

(async () => {
  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-lcd-'));
    app.setPath('userData', tmpDir);

    const db = require('../../dist/main/services/db');
    const flow = require('../../dist/main/services/parking-flow');
    const lcd = require('../../dist/main/services/lcd-display');

    // No cloud, no payment device: this harness is about frames, and an outward
    // call would only add a timeout to every run.
    db.saveSettings({ qparkingBaseUrl: '', qparkingApiKey: '', tngEnabled: false });

    // Two lanes, each with its own panel. The second exists to prove a failure
    // clears the gate the driver is AT and not another barrier on the site.
    const exitPanel = await startFakePanel('Exit A LCD');
    const entryPanel = await startFakePanel('Entry A LCD');
    const exitLcd = db.upsertLcd({ name: 'Exit A LCD', host: '127.0.0.1', port: exitPanel.port, enabled: true });
    const entryLcd = db.upsertLcd({ name: 'Entry A LCD', host: '127.0.0.1', port: entryPanel.port, enabled: true });
    const exitLane = db.upsertLane({ name: 'Exit A', policyId: null, terminalId: null, lcdId: exitLcd.id, enabled: true });
    const entryLane = db.upsertLane({ name: 'Entry A', policyId: null, terminalId: null, lcdId: entryLcd.id, enabled: true });
    const entryCam = db.upsertCamera({
      name: 'Entry cam', laneId: entryLane.id, direction: 'entry', host: '10.0.0.9',
      deviceUser: null, devicePassword: null, devicePort: null, webhookSecret: null, enabled: true,
    });

    lcd.startLcdDisplays();
    await wait(SETTLE_MS);
    check('the lane resolves to a live panel', !!db.getLaneLcd(exitLane.id));

    let seq = 0;
    /** An open stay on the ENTRY lane — the shape every case starts from: a car
     *  inside, so its row carries no exit lane yet. */
    const openStay = () => db.createEntrySession('CAR' + (++seq) + 'X', entryLane.id, entryCam.id, null);
    /** The fare frame the flow emits once a stay is priced, on the EXIT lane. */
    const showFare = (session, feeCents = 500) => flow.parkingEvents.emit('exit-pending', {
      session, lane: { id: exitLane.id }, policy: { currency: 'RM' },
      durationMinutes: 135, feeCents,
    });
    const warn = (payload) => flow.parkingEvents.emit('warning', payload);
    const screens = (frames) => frames
      .map((f) => f.screen + (f.free ? ':free' : '') + (f.amountCents != null ? ':' + f.amountCents : ''))
      .join(' → ');

    // ── 1. a failed charge takes the dead fare off the glass ─────────────────
    {
      const s = openStay();
      const mark = exitPanel.mark();
      showFare(s);
      warn({ kind: 'exit-timeout', sessionId: s.id, transactionId: 1 });
      await wait(FAILED_FARE_DWELL_MS + SETTLE_MS);
      const got = screens(exitPanel.since(mark));
      check('a timed-out charge clears the fare back to idle', got === 'exit:500 → idle', got);
    }

    // ── 2. …but not while another attempt is armed ───────────────────────────
    {
      const s = openStay();
      const mark = exitPanel.mark();
      showFare(s);
      // Exactly the order the flow emits: the failure, then the retry
      // announcement in the same tick.
      warn({ kind: 'exit-timeout', sessionId: s.id, transactionId: 2 });
      warn({ kind: 'exit-auto-retrigger', sessionId: s.id, laneId: exitLane.id, attempt: 1, max: 3 });
      await wait(FAILED_FARE_DWELL_MS + SETTLE_MS);
      const got = screens(exitPanel.since(mark));
      check('an armed auto-retrigger keeps the fare on screen', got === 'exit:500', got);
    }

    // ── 3. out of automatic attempts → the fare goes ─────────────────────────
    {
      const s = openStay();
      const mark = exitPanel.mark();
      showFare(s);
      warn({ kind: 'exit-timeout', sessionId: s.id, transactionId: 3 });
      warn({ kind: 'exit-auto-retrigger-capped', sessionId: s.id, plate: s.plate, laneId: exitLane.id, attempts: 3 });
      await wait(FAILED_FARE_DWELL_MS + SETTLE_MS);
      const got = screens(exitPanel.since(mark));
      check('a capped retry cycle clears the fare', got === 'exit:500 → idle', got);
    }

    // ── 4. a declined card with no retry armed clears too ────────────────────
    {
      const s = openStay();
      const mark = exitPanel.mark();
      showFare(s);
      flow.parkingEvents.emit('exit-declined', { sessionId: s.id, transactionId: 4 });
      await wait(FAILED_FARE_DWELL_MS + SETTLE_MS);
      const got = screens(exitPanel.since(mark));
      check('a declined card clears the fare', got === 'exit:500 → idle', got);
    }

    // ── 5. a retrigger's fresh fare is not wiped by the previous idle ────────
    // The regression this guards: the idle queued by the FAILED attempt firing
    // after the operator retriggered, blanking a fare the driver was about to pay.
    {
      const s = openStay();
      const mark = exitPanel.mark();
      showFare(s);
      flow.parkingEvents.emit('exit-declined', { sessionId: s.id, transactionId: 5 });
      await wait(500);
      showFare(s); // ← the retrigger, mid-dwell
      await wait(FAILED_FARE_DWELL_MS + SETTLE_MS);
      const got = screens(exitPanel.since(mark));
      check('a retriggered fare survives the queued idle', got === 'exit:500 → exit:500', got);
    }

    // ── 6. a duplicate read for another car must not clear this one ──────────
    {
      const s = openStay();
      const mark = exitPanel.mark();
      showFare(s);
      warn({ kind: 'exit-busy', laneId: exitLane.id });
      await wait(FAILED_FARE_DWELL_MS + SETTLE_MS);
      const got = screens(exitPanel.since(mark));
      check('exit-busy leaves the fare alone (it belongs to the charging car)', got === 'exit:500', got);
    }

    // ── 7. the failure clears the gate the driver is at ──────────────────────
    // The session's own row points at the ENTRY lane (it is still open, so it has
    // no exit lane). Resolving the panel from the row would blank the wrong gate.
    {
      const s = openStay();
      const exitMark = exitPanel.mark();
      const entryMark = entryPanel.mark();
      showFare(s);
      warn({ kind: 'exit-timeout', sessionId: s.id, transactionId: 7 });
      await wait(FAILED_FARE_DWELL_MS + SETTLE_MS);
      const atExit = screens(exitPanel.since(exitMark));
      const atEntry = screens(entryPanel.since(entryMark));
      check('clears the panel that showed the fare, not the session\'s entry lane',
        atExit === 'exit:500 → idle' && atEntry === '', 'exit=[' + atExit + '] entry=[' + atEntry + ']');
    }

    // ── 8. manual release: FREE, then THANK YOU ─────────────────────────────
    {
      const s = openStay();
      const mark = exitPanel.mark();
      showFare(s);
      lcd.showManualReleaseOnLane(exitLane.id, s);
      await wait(FREE_DWELL_MS + SETTLE_MS);
      check('a manual release shows FREE then THANK YOU',
        screens(exitPanel.since(mark)) === 'exit:500 → exit:free:0 → thankyou', screens(exitPanel.since(mark)));
      // And it must not leave a failed-charge idle armed behind it.
      await wait(FAILED_FARE_DWELL_MS);
      check('…and nothing blanks the panel afterwards',
        !screens(exitPanel.since(mark)).includes('idle'), screens(exitPanel.since(mark)));
    }

    // ── 9. deleting / rewriting the record clears its fare ──────────────────
    {
      const s = openStay();
      const mark = exitPanel.mark();
      showFare(s);
      lcd.clearFareForSession(s.id, 'harness: session deleted');
      await wait(SETTLE_MS);
      const got = screens(exitPanel.since(mark));
      check('deleting the session clears its fare at once', got === 'exit:500 → idle', got);
    }

    // ── 10. …and only that session's fare ───────────────────────────────────
    // An operator deleting a closed row from last Tuesday must not blank the fare
    // of the car at the barrier right now.
    {
      const onScreen = openStay();
      const unrelated = openStay();
      const mark = exitPanel.mark();
      showFare(onScreen);
      lcd.clearFareForSession(unrelated.id, 'harness: unrelated row deleted');
      await wait(SETTLE_MS);
      const got = screens(exitPanel.since(mark));
      check('clearing an unrelated session leaves the live fare up', got === 'exit:500', got);
    }

    // ── 11. a settled exit still thanks the driver ──────────────────────────
    // Regression guard on the refactor: FREE→THANK YOU is now shared code.
    {
      const s = openStay();
      const mark = exitPanel.mark();
      showFare(s);
      db.recordExit(s.id, {
        exitAt: new Date().toISOString(), exitLaneId: exitLane.id, exitCameraId: entryCam.id,
        exitImagePath: null, durationMinutes: 135, feeCents: 500, paymentStatus: 'paid',
        terminalTxnId: null, freeReason: null,
      });
      flow.parkingEvents.emit('exit-completed', { sessionId: s.id, outcome: 'paid' });
      await wait(SETTLE_MS);
      const got = screens(exitPanel.since(mark));
      check('a paid exit goes straight to THANK YOU', got === 'exit:500 → thankyou', got);
    }

    // ── 12. a pass holder, who never saw a fare, is told why it was free ────
    {
      const s = openStay();
      const mark = exitPanel.mark();
      db.recordExit(s.id, {
        exitAt: new Date().toISOString(), exitLaneId: exitLane.id, exitCameraId: entryCam.id,
        exitImagePath: null, durationMinutes: 30, feeCents: 0, paymentStatus: 'free',
        terminalTxnId: null, freeReason: 'pass',
      });
      flow.parkingEvents.emit('exit-completed', { sessionId: s.id, outcome: 'free' });
      await wait(FREE_DWELL_MS + SETTLE_MS);
      const got = screens(exitPanel.since(mark));
      check('a pass exit shows FREE then THANK YOU', got === 'exit:free:0 → thankyou', got);
    }

    exitPanel.close();
    entryPanel.close();
    lcd.stopLcdDisplays();
    out.ok = out.checks.every((c) => c.pass);
  } catch (e) {
    out.error = (e && e.stack) ? e.stack : String(e);
  } finally {
    fs.writeFileSync(process.argv[process.argv.length - 1], JSON.stringify(out, null, 2));
    app.quit();
  }
})();
