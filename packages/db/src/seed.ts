import { eq, and } from "drizzle-orm";
import { db, pool } from "./index";
import { organizationsTable, companiesTable } from "./schema";

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

// Run directly: `pnpm --filter @workspace/db run seed`
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("seed.ts")) {
  seedDefaultTenant()
    .then((r) => {
      const parts = [
        `organization=${r.organizationId} (${r.created.organization ? "created" : "existing"})`,
        `company=${r.companyId} (${r.created.company ? "created" : "existing"})`,
      ];
      // eslint-disable-next-line no-console
      console.log(`[seed] default tenant ready: ${parts.join(", ")}`);
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
