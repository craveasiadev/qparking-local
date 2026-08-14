/**
 * Gate-decision PARITY harness.
 *
 * Runs tests/fixtures/gate-decisions.json — the SAME file the cloud's
 * GateDecisionTest runs — against this box's real entry path
 * (lprEvents → handlePlateEvent → handleEntry).
 *
 * The cloud decides entry in PHP and the box decides it in TypeScript. Two
 * implementations of one rule drift silently unless something forces them to
 * agree; this file is that something. If the two ever disagree, one of the two
 * suites goes red.
 *
 * Fixture verdict → observable local behaviour, on an `open` camera:
 *
 *   allow_free        session IS created (car admitted)
 *   deny_quota_full   NO session (pass valid, but its other cars fill it)
 *   deny_blacklist    NO session (banned plate never gets a session)
 *   no_pass           session IS created — falls through to the hourly flow
 *   no_vehicle        session IS created — an unknown plate is a transient
 *
 * EXIT-direction cases are NOT run here: the box's exit path is fee maths and
 * terminal I/O, covered by test:fees and test:sessions. They are counted and
 * reported as skipped rather than silently dropped.
 */
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TZ = 'Asia/Kuala_Lumpur';

const out = { ok: false, checks: [], skipped: 0, error: null };
const check = (name, pass, detail = null) => out.checks.push({ name, pass, detail });

(async () => {
	try {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-gate-parity-'));
		app.setPath('userData', tmpDir);

		const db = require('../../dist/main/services/db');
		const flow = require('../../dist/main/services/parking-flow');
		const { lprEvents } = require('../../dist/main/services/lpr-webhook');

		db.saveSettings({
			qparkingBaseUrl: '', qparkingApiKey: '',
			tngEnabled: false,
			exitGracePeriodSeconds: 90,
		});

		const lane = db.upsertLane({ name: 'L1', policyId: null, terminalId: null, enabled: true });
		const cam = db.upsertCamera({
			name: 'C1', laneId: lane.id, direction: 'entry', host: '10.0.0.9',
			deviceUser: null, devicePassword: null, devicePort: null, webhookSecret: null, enabled: true,
		});

		flow.startParkingFlow();

		const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'gate-decisions.json'), 'utf8'));

		/** Verdicts that must leave NO session behind. */
		const DENIES = new Set(['deny_blacklist', 'deny_quota_full']);

		let caseIndex = 0;
		for (const testCase of fixture.cases) {
			if ((testCase.direction ?? 'entry') !== 'entry') {
				out.skipped++;
				continue;
			}
			caseIndex++;

			// Fresh world per case — the fixture describes each in isolation.
			db.replaceAllSeasonPasses([]);
			db.replaceAllBlockedPlates([]);
			for (const open of db.listOpenSessions?.() ?? []) {
				db.recordExit(open.id, {
					exitAt: new Date().toISOString(), exitLaneId: lane.id, exitCameraId: cam.id,
					exitImagePath: null, durationMinutes: 1, feeCents: 0,
					paymentStatus: 'free', terminalTxnId: null, freeReason: 'rate-zero',
				});
			}

			const plateCount = Math.max(1, testCase.plates_on_pass ?? 1);
			const plates = [];
			for (let i = 0; i < plateCount; i++) plates.push(`PAR${caseIndex}X${i}`);

			const arrivingIndex = testCase.arriving_index ?? 0;
			const arriving = (testCase.registered === false) ? `UNKNOWN${caseIndex}` : plates[arrivingIndex];

			if (testCase.blacklisted) {
				db.replaceAllBlockedPlates([{ plateNumber: arriving, vehicleId: null, reason: 'fixture' }]);
			}

			if (testCase.pass && testCase.registered !== false) {
				const spec = testCase.pass;
				// other_site passes are simply absent from THIS box's roster —
				// the local cache is site-scoped by construction.
				if (!spec.other_site) {
					const day = (offset) => {
						const d = new Date();
						d.setDate(d.getDate() + offset);
						return d.toISOString().slice(0, 10);
					};
					const endOffset = Object.prototype.hasOwnProperty.call(spec, 'end_offset_days')
						? spec.end_offset_days
						: 30;
					const limit = spec.concurrent_limit ?? Math.max(1, spec.bays ?? 0);

					db.replaceAllSeasonPasses(plates.map((plateNumber) => ({
						passId: `pass-${caseIndex}`,
						plateNumber,
						passType: 'season',
						status: spec.status ?? 'active',
						startDate: day(spec.start_offset_days ?? -1),
						endDate: endOffset === null ? null : day(endOffset),
						isFree: true,
						spaceNumber: null,
						concurrentLimit: limit,
						role: 'season',
						fetchedAt: new Date().toISOString(),
					})));
				}
			}

			for (const insideIndex of testCase.already_inside ?? []) {
				if (plates[insideIndex] === arriving) continue; // rescan case: seeded below
				db.createEntrySession(plates[insideIndex], lane.id, cam.id, null);
			}
			// The rescan case needs the ARRIVING plate itself already inside.
			if ((testCase.already_inside ?? []).includes(arrivingIndex)) {
				db.createEntrySession(arriving, lane.id, cam.id, null);
			}

			const before = !!db.findOpenSessionByPlate(arriving);

			lprEvents.emit('plate', {
				cameraId: cam.id, plate: arriving, confidence: 1, imagePath: null,
				timestamp: new Date().toISOString(), direction: 'entry',
			});
			await new Promise((r) => setTimeout(r, 30));

			const after = !!db.findOpenSessionByPlate(arriving);
			const shouldDeny = DENIES.has(testCase.expect);
			// A denial must not have CREATED one; if the plate was already inside
			// (rescan), it legitimately stays inside.
			const pass = shouldDeny ? (after === before) : after;

			check(
				`${testCase.name} → ${testCase.expect}`,
				pass,
				`sessionBefore=${before} sessionAfter=${after} expected=${shouldDeny ? 'no new session' : 'session present'}`,
			);
		}

		out.ok = true;
	} catch (e) {
		out.error = e && e.stack ? e.stack : String(e);
	} finally {
		fs.writeFileSync(process.argv[process.argv.length - 1], JSON.stringify(out, null, 2));
		app.quit();
	}
})();
