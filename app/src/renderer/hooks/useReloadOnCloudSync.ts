import { useEffect, useRef } from 'react';
import type { CloudMirror } from '@shared/types';

/**
 * Re-read a page's list whenever a cloud mirror it shows has just been pulled
 * down — the header's "Sync now", the recurring tick, app boot, or a rebind.
 *
 * Why: every page loads its rows once, on mount. A sync writes the fresh rows
 * into SQLite but the open page kept rendering the old ones, so a pass issued
 * or a plate banned in the cloud looked like it never arrived until the
 * operator pressed that page's own Refresh. This closes that gap.
 *
 * Only fires for the mirrors named — a customers pull must not re-run the
 * Vehicles page's two queries, and vice versa.
 *
 * `reload` is held in a ref: pages build it with useAsyncAction, whose identity
 * changes on every render, and re-subscribing that often would tear the
 * listener down and back up mid-sync.
 */
export function useReloadOnCloudSync(mirrors: CloudMirror[], reload: () => unknown): void {
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  // Subscribe on the CONTENT of the list, not its identity — every call site
  // passes an inline array literal, which is a new object each render.
  const watched = mirrors.join(',');

  useEffect(() => {
    const wanted = new Set(watched.split(','));
    return window.bridge.onEvent('cloud-mirrors', (payload) => {
      const refreshed = Array.isArray(payload) ? payload : [];
      if (refreshed.some((mirror) => wanted.has(String(mirror)))) void reloadRef.current();
    });
  }, [watched]);
}
