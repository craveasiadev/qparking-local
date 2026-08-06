# session-sync-check

`npm run test:session-sync`

Guards the path a parking session takes from this box to qparking SaaS, and the
watermark that says whether it got there.

## The regression it exists for

Found 2026-08-06. Every `enqueue*` helper in `cloud-queue.ts` resolved a rate
policy for the payload's legacy `site_id` field and **returned early when it found
none** — `console.warn` only. On a box whose lanes carry no rate plan and which has
no site-default plan (an ordinary setup; the state of the test box that day), that
silently discarded **every** session: `sync_queue` stayed empty, the cloud's
Parking Activity page stayed blank, and nothing anywhere recorded the loss.

The field wasn't even used: `ParkingRecordController::upsert` never validated or
read `site_id` — it takes the site from the bearer token. Sessions were being
thrown away to protect an ignored key. It is now best-effort: present when a
policy resolves, absent when not, never blocking.

## Why a revision counter, not a `pushed` boolean

An activity-log row is written once, so a boolean is right for that table. A
session mutates repeatedly — entry, exit, an operator edit, a manual release — so
"pushed" would flip true on the entry push and then lie about everything after it.

Sessions therefore carry `rev` (bumped by every mutation) against
`cloud_synced_rev` (the rev the cloud acknowledged). Three states fall out:
never delivered, delivered-and-current, delivered-but-stale.

**Timestamps were tried first and rejected**, and this harness is why: comparing
`updated_at > cloud_synced_at` failed here because `CURRENT_TIMESTAMP` has
one-second resolution — a change in the same second as an acknowledgement compared
EQUAL and read as already-synced. Millisecond precision (`strftime('%f')`) moved
the collision window without closing it. The revision comparison has no clock in
it at all. The timestamp comparison is kept only as a backstop, for a future
mutation path that bumps `updated_at` but forgets `rev = rev + 1`.

The acknowledged rev is the one **snapshotted when the queue row was created**, not
the session's current rev: the payload is a snapshot too, so a session that
changed while its push was in flight must still be reported as stale.

## Known trade-off it documents

A session restored FROM the cloud (`importOpenSessionsFromCloud`, the rebind /
reinstall recovery feed) starts with a NULL watermark, so it lists as
not-yet-acknowledged and will be pushed back up once. Harmless — the cloud upsert
is idempotent on plate + open record — but asserted here so the behaviour is a
decision rather than a surprise.
