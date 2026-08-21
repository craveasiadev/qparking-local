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
 * a private qparking SaaS, the shared cloud API client is enough.
 */
import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { getCloudApi, describeRequestError } from './services/cloud-api';

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

/** Compare two semver-ish strings ("0.14.2" vs "0.14.1"). Returns +1 if a > b,
 *  -1 if a < b, 0 if equal. Tolerates missing parts (treats as 0). Pre-release
 *  suffixes after "-" are stripped — we don't ship them. */
function compareVersions(a: string, b: string): number {
  const toParts = (version: string) => version.split('-')[0].split('.').map((part) => Number(part) || 0);
  const partsA = toParts(a);
  const partsB = toParts(b);
  const length = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < length; i++) {
    const partA = partsA[i] ?? 0;
    const partB = partsB[i] ?? 0;
    if (partA > partB) return 1;
    if (partA < partB) return -1;
  }
  return 0;
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion();
  const cloud = getCloudApi();
  if (!cloud) {
    return { ok: false, currentVersion, error: 'qparking_not_configured — set qparking base URL and API key in Settings' };
  }
  try {
    const { data: body } = await cloud.get<any>('/latest-built');
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
  } catch (error) {
    return { ok: false, currentVersion, error: describeRequestError(error) };
  }
}

/**
 * Stream the chosen variant to a temp file. Emits 'app-update-progress'
 * with `{ bytes, totalBytes, pct }` so the renderer can draw a progress bar.
 */
export async function downloadUpdate(opts: {
  variant: 'portable' | 'installer';
  /** The digest /latest-built published for this variant, when it published one.
   *  Passed straight back out as `expectedSha256` so applyUpdate can verify
   *  without a second round-trip to the cloud. */
  expectedSha256?: string | null;
  onProgress?: (progress: { bytes: number; totalBytes: number; pct: number }) => void;
}): Promise<{
  ok: boolean; path?: string; bytes?: number; sha256?: string;
  expectedSha256?: string | null; verified?: boolean; error?: string;
}> {
  const cloud = getCloudApi();
  if (!cloud) return { ok: false, error: 'qparking_not_configured' };
  try {
    const response = await cloud.get(`/latest-built/download/${opts.variant}`, {
      responseType: 'stream',
      // No timeout — the file is 80MB+; let it take however long it takes.
      timeout: 0,
    });

    const totalBytes = Number(response.headers['content-length'] ?? 0);
    // Pull the suggested filename from Content-Disposition so updates land
    // with their proper version-stamped name. Fall back to a generic one.
    const contentDisposition = String(response.headers['content-disposition'] ?? '');
    const filenameMatch = contentDisposition.match(/filename="?([^";]+)"?/);
    // basename, always: this string comes off the wire, and the result is passed
    // to shell.openPath. A Content-Disposition of `filename="..\..\evil.exe"`
    // would otherwise write and execute outside the updates directory.
    const filename = path.basename(filenameMatch?.[1] || '') || `qparking-local-update-${opts.variant}.exe`;
    const updatesDir = path.join(app.getPath('userData'), 'updates');
    fs.mkdirSync(updatesDir, { recursive: true });
    const downloadPath = path.join(updatesDir, filename);

    const fileHandle = await fs.promises.open(downloadPath, 'w');
    const sha256 = crypto.createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of response.data as NodeJS.ReadableStream) {
        const buffer = chunk as Buffer;
        await fileHandle.write(buffer);
        sha256.update(buffer);
        bytes += buffer.byteLength;
        opts.onProgress?.({
          bytes,
          totalBytes,
          pct: totalBytes > 0 ? Math.min(100, Math.floor((bytes / totalBytes) * 100)) : 0,
        });
      }
    } finally {
      await fileHandle.close();
    }
    const digest = sha256.digest('hex');
    const expected = opts.expectedSha256 ? opts.expectedSha256.trim().toLowerCase() : null;

    // The digest was computed here and published by the cloud all along, and
    // nothing ever compared the two — so a truncated or tampered .exe was
    // executed with the one integrity check the design already had sitting
    // unused. Compare now, and refuse rather than hand back a path.
    if (expected && digest !== expected) {
      try { fs.unlinkSync(downloadPath); } catch { /* best-effort */ }
      return {
        ok: false,
        expectedSha256: expected,
        sha256: digest,
        error: `checksum_mismatch — the download does not match the digest the cloud published`
          + ` (expected ${expected.slice(0, 12)}…, got ${digest.slice(0, 12)}…).`
          + ` The file has been deleted; try the download again.`,
      };
    }
    if (totalBytes > 0 && bytes !== totalBytes) {
      try { fs.unlinkSync(downloadPath); } catch { /* best-effort */ }
      return {
        ok: false,
        error: `truncated_download — got ${bytes} of ${totalBytes} bytes. The file has been deleted; try again.`,
      };
    }
    return {
      ok: true, path: downloadPath, bytes, sha256: digest,
      expectedSha256: expected,
      // false = the CLOUD published no digest, so there was nothing to check
      // against. Older SaaS builds don't send one, and refusing outright would
      // brick updates against them — so this is surfaced instead of assumed.
      verified: !!expected,
    };
  } catch (error) {
    return { ok: false, error: describeRequestError(error) };
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
 *
 * The teardown is DELEGATED, not hand-rolled here. This used to close the
 * windows and call app.quit(), which is the exact route forceQuit() exists to
 * avoid: once the VzLPR SDK is loaded — every site with a credentialed camera —
 * the native teardown hangs, so the process sat there with the NSIS wizard
 * already running against a live executable. It also skipped closeDb(), leaving
 * SQLite un-checkpointed while the binary was replaced. `onQuit` is index.ts's
 * forceQuit, which stops the services, checkpoints the DB and then exits in the
 * SDK-aware way.
 */
export async function applyUpdate(opts: {
  path: string;
  /** Optional integrity gate. When the caller knows what the cloud published,
   *  pass it: the file is re-hashed here, because "verified at download time"
   *  says nothing about the file still on disk at APPLY time. */
  expectedSha256?: string | null;
  onQuit: () => void;
}): Promise<{ ok: boolean; error?: string }> {
  if (!opts.path || !fs.existsSync(opts.path)) {
    return { ok: false, error: 'downloaded_file_missing' };
  }
  if (opts.expectedSha256) {
    const expected = opts.expectedSha256.trim().toLowerCase();
    const actual = crypto.createHash('sha256').update(fs.readFileSync(opts.path)).digest('hex');
    if (actual !== expected) {
      return {
        ok: false,
        error: `checksum_mismatch — the file on disk no longer matches the digest the cloud published`
          + ` (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…). Nothing was launched.`,
      };
    }
  }
  const openError = await shell.openPath(opts.path);
  if (openError) return { ok: false, error: openError };
  setTimeout(() => {
    for (const window of BrowserWindow.getAllWindows()) {
      try { window.close(); } catch { /* ignore */ }
    }
    opts.onQuit();
  }, 1_200);
  return { ok: true };
}
