/**
 * 🔴 Phase 19A (19.7) — an organization's security settings and the requests that weaken them: IDENTITY LAYER, owner
 * connection (both tables are owner-only). Reached only from `services/securitySettings.service.ts`, which authorizes
 * (an admin of THIS organization) first. Every write declares its actor (`app.current_user_id`) inside its own
 * transaction, because the database's guards (0167) decide on the person acting, not on a value the caller supplies.
 */
import { ownerDb as db } from "@workspace/db";
import { sql } from "drizzle-orm";

export interface SecuritySettings {
  mfaRequiredForAll: boolean;
  sessionLifetimeHours: number;
  idleTimeoutMinutes: number;
}
/** A missing row: the platform default, which is also the weakest value the platform allows. */
export const SECURITY_DEFAULTS: SecuritySettings = { mfaRequiredForAll: false, sessionLifetimeHours: 12, idleTimeoutMinutes: 480 };
export const SECURITY_BOUNDS = { sessionLifetimeHours: { min: 1, max: 12 }, idleTimeoutMinutes: { min: 15, max: 480 } } as const;

export interface PendingChange {
  id: string;
  requestedBy: { id: number; name: string };
  requestedAt: string;
  before: SecuritySettings;
  after: SecuritySettings;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const actAs = (tx: Tx, userId: number) => tx.execute(sql`SELECT set_config('app.current_user_id', ${String(userId)}, true)`);
const upsert = (tx: Tx, orgId: string, s: SecuritySettings, userId: number) => tx.execute(sql`
  INSERT INTO org_security_settings (organization_id, mfa_required_for_all, session_lifetime_hours, idle_timeout_minutes, updated_by)
  VALUES (${orgId}::uuid, ${s.mfaRequiredForAll}, ${s.sessionLifetimeHours}, ${s.idleTimeoutMinutes}, ${userId})
  ON CONFLICT (organization_id) DO UPDATE SET mfa_required_for_all = EXCLUDED.mfa_required_for_all,
    session_lifetime_hours = EXCLUDED.session_lifetime_hours, idle_timeout_minutes = EXCLUDED.idle_timeout_minutes,
    updated_at = now(), updated_by = EXCLUDED.updated_by`);

export const securitySettingsRepository = {
  async get(orgId: string): Promise<SecuritySettings> {
    const row = (await db.execute(sql`SELECT mfa_required_for_all AS "mfaRequiredForAll", session_lifetime_hours AS "sessionLifetimeHours",
      idle_timeout_minutes AS "idleTimeoutMinutes" FROM org_security_settings WHERE organization_id = ${orgId}::uuid`)).rows[0] as unknown as SecuritySettings | undefined;
    return row ?? { ...SECURITY_DEFAULTS };
  },

  async pending(orgId: string): Promise<PendingChange | null> {
    const r = (await db.execute(sql`SELECT c.id, c.requested_by, u.name, c.requested_at, c.mfa_before, c.mfa_after, c.lifetime_before, c.lifetime_after, c.idle_before, c.idle_after
      FROM org_security_setting_changes c JOIN users u ON u.id = c.requested_by
      WHERE c.organization_id = ${orgId}::uuid AND c.status = 'pending'`)).rows[0] as any;
    if (!r) return null;
    return {
      id: r.id, requestedBy: { id: Number(r.requested_by), name: r.name }, requestedAt: new Date(r.requested_at).toISOString(),
      before: { mfaRequiredForAll: r.mfa_before, sessionLifetimeHours: r.lifetime_before, idleTimeoutMinutes: r.idle_before },
      after: { mfaRequiredForAll: r.mfa_after, sessionLifetimeHours: r.lifetime_after, idleTimeoutMinutes: r.idle_after },
    };
  },

  /** Write the settings as the person acting. The database refuses a weakening that needs a second admin (0167). */
  async apply(orgId: string, after: SecuritySettings, userId: number): Promise<void> {
    await db.transaction(async (tx) => {
      await actAs(tx, userId);
      await upsert(tx, orgId, after, userId);
    });
  },

  /** Record a weakening change as a request. The unique index allows one pending request per organization. */
  async request(orgId: string, before: SecuritySettings, after: SecuritySettings, userId: number): Promise<void> {
    await db.execute(sql`INSERT INTO org_security_setting_changes
      (organization_id, mfa_before, mfa_after, lifetime_before, lifetime_after, idle_before, idle_after, requested_by)
      VALUES (${orgId}::uuid, ${before.mfaRequiredForAll}, ${after.mfaRequiredForAll}, ${before.sessionLifetimeHours}, ${after.sessionLifetimeHours},
              ${before.idleTimeoutMinutes}, ${after.idleTimeoutMinutes}, ${userId})`);
  },

  /**
   * Decide a request — and, on approval, write the settings IN THE SAME TRANSACTION, which is what the database's dual
   * control checks (an approval made at this transaction's instant by the person acting). Returns false when the
   * request is not this organization's pending one.
   */
  async decide(orgId: string, changeId: string, decision: "approved" | "rejected", after: SecuritySettings | null, userId: number): Promise<boolean> {
    return db.transaction(async (tx) => {
      await actAs(tx, userId);
      const res = await tx.execute(sql`UPDATE org_security_setting_changes SET status = ${decision}, decided_by = ${userId}, decided_at = now()
        WHERE id = ${changeId}::uuid AND organization_id = ${orgId}::uuid AND status = 'pending'`);
      if ((res.rowCount ?? 0) !== 1) return false;
      if (decision === "approved" && after) await upsert(tx, orgId, after, userId);
      return true;
    });
  },

  /** Does any organization this account is an active member of require two-step verification for everyone? */
  async mfaRequiredForAllOf(userId: number): Promise<boolean> {
    const res = await db.execute(sql`SELECT 1 FROM organization_memberships m JOIN org_security_settings s ON s.organization_id = m.organization_id
      WHERE m.user_id = ${userId} AND m.status = 'active' AND s.mfa_required_for_all LIMIT 1`);
    return (res.rowCount ?? 0) > 0;
  },
};
