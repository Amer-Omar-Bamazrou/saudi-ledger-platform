/**
 * Signup repository (M11.5) — public self-service tenant creation.
 *
 * Identity/infrastructure layer, BASE (owner) connection, before `resolveTenant`
 * (the signing-up user has no session and no tenant yet). The whole tenant is
 * created in ONE transaction so a half-provisioned account can never exist: an
 * organization without an admin, or a user who can log in but belongs nowhere.
 */
import {
  db,
  organizationsTable,
  companiesTable,
  usersTable,
  organizationMembershipsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

export interface CreateTenantInput {
  email: string;
  name: string;
  passwordHash: string;
  organizationName: string;
  companyName: string;
  crNumber: string | null;
  vatNumber: string | null;
}

export interface CreatedTenant {
  userId: number;
  organizationId: string;
  companyId: string;
}

/** `"Acme Trading Co."` → `"acme-trading-co"` (empty → "org"). */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "org"
  );
}

export const signupRepository = {
  async emailExists(email: string): Promise<boolean> {
    const [row] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, email))
      .limit(1);
    return !!row;
  },

  /**
   * Create organization (pending_review) + company + admin user + active admin
   * membership atomically.
   */
  async createTenant(input: CreateTenantInput): Promise<CreatedTenant> {
    return db.transaction(async (tx) => {
      // Unique slug: base, then -2, -3, … (bounded; falls back to a random suffix).
      const base = slugify(input.organizationName);
      let slug = base;
      for (let i = 2; i <= 50; i++) {
        const [clash] = await tx
          .select({ id: organizationsTable.id })
          .from(organizationsTable)
          .where(eq(organizationsTable.slug, slug))
          .limit(1);
        if (!clash) break;
        slug = `${base}-${i}`;
        if (i === 50) slug = `${base}-${Date.now().toString(36)}`;
      }

      const [org] = await tx
        .insert(organizationsTable)
        .values({
          name: input.organizationName,
          slug,
          // Explicit, though it is also the column default: a self-service signup
          // starts locked out pending operator review (M11.2 gate).
          verificationStatus: "pending_review",
          verificationSubmittedAt: new Date(),
        })
        .returning({ id: organizationsTable.id });

      const [company] = await tx
        .insert(companiesTable)
        .values({
          organizationId: org.id,
          name: input.companyName,
          crNumber: input.crNumber,
          vatNumber: input.vatNumber,
        })
        .returning({ id: companiesTable.id });

      const [user] = await tx
        .insert(usersTable)
        .values({
          email: input.email,
          name: input.name,
          passwordHash: input.passwordHash,
          role: "admin",
          isActive: true,
        })
        .returning({ id: usersTable.id });

      await tx.insert(organizationMembershipsTable).values({
        userId: user.id,
        organizationId: org.id,
        role: "admin",
        status: "active",
      });

      return { userId: user.id, organizationId: org.id, companyId: company.id };
    });
  },
};
