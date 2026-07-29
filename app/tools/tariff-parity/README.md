# Tariff parity harness

Verifies that Repo A's on-prem fee calculator (`computeFee` in
`app/src/main/services/parking-flow.ts`) produces **exactly** the same charge as
the qparking SaaS engine (Repo B `app/Services/TariffCalculator.php`) for the
same policy + entry/exit. This is the regression guard for the 2026-07-08 parity
port — if the two ever diverge again, this catches it.

## How it works

Both sides run their **real** code on identical scenarios:

- `ref_cloud.php` — builds `RatePolicy` + `TariffRule` models in memory (no DB)
  and calls the real `TariffCalculator::calculateForPolicy`. It filters to
  `is_active` rules, mirroring the production query. Run inside the
  `qparking_backend` container (has Laravel + vendor).
- `ref_local.mjs` — a **verbatim copy** of `computeFee` and its helpers from
  `parking-flow.ts` (TS annotations stripped). Runs with a fixed timezone so
  wall-clock rule windows line up with the PHP side.
  > ⚠️ If you change `computeFee` / its helpers in `parking-flow.ts`, re-copy the
  > block between the `VERBATIM COPY` markers in `ref_local.mjs`.
- `scenarios.json` — hand-picked cases, one per pricing feature (grace, cutoff,
  rate_basis, flat modes, caps, first-block sizing).
- `gen_fuzz.mjs` — generates N randomized policies (every scenario has an
  always-on 24h fallback rule so coverage is complete and the cloud never
  throws).
- `compare.mjs` / `compare_quiet.mjs` — diff the two outputs.

Timezone is pinned to `Asia/Kuala_Lumpur` (no DST) so calendar-day math agrees.

## Run it

Requires the `qparking_backend` Docker container running (Repo B), and Node.
`MSYS_NO_PATHCONV=1` is only needed on Git Bash for Windows (stops `/tmp/...`
being mangled).

```bash
cd app/tools/tariff-parity
bash run.sh          # curated scenarios + a 1000-case fuzz
```

Expected: `11 match, 0 mismatch` on the curated set and
`1000 match, 0 mismatch, 0 cloud-throw` on the fuzz.

## Known intentional divergence

If a policy has a **coverage gap** (a moment no active rule covers), the cloud
`TariffCalculator` throws (treats it as misconfiguration) while local safely
charges the covered portion and treats the gap as free — the gate must never
crash mid-exit. The fuzz reports these as `cloud-throw(skipped)`, not mismatches.

Because the cloud throws, this harness **cannot test the gap behaviour at all** —
there is no cloud number to compare against, and `gen_fuzz.mjs` gives every
scenario an always-on 24h fallback rule specifically so gaps never arise (hence
`0 cloud-throw(skipped)` on a clean run). That local-only path is covered
separately by `tools/fee-gap-check`, which asserts hand-computed fees instead.
