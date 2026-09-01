# mirror-contract-probe

```
node tools/mirror-contract-probe/run.mjs <baseUrl> <siteApiKey>
```

**Manual, not part of `npm test`** — it needs a live qparking SaaS and a real
per-site key, the same way `tools/tariff-parity` needs a running backend.

## What it proves, and why nothing else can

The gate-critical mirrors (season passes, blocked plates, rate policies) are
pulled replace-all, so an empty `data` array means "stop honouring every pass,
stop enforcing every ban, drop every rate plan at this site". The box's
`refuseEmptyWipe()` will not act on a bare empty list; it needs the cloud to
corroborate with a count, delivered as `meta.total`.

That contract spans two repos, and each side is already tested **in isolation**:

| Test | Pins |
|---|---|
| `qparking` → `tests/Feature/LocalMirrorCountTest` | what the cloud *sends* |
| `qparking-local` → `tools/gate-sync-check` | what the box *does with it* |

Both would still pass if the field moved, got renamed, or stopped being emitted
on the real wire — the box's tests use a stub cloud, and the cloud's tests never
run a box. This probe is the only thing that puts a real box in front of a real
server and checks they still agree.

## How to run it

Point it at a site whose **deny list is empty in the cloud**. The probe plants a
stale ban in a throwaway local database first, then runs one unattended-style
`syncGateCritical()`:

- **pass** — the empty deny list was corroborated (`meta.total: 0`) and applied,
  clearing the planted ban.
- **fail** — the box refused the wipe. That is exactly what a missing or moved
  `meta.total` looks like, and on a real box it would mean a red sync error every
  5 minutes plus a deny list nobody can clear.

Find a suitable site with:

```sql
SELECT s.name, l.`key`,
       (SELECT COUNT(*) FROM vehicle_blacklists b WHERE b.site_id = s.id) AS bans
FROM site_local_servers l JOIN sites s ON s.id = l.site_id
WHERE l.`key` IS NOT NULL;
```

It is **read-only against the cloud** — three GETs, no writes, no queue drain.
Everything it writes goes to a fresh temp `userData` directory.

## Two traps this cost time on

- **Config comes through the ENV, not argv.** Electron's own command-line parsing
  swallows an argv entry that looks like a URL, and the process dies before the
  script runs — silently, because electron is a Windows GUI-subsystem binary with
  no usable stdout. `run.mjs` sets `PROBE_BASE_URL` / `PROBE_API_KEY` instead.
- **`ELECTRON_RUN_AS_NODE` must be DELETED, not blanked.** Setting it to an empty
  string still counts as set, and electron boots as plain Node with
  `require('electron').app === undefined`. `run-under-electron.mjs` deletes it;
  invoking electron by hand from a shell usually does not.
