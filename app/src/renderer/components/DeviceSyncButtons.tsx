import { useState } from 'react';
import { UploadCloud, DownloadCloud, Loader2, AlertTriangle } from 'lucide-react';
import type { DeviceSyncType, DeviceSyncPreview } from '@shared/types';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { toast } from '../toast';

/**
 * The manual "Push to cloud" / "Pull from cloud" pair shown on each device page
 * (Cameras / Lanes / Terminals). Both are destructive mirrors, so each first
 * previews the diff, shows a "cannot be undone" confirmation with the counts,
 * and only syncs on confirm. `onDone` refreshes the host page's list.
 */
const NOUN: Record<DeviceSyncType, string> = {
  cameras: 'cameras',
  lanes: 'lanes',
  terminals: 'terminals',
};

export function DeviceSyncButtons({ type, onDone }: { type: DeviceSyncType; onDone?: () => void | Promise<void> }) {
  const [dialog, setDialog] = useState<{ direction: 'push' | 'pull'; preview: DeviceSyncPreview } | null>(null);
  const noun = NOUN[type];
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);

  const failToast = (detail: string) => toast({ tone: 'error', title: `${Noun} sync failed`, detail });

  const [openConfirm, opening] = useAsyncAction(
    async (direction: 'push' | 'pull') => {
      const preview = await window.bridge.previewDeviceSync(type, direction);
      if (!preview.ok) { failToast(preview.error ?? 'Could not reach the cloud'); return; }
      setDialog({ direction, preview });
    },
    { onError: (e) => failToast(String((e as any)?.message ?? e)) },
  );

  const [runSync, syncing] = useAsyncAction(
    async () => {
      if (!dialog) return;
      if (dialog.direction === 'push') {
        const r = await window.bridge.pushDevicesToCloud(type);
        if (!r.ok) { failToast(r.error ?? 'Push failed'); setDialog(null); return; }
        const failed = (r.items ?? []).filter((i) => !i.ok && !i.skipped).length;
        const pushed = (r.items ?? []).filter((i) => i.ok).length;
        toast({
          tone: failed ? 'warn' : 'success',
          title: `Pushed ${pushed} ${noun} to cloud`,
          detail: `Removed ${r.removed ?? 0} from cloud${failed ? ` · ${failed} failed` : ''}`,
        });
      } else {
        const r = await window.bridge.pullDevicesFromCloud(type);
        if (!r.ok) { failToast(r.error ?? 'Pull failed'); setDialog(null); return; }
        toast({ tone: 'success', title: `Pulled ${r.applied ?? 0} ${noun} from cloud`, detail: `Replaced this PC's ${noun} with the cloud's.` });
      }
      setDialog(null);
      await onDone?.();
    },
    { onError: (e) => { failToast(String((e as any)?.message ?? e)); setDialog(null); } },
  );

  const busy = opening || syncing;

  return (
    <>
      <div className="inline-flex items-center gap-2">
        <button
          onClick={() => openConfirm('push')}
          disabled={busy}
          title={`Mirror this PC's ${noun} to the cloud (removes cloud ${noun} not here)`}
          className="inline-flex items-center gap-1.5 h-10 px-3 rounded-lg border border-gray-200 hover:border-gray-900 text-xs font-bold uppercase tracking-wide text-gray-700 disabled:opacity-50"
        >
          {opening ? <Loader2 size={13} className="animate-spin" /> : <UploadCloud size={14} />} Push to cloud
        </button>
        <button
          onClick={() => openConfirm('pull')}
          disabled={busy}
          title={`Replace this PC's ${noun} with the cloud's`}
          className="inline-flex items-center gap-1.5 h-10 px-3 rounded-lg border border-gray-200 hover:border-gray-900 text-xs font-bold uppercase tracking-wide text-gray-700 disabled:opacity-50"
        >
          <DownloadCloud size={14} /> Pull from cloud
        </button>
      </div>

      {dialog && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4" onClick={() => !syncing && setDialog(null)}>
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden">
            <div className="p-5 space-y-3">
              <h2 className="inline-flex items-center gap-2 text-base font-bold">
                <AlertTriangle size={16} className="text-amber-500" />
                {dialog.direction === 'push' ? `Push ${noun} to cloud?` : `Pull ${noun} from cloud?`}
              </h2>
              {dialog.direction === 'push' ? (
                <p className="text-sm text-gray-600">
                  This makes the cloud match this PC. <strong>{dialog.preview.toAdd} added</strong>, <strong>{dialog.preview.toUpdate} updated</strong>, and <strong>{dialog.preview.toRemove} removed</strong> from the cloud
                  {dialog.preview.toRemove > 0 ? ` (${noun} no longer on this PC).` : '.'}
                </p>
              ) : (
                <p className="text-sm text-gray-600">
                  This replaces this PC's {noun} with the cloud's: <strong>{dialog.preview.toAdd} added</strong>, <strong>{dialog.preview.toUpdate} updated</strong>, and <strong>{dialog.preview.toRemove} removed</strong> locally.
                  {/* Per type, because it stopped being one rule. Cameras now
                      mirror their whole LAN wiring (2026-08-12), so a pull leaves
                      them usable; terminals still keep their timeout locally;
                      lanes have nothing local to lose. Saying "secrets are not
                      restored" for cameras would send an operator off to re-type
                      passwords they no longer need. */}
                  {type === 'cameras' && " Camera logins, ports and webhook secrets come back with them, so pulled cameras are ready to use."}
                  {type === 'terminals' && ' The connection timeout is local-only and returns to its default on any terminal the cloud re-creates.'}
                </p>
              )}
              <p className="text-[11px] font-semibold uppercase tracking-wide text-red-600">This cannot be undone.</p>
            </div>
            <footer className="px-5 py-3 border-t border-gray-200 flex items-center justify-end gap-2">
              <button onClick={() => setDialog(null)} disabled={syncing}
                className="h-9 px-3 text-xs font-bold uppercase tracking-wide text-gray-600 hover:text-gray-900 disabled:opacity-50">
                Cancel
              </button>
              <button onClick={() => runSync()} disabled={syncing}
                className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50">
                {syncing ? <Loader2 size={13} className="animate-spin" /> : null}
                {syncing ? 'Syncing…' : dialog.direction === 'push' ? 'Push & mirror' : 'Pull & replace'}
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}
