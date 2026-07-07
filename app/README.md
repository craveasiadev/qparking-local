# QParking Local Server

On-prem parking controller. Runs as a Windows desktop app on the site's gate PC.
It sits between the physical parking hardware and the qparking cloud:

- **LPR cameras** over HTTP — cameras POST plate detections to our webhook.
- **ECPI payment terminals** over TCP (JSON + SHA-256 + heartbeat) — drives the
  gate's payment flow.
- **qparking SaaS** over HTTPS — a **Laravel REST API** we pull scope/rate config
  from every hour, so fees can be calculated even when the WAN is down, and push
  session records up to.

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
2. We look up the open session, compute duration + fee using the lane's scope rate.
3. We drive the payment terminal:
   - **Kiosk-mode lane**: `initExit` → wait for card tap → `proceedExit` → wait for txnStatus.
   - **LPR-mode lane**: `initCard` (reader settles the tap) → wait for cardRead.
4. On `APPROVED` we record the exit + open the gate.
5. On declined/timeout/cancelled the session stays open; the operator can
   manually release from the UI.

If the fee is 0 (within the free window, or the plate holds an active pass, or
the scope has no rate), we mark the session `free` and skip the terminal entirely.

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
but the backend lives in the same program:

```
React component                preload.ts                    index.ts (Node)
───────────────                ──────────                    ───────────────
window.bridge.listScopes()  →  ipcRenderer.invoke(         →  ipcMain.handle(
                                 'scopes:list')                 'scopes:list',
                                                                () => listScopes())
        (Promise)           ◄──   returns the rows        ◄──   reads SQLite
```

To trace any bridge call: find its name in `src/main/preload.ts` to get the
channel string (e.g. `'scopes:list'`), then search that string in
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
| `app-update.ts` | Self-updater: check cloud → download → relaunch. |

### `src/main/services/` (Node backend 🟢)

| File | Purpose |
|------|---------|
| `db.ts` | SQLite schema + every query (sessions, terminals, cameras, lanes, scopes, settings, sync queue). |
| `lpr-webhook.ts` | HTTP server the LPR cameras POST plate events to. Also powers the "Simulate" button. |
| `parking-flow.ts` | The brain: entry vs exit, fee calculation, drives the terminal, records the result, opens the gate. |
| `ecpi-terminal.ts` | Payment-terminal driver over a raw TCP socket (heartbeat + state machine). |
| `w4g-tng.ts` | Touch'n'Go integration — a parallel payment path via the W4G IO-controller. |
| `face-gate.ts` | Calls the face-auth turnstile's HTTP API to raise the barrier. |
| `qparking-sync.ts` | **Pull** from the Laravel API: `GET /api/v1/local-server/scopes`, `/passes`, `/spaces`, `/vehicle-types`, `/gate-commands/pending`, … (`Bearer <apiKey>`). |
| `sync-queue.ts` | **Push** to the Laravel API: `POST /api/v1/local-server/parking-records`, with retries so a WAN outage never drops a record. |
| `camera-snapshots.ts` | Fetches live JPEG snapshots from cameras (UI preview + cloud upload). |
| `camera-push.ts` | Mirrors the local camera registry up to the cloud. |
| `device-push.ts` | Mirrors terminals + lanes up to the cloud. |

### `src/renderer/` (React ⚛️)

100% ordinary React + TypeScript + Vite + Tailwind. `main.tsx` is the entry,
`App.tsx` the sidebar/shell, `pages/*.tsx` one file per screen (Dashboard,
Terminals, Cameras, Lanes, Sessions, Scopes, Settings, …). When it needs data or
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
                                       db.ts recordExit + sync-queue.ts (→ Laravel)
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

### Example 1 — Reading data (the "Rate plans" page)

The whole round-trip for "show the list of rate plans", across three files:

```tsx
// src/renderer/pages/Scopes.tsx   ⚛️ REACT — runs in the window
async function refresh() {
  setList(await window.bridge.listScopes());   // ← the only Electron-aware line
}
useEffect(() => { void refresh(); }, []);       // load once on mount
```

```ts
// src/main/preload.ts             ⚡ the bridge — turns the call into a message
listScopes: () => ipcRenderer.invoke('scopes:list'),
```

```ts
// src/main/index.ts               🟢 the handler — runs in Node, reads SQLite
ipcMain.handle('scopes:list', () => listScopes());   // listScopes() lives in services/db.ts
```

Read `window.bridge.listScopes()` as `await axios.get('/api/scopes')` and the
whole thing is just React fetching from a backend.

### Example 2 — An action + refresh ("Sync now" button)

```tsx
// src/renderer/pages/Scopes.tsx
const [sync, syncing] = useAsyncAction(async () => {
  const r = await window.bridge.syncScopesNow();  // → pulls fresh rates from the Laravel API
  setResult(r);                                    // { ok: true, fetched: 7 }
  await refresh();                                 // re-read the now-updated local list
});
// <button onClick={() => sync()} disabled={syncing}>Sync now</button>
```

`syncScopesNow` → `ipcRenderer.invoke('scopes:sync')` → `ipcMain.handle('scopes:sync',
() => syncScopes())`, and `syncScopes()` (in `services/qparking-sync.ts`) does
`GET /api/v1/local-server/scopes` with the `Bearer` token, writes the rows to
SQLite, and returns the count.

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
// 3. src/shared/types.ts — (optional) add the type for autocomplete
countInside(): Promise<number>;
```

```tsx
// 4. any page in src/renderer — call it
const n = await window.bridge.countInside();
```

That's the whole pattern every feature in this app follows.

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
2. **Settings** → enter qparking base URL + API key → Save. Click **Rate plans →
   Sync now**. The lane/scope dropdowns now populate.
3. **Payment terminals** → Add each ECPI reader on the LAN:
   - Host = reader's static IP (default `192.168.1.199`)
   - Port = `5000` (ECPI default)
   - Secret key = the one assigned by CoherentPlus during commissioning
   - Plaza ID / Lane ID = whatever the integrator gave you
   - Driver mode = **Kiosk** for self-pay stations, **LPR** for gate-controlled readers
4. **LPR cameras** → Add each camera. Copy the webhook URL shown at the top of the
   page into the camera's "alarm-action / event-push" config. Use the per-camera
   webhook secret.
5. **Lanes** → Define one lane per entry/exit gate. Pick the scope (rate set) and
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
- The Electron main process also writes to the console — open DevTools
  (Ctrl+Shift+I in dev) to see live output.

---

## Jargon decoder

| Term | Meaning |
|------|---------|
| **LPR** | License-Plate Recognition (the cameras that read number plates) |
| **ECPI** | The payment-terminal protocol/brand this app drives over TCP |
| **W4G / TNG** | Touch'n'Go IO-controller integration (Malaysian e-wallet / card) |
| **scope / tariff** | A rate plan (how much to charge per hour/block), synced from the cloud |
| **session** | One car's visit: entry event → exit event |
| **qparking SaaS** | The cloud **Laravel API** this on-prem app syncs rates up/down with |
| **kiosk vs LPR mode** | Self-pay station vs gate-controlled reader — different terminal command sets |
