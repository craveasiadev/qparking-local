/**
 * Renderer-wide date/time formatting.
 *
 * Project convention: timestamps are STORED as UTC and always DISPLAYED in
 * GMT+8 (Asia/Kuala_Lumpur, no DST), independent of the operator PC's clock.
 * This mirrors the qparking cloud frontend's `APP_TZ` constant
 * (frontend/src/lib/normalizers.ts) so both apps show identical times.
 *
 * The company timezone in the cloud's system-settings is NOT used here on
 * purpose: the cloud frontend hardcodes KL too, the value isn't synced to this
 * box, and the fee calculator is KL-pinned for parity (see main/tz.ts). If true
 * per-company timezone support is ever added, change APP_TZ here AND in the
 * cloud frontend together, and re-validate fee-math parity.
 */
export const APP_TZ = 'Asia/Kuala_Lumpur';

/**
 * Normalise a stored timestamp to a Date. Handles both storage shapes:
 *   - proper ISO with a zone (…Z / ±hh:mm) — used as-is
 *   - a datetime WITHOUT a zone (SQLite CURRENT_TIMESTAMP "YYYY-MM-DD HH:MM:SS",
 *     or a bare "…THH:MM:SS") — interpreted as UTC per the storage convention,
 *     so the machine's own timezone can't shift it.
 * Returns null for empty / unparseable input.
 */
function toDate(ts?: string | null): Date | null {
  if (!ts) return null;
  let s = ts.trim();
  const hasZone = /[zZ]$|[+-]\d\d:?\d\d$/.test(s);
  if (!hasZone) {
    s = s.replace(' ', 'T');
    if (s.includes('T')) s += 'Z';
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Date + time, 24h — e.g. "23 Jul 2026, 15:04". */
export function fmtDateTime(ts?: string | null): string {
  const d = toDate(ts);
  if (!d) return '—';
  return d.toLocaleString('en-MY', {
    timeZone: APP_TZ,
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/** Date + time + seconds — for logs / live feeds where seconds matter. */
export function fmtDateTimeSeconds(ts?: string | null): string {
  const d = toDate(ts);
  if (!d) return '—';
  return d.toLocaleString('en-MY', {
    timeZone: APP_TZ,
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

/** Date only — e.g. "23 Jul 2026". */
export function fmtDate(ts?: string | null): string {
  const d = toDate(ts);
  if (!d) return '—';
  return d.toLocaleDateString('en-MY', { timeZone: APP_TZ, year: 'numeric', month: 'short', day: '2-digit' });
}

/** Time only, 24h — e.g. "15:04". */
export function fmtTime(ts?: string | null): string {
  const d = toDate(ts);
  if (!d) return '—';
  return d.toLocaleTimeString('en-MY', { timeZone: APP_TZ, hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Time with seconds, 24h — e.g. "15:04:09". */
export function fmtTimeSeconds(ts?: string | null): string {
  const d = toDate(ts);
  if (!d) return '—';
  return d.toLocaleTimeString('en-MY', { timeZone: APP_TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

/** A given instant's calendar date in APP_TZ as "YYYY-MM-DD" (en-CA → ISO order). */
export function dateInAppTz(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: APP_TZ });
}

/**
 * Today's calendar date in APP_TZ as "YYYY-MM-DD". Use for day-boundary windows
 * (entries today, revenue today, expiring passes) instead of
 * `new Date().toISOString().slice(0, 10)`, which uses the UTC calendar day and
 * is wrong for the first 8 hours of the GMT+8 day.
 */
export function todayInAppTz(): string {
  return dateInAppTz(new Date());
}
