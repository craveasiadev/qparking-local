/**
 * Sites — read-only display of the site profile mirrored from
 * qparking SaaS (GET /local-server/site → sites table → this page).
 *
 * This is a display-only page: no inputs, no Save button. Everything here
 * is owned by the cloud admin panel; qparking-local just shows what synced.
 *
 * Data comes from window.bridge.getCurrentSite() (the cached `sites` row).
 * While that first read is in flight a skeleton is shown; if nothing has
 * synced yet, an empty state explains why.
 */
import {
  MapPin, Phone, Printer, Mail, Globe2, User,
  Car, Layers, Clock, Image as ImageIcon,
  RefreshCw, Loader2,
} from 'lucide-react';
import type { Site } from '@shared/types';
import { useEffect, useState } from 'react';
import { InfoTip } from '../components/InfoTip';
import { useReloadOnCloudSync } from '../hooks/useReloadOnCloudSync';

const STATUS_STYLE: Record<Site['status'], { dot: string; text: string; label: string }> = {
  active: { dot: 'bg-emerald-500', text: 'text-emerald-700', label: 'Active' },
  maintenance: { dot: 'bg-amber-500', text: 'text-amber-700', label: 'Maintenance' },
  offline: { dot: 'bg-gray-400', text: 'text-gray-600', label: 'Offline' },
};

export function Sites() {
  const [currentSite, setCurrentSite] = useState<Site | null>(null);
  // Live occupancy comes from OUR open sessions, not the synced
  // `occupiedSpaces` counter — see the "Live numbers" section below.
  const [openCount, setOpenCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    try {
      const [site, open] = await Promise.all([
        window.bridge.getCurrentSite(),
        window.bridge.listOpenSessions().catch(() => []),
      ]);
      setCurrentSite(site);
      setOpenCount(open.length);
    } catch (e) {
      console.error('[Sites] failed to load site', e);
    }
  }

  // Load the synced site once on mount, then re-read whenever a pull refreshes
  // the site row (header "Sync now", boot, rebind) — no polling either way.
  useEffect(() => { void load().finally(() => setLoading(false)); }, []);
  useReloadOnCloudSync(['site'], load);

  // Manual re-read of the cached site row (the background sync keeps it fresh;
  // this just pulls the latest into view without waiting for the next tick).
  async function refresh() {
    setRefreshing(true);
    try { await load(); } finally { setRefreshing(false); }
  }

  // First read still in flight → show the skeleton in place of the content.
  if (loading) {
    return (
      <div className="p-5 sm:p-8 max-w-7xl mx-auto animate-pulse">
        {/* Title + subtitle */}
        <div className="h-7 w-40 rounded bg-gray-200" />
        <div className="mt-2 h-4 w-96 max-w-full rounded bg-gray-100" />

        {/* Identity card */}
        <div className="mt-5 rounded-xl border border-gray-200 bg-white p-5">
          <div className="flex items-start gap-4">
            <div className="w-16 h-16 rounded-xl bg-gray-200 flex-shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="h-5 w-48 rounded bg-gray-200" />
              <div className="h-4 w-64 max-w-full rounded bg-gray-100" />
            </div>
          </div>
        </div>

        {/* Four stat tiles */}
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-gray-200 bg-white p-3.5 space-y-2">
              <div className="h-3 w-20 rounded bg-gray-100" />
              <div className="h-5 w-16 rounded bg-gray-200" />
            </div>
          ))}
        </div>

        {/* Two info cards (contact + receipt) */}
        {Array.from({ length: 2 }).map((_, card) => (
          <div key={card} className="mt-4 rounded-xl border border-gray-200 bg-white p-5 space-y-3">
            <div className="h-3 w-28 rounded bg-gray-100" />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="space-y-1.5">
                  <div className="h-3 w-24 rounded bg-gray-100" />
                  <div className="h-4 w-32 rounded bg-gray-200" />
                </div>
              ))}
            </div>
          </div>
        ))}

        {/* Policy-override tiles */}
        <div className="mt-4 rounded-xl border border-gray-200 bg-white p-5 space-y-3">
          <div className="h-3 w-36 rounded bg-gray-100" />
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-1.5">
                <div className="h-3 w-16 rounded bg-gray-200" />
                <div className="h-4 w-12 rounded bg-gray-200" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }


  // Read finished but nothing synced yet (e.g. fresh install before first sync).
  if (!currentSite) {
    return (
      <div className="p-5 sm:p-8 max-w-7xl mx-auto">
        <h1 className="text-2xl font-bold tracking-tight">Sites</h1>
        <div className="mt-5 rounded-xl border border-dashed border-gray-300 bg-white p-10 text-center">
          <MapPin size={28} className="mx-auto text-gray-300" />
          <p className="mt-3 text-sm font-semibold text-gray-700">No site synced yet</p>
          <p className="mt-1 text-[13px] text-gray-500">The site profile appears here once the first sync from qparking SaaS completes. Check the API key in Settings if this persists.</p>
          <button onClick={() => refresh()} disabled={refreshing}
            className="mt-4 inline-flex items-center gap-1.5 h-9 px-4 rounded-lg border border-gray-200 hover:border-gray-900 text-xs font-bold uppercase tracking-wide text-gray-700 disabled:opacity-50">
            {refreshing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} {refreshing ? 'Checking…' : 'Check again'}
          </button>
        </div>
      </div>
    );
  }

  const status = STATUS_STYLE[currentSite.status];
  const occupancyPct = currentSite.totalSpaces > 0
    ? Math.min(100, Math.round((openCount / currentSite.totalSpaces) * 100))
    : 0;

  return (
    <div className="p-5 sm:p-8 max-w-7xl mx-auto">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            Sites
            <InfoTip>
              Your site's profile — name, address, contact details and operating
              hours — as registered in the qparking cloud. To change anything
              here, edit the site in the cloud admin panel; this page updates on
              the next sync.
            </InfoTip>
          </h1>
          <p className="text-sm text-gray-500 mt-1">Read-only site profile, mirrored from qparking SaaS. Edit these values in the cloud admin panel.</p>
        </div>
        <button onClick={() => refresh()} disabled={refreshing}
          className="inline-flex items-center justify-center gap-1.5 h-10 px-4 rounded-lg border border-gray-200 hover:border-gray-900 text-xs font-bold uppercase tracking-wide text-gray-700 disabled:opacity-50">
          {refreshing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {/* ─── Identity ──────────────────────────────────────────────────── */}
      <section className="mt-5 rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex items-start gap-4">
          <div className="w-16 h-16 rounded-xl bg-gray-100 border border-gray-200 flex items-center justify-center flex-shrink-0 overflow-hidden">
            {currentSite.logoUrl ? (
              <img src={currentSite.logoUrl} alt={currentSite.name} className="w-full h-full object-cover" />
            ) : (
              <ImageIcon size={22} className="text-gray-300" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-bold truncate">{currentSite.name}</h2>
              <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wide bg-gray-50 border border-gray-200 ${status.text}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} /> {status.label}
              </span>
              {currentSite.parkingSiteType && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-gray-100 text-gray-600">
                  {currentSite.parkingSiteType}
                </span>
              )}
            </div>
            {currentSite.address && (
              <p className="mt-1 text-sm text-gray-500 flex items-start gap-1.5">
                <MapPin size={14} className="flex-shrink-0 mt-0.5" /> {currentSite.address}
              </p>
            )}
          </div>
        </div>
      </section>

      {/* ─── Live numbers ──────────────────────────────────────────────────
          Capacity and identity are the cloud's to own, but the live figures
          are ours. There used to be revenue and alarm tiles here, fed by cloud
          columns nothing ever wrote — a permanent RM 0.00 / 0. The tiles went
          first, and the cloud has since stopped sending the fields at all.
          Occupancy is counted from our own open sessions instead of the
          drifting `occupiedSpaces` counter. */}
      <section className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-3">
        <StatTile icon={Car} label="Total spaces" value={currentSite.totalSpaces.toLocaleString()} />
        <StatTile icon={Layers} label="Occupied now" value={`${openCount.toLocaleString()} (${occupancyPct}%)`} />
        <StatTile icon={Clock} label="Status" value={STATUS_STYLE[currentSite.status].label} />
      </section>

      {/* ─── Occupancy bar ─────────────────────────────────────────────── */}
      {currentSite.totalSpaces > 0 && (
        <section className="mt-3 rounded-xl border border-gray-200 bg-white p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="font-semibold flex items-center gap-2"><Layers size={15} className="text-gray-400" /> Occupancy</span>
            <span className="tabular-nums text-gray-600"><strong>{openCount.toLocaleString()}</strong> / {currentSite.totalSpaces.toLocaleString()} spaces · {occupancyPct}%</span>
          </div>
          <div className="mt-2.5 h-2.5 w-full rounded-full bg-gray-100 overflow-hidden">
            <div className={`h-full rounded-full transition-all ${occupancyPct >= 90 ? 'bg-red-500' : occupancyPct >= 70 ? 'bg-amber-500' : 'bg-emerald-500'}`}
              style={{ width: `${Math.min(100, occupancyPct)}%` }} />
          </div>
        </section>
      )}

      {/* ─── Contact ───────────────────────────────────────────────────── */}
      <section className="mt-4 rounded-xl border border-gray-200 bg-white p-5 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-widest text-gray-500">Contact</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <InfoRow icon={User} label="Contact person" value={currentSite.contactPerson} />
          <InfoRow icon={Globe2} label="Country" value={currentSite.country} />
          <InfoRow icon={Phone} label="Telephone" value={currentSite.telephone} />
          <InfoRow icon={Printer} label="Fax" value={currentSite.fax} />
          <InfoRow icon={Mail} label="Email" value={currentSite.email} />
        </div>
      </section>

      <p className="mt-4 text-[11px] text-gray-400 flex items-center gap-1.5">
        <Clock size={12} /> Synced automatically from qparking SaaS every 60 seconds.
      </p>
    </div>
  );
}

/** Small labelled stat card for the top occupancy/revenue/alarm row. */
function StatTile({ icon: Icon, label, value, tone = 'default' }: {
  icon: any; label: string; value: string; tone?: 'default' | 'warn';
}) {
  return (
    <div className={`rounded-xl border p-3.5 ${tone === 'warn' && value !== '0' ? 'border-amber-200 bg-amber-50' : 'border-gray-200 bg-white'}`}>
      <div className={`flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide ${tone === 'warn' && value !== '0' ? 'text-amber-700' : 'text-gray-500'}`}>
        <Icon size={13} /> {label}
      </div>
      <div className={`mt-1 text-lg font-bold ${tone === 'warn' && value !== '0' ? 'text-amber-800' : 'text-gray-900'}`}>{value}</div>
    </div>
  );
}

/** Labelled read-only value row — the display-only counterpart to Settings' <Field>. */
function InfoRow({ icon: Icon, label, value }: { icon?: any; label: string; value: string | null }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 flex items-center gap-1.5">
        {Icon && <Icon size={12} className="text-gray-400" />} {label}
      </div>
      <div className="mt-0.5 text-sm text-gray-900">{value || <span className="text-gray-400">—</span>}</div>
    </div>
  );
}

