# Schema-migration harness

Guards the one-shot `sessions` table rebuild in
`app/src/main/services/db.ts` (`applySchema`). That block exists because SQLite
can't `ALTER` a CHECK constraint, so a very old install whose
`payment_status` CHECK predates `manual_release` / `declined` / `cancelled` has
its table recreated and copied once.

**The bug this catches (fixed 2026-07-29):** the rebuild's `CREATE TABLE` was a
hand-written column list that drifted out of step with the `ALTER TABLE ... ADD
COLUMN` block above it. When `pass_id` / `free_reason` were added, the rebuild
wasn't updated — so on an install that actually triggered the rebuild, those two
columns were recreated away. The damage isn't only the dropped columns:
`recordExit()` writes them, so for the rest of that boot **every exit failed to
record** with `no such column: pass_id`, and the gate couldn't close a session
until the app was restarted.

That's invisible on a current dev box: once the rebuild has run (or the install
is new enough), the CHECK is canonical and the block never fires again. It only
bites a field install upgrading from an old version — which is exactly the case
nobody tests by hand.

## How it works

Each scenario runs in its own **real electron main process** (`check.js`), because
`better-sqlite3` is compiled for the electron ABI and plain Node can't open the
DB. Each one seeds a throwaway DB under a temp `userData` dir, then calls the
**real** `getDb()` from `dist/main/services/db.js` — not a copy of the SQL — so
the harness can't drift from the code it's testing.

| case | what it proves |
|---|---|
| `control` | Replays the **pre-fix** SQL and asserts it still loses `pass_id` and still breaks the `recordExit` UPDATE. Keeps the other cases honest — if this ever passes, the real assertions have lost their teeth. |
| `fresh` | Baseline: a brand-new install's column set. |
| `rebuild` | A legacy DB (stale CHECK, no audit columns) migrates with `pass_id` / `free_reason` intact, legacy `'release'` sanitised to `'manual_release'`, and `recordExit()` still able to write a free-exit audit trail. |
| `carry` | Pre-existing `pass_id` / `free_reason` **values** survive the `INSERT..SELECT`. |

The headline assertion is the last one the runner prints: **the rebuilt table's
column set must equal a fresh install's.** That's what catches the *next* column
added to `sessions` without a matching entry in the rebuild block — the actual
root cause, rather than these two specific columns.

## Run it

Needs a compiled main process (`dist/`), which the npm script builds for you.

```bash
cd app
npm run test:migration
```

Expected tail: `PASS — all migration checks green`, with
`column parity: fresh install vs rebuilt table → ok identical (22 columns)`.

Results land in `.results/*.json` (gitignored) because electron is a Windows
GUI-subsystem binary and its stdout is unreliable when spawned.
