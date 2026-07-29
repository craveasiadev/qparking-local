# Coverage-gap fee harness

Prices rate plans that have a **coverage gap** — a moment no active tariff rule
covers — through the real `computeFee` in
`app/src/main/services/parking-flow.ts`.

## Why this is separate from `tools/tariff-parity`

The parity harness can't test this. On an uncovered moment the cloud
`TariffCalculator` **throws** (it treats a gap as misconfiguration), so there is no
cloud number to compare against; parity reports those cases as
`cloud-throw(skipped)`. The gate, meanwhile, must never crash mid-exit, so it has
its own deliberate local-only fallback — and that fallback was untested until now.

## The bug this catches (fixed 2026-07-29)

On an uncovered moment the walker jumped to **midnight**, which skipped every
*covered* hour of the following day too, not just the gap. Measured against the
same scenarios below, before the fix:

| scenario | correct | pre-fix |
|---|---|---|
| enters 23:00 in a 08:00–22:00 plan, exits 12:00 next day | RM 9.00 | **RM 0.00** |
| same, exits 09:00 next day | RM 3.00 | **RM 0.00** |
| three nights in a daytime-only plan | RM 61.00 | **RM 0.00** |

Any stay that *began* inside a gap and ran past midnight was free. A daytime-only
plan — a completely ordinary configuration — gave away every overnight stay.

The fix advances to the earliest next rule-window start (or midnight, whichever
comes first) instead, so only the true gap is free.

## Cases

`check.js` hand-computes each expected fee in a comment, so the suite asserts what
the tariff *should* be, not what the code currently returns. Three of the six are
regression guards that must stay unchanged by any gap-handling edit: a fully
covered 24h plan, a gap that only trails the exit, and a plan whose rule never
matches at all (which also proves the walk terminates rather than spinning to its
100k-iteration guard).

## Run it

```bash
cd app
npm run test:fees
```

Expected tail: `PASS — 6 gap scenarios priced correctly`.

Results land in `.results/` (gitignored) — electron is a Windows GUI-subsystem
binary whose stdout is unreliable when spawned, so `check.js` reports through a
file and `run.mjs` prints it.
