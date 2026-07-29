/**
 * Shared launcher for the tools/ check scripts.
 *
 * Why they can't just run under plain Node: they exercise the compiled main
 * process, which pulls in better-sqlite3 — a native module built for the electron
 * ABI (see the `rebuild` npm script). Loading it in Node fails outright.
 *
 * Two environment quirks handled here, both already known in this repo:
 *   - ELECTRON_RUN_AS_NODE=1 is exported by VS Code and some terminals. When set,
 *     electron boots as plain Node and require('electron').app is undefined. It
 *     must be DELETED, not blanked — see scripts/dev-electron.mjs for the same
 *     workaround on the dev path.
 *   - electron is a Windows GUI-subsystem binary, so its stdout is unreliable when
 *     spawned. Check scripts report through a JSON result file instead, and the
 *     per-harness run.mjs (plain Node) does the printing.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);

/** Absolute path to app/ — this file lives in app/tools/. */
export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Run `scriptPath` (relative to app/) in an electron main process.
 * Resolves with its exit code; never rejects.
 */
export function runUnderElectron(scriptPath, args = []) {
  delete process.env.ELECTRON_RUN_AS_NODE; // the whole point — see above
  const electronPath = require('electron');
  return new Promise((resolve) => {
    const child = spawn(electronPath, [scriptPath, ...args], {
      cwd: APP_DIR,
      stdio: 'ignore',
    });
    child.on('close', (code) => resolve(code ?? 0));
  });
}
