/**
 * Pull scope+rate config from the qparking SaaS and cache it locally so the
 * exit flow can compute fees even if the WAN is offline.
 *
 * Expected endpoint (qparking backend should expose this):
 *   GET /api/local-server/scopes
 *   Authorization: Bearer <apiKey>
 *   →  { data: ScopeRate[] }
 *
 * If the qparking team hasn't surfaced this endpoint yet, the local server
 * still works — operators just have to fill the scopes table manually via the
 * Scopes page in the UI.
 */
import { getSettings, upsertScope } from './db';
import type { ScopeRate } from '../shared/types';

export interface SyncResult { ok: boolean; fetched: number; error?: string; }

let syncTimer: NodeJS.Timeout | null = null;

export async function syncScopes(): Promise<SyncResult> {
  const s = getSettings();
  if (!s.qparkingBaseUrl || !s.qparkingApiKey) {
    return { ok: false, fetched: 0, error: 'qparking_not_configured' };
  }
  // qparking's API is prefixed /api/v1/. The local-server endpoint lives
  // under that prefix and is bearer-token authed (no sanctum session).
  const url = `${s.qparkingBaseUrl.replace(/\/+$/, '')}/api/v1/local-server/scopes`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${s.qparkingApiKey}` } });
    if (!res.ok) {
      return { ok: false, fetched: 0, error: `http_${res.status}` };
    }
    const body = await res.json() as { data?: any[] };
    const fetchedAt = new Date().toISOString();
    let count = 0;
    for (const row of body.data ?? []) {
      const scope: ScopeRate = {
        scopeId: String(row.scope_id ?? row.scopeId ?? row.id),
        scopeName: String(row.scope_name ?? row.scopeName ?? row.name ?? row.scope_id),
        freeMinutes: Number(row.free_minutes ?? row.freeMinutes ?? 0),
        firstBlockCents: Number(row.first_block_cents ?? row.firstBlockCents ?? 0),
        perBlockCents: Number(row.per_block_cents ?? row.perBlockCents ?? 0),
        blockMinutes: Number(row.block_minutes ?? row.blockMinutes ?? 60),
        dailyCapCents: Number(row.daily_cap_cents ?? row.dailyCapCents ?? 0),
        currency: String(row.currency ?? 'MYR'),
        fetchedAt,
      };
      if (!scope.scopeId) continue;
      upsertScope(scope);
      count++;
    }
    return { ok: true, fetched: count };
  } catch (e: any) {
    return { ok: false, fetched: 0, error: e.message ?? String(e) };
  }
}

/** Background hourly sync. Cheap and self-healing; operators don't have to
 *  remember to refresh after changing a rate on the SaaS. */
export function startBackgroundSync(intervalMs = 60 * 60 * 1000) {
  stopBackgroundSync();
  syncTimer = setInterval(() => { syncScopes().catch(() => null); }, intervalMs);
  // Kick one off at startup, fire-and-forget.
  syncScopes().catch(() => null);
}

export function stopBackgroundSync() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
}

/**
 * Push a rate edit up to the qparking SaaS (PUT /scopes/rate). On success
 * we immediately re-pull the scopes so the cached row reflects whatever
 * the SaaS canonicalised (and the rest of the app sees the new fee math).
 */
export async function pushScopeRate(input: {
  firstBlockCents: number;
  perBlockCents: number;
  blockMinutes: number;
  freeMinutes: number;
  dailyCapCents: number;
}): Promise<SyncResult> {
  const s = getSettings();
  if (!s.qparkingBaseUrl || !s.qparkingApiKey) {
    return { ok: false, fetched: 0, error: 'qparking_not_configured' };
  }
  const url = `${s.qparkingBaseUrl.replace(/\/+$/, '')}/api/v1/local-server/scopes/rate`;
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${s.qparkingApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        first_block_cents: input.firstBlockCents,
        per_block_cents:   input.perBlockCents,
        block_minutes:     input.blockMinutes,
        free_minutes:      input.freeMinutes,
        daily_cap_cents:   input.dailyCapCents,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      let msg = `http_${res.status}`;
      try {
        const body: any = await res.json();
        msg = body?.message || body?.error || msg;
      } catch { /* ignore */ }
      return { ok: false, fetched: 0, error: msg };
    }
    // Re-pull so the local cache reflects whatever SaaS canonicalised.
    return await syncScopes();
  } catch (e: any) {
    return { ok: false, fetched: 0, error: e?.message ?? String(e) };
  }
}
