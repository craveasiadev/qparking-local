import { useCallback, useRef, useState } from 'react';

/**
 * Standard "click → spinner → done" wrapper for any async button handler.
 * Returns a tuple of [run, busy] where:
 *   - run(args) executes the action, blocks re-entry while it's running, and
 *     traps errors into an optional onError callback.
 *   - busy is true while the action is in flight (spinner / disabled state).
 *
 * Why: pages were firing async actions on click without any feedback, so
 * users couldn't tell whether the click "took". This makes the pattern a
 * one-liner — every button that talks to main process / network goes
 * through this hook.
 */
export function useAsyncAction<TArgs extends unknown[], TResult>(
  action: (...args: TArgs) => Promise<TResult>,
  opts: { onError?: (err: unknown) => void } = {}
): [(...args: TArgs) => Promise<TResult | undefined>, boolean] {
  const [busy, setBusy] = useState(false);
  // Re-entry guard separate from React state so back-to-back clicks within
  // the same tick (before the state flush) still bail out.
  const inFlight = useRef(false);

  const run = useCallback(async (...args: TArgs) => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setBusy(true);
    try {
      return await action(...args);
    } catch (e) {
      opts.onError?.(e);
      return undefined;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [action, opts]);

  return [run, busy];
}
