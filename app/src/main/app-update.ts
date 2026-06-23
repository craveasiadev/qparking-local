/**
 * Self-update channel against the qparking cloud's /latest-built endpoint.
 *
 * Flow:
 *   1. checkForUpdate()      — GET /api/v1/local-server/latest-built, semver
 *                              compare against app.getVersion().
 *   2. downloadUpdate()      — stream the chosen variant's .exe to a temp
 *                              file with progress events back to the renderer.
 *   3. applyUpdate()         — shell.openPath(...) the downloaded file then
 *                              app.quit(). NSIS handles in-place upgrade with
 *                              its standard wizard. Portable just relaunches.
 *
 * No external dependency on electron-updater — that ships its own download
 * mechanism + signature checks, but requires a code-signing cert and a
 * properly published GitHub/S3 feed. For an unsigned on-prem app talking to
 * a private qparking SaaS, a plain HTTP fetch with bearer auth is enough.
 */
import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { getSettings } from './db';

export interface BuildVariantMeta {
  filename: string;
  size: number | null;
  sha256: string | null;
  url: string;
}

export interface UpdateCheckResult {
  ok: boolean;
  currentVersion: string;
  latestVersion?: string;
  isNewer?: boolean;
  releasedAt?: string | null;
  notes?: string | null;
  portable?: BuildVariantMeta | null;
  installer?: BuildVariantMeta | null;
  error?: string;
}

function trimTrailingSlash(s: string): string { return s.replace(/\/+$/, ''); }

/** Compare two semver-ish strings ("0.14.2" vs "0.14.1"). Returns +1 if a > b,
 *  -1 if a < b, 0 if equal. Tolerates missing parts (treats as 0). Pre-release
 *  suffixes after "-" are stripped — we don't ship them. */
export function compareVersions(a: string, b: string): number {
  const norm = (v: string) => v.split('-')[0].split('.').map((n) => Number(n) || 0);
  const aParts = norm(a);
  const bParts = norm(b);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const av = aParts[i] ?? 0;
    const bv = bParts[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion();
  const s = getSettings();
  if (!s.qparkingBaseUrl || !s.qparkingApiKey) {
    return { ok: false, currentVersion, error: 'qparking_not_configured — set qparking base URL and API key in Settings' };
  }
  const url = `${trimTrailingSlash(s.qparkingBaseUrl)}/api/v1/local-server/latest-built`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${s.qparkingApiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return { ok: false, currentVersion, error: `http_${res.status}` };
    }
    const body: any = await res.json();
    if (!body || body.available === false) {
      return {
        ok: true,
        currentVersion,
        error: body?.reason ? `no_update_published (${body.reason})` : 'no_update_published',
      };
    }
    const latestVersion = String(body.version ?? '');
    const isNewer = latestVersion && compareVersions(latestVersion, currentVersion) > 0;
    return {
      ok: true,
      currentVersion,
      latestVersion,
      isNewer: !!isNewer,
      releasedAt: body.released_at ?? null,
      notes: body.notes ?? null,
      portable: body.portable ?? null,
      installer: body.installer ?? null,
    };
  } catch (e: any) {
    return { ok: false, currentVersion, error: e?.message ?? String(e) };
  }
}

/**
 * Stream the chosen variant to a temp file. Emits 'app-update-progress'
 * with `{ bytes, totalBytes, pct }` so the renderer can draw a progress bar.
 */
export async function downloadUpdate(opts: {
  variant: 'portable' | 'installer';
  onProgress?: (p: { bytes: number; totalBytes: number; pct: number }) => void;
}): Promise<{ ok: boolean; path?: string; bytes?: number; sha256?: string; error?: string }> {
  const s = getSettings();
  if (!s.qparkingBaseUrl || !s.qparkingApiKey) {
    return { ok: false, error: 'qparking_not_configured' };
  }
  const url = `${trimTrailingSlash(s.qparkingBaseUrl)}/api/v1/local-server/latest-built/download/${opts.variant}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${s.qparkingApiKey}` },
      // No abort — the file is 80MB+; let it take however long it takes.
    });
    if (!res.ok || !res.body) {
      return { ok: false, error: `http_${res.status}` };
    }
    const totalBytes = Number(res.headers.get('content-length') ?? 0);
    // Pull the suggested filename from Content-Disposition so updates land
    // with their proper version-stamped name. Fall back to a generic one.
    const cdHeader = res.headers.get('content-disposition') ?? '';
    const cdMatch = cdHeader.match(/filename="?([^";]+)"?/);
    const filename = cdMatch?.[1] || `qparking-local-update-${opts.variant}.exe`;
    const outDir = path.join(app.getPath('userData'), 'updates');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, filename);

    const fileHandle = await fs.promises.open(outPath, 'w');
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const reader = (res.body as any).getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.byteLength) {
        await fileHandle.write(value);
        hash.update(value);
        bytes += value.byteLength;
        if (opts.onProgress) {
          opts.onProgress({
            bytes,
            totalBytes,
            pct: totalBytes > 0 ? Math.min(100, Math.floor((bytes / totalBytes) * 100)) : 0,
          });
        }
      }
    }
    await fileHandle.close();
    return { ok: true, path: outPath, bytes, sha256: hash.digest('hex') };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/**
 * Launch the downloaded build via the OS shell and quit the current app.
 * For NSIS this fires the wizard (which can in-place upgrade with the same
 * appId, replacing the installed copy). For portable it just opens the new
 * exe; the operator can move it where they want.
 *
 * We delay the quit by a beat so the renderer's "Restarting…" toast renders
 * before we tear the window down — without it the operator just sees the
 * app vanish, which looks like a crash.
 */
export async function applyUpdate(opts: { path: string }): Promise<{ ok: boolean; error?: string }> {
  if (!opts.path || !fs.existsSync(opts.path)) {
    return { ok: false, error: 'downloaded_file_missing' };
  }
  const err = await shell.openPath(opts.path);
  if (err) return { ok: false, error: err };
  setTimeout(() => {
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.close(); } catch { /* ignore */ }
    }
    app.quit();
  }, 1_200);
  return { ok: true };
}
