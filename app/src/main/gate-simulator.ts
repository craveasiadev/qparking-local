/**
 * Visual gate-simulator window. Stands in for the real gate-relay until the
 * site is wired with hardware. Shows a full-screen red panel ("CLOSED") that
 * flashes green ("OPEN — <plate>") for a few seconds whenever the parking
 * flow decides a gate should open.
 *
 * Triggers (sent from main/index.ts via IPC):
 *   - car entered → lane=entry direction=in
 *   - car exited successfully (paid / free / manual_release) → lane=exit direction=out
 *   - operator clicks "Test gate" → lane=manual direction=test
 */
import { BrowserWindow } from 'electron';
import path from 'node:path';

let gateWindow: BrowserWindow | null = null;

export interface GateEvent {
  state: 'open' | 'closed';
  plate?: string;
  laneName?: string;
  direction?: 'in' | 'out' | 'test';
  /** Free-form tag for the renderer to pick a special layout:
   *   'please-pay'      → big "PLEASE PAY RM X.XX" with terminal-driving spinner
   *   'duplicate-scan'  → amber "ALREADY INSIDE — use exit lane"
   *   'no-terminal'     → red "TERMINAL NOT CONFIGURED" (operator action needed)
   *   'no-lane'         → red "CAMERA HAS NO LANE" (operator action needed) */
  reason?: string;
  /** Fee amount in cents — used by the 'please-pay' layout. */
  feeCents?: number;
  /** Auto-close after this many ms (driven by the renderer). */
  holdMs?: number;
}

export function openGateSimulator(isDev: boolean) {
  if (gateWindow && !gateWindow.isDestroyed()) {
    gateWindow.show();
    gateWindow.focus();
    return gateWindow;
  }

  gateWindow = new BrowserWindow({
    width: 720, height: 540,
    title: 'Gate Simulator',
    backgroundColor: '#dc2626', // red so first paint matches "closed" state
    autoHideMenuBar: true,
    alwaysOnTop: true, // operator wants to glance at this while doing other work
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    gateWindow.loadURL('http://localhost:5173/?view=gate');
  } else {
    gateWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { search: 'view=gate' });
  }

  gateWindow.on('closed', () => { gateWindow = null; });
  return gateWindow;
}

export function isGateOpen() { return !!gateWindow && !gateWindow.isDestroyed(); }

export function sendGateEvent(event: GateEvent) {
  if (gateWindow && !gateWindow.isDestroyed()) {
    gateWindow.webContents.send('gate-state', event);
  }
}
