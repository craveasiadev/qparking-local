# activity-log-check

`npm run test:activity`

Guards the durability of the local `activity_logs` table across a cloud sync.

## Why it exists

The Activity Log is part mirror, part original. Rows written on this box
(`source='local'`, `pushed_to_cloud=0`) are the ONLY copy of a manual release, a
blacklist refusal or a gate refusal until a push delivers them. Everything else
is a mirror of the cloud's combined trail, refreshed by a replace-all pull.

Three real defects, all found on 2026-08-06, live in that seam:

1. **The wipe.** `replaceAllActivityLogs()` deleted the whole table before
   re-inserting the cloud's set, so pressing "Sync now" before "Push to cloud"
   destroyed every unacked local row without a trace. `syncActivityLogs()` now
   pushes before it pulls, and the pull preserves unacked local rows as a second
   line of defence for when that push fails (offline, or a rejected row).

2. **The lost ack.** A push can land server-side and lose its response. The row
   is then unacked locally but already in the cloud under the same id, so the
   next mirror-down brings back a row that local still holds — an insert that
   used to be a primary-key collision. It's an `INSERT OR REPLACE` now: the
   cloud's copy wins and the row flips to pushed.

3. **The silent reject.** `/activity-logs/sync` maps each row onto the cloud's
   enums and drops what it can't map. Rows it didn't ack must end up carrying the
   reason (`sync_error`), or they sit at "Not pushed yet" forever and get
   re-sent on every sync with nothing to explain why.

## What it does not cover

The vocabulary contract itself — that every `action` / `category` /
`resourceType` this app writes is one the cloud can map — is enforced at compile
time instead, by the union types on `ActivityLogPayload` in
`src/shared/types.ts`. That is what would have caught the `manual_open` and
`app_settings` writers that used to fail whole push batches.
