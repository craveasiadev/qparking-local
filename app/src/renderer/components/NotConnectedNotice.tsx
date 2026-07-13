import { CloudOff } from 'lucide-react';

/**
 * Global "this local server isn't linked to an operator's site yet" banner.
 * Rendered on every page except Settings (see App) so it's unmistakable that
 * the app is standalone until the qparking connection is filled in. Kept
 * deliberately plain — it's a status notice, not a call-to-action button.
 */
export function NotConnectedNotice() {
  return (
    <section className="rounded-xl border border-amber-200 bg-amber-50/40 p-4">
      <div className="flex items-start gap-3">
        <CloudOff size={20} className="text-amber-600 mt-0.5 shrink-0" />
        <div>
          <div className="text-sm font-bold text-amber-900">Not connected to an operator's site</div>
          <div className="mt-0.5 text-[11px] text-gray-600">
            This local server hasn't been linked to a qparking site yet. Open <strong>Settings → qparking SaaS sync</strong>,
            fill in the base URL and API key, then run a sync. Cloud-sync status will appear here once the link is live.
          </div>
        </div>
      </div>
    </section>
  );
}
