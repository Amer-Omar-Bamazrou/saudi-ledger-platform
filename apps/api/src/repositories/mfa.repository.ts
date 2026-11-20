/**
 * 🔴 Phase 19A (19.1–19.3) — the second factor's rows: IDENTITY LAYER, owner connection (both tables are owner-only).
 * Reached only from `services/mfa.service.ts`, which authorizes every act first.
 */
import { ownerDb as db, userMfaFactorsTable, userMfaRecoveryCodesTable, type UserMfaFactor } from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";

export const mfaRepository = {
  async factorOf(userId: number): Promise<UserMfaFactor | undefined> {
    const [row] = await db.select().from(userMfaFactorsTable).where(eq(userMfaFactorsTable.userId, userId)).limit(1);
    return row;
  },

  async hasActiveFactor(userId: number): Promise<boolean> {
    const [row] = await db.select({ id: userMfaFactorsTable.id }).from(userMfaFactorsTable)
      .where(and(eq(userMfaFactorsTable.userId, userId), eq(userMfaFactorsTable.state, "active"))).limit(1);
    return !!row;
  },

  /** A new PENDING factor — replacing a pending one (an abandoned enrolment), never an active one. */
  async putPending(userId: number, sealed: Pick<UserMfaFactor, "kmsProvider" | "kmsKeyId" | "wrappedDataKey" | "encryptedSecret" | "secretIv" | "secretAuthTag">): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.delete(userMfaFactorsTable).where(and(eq(userMfaFactorsTable.userId, userId), eq(userMfaFactorsTable.state, "pending")));
      await tx.insert(userMfaFactorsTable).values({ userId, state: "pending", ...sealed });
    });
  },

  /**
   * 🔴 REPLAY: accept `step` only if it is later than the last step this factor accepted — one statement, so two
   * requests with the same code cannot both win. Returns whether this call took the step.
   */
  async takeStep(userId: number, step: number, activate: boolean): Promise<boolean> {
    const res = await db.execute(activate
      ? sql`UPDATE user_mfa_factors SET last_used_step = ${step}, state = 'active', activated_at = now()
            WHERE user_id = ${userId} AND state = 'pending' AND (last_used_step IS NULL OR last_used_step < ${step})`
      : sql`UPDATE user_mfa_factors SET last_used_step = ${step}
            WHERE user_id = ${userId} AND state = 'active' AND (last_used_step IS NULL OR last_used_step < ${step})`);
    return (res.rowCount ?? 0) === 1;
  },

  async replaceRecoveryCodes(userId: number, hashes: string[]): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.delete(userMfaRecoveryCodesTable).where(eq(userMfaRecoveryCodesTable.userId, userId));
      await tx.insert(userMfaRecoveryCodesTable).values(hashes.map((codeHash) => ({ userId, codeHash })));
    });
  },

  async unusedRecoveryCodes(userId: number): Promise<{ id: string; codeHash: string }[]> {
    return db.select({ id: userMfaRecoveryCodesTable.id, codeHash: userMfaRecoveryCodesTable.codeHash }).from(userMfaRecoveryCodesTable)
      .where(and(eq(userMfaRecoveryCodesTable.userId, userId), isNull(userMfaRecoveryCodesTable.usedAt)));
  },

  /** Consume ONE code: true only for the call that marked it used. */
  async useRecoveryCode(id: string): Promise<boolean> {
    const res = await db.execute(sql`UPDATE user_mfa_recovery_codes SET used_at = now() WHERE id = ${id}::uuid AND used_at IS NULL`);
    return (res.rowCount ?? 0) === 1;
  },

  /** The reset: the factor and every recovery code go. Returns how many unused codes were invalidated. */
  async removeAll(userId: number): Promise<{ hadFactor: boolean; recoveryCodesInvalidated: number }> {
    return db.transaction(async (tx) => {
      const codes = await tx.execute(sql`DELETE FROM user_mfa_recovery_codes WHERE user_id = ${userId} RETURNING used_at`);
      const factor = await tx.execute(sql`DELETE FROM user_mfa_factors WHERE user_id = ${userId}`);
      return { hadFactor: (factor.rowCount ?? 0) > 0, recoveryCodesInvalidated: codes.rows.filter((r: any) => r.used_at == null).length };
    });
  },

  /**
   * When this account's factor was last reset, and by whom — an admin of its organization or the platform (the security
   * trail's own fact), if ever.
   */
  async lastReset(userId: number): Promise<{ at: Date; by: "admin" | "platform" } | null> {
    const res = await db.execute(sql`SELECT created_at AS at, metadata ->> 'by' AS by FROM security_audit_logs
      WHERE action = 'mfa.reset' AND target_user_id = ${userId} ORDER BY created_at DESC, id DESC LIMIT 1`);
    const row = res.rows[0] as { at?: string | Date; by?: string | null } | undefined;
    return row?.at ? { at: new Date(row.at), by: row.by === "admin" ? "admin" : "platform" } : null;
  },

  /** Is this account an ACTIVE admin of any organization (whatever its verification state)? */
  async isAdminAnywhere(userId: number): Promise<boolean> {
    const res = await db.execute(sql`SELECT 1 FROM organization_memberships WHERE user_id = ${userId} AND role = 'admin' AND status = 'active' LIMIT 1`);
    return (res.rowCount ?? 0) > 0;
  },
};
