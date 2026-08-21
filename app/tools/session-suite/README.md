# session-suite — the session lifecycle + season-pass harness

```
npm run test:sessions
```

Drives the **real** parking-flow entry/exit paths (`lprEvents` → `handlePlateEvent`
→ `handleEntry` / `handleExit` → `recordExit` / `startTngExitCharge`) against a
throwaway SQLite database in a temp `userData` dir, and asserts every state a
parking session can reach plus every season-pass shape qparking SaaS can issue.

## What is stubbed, and why only that

Three exported seams on `services/payment-tng` are replaced so a paid exit can be
approved / declined / timed out / left hanging without an Alarmtech W4G on the LAN:

| stub | purpose |
| --- | --- |
| `payResultListenerReady()` | flip the "no callback path" refusal on and off |
| `payRequest()` | script the device outcome (approve, decline, timeout, hang) |
| `payCancel()` | observe that a cancelled charge aborts the deduction |

Everything else is the shipped implementation: fee math, pass lookup and ranking,
session rows, the transaction ledger, the auto-retrigger timers, the blacklist,
and the cloud-restore import. `TZ` is pinned to `Asia/Kuala_Lumpur` exactly like
`src/main/tz.ts` does, because pass validity days and the pass-lapse billing
boundary are site-local midnights.

`qparkingBaseUrl` / `qparkingApiKey` are left blank so the outbound cloud queue
stays inert.

## Fixtures

Three rate plans — `charge` (RM5 first hour + RM3/hour), `zero` (RM 0), `grace`
(24h free) — wired across eight lanes that each isolate one failure mode: device
present, device missing, device disabled, no plan at all, dual-direction camera,
lane with no camera. The canonical stay is **10:00 → 14:00 MYT on 10 Aug 2026**
(240 min = RM14 under `charge`), so on a charging lane a free exit can only have
come from a pass.

Retrigger cases are the exception: a retrigger carries no `exitAtOverride`, so it
prices against the wall clock. Those fixtures are back-stamped relative to `now`
(`RETRIGGER_ENTRY`), not to the fixed 2026 window.

## Groups

| group | covers |
| --- | --- |
| **A · entry** | first read, rescan-ignored, exit-grace duplicate guard (incl. `=0` opt-out and the future-dated-exit escape), blacklist refusal, shared-barrier entry+exit camera pair, entry-camera re-read, lane-less camera, UTC `Z` stamping |
| **B · exit routing & free exits** | exit-without-entry, exit-no-lane, the three free reasons (`within-grace` / `rate-zero` / `no-policy`), no-device, disabled device, missing PayResult listener, entry-lane-governs-the-fee, blacklist at exit (with and without an entry on record) |
| **C · paid exit & the terminal** | approved / declined / timed-out taps, ledger row opened `pending` before the device is driven, the per-lane busy guard, `cancelExitInFlight` + PayCancel, auto-retrigger off / on / capped at 3 / aborted by a mid-delay release |
| **D · manual release & retrigger** | release closes an open session and refuses a settled one, every `retriggerSessionExit` rejection (missing, closed, no lane, no device, no camera), the happy path, and `retriggerSessionExitByPlate` plate canonicalisation |
| **E · every pass type** | every `pass_type` value the cached roster can hold — the seven the cloud's v1 payload still derives (monthly, quarterly, yearly, staff, free_access, temporary, resident) plus corporate and vip, retired 2026-08-19 but kept to prove an un-synced cache still exits cleanly — each proving a free exit on a charging plan with `freeReason = pass-<type>` and the `pass_id` in the audit row |
| **F · pass validity edges** | non-`active` statuses (expired / suspended / pending / rejected), wrong plate, not-yet-started, already-ended, open-ended `NULL` **and** `''` end dates, `NULL`/`''` start dates, inclusive last-day boundary, separator-bearing cloud plates, reserved space numbers, the three ranking rules, and blacklist-beats-pass |
| **G · pass lapse & renewal** | lapse mid-stay bills only the uncovered tail while the audit keeps the true stay length, renewal mid-stay is credited to the renewal row, an RM 0 tail is attributed to the rate (not the pass), exit-day-only coverage, and cloud revocation |
| **H · duration & fee integrity** | the one truncating duration rule, clamps, and "Test price" parity with what the gate charged |
| **I · dev simulator & restore** | `simulateEntryAt` / `simulateExitAt` guards (already inside, invalid time, blacklist, no open session) and `importOpenSessionsFromCloud` (import / skip-inside / skip-known-closed / idempotent / the restored session still exits) |

## Reading the output

`run.mjs` prints one line per assertion grouped by section; failures show the
observed value. Electron is a Windows GUI-subsystem binary with unreliable
stdout when spawned, so `check.js` reports through
`tools/session-suite/.results/sessions.json` and `run.mjs` (plain Node) does the
printing — the same arrangement as the other harnesses here.
