/**
 * VZ camera discovery.  npm run find:cameras
 *
 * WHY THIS EXISTS
 * A camera you can't ping is usually not broken — it's on a different subnet.
 * VZ cameras ship on a factory IP (commonly 192.168.1.100) and a PC on
 * 192.168.100.x simply has no route to it, even though both are plugged into
 * the same switch and are perfectly happy at layer 2.
 *
 * VZLPRClient_StartFindDeviceEx broadcasts on the LAN segment rather than
 * routing, so the camera answers regardless of whose subnet it's on — and the
 * Ex variant reports the device's netmask and gateway too, which is exactly what
 * you need to decide how to reach it.
 *
 * Read-only: this only listens for replies to a discovery broadcast. It changes
 * nothing on the camera.
 */
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SEARCH_MS = Number(process.argv[3]) || 6000;
const out = { ok: false, devices: [], interfaces: [], configured: [], error: null };

function sdkDir() {
  const candidates = [
    path.join(process.cwd(), 'native', 'vzsdk'),
    path.join(__dirname, '..', '..', 'native', 'vzsdk'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'VzLPRSDK.dll'))) return dir;
  }
  return candidates[0];
}

(async () => {
  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-find-'));
    app.setPath('userData', tmpDir);

    // Local interfaces, so the report can point out a subnet mismatch itself.
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family === 'IPv4' && !a.internal) {
          out.interfaces.push({ name, address: a.address, netmask: a.netmask });
        }
      }
    }

    // What the app currently thinks the cameras are, for comparison. Uses the
    // REAL userData path, not the temp one set above.
    try {
      const realUserData = path.join(process.env.APPDATA || '', 'qparking-local-dev');
      const dbFile = path.join(realUserData, 'qparking-local.db');
      if (fs.existsSync(dbFile)) {
        const Database = require('better-sqlite3');
        const db = new Database(dbFile, { readonly: true });
        out.configured = db.prepare('SELECT id, name, host, device_port, device_user FROM cameras ORDER BY id').all();
        db.close();
      }
    } catch (e) {
      out.configuredError = e.message;
    }

    const koffi = require('koffi');
    const dir = sdkDir();
    process.env.PATH = dir + path.delimiter + (process.env.PATH || '');
    const lib = koffi.load(path.join(dir, 'VzLPRSDK.dll'));

    const Setup = lib.func('int VzLPRClient_Setup()');
    // The Ex callback adds netmask + gateway over the plain one — the two fields
    // that actually explain an unreachable camera.
    const FindCbEx = koffi.proto(
      'void FindCbEx(const char *name, const char *ip, uint16 port1, uint16 type, uint32 sl, uint32 sh, const char *netmask, const char *gateway, void *user)',
    );
    const StartFindDeviceEx = lib.func('int VZLPRClient_StartFindDeviceEx(FindCbEx *, void *)');
    const StopFindDevice = lib.func('void VZLPRClient_StopFindDevice()');

    Setup();

    const seen = new Set();
    const cb = koffi.register((name, ip, port1, type, sl, sh, netmask, gateway) => {
      const key = `${ip}|${sl}|${sh}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.devices.push({
        name: name || '(unnamed)',
        ip,
        port: port1,
        type,
        serial: `${sh}-${sl}`,
        netmask: netmask || null,
        gateway: gateway || null,
      });
    }, koffi.pointer(FindCbEx));

    const rc = StartFindDeviceEx(cb, null);
    out.startResult = rc;
    await new Promise((r) => setTimeout(r, SEARCH_MS));
    try { StopFindDevice(); } catch { /* ignore */ }
    try { koffi.unregister(cb); } catch { /* ignore */ }

    out.ok = true;
  } catch (e) {
    out.error = e && e.stack ? e.stack : String(e);
  }
})().finally(() => {
  fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2));
  app.exit(0);
});
