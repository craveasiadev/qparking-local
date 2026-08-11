/**
 * Dev launcher for the Electron main process.
 *
 * Why this exists: VS Code (and any Electron-based host, incl. some terminals)
 * exports ELECTRON_RUN_AS_NODE=1 into the environment. Child processes inherit
 * it, and when set, Electron boots as plain Node.js instead of as a desktop
 * app — so `require('electron').app` is undefined and index.ts crashes on the
 * first line that touches `app`. `cross-env FOO=` can't help because Electron
 * checks whether the var EXISTS, not its value; it must be deleted outright.
 *
 * So we delete it here, set NODE_ENV, then spawn the real Electron binary.
 *
 * It also WATCHES src/main + src/shared and recompiles/relaunches on change —
 * Vite only hot-reloads the renderer, and a stale main process is invisible
 * (see restart()).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { watch } from 'node:fs';
import path from 'node:path';

delete process.env.ELECTRON_RUN_AS_NODE; // the whole point — see above
process.env.NODE_ENV = 'development';

// electron's package entry is the path to the binary when loaded from Node.
const require = createRequire(import.meta.url);
const electronPath = require('electron');

/**
 * Recompile + relaunch on any src/main change.
 *
 * Vite hot-reloads the RENDERER, but `npm run dev` compiled the main process once
 * at startup and never again — so a change to db.ts or cloud-sync.ts silently did
 * nothing for the rest of the session. That cost a real debugging round trip on
 * 2026-08-11: a new sqlite migration never ran and a new payload field was never
 * mapped, while the new UI rendered on top and looked simply broken.
 */
const MAIN_SRC = path.resolve('src/main');
const SHARED_SRC = path.resolve('src/shared');

let child = null;
let restarting = false;

function start() {
  child = spawn(electronPath, ['dist/main/index.js'], { stdio: 'inherit' });
  child.on('close', (code) => {
    // A restart kills the child on purpose; only a real exit ends the run.
    if (!restarting) process.exit(code ?? 0);
  });
}

function restart() {
  const build = spawnSync(process.execPath,
    [require.resolve('typescript/bin/tsc'), '-p', 'src/main/tsconfig.json'],
    { stdio: 'inherit' });
  if (build.status !== 0) {
    console.error('[dev] main process did not compile — keeping the running one');
    return;
  }
  console.log('[dev] main process changed — relaunching');
  restarting = true;
  child?.kill();
  child?.once('close', () => { restarting = false; start(); });
}

let pending = null;
function scheduleRestart() {
  clearTimeout(pending);
  pending = setTimeout(restart, 250); // coalesce editor save bursts
}

for (const dir of [MAIN_SRC, SHARED_SRC]) {
  watch(dir, { recursive: true }, (_event, file) => {
    if (file && /\.tsx?$/.test(file)) scheduleRestart();
  });
}

start();
