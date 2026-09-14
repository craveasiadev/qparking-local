import { RefreshCw, CloudDownload } from 'lucide-react';

/**
 * The header pair on the read-only cloud-mirrored directories (Customers /
 * Vehicles / Visitors): re-read what this PC already has, or go and fetch the
 * cloud's copy again.
 *
 * Distinct from DeviceSyncButtons, which is the two-way push/pull on the device
 * pages — these pages are mirrors, so there is nothing local to push.
 */
export function CloudMirrorButtons({
  onRefresh, refreshing, onSync, syncing,
}: {
  onRefresh: () => void;
  refreshing: boolean;
  onSync: () => void;
  syncing: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <button onClick={onRefresh} disabled={refreshing}
        className="inline-flex items-center justify-center gap-1.5 h-10 px-4 rounded-lg border border-gray-200 hover:border-gray-900 text-xs font-bold uppercase tracking-wide text-gray-700 disabled:opacity-50">
        <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} /> Refresh
      </button>
      <button onClick={onSync} disabled={syncing}
        className="inline-flex items-center justify-center gap-1.5 h-10 px-4 rounded-lg bg-gray-900 text-white hover:bg-gray-700 text-xs font-bold uppercase tracking-wide disabled:opacity-50">
        <CloudDownload size={13} className={syncing ? 'animate-pulse' : ''} /> Sync from cloud
      </button>
    </div>
  );
}
