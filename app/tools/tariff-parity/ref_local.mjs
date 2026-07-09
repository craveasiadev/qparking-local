/**
 * Runs Repo A's REAL computeFee logic against scenarios.json.
 *   TZ='Asia/Kuala_Lumpur' node ref_local.mjs scenarios.json
 *
 * computeFee + helpers below are COPIED VERBATIM from
 *   app/src/main/services/parking-flow.ts  (branch 080726_yl)
 * with only TypeScript type annotations stripped. Re-copy if the source changes.
 * NOTE: as of 2026-07-09 the vehicle-type dimension is retired — pricing is
 * lane → rate policy → day/time/date only.
 */
import { readFileSync } from 'node:fs';

// ─────────── VERBATIM COPY START (schedule path + internals) ───────────
function computeFee(durationMinutes, scope, entryAt) {
  if (!scope) return 0;

  if (!scope.rules || scope.rules.length === 0) {
    const billable = Math.max(0, durationMinutes - scope.freeMinutes);
    if (billable === 0) return 0;
    const blocks = Math.ceil(billable / Math.max(1, scope.blockMinutes));
    let cents = scope.firstBlockCents + Math.max(0, blocks - 1) * scope.perBlockCents;
    if (scope.dailyCapCents > 0 && cents > scope.dailyCapCents) cents = scope.dailyCapCents;
    return cents;
  }

  const exitMs = Date.now();
  const entryMs = entryAt ? new Date(entryAt).getTime() : exitMs - durationMinutes * 60_000;
  if (exitMs <= entryMs) return 0;

  const durMin = diffFloorMinutes(entryMs, exitMs);
  const grace = Math.max(0, scope.freeMinutes || 0);
  if (durMin <= grace) return 0;

  const billStartMs = scope.graceExceededBehavior === 'charge_from_grace_end'
    ? entryMs + grace * 60_000
    : entryMs;

  let rulesForStay = scope.rules;
  if ((scope.rateBasis ?? 'occupancy') === 'entry') {
    const entryRule = pickRuleAtMoment(entryMs, scope.rules, false);
    if (entryRule) {
      rulesForStay = [{
        ...entryRule,
        timeFrom: '00:00:00',
        timeTo: '23:59:59',
        daysOfWeek: null,
        validFrom: null,
        validTo: null,
        isOvernight: false,
      }];
    }
  }

  const cycles = buildBillingCycles(billStartMs, exitMs, scope);
  const carryBlocks = !!scope.firstBlockOncePerEntry && !!scope.cutoffEnabled;
  const flatMode = ['sum', 'entry', 'highest', 'per_day'].includes(scope.flatMultiRate ?? 'sum')
    ? (scope.flatMultiRate ?? 'sum')
    : 'sum';
  const policyCap = scope.dailyCapCents && scope.dailyCapCents > 0 ? scope.dailyCapCents : null;

  let total = 0;
  let blockMinutes = 0;
  for (let idx = 0; idx < cycles.length; idx++) {
    const [cs, ce] = cycles[idx];
    if (idx > 0 && scope.cutoffBehavior === 'new_day_fixed_fee') {
      total += scope.newDayFixedFeeCents ?? 0;
      continue;
    }
    const preferOvernight = idx > 0 && scope.cutoffBehavior === 'overnight_tariff';
    const res = priceBillingCycle(
      cs, ce, rulesForStay, preferOvernight, policyCap,
      carryBlocks ? blockMinutes : 0, flatMode,
    );
    if (carryBlocks) blockMinutes = res.blockMinutesAfter;
    total += res.total;
  }
  return total;
}

function ymdLocal(ms) {
  const d = new Date(ms); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function hmsLocal(ms) {
  const d = new Date(ms); const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function startOfNextDayMs(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
}
function setTimeOnMs(ms, h, m, s) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, s, 0).getTime();
}
function addOneDayMs(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, d.getHours(), d.getMinutes(), d.getSeconds(), 0).getTime();
}
function diffFloorMinutes(aMs, bMs) {
  return Math.floor((bMs - aMs) / 60_000);
}
function normTime(v) {
  let s = String(v ?? '');
  if (s.length === 5) s += ':00';
  if (s === '23:59:00' || s === '23:59:59') return '24:00:00';
  return s;
}

function ruleMatchesAtMoment(r, atMs) {
  if (r.isActive === false) return false;
  const date = ymdLocal(atMs);
  if (r.validFrom && date < r.validFrom) return false;
  if (r.validTo && date > r.validTo) return false;
  if (Array.isArray(r.daysOfWeek) && r.daysOfWeek.length > 0) {
    if (!r.daysOfWeek.includes(new Date(atMs).getDay())) return false;
  }
  const now = hmsLocal(atMs);
  const from = normTime(r.timeFrom);
  const to = normTime(r.timeTo);
  if (from === to) return true;
  if (from < to) return now >= from && now < to;
  return now >= from || now < to;
}

function pickRuleAtMoment(atMs, rules, preferOvernight) {
  let matches = rules.filter((r) => ruleMatchesAtMoment(r, atMs));
  if (matches.length === 0) return null;
  if (preferOvernight) {
    const on = matches.filter((r) => r.isOvernight);
    if (on.length > 0) matches = on;
  }
  return matches.slice().sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return (b.isOvernight ? 1 : 0) - (a.isOvernight ? 1 : 0);
  })[0];
}

function nextBoundaryMsV2(cursorMs, cycleEndMs, rule) {
  const candidates = [cycleEndMs];
  const to = normTime(rule.timeTo);
  const from = normTime(rule.timeFrom);
  let ruleEnd;
  if (to === '24:00:00') {
    ruleEnd = startOfNextDayMs(cursorMs);
  } else {
    const [h, m, s] = to.split(':').map((n) => Number(n));
    ruleEnd = setTimeOnMs(cursorMs, h || 0, m || 0, s || 0);
  }
  if (from < to) {
    if (ruleEnd <= cursorMs) ruleEnd = addOneDayMs(ruleEnd);
  } else {
    if (!(hmsLocal(cursorMs) < to)) ruleEnd = addOneDayMs(ruleEnd);
  }
  candidates.push(ruleEnd);
  candidates.push(startOfNextDayMs(cursorMs));
  let earliest = null;
  for (const c of candidates) {
    if (c > cursorMs && (earliest === null || c < earliest)) earliest = c;
  }
  return earliest ?? cycleEndMs;
}

function priceBlockHourlyCents(minutes, rule, prior = 0) {
  if (minutes <= 0) return 0;
  const firstAmt = rule.firstBlockAmountCents || 0;
  const firstMin = Math.max(1, rule.firstBlockMinutes || 60);
  const subAmt = rule.subsequentBlockAmountCents || 0;
  const subMin = Math.max(1, rule.subsequentBlockMinutes || 60);
  if (prior >= firstMin) return Math.ceil(minutes / subMin) * subAmt;
  if (prior + minutes <= firstMin) return firstAmt;
  const extra = (prior + minutes) - firstMin;
  return firstAmt + Math.ceil(extra / subMin) * subAmt;
}

function buildBillingCycles(startMs, endMs, scope) {
  if (!scope.cutoffEnabled) return [[startMs, endMs]];
  const parts = String(scope.cutoffTime ?? '00:00:00').split(':');
  const h = Number(parts[0]) || 0, m = Number(parts[1]) || 0, s = Number(parts[2]) || 0;
  const cycles = [];
  let segStart = startMs;
  let next = setTimeOnMs(segStart, h, m, s);
  if (next <= segStart) next = addOneDayMs(next);
  let guard = 0;
  while (next < endMs && guard++ < 3660) {
    cycles.push([segStart, next]);
    segStart = next;
    next = addOneDayMs(next);
  }
  cycles.push([segStart, endMs]);
  return cycles;
}

function priceBillingCycle(cycleStartMs, cycleEndMs, rules, preferOvernight, policyCapCents, priorBlockMinutes, flatMode) {
  const segs = [];
  const flatSegIdx = [];
  const ruleCaps = {};
  let blockMinutes = priorBlockMinutes;
  let hasHourly = false;
  let cursor = cycleStartMs;
  let guard = 0;
  while (cursor < cycleEndMs && guard++ < 100_000) {
    const rule = pickRuleAtMoment(cursor, rules, preferOvernight);
    if (!rule) {
      cursor = Math.min(startOfNextDayMs(cursor), cycleEndMs);
      continue;
    }
    const boundary = nextBoundaryMsV2(cursor, cycleEndMs, rule);
    const segMinutes = diffFloorMinutes(cursor, boundary);
    const isFlat = rule.ruleType === 'flat_rate';
    let amount;
    if (isFlat) {
      amount = rule.flatAmountCents || 0;
    } else {
      amount = priceBlockHourlyCents(segMinutes, rule, blockMinutes);
      blockMinutes += segMinutes;
      hasHourly = true;
      if ((rule.dailyCapCents || 0) > 0) ruleCaps[rule.ruleId] = rule.dailyCapCents;
    }
    segs.push({ ruleId: rule.ruleId, isFlat, amount });
    if (isFlat) flatSegIdx.push(segs.length - 1);
    cursor = boundary;
  }

  if (flatSegIdx.length > 0) {
    if (flatMode === 'per_day') {
      // keep all
    } else if (flatMode === 'entry') {
      const keep = flatSegIdx[0];
      for (const si of flatSegIdx) if (si !== keep) segs[si].amount = 0;
    } else if (flatMode === 'highest') {
      let keep = flatSegIdx[0];
      for (const si of flatSegIdx) if (segs[si].amount > segs[keep].amount) keep = si;
      for (const si of flatSegIdx) if (si !== keep) segs[si].amount = 0;
    } else {
      const seen = new Set();
      for (const si of flatSegIdx) {
        if (seen.has(segs[si].ruleId)) segs[si].amount = 0;
        else seen.add(segs[si].ruleId);
      }
    }
  }

  let total = segs.reduce((a, sg) => a + sg.amount, 0);

  const caps = Object.values(ruleCaps);
  if (policyCapCents !== null) caps.push(policyCapCents);
  if (hasHourly && caps.length > 0) {
    const cap = Math.min(...caps);
    if (total > cap) total = cap;
  }

  return { total, blockMinutesAfter: blockMinutes };
}
// ─────────── VERBATIM COPY END ───────────

function mapRule(r, i, id) {
  return {
    ruleId: `rule-${id}-${i}`,
    name: r.name,
    priority: r.priority,
    daysOfWeek: r.days_of_week,
    timeFrom: r.time_from,
    timeTo: r.time_to,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    ruleType: r.rule_type,
    flatAmountCents: r.flat_amount_cents,
    firstBlockAmountCents: r.first_block_amount_cents,
    firstBlockMinutes: r.first_block_minutes,
    subsequentBlockAmountCents: r.subsequent_block_amount_cents,
    subsequentBlockMinutes: r.subsequent_block_minutes,
    dailyCapCents: r.daily_cap_cents ?? 0,
    isOvernight: r.is_overnight,
    isActive: r.is_active,
  };
}

const path = process.argv[2] ?? 'scenarios.json';
const scenarios = JSON.parse(readFileSync(path, 'utf8'));
const realNow = Date.now;
const out = [];

for (const sc of scenarios) {
  const p = sc.policy;
  const scope = {
    scopeId: sc.id,
    scopeName: sc.id,
    freeMinutes: p.grace_minutes,
    firstBlockCents: 0,
    perBlockCents: 0,
    blockMinutes: 60,
    dailyCapCents: p.daily_cap_cents ?? 0,
    currency: 'MYR',
    rules: sc.rules.map((r, i) => mapRule(r, i, sc.id)),
    graceExceededBehavior: p.grace_exceeded_behavior ?? null,
    cutoffEnabled: !!p.cutoff_enabled,
    cutoffTime: p.cutoff_time ?? null,
    cutoffBehavior: p.cutoff_behavior ?? null,
    newDayFixedFeeCents: p.new_day_fixed_fee_cents ?? null,
    rateBasis: p.rate_basis ?? null,
    flatMultiRate: p.flat_multi_rate ?? null,
    firstBlockOncePerEntry: !!p.first_block_once_per_entry,
  };
  const entryMs = new Date(sc.entry).getTime();
  const exitMs = new Date(sc.exit).getTime();
  const durationMinutes = Math.round((exitMs - entryMs) / 60_000);
  try {
    Date.now = () => exitMs;
    const feeCents = computeFee(durationMinutes, scope, sc.entry);
    out.push({ id: sc.id, total_cents: feeCents });
  } catch (e) {
    out.push({ id: sc.id, error: String(e && e.message || e) });
  } finally {
    Date.now = realNow;
  }
}

console.log(JSON.stringify(out, null, 2));
