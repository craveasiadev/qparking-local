import { useEffect, useState } from 'react';
import type { Site } from '@shared/db-models';

/**
 * The operator's site this local server is linked to, or null when it isn't
 * linked yet. `getCurrentSite()` is populated by syncSite() once the qparking
 * base URL + API key resolve, so null is the ground-truth "not connected to an
 * operator's site" signal (a fresh install has no site row).
 *
 * Refreshes on mount, whenever a cloud sync reports status (the moment a site
 * would land), and on a slow poll as a catch-all — there's no dedicated
 * "site-synced" event to hang off. Shared by the global not-connected banner
 * and the dashboard's cloud-sync panel so both agree on connection state.
 */
export function useCurrentSite(): Site | null {
  const [site, setSite] = useState<Site | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      window.bridge.getCurrentSite()
        .then((s) => { if (alive) setSite(s); })
        .catch(() => null);
    };
    load();
    const off = window.bridge.onEvent('sync-status', () => load());
    const timer = window.setInterval(load, 20_000);
    return () => { alive = false; off(); window.clearInterval(timer); };
  }, []);

  return site;
}
