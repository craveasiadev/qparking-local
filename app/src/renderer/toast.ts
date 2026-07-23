/**
 * App-wide toast bus. The actual toast UI + lifecycle lives in App.tsx
 * (pushAlert / the top-right stack); this is just a module-level pub/sub so any
 * component — however deeply nested — can raise one without prop-drilling or a
 * context provider. App subscribes once and forwards each event to pushAlert.
 */
export type ToastTone = 'error' | 'warn' | 'success';

export interface ToastInput {
  tone: ToastTone;
  title: string;
  detail?: string;
  /** Auto-dismiss delay; falls back to App's default when omitted. */
  ttlMs?: number;
}

type Listener = (t: ToastInput) => void;
const listeners = new Set<Listener>();

/** Raise a toast from anywhere in the renderer. */
export function toast(t: ToastInput): void {
  listeners.forEach((l) => l(t));
}

/** App wires this up once; returns an unsubscribe for cleanup. */
export function subscribeToast(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
