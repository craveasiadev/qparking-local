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
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

delete process.env.ELECTRON_RUN_AS_NODE; // the whole point — see above
process.env.NODE_ENV = 'development';

// electron's package entry is the path to the binary when loaded from Node.
const require = createRequire(import.meta.url);
const electronPath = require('electron');

const child = spawn(electronPath, ['dist/main/index.js'], { stdio: 'inherit' });
child.on('close', (code) => process.exit(code ?? 0));
