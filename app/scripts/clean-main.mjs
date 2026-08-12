/**
 * Wipe the main-process build output before tsc runs.
 *
 * tsc only ever ADDS files — it never removes the .js/.js.map left behind by a
 * module that has since been deleted or moved. Those orphans then get swept
 * into the asar by electron-builder's recursive `dist` filter, so a shipped
 * build carried compiled copies of services retired months ago (ecpi-terminal,
 * face-gate, qparking-sync, camera-whitelist, …) alongside the live ones.
 *
 * Only dist/main + dist/shared are cleared — dist/renderer belongs to Vite,
 * which already empties its own outDir (see vite.config.ts emptyOutDir).
 */
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const dir of ['main', 'shared']) {
  rmSync(path.join(appRoot, 'dist', dir), { recursive: true, force: true });
}
