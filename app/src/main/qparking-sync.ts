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
import { getSettings, upsertScope, replaceActivePassesForScope, listScopes } from './db';
import type { ScopeRate, TariffRule, ActivePass } from '../shared/types';

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
      const scopeId = String(row.scope_id ?? row.scopeId ?? row.id ?? '');
      if (!scopeId) continue;
      const rules: TariffRule[] = Array.isArray(row.rules)
        ? row.rules.map((r: any) => ({
            ruleId: String(r.rule_id ?? r.ruleId ?? ''),
            name: String(r.name ?? ''),
            priority: Number(r.priority ?? 0),
            vehicleType: r.vehicle_type ?? r.vehicleType ?? null,
            daysOfWeek: Array.isArray(r.days_of_week ?? r.daysOfWeek)
              ? (r.days_of_week ?? r.daysOfWeek).map((n: any) => Number(n))
              : null,
            timeFrom: String(r.time_from ?? r.timeFrom ?? '00:00:00'),
            timeTo: String(r.time_to ?? r.timeTo ?? '23:59:59'),
            validFrom: r.valid_from ?? r.validFrom ?? null,
            validTo: r.valid_to ?? r.validTo ?? null,
            ruleType: (r.rule_type ?? r.ruleType ?? 'block_hourly') as 'flat_rate' | 'block_hourly',
            flatAmountCents: Number(r.flat_amount_cents ?? 0),
            firstBlockAmountCents: Number(r.first_block_amount_cents ?? 0),
            firstBlockMinutes: Number(r.first_block_minutes ?? 60),
            subsequentBlockAmountCents: Number(r.subsequent_block_amount_cents ?? 0),
            subsequentBlockMinutes: Number(r.subsequent_block_minutes ?? 60),
            dailyCapCents: Number(r.daily_cap_cents ?? 0),
            isOvernight: !!r.is_overnight,
          })).filter((r: TariffRule) => !!r.ruleId)
        : [];

      const scope: ScopeRate = {
        scopeId,
        scopeName: String(row.scope_name ?? row.scopeName ?? row.name ?? scopeId),
        freeMinutes: Number(row.grace_minutes ?? row.free_minutes ?? row.freeMinutes ?? 0),
        firstBlockCents: Number(row.first_block_cents ?? row.firstBlockCents ?? 0),
        perBlockCents: Number(row.per_block_cents ?? row.perBlockCents ?? 0),
        blockMinutes: Number(row.block_minutes ?? row.blockMinutes ?? 60),
        dailyCapCents: Number(row.daily_cap_cents ?? row.dailyCapCents ?? 0),
        currency: String(row.currency ?? 'MYR'),
        fetchedAt,
        rules,
        policyId: row.policy_id ?? null,
        policyName: row.policy_name ?? null,
        graceExceededBehavior: row.grace_exceeded_behavior ?? null,
        cutoffEnabled: !!row.cutoff_enabled,
        cutoffTime: row.cutoff_time ?? null,
        cutoffBehavior: row.cutoff_behavior ?? null,
      };
      upsertScope(scope);
      count++;
    }
    return { ok: true, fetched: count };
  } catch (e: any) {
    return { ok: false, fetched: 0, error: e.message ?? String(e) };
  }
}

/**
 * Pull the active pass roster for each cached scope. The gate uses this
 * to skip charging plates that have a paid / VIP / corporate / staff pass.
 * Empty roster is a legitimate result (no active passes), not a sync failure.
 */
export async function syncPasses(): Promise<SyncResult> {
  const s = getSettings();
  if (!s.qparkingBaseUrl || !s.qparkingApiKey) {
    return { ok: false, fetched: 0, error: 'qparking_not_configured' };
  }
  const url = `${s.qparkingBaseUrl.replace(/\/+$/, '')}/api/v1/local-server/passes`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${s.qparkingApiKey}` } });
    if (!res.ok) {
      // 404 means older qparking SaaS without the endpoint — gracefully no-op.
      if (res.status === 404) return { ok: true, fetched: 0 };
      return { ok: false, fetched: 0, error: `http_${res.status}` };
    }
    const body = await res.json() as { data?: any[] };
    const rows = body.data ?? [];

    // Group passes by scope so we can do a single replace-all per scope.
    const byScope = new Map<string, ActivePass[]>();
    for (const r of rows) {
      const scopeId = String(r.site_id ?? r.scope_id ?? '');
      const plate = String(r.plate_number ?? '');
      if (!scopeId || !plate) continue;
      const pass: ActivePass = {
        passId: String(r.pass_id ?? r.id ?? ''),
        scopeId,
        plateNumber: plate,
        passType: String(r.pass_type ?? 'monthly'),
        status: String(r.status ?? 'active'),
        startDate: r.start_date ?? null,
        endDate: r.end_date ?? null,
        isFree: !!(r.is_free ?? false),
        spaceNumber: r.space_number ?? null,
        fetchedAt: new Date().toISOString(),
      };
      if (!byScope.has(scopeId)) byScope.set(scopeId, []);
      byScope.get(scopeId)!.push(pass);
    }

    // Refresh every scope we know about — including scopes that returned
    // zero passes (so a revoked pass actually disappears from local cache).
    for (const scope of listScopes()) {
      replaceActivePassesForScope(scope.scopeId, byScope.get(scope.scopeId) ?? []);
    }
    return { ok: true, fetched: rows.length };
  } catch (e: any) {
    return { ok: false, fetched: 0, error: e?.message ?? String(e) };
  }
}

/** Background sync. Default cadence: every 60 seconds — operators expect a
 *  rate edit in qparking SaaS to apply at the gate within ~1 minute, not the
 *  ~60 minutes the legacy interval enforced. Cheap (two GETs), self-healing,
 *  no operator action needed.
 */
export function startBackgroundSync(intervalMs = 60_000) {
  stopBackgroundSync();
  syncTimer = setInterval(() => {
    syncScopes().catch(() => null);
    syncPasses().catch(() => null);
  }, intervalMs);
  // Kick one off at startup, fire-and-forget.
  syncScopes().catch(() => null);
  syncPasses().catch(() => null);
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
