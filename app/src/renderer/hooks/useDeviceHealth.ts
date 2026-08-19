import { useEffect, useState } from 'react';
import type { DeviceHealth, DeviceHealthKind } from '@shared/types';

/**
 * Live reachability of every device, as computed by the main process.
 *
 * Subscribe-only: the main process owns the probing (services/device-health.ts)
 * and pushes a full set of rows after every sweep. Pages must NOT ping devices
 * themselves — that is what the Dashboard used to do, and it meant health froze
 * whenever the operator navigated away and existed nowhere the cloud could see it.
 *
 * Rows also arrive within about a second of an LCD link dropping or a camera's SDK
 * handle changing, because those signals are pushed rather than polled.
 */
export function useDeviceHealth() {
  const [rows, setRows] = useState<DeviceHealth[]>([]);

  useEffect(() => {
    let cancelled = false;
    // Seed from the last computed snapshot so a page opened between sweeps is not
    // blank for up to a minute.
    window.bridge.getDeviceHealth()
      .then((snapshot) => { if (!cancelled) setRows(snapshot); })
      .catch(() => { /* health is decoration on these pages, never a blocker */ });

    const off = window.bridge.onEvent('device-health', (payload: unknown) => {
      if (!cancelled) setRows(payload as DeviceHealth[]);
    });
    return () => { cancelled = true; off(); };
  }, []);

  /** One device's row, or undefined before the first sweep has covered it. */
  const healthOf = (kind: DeviceHealthKind, deviceId: number): DeviceHealth | undefined =>
    rows.find((row) => row.kind === kind && row.deviceId === deviceId);

  return { rows, healthOf };
}
