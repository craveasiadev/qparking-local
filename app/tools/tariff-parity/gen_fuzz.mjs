/**
 * Generate N randomized parity scenarios into scenarios.fuzz.json.
 * Every scenario includes an always-on 24h fallback block rule so the cloud
 * (which throws on uncovered moments) always returns a number — isolating real
 * math differences rather than coverage-gap errors.
 *   node gen_fuzz.mjs 500 > scenarios.fuzz.json
 */
const N = Number(process.argv[2] || 500);
const R = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[R(arr.length)];
const pad = (n) => String(n).padStart(2, '0');

// minutes since 2026-03-01T00:00:00+08:00 -> ISO with +08:00 (kept within March)
function iso(mins) {
  const day = Math.floor(mins / 1440);
  const rem = mins % 1440;
  const dom = 1 + day;
  return `2026-03-${pad(dom)}T${pad(Math.floor(rem / 60))}:${pad(rem % 60)}:00+08:00`;
}

const WINDOWS = [
  ['00:00:00', '23:59:59'], // all day
  ['06:00:00', '18:00:00'], // daytime
  ['18:00:00', '06:00:00'], // overnight wrap
  ['08:00:00', '20:00:00'],
  ['22:00:00', '07:00:00'], // wrap
];
const DOW = [null, null, [1, 2, 3, 4, 5], [0, 6], [0, 1, 2, 3, 4, 5, 6]];

function randRule(i, forceAllDay) {
  const isFlat = !forceAllDay && Math.random() < 0.3;
  const win = forceAllDay ? WINDOWS[0] : pick(WINDOWS);
  return {
    name: forceAllDay ? 'Fallback' : `R${i}`,
    priority: forceAllDay ? 0 : R(20),
    vehicle_type: null,
    days_of_week: forceAllDay ? null : pick(DOW),
    time_from: win[0],
    time_to: win[1],
    valid_from: null,
    valid_to: null,
    rule_type: isFlat ? 'flat_rate' : 'block_hourly',
    flat_amount_cents: isFlat ? (R(20) + 1) * 100 : 0,
    first_block_amount_cents: (R(10) + 1) * 100,
    first_block_minutes: pick([15, 30, 60, 90, 120]),
    subsequent_block_amount_cents: (R(8) + 1) * 100,
    subsequent_block_minutes: pick([15, 30, 60]),
    daily_cap_cents: Math.random() < 0.4 ? (R(50) + 5) * 100 : null,
    is_overnight: win[0] > win[1],
    // Fallback is always active so every moment is covered (cloud never throws);
    // extra rules stay randomly active/inactive to exercise the is_active filter.
    is_active: forceAllDay ? true : Math.random() < 0.9,
  };
}

const scenarios = [];
for (let n = 0; n < N; n++) {
  const startMin = R(1440 * 12);          // within first ~12 days of March
  const durMin = R(4000) + 1;             // 1 min .. ~2.7 days
  const nExtra = R(3);                    // 0..2 extra rules
  const rules = [randRule(0, true)];
  for (let i = 1; i <= nExtra; i++) rules.push(randRule(i, false));

  const cutoffEnabled = Math.random() < 0.5;
  scenarios.push({
    id: `F${n}`,
    desc: 'fuzz',
    entry: iso(startMin),
    exit: iso(startMin + durMin),
    vehicleType: null,
    policy: {
      grace_minutes: pick([0, 0, 10, 15, 30]),
      grace_exceeded_behavior: pick(['charge_from_entry', 'charge_from_grace_end']),
      rate_basis: pick(['occupancy', 'occupancy', 'entry']),
      flat_multi_rate: pick(['sum', 'entry', 'highest', 'per_day']),
      first_block_once_per_entry: Math.random() < 0.5,
      cutoff_enabled: cutoffEnabled,
      cutoff_time: pick(['00:00:00', '06:00:00', '03:00:00']),
      cutoff_behavior: cutoffEnabled ? pick(['restart', 'new_day_fixed_fee', 'overnight_tariff']) : 'restart',
      new_day_fixed_fee_cents: Math.random() < 0.5 ? (R(30) + 1) * 100 : null,
      daily_cap_cents: Math.random() < 0.4 ? (R(80) + 10) * 100 : null,
    },
    rules,
  });
}
console.log(JSON.stringify(scenarios, null, 0));
