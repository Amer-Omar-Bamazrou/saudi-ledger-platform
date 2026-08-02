import { eq, and } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { db, pool } from "./index";
import {
  organizationsTable,
  companiesTable,
  usersTable,
  organizationMembershipsTable,
} from "./schema";
import { seedPermissions } from "./permissions";

/**
 * Idempotent seed for the bootstrap tenant.
 *
 * Creates a single "Default Organization" and a "Default Company" under it.
 * Running this multiple times never creates duplicates — records are looked up
 * by their stable natural keys (org slug, and company name within the org)
 * before any insert. No UUIDs are hardcoded; the database generates them.
 *
 * This is the same tenant the M3 backfill migration assigns all pre-tenancy
 * rows to, so the seed and the migration agree on the default tenant by slug.
 */

export const DEFAULT_ORG_SLUG = "default";
export const DEFAULT_ORG_NAME = "Default Organization";
export const DEFAULT_COMPANY_NAME = "Default Company";

export interface SeededTenant {
  organizationId: string;
  companyId: string;
  created: { organization: boolean; company: boolean };
}

export async function seedDefaultTenant(): Promise<SeededTenant> {
  return db.transaction(async (tx) => {
    // --- Organization (unique by slug) ---
    let created = { organization: false, company: false };

    let [org] = await tx
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.slug, DEFAULT_ORG_SLUG))
      .limit(1);

    if (!org) {
      // The default/bootstrap tenant is trusted — create it already `approved`
      // (the column default is `pending_review` for real self-service signups).
      [org] = await tx
        .insert(organizationsTable)
        .values({ name: DEFAULT_ORG_NAME, slug: DEFAULT_ORG_SLUG, verificationStatus: "approved" })
        .returning();
      created.organization = true;
    } else if (org.verificationStatus !== "approved") {
      // Heal a default org created before this column existed / left unapproved.
      [org] = await tx
        .update(organizationsTable)
        .set({ verificationStatus: "approved" })
        .where(eq(organizationsTable.id, org.id))
        .returning();
    }

    // --- Company (unique by name within the organization) ---
    let [company] = await tx
      .select()
      .from(companiesTable)
      .where(
        and(
          eq(companiesTable.organizationId, org.id),
          eq(companiesTable.name, DEFAULT_COMPANY_NAME),
        ),
      )
      .limit(1);

    if (!company) {
      [company] = await tx
        .insert(companiesTable)
        .values({ organizationId: org.id, name: DEFAULT_COMPANY_NAME })
        .returning();
      created.company = true;
    }

    return { organizationId: org.id, companyId: company.id, created };
  });
}

// bcrypt cost factor — must match the API (apps/api/src/routes/auth.ts SALT_ROUNDS).
const SALT_ROUNDS = 12;

export interface SeededAdmin {
  /** True when a new admin user row was inserted (false if it already existed). */
  created: boolean;
  /** True when an admin membership row was inserted this run. */
  membershipCreated?: boolean;
  /** Set when seeding was intentionally skipped (missing/invalid config). */
  skipped?: string;
  email?: string;
}

/**
 * Idempotently provision the initial admin user AND its membership in the
 * bootstrap organization.
 *
 * This replaces the old unauthenticated "first user registers freely" HTTP
 * bootstrap (a race-to-admin vulnerability). The initial admin is now created
 * out-of-band from these env vars:
 *
 *   SEED_ADMIN_EMAIL     (required to seed)
 *   SEED_ADMIN_PASSWORD  (required to seed; min 8 chars)
 *   SEED_ADMIN_NAME      (optional; defaults to "Administrator")
 *
 * A user row alone is NOT a usable admin: `resolveTenant` 403s any user with no
 * active `organization_memberships` row, so a user without a membership can log
 * in but cannot reach a single business route. This function therefore also
 * ensures an **active admin membership** linking the user to `organizationId`
 * (the default org created by {@link seedDefaultTenant}), so a fresh
 * migrate + seed produces a fully working admin.
 *
 * Both writes are idempotent:
 *   - if a user with that email already exists it is left untouched (the
 *     password is never re-hashed or overwritten), but its membership is still
 *     ensured — this backfills admins seeded before this fix;
 *   - the membership insert is a no-op on the unique `(user_id, organization_id)`
 *     constraint, so re-running seed never creates duplicates.
 *
 * If the credentials are absent the step is skipped (so the tenant seed can run
 * on its own).
 */
export async function seedAdminUser(organizationId: string): Promise<SeededAdmin> {
  const email = process.env["SEED_ADMIN_EMAIL"]?.trim();
  const password = process.env["SEED_ADMIN_PASSWORD"];
  const name = process.env["SEED_ADMIN_NAME"]?.trim() || "Administrator";

  if (!email || !password) {
    return { created: false, skipped: "SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD not set" };
  }
  if (password.length < 8) {
    return { created: false, skipped: "SEED_ADMIN_PASSWORD must be at least 8 characters" };
  }

  // (1) Ensure the admin user row exists; capture its id either way.
  let created = false;
  let [user] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);

  if (!user) {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    [user] = await db
      .insert(usersTable)
      .values({ email, name, passwordHash, role: "admin", isActive: true })
      .returning({ id: usersTable.id });
    created = true;
  }

  // (2) Ensure an active admin membership in the default org. Idempotent via the
  //     unique (user_id, organization_id) constraint — re-running never dupes.
  const inserted = await db
    .insert(organizationMembershipsTable)
    .values({ userId: user!.id, organizationId, role: "admin", status: "active" })
    .onConflictDoNothing({
      target: [organizationMembershipsTable.userId, organizationMembershipsTable.organizationId],
    })
    .returning({ id: organizationMembershipsTable.id });

  return { created, membershipCreated: inserted.length > 0, email };
}

// Run directly: `pnpm --filter @workspace/db run seed`
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("seed.ts")) {
  seedDefaultTenant()
    .then(async (r) => {
      const parts = [
        `organization=${r.organizationId} (${r.created.organization ? "created" : "existing"})`,
        `company=${r.companyId} (${r.created.company ? "created" : "existing"})`,
      ];
      // eslint-disable-next-line no-console
      console.log(`[seed] default tenant ready: ${parts.join(", ")}`);

      const admin = await seedAdminUser(r.organizationId);
      if (admin.skipped) {
        // eslint-disable-next-line no-console
        console.log(`[seed] admin user skipped: ${admin.skipped}`);
      } else {
        const userState = admin.created ? "created" : "existing";
        const memState = admin.membershipCreated ? "membership created" : "membership existing";
        // eslint-disable-next-line no-console
        console.log(`[seed] admin user ${userState}: ${admin.email} (${memState})`);
      }

      const perms = await seedPermissions();
      // eslint-disable-next-line no-console
      console.log(`[seed] permissions: ${perms.inserted} inserted, ${perms.total} total`);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[seed] failed:", err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end();
    });
}
