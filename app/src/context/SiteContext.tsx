import { createContext, useContext, useEffect, useState } from "react";
import type { Site } from "../shared/types";

interface SiteContextType {
	currentSite: Site | null;
	loading: boolean;
}

export const SiteContext = createContext<SiteContextType>({
	currentSite: null,
	loading: true,
});

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
export function SiteProvider({ children }: { children: React.ReactNode }) {
	const [currentSite, setCurrentSite] = useState<Site | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let alive = true;
		const load = () => {
			window.bridge.getCurrentSite().then((site) => {
					if (alive) setCurrentSite(site);
				})
				.catch((e) => console.error("[Sites] failed to load site", e))
				.finally(() => {
					if (alive) setLoading(false);
				});
		};
		load();
		const unsubscribe = window.bridge.onEvent("sync-status", () => load());
		const timer = window.setInterval(load, 20_000);
		return () => {
			alive = false;
			unsubscribe();
			window.clearInterval(timer);
		};
	}, []);

	return (
		<SiteContext.Provider
			value={{
				currentSite,
				loading,
			}}
		>
			{children}
		</SiteContext.Provider>
	);
}

/** Read the current site from SiteContext. Must be used under SiteProvider. */
export function useCurrentSite(): Site | null {
	return useContext(SiteContext).currentSite;
}
