/**
 * Operators repository (M11.3) — platform-operator identity lookups.
 *
 * IMPORTANT: `platform_operators` is identity/infrastructure data on the BASE
 * (owner) connection, read BEFORE `resolveTenant`. It is NOT RLS-scoped. This
 * repository only answers "is this user an operator?"; granting operator status
 * happens exclusively in the seed/CLI, never here.
 */
// 🔴 The OWNER connection, named deliberately rather than inherited.
// `platform_operators` is an owner-only table, and operator status is resolved before tenant scope.
// The `db` proxy now REFUSES a query outside a tenant transaction instead of
// silently falling back to this connection.
import { ownerDb as db, platformOperatorsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export const operatorsRepository = {
  async isOperator(userId: number): Promise<boolean> {
    const [row] = await db
      .select({ id: platformOperatorsTable.id })
      .from(platformOperatorsTable)
      .where(eq(platformOperatorsTable.userId, userId))
      .limit(1);
    return !!row;
  },
};
