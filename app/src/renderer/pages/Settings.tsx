import { useEffect, useState } from 'react';
import { Save, Check, AlertCircle, Zap, Activity, Loader2, Trash2, CreditCard, XCircle, Wifi, Download, Package, RefreshCw } from 'lucide-react';
import type { AppSettings } from '@shared/types';
import { useAsyncAction } from '../hooks/useAsyncAction';

interface TngTestLine {
  ts: string;
  kind: 'send' | 'recv' | 'error' | 'info';
  text: string;
}

interface TngStatus {
  enabled: boolean;
  listening: boolean;
  listenPort: number;
  listenAddresses: string[];
  host: string;
  port: number;
  pending: { orderId: string; payAmount: number; startedAt: string }[];
  lastResult?: { orderId: string; status: string; payType?: number; at: string };
  lastError?: string;
}

const PAY_TYPE_LABEL: Record<number, string> = {
  0: 'TNG card',
  1: 'Visa',
  2: 'Mastercard',
  3: 'MCCS',
  4: 'TNG e-wallet',
};

export function Settings() {
  const [s, setS] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [faceGateTest, setFaceGateTest] = useState<string | null>(null);
  const [tngStatus, setTngStatus] = useState<TngStatus | null>(null);
  const [tngLog, setTngLog] = useState<TngTestLine[]>([]);
  const [tngTestAmount, setTngTestAmount] = useState<number>(100);
  const [tngLastOrderId, setTngLastOrderId] = useState<string>('');

  useEffect(() => { window.bridge.getSettings().then(setS); }, []);

  // Live status poll — refreshes every 2s so the operator sees pending
  // orders and the last callback as soon as the device responds.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const st = await window.bridge.tngStatus();
        if (!cancelled) setTngStatus(st);
      } catch { /* ignore */ }
    };
    tick();
    const handle = setInterval(tick, 2000);
    return () => { cancelled = true; clearInterval(handle); };
  }, []);

  // Stream W4G activity into the test panel. Comes through the generic 'log'
  // channel; we filter by source==='w4g' so other terminal logs don't leak in.
  useEffect(() => {
    const off = window.bridge.onEvent('log' as any, (payload: any) => {
      if (payload?.source !== 'w4g') return;
      setTngLog((prev) => [
        { ts: new Date().toLocaleTimeString(), kind: payload.direction, text: payload.message },
        ...prev,
      ].slice(0, 30));
    });
    return () => { try { off(); } catch { /* ignore */ } };
  }, []);

  const pushLog = (kind: TngTestLine['kind'], text: string) => {
    setTngLog((prev) => [{ ts: new Date().toLocaleTimeString(), kind, text }, ...prev].slice(0, 30));
  };

  const [save, saving] = useAsyncAction(async () => {
    if (!s) return;
    const next = await window.bridge.saveSettings(s);
    setS(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  });

  const [runPing, pingBusy] = useAsyncAction(async () => {
    if (!s) return;
    setFaceGateTest('Saving config…');
    await window.bridge.saveSettings(s);
    setFaceGateTest('Pinging…');
    const r = await window.bridge.pingFaceGate();
    setFaceGateTest(r.ok ? `✓ Reachable (status ${r.status})` : `✗ ${r.error ?? `status ${r.status}`}`);
  });

  const [runTngPing, tngPinging] = useAsyncAction(async () => {
    if (!s) return;
    await window.bridge.saveSettings(s);
    pushLog('info', `Ping ${s.tngHost}:${s.tngPort}…`);
    const r = await window.bridge.tngPing();
    if (r.ok) pushLog('recv', `✓ Reachable (${r.latencyMs}ms)`);
    else pushLog('error', `✗ ${r.error ?? 'unreachable'}`);
  });

  const [runTngPayRequest, tngPayBusy] = useAsyncAction(async () => {
    if (!s) return;
    if (!s.tngEnabled) {
      pushLog('error', 'Enable TNG first and Save settings');
      return;
    }
    await window.bridge.saveSettings(s);
    pushLog('send', `PayRequest amount=${tngTestAmount}c`);
    const r = await window.bridge.tngTestPayRequest({ payAmount: tngTestAmount });
    setTngLastOrderId(r.orderId);
    if (r.ok) {
      const scheme = r.payType != null ? (PAY_TYPE_LABEL[r.payType] ?? `code ${r.payType}`) : '?';
      pushLog('recv', `✓ APPROVED · ${scheme} · card=${r.cardNo ?? '-'} · appr=${r.apprCode ?? '-'}`);
    } else if (r.resultState) {
      pushLog('error', `✗ DECLINED state=${r.resultState}`);
    } else {
      pushLog('error', `✗ ${r.error ?? 'failed'}`);
    }
  });

  const [runTngPayCancel, tngCancelBusy] = useAsyncAction(async () => {
    if (!tngLastOrderId) {
      pushLog('error', 'No orderId yet — fire PayRequest first');
      return;
    }
    pushLog('send', `PayCancel orderId=${tngLastOrderId}`);
    const r = await window.bridge.tngTestPayCancel(tngLastOrderId);
    if (r.ok) pushLog('recv', `✓ Cancel accepted (state=${r.deviceState})`);
    else pushLog('error', `✗ ${r.error ?? `state=${r.deviceState}`}`);
  });

  // ─── App self-update ─────────────────────────────────────────────────
  const [appUpdate, setAppUpdate] = useState<{
    checkedAt?: string;
    currentVersion?: string;
    latestVersion?: string;
    isNewer?: boolean;
    releasedAt?: string | null;
    notes?: string | null;
    portable?: { filename: string; size: number | null; url: string } | null;
    installer?: { filename: string; size: number | null; url: string } | null;
    error?: string;
  } | null>(null);
  const [downloadPct, setDownloadPct] = useState<number | null>(null);
  const [downloadedPath, setDownloadedPath] = useState<string | null>(null);

  useEffect(() => {
    // Subscribe to streaming progress events from the main process.
    const off = window.bridge.onEvent('app-update-progress' as any, (p: any) => {
      if (typeof p?.pct === 'number') setDownloadPct(p.pct);
    });
    return () => { try { off(); } catch { /* ignore */ } };
  }, []);

  const [checkUpdate, checking] = useAsyncAction(async () => {
    setDownloadPct(null);
    setDownloadedPath(null);
    const r = await window.bridge.appUpdateCheck();
    setAppUpdate({ ...r, checkedAt: new Date().toISOString() });
  });

  const [downloadUpdate, downloading] = useAsyncAction(async (variant: 'portable' | 'installer') => {
    setDownloadPct(0);
    const r = await window.bridge.appUpdateDownload({ variant });
    if (r.ok && r.path) setDownloadedPath(r.path);
    else setAppUpdate((prev) => ({ ...(prev ?? {}), error: r.error ?? 'download_failed' }));
  });

  const [applyUpdate, applying] = useAsyncAction(async () => {
    if (!downloadedPath) return;
    if (!confirm('Install the update now?\n\nThis closes the app. For the installer variant, the NSIS wizard opens — accept its prompts. For the portable, the new exe launches in place.')) return;
    await window.bridge.appUpdateApply({ path: downloadedPath });
  });

  const [runClearCache, clearingCache] = useAsyncAction(async () => {
    if (!confirm('Clear browser cache and reload?\n\nThis wipes Electron-side cached responses, localStorage, IndexedDB, and cookies, then reloads the window. Your parking data (sessions, terminals, settings) is NOT affected.')) return;
    const r = await window.bridge.clearAppCache();
    // The reload happens server-side before this resolves, but show feedback
    // just in case the renderer is still alive momentarily.
    console.log(`[settings] cache cleared in ${r.elapsedMs}ms`);
  });

  const [runTestOpen, testOpenBusy] = useAsyncAction(async () => {
    if (!s) return;
    setFaceGateTest('Saving config…');
    await window.bridge.saveSettings(s);
    setFaceGateTest('Opening…');
    const r = await window.bridge.openFaceGate({ plate: 'TEST', reason: 'settings-test' });
    if (r.ok) {
      setFaceGateTest('✓ Open command accepted by gateway');
    } else {
      const bodyMsg = (r.body as any)?.message ?? (r.body as any)?.error ?? '';
      const bits = [`status ${r.status ?? '—'}`];
      if (r.error) bits.push(r.error);
      if (bodyMsg) bits.push(bodyMsg);
      setFaceGateTest(`✗ ${bits.join(' · ')}`);
    }
  });

  if (!s) return <div className="p-10 text-center text-gray-500 text-sm">Loading…</div>;

  return (
    <div className="p-5 sm:p-8 max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
      <p className="text-sm text-gray-500 mt-1">Server-wide configuration. Restart not required — most changes take effect immediately.</p>

      <section className="mt-5 rounded-xl border border-gray-200 bg-white p-5 space-y-4">
        <h2 className="text-sm font-bold uppercase tracking-widest text-gray-500">qparking SaaS sync</h2>
        <Field label="qparking base URL">
          <input className="input" value={s.qparkingBaseUrl} onChange={(e) => setS({ ...s, qparkingBaseUrl: e.target.value })} placeholder="https://parking.qbot.now" />
        </Field>
        <Field label="API key">
          <input type="password" className="input font-mono text-xs" value={s.qparkingApiKey} onChange={(e) => setS({ ...s, qparkingApiKey: e.target.value })} placeholder="issued by qparking admin" />
        </Field>
        <p className="text-[11px] text-gray-500 flex items-start gap-1.5"><AlertCircle size={13} className="flex-shrink-0 mt-0.5" /> Scope/rate rows are pulled from <code className="font-mono">{`{base}/api/local-server/scopes`}</code>. Background sync runs hourly.</p>
      </section>

      <section className="mt-4 rounded-xl border border-gray-200 bg-white p-5 space-y-4">
        <h2 className="text-sm font-bold uppercase tracking-widest text-gray-500">Local servers</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="LPR webhook port">
            <input type="number" className="input" value={s.lprWebhookPort} onChange={(e) => setS({ ...s, lprWebhookPort: Number(e.target.value) })} />
          </Field>
          <Field label="Operator API port">
            <input type="number" className="input" value={s.apiPort} onChange={(e) => setS({ ...s, apiPort: Number(e.target.value) })} />
          </Field>
        </div>
        <Field label="Image store path (optional)">
          <input className="input font-mono text-xs" value={s.imageStorePath} onChange={(e) => setS({ ...s, imageStorePath: e.target.value })} placeholder="leave blank to use app userData/plates" />
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
            checked={s.faceGateEnabled}
            onChange={(e) => setS({ ...s, faceGateEnabled: e.target.checked })}
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
            <input className="input" value={s.faceappBaseUrl} onChange={(e) => setS({ ...s, faceappBaseUrl: e.target.value })} placeholder="https://face.qbot.now" />
          </Field>
          <Field label="API token">
            <input type="password" className="input font-mono text-xs" value={s.faceappApiToken} onChange={(e) => setS({ ...s, faceappApiToken: e.target.value })} placeholder="FACEAPP_EXTERNAL_API_TOKEN" />
          </Field>
          <Field label="Device ID (0 = default device)">
            <input type="number" className="input" value={s.faceappDeviceId} onChange={(e) => setS({ ...s, faceappDeviceId: Number(e.target.value) })} />
          </Field>
          <div className="flex items-end gap-2">
            <button onClick={() => runPing()} disabled={pingBusy || testOpenBusy}
              className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg border border-gray-200 hover:border-gray-900 text-xs font-bold uppercase tracking-wide text-gray-700 disabled:opacity-50">
              {pingBusy ? <Loader2 size={13} className="animate-spin" /> : <Activity size={13} />}
              {pingBusy ? 'Pinging…' : 'Ping'}
            </button>
            <button onClick={() => runTestOpen()} disabled={pingBusy || testOpenBusy}
              className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50">
              {testOpenBusy ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />}
              {testOpenBusy ? 'Opening…' : 'Test open'}
            </button>
          </div>
        </div>
        {faceGateTest && (
          <div className={`rounded-lg border px-3 py-2 text-xs font-mono ${faceGateTest.startsWith('✓') ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700'}`}>
            {faceGateTest}
          </div>
        )}
      </section>

      <section className="mt-4 rounded-xl border border-gray-200 bg-white p-5 space-y-4">
        <h2 className="text-sm font-bold uppercase tracking-widest text-gray-500">Flow behavior</h2>
        <label className="flex items-start gap-3 p-3 rounded-lg border border-gray-200 hover:border-gray-300 cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5 w-4 h-4 accent-gray-900"
            checked={s.entryCameraHandlesExit}
            onChange={(e) => setS({ ...s, entryCameraHandlesExit: e.target.checked })}
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
          Multi-acquirer payment: a W4G IO controller box on the LAN accepts
          Touch'n'Go card / e-wallet / Visa / Master / MCCS taps and settles
          through its own bank rail. When enabled, every paid exit fires a
          <code className="font-mono"> PayRequest </code>
          to this device IN PARALLEL with the ECPI terminal — whichever
          device the driver taps on first wins. Sessions paid via W4G are
          tagged <code className="font-mono">TNG_CARD</code> / <code className="font-mono">TNG_EWALLET</code> /
          <code className="font-mono">VISA_W4G</code> etc. so Finance reports
          can split TNG taps from the normal Visa/Master terminal flow.
        </p>
        <label className="flex items-start gap-3 p-3 rounded-lg border border-gray-900 bg-gray-50 hover:border-gray-700 cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5 w-4 h-4 accent-gray-900"
            checked={s.tngEnabled}
            onChange={(e) => setS({ ...s, tngEnabled: e.target.checked })}
          />
          <div>
            <div className="text-sm font-semibold">Enable Touch'n'Go W4G acquirer</div>
            <div className="text-[11px] text-gray-500 mt-0.5">
              ON = every paid exit fires PayRequest at the W4G box alongside the ECPI tap prompt. OFF = no W4G calls, parking continues on ECPI only.
            </div>
          </div>
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="W4G device IP">
            <input className="input font-mono" value={s.tngHost} onChange={(e) => setS({ ...s, tngHost: e.target.value })} placeholder="192.168.1.105" />
          </Field>
          <Field label="W4G HTTP port">
            <input type="number" className="input" value={s.tngPort} onChange={(e) => setS({ ...s, tngPort: Number(e.target.value) })} />
          </Field>
          <Field label="Our callback port (PayResult)">
            <input type="number" className="input" value={s.tngCallbackPort} onChange={(e) => setS({ ...s, tngCallbackPort: Number(e.target.value) })} />
            <p className="text-[11px] text-gray-500 mt-1">
              The W4G device POSTs results to <code className="font-mono">http://&lt;our-lan-ip&gt;:{s.tngCallbackPort}/w4g/PayResult</code>. Make sure this port is open on the host firewall.
            </p>
          </Field>
          <Field label="Per-transaction timeout (seconds)">
            <input type="number" className="input" value={s.tngTimeoutSeconds} onChange={(e) => setS({ ...s, tngTimeoutSeconds: Number(e.target.value) })} />
          </Field>
        </div>
        {tngStatus && (
          <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-[11px] font-mono space-y-0.5">
            <div className="flex items-center gap-2">
              <span className={`inline-block w-2 h-2 rounded-full ${tngStatus.listening ? 'bg-emerald-500' : 'bg-gray-400'}`} />
              {tngStatus.listening
                ? <span>Listener UP on :{tngStatus.listenPort} — device callback URL: <strong>http://&lt;{tngStatus.listenAddresses[0] ?? 'this-host'}&gt;:{tngStatus.listenPort}/w4g/PayResult</strong></span>
                : <span>Listener DOWN — flip ON and save to start</span>}
            </div>
            {tngStatus.pending.length > 0 && (
              <div>Pending orders: {tngStatus.pending.map((p) => `${p.orderId.slice(0, 8)}…(${p.payAmount}c)`).join(', ')}</div>
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
            <input type="number" min="1" className="input w-32" value={tngTestAmount} onChange={(e) => setTngTestAmount(Math.max(1, Number(e.target.value) || 1))} />
          </div>
          <button onClick={() => runTngPing()} disabled={tngPinging || tngPayBusy || tngCancelBusy}
            className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg border border-gray-200 hover:border-gray-900 text-xs font-bold uppercase tracking-wide text-gray-700 disabled:opacity-50">
            {tngPinging ? <Loader2 size={13} className="animate-spin" /> : <Wifi size={13} />}
            {tngPinging ? 'Pinging…' : 'Ping device'}
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
          <div className="rounded-lg border border-gray-200 bg-black/95 text-gray-100 px-3 py-2 max-h-56 overflow-auto text-[11px] font-mono space-y-0.5">
            {tngLog.map((line, idx) => (
              <div key={idx} className={
                line.kind === 'error' ? 'text-red-400'
                : line.kind === 'send' ? 'text-sky-300'
                : line.kind === 'recv' ? 'text-emerald-300'
                : 'text-gray-400'
              }>
                <span className="text-gray-500">{line.ts}</span> <span className="uppercase">{line.kind}</span> {line.text}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mt-4 rounded-xl border border-gray-200 bg-white p-5 space-y-4">
        <h2 className="text-sm font-bold uppercase tracking-widest text-gray-500">Operations</h2>
        <Field label="Exit grace period (seconds)">
          <input type="number" className="input" value={s.exitGracePeriodSeconds} onChange={(e) => setS({ ...s, exitGracePeriodSeconds: Number(e.target.value) })} />
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
            onClick={() => checkUpdate()}
            disabled={checking || downloading || applying}
            className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg border border-gray-200 hover:border-gray-900 text-xs font-bold uppercase tracking-wide text-gray-700 disabled:opacity-50"
          >
            {checking ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            {checking ? 'Checking…' : 'Check for updates'}
          </button>
          {appUpdate?.checkedAt && (
            <span className="text-[11px] text-gray-500">
              Last checked {new Date(appUpdate.checkedAt).toLocaleTimeString()}
            </span>
          )}
        </div>

        {appUpdate?.error && (
          <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 text-xs px-3 py-2">
            <strong>Error:</strong> {appUpdate.error}
          </div>
        )}

        {appUpdate?.currentVersion && appUpdate.latestVersion && (
          <div className={`rounded-lg border px-3 py-2.5 text-xs space-y-1 ${
            appUpdate.isNewer ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50'
          }`}>
            <div className="flex items-center justify-between gap-2">
              <div className="inline-flex items-center gap-1.5">
                <Package size={13} className={appUpdate.isNewer ? 'text-amber-700' : 'text-emerald-700'} />
                <span className="font-bold">
                  {appUpdate.isNewer
                    ? `Update available: ${appUpdate.latestVersion}`
                    : `You're on the latest (${appUpdate.currentVersion})`}
                </span>
              </div>
              <span className="font-mono text-[11px] text-gray-600">
                installed: {appUpdate.currentVersion}
                {appUpdate.releasedAt && appUpdate.isNewer && (
                  <> · released: {new Date(appUpdate.releasedAt).toLocaleDateString()}</>
                )}
              </span>
            </div>
            {appUpdate.notes && (
              <p className="text-[11px] text-gray-700 mt-1 whitespace-pre-wrap">{appUpdate.notes}</p>
            )}
          </div>
        )}

        {appUpdate?.isNewer && (appUpdate.portable || appUpdate.installer) && !downloadedPath && (
          <div className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-600">Choose how to update</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {appUpdate.installer && (
                <button
                  onClick={() => downloadUpdate('installer')}
                  disabled={downloading || applying}
                  className="flex flex-col items-start gap-1 rounded-lg border border-gray-200 hover:border-gray-900 px-3 py-2.5 text-left disabled:opacity-50"
                >
                  <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide">
                    <Download size={13} /> Installer (.exe)
                  </div>
                  <div className="text-[11px] text-gray-500 font-mono">{appUpdate.installer.filename}</div>
                  <div className="text-[11px] text-gray-400">
                    {appUpdate.installer.size ? `${(appUpdate.installer.size / 1024 / 1024).toFixed(1)} MB` : '—'} · NSIS wizard, in-place upgrade
                  </div>
                </button>
              )}
              {appUpdate.portable && (
                <button
                  onClick={() => downloadUpdate('portable')}
                  disabled={downloading || applying}
                  className="flex flex-col items-start gap-1 rounded-lg border border-gray-200 hover:border-gray-900 px-3 py-2.5 text-left disabled:opacity-50"
                >
                  <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide">
                    <Download size={13} /> Portable (.exe)
                  </div>
                  <div className="text-[11px] text-gray-500 font-mono">{appUpdate.portable.filename}</div>
                  <div className="text-[11px] text-gray-400">
                    {appUpdate.portable.size ? `${(appUpdate.portable.size / 1024 / 1024).toFixed(1)} MB` : '—'} · single-file, no installer
                  </div>
                </button>
              )}
            </div>
          </div>
        )}

        {downloadPct !== null && !downloadedPath && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[11px] text-gray-600">
              <span className="inline-flex items-center gap-1.5"><Loader2 size={11} className="animate-spin" /> Downloading…</span>
              <span className="font-mono">{downloadPct}%</span>
            </div>
            <div className="h-2 rounded-full overflow-hidden bg-gray-100">
              <div className="h-full bg-gray-900 transition-all" style={{ width: `${downloadPct}%` }} />
            </div>
          </div>
        )}

        {downloadedPath && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-xs space-y-2">
            <div className="inline-flex items-center gap-1.5 font-bold text-emerald-800">
              <Check size={13} /> Download complete
            </div>
            <div className="font-mono text-[10px] text-gray-600 break-all">{downloadedPath}</div>
            <button
              onClick={() => applyUpdate()}
              disabled={applying}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50"
            >
              {applying ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
              {applying ? 'Restarting…' : 'Install & restart'}
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
          delete parking sessions, terminals, cameras, lanes, scopes, or settings</strong> —
          those live in the SQLite database and survive a cache clear.
        </p>
        <button onClick={() => runClearCache()} disabled={clearingCache}
          className="inline-flex items-center gap-2 h-10 px-4 rounded-lg border border-red-200 bg-white hover:bg-red-50 text-red-700 text-xs font-bold uppercase tracking-wide disabled:opacity-50">
          {clearingCache ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
          {clearingCache ? 'Clearing & reloading…' : 'Clear cache & reload'}
        </button>
      </section>

      <div className="mt-5 flex items-center gap-2">
        <button onClick={() => save()} disabled={saving}
          className="inline-flex items-center gap-2 h-11 px-5 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold uppercase tracking-wide disabled:opacity-50">
          {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <Check size={14} /> : <Save size={14} />}
          {saving ? 'Saving…' : saved ? 'Saved' : 'Save settings'}
        </button>
      </div>

      <style>{`.input { height: 40px; padding: 0 0.75rem; border: 1px solid #d1d5db; border-radius: 0.5rem; outline: none; font-size: 14px; width: 100%; } .input:focus { border-color: #111827; }`}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-semibold uppercase tracking-wide text-gray-600 mb-1">{label}</label>
      {children}
    </div>
  );
}
