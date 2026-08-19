import { Wifi, WifiOff } from 'lucide-react';
import type { DeviceHealth } from '@shared/types';
import { fmtSince } from '../lib/datetime';

/**
 * Live online/offline pill for one device, shared by the Cameras, Terminals and
 * Displays pages so all three read identically and cannot drift apart.
 *
 * WHY IT IS COMPACT
 * -----------------
 * This sits beside the device name, where an operator is scanning a list for the
 * one thing that is broken. So the pill carries the verdict only; the *reason* and
 * the exact time go in the tooltip, where they are one hover away without turning
 * every row into a paragraph. (The Dashboard's version spells the time out inline,
 * because there the row IS the alert.)
 *
 * WHY IT RENDERS NOTHING WHEN DISABLED
 * ------------------------------------
 * Every card that uses this already shows its own `disabled` pill. Two pills
 * saying the same thing is noise, and "offline" would be an outright lie about a
 * device nobody is probing.
 */
export function DeviceHealthBadge({ health }: { health?: DeviceHealth }) {
  // Before the first sweep has covered this device there is genuinely nothing to
  // claim. Saying nothing beats inventing a green pill.
  if (!health || health.status === 'disabled') return null;

  const base = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border';
  const online = health.status === 'online';

  // How much the verdict is worth. A camera "online" via an HTTP ping has only
  // proved that something answered on that port — materially weaker than the SDK
  // reporting itself connected, and the operator deserves to know which they have.
  const evidence =
    health.via === 'sdk' ? 'The camera SDK reports itself connected.'
    : health.via === 'link' ? 'Our socket to this panel is open.'
    : health.via === 'http' ? 'The HTTP port answered — this proves the port responds, not that the camera is working.'
    : health.via === 'tcp' ? 'The TCP port is listening — this proves the port responds, not that the device is working.'
    : 'Not probed.';

  const tooltip = [
    online
      ? `Online since ${fmtSince(health.changedAt)}.`
      : `Offline since ${fmtSince(health.changedAt)}.`,
    health.detail,
    evidence,
    health.latencyMs != null ? `Answered in ${health.latencyMs}ms.` : null,
    `Last checked ${fmtSince(health.checkedAt)}.`,
  ].filter(Boolean).join(' ');

  return (
    <span
      title={tooltip}
      className={`${base} ${online
        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
        : 'bg-amber-50 text-amber-700 border-amber-200'}`}
    >
      {online ? <Wifi size={10} /> : <WifiOff size={10} />}
      {online ? 'online' : 'offline'}
    </span>
  );
}
