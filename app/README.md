# QParking Local Server

On-prem parking controller. Runs as a Windows desktop app on the site's gate PC.
It sits between the physical parking hardware and the qparking cloud:

- **LPR cameras** over HTTP — cameras POST plate detections to our webhook.
- **ECPI payment terminals** over TCP (JSON + SHA-256 + heartbeat) — drives the
  gate's payment flow.
- **qparking SaaS** over HTTPS — a **Laravel REST API** we pull rate-policy config
  from every 60 seconds (so fees can be calculated even when the WAN is down) and
  push session records up to. All of these calls go through **one shared axios
  client** (`services/cloud-api.ts`).

State lives in a local SQLite DB at `%APPDATA%\qparking-local\qparking-local.db`.
Captured plate images go to `%APPDATA%\qparking-local\plates\<date>\`.

---

## Contents

1. [What it does](#what-it-does)
2. [Architecture: React + Node.js + Electron](#architecture-react--nodejs--electron)
3. [How the layers connect (the bridge)](#how-the-layers-connect-the-bridge)
4. [Folder + file map](#folder--file-map)
5. [A full flow through all layers](#a-full-flow-through-all-layers)
6. [Worked examples (with real code)](#worked-examples-with-real-code)
7. [Running it (dev)](#running-it-dev)
8. [Building the installer](#building-the-installer)
9. [First-time configuration on a new site](#first-time-configuration-on-a-new-site)
10. [Camera webhook contract](#camera-webhook-contract)
11. [Testing without hardware](#testing-without-hardware)
12. [Logs + diagnostics](#logs--diagnostics)
13. [Jargon decoder](#jargon-decoder)

---

## What it does

When a car **enters**:
1. LPR camera reads the plate, POSTs to `/lpr/event`.
2. We create a parking session (plate + entry timestamp).
3. (Optional) pulse the gate-relay / raise the turnstile.

When a car **exits**:
1. Exit-lane LPR camera reads the plate, POSTs to `/lpr/event`.
2. We look up the open session, compute duration + fee using the lane's rate policy.
3. We drive the payment terminal:
   - **Kiosk-mode lane**: `initExit` → wait for card tap → `proceedExit` → wait for txnStatus.
   - **LPR-mode lane**: `initCard` (reader settles the tap) → wait for cardRead.
4. On `APPROVED` we record the exit + open the gate.
5. On declined/timeout/cancelled the session stays open; the operator can
   manually release from the UI.

If the fee is 0 (within the free window, or the plate holds an active pass, or
the rate policy has no rate), we mark the session `free` and skip the terminal entirely.

---

## Architecture: React + Node.js + Electron

### The mental model: a web app in a box

If you've built a normal web app, you already know the shape:

```
   Browser (React)  ──HTTP──►  Server (Node backend)  ──►  Database
```

Electron is that **same split, bundled into one desktop program** — plus it syncs
with a remote Laravel API:

```
┌─────────────────────── one Electron app (the gate PC) ─────────────────┐
│                                                                         │
│   RENDERER (React)   ──window.bridge──►   MAIN (Node backend)           │
│   a Chromium window                        a Node.js process            │
│                                                 │                       │
│                                                 ▼                       │
│                                   SQLite · TCP (terminal) · LPR HTTP     │
└────────────────────────────────────────────────│──────────────────────┘
                                                  │ HTTPS  Bearer <apiKey>
                                                  ▼
                                   qparking SaaS — Laravel REST API
                                   /api/v1/local-server/…   (in the cloud)
```

So there are three programs in play. Two run together on the gate PC inside one
Electron app; the third (the Laravel API) lives in the cloud and this app is just
an HTTPS *client* of it.

| Layer | What it really is | Where it lives |
|-------|-------------------|----------------|
| **React** | The UI — an ordinary React app in a Chromium window | `src/renderer/` |
| **Electron** | The desktop shell + the bridge to the backend | `src/main/index.ts`, `src/main/preload.ts`, … |
| **Node.js** | The backend logic — database, hardware, cloud sync | `src/main/services/` |
| **Laravel** | The cloud API this app syncs with (separate repo) | remote, not in this project |

> ⚠️ **Electron and Node.js are not two separate processes.** The Electron "main
> process" *is* a Node.js runtime with extra desktop APIs added. Everything under
> `src/main/` runs in Node; we split it by *role* — Electron glue at the root,
> pure backend logic in `services/`.

### Why not just a website?

Because a browser page cannot open TCP sockets to a payment terminal, run an HTTP
server for the cameras to POST to, write a SQLite file, or keep working with the
window closed. Those need Node. And the gate must keep charging cars even when the
internet is down — so rates are cached locally in SQLite. React is only the
*dashboard*; the Node backend is the actual application, and it runs headless in
the system tray whether or not the window is open.

---

## How the layers connect (the bridge)

React never touches hardware or data directly. It talks to the backend two ways.

### Direction A — React asks, backend answers (request → response)

Think of `window.bridge.x()` as this app's `axios` — same idea as `axios.get()`,
but the backend lives in the same program. (The backend *does* use real axios —
but only for calling the Laravel cloud API; see `services/cloud-api.ts` below.)

```
React component                preload.ts                    index.ts (Node)
───────────────                ──────────                    ───────────────
window.bridge.listRatePolicies()  →  ipcRenderer.invoke(         →  ipcMain.handle(
                                 'policies:list')                 'policies:list',
                                                                () => listRatePolicies())
        (Promise)           ◄──   returns the rows        ◄──   reads SQLite
```

To trace any bridge call: find its name in `src/main/preload.ts` to get the
channel string (e.g. `'policies:list'`), then search that string in
`src/main/index.ts` to find the handler that runs it. (Same as "find the axios
URL → find the matching route".)

### Direction B — backend pushes to React (live updates)

Like a WebSocket. The backend sends, React subscribes — used for live plate
events, terminal status, the parking-flow log, etc.

```tsx
useEffect(() => {
  const off = window.bridge.onEvent('plate-detected', (e) => setEvents(…));
  return off; // unsubscribe on unmount
}, []);
```

On the backend that push is `mainWindow.webContents.send('plate-detected', …)`.

### The IPC vocabulary (`ipcMain.handle`, `invoke`, `send`, …)

"IPC" = **Inter-Process Communication** — how the two processes (React window ↔
Node backend) talk, since they can't share memory. There are only five names to
know, and they pair up:

| Name | Runs on | Direction | What it does | Web analogy |
|------|---------|-----------|--------------|-------------|
| `contextBridge.exposeInMainWorld('bridge', api)` | preload | — | Safely puts the `api` object on the renderer's `window` as `window.bridge`. The only hole in the sandbox wall. | Handing the frontend a pre-built API client |
| `ipcRenderer.invoke('channel', …args)` | preload / renderer | React → Node | Sends a request on a named channel and returns a **Promise** with the reply. | `axios.get()` |
| `ipcMain.handle('channel', fn)` | main (Node) | answers the above | Registers the function that runs when that channel is invoked, and returns a value back. | `router.get('/path', handler)` |
| `webContents.send('channel', payload)` | main (Node) | Node → React | **Pushes** a message to the window, unprompted (fire-and-forget, no reply). | `socket.emit()` from the server |
| `ipcRenderer.on('channel', cb)` / `.off(...)` | preload / renderer | receives the above | Subscribes / unsubscribes to pushed messages. | `socket.on()` on the client |

They form two pairs plus the setup call:

```
SETUP:        contextBridge.exposeInMainWorld('bridge', api)   → gives React `window.bridge`

REQUEST/REPLY: ipcRenderer.invoke('policies:list')   ⇄   ipcMain.handle('policies:list', fn)
               (React asks)                              (Node answers)

PUSH/SUBSCRIBE: webContents.send('plate-detected', e)  →  ipcRenderer.on('plate-detected', cb)
               (Node pushes)                               (React listens)
```

The **`'channel'` string** (like `'policies:list'` or `'plate-detected'`) is just a
label both sides agree on — the invoke and its handle must use the *exact same
string*, or the message goes nowhere. That string is the thing you search for
when tracing a call (see below).

> **Don't confuse IPC with `EventEmitter`.** Inside the Node backend you'll also
> see `lprEvents.emit('plate', …)` / `parkingEvents.on('exit-completed', …)`.
> Those are Node's plain [`EventEmitter`](https://nodejs.org/api/events.html) —
> pub/sub **between backend modules in the same process**. They never reach React.
> Only `webContents.send` crosses the process boundary to the UI. Rule of thumb:
> `emit`/`on` on a local emitter = internal; `webContents.send` = out to React.

### Following a call across the layers (frontend → Electron → backend → SQL)

When you see `window.bridge.something()` in a React page and want to find *what it
actually does* (all the way down to the database), follow this 4-hop trail. Each
hop is a plain text search — no guessing.

Worked trace for `window.bridge.listRatePolicies()`:

**Hop 1 — Frontend (React).** You start here, in a page:
```tsx
// src/renderer/pages/ParkingPolicies.tsx
setList(await window.bridge.listRatePolicies());
```
→ Note the method name: **`listRatePolicies`**.

**Hop 2 — The bridge (preload).** Search `listRatePolicies` in `src/main/preload.ts`:
```ts
listRatePolicies: () => ipcRenderer.invoke('policies:list'),
```
→ This gives you the **channel string**: `'policies:list'`. (The method name and the
channel string are often different — the channel is what actually crosses into Node.)

**Hop 3 — The handler (Electron main).** Search `'policies:list'` in `src/main/index.ts`:
```ts
ipcMain.handle('policies:list', () => listRatePolicies());
```
→ This is the "endpoint". It calls a backend function, also named **`listRatePolicies`**
(imported from `./services/db`).

**Hop 4 — The backend + SQL.** Search `function listRatePolicies` in `src/main/services/`:
```ts
// src/main/services/db.ts
export function listRatePolicies(): RatePolicy[] {
  const rows = getDb().prepare('SELECT * FROM rate_policies ORDER BY policy_name').all();
  // …maps rows to RatePolicy objects…
}
```
→ **Here's the actual SQL.** You've reached the bottom.

#### The trail in one line

```
window.bridge.listRatePolicies()   →   'policies:list'   →   ipcMain.handle(...)   →   db.ts listRatePolicies()   →   SELECT * FROM rate_policies
   (React page)                    (preload.ts)         (index.ts)              (services/*.ts)            (SQLite)
   search: method name             search: channel      search: fn name         the query
```

#### Fast way (search terms to use)

1. In your editor, **search the whole `src/main/` folder** for the method name
   (`listRatePolicies`) → lands you in `preload.ts`, revealing the channel string.
2. **Search for the channel string** (`'policies:list'`) → lands you on the
   `ipcMain.handle` in `index.ts`, revealing the backend function name.
3. **Search for `function <name>`** → lands you in `services/…` at the real logic
   + SQL.

The reverse also works: to find *what triggers* a SQL query, search the backend
function name → its `ipcMain.handle` channel → the `window.bridge.*` method → the
page that calls it.

---

## Folder + file map

```
app/
├── src/
│   ├── main/                 ⚡ ELECTRON — desktop shell (runs in Node)
│   │   ├── index.ts            entry: window, tray, services, IPC handlers
│   │   ├── preload.ts          the window.bridge (React ↔ Node door)
│   │   ├── gate-simulator.ts   red/green gate window
│   │   ├── app-update.ts       self-updater
│   │   └── services/         🟢 NODE.JS — backend logic
│   │       └── …
│   ├── renderer/             ⚛️ REACT — the UI
│   │   ├── main.tsx, App.tsx, GateView.tsx
│   │   ├── pages/*.tsx
│   │   └── hooks/
│   └── shared/               🔗 TypeScript types used by BOTH sides
│       └── types.ts
├── scripts/dev-electron.mjs  dev launcher (see "Running it")
├── vite.config.ts            builds the React bundle
└── package.json              scripts + build config
```

**One-glance rule:** path has `/renderer/` → React · `/main/services/` → Node
backend · `/main/` (root) → Electron glue · `/shared/` → shared types.

### `src/main/` (Electron shell ⚡)

| File | Purpose |
|------|---------|
| `index.ts` | App entry: opens window + tray, starts every service, registers all `ipcMain.handle(...)` endpoints. Keeps the app alive when the window closes. |
| `preload.ts` | The bridge — exposes the safe `window.bridge.*` surface to React. The single most useful file to see what the UI can do. |
| `gate-simulator.ts` | The always-on-top red/green gate window. |
| `app-update.ts` | Self-updater: check the cloud for a newer build → stream-download it → relaunch. Talks to the cloud via `services/cloud-api.ts` like everything else. |

### `src/main/services/` (Node backend 🟢)

| File | Purpose |
|------|---------|
| `db.ts` | SQLite schema + every query (sessions, terminals, cameras, lanes, rate policies, settings, sync queue). |
| `cloud-api.ts` | **The one axios client for the Laravel API.** Builds base URL + `Bearer` auth + 10s timeout from Settings. Every cloud call in the rows below goes through it. |
| `lpr-webhook.ts` | HTTP **server** the LPR cameras POST plate events to. Also powers the "Simulate" button. |
| `parking-flow.ts` | The brain: entry vs exit, fee calculation, drives the terminal, records the result, opens the gate. |
| `ecpi-terminal.ts` | Payment-terminal driver over a raw TCP socket (heartbeat + state machine). |
| `w4g-tng.ts` | Touch'n'Go integration — a parallel payment path via the W4G IO-controller. Deliberately hand-rolled HTTP (no axios): the device firmware is byte-picky about header order + JSON spacing. |
| `face-gate.ts` | Calls the face-auth turnstile's HTTP API to raise the barrier (its own axios client — different server, different token). |
| `qparking-sync.ts` | **Pull** from the Laravel API: `GET /rate-policies`, `/season-passes`, `/parking-spaces`, `/gate-commands/pending`; `PUT /rate-policies/upsert` pushes rate edits back up. |
| `sync-queue.ts` | **Push** to the Laravel API: `POST /parking-records`, with exponential-backoff retries so a WAN outage never drops a record. |
| `camera-snapshots.ts` | Fetches live JPEG snapshots from cameras (UI preview) and uploads them to the cloud on a 10s timer. |
| `camera-push.ts` | Mirrors the local camera registry up to the cloud. |
| `device-push.ts` | Mirrors terminals + lanes up to the cloud. |

### How the backend calls the Laravel API (`cloud-api.ts`)

Every service that talks to the cloud used to build its own URL, auth header and
timeout. Now that plumbing lives in exactly one place:

```ts
// src/main/services/cloud-api.ts
export function getCloudApi(): AxiosInstance | null {
  const settings = getSettings();
  if (!settings.qparkingBaseUrl || !settings.qparkingApiKey) return null; // not configured yet
  return axios.create({
    baseURL: `${settings.qparkingBaseUrl.replace(/\/+$/, '')}/api/v1/local-server`,
    headers: { Authorization: `Bearer ${settings.qparkingApiKey}` },
    timeout: CLOUD_REQUEST_TIMEOUT_MS, // 10s — no cloud call can hang forever
  });
}
```

Every cloud call in the app then follows the same three-line pattern:

```ts
const cloud = getCloudApi();
if (!cloud) return NOT_CONFIGURED;            // operator hasn't filled in Settings yet
const { data } = await cloud.get('/rate-policies');  // relative path — base URL + auth come from the client
```

What this buys:

- **One source of truth** — endpoints in services are short relative paths
  (`'/season-passes'`, `'/parking-records'`), not hand-assembled URLs.
- **Settings apply instantly** — `getCloudApi()` re-reads Settings on every call,
  so changing the base URL / API key needs no restart.
- **Uniform errors** — axios throws on any non-2xx, so failure handling is one
  `catch` per function instead of scattered `if (!res.ok)` checks. Shared helpers:
  `isHttpStatus(error, 404)` (e.g. tolerate older SaaS versions without an
  endpoint) and `describeRequestError(error)` (best human-readable message).
- **Timeouts everywhere by default** — previously some calls had none and could
  hang forever on a dead WAN.

Two deliberate exceptions that do **not** use the shared client:
`w4g-tng.ts` (see table above) and `lpr-webhook.ts` (an inbound HTTP *server*,
not a client).

### `src/renderer/` (React ⚛️)

100% ordinary React + TypeScript + Vite + Tailwind. `main.tsx` is the entry,
`App.tsx` the sidebar/shell, `pages/*.tsx` one file per screen (Dashboard,
Terminals, Cameras, Lanes, Sessions, Parking Rates, Settings, …). When it needs data or
an action, it calls `window.bridge.*`.

---

## A full flow through all layers

A car pays and exits:

```
1. exit camera  ──HTTP POST /lpr/event──►  services/lpr-webhook.ts   🟢 Node
                                              │ emits 'plate'
2.                                            ▼
                                       services/parking-flow.ts       🟢 Node
                                              │ find session (db.ts)
                                              │ compute fee (cloud-synced rate)
3.                                            ▼
                                       services/ecpi-terminal.ts      🟢 Node
                                              │ TCP: "tap card" → approved
4.                                            ▼
                                       db.ts recordExit + sync-queue.ts
                                              │ (→ Laravel via cloud-api.ts)
                                              │ emits 'exit-completed'
5.                                            ▼
                                       index.ts                        ⚡ Electron
                                              │ opens gate window
                                              │ sendToRenderer('session', …)
6.                                            ▼
                                       renderer/pages/Dashboard.tsx    ⚛️ React
                                              re-renders "recent sessions"
```

Steps 1–4 are pure backend and happen **even with no window open**. React (step 6)
only observes the result.

---

## Worked examples (with real code)

All snippets below are the *actual* code in this repo, trimmed for clarity.

### Example 1 — Reading data (the "Parking Rates" page)

The whole round-trip for "show the list of rate plans", across three files:

```tsx
// src/renderer/pages/ParkingPolicies.tsx   ⚛️ REACT — runs in the window
async function refresh() {
  setList(await window.bridge.listRatePolicies());   // ← the only Electron-aware line
}
useEffect(() => { void refresh(); }, []);       // load once on mount
```

```ts
// src/main/preload.ts             ⚡ the bridge — turns the call into a message
listRatePolicies: () => ipcRenderer.invoke('policies:list'),
```

```ts
// src/main/index.ts               🟢 the handler — runs in Node, reads SQLite
ipcMain.handle('policies:list', () => listRatePolicies());   // listRatePolicies() lives in services/db.ts
```

Read `window.bridge.listRatePolicies()` as `await axios.get('/api/rate-policies')` and the
whole thing is just React fetching from a backend.

### Example 2 — An action + refresh ("Sync now" button)

```tsx
// src/renderer/pages/ParkingPolicies.tsx
const [sync, syncing] = useAsyncAction(async () => {
  const r = await window.bridge.syncRatePoliciesNow();  // → pulls fresh rates from the Laravel API
  setResult(r);                                    // { ok: true, fetched: 7 }
  await refresh();                                 // re-read the now-updated local list
});
// <button onClick={() => sync()} disabled={syncing}>Sync now</button>
```

`syncRatePoliciesNow` → `ipcRenderer.invoke('policies:sync')` → `ipcMain.handle('policies:sync',
() => syncRatePolicies())`, and `syncRatePolicies()` (in `services/qparking-sync.ts`) calls
`GET /rate-policies` through the shared cloud client (`cloud-api.ts` adds the base URL +
`Bearer` token), maps the snake_case rows to local types, writes them to SQLite,
and returns the count.

### Example 3 — Live events pushed from the backend

The bottom "Parking-flow live log" strip. The backend pushes; React subscribes:

```tsx
// src/renderer/App.tsx            ⚛️ REACT — subscribe like a WebSocket
useEffect(() => {
  const off = window.bridge.onEvent('parking-flow-log', (p) => {
    setDebugLog((cur) => [...cur, p].slice(-200));  // keep last 200 lines
  });
  return off;                       // ← unsubscribe when the component unmounts
}, []);
```

```ts
// src/main/index.ts               🟢 the push side
parkingEvents.on('debug-log', (p) => sendToRenderer('parking-flow-log', p));
// sendToRenderer = mainWindow.webContents.send(channel, payload)
```

### Example 4 — How the fee is calculated (with numbers)

The simple block model in `services/parking-flow.ts` (`computeFee`):

```
billableMinutes = max(0, durationMinutes − freeMinutes)
blocks          = ceil(billableMinutes / blockMinutes)
feeCents        = firstBlockCents + (blocks − 1) × perBlockCents
                  (then capped at dailyCapCents, if a cap is set)
```

Worked example — rate plan: **first block RM 5.00, per block RM 3.00,
block = 60 min, free = 0 min**, car parked **2 h 30 m (150 min)**:

```
billable = 150 − 0            = 150 min
blocks   = ceil(150 / 60)     = 3
fee      = 500 + (3−1) × 300  = 1100 cents = RM 11.00
```

(Fees are always stored in **cents** — `1100` means RM 11.00 — so there's no
floating-point rounding on money.)

### Example 5 — What a session record looks like

One row from the `sessions` table (shape defined in `src/shared/types.ts`):

```jsonc
{
  "id": 42,
  "plate": "VMM1234",
  "entryAt": "2026-07-07T08:00:00.000Z",
  "exitAt":  "2026-07-07T10:30:00.000Z",
  "durationMinutes": 150,
  "feeCents": 1100,                 // RM 11.00
  "paymentStatus": "paid",          // pending | paid | declined | free | manual_release
  "cardScheme": "VISA",
  "terminalTxnId": "492******1234",
  "entryLaneId": 1,
  "exitLaneId": 2
}
```

While a car is still inside, `exitAt` is `null` (that's how "open sessions" are
found).

### Example 6 — How a DB upsert works (`?` placeholders, `ON CONFLICT`, `excluded`)

Every cloud-synced table (`rate_policies`, `sites`, …) is written with the same
**upsert** pattern (**up**date-or-in**sert**). Trimmed from the real
`upsertRatePolicy` in `services/db.ts`:

```ts
db.prepare(`INSERT INTO rate_policies (
    policy_id, policy_name, free_minutes
  ) VALUES (?,?,?)
  ON CONFLICT(policy_id) DO UPDATE SET
    policy_name   = excluded.policy_name,
    free_minutes = excluded.free_minutes`)
  .run(policy.policyId, policy.policyName, policy.freeMinutes);
```

Three pieces to understand:

**1. `?` placeholders + `.run(...)`** — the SQL is compiled once with holes in
it; `.run()` pours your values into those holes **in order** (1st `?` ←
`policy.policyId`, 2nd `?` ← `policy.policyName`, …). The argument order must match
the column list exactly. Why not build the SQL string by hand? Safety (a plate
named `'); DROP TABLE rate_policies;--` stays plain data — no SQL injection) and speed
(compile once, run many). Two idioms you'll see in every `.run()`:
- `x ?? null` — SQLite can't store `undefined`, so maybe-missing values become `NULL`.
- `flag ? 1 : 0` — SQLite has no boolean type; `true`/`false` are stored as `1`/`0`.

**2. `ON CONFLICT(policy_id) DO UPDATE`** — try the insert; if a row with that
`policy_id` already exists, don't fail — run the `UPDATE` on the existing row
instead. One statement handles both "first time seen" and "already cached".

**3. `excluded.<column>`** — inside the `DO UPDATE` there are two rows in play:
the **old row already in the table**, and the **new row that just got rejected**
(*excluded*) from inserting. `excluded.policy_name` means "the value I just tried
to insert" — i.e. the fresh data from the cloud:

```sql
SET policy_name = excluded.policy_name
--     ↑                ↑
--  old row's       the fresh value from
--  column          this sync's payload
```

Worked example — the cloud has policy `abc-123` named **"Weekend Rate"**:

| Sync tick | What happens |
|---|---|
| First ever | No row with `policy_id = 'abc-123'` → plain **insert** |
| Operator renames it in the cloud to "Weekend & Holiday Rate" | Next 60s sync sends the same id → insert **conflicts** on the primary key → `DO UPDATE` overwrites the cached name with `excluded.policy_name` |
| Every tick after | Same id, same values → conflict + update to identical values (harmless) |

Same id in, one row out, always fresh — that's why the 60-second sync can run
forever without ever creating duplicate rows.

### Recipe — add your own bridge call

Say you want a "count cars currently inside" button. Four small steps:

```ts
// 1. src/main/index.ts — add the handler (the "endpoint")
ipcMain.handle('sessions:count-inside', () => listOpenSessions().length);
```

```ts
// 2. src/main/preload.ts — expose it on window.bridge
countInside: () => ipcRenderer.invoke('sessions:count-inside'),
```

```ts
// 3. src/shared/types.ts — declare it on BridgeApi (required: preload is
//    type-checked against this interface, and it's what types window.bridge
//    in every React page)
countInside(): Promise<number>;
```

```tsx
// 4. any page in src/renderer — call it
const n = await window.bridge.countInside();
```

That's the whole pattern every feature in this app follows.

### Recipe — a complete feature, end to end ("Sync all tables" button)

The recipe above is the minimal skeleton. Here's a **full-size worked example** —
adding a Settings button that pulls *all* cloud tables (rate policies + season passes + parking spaces)
from the Laravel API in one click, with a spinner and a result message. It shows
where real logic, error handling, and UI states go in each layer. Same 4 hops,
bottom-up:

**Step 1 — Backend logic** (`src/main/services/qparking-sync.ts`). The real work
lives in a service, not in the IPC handler. Reuse the existing per-table syncs
and run them in parallel; the per-call `.catch(toFailedSyncResult)` converts any
crash into an `{ ok: false, error }` result so one failing endpoint doesn't
block the others:

```ts
/** Run all three pulls in parallel; one failing doesn't block the others. */
export async function syncAll(): Promise<{
  policies: SyncResult;
  passes: SyncResult;
  spaces: SyncResult;
}> {
  const [policies, passes, spaces] = await Promise.all([
    syncRatePolicies().catch(toFailedSyncResult),
    syncSeasonPasses().catch(toFailedSyncResult),
    syncParkingSpaces().catch(toFailedSyncResult),
  ]);
  return { policies, passes, spaces };
}
```

**Step 2 — IPC endpoint** (`src/main/index.ts`). Import the function, register
the channel. Handlers stay thin — one line that delegates to the service:

```ts
import { …, syncAll } from './services/qparking-sync';

ipcMain.handle('sync:all-tables', () => syncAll());
```

> Channel naming: pick something unambiguous. Here `sync:all-tables`, not
> `sync:all` — the existing `sync:*` channels are about the *outbound* queue
> (local → cloud); this one is inbound (cloud → local).

**Step 3 — Bridge + type** (`src/main/preload.ts` + `src/shared/types.ts`):

```ts
// preload.ts
syncAllNow: () => ipcRenderer.invoke('sync:all-tables'),

// types.ts (BridgeApi) — gives every page autocomplete on the result shape
syncAllNow(): Promise<{
  policies: { ok: boolean; fetched: number; error?: string };
  passes: { ok: boolean; fetched: number; error?: string };
  spaces: { ok: boolean; fetched: number; error?: string };
}>;
```

**Step 4 — UI** (`src/renderer/pages/Settings.tsx`). Use the page's existing
`useAsyncAction` hook — it gives you the busy flag for the spinner/disable —
and keep a result string in state:

```tsx
const [syncResult, setSyncResult] = useState<string | null>(null);

const [runSyncAll, syncingAll] = useAsyncAction(async () => {
  setSyncResult(null);
  const r = await window.bridge.syncAllNow();
  const bits = [`${r.policies.fetched} policies`, `${r.passes.fetched} passes`, `${r.spaces.fetched} spaces`];
  const errs = [r.policies, r.passes, r.spaces].filter((x) => !x.ok);
  setSyncResult(errs.length === 0
    ? `✓ Fetched ${bits.join(', ')}`
    : `✗ ${errs[0].error ?? 'sync failed'} (fetched ${bits.join(', ')})`);
});

<button onClick={() => runSyncAll()} disabled={syncingAll} className="…">
  {syncingAll ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
  {syncingAll ? 'Syncing…' : 'Sync now'}
</button>

{syncResult && (
  <div className={syncResult.startsWith('✓') ? '…green…' : '…red…'}>{syncResult}</div>
)}
```

**The full path of one click:**

```
click → runSyncAll() → window.bridge.syncAllNow()          ⚛️ React
      → ipcRenderer.invoke('sync:all-tables')              ⚡ preload
      → ipcMain.handle('sync:all-tables')                  ⚡ index.ts
      → syncAll() → 3× GET /api/v1/local-server/…          🟢 qparking-sync.ts → Laravel
      → rows written to SQLite, counts returned back up    🟢 db.ts
      → "✓ Fetched 7 policies, 12 passes, 40 spaces"         ⚛️ React
```

Rules of thumb baked into this example:
- **Logic in `services/`, not in the handler** — `index.ts` handlers are one-liners.
- **Errors cross the bridge as data** (`{ ok, error }`), not thrown exceptions —
  the UI decides how to show them.
- **Every button that awaits the bridge gets a busy state** (`useAsyncAction`)
  so double-clicks can't fire twice and the user sees progress.

---

## Running it (dev)

Prerequisites: **Node.js 20+** and **npm 10+**. (Windows builds need nothing
extra — `electron-builder` ships its own toolchain. Install Visual Studio Build
Tools only if `npm install` fails to find a prebuilt `better-sqlite3` binary.)

```cmd
cd qparking-local\app
npm install
npm run dev
```

`npm run dev` runs two things at once:
1. **Vite** serves the React UI on `http://localhost:5173`.
2. **Electron** waits for Vite, compiles `src/main`, then opens the window
   pointing at Vite. Hot-reload + Chrome DevTools work as normal.

> **What hot-reloads and what doesn't.** Edits under `src/renderer/` hot-reload
> instantly via Vite. Edits under `src/main/` (including `preload.ts` and
> `services/*`) do **NOT** — they're compiled once at startup, so you must
> **restart `npm run dev`** to pick them up. Tell-tale symptom of forgetting:
> you add a new method to `preload.ts` and the UI throws
> `window.bridge.yourMethod is not a function` — the window is still running
> the preload compiled before your edit.

> **Dev-launcher note.** VS Code (and other Electron-based hosts) leak an env var
> `ELECTRON_RUN_AS_NODE=1` into the terminal, which makes Electron boot as plain
> Node and crash on startup (`Cannot read properties of undefined (reading
> 'isPackaged')`). `scripts/dev-electron.mjs` deletes that variable before
> launching, so `npm run dev` works from any terminal.

**Dev vs packaged isolation:** dev uses `%APPDATA%/qparking-local-dev/` with
offset ports (LPR on **7001**); packaged uses `%APPDATA%/qparking-local/` with
normal ports (LPR on **6001**). This lets a dev build run side-by-side with the
installed one.

---

## Building the installer

```cmd
npm run package
```

Produces two `.exe` artefacts in `release/`:

- `QParkingLocal-<version>-x64.exe` — NSIS installer (Start menu + Desktop shortcuts).
- `QParkingLocal-<version>-portable.exe` — single self-extracting binary, no install.

The portable build is handy for testing on a new PC: copy the file, double-click, done.

---

## First-time configuration on a new site

1. Launch the app.
2. **Settings** → enter qparking base URL + API key → Save. Click **Parking Rates →
   Sync now**. The lane/rate-policy dropdowns now populate.
3. **Payment terminals** → Add each ECPI reader on the LAN:
   - Host = reader's static IP (default `192.168.1.199`)
   - Port = `5000` (ECPI default)
   - Secret key = the one assigned by CoherentPlus during commissioning
   - Plaza ID / Lane ID = whatever the integrator gave you
   - Driver mode = **Kiosk** for self-pay stations, **LPR** for gate-controlled readers
4. **LPR cameras** → Add each camera. Copy the webhook URL shown at the top of the
   page into the camera's "alarm-action / event-push" config. Use the per-camera
   webhook secret.
5. **Lanes** → Define one lane per entry/exit gate. Pick the rate policy and
   the payment terminal (exit lanes only).
6. **Cameras** → edit each camera and assign it to the right lane.
7. Back to **Terminals**, click **Connect** on each row to establish the TCP session.
8. **Dashboard** → watch the "Live plate events" panel as a real car drives
   through to confirm the wiring.

---

## Camera webhook contract

```
POST http://<this-pc>:6001/lpr/event
Content-Type: application/json
X-Webhook-Secret: <per-camera-secret>

{
  "cameraId": 1,
  "plate": "VMM1234",
  "confidence": 0.92,
  "image": "<optional base64 jpeg>",
  "timestamp": "2026-05-18T08:00:00Z",
  "direction": "entry"
}
```

(In dev mode the port is **7001**.) The intake also accepts common vendor
envelopes (Hikvision/Dahua/Uniview-family `AlarmInfoPlate`) and identifies the
camera by its LAN IP. If your camera can't POST JSON natively, write a small
bridge that reshapes its payload and POSTs to this endpoint.

---

## Testing without hardware

On the **LPR cameras** page each row has a **Simulate** button. Type a plate,
click Simulate — the system processes it as if the camera had fired. Cars
accumulate in the Dashboard's "Cars inside" list. Pair an entry camera + exit
camera against the same lane and walk through both to test the end-to-end flow.
There's also a **Demo full-flow** button that fires entry, waits, then fires exit
so you can watch the whole cycle from one click.

---

## Logs + diagnostics

- The **Parking-flow live log** strip at the bottom of the app shows every
  decision the exit flow makes (which guard fired, fee math, terminal replies) —
  no DevTools needed.
- Terminal TCP traffic is logged to the `terminal_log` table in SQLite — open
  `%APPDATA%\qparking-local\qparking-local.db` with any SQLite browser.
- Sessions are in the `sessions` table; open sessions have `exit_at IS NULL`.
- **Two different consoles — don't mix them up.** `console.log` in
  `src/renderer/` (React) prints in the app window's **DevTools** (Ctrl+Shift+I).
  `console.log` in `src/main/` (services, index.ts) prints in the **terminal
  running `npm run dev`** — the lines prefixed `[electron]` — and NEVER in
  DevTools.

---

## Jargon decoder

| Term | Meaning |
|------|---------|
| **LPR** | License-Plate Recognition (the cameras that read number plates) |
| **ECPI** | The payment-terminal protocol/brand this app drives over TCP |
| **W4G / TNG** | Touch'n'Go IO-controller integration (Malaysian e-wallet / card) |
| **rate policy / tariff** | A rate plan (how much to charge per hour/block), synced from the cloud |
| **session** | One car's visit: entry event → exit event |
| **qparking SaaS** | The cloud **Laravel API** this on-prem app syncs rates up/down with |
| **kiosk vs LPR mode** | Self-pay station vs gate-controlled reader — different terminal command sets |
