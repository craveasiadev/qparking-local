# gate-sync-check

`npm run test:gate-sync`

Guards `syncGateCritical()` and its 5-minute timer — the tick that keeps the three
mirrors a barrier decision actually reads (season passes, blocked plates, rate
policies) current without anyone pressing a button.

## The regression it exists for

Those three mirrors used to come down on `syncAll()` **only** — app boot, the
header's "Sync now", or a site rebind. So a pass issued or a plate banned in the
SaaS did not reach the barrier until somebody walked to the box and clicked.
Staff were the sync mechanism, and the person who paid for anyone forgetting was
a driver sitting at a closed gate holding a pass they had just been sold.

The code said so out loud — `cloud-sync.ts` carried "Operational consequence, by
design: a ban or season pass issued in the cloud reaches the barrier only at
boot, on a rebind, or when staff press Sync now" — but it was a consequence of
how the old tick was *deleted*, not a decision anyone made about the gate.

## Why it isn't just "put them back on the existing tick"

The 60-second everything-tick was removed for a good reason: it dragged
`/activity-logs` down with it, an **unbounded replace-all of the whole audit
trail** that grows for the life of a site. Undoing that deletion would have
re-created a request that gets slower every month.

So this tick carries three small, bounded list endpoints and nothing else. Half
the checks here exist to keep it that way: they assert the tick hits exactly
three paths, that `/activity-logs` is never one of them, and that no other
`syncAll()`-only endpoint (`/site`, `/company/settings`, `/customers`,
`/vehicles`, `/parking-spaces`, `/sessions/open`) creeps in.

## Why the cadence is a fixed constant

`GATE_SYNC_INTERVAL_MIN` is deliberately **not**
`company_settings.sync_interval_minutes` (60 by default, and an operator may
raise it further). That setting answers "how fresh are the office directories",
which is a bandwidth trade an operator is entitled to make. How long a paying
customer waits at a barrier holding a valid pass is a different question and must
not be tunable into "an hour" as a side effect.

The last three checks read that off the **compiled** output, so a refactor that
quietly swaps in `resolveSyncIntervalMin()` fails here rather than in a car park.

## The empty-wipe guard's scope rule

`refuseEmptyWipe()` refuses to clear a gate-critical mirror on the first empty
"successful" response — one bad cloud deploy returning `{"data":[]}` would
otherwise stop the gate honouring every pass and enforcing every ban. When the
cloud sends its own `total` the guard uses that; when it sends none, it falls
back to demanding **two consecutive empty pulls**.

**That fallback used to be the only path, and it was a real problem.** Until
2026-09-01 the live SaaS returned a bare `{"data":[...]}` on all three of these
endpoints, so `readCloudTotal()` was always null for exactly the mirrors this
guard protects — meaning a site whose roster genuinely emptied kept its stale
copy and showed a refusal on the header every 5 minutes, forever, because a tick
is not allowed to confirm. The cloud now sends `meta.total`
(`qparking` → `tests/Feature/LocalMirrorCountTest` pins it), so the corroborated
branch decides and the streak is genuinely legacy-only again. `tools/mirror-
contract-probe` is what checks the two repos still agree on the wire.

That fallback was written when these mirrors only came down on a deliberate pull,
so "two consecutive empties" meant two human decisions. A 5-minute tick would
have turned it into ten minutes of nobody watching. Ticks therefore refuse
**without touching the streak** — they can neither confirm a wipe nor bring one
closer — and the checks prove it from both ends: four ticks in a row leave the
roster intact, and the operator's *first* deliberate pull afterwards still
refuses (their second applies it, so the guard keeps its exit).

## The boundary that is deliberately NOT blocked

A tick **does** apply an emptying the cloud corroborates with `total: 0`. That is
the SaaS stating the site has no passes, not an ambiguous blank; refusing it
would leave the box honouring passes the cloud has retired until someone pressed
a button — the exact staleness this tick exists to end.

## Header stamp

A clean gate tick refreshes the "Synced …" time, because those three mirrors are
the entire thing that stamp vouches for. It does **not** clear an error it never
re-tried: if `/activity-logs` is failing, the full pull owns that error and a
gate tick showing a fresh clock alongside it is the honest reading of both.
