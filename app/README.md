# QParking Local Server

On-prem parking controller. Runs as a Windows desktop app on the site's PC. Talks to:

- **LPR cameras** over HTTP — cameras POST plate detections to our webhook.
- **ECPI payment terminals** over TCP (JSON + SHA-256 + heartbeat) — drives the gate's payment flow.
- **qparking SaaS** over HTTPS — pulls scope/rate config every hour, so fees can be calculated even when WAN is down.

State lives in a local SQLite DB at `%APPDATA%\qparking-local\qparking-local.db`. Captured plate images go to `%APPDATA%\qparking-local\plates\<date>\`.

## What it does

When a car enters:
1. LPR camera reads the plate, POSTs to `/lpr/event`.
2. We create a parking session (plate + entry timestamp).
3. (Optional) pulse the gate-relay to open the barrier.

When a car exits:
1. Exit-lane LPR camera reads the plate, POSTs to `/lpr/event`.
2. We look up the open session, compute duration + fee using the lane's scope rate.
3. We drive the payment terminal:
   - **Kiosk-mode lane**: `initExit` → wait for card tap → `proceedExit` → wait for txnStatus.
   - **LPR-mode lane**: `initTxn` (reader handles the whole EMV flow) → wait for txnResult.
4. On `APPROVED` we record the exit + open the gate.
5. On declined/timeout/cancelled the session stays open; the operator can manually release from the UI.

If the fee is 0 (within the free window or scope has no rate), we mark the session as `free` and skip the terminal entirely.

## Setup

Prerequisites:
- **Node.js 20+** and **npm 10+**
- For Windows builds: nothing extra — `electron-builder` ships its own toolchain.
- Optional: **Visual Studio Build Tools** (only if `npm install` fails on `better-sqlite3` — it usually finds a prebuilt binary).

```cmd
cd qparking-local\app
npm install
npm run dev
```

`npm run dev` starts Vite (renderer at :5173), waits for it, then launches Electron.

## Build the installer

```cmd
npm run package
```

Produces two `.exe` artefacts in `release/`:

- `QParkingLocal-0.1.0-x64.exe` — NSIS installer (creates Start menu + Desktop shortcuts).
- `QParkingLocal-0.1.0-portable.exe` — single self-extracting binary, no install required.

The portable build is useful for testing on a new PC: copy the file, double-click, done.

## First-time configuration on a new site

1. Launch the app.
2. **Settings** → enter qparking base URL + API key → Save. Click **Scopes → Sync now**. The lane/scope dropdowns now populate.
3. **Terminals** → Add each ECPI payment reader on the LAN:
   - Host = reader's static IP (default `192.168.1.199`)
   - Port = `5000` (ECPI default)
   - Secret key = the one assigned by CoherentPlus during commissioning
   - Plaza ID / Lane ID = whatever the integrator gave you
   - Driver mode = **Kiosk** for self-pay stations, **LPR** for gate-controlled readers
4. **LPR cameras** → Add each camera. Copy the webhook URL shown at the top of the page and paste it into the camera's "alarm-action / event-push" config. Use the per-camera webhook secret.
5. **Lanes** → Define one lane per entry/exit gate. Pick the scope (rate set) and the payment terminal (exit lanes only).
6. **Cameras** → edit each camera and assign it to the right lane.
7. Back to **Terminals**, click **Connect** on each row to establish the TCP session.
8. **Dashboard** → watch the "Live plate events" panel as a real car drives through to confirm the wiring.

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

If your camera can't POST JSON natively, write a small bridge that reshapes its native payload and POSTs to this endpoint.

## Testing without hardware

In the **LPR cameras** page each row has a **Simulate** button. Type a plate, click Simulate — the system processes it as if the camera had fired. Cars accumulate in the Dashboard's "Cars inside" list. Pair an entry camera + exit camera against the same lane and walk through both to test the end-to-end flow.

## Logs + diagnostics

- Terminal TCP traffic is logged to the `terminal_log` table in SQLite — query with any SQLite browser pointed at `%APPDATA%\qparking-local\qparking-local.db`.
- Sessions are in the `sessions` table; open sessions have `exit_at IS NULL`.
- The Electron main process writes to the console — open DevTools (Ctrl+Shift+I in dev mode) to see live output.

## Files

```
app/
├── src/main/                 — Electron main process (Node)
│   ├── index.ts              — entrypoint, IPC handlers, window + tray
│   ├── preload.ts            — contextBridge surface for the renderer
│   ├── db.ts                 — SQLite schema + repositories
│   ├── ecpi-terminal.ts      — TCP/JSON/SHA-256 ECPI driver (heartbeat + state machine)
│   ├── lpr-webhook.ts        — HTTP server that accepts plate events
│   ├── parking-flow.ts       — entry/exit state machine + fee calculator
│   └── qparking-sync.ts      — pulls scope rates from the SaaS hourly
├── src/renderer/             — React UI
│   ├── pages/                — Dashboard, Terminals, Cameras, Lanes, Scopes, Sessions, Settings
│   └── App.tsx
└── src/shared/types.ts       — wire types shared between main + renderer
```
