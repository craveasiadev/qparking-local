# device-health-check

`npm run test:device-health`

Covers the box half of device reachability reporting: `health-heartbeat`,
`device-health`, `device-push` and `camera-push`. Before this, those were the
only main-process services no harness loaded at all — the feature shipped
2026-08-19 with the note "no test covers this end to end", and a coverage sweep
on 2026-09-01 found it was still true.

The cloud half lives in `qparking` → `tests/Feature/DeviceHealthTest`.

## The design decision it guards

**The heartbeat deliberately does NOT go through `cloud-queue`.** That queue is
durable-with-backoff, which is exactly right for sessions and transactions:
facts that must eventually land, in order, whenever the WAN returns.

A heartbeat is the opposite kind of message — a statement about *now*. Replaying
a queued "camera 3 online" ten minutes late would resurrect a dead camera on the
operator's screen, which is worse than saying nothing. So a failed post is
**dropped**, and the next tick tells the truth about the new now.

Nothing about that is visible on a happy path, so it is checked by asserting the
queue depth does not move across a failing post — with a **positive control**
right after it that queues a real session and proves the counter does move. An
invariant of the form "this number didn't change" is worth very little without
one.

## The other properties pinned

- **Two guards that must never post to the wrong place**: an unconfigured box
  (`qparking_not_configured`) and a box not bound to the site its key resolves to
  (`site_not_bound`) both refuse, and send *nothing* on the wire. The second
  matters most — a report from a mis-bound box attaches health to another site's
  equipment.
- **An empty report still posts.** "I am alive and own no equipment" is a
  different statement from silence, and the cloud reads silence as a dead site.
- **A device with no `external_id` is skipped, never given an invented one** —
  there is no cloud row to attach health to, and a made-up id creates a phantom
  device nobody can reconcile.
- **The box never claims `unknown`.** That status is the cloud's to *derive* from
  heartbeat staleness; a box cannot report its own death.
- **A skip is not a failure.** `toEquipmentPushItem` classifies "not bound" /
  "not configured" as `skipped` so the operator sees "nothing to do" rather than
  a red row they cannot act on.
- Timer hygiene: `startHealthHeartbeat` is idempotent and `stop` clears it.

## Two things that cost time here

- **The skip-guard check was vacuous at first.** Every device created through the
  app gets an `external_id` at insert, so "skipped === (rows without an id)" was
  `0 === 0` and stayed green with the guard deleted — verified by mutation, it
  SURVIVED. The test now constructs the case the guard actually exists for: a
  legacy install upgraded from before that column was populated, simulated by
  nulling `cameras.external_id` directly. With that row present the mutation is
  caught.
- **Write through the module's own DB handle.** A second `better-sqlite3`
  connection to the same file did not show up in the sweep. Use
  `db.getDb().prepare(...)` rather than opening the file again.

All six mutations of the guards above are verified caught, with sources restored
byte-identical after each.
