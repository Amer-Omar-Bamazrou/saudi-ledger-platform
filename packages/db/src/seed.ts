import { eq, and } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { db, pool } from "./index";
import { organizationsTable, companiesTable, usersTable } from "./schema";
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
      [org] = await tx
        .insert(organizationsTable)
        .values({ name: DEFAULT_ORG_NAME, slug: DEFAULT_ORG_SLUG })
        .returning();
      created.organization = true;
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
  created: boolean;
  /** Set when seeding was intentionally skipped (missing/invalid config or already present). */
  skipped?: string;
  email?: string;
}

/**
 * Idempotently provision the initial admin user.
 *
 * This replaces the old unauthenticated "first user registers freely" HTTP
 * bootstrap (a race-to-admin vulnerability). The initial admin is now created
 * out-of-band from these env vars:
 *
 *   SEED_ADMIN_EMAIL     (required to seed)
 *   SEED_ADMIN_PASSWORD  (required to seed; min 8 chars)
 *   SEED_ADMIN_NAME      (optional; defaults to "Administrator")
 *
 * If the credentials are absent the step is skipped (so the tenant seed can run
 * on its own). If a user with that email already exists it is left untouched —
 * the password is never re-hashed or overwritten.
 */
export async function seedAdminUser(): Promise<SeededAdmin> {
  const email = process.env["SEED_ADMIN_EMAIL"]?.trim();
  const password = process.env["SEED_ADMIN_PASSWORD"];
  const name = process.env["SEED_ADMIN_NAME"]?.trim() || "Administrator";

  if (!email || !password) {
    return { created: false, skipped: "SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD not set" };
  }
  if (password.length < 8) {
    return { created: false, skipped: "SEED_ADMIN_PASSWORD must be at least 8 characters" };
  }

  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);

  if (existing) {
    return { created: false, skipped: `user ${email} already exists`, email };
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  await db.insert(usersTable).values({ email, name, passwordHash, role: "admin", isActive: true });
  return { created: true, email };
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

      const admin = await seedAdminUser();
      if (admin.created) {
        // eslint-disable-next-line no-console
        console.log(`[seed] admin user created: ${admin.email}`);
      } else {
        // eslint-disable-next-line no-console
        console.log(`[seed] admin user skipped: ${admin.skipped}`);
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
