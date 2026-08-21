/**
 * Settings page — server-wide configuration for this local install.
 *
 * Every value shown here lives in the SQLite `settings` table. Reads and
 * writes go through the typed bridge (window.bridge → preload → ipcMain →
 * services/db.ts), and most changes take effect immediately after Save —
 * no app restart needed.
 *
 * Sections, top to bottom:
 *   1. qparking SaaS sync  — cloud base URL + API key, manual "Sync now"
 *   2. Local servers       — exit grace period (the LPR webhook port moved onto
 *                            each camera on 2026-08-11 — see the Cameras page)
 *   3. App updates         — check / download / install a newer build
 *   4. Maintenance         — clear Electron browser cache
 *
 * Payment devices (Alarmtech W4G) are configured on the Payment terminals page,
 * not here.
 */
import { useEffect, useState } from 'react';
import { Save, Check, AlertCircle, Zap, Loader2, Trash2, Download, Package, RefreshCw, Cloud, Server, Wrench } from 'lucide-react';
import type { AppSettings, EquipmentPushItem } from '@shared/types';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { useConfirm } from '../hooks/useConfirm';
import { fmtTimeSeconds, fmtDate } from '../lib/datetime';
import { toast } from '../toast';
import { useCurrentSite } from '../context/SiteContext';
import { InfoTip } from '../components/InfoTip';

// ─── Types local to this page ────────────────────────────────────────────────

/** Outcome of pulling one cloud model (mirrors SyncResult in qparking-sync). */
interface CloudSyncResult { ok: boolean; fetched: number; error?: string }

/** Per-model outcome of a full cloud pull + equipment push, as returned by
 *  syncAllNow(). Pull models (site…spaces) come DOWN; equipment goes UP. */
interface CloudSyncReport {
  site: CloudSyncResult;
  policies: CloudSyncResult;
  passes: CloudSyncResult;
  blockedPlates: CloudSyncResult;
  customers: CloudSyncResult;
  vehicles: CloudSyncResult;
  spaces: CloudSyncResult;
  activity?: CloudSyncResult;
  sessions?: CloudSyncResult;
  companySetting?: CloudSyncResult;
  equipment?: {
    lanes: EquipmentPushItem[];
    terminals: EquipmentPushItem[];
    cameras: EquipmentPushItem[];
  };
}

/**
 * Display names for the sync-report rows — the SIDEBAR page name for each model,
 * so the operator can map a row straight to the page it filled (raw object keys
 * like "blockedPlates" read as developer debug output).
 *
 * Two labels are not verbatim from the sidebar, both for the same reason: the
 * Passes page merged into Vehicles (2026-08-11), and blocked plates never had a
 * page of their own. Both land on Vehicles.
 */
const PULL_MODEL_LABELS: Record<string, string> = {
  site: 'Sites',
  policies: 'Parking Rates',
  passes: 'Passes (shown on Vehicles)',
  blockedPlates: 'Blocked plates (shown on Vehicles)',
  customers: 'Customers',
  vehicles: 'Vehicles',
  spaces: 'Bays',
  activity: 'Activity Logs',
  sessions: 'Sessions',
  companySetting: 'Company Settings',
};

const PUSH_GROUP_LABELS: Record<string, string> = {
  lanes: 'Lanes',
  terminals: 'Payment terminals',
  cameras: 'LPR cameras',
};

/** A downloadable build artifact offered by the update endpoint. */
// `sha256` was missing from this mirror of app-update.ts's BuildVariantMeta,
// which is a large part of why the digest went unused for so long: the cloud sent
// it, downloadUpdate computed its own, and the UI type could not even see the
// field to compare them.
interface UpdateArtifact { filename: string; size: number | null; sha256: string | null; url: string }

/** Result of the last "Check for updates" call, stamped with checkedAt. */
interface UpdateCheckReport {
  checkedAt?: string;
  currentVersion?: string;
  latestVersion?: string;
  isNewer?: boolean;
  releasedAt?: string | null;
  notes?: string | null;
  portable?: UpdateArtifact | null;
  installer?: UpdateArtifact | null;
  error?: string;
}

export function Settings() {
  // ─── Settings form ─────────────────────────────────────────────────────────
  // `settings` is the whole AppSettings row, edited in place by the inputs
  // below and persisted as one unit by the Save button.
  const [settings, setSettings] = useState<AppSettings | null>(null);
  // JSON snapshot of the last-persisted settings — compared against the live
  // form to drive the "unsaved changes" indicator on the sticky save bar.
  const [savedSnapshot, setSavedSnapshot] = useState<string>('');
  const [justSaved, setJustSaved] = useState<boolean>(false);
  const [syncError , setSyncError] = useState<string | null>(null);

  const site = useCurrentSite();

  useEffect(() => { window.bridge.getSettings().then((s) => { setSettings(s); setSavedSnapshot(JSON.stringify(s)); }); }, []);

  // Persist the current form AND refresh the saved snapshot so the unsaved
  // indicator clears. Shared by the main Save button and the inline test
  // buttons (which save the config before probing a device).
  async function persistSettings(): Promise<AppSettings | null> {
    if (!settings) return null;
    const saved = await window.bridge.saveSettings(settings);
    await window.bridge.insertActivityLog({
      eventKey: 'config.settings.saved',
      action: 'edit',
      category: 'config',
      severity: 'high',
      siteId: site?.id ?? null,
      outcome: 'ok',
      resourceType: 'app_settings',
      resourceId: null,
      description: `Server settings updated · ${saved.qparkingBaseUrl || 'no cloud URL'}`
    });
    setSettings(saved);
    setSavedSnapshot(JSON.stringify(saved));
    return saved;
  }

  // Re-provision flow: when the qparking base URL / API key changes to a key
  // that belongs to a DIFFERENT site, saving must not silently re-point the box
  // (that would leak this site's equipment to the other site and leave the old
  // site's sessions/logs showing). Instead we preview the candidate site and,
  // if it differs, prompt the operator to confirm a reset.
  const [rebindPrompt, setRebindPrompt] = useState<{ boundName: string; candidateName: string; openSessions: number } | null>(null);
  const [wipeEquipment, setWipeEquipment] = useState(false);

  // Persist the on-screen settings, guarding the credential change: if the new
  // API key/URL resolves to a DIFFERENT site, hold the write and raise the
  // re-provision prompt instead of silently re-pointing the box. Returns:
  //   'saved'  — settings are now persisted and safe to use
  //   'rebind' — a site-switch confirmation is now pending (nothing saved yet)
  //   'error'  — verification failed (syncError is set)
  // Shared by Save and by "Sync now" so both act on what's in the fields.
  async function ensureSaved(): Promise<'saved' | 'rebind' | 'error'> {
    if (!settings) return 'error';
    const prev = JSON.parse(savedSnapshot) as AppSettings;
    const credsChanged =
      settings.qparkingApiKey !== prev.qparkingApiKey || settings.qparkingBaseUrl !== prev.qparkingBaseUrl;
    if (credsChanged && settings.qparkingApiKey && settings.qparkingBaseUrl) {
      const preview = await window.bridge.previewSiteRebind({
        baseUrl: settings.qparkingBaseUrl,
        apiKey: settings.qparkingApiKey,
      });
      if (!preview.ok) { setSyncError(preview.error ?? 'Could not verify the site for this API key'); return 'error'; }
      if (preview.changed) {
        // Different site — hold the save and require explicit confirmation.
        setWipeEquipment(false);
        setRebindPrompt({
          boundName: preview.boundSite?.name ?? '—',
          candidateName: preview.candidateSite?.name ?? '—',
          openSessions: preview.openSessions ?? 0,
        });
        return 'rebind';
      }
    }
    await persistSettings();
    return 'saved';
  }

  const [saveSettings, savingSettings] = useAsyncAction(async () => {
    setSyncError(null);
    if (await ensureSaved() === 'saved') {
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2000);
    }
  });

  const [confirmRebind, rebinding] = useAsyncAction(
    async () => {
      if (!settings) return;
      setSyncError(null);
      const report = await window.bridge.rebindSite({
        baseUrl: settings.qparkingBaseUrl,
        apiKey: settings.qparkingApiKey,
        wipeEquipment,
      });
      setRebindPrompt(null);
      // Refresh the form + snapshot (the box is now bound to the new site) and
      // show the pull/push report so the operator sees what landed.
      const fresh = await window.bridge.getSettings();
      setSettings(fresh);
      setSavedSnapshot(JSON.stringify(fresh));
      setCloudSyncReport(report as unknown as CloudSyncReport);
    },
    { onError: (error) => setSyncError(String((error as any)?.message ?? error)) },
  );

  // Cancelling a switch reverts just the credential fields to their last-saved
  // values so the box stays bound to its current site.
  function cancelRebind() {
    const prev = JSON.parse(savedSnapshot) as AppSettings;
    setSettings((current) => current ? { ...current, qparkingApiKey: prev.qparkingApiKey, qparkingBaseUrl: prev.qparkingBaseUrl } : current);
    setRebindPrompt(null);
  }

  const dirty = !!settings && JSON.stringify(settings) !== savedSnapshot;

  // ─── qparking cloud sync ───────────────────────────────────────────────────
  // "Sync now" persists the URL/key currently on screen, then pulls every
  // cloud-owned model (site, policies, passes, spaces) and shows the per-model
  // outcome — so a just-edited key takes effect without a separate Save.
  const [cloudSyncReport, setCloudSyncReport] = useState<CloudSyncReport | null>(null);

  const [runCloudSyncNow, cloudSyncing] = useAsyncAction(
    async () => {
      setSyncError(null);
      if (!settings) return;
      if (!settings.qparkingApiKey) { setSyncError('Set an API key before syncing'); return; }
      // Sync against what's in the fields: persist first, then pull. If the
      // edited key belongs to a DIFFERENT site, ensureSaved() raises the
      // re-provision prompt (which does its own pull) instead of syncing the
      // old site's data against the new key — so we stop here in that case.
      if (await ensureSaved() !== 'saved') return;
      setCloudSyncReport(await window.bridge.syncAllNow());
    },
    { onError: (error) => setSyncError(String((error as any)?.message ?? error)) },
  );

  // ─── App self-update ───────────────────────────────────────────────────────
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckReport | null>(null);
  const [downloadProgressPct, setDownloadProgressPct] = useState<number | null>(null);
  const [downloadedUpdatePath, setDownloadedUpdatePath] = useState<string | null>(null);
  // The digest the cloud published for the build we downloaded, kept so apply
  // can re-check the file that is actually on disk — and a flag for the case the
  // cloud published nothing, which must be said out loud rather than assumed OK.
  const [downloadedUpdateSha, setDownloadedUpdateSha] = useState<string | null>(null);
  const [downloadedUpdateVerified, setDownloadedUpdateVerified] = useState(true);

  // Subscribe to streaming download-progress events from the main process.
  useEffect(() => {
    const unsubscribe = window.bridge.onEvent('app-update-progress', (progress: any) => {
      if (typeof progress?.pct === 'number') setDownloadProgressPct(progress.pct);
    });
    return () => { try { unsubscribe(); } catch { /* ignore */ } };
  }, []);

  const [runUpdateCheck, checkingForUpdate] = useAsyncAction(async () => {
    setDownloadProgressPct(null);
    setDownloadedUpdatePath(null);
    const report = await window.bridge.appUpdateCheck();
    setUpdateCheck({ ...report, checkedAt: new Date().toISOString() });
  });

  const [runUpdateDownload, downloadingUpdate] = useAsyncAction(async (variant: 'portable' | 'installer') => {
    setDownloadProgressPct(0);
    // The check step already handed us the digest the cloud published for this
    // variant, so it rides along and the download is verified against it rather
    // than trusted on arrival.
    const expectedSha256 = (variant === 'portable' ? updateCheck?.portable : updateCheck?.installer)?.sha256 ?? null;
    const result = await window.bridge.appUpdateDownload({ variant, expectedSha256 });
    if (result.ok && result.path) {
      setDownloadedUpdatePath(result.path);
      setDownloadedUpdateSha(expectedSha256);
      setDownloadedUpdateVerified(result.verified !== false);
    } else {
      setDownloadedUpdatePath(null);
      setUpdateCheck((prev) => ({ ...(prev ?? {}), error: result.error ?? 'download_failed' }));
    }
  });

  const [confirm, confirmDialog] = useConfirm();
  const [runUpdateInstall, installingUpdate] = useAsyncAction(async () => {
    if (!downloadedUpdatePath) return;
    const integrityNote = downloadedUpdateVerified
      ? ''
      : '\n\nWARNING: the cloud published no checksum for this build, so its integrity could not be verified.';
    if (!(await confirm({ title: 'Install update', message: `Install the update now?\n\nThis closes the app. For the installer variant, the NSIS wizard opens — accept its prompts. For the portable, the new exe launches in place.${integrityNote}`, confirmLabel: 'Install' }))) return;
    // Re-checked at apply time against the same digest: "verified on download"
    // says nothing about the file still sitting on disk now.
    const applied = await window.bridge.appUpdateApply({ path: downloadedUpdatePath, expectedSha256: downloadedUpdateSha });
    if (!applied.ok) {
      toast({ tone: 'error', title: 'Update not installed', detail: applied.error ?? 'apply_failed' });
    }
  });

  // ─── Maintenance ───────────────────────────────────────────────────────────
  // Backfill: one-shot re-queue of every local session for cloud sync. Moved
  // here from the Dashboard so a live operator can't fire a mass re-queue by
  // accident — it belongs with the other maintenance actions.
  const [runBackfill, backfilling] = useAsyncAction(async () => {
    const r = await window.bridge.backfillSessions();
    toast({ tone: 'success', title: `Queued ${r.entries} entry + ${r.exits} exit record(s) for sync`, detail: 'Watch the Dashboard cloud-sync panel for progress.' });
  });

  const [runClearCache, clearingCache] = useAsyncAction(async () => {
    if (!(await confirm({ title: 'Clear cache & reload', message: 'Clear browser cache and reload?\n\nThis wipes Electron-side cached responses, localStorage, IndexedDB, and cookies, then reloads the window. Your parking data (sessions, terminals, settings) is NOT affected.', confirmLabel: 'Clear & reload' }))) return;
    const result = await window.bridge.clearAppCache();
    // The reload happens main-process-side before this resolves, but show
    // feedback just in case the renderer is still alive momentarily.
    console.log(`[settings] cache cleared in ${result.elapsedMs}ms`);
  });

  if (!settings) return <div className="p-10 text-center text-gray-500 text-sm">Loading…</div>;

  return (
    <div className="p-5 sm:p-8 max-w-7xl mx-auto">
      {confirmDialog}
      {rebindPrompt && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4" onClick={cancelRebind}>
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden">
            <div className="p-5 space-y-3">
              <h2 className="text-base font-bold">Switch this box to a different site?</h2>
              <p className="text-sm text-gray-600">
                This API key belongs to <strong>{rebindPrompt.candidateName}</strong>, not <strong>{rebindPrompt.boundName}</strong>.
                Switching disconnects this box from {rebindPrompt.boundName} and <strong>permanently clears its local data</strong> —
                sessions, transactions, activity logs and the pending cloud-sync queue — so nothing from the old site lingers.
              </p>
              {rebindPrompt.openSessions > 0 ? (
                <p className="text-sm rounded-lg bg-amber-50 border border-amber-300 text-amber-800 px-3 py-2">
                  <strong>{rebindPrompt.openSessions} car{rebindPrompt.openSessions > 1 ? 's are' : ' is'} still on site.</strong>{' '}
                  Switching now wipes {rebindPrompt.openSessions > 1 ? 'their stays' : 'its stay'} — {rebindPrompt.openSessions > 1 ? 'those cars' : 'that car'} will have no
                  record at exit and must be let out with Open Barrier. Clear the site first if you can.
                </p>
              ) : null}
              <label className="flex items-start gap-2 text-sm text-gray-700">
                <input type="checkbox" className="mt-0.5" checked={wipeEquipment} onChange={(e) => setWipeEquipment(e.target.checked)} />
                <span>Also remove configured cameras, lanes, payment terminals and LCD displays (leave unchecked if the same hardware serves the new site).</span>
              </label>
            </div>
            <footer className="px-5 py-3 border-t border-gray-200 flex items-center justify-end gap-2">
              <button onClick={cancelRebind} disabled={rebinding}
                className="h-9 px-3 text-xs font-bold uppercase tracking-wide text-gray-600 hover:text-gray-900 disabled:opacity-50">
                Cancel
              </button>
              <button onClick={() => confirmRebind()} disabled={rebinding}
                className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50">
                {rebinding ? <Loader2 size={13} className="animate-spin" /> : null}
                {rebinding ? 'Switching…' : 'Switch & reset'}
              </button>
            </footer>
          </div>
        </div>
      )}
      <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
        Settings
        <InfoTip title="About this page" kind="info">
          Settings for this server only — the cloud connection, local ports and
          app updates. Most changes apply as soon as you save. Be careful with
          the qparking URL and API key: they link this server to your site in
          the cloud, and changing them to a different site clears the local
          data and starts fresh.
        </InfoTip>
      </h1>
      <p className="text-sm text-gray-500 mt-1">Server-wide configuration. Restart not required — most changes take effect immediately.</p>

      <section className="mt-5 rounded-xl border border-gray-200 bg-white p-5 space-y-4">
        <SectionHeader icon={Cloud} title="qparking SaaS sync">
          <button
            type="button"
            onClick={() => runCloudSyncNow()}
            disabled={cloudSyncing}
            className="inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50"
          >
            {cloudSyncing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            {cloudSyncing ? 'Syncing…' : 'Sync now'}
          </button>
        </SectionHeader>
        <Field label="qparking base URL">
          <input className="input" value={settings.qparkingBaseUrl} onChange={(e) => setSettings({ ...settings, qparkingBaseUrl: e.target.value })} placeholder="https://parking.qbot.now" />
        </Field>
        <Field label="API key">
          <input type="password" className="input font-mono text-xs" value={settings.qparkingApiKey} onChange={(e) => setSettings({ ...settings, qparkingApiKey: e.target.value })} placeholder="issued by qparking admin" />
        </Field>
        {syncError && (
          <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 text-[11px] px-3 py-2">
            {syncError}
          </div>
        )}
        {cloudSyncReport && (
          <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-[11px] font-mono space-y-1.5">
            <div className="space-y-0.5">
              <div className="text-gray-400 uppercase tracking-wide text-[10px] not-italic">Pulled from cloud ↓</div>
              {(['site', 'policies', 'passes', 'blockedPlates', 'customers', 'vehicles', 'spaces', 'activity', 'sessions', 'companySetting'] as const).map((model) => {
                const result = cloudSyncReport[model];
                if (!result) return null;
                // Sessions is an IMPORT (restore of cars still inside), not a
                // mirror replace — word it so "0" reads as healthy, not broken.
                const okText = model === 'sessions'
                  ? `${result.fetched} open session${result.fetched === 1 ? '' : 's'} restored`
                  : `${result.fetched} pulled`;
                return (
                  <div key={model} className={result.ok ? 'text-emerald-700' : 'text-red-700'}>
                    {result.ok ? '✓' : '✗'} {PULL_MODEL_LABELS[model] ?? model} — {result.ok ? okText : result.error}
                  </div>
                );
              })}
            </div>
            {cloudSyncReport.equipment && (
              <div className="space-y-0.5 border-t border-gray-200 pt-1.5">
                <div className="text-gray-400 uppercase tracking-wide text-[10px]">Pushed to cloud ↑</div>
                {([
                  ['lanes', cloudSyncReport.equipment.lanes],
                  ['terminals', cloudSyncReport.equipment.terminals],
                  ['cameras', cloudSyncReport.equipment.cameras],
                ] as const).map(([group, items]) => {
                  const sent = items.filter((i) => i.ok).length;
                  const skipped = items.filter((i) => !i.ok && i.skipped);
                  const failed = items.filter((i) => !i.ok && !i.skipped);
                  return (
                    <div key={group}>
                      <div className={failed.length ? 'text-red-700' : skipped.length ? 'text-amber-700' : 'text-emerald-700'}>
                        {failed.length ? '✗' : skipped.length ? '⚠' : '✓'} {PUSH_GROUP_LABELS[group] ?? group} — {sent}/{items.length} sent
                        {skipped.length ? `, ${skipped.length} skipped` : ''}
                        {failed.length ? `, ${failed.length} failed` : ''}
                      </div>
                      {[...skipped, ...failed].map((item) => (
                        <div key={item.id} className={`pl-3 ${item.skipped ? 'text-amber-600' : 'text-red-600'}`}>
                          • {item.name}: {item.error}
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
        <div className="text-[11px] text-gray-500 flex items-start gap-1.5">
          <AlertCircle size={13} className="flex-shrink-0 mt-0.5" />
          <p>Site, policies, passes and spaces are pulled from <code className="font-mono">{`{base}/api/v1/local-server/…`}</code> and re-pulled every 60 seconds. <strong>Sync now</strong> additionally restores open sessions (cars the cloud says are still inside) — recovery for a reset or rebound box; stays this box already knows are left untouched. Equipment (cameras, lanes, terminals) syncs manually from each device page's <strong>Push / Pull to cloud</strong> buttons — not here.</p>
        </div>
      </section>

      <section className="mt-4 rounded-xl border border-gray-200 bg-white p-5 space-y-4">
        <SectionHeader icon={Server} title="Local servers" />
        {/* The LPR webhook port used to live here, as ONE box-wide value. It is
            now a field on each camera (2026-08-11): firmware varies in what it
            will let you set, so a site can end up with cameras pushing to
            different ports, and the box binds a listener for each. */}
        {/* Was stored but had no control anywhere, so in practice it could only be
            changed by editing the SQLite file — exposed 2026-08-07. */}
        <Field label="Exit grace period (seconds)">
          <input
            type="number"
            min={0}
            max={3600}
            step={5}
            className="input"
            value={settings.exitGracePeriodSeconds}
            onChange={(e) => setSettings({ ...settings, exitGracePeriodSeconds: Math.min(3600, Math.max(0, Number(e.target.value) || 0)) })}
          />
          <p className="text-[11px] text-gray-500 mt-1">
            After a car exits, ignore fresh <strong>entry</strong> reads of the same plate for this long.
            ANPR cameras report a plate two or three times per pass, so without this the departing car
            is re-read as a new arrival — a phantom "inside" record that then blocks its real next visit
            with ALREADY INSIDE and inflates occupancy. Default <strong>60</strong>; set{' '}
            <strong>0</strong> to disable. Lower it only where a genuine return within the window is
            plausible (a drop-off loop). Nothing to do with payment — a car that hasn't paid is never
            auto-released.
          </p>
        </Field>
        {/* "One camera covers entry and exit" lived here briefly and was removed
            2026-08-05 along with the camera direction 'dual' — same rule, same
            configuration, and it never worked properly (a departing car is only in
            frame after it has passed the barrier). A shared barrier now takes two
            cameras, one facing each way. Camera direction is the only thing that
            decides routing. */}
      </section>

      <section className="mt-4 rounded-xl border border-gray-200 bg-white p-5 space-y-4">
        <SectionHeader icon={Package} title="App updates" />
        <p className="text-[11px] text-gray-500">
          Checks the qparking cloud (<code className="font-mono">{`{base}/api/v1/local-server/latest-built`}</code>) for a newer published build of this app. The download is bearer-token authed via the qparking API key in the section above — make sure that's saved before checking.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => runUpdateCheck()}
            disabled={checkingForUpdate || downloadingUpdate || installingUpdate}
            className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg border border-gray-200 hover:border-gray-900 text-xs font-bold uppercase tracking-wide text-gray-700 disabled:opacity-50"
          >
            {checkingForUpdate ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            {checkingForUpdate ? 'Checking…' : 'Check for updates'}
          </button>
          {updateCheck?.checkedAt && (
            <span className="text-[11px] text-gray-500">
              Last checked {fmtTimeSeconds(updateCheck.checkedAt)}
            </span>
          )}
        </div>

        {updateCheck?.error && (
          <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 text-xs px-3 py-2">
            <strong>Error:</strong> {updateCheck.error}
          </div>
        )}

        {updateCheck?.currentVersion && updateCheck.latestVersion && (
          <div className={`rounded-lg border px-3 py-2.5 text-xs space-y-1 ${
            updateCheck.isNewer ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50'
          }`}>
            <div className="flex items-center justify-between gap-2">
              <div className="inline-flex items-center gap-1.5">
                <Package size={13} className={updateCheck.isNewer ? 'text-amber-700' : 'text-emerald-700'} />
                <span className="font-bold">
                  {updateCheck.isNewer
                    ? `Update available: ${updateCheck.latestVersion}`
                    : `You're on the latest (${updateCheck.currentVersion})`}
                </span>
              </div>
              <span className="font-mono text-[11px] text-gray-600">
                installed: {updateCheck.currentVersion}
                {updateCheck.releasedAt && updateCheck.isNewer && (
                  <> · released: {fmtDate(updateCheck.releasedAt)}</>
                )}
              </span>
            </div>
            {updateCheck.notes && (
              <p className="text-[11px] text-gray-700 mt-1 whitespace-pre-wrap">{updateCheck.notes}</p>
            )}
          </div>
        )}

        {updateCheck?.isNewer && (updateCheck.portable || updateCheck.installer) && !downloadedUpdatePath && (
          <div className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-600">Choose how to update</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {updateCheck.installer && (
                <button
                  onClick={() => runUpdateDownload('installer')}
                  disabled={downloadingUpdate || installingUpdate}
                  className="flex flex-col items-start gap-1 rounded-lg border border-gray-200 hover:border-gray-900 px-3 py-2.5 text-left disabled:opacity-50"
                >
                  <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide">
                    <Download size={13} /> Installer (.exe)
                  </div>
                  <div className="text-[11px] text-gray-500 font-mono">{updateCheck.installer.filename}</div>
                  <div className="text-[11px] text-gray-400">
                    {updateCheck.installer.size ? `${(updateCheck.installer.size / 1024 / 1024).toFixed(1)} MB` : '—'} · NSIS wizard, in-place upgrade
                  </div>
                </button>
              )}
              {updateCheck.portable && (
                <button
                  onClick={() => runUpdateDownload('portable')}
                  disabled={downloadingUpdate || installingUpdate}
                  className="flex flex-col items-start gap-1 rounded-lg border border-gray-200 hover:border-gray-900 px-3 py-2.5 text-left disabled:opacity-50"
                >
                  <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide">
                    <Download size={13} /> Portable (.exe)
                  </div>
                  <div className="text-[11px] text-gray-500 font-mono">{updateCheck.portable.filename}</div>
                  <div className="text-[11px] text-gray-400">
                    {updateCheck.portable.size ? `${(updateCheck.portable.size / 1024 / 1024).toFixed(1)} MB` : '—'} · single-file, no installer
                  </div>
                </button>
              )}
            </div>
          </div>
        )}

        {downloadProgressPct !== null && !downloadedUpdatePath && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[11px] text-gray-600">
              <span className="inline-flex items-center gap-1.5"><Loader2 size={11} className="animate-spin" /> Downloading…</span>
              <span className="font-mono">{downloadProgressPct}%</span>
            </div>
            <div className="h-2 rounded-full overflow-hidden bg-gray-100">
              <div className="h-full bg-gray-900 transition-all" style={{ width: `${downloadProgressPct}%` }} />
            </div>
          </div>
        )}

        {downloadedUpdatePath && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-xs space-y-2">
            <div className="inline-flex items-center gap-1.5 font-bold text-emerald-800">
              <Check size={13} /> Download complete
            </div>
            <div className="font-mono text-[10px] text-gray-600 break-all">{downloadedUpdatePath}</div>
            <button
              onClick={() => runUpdateInstall()}
              disabled={installingUpdate}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50"
            >
              {installingUpdate ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
              {installingUpdate ? 'Restarting…' : 'Install & restart'}
            </button>
          </div>
        )}
      </section>

      <section className="mt-4 rounded-xl border border-gray-200 bg-white p-5 space-y-5">
        <SectionHeader icon={Wrench} title="Maintenance" />

        <div className="space-y-2">
          <p className="text-[11px] text-gray-500">
            <strong>Backfill all sessions</strong> — one-shot: queue every existing local session for sync to qparking.
            Idempotent (safe to run repeatedly). Use it after first linking a site, or if the cloud is missing older sessions.
          </p>
          <button onClick={() => runBackfill()} disabled={backfilling}
            className="inline-flex items-center gap-2 h-10 px-4 rounded-lg border border-gray-200 bg-white hover:border-gray-900 text-gray-700 text-xs font-bold uppercase tracking-wide disabled:opacity-50">
            {backfilling ? <Loader2 size={13} className="animate-spin" /> : <Cloud size={13} />}
            {backfilling ? 'Queuing…' : 'Backfill all sessions'}
          </button>
        </div>

        <div className="space-y-2 border-t border-gray-100 pt-4">
          <p className="text-[11px] text-gray-500">
            <strong>Clear cache &amp; reload</strong> — wipes Electron-side browser caches (HTTP responses, localStorage,
            IndexedDB, service workers, cookies) and reloads the window.
            Useful after an app update when the UI shows stale data. <strong>Does NOT
            delete parking sessions, terminals, cameras, lanes, policies, or settings</strong> —
            those live in the SQLite database and survive a cache clear.
          </p>
          <button onClick={() => runClearCache()} disabled={clearingCache}
            className="inline-flex items-center gap-2 h-10 px-4 rounded-lg border border-red-200 bg-white hover:bg-red-50 text-red-700 text-xs font-bold uppercase tracking-wide disabled:opacity-50">
            {clearingCache ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
            {clearingCache ? 'Clearing & reloading…' : 'Clear cache & reload'}
          </button>
        </div>
      </section>

      {/* Sticky save bar — stays in view no matter how far down the long form
          the operator has scrolled, and flags whether there are edits to save. */}
      <div className="sticky bottom-4 z-20 mt-6">
        <div className="flex items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white/95 backdrop-blur shadow-lg px-4 py-3">
          <span className="text-xs font-medium inline-flex items-center gap-2">
            {dirty ? (
              <><span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" /> <span className="text-amber-700">Unsaved changes</span></>
            ) : (
              <><span className="w-2 h-2 rounded-full bg-emerald-500" /> <span className="text-gray-500">All changes saved</span></>
            )}
          </span>
          <button onClick={() => saveSettings()} disabled={savingSettings || (!dirty && !justSaved)}
            className="inline-flex items-center gap-2 h-11 px-5 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50">
            {savingSettings ? <Loader2 size={14} className="animate-spin" /> : justSaved ? <Check size={14} /> : <Save size={14} />}
            {savingSettings ? 'Saving…' : justSaved ? 'Saved' : 'Save settings'}
          </button>
        </div>
      </div>

      <style>{`.input { height: 40px; padding: 0 0.75rem; border: 1px solid #d1d5db; border-radius: 0.5rem; outline: none; font-size: 14px; width: 100%; } .input:focus { border-color: #111827; }`}</style>
    </div>
  );
}

/** Section header — icon + uppercase title, with an optional right-side action
 *  (e.g. the qparking "Sync now" button). */
function SectionHeader({ icon: Icon, title, children }: { icon: any; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-sm font-bold uppercase tracking-widest text-gray-500 flex items-center gap-2">
        <Icon size={14} className="text-gray-400" /> {title}
      </h2>
      {children}
    </div>
  );
}

/** Labelled form row — tiny uppercase label above whatever input is passed in. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-semibold uppercase tracking-wide text-gray-600 mb-1">{label}</label>
      {children}
    </div>
  );
}
