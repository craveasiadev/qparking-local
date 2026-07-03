#!/usr/bin/env node
/**
 * Publish the latest built qparking-local exe to the qparking cloud so
 * running on-prem installs can pull it via `GET /api/v1/local-server/latest-built`.
 *
 * What this does:
 *   1. Reads the current version from package.json.
 *   2. Verifies release/QParkingLocal-<v>-portable.exe + -x64.exe exist
 *      (run `npm run package` first if they don't).
 *   3. Copies both files into qparking/backend/storage/app/public/qparking-local-builds/.
 *   4. Computes sha256 + file size for each.
 *   5. Writes latest.json manifest pointing at the new files.
 *
 * Usage:
 *   npm run ship       — package + publish in one shot (recommended)
 *   npm run publish:cloud  — publish whatever's already in release/
 *
 * The cloud storage location is relative to this script; if the qparking
 * checkout moves you only need to update CLOUD_BUILD_DIR below.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync, copyFileSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(__dirname, '..');
const RELEASE_DIR = join(APP_DIR, 'release');

// qparking cloud build storage. Sibling to the qparking-local checkout —
// adjust if your tree is laid out differently.
const CLOUD_BUILD_DIR = resolve(APP_DIR, '..', '..', 'qparking', 'backend', 'storage', 'app', 'public', 'qparking-local-builds');

async function sha256(filePath) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

/**
 * Delete every QParkingLocal-*.exe (and matching .blockmap) in `dir` whose
 * filename doesn't reference the current version. Keeps the release + cloud
 * folders clean — after every ship there's exactly ONE version's artifacts.
 * Non-matching filenames (e.g. `latest.json`, `builder-debug.yml`, subdirs)
 * are left alone.
 */
function purgeOldBuilds(dir, currentVersion) {
  if (!existsSync(dir)) return { deleted: [], skipped: [] };
  const deleted = [];
  const skipped = [];
  for (const name of readdirSync(dir)) {
    // Match QParkingLocal-<version>-{portable,x64}.exe(.blockmap)?
    const m = name.match(/^QParkingLocal-([\d.]+)-(?:portable|x64)\.exe(?:\.blockmap)?$/);
    if (!m) { skipped.push(name); continue; }
    if (m[1] === currentVersion) { skipped.push(name); continue; }
    try {
      unlinkSync(join(dir, name));
      deleted.push(name);
    } catch (e) {
      console.error(`  ✗ could not delete ${name}: ${e.message}`);
    }
  }
  return { deleted, skipped };
}

async function main() {
  const pkg = JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8'));
  const version = pkg.version;
  if (!version) fail('package.json has no version field');

  const portableName = `QParkingLocal-${version}-portable.exe`;
  const installerName = `QParkingLocal-${version}-x64.exe`;
  const portableSrc = join(RELEASE_DIR, portableName);
  const installerSrc = join(RELEASE_DIR, installerName);

  if (!existsSync(portableSrc)) {
    fail(`Missing ${portableName} in release/. Run \`npm run package\` first.`);
  }
  if (!existsSync(installerSrc)) {
    fail(`Missing ${installerName} in release/. Run \`npm run package\` first.`);
  }

  if (!existsSync(CLOUD_BUILD_DIR)) {
    console.log(`Creating ${CLOUD_BUILD_DIR}`);
    mkdirSync(CLOUD_BUILD_DIR, { recursive: true });
  }

  console.log(`\nPublishing qparking-local v${version}`);

  // Purge stale versioned artifacts from BOTH the local release/ folder AND
  // the cloud storage folder. Keeps disk usage flat over time and prevents
  // confusion (a running old portable can pin release/ files open; if that
  // happens the unlink fails and we surface it to the operator).
  const localPurge = purgeOldBuilds(RELEASE_DIR, version);
  if (localPurge.deleted.length > 0) {
    console.log(`  🗑  release/ — removed ${localPurge.deleted.length} stale file(s): ${localPurge.deleted.join(', ')}`);
  }
  const cloudPurge = purgeOldBuilds(CLOUD_BUILD_DIR, version);
  if (cloudPurge.deleted.length > 0) {
    console.log(`  🗑  cloud    — removed ${cloudPurge.deleted.length} stale file(s): ${cloudPurge.deleted.join(', ')}`);
  }

  console.log(`  → ${CLOUD_BUILD_DIR}`);

  // Copy + hash both variants.
  const variants = [
    { key: 'portable', name: portableName, src: portableSrc },
    { key: 'installer', name: installerName, src: installerSrc },
  ];
  const manifest = {
    version,
    released_at: new Date().toISOString(),
    notes: pkg.releaseNotes ?? `Build v${version}`,
  };

  for (const v of variants) {
    const dst = join(CLOUD_BUILD_DIR, v.name);
    copyFileSync(v.src, dst);
    const size = statSync(dst).size;
    const digest = await sha256(dst);
    manifest[v.key] = { filename: v.name, size, sha256: digest };
    const mb = (size / 1024 / 1024).toFixed(1);
    console.log(`  ✓ ${v.key.padEnd(9)} ${v.name}  ${mb} MB  sha256=${digest.slice(0, 12)}…`);
  }

  // Optional blockmap companion for the NSIS installer (electron-builder
  // emits it for delta updates). Not required by the latest-built endpoint
  // but harmless to copy.
  const blockmapSrc = join(RELEASE_DIR, `${installerName}.blockmap`);
  if (existsSync(blockmapSrc)) {
    copyFileSync(blockmapSrc, join(CLOUD_BUILD_DIR, `${installerName}.blockmap`));
    console.log(`  ✓ blockmap  ${installerName}.blockmap`);
  }

  const manifestPath = join(CLOUD_BUILD_DIR, 'latest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`  ✓ manifest  latest.json`);
  console.log(`\nDone. On-prem apps that hit \`/api/v1/local-server/latest-built\` will now see v${version}.\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
