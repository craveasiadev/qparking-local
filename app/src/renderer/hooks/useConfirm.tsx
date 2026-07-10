import { useCallback, useState, type ReactNode } from 'react';

interface ConfirmOpts {
  /** Optional bold heading above the message. */
  title?: string;
  /** Body text. `\n` is honoured (rendered with whitespace-pre-line). */
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button for destructive actions. */
  danger?: boolean;
}

/**
 * Promise-based, in-DOM confirmation dialog — a drop-in replacement for the
 * native `window.confirm()`. On Electron the native alert/confirm dialogs
 * leave the renderer unable to focus inputs until a reload, so every page uses
 * this instead.
 *
 * Usage:
 *   const [confirm, confirmDialog] = useConfirm();
 *   ...
 *   if (!(await confirm({ message: 'Delete this?', danger: true }))) return;
 *   ...
 *   return (<div>… {confirmDialog}</div>);   // mount the dialog once
 */
export function useConfirm(): [(opts: ConfirmOpts) => Promise<boolean>, ReactNode] {
  const [state, setState] = useState<{ opts: ConfirmOpts; resolve: (v: boolean) => void } | null>(null);

  const confirm = useCallback(
    (opts: ConfirmOpts) => new Promise<boolean>((resolve) => setState({ opts, resolve })),
    [],
  );

  const settle = (value: boolean) => {
    if (state) state.resolve(value);
    setState(null);
  };

  const dialog: ReactNode = state ? (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4" onClick={() => settle(false)}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm bg-white rounded-2xl shadow-2xl overflow-hidden">
        <div className="p-5">
          {state.opts.title && <h2 className="text-base font-bold mb-1">{state.opts.title}</h2>}
          <p className="text-sm text-gray-600 whitespace-pre-line">{state.opts.message}</p>
        </div>
        <footer className="px-5 py-3 border-t border-gray-200 flex items-center justify-end gap-2">
          <button onClick={() => settle(false)}
            className="h-9 px-3 text-xs font-bold uppercase tracking-wide text-gray-600 hover:text-gray-900">
            {state.opts.cancelLabel ?? 'Cancel'}
          </button>
          <button onClick={() => settle(true)}
            className={`h-9 px-4 rounded-lg text-white text-xs font-bold uppercase tracking-wide ${
              state.opts.danger ? 'bg-red-600 hover:bg-red-700' : 'bg-gray-900 hover:bg-gray-800'
            }`}>
            {state.opts.confirmLabel ?? 'Confirm'}
          </button>
        </footer>
      </div>
    </div>
  ) : null;

  return [confirm, dialog];
}
