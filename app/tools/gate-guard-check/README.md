# Gate + session-integrity guard harness

Runs the **real** main-process code against a throwaway SQLite DB. Two groups:

1. **Entry routing** — drives the actual event path
   (`lprEvents.emit('plate')` → `handlePlateEvent` → `handleEntry`) and asserts
   which plate reads open a session and which are correctly ignored.
2. **Record integrity** — manual release, season-pass preference ordering, and the
   one-duration-rule invariant, all called directly.

## The bug this catches (fixed 2026-07-29)

`settings.exitGracePeriodSeconds` (default 90) existed, was editable in Settings,
and was **read by nothing**. ANPR cameras routinely report the same plate two or
three times per pass. On a `dual` camera — or an entry camera with
a shared barrier — the exit camera closes the session, and the
next one a second later opened a **brand-new entry**: a phantom "car inside" for a
car that had just driven out. That phantom then blocked the vehicle's real next
visit with ALREADY INSIDE, and inflated occupancy until someone deleted it by hand.

## Cases

Beyond the duplicate-read case itself, the suite pins down the things most likely
to break when someone touches this guard:

- a genuine re-entry **after** the window is still admitted (the guard must not
  become a permanent lockout)
- `exitGracePeriodSeconds = 0` disables it entirely — the operator opt-out
- a **future-dated** `exit_at` (hand-edited session, clock skew) doesn't swallow
  entries forever, which a naive `now - exitAt < window` test would do
- a car that is genuinely still inside keeps reporting `rescan-ignored`
  (ALREADY INSIDE) rather than falling into the new path, and never double-opens

## Record-integrity cases

- **Manual release must never rewrite a settled session.** A release can land moments
  after a payment closed the session (driver taps as staff press the button); without
  the `exit_at IS NULL` guard in `manualReleaseSession`, a genuinely PAID record was
  rewritten to `manual_release` and real revenue read as waived. Both directions are
  pinned: a closed session is left intact, an open one still closes.
- **Season-pass preference.** SQLite sorts NULL below every value, so
  `ORDER BY end_date DESC` alone ranked a never-expiring pass **last** — the opposite
  of "longest coverage". The suite pins the full order: free first, then open-ended,
  then latest end date. This only affects which `pass_id` / `pass-<type>` reason lands
  in the audit trail, not whether the exit is free.
- **One duration rule.** The gate used `Math.ceil` while "Test price" used floor, so a
  stay just past a grace boundary was charged at the barrier but quoted free by the
  simulator. Both now call `stayDurationMinutes` (truncating, matching the cloud).
  The end-to-end case is a legacy no-`rules[]` plan with a 60-minute grace and a
  60m30s stay: it must price free, and the gate's duration must equal the
  simulator's.

## Open-session restore ("Sync now" recovery)

A rebound / reinstalled / wiped box pulls the cloud's OPEN parking records
(`GET /local-server/parking-records/open`) and re-creates its open sessions, so
cars that entered before the reset can still exit. The suite pins the import
guards in `importOpenSessionsFromCloud`: an unknown plate imports (with entry
time + a "Restored from cloud" note), a plate already inside keeps the box's own
record, a stay the box already knows (entry within ±5 min, even CLOSED) is
skipped — the stale-cloud guard that stops a record whose exit push is still in
our outbound queue from re-opening a stay this box just closed. Also: re-running
is a no-op, and a restored session closes normally via recordExit. That guard is
also why the restore rides ONLY on manual "Sync now" / post-rebind, never the
60s tick.

## Not covered

The auto-retrigger chargeability guard (`isStillChargeable`) is **not** tested here
— exercising it needs a live W4G device and a payment timeout, so it stays a
manual check at the rig. Same for the "refuse a paid exit when no PayResult
listener is bound" guard. The session-editor plate canonicalisation lives inside an
`ipcMain.handle` callback, which isn't reachable without an IPC round-trip; the
underlying `canonicalPlate` rule is shared with the LPR ingest path.

## Run it

```bash
cd app
npm run test:gate
```

Expected tail: `PASS — 8 gate-guard checks green`.

Results land in `.results/` (gitignored) — electron is a Windows GUI-subsystem
binary whose stdout is unreliable when spawned, so `check.js` reports through a
file and `run.mjs` prints it.
