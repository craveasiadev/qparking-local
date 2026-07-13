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
 *   2. Local servers       — LPR webhook / operator API ports, image store
 *   3. Face-auth turnstile — optional faceapp_main gate trigger + test tools
 *   4. Flow behavior       — single-camera entry/exit mode
 *   5. Touch'n'Go W4G      — multi-acquirer payment box + live test panel
 *   6. Operations          — exit grace period
 *   7. App updates         — check / download / install a newer build
 *   8. Maintenance         — clear Electron browser cache
 */
import { useEffect, useState } from 'react';
import { Save, Check, AlertCircle, Zap, Activity, Loader2, Trash2, CreditCard, XCircle, Wifi, Download, Package, RefreshCw } from 'lucide-react';
import type { AppSettings, EquipmentPushItem } from '@shared/types';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { useConfirm } from '../hooks/useConfirm';

// ─── Types local to this page ────────────────────────────────────────────────

/** One line in the W4G test panel's black console. */
interface TngLogLine {
  at: string;
  kind: 'send' | 'recv' | 'error' | 'info';
  text: string;
  /** Optional structured payload (JSON body, headers, decoded fields). Rendered
   *  as a collapsible <details> block under the text — operators can pop it
   *  open to inspect the raw bytes when something fails. */
  payload?: unknown;
}

/** Live W4G integration state polled from the main process every 2s. */
interface TngStatus {
  enabled: boolean;
  listening: boolean;
  listenPort: number;
  listenPorts: number[];
  listenAddresses: string[];
  host: string;
  port: number;
  pending: { orderId: string; payAmount: number; startedAt: string }[];
  lastResult?: { orderId: string; status: string; payType?: number; at: string };
  lastError?: string;
}

/** Outcome of pulling one cloud model (mirrors SyncResult in qparking-sync). */
interface CloudSyncResult { ok: boolean; fetched: number; error?: string }

/** Per-model outcome of a full cloud pull + equipment push, as returned by
 *  syncAllNow(). Pull models (site…spaces) come DOWN; equipment goes UP. */
interface CloudSyncReport {
  site: CloudSyncResult;
  policies: CloudSyncResult;
  passes: CloudSyncResult;
  spaces: CloudSyncResult;
  equipment?: {
    lanes: EquipmentPushItem[];
    terminals: EquipmentPushItem[];
    cameras: EquipmentPushItem[];
  };
}

/** A downloadable build artifact offered by the update endpoint. */
interface UpdateArtifact { filename: string; size: number | null; url: string }

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

/** W4G payType code → human label, for the test panel's APPROVED line. */
const PAY_TYPE_LABEL: Record<number, string> = {
  0: 'TNG card',
  1: 'Visa',
  2: 'Mastercard',
  3: 'MCCS',
  4: 'TNG e-wallet',
};

export function Settings() {
  // ─── Settings form ─────────────────────────────────────────────────────────
  // `settings` is the whole AppSettings row, edited in place by the inputs
  // below and persisted as one unit by the Save button.
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [justSaved, setJustSaved] = useState<boolean>(false);
  const [syncError , setSyncError] = useState<string | null>(null);

  useEffect(() => { window.bridge.getSettings().then(setSettings); }, []);

  const [saveSettings, savingSettings] = useAsyncAction(async () => {
    if (!settings) return null;
    const savedSetting = await window.bridge.saveSettings(settings);
    setSettings(savedSetting);
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 2000);
  });

  // ─── qparking cloud sync ───────────────────────────────────────────────────
  // "Sync now" saves the URL/key currently on screen, pulls every cloud-owned
  // model (site, policies, passes, spaces) and shows the per-model outcome.
  const [cloudSyncReport, setCloudSyncReport] = useState<CloudSyncReport | null>(null);

  const [runCloudSyncNow, cloudSyncing] = useAsyncAction(
    async () => {
      setSyncError(null);
      if (!settings) return;
      if (!settings.qparkingApiKey) { setSyncError('Set an API key before syncing'); return; }
      setCloudSyncReport(await window.bridge.syncAllNow());
    },
    { onError: (error) => setSyncError(String((error as any)?.message ?? error)) },
  );

  // ─── Face-auth turnstile test ──────────────────────────────────────────────
  const [faceGateTestResult, setFaceGateTestResult] = useState<string | null>(null);

  const [runFaceGatePing, faceGatePingBusy] = useAsyncAction(async () => {
    if (!settings) return;
    setFaceGateTestResult('Saving config…');
    await window.bridge.saveSettings(settings);
    setFaceGateTestResult('Pinging…');
    const result = await window.bridge.pingFaceGate();
    setFaceGateTestResult(result.ok ? `✓ Reachable (status ${result.status})` : `✗ ${result.error ?? `status ${result.status}`}`);
  });

  const [runFaceGateOpen, faceGateOpenBusy] = useAsyncAction(async () => {
    if (!settings) return;
    setFaceGateTestResult('Saving config…');
    await window.bridge.saveSettings(settings);
    setFaceGateTestResult('Opening…');
    const result = await window.bridge.openFaceGate({ plate: 'TEST', reason: 'settings-test' });
    if (result.ok) {
      setFaceGateTestResult('✓ Open command accepted by gateway');
    } else {
      const bodyMessage = (result.body as any)?.message ?? (result.body as any)?.error ?? '';
      const parts = [`status ${result.status ?? '—'}`];
      if (result.error) parts.push(result.error);
      if (bodyMessage) parts.push(bodyMessage);
      setFaceGateTestResult(`✗ ${parts.join(' · ')}`);
    }
  });

  // ─── Touch'n'Go W4G test panel ─────────────────────────────────────────────
  const [tngStatus, setTngStatus] = useState<TngStatus | null>(null);
  const [tngLog, setTngLog] = useState<TngLogLine[]>([]);
  const [tngTestAmountCents, setTngTestAmountCents] = useState<number>(100);
  const [tngLastOrderId, setTngLastOrderId] = useState<string>('');

  // Live status poll — refreshes every 2s so the operator sees pending
  // orders and the last callback as soon as the device responds.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await window.bridge.tngStatus();
        if (!cancelled) setTngStatus(status);
      } catch { /* ignore */ }
    };
    poll();
    const timerId = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(timerId); };
  }, []);

  // Stream W4G activity into the test panel. Comes through the generic 'log'
  // channel; we filter by source==='w4g' so other terminal logs don't leak in.
  useEffect(() => {
    const unsubscribe = window.bridge.onEvent('log', (payload: any) => {
      if (payload?.source !== 'w4g') return;
      setTngLog((prev) => [
        {
          at: new Date().toLocaleTimeString(),
          kind: payload.direction,
          text: payload.message,
          payload: payload.payload,
        },
        ...prev,
      ].slice(0, 100));
    });
    return () => { try { unsubscribe(); } catch { /* ignore */ } };
  }, []);

  /** Prepend a line to the black test console (newest first, capped at 100). */
  const appendTngLog = (kind: TngLogLine['kind'], text: string, payload?: unknown) => {
    setTngLog((prev) => [{ at: new Date().toLocaleTimeString(), kind, text, payload }, ...prev].slice(0, 100));
  };

  const [runTngPing, tngPinging] = useAsyncAction(async () => {
    if (!settings) return;
    await window.bridge.saveSettings(settings);
    appendTngLog('info', `Ping ${settings.tngHost}:${settings.tngPort}…`);
    const result = await window.bridge.tngPing();
    if (result.ok) appendTngLog('recv', `✓ Reachable (${result.latencyMs}ms)`);
    else appendTngLog('error', `✗ ${result.error ?? 'unreachable'}`);
  });

  const [runTngProbe, tngProbing] = useAsyncAction(async () => {
    if (!settings) return;
    await window.bridge.saveSettings(settings);
    appendTngLog('info', `Probe HTTP GET / at ${settings.tngHost}:${settings.tngPort}…`);
    const result = await window.bridge.tngProbeHttp();
    if (result.ok) {
      appendTngLog('recv', `✓ HTTP ${result.status} ${result.statusText ?? ''} · ${result.elapsedMs}ms`, {
        headers: result.headers,
        body_preview: result.bodyPreview,
      });
    } else {
      appendTngLog('error', `✗ Probe failed: ${result.error}`);
    }
  });

  const [runTngLoopback, tngLooping] = useAsyncAction(async () => {
    if (!settings) return;
    if (!settings.tngEnabled) {
      appendTngLog('error', 'Enable TNG and save settings first');
      return;
    }
    await window.bridge.saveSettings(settings);
    appendTngLog('info', `Loopback test — POSTing synthetic PayResult to our own listener…`);
    const result = await window.bridge.tngLoopbackPayResult();
    if (result.ok) {
      appendTngLog('recv', `✓ Loopback succeeded · status=${result.status} · ${result.elapsedMs}ms — listener is healthy and parsing correctly. If real device callbacks still aren't landing, the issue is purely device-side (PayResult URL or firewall).`, { sent: result.sentBody, response: result.responseBody });
    } else {
      appendTngLog('error', `✗ Loopback failed: ${result.error ?? `status=${result.status}`} — our own listener can't be reached on the callback port. Save settings first, then retry.`);
    }
  });

  const [runTngPayRequest, tngPayBusy] = useAsyncAction(async () => {
    if (!settings) return;
    if (!settings.tngEnabled) {
      appendTngLog('error', 'Enable TNG first and Save settings');
      return;
    }
    await window.bridge.saveSettings(settings);
    appendTngLog('send', `PayRequest amount=${tngTestAmountCents}c`);
    const result = await window.bridge.tngTestPayRequest({ payAmount: tngTestAmountCents });
    setTngLastOrderId(result.orderId);
    if (result.ok) {
      const scheme = result.payType != null ? (PAY_TYPE_LABEL[result.payType] ?? `code ${result.payType}`) : '?';
      appendTngLog('recv', `✓ APPROVED · ${scheme} · card=${result.cardNo ?? '-'} · appr=${result.apprCode ?? '-'}`);
    } else if (result.resultState) {
      appendTngLog('error', `✗ DECLINED state=${result.resultState}`);
    } else {
      appendTngLog('error', `✗ ${result.error ?? 'failed'}`);
    }
  });

  const [runTngPayCancel, tngCancelBusy] = useAsyncAction(async () => {
    if (!tngLastOrderId) {
      appendTngLog('error', 'No orderId yet — fire PayRequest first');
      return;
    }
    appendTngLog('send', `PayCancel orderId=${tngLastOrderId}`);
    const result = await window.bridge.tngTestPayCancel(tngLastOrderId);
    if (result.ok) appendTngLog('recv', `✓ Cancel accepted (state=${result.deviceState})`);
    else appendTngLog('error', `✗ ${result.error ?? `state=${result.deviceState}`}`);
  });

  // ─── App self-update ───────────────────────────────────────────────────────
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckReport | null>(null);
  const [downloadProgressPct, setDownloadProgressPct] = useState<number | null>(null);
  const [downloadedUpdatePath, setDownloadedUpdatePath] = useState<string | null>(null);

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
    const result = await window.bridge.appUpdateDownload({ variant });
    if (result.ok && result.path) setDownloadedUpdatePath(result.path);
    else setUpdateCheck((prev) => ({ ...(prev ?? {}), error: result.error ?? 'download_failed' }));
  });

  const [confirm, confirmDialog] = useConfirm();
  const [runUpdateInstall, installingUpdate] = useAsyncAction(async () => {
    if (!downloadedUpdatePath) return;
    if (!(await confirm({ title: 'Install update', message: 'Install the update now?\n\nThis closes the app. For the installer variant, the NSIS wizard opens — accept its prompts. For the portable, the new exe launches in place.', confirmLabel: 'Install' }))) return;
    await window.bridge.appUpdateApply({ path: downloadedUpdatePath });
  });

  // ─── Maintenance ───────────────────────────────────────────────────────────
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
      <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
      <p className="text-sm text-gray-500 mt-1">Server-wide configuration. Restart not required — most changes take effect immediately.</p>

      <section className="mt-5 rounded-xl border border-gray-200 bg-white p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-bold uppercase tracking-widest text-gray-500">qparking SaaS sync</h2>
          <button
            type="button"
            onClick={() => runCloudSyncNow()}
            disabled={cloudSyncing}
            className="inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50"
          >
            {cloudSyncing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            {cloudSyncing ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
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
              {(['site', 'policies', 'passes', 'spaces'] as const).map((model) => {
                const result = cloudSyncReport[model];
                if (!result) return null;
                return (
                  <div key={model} className={result.ok ? 'text-emerald-700' : 'text-red-700'}>
                    {result.ok ? '✓' : '✗'} {model} — {result.ok ? `${result.fetched} pulled` : result.error}
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
                        {failed.length ? '✗' : skipped.length ? '⚠' : '✓'} {group} — {sent}/{items.length} sent
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
        <p className="text-[11px] text-gray-500 flex items-start gap-1.5"><AlertCircle size={13} className="flex-shrink-0 mt-0.5" /> Site, policies, passes and spaces are pulled from <code className="font-mono">{`{base}/api/v1/local-server/…`}</code>; lanes, terminals and cameras are pushed up. Equipment syncs as soon as it exists — no rate policy required. Background sync re-pulls everything every 60 seconds.</p>
      </section>

      <section className="mt-4 rounded-xl border border-gray-200 bg-white p-5 space-y-4">
        <h2 className="text-sm font-bold uppercase tracking-widest text-gray-500">Local servers</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="LPR webhook port">
            <input type="number" className="input" value={settings.lprWebhookPort} onChange={(e) => setSettings({ ...settings, lprWebhookPort: Number(e.target.value) })} />
          </Field>
          <Field label="Operator API port">
            <input type="number" className="input" value={settings.apiPort} onChange={(e) => setSettings({ ...settings, apiPort: Number(e.target.value) })} />
          </Field>
        </div>
        <Field label="Image store path (optional)">
          <input className="input font-mono text-xs" value={settings.imageStorePath} onChange={(e) => setSettings({ ...settings, imageStorePath: e.target.value })} placeholder="leave blank to use app userData/plates" />
        </Field>
      </section>

      <section className="mt-4 rounded-xl border border-gray-200 bg-white p-5 space-y-4">
        <h2 className="text-sm font-bold uppercase tracking-widest text-gray-500">Face-auth turnstile (faceapp_main)</h2>
        <p className="text-[11px] text-gray-500">
          Optional second gate trigger. When enabled, qparking-local POSTs to
          <code className="font-mono"> {`{base}/api/external/open-gate`} </code>
          on every successful plate scan (both entry AND paid exit) so the faceapp turnstile opens at the same moment the parking gate window shows WELCOME / COME AGAIN. This matches real-world LPR parking where both barriers raise together.
        </p>
        <label className="flex items-start gap-3 p-3 rounded-lg border border-gray-900 bg-gray-50 hover:border-gray-700 cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5 w-4 h-4 accent-gray-900"
            checked={settings.faceGateEnabled}
            onChange={(e) => setSettings({ ...settings, faceGateEnabled: e.target.checked })}
          />
          <div>
            <div className="text-sm font-semibold">Trigger faceapp turnstile on every plate scan</div>
            <div className="text-[11px] text-gray-500 mt-0.5">
              ON = fires on entry AND paid exit (matches real industry — plate recognized → both gates open). OFF = never fires, even if URL and token below are filled in. Use OFF to pause the integration without wiping config.
            </div>
          </div>
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="faceapp_main base URL">
            <input className="input" value={settings.faceappBaseUrl} onChange={(e) => setSettings({ ...settings, faceappBaseUrl: e.target.value })} placeholder="https://face.qbot.now" />
          </Field>
          <Field label="API token">
            <input type="password" className="input font-mono text-xs" value={settings.faceappApiToken} onChange={(e) => setSettings({ ...settings, faceappApiToken: e.target.value })} placeholder="FACEAPP_EXTERNAL_API_TOKEN" />
          </Field>
          <Field label="Device ID (0 = default device)">
            <input type="number" className="input" value={settings.faceappDeviceId} onChange={(e) => setSettings({ ...settings, faceappDeviceId: Number(e.target.value) })} />
          </Field>
          <div className="flex items-end gap-2">
            <button onClick={() => runFaceGatePing()} disabled={faceGatePingBusy || faceGateOpenBusy}
              className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg border border-gray-200 hover:border-gray-900 text-xs font-bold uppercase tracking-wide text-gray-700 disabled:opacity-50">
              {faceGatePingBusy ? <Loader2 size={13} className="animate-spin" /> : <Activity size={13} />}
              {faceGatePingBusy ? 'Pinging…' : 'Ping'}
            </button>
            <button onClick={() => runFaceGateOpen()} disabled={faceGatePingBusy || faceGateOpenBusy}
              className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50">
              {faceGateOpenBusy ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />}
              {faceGateOpenBusy ? 'Opening…' : 'Test open'}
            </button>
          </div>
        </div>
        {faceGateTestResult && (
          <div className={`rounded-lg border px-3 py-2 text-xs font-mono ${faceGateTestResult.startsWith('✓') ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700'}`}>
            {faceGateTestResult}
          </div>
        )}
      </section>

      <section className="mt-4 rounded-xl border border-gray-200 bg-white p-5 space-y-4">
        <h2 className="text-sm font-bold uppercase tracking-widest text-gray-500">Flow behavior</h2>

        {/* Which device collects the fee on a paid exit — strict either/or.
            Only the routing changes; each controller's own command sequence is
            untouched. */}
        <Field label="Payment controller">
          <select className="input" value={settings.paymentController ?? 'terminal'}
            onChange={(e) => setSettings({ ...settings, paymentController: e.target.value as 'terminal' | 'tng' })}>
            <option value="terminal">Payment terminal (ECPI) — the normal reader</option>
            <option value="tng">Touch'n'Go W4G controller</option>
          </select>
          <p className="text-[11px] text-gray-500 mt-1">
            On a paid exit the fee is collected by <strong>one</strong> of these — never both.
            {(settings.paymentController === 'tng')
              ? ' TNG requires “Enable Touch’n’Go W4G” below to be ON and the device IP set, so the PayResult callback server runs.'
              : ' The ECPI terminal wired to the exit lane drives the tap prompt.'}
          </p>
        </Field>

        <label className="flex items-start gap-3 p-3 rounded-lg border border-gray-200 hover:border-gray-300 cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5 w-4 h-4 accent-gray-900"
            checked={settings.entryCameraHandlesExit}
            onChange={(e) => setSettings({ ...settings, entryCameraHandlesExit: e.target.checked })}
          />
          <div>
            <div className="text-sm font-semibold">Single-camera mode: entry cam also handles exits</div>
            <div className="text-[11px] text-gray-500 mt-0.5">
              For sites with ONE camera covering both flows. When ON, the first scan of a plate opens a session (welcome + gate open + face turnstile). The next scan of the SAME plate while the session is still open is treated as the EXIT — drives the payment terminal, opens the gate, and raises the turnstile again on success. When OFF (default), an entry-direction camera only handles entries; exits need a separate exit-direction or dual camera.
            </div>
          </div>
        </label>
      </section>

      <section className="mt-4 rounded-xl border border-gray-200 bg-white p-5 space-y-4">
        <h2 className="text-sm font-bold uppercase tracking-widest text-gray-500">Touch'n'Go W4G IO controller</h2>
        <p className="text-[11px] text-gray-500">
          A W4G IO controller box on the LAN accepts Touch'n'Go card / e-wallet
          / Visa / Master / MCCS taps and settles through its own bank rail.
          This switch keeps the integration active — the PayResult callback
          server and the test panel below. Whether a paid exit is actually
          routed here is decided by <strong>Payment controller</strong> under
          Flow behavior (set it to <em>Touch'n'Go W4G</em>). Sessions paid via
          W4G are tagged <code className="font-mono">TNG_CARD</code> / <code className="font-mono">TNG_EWALLET</code> /
          <code className="font-mono">VISA_W4G</code> etc. so Finance reports
          can split TNG taps from the normal Visa/Master terminal flow.
        </p>
        <label className="flex items-start gap-3 p-3 rounded-lg border border-gray-900 bg-gray-50 hover:border-gray-700 cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5 w-4 h-4 accent-gray-900"
            checked={settings.tngEnabled}
            onChange={(e) => setSettings({ ...settings, tngEnabled: e.target.checked })}
          />
          <div>
            <div className="text-sm font-semibold">Enable Touch'n'Go W4G acquirer</div>
            <div className="text-[11px] text-gray-500 mt-0.5">
              ON = the W4G PayResult callback server runs and the test panel is live. Required before selecting the W4G controller for payment. OFF = no W4G server; exits use the ECPI terminal.
            </div>
          </div>
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="W4G device IP">
            <input className="input font-mono" value={settings.tngHost} onChange={(e) => setSettings({ ...settings, tngHost: e.target.value })} placeholder="192.168.1.105" />
          </Field>
          <Field label="W4G HTTP port">
            <input type="number" className="input" value={settings.tngPort} onChange={(e) => setSettings({ ...settings, tngPort: Number(e.target.value) })} />
          </Field>
          <Field label="Our callback port (PayResult)">
            <input type="number" className="input" value={settings.tngCallbackPort} onChange={(e) => setSettings({ ...settings, tngCallbackPort: Number(e.target.value) })} />
            <p className="text-[11px] text-gray-500 mt-1">
              The W4G device POSTs results to <code className="font-mono">http://&lt;our-lan-ip&gt;:{settings.tngCallbackPort}/w4g/PayResult</code>. Make sure this port is open on the host firewall.
            </p>
          </Field>
          <Field label="Per-transaction timeout (seconds)">
            <input type="number" className="input" value={settings.tngTimeoutSeconds} onChange={(e) => setSettings({ ...settings, tngTimeoutSeconds: Number(e.target.value) })} />
          </Field>
        </div>
        {tngStatus && (
          <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-[11px] font-mono space-y-1">
            <div className="flex items-center gap-2">
              <span className={`inline-block w-2 h-2 rounded-full ${tngStatus.listening ? 'bg-emerald-500' : 'bg-gray-400'}`} />
              {tngStatus.listening
                ? <span>Listener UP on 0.0.0.0:{(tngStatus.listenPorts ?? [tngStatus.listenPort]).join(', ')}</span>
                : <span>Listener DOWN — flip ON and save to start</span>}
            </div>
            {tngStatus.listening && tngStatus.listenAddresses.length > 0 && (
              <div className="text-gray-700">
                <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Configure the W4G device to POST PayResult to ONE of these URLs (the device firmware hardcodes port 80, so prefer that):</div>
                {tngStatus.listenAddresses.flatMap((ip) =>
                  (tngStatus.listenPorts ?? [tngStatus.listenPort]).map((port) => (
                    <div key={`${ip}:${port}`} className="flex items-center gap-1.5">
                      <span className={`inline-flex items-center px-1.5 rounded text-[10px] font-bold ${port === 80 ? 'bg-emerald-100 text-emerald-800' : 'bg-blue-100 text-blue-800'}`}>{ip}:{port}{port === 80 ? ' ★' : ''}</span>
                      <code className="text-gray-900 select-all">http://{ip}:{port}/w4g/PayResult</code>
                    </div>
                  ))
                )}
                <div className="text-[10px] text-gray-500 mt-0.5">★ = device default port. Use this entry in the device's SERVER IP setting via DebugTool. If Windows Firewall blocks inbound TCP, open it: <code>New-NetFirewallRule -Direction Inbound -Protocol TCP -LocalPort 80 -Action Allow -DisplayName 'qparking-local W4G'</code></div>
              </div>
            )}
            {tngStatus.pending.length > 0 && (
              <div>Pending orders: {tngStatus.pending.map((order) => `${order.orderId.slice(0, 8)}…(${order.payAmount}c)`).join(', ')}</div>
            )}
            {tngStatus.lastResult && (
              <div>Last result: orderId={tngStatus.lastResult.orderId.slice(0, 8)}… status={tngStatus.lastResult.status} payType={tngStatus.lastResult.payType ?? '-'} at {new Date(tngStatus.lastResult.at).toLocaleTimeString()}</div>
            )}
            {tngStatus.lastError && (
              <div className="text-red-700">Last error: {tngStatus.lastError}</div>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-end gap-2 pt-1">
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-gray-600 mb-1">Test amount (cents)</label>
            <input type="number" min="1" className="input w-32" value={tngTestAmountCents} onChange={(e) => setTngTestAmountCents(Math.max(1, Number(e.target.value) || 1))} />
          </div>
          <button onClick={() => runTngPing()} disabled={tngPinging || tngProbing || tngPayBusy || tngCancelBusy}
            className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg border border-gray-200 hover:border-gray-900 text-xs font-bold uppercase tracking-wide text-gray-700 disabled:opacity-50">
            {tngPinging ? <Loader2 size={13} className="animate-spin" /> : <Wifi size={13} />}
            {tngPinging ? 'Pinging…' : 'Ping device'}
          </button>
          <button onClick={() => runTngProbe()} disabled={tngPinging || tngProbing || tngLooping || tngPayBusy || tngCancelBusy}
            className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg border border-gray-200 hover:border-gray-900 text-xs font-bold uppercase tracking-wide text-gray-700 disabled:opacity-50"
            title="Sends a plain GET / to the device to verify it's speaking HTTP at all. Useful when PayRequest times out but Ping passes.">
            {tngProbing ? <Loader2 size={13} className="animate-spin" /> : <Activity size={13} />}
            {tngProbing ? 'Probing…' : 'Probe HTTP /'}
          </button>
          <button onClick={() => runTngLoopback()} disabled={tngPinging || tngProbing || tngLooping || tngPayBusy || tngCancelBusy}
            className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg border border-violet-200 hover:bg-violet-50 text-violet-700 text-xs font-bold uppercase tracking-wide disabled:opacity-50"
            title="POSTs a synthetic PayResult to our own listener — proves the receive path works end-to-end. If this passes but real device callbacks still don't land, the issue is the device's callback URL config or Windows Firewall.">
            {tngLooping ? <Loader2 size={13} className="animate-spin" /> : <Activity size={13} />}
            {tngLooping ? 'Looping…' : 'Test loopback'}
          </button>
          <button onClick={() => runTngPayRequest()} disabled={tngPinging || tngPayBusy || tngCancelBusy}
            className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50">
            {tngPayBusy ? <Loader2 size={13} className="animate-spin" /> : <CreditCard size={13} />}
            {tngPayBusy ? 'Awaiting tap…' : 'Test PayRequest'}
          </button>
          <button onClick={() => runTngPayCancel()} disabled={tngPinging || tngPayBusy || tngCancelBusy || !tngLastOrderId}
            className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg border border-red-200 hover:bg-red-50 text-red-700 text-xs font-bold uppercase tracking-wide disabled:opacity-50">
            {tngCancelBusy ? <Loader2 size={13} className="animate-spin" /> : <XCircle size={13} />}
            {tngCancelBusy ? 'Cancelling…' : 'Test PayCancel'}
          </button>
        </div>
        {tngLog.length > 0 && (
          <div className="rounded-lg border border-gray-200 bg-black/95 text-gray-100 px-3 py-2 max-h-72 overflow-auto text-[11px] font-mono space-y-1">
            {tngLog.map((line, idx) => {
              const kindColor =
                line.kind === 'error' ? 'text-red-400'
                : line.kind === 'send' ? 'text-sky-300'
                : line.kind === 'recv' ? 'text-emerald-300'
                : 'text-gray-400';
              const hasPayload = line.payload !== undefined && line.payload !== null;
              return (
                <div key={idx} className={kindColor}>
                  <div className="break-all">
                    <span className="text-gray-500">{line.at}</span>{' '}
                    <span className="uppercase">{line.kind}</span>{' '}
                    {line.text}
                  </div>
                  {hasPayload && (
                    <details className="ml-12 mt-0.5">
                      <summary className="cursor-pointer text-gray-500 hover:text-gray-300 text-[10px] uppercase tracking-wider">
                        payload ▾
                      </summary>
                      <pre className="mt-1 px-2 py-1 rounded bg-gray-900/80 text-gray-300 text-[10px] whitespace-pre-wrap break-all leading-snug">
                        {(() => {
                          try {
                            return typeof line.payload === 'string'
                              ? line.payload
                              : JSON.stringify(line.payload, null, 2);
                          } catch {
                            return String(line.payload);
                          }
                        })()}
                      </pre>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="mt-4 rounded-xl border border-gray-200 bg-white p-5 space-y-4">
        <h2 className="text-sm font-bold uppercase tracking-widest text-gray-500">Operations</h2>
        <Field label="Exit grace period (seconds)">
          <input type="number" className="input" value={settings.exitGracePeriodSeconds} onChange={(e) => setSettings({ ...settings, exitGracePeriodSeconds: Number(e.target.value) })} />
          <p className="text-[11px] text-gray-500 mt-1">If payment terminal doesn't complete within this window, the operator gets a manual-release prompt.</p>
        </Field>
      </section>

      <section className="mt-4 rounded-xl border border-gray-200 bg-white p-5 space-y-4">
        <h2 className="text-sm font-bold uppercase tracking-widest text-gray-500">App updates</h2>
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
              Last checked {new Date(updateCheck.checkedAt).toLocaleTimeString()}
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
                  <> · released: {new Date(updateCheck.releasedAt).toLocaleDateString()}</>
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

      <section className="mt-4 rounded-xl border border-gray-200 bg-white p-5 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-widest text-gray-500">Maintenance</h2>
        <p className="text-[11px] text-gray-500">
          Wipes Electron-side browser caches (HTTP responses, localStorage,
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
      </section>

      <div className="mt-5 flex items-center gap-2">
        <button onClick={() => saveSettings()} disabled={savingSettings}
          className="inline-flex items-center gap-2 h-11 px-5 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50">
          {savingSettings ? <Loader2 size={14} className="animate-spin" /> : justSaved ? <Check size={14} /> : <Save size={14} />}
          {savingSettings ? 'Saving…' : justSaved ? 'Saved' : 'Save settings'}
        </button>
      </div>

      <style>{`.input { height: 40px; padding: 0 0.75rem; border: 1px solid #d1d5db; border-radius: 0.5rem; outline: none; font-size: 14px; width: 100%; } .input:focus { border-color: #111827; }`}</style>
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
