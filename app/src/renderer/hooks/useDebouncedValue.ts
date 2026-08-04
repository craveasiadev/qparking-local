import { useEffect, useState } from 'react';

/**
 * Debounced copy of a value — used to hold back a search box's keystrokes so
 * the paged-list fetch only fires once typing pauses. Pass the already-trimmed
 * value (e.g. `useDebouncedValue(search.trim())`).
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
	const [debounced, setDebounced] = useState(value);
	useEffect(() => {
		const h = setTimeout(() => setDebounced(value), delayMs);
		return () => clearTimeout(h);
	}, [value, delayMs]);
	return debounced;
}
