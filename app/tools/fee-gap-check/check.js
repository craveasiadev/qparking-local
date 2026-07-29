/**
 * Exercises the REAL compiled computeFee on rate plans with COVERAGE GAPS —
 * moments no active tariff rule covers. Launched by run.mjs; see the README.
 *
 * Expected values are hand-computed in each case's comment, deliberately, so the
 * test asserts what the tariff SHOULD be rather than whatever the code happens to
 * return today.
 */
require('../../dist/main/tz');                 // pin TZ to Asia/Kuala_Lumpur first
const { computeFee } = require('../../dist/main/services/parking-flow');
const fs = require('node:fs');

const rule = (over = {}) => ({
  ruleId: over.ruleId || 'r1', name: 'R', priority: 0, daysOfWeek: null,
  timeFrom: '00:00:00', timeTo: '23:59:59', validFrom: null, validTo: null,
  ruleType: 'block_hourly', flatAmountCents: 0,
  firstBlockAmountCents: 300, firstBlockMinutes: 60,
  subsequentBlockAmountCents: 200, subsequentBlockMinutes: 60,
  dailyCapCents: 0, isOvernight: false, isActive: true, ...over,
});
const policy = (rules, over = {}) => ({
  policyId: 'p1', policyName: 'P', freeMinutes: 0,
  firstBlockCents: 300, perBlockCents: 200, blockMinutes: 60, dailyCapCents: 0,
  currency: 'MYR', fetchedAt: new Date(0).toISOString(),
  graceExceededBehavior: 'charge_from_entry', cutoffEnabled: false, cutoffTime: null,
  cutoffBehavior: null, newDayFixedFeeCents: null, rateBasis: 'occupancy',
  flatMultiRate: 'sum', firstBlockOncePerEntry: false, policyDailyCapCents: null,
  isSiteDefault: false, rules, ...over,
});

const DAY = [8, 22]; // the classic "daytime only" policy that creates a gap
const daytime = [rule({ timeFrom: '08:00:00', timeTo: '22:00:00' })];

const CASES = [
  {
    id: 'A gap-overnight-into-next-day',
    why: 'enters inside the gap, exits mid-morning: 08:00-12:00 = 240min billable',
    policy: policy(daytime),
    entry: '2026-07-28T23:00:00+08:00', exit: '2026-07-29T12:00:00+08:00',
    expect: 900, // 300 (first 60) + ceil(180/60)*200
  },
  {
    id: 'B no-gap-24h-rule (regression guard)',
    why: 'fully covered policy — must be untouched by the gap change',
    policy: policy([rule()]),
    entry: '2026-07-28T10:00:00+08:00', exit: '2026-07-28T11:30:00+08:00',
    expect: 500, // 300 + ceil(30/60)*200
  },
  {
    id: 'C gap-trailing-same-day',
    why: 'covered 09:00-12:00 then an uncovered tail — was already correct',
    policy: policy([rule({ timeFrom: '08:00:00', timeTo: '12:00:00' })]),
    entry: '2026-07-28T09:00:00+08:00', exit: '2026-07-28T15:00:00+08:00',
    expect: 700, // 180min: 300 + ceil(120/60)*200
  },
  {
    id: 'D gap-short-morning-tail',
    why: 'enters in the gap, exits 09:00: only 08:00-09:00 billable',
    policy: policy(daytime),
    entry: '2026-07-28T23:00:00+08:00', exit: '2026-07-29T09:00:00+08:00',
    expect: 300,
  },
  {
    id: 'E never-covered (termination guard)',
    why: 'rule only valid Sundays, stay is Tue->Wed: 0, and must not hang',
    policy: policy([rule({ daysOfWeek: [0] })]),
    entry: '2026-07-28T10:00:00+08:00', exit: '2026-07-29T10:00:00+08:00',
    expect: 0,
  },
  {
    id: 'F multi-day gap policy',
    why: '3 nights in a daytime-only policy: 3 full 08:00-22:00 days + a tail',
    policy: policy(daytime),
    entry: '2026-07-28T23:00:00+08:00', exit: '2026-07-31T10:00:00+08:00',
    // 29th 08-22 = 840min, 30th 08-22 = 840min, 31st 08-10 = 120min.
    // Block minutes carry across the whole stay (firstBlockOncePerEntry=false, so
    // each priceBillingCycle call is one cycle here — cutoff disabled = 1 cycle).
    // 1800min total: 300 + ceil(1740/60)*200 = 300 + 29*200 = 6100
    expect: 6100,
  },
];

const out = [];
for (const c of CASES) {
  const durationMinutes = Math.max(0, Math.floor((Date.parse(c.exit) - Date.parse(c.entry)) / 60000));
  const started = Date.now();
  let got = null, err = null;
  try { got = computeFee(durationMinutes, c.policy, c.entry, c.exit); }
  catch (e) { err = e.message; }
  out.push({
    id: c.id, why: c.why, durationMinutes,
    expect: c.expect, got, err, pass: got === c.expect,
    elapsedMs: Date.now() - started,
  });
}
fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2));
process.exit(out.every((r) => r.pass) ? 0 : 1);
