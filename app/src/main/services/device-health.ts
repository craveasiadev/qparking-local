/**
 * Live reachability of the LAN equipment — LPR cameras, payment terminals and
 * driver-facing LCD panels — probed on one timer in the MAIN process.
 *
 * WHY THIS IS IN MAIN, not the renderer
 * -------------------------------------
 * Until now online/offline was computed by the Dashboard page itself, in React
 * state, on its own 60s loop. That had two consequences: health stopped updating
 * the moment the operator navigated to another page, and — because it never left
 * the renderer — there was nothing for the cloud to be told. Health is a property
 * of the site, not of a screen someone happens to be looking at, so it belongs
 * here: one owner, one truth, running whether or not a window is open.
 *
 * ONE PROBE PER DEVICE, BEST SIGNAL AVAILABLE
 * -------------------------------------------
 * The three device types are not equally knowable, and this module deliberately
 * does NOT flatten them into a single ping:
 *
 *   LCD      — we already hold a persistent socket to the panel with a keepalive
 *              (lcd-display.ts). Its link state IS the answer; probing again
 *              would be both redundant and less accurate.
 *   camera   — the vendor SDK's warm handle knows whether the camera is truly
 *              connected, including the case that matters most: port open but
 *              credentials refused. That is authoritative and beats any probe.
 *              Only when the SDK has no opinion (no DLL, no credentials, handle
 *              still warming) do we fall back to an HTTP ping — and we mark the
 *              result `via: 'http'` so nothing downstream mistakes "something
 *              answered" for "the camera works".
 *   terminal — a TCP probe is all there is; the W4G protocol is not spoken.
 *
 * WHAT `changedAt` IS FOR
 * -----------------------
 * The operator-facing question is never "how long ago did this break" but "what
 * time did it break" — the number you correlate against CCTV, a shift log, or a
 * car that has been sitting at a boom. So each row carries the absolute instant
 * its current status began, carried forward untouched while the status holds and
 * persisted to SQLite so a restart does not re-date every outage to boot time.
 */
import { EventEmitter } from 'node:events';
import {
  listCameras, listTerminals, listLcds,
  listDeviceHealth, saveDeviceHealth, pruneDeviceHealth,
} from './db';
import { getLcdStatuses, lcdEvents } from './lcd-display';
import { cameraRelayHealth, cameraRelayEvents } from './camera-relay';
import { pingCamera } from './camera-probe';
import { pingTerminalHost } from './payment-probe';
import type {
  DeviceHealth, DeviceHealthKind, DeviceHealthStatus, DeviceHealthVia, LcdDisplayStatus,
  LcdDisplay, LprCamera, PaymentTerminal,
} from '../../shared/types';

/**
 * Probe cadence. 60s is a deliberate compromise, not a default nobody thought
 * about: a payment terminal gets a fresh socket opened and dropped on every
 * tick, and hammering vendor hardware to shave seconds off a status chip is a
 * bad trade. Matches the interval the Dashboard used before this moved to main.
 */
export const HEALTH_PROBE_INTERVAL_MS = 60_000;

/**
 * How long a burst of live-signal changes is collected before refreshing.
 *
 * A panel stuck in a reconnect loop can announce several times a second; without
 * a window each one would rewrite every health row and wake the renderer and the
 * heartbeat. One second is short enough to be imperceptible next to the 60s sweep
 * this replaces, and long enough to collapse a flap into a single update.
 */
const LIVE_REFRESH_DEBOUNCE_MS = 1_000;

/** Emits 'health' with the full DeviceHealth[] after every sweep. */
export const deviceHealthEvents = new EventEmitter();

/** kind:deviceId → last computed row. Rebuilt from SQLite at boot. */
const current = new Map<string, DeviceHealth>();

let timer: NodeJS.Timeout | null = null;
/** Guard against overlapping sweeps — a slow device must not stack ticks. */
let sweeping = false;

const keyOf = (kind: DeviceHealthKind, deviceId: number) => `${kind}:${deviceId}`;

/** One probe's raw finding, before it is folded against the previous status. */
interface Finding {
  status: DeviceHealthStatus;
  via: DeviceHealthVia;
  latencyMs: number | null;
  detail: string | null;
  /**
   * When this finding was actually established. Set only when a row is carried
   * forward un-rechecked, so `checkedAt` keeps telling the truth about the last
   * time we really looked rather than the last time we recomputed.
   */
  checkedAt?: string;
}

/**
 * What a refresh is allowed to do.
 *
 * `probeNetwork: false` is the event-driven path: it recomputes from signals that
 * cost nothing (our own LCD sockets, the camera SDK's warm handles) and carries
 * everything else forward untouched. That is what lets a dropped panel reach the
 * cloud in about a second WITHOUT opening a socket to every payment terminal on
 * the site each time one flaps.
 */
interface SweepOptions {
  probeNetwork: boolean;
}

/** Reuse a previous verdict verbatim — nothing new was learned about this device. */
function carryForward(previous: DeviceHealth): Finding {
  return {
    status: previous.status,
    via: previous.via,
    latencyMs: previous.latencyMs,
    detail: previous.detail,
    checkedAt: previous.checkedAt,
  };
}

/** Identity fields joined in from the device table, never stored on the health row. */
interface Identity {
  kind: DeviceHealthKind;
  deviceId: number;
  externalId: string | null;
  name: string;
  address: string;
}

// ─── per-type probes ────────────────────────────────────────────────────────

function probeLcd(lcd: LcdDisplay, statuses: LcdDisplayStatus[]): Finding {
  if (!lcd.enabled) return { status: 'disabled', via: 'config', latencyMs: null, detail: null };
  const status = statuses.find((s) => s.lcdId === lcd.id);
  // No link object at all means reloadLcdLinks has not caught up with a freshly
  // saved panel — report it as offline with the reason rather than inventing an
  // "online" we have no evidence for.
  if (!status) return { status: 'offline', via: 'link', latencyMs: null, detail: 'no link yet' };
  return {
    status: status.connected ? 'online' : 'offline',
    via: 'link',
    latencyMs: null,
    detail: status.connected ? null : (status.lastError ?? 'not connected'),
  };
}

async function probeCamera(camera: LprCamera, opts: SweepOptions, previous?: DeviceHealth): Promise<Finding> {
  // Enabled-ness is read fresh on every pass, network or not: it is a local
  // column, and an operator who just switched a device off expects to see that.
  if (!camera.enabled) return { status: 'disabled', via: 'config', latencyMs: null, detail: null };

  // The SDK's answer wins whenever it has one — it is the only layer that can
  // distinguish a working camera from a port that merely answers. Free to read.
  const relay = cameraRelayHealth(camera);
  if (relay.known) {
    return { status: relay.up ? 'online' : 'offline', via: 'sdk', latencyMs: null, detail: relay.detail };
  }

  if (!camera.host) return { status: 'offline', via: 'config', latencyMs: null, detail: 'no host configured' };

  // No SDK opinion and we are not allowed on the network: keep what we had. A
  // device with no previous verdict is probed regardless — carrying nothing
  // forward would leave it invisible until the next full sweep.
  if (!opts.probeNetwork && previous) return carryForward(previous);

  const ping = await pingCamera(camera.id);
  return {
    status: ping.ok ? 'online' : 'offline',
    via: 'http',
    latencyMs: ping.latencyMs ?? null,
    // An auth refusal is ONLINE — the device answered, which is all this probe can
    // ever establish — but it is worth naming, because "reachable" and "usable"
    // are different things and only the SDK path can tell you the second (see
    // cameraRelayHealth above, which is consulted first and wins when it has an
    // opinion).
    detail: ping.ok
      ? (ping.needsAuth ? `reachable, but the web interface refused the request (HTTP ${ping.status})` : null)
      : (ping.error ?? (ping.status ? `HTTP ${ping.status}` : 'no response')),
  };
}

async function probeTerminal(terminal: PaymentTerminal, opts: SweepOptions, previous?: DeviceHealth): Promise<Finding> {
  if (!terminal.enabled) return { status: 'disabled', via: 'config', latencyMs: null, detail: null };
  // A TCP probe is the ONLY signal a terminal has, so a network-free refresh can
  // only repeat what it already knew.
  if (!opts.probeNetwork && previous) return carryForward(previous);
  const ping = await pingTerminalHost(terminal.host, terminal.port);
  return {
    status: ping.ok ? 'online' : 'offline',
    via: 'tcp',
    latencyMs: ping.latencyMs ?? null,
    detail: ping.ok ? null : (ping.error ?? 'no response'),
  };
}

// ─── folding a finding into a stored row ────────────────────────────────────

/**
 * Combine a fresh finding with what we knew before.
 *
 * The whole point of this function is `changedAt`: it moves ONLY when the status
 * actually differs from last time. A device that has been offline for two hours
 * keeps reporting the instant it went down, sweep after sweep.
 */
function fold(identity: Identity, finding: Finding, at: string): DeviceHealth {
  const previous = current.get(keyOf(identity.kind, identity.deviceId));
  const statusHeld = previous?.status === finding.status;
  return {
    ...identity,
    status: finding.status,
    via: finding.via,
    latencyMs: finding.latencyMs,
    detail: finding.detail,
    checkedAt: finding.checkedAt ?? at,
    // First sight of a device counts as a change — there is no earlier instant
    // to carry forward, and `at` is genuinely when this status was first seen.
    changedAt: statusHeld && previous ? previous.changedAt : at,
    lastOnlineAt: finding.status === 'online' ? at : (previous?.lastOnlineAt ?? null),
  };
}

function cameraIdentity(camera: LprCamera): Identity {
  return {
    kind: 'camera',
    deviceId: camera.id,
    externalId: camera.externalId ?? null,
    name: camera.name,
    address: camera.host ? `${camera.host}:${camera.devicePort ?? 80}` : 'no host',
  };
}

function terminalIdentity(terminal: PaymentTerminal): Identity {
  return {
    kind: 'terminal',
    deviceId: terminal.id,
    externalId: terminal.externalId ?? null,
    name: terminal.name,
    address: `${terminal.host}:${terminal.port}`,
  };
}

function lcdIdentity(lcd: LcdDisplay): Identity {
  return {
    kind: 'lcd',
    deviceId: lcd.id,
    externalId: lcd.externalId ?? null,
    name: lcd.name,
    address: `${lcd.host}:${lcd.port}`,
  };
}

// ─── the sweep ──────────────────────────────────────────────────────────────

/**
 * Recompute every device's health once and publish the result.
 *
 * Every device is handled in PARALLEL: one unreachable terminal sits out its full
 * socket timeout, and serialising would let a couple of dead devices push the
 * sweep past its own interval.
 *
 * Default is a FULL sweep (probes included) — that is the 60s timer. The
 * event-driven path passes `probeNetwork: false`; see SweepOptions.
 */
export async function sweepDeviceHealth(opts: SweepOptions = { probeNetwork: true }): Promise<DeviceHealth[]> {
  if (sweeping) return snapshotDeviceHealth();
  sweeping = true;
  try {
    const cameras = listCameras();
    const terminals = listTerminals();
    const lcds = listLcds();
    // Read the LCD link table once for the whole sweep, not per panel.
    const lcdStatuses = getLcdStatuses();
    const at = new Date().toISOString();
    const previousOf = (kind: DeviceHealthKind, id: number) => current.get(keyOf(kind, id));

    const rows = await Promise.all([
      ...cameras.map(async (camera) =>
        fold(cameraIdentity(camera), await probeCamera(camera, opts, previousOf('camera', camera.id)), at)),
      ...terminals.map(async (terminal) =>
        fold(terminalIdentity(terminal), await probeTerminal(terminal, opts, previousOf('terminal', terminal.id)), at)),
      ...lcds.map(async (lcd) => fold(lcdIdentity(lcd), probeLcd(lcd, lcdStatuses), at)),
    ]);

    current.clear();
    for (const row of rows) {
      current.set(keyOf(row.kind, row.deviceId), row);
      saveDeviceHealth(row);
    }
    pruneDeviceHealth(rows.map((r) => ({ kind: r.kind, deviceId: r.deviceId })));

    deviceHealthEvents.emit('health', rows);
    return rows;
  } finally {
    sweeping = false;
  }
}

/** The last computed rows, without probing. Cheap enough for any caller. */
export function snapshotDeviceHealth(): DeviceHealth[] {
  return [...current.values()];
}

/**
 * Rehydrate the last-known rows from SQLite, joining the device tables for the
 * name / address / external id.
 *
 * Called at boot so the UI (and the first heartbeat) has something truthful
 * before the first sweep completes, and so `changedAt` survives a restart.
 * Health rows whose device is gone are ignored here and pruned by the next sweep.
 */
function rehydrate(): void {
  const identities = new Map<string, Identity>();
  for (const camera of listCameras()) identities.set(keyOf('camera', camera.id), cameraIdentity(camera));
  for (const terminal of listTerminals()) identities.set(keyOf('terminal', terminal.id), terminalIdentity(terminal));
  for (const lcd of listLcds()) identities.set(keyOf('lcd', lcd.id), lcdIdentity(lcd));

  for (const stored of listDeviceHealth()) {
    const key = keyOf(stored.kind, stored.deviceId);
    const identity = identities.get(key);
    if (!identity) continue;
    current.set(key, { ...stored, ...identity });
  }
}

/**
 * Refresh from the live signals, soon, without touching the network.
 *
 * Called when an LCD link or a camera's SDK handle changes state — both of which
 * are known the instant they happen. Without this the monitor would not notice
 * until its next 60s tick, which is exactly why the cloud used to lag a minute
 * behind this app's own Displays page.
 *
 * The single queued timer is what makes a flapping device cheap: any number of
 * announcements inside the window collapse into one refresh, and because a
 * refresh is already scheduled we simply return rather than re-arming (a plain
 * trailing debounce would let a device flapping faster than the window postpone
 * its own update forever).
 */
let liveRefreshTimer: NodeJS.Timeout | null = null;

export function requestLiveHealthRefresh(): void {
  if (liveRefreshTimer) return;
  liveRefreshTimer = setTimeout(() => {
    liveRefreshTimer = null;
    void sweepDeviceHealth({ probeNetwork: false }).catch(() => null);
  }, LIVE_REFRESH_DEBOUNCE_MS);
}

export function startDeviceHealth(): void {
  if (timer) return;
  rehydrate();
  void sweepDeviceHealth().catch(() => null);
  timer = setInterval(() => { void sweepDeviceHealth().catch(() => null); }, HEALTH_PROBE_INTERVAL_MS);

  // Push, not poll, for the two signals that can push. Everything else (terminal
  // and credential-less camera probes) still waits for the timer above, because a
  // socket probe is the only thing that can tell us about those at all.
  lcdEvents.on('link', requestLiveHealthRefresh);
  cameraRelayEvents.on('relay', requestLiveHealthRefresh);
}

export function stopDeviceHealth(): void {
  if (timer) { clearInterval(timer); timer = null; }
  if (liveRefreshTimer) { clearTimeout(liveRefreshTimer); liveRefreshTimer = null; }
  lcdEvents.off('link', requestLiveHealthRefresh);
  cameraRelayEvents.off('relay', requestLiveHealthRefresh);
}
