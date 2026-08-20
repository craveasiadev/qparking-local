# Driver-display harness

`npm run test:lcd`

Runs the **real** display service (`src/main/services/lcd-display.ts`) against a
fake panel: a local TCP server that speaks the qparking-lcd protocol, records
every frame and acks it the way a real panel does. Real SQLite rows in a throwaway
DB, real socket, real `parkingEvents` subscriptions — only the glass is simulated.

Parking events are emitted directly rather than driven through a payment terminal.
The failures under test (declined card, dead device, callbacks not running) each
need hardware to refuse in a particular way, and the flow's contract with the
display **is** the event, so the event is what gets exercised.

## The bugs this catches (all fixed 2026-08-20)

1. **A fare nothing will collect stayed on the glass.** `exit-pending` put
   `RM 5.00` up; a decline or a timeout emitted no frame at all. The panel went on
   asking for money no terminal was armed to take — and was still asking when the
   next car pulled up.
2. **A manual release said nothing.** A release never enters the parking flow, so
   `exit-completed` never fired and the panel kept the dead fare (or the previous
   car's thank-you).
3. **The wrong panel would have been cleared.** A failed exit leaves the session
   **open**, so its row has no `exit_lane_id`. Recovering the gate from the
   database falls back to the ENTRY lane — blanking a panel at the far side of the
   site while the one in front of the driver kept its dead fare. Hence
   `faresShown` remembering the lane the fare was actually sent to.
4. **A retrigger's fresh fare could be wiped by the previous attempt's idle**, two
   seconds after the driver was asked to pay it again.
5. **Deleting or rewriting a session left its fare up** — the editor and the delete
   button don't go near the flow either.

## What must NOT happen (also asserted)

- `exit-busy` never clears anything: that is a duplicate read arriving while a
  *different* car is mid-charge, and the fare on screen belongs to that car.
- An armed `exit-auto-retrigger` keeps the fare exactly where it is — the terminal
  is about to ask again, and the retry path re-arms the device **without**
  re-emitting `exit-pending`, so a cleared screen would never come back.
- Clearing session #N never touches a panel showing session #M.

## Timing

The dwell constants are duplicated at the top of `check.js` on purpose. If someone
shortens a dwell in `lcd-display.ts`, the harness's waits still bracket the old
value, so it fails loudly instead of quietly testing nothing. That does make this
the slowest harness in `tools/` (~40s), almost all of it deliberate waiting.

## Verifying the harness itself

Every check here passed on its first run, which is worth distrusting. Both
load-bearing guards were mutation-tested against the compiled output —
`FAILED_FARE_WARNINGS` emptied, and the supersede line in `showOnLane` removed —
and each mutant was caught (3 and 1 failures respectively). Re-run `npm run
build:main` afterwards to discard the mutation.
