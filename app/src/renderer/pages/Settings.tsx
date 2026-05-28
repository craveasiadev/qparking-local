import { useEffect, useState } from 'react';
import { Save, Check, AlertCircle, Zap, Activity, Loader2, Trash2 } from 'lucide-react';
import type { AppSettings } from '@shared/types';
import { useAsyncAction } from '../hooks/useAsyncAction';

export function Settings() {
  const [s, setS] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [faceGateTest, setFaceGateTest] = useState<string | null>(null);

  useEffect(() => { window.bridge.getSettings().then(setS); }, []);

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
        <h2 className="text-sm font-bold uppercase tracking-widest text-gray-500">Operations</h2>
        <Field label="Exit grace period (seconds)">
          <input type="number" className="input" value={s.exitGracePeriodSeconds} onChange={(e) => setS({ ...s, exitGracePeriodSeconds: Number(e.target.value) })} />
          <p className="text-[11px] text-gray-500 mt-1">If payment terminal doesn't complete within this window, the operator gets a manual-release prompt.</p>
        </Field>
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
