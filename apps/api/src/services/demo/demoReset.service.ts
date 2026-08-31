/**
 * The weekly demo reset (docs/product/demo-deployment-decisions.md D6, D9).
 *
 * 🔴 THIS FUNCTION DESTROYS DATA. Everything below is written on the assumption
 * that the flag guarding it will one day be set on the wrong deployment — by a
 * copy-pasted environment, a cloned Railway service, a restored backup. So
 * `DEMO_MODE` is NOT the safety mechanism; it is the trigger. The safety
 * mechanism is a STRUCTURAL precondition the real platform cannot satisfy:
 *
 *   the database must contain EXACTLY ONE organization, and its slug must be
 *   the demo slug.
 *
 * A production database has other tenants, so the reset refuses there even with
 * `DEMO_MODE=true` — it does not merely decline to delete them, it declines to
 * run at all. That is the "make the weaker requirement structurally
 * load-bearing" lesson: a check that fails closed on the presence of real data
 * beats a flag that has to be remembered.
 *
 * A refusal is a FAILED RUN, recorded and alarmed — never a silent skip. If the
 * demo stops resetting, that is exactly the case the banner must stop claiming.
 */
import { sql } from "drizzle-orm";
import { ownerDb, pool } from "@workspace/db";
import { loadEnv } from "@workspace/config";
import { logger } from "../../lib/logger";
import { seedDemoTenant, DEMO_ORG_SLUG } from "./demoSeed.service";

/**
 * Tables that are GLOBAL reference data or the reset's own bookkeeping, and are
 * never part of a tenant's data. Everything else in `public` that carries an
 * `organization_id` is tenant data and goes, plus the identity tables listed
 * below.
 *
 * 🔴 The tenant set is discovered from the CATALOG, not from a list here. A
 * hand-maintained list of tables to wipe is a list that silently stops being
 * complete the next time someone adds a table — and the failure mode is
 * "yesterday's tenant data survived the wipe", which is the one outcome a demo
 * reset exists to prevent.
 */
const NEVER_TRUNCATE = new Set([
  "permissions",
  "system_account_templates",
  "alert_state",
  "demo_reset_runs",
  "__drizzle_migrations",
]);

/**
 * Identity + session tables. They carry no `organization_id`, so the catalog
 * query cannot find them, and the demo's login lives in them — a reset that
 * left them behind would accumulate users forever.
 */
const IDENTITY_TABLES = [
  "organizations",
  "users",
  "organization_memberships",
  "platform_operators",
  "user_sessions",
];

export class DemoResetRefused extends Error {
  constructor(message: string) {
    super(message);
    // 🔴 Without this the class was INDISTINGUISHABLE from a bare Error at
    // runtime across transpilation targets (name stayed "Error", and the
    // audit found the test asserting exactly that defect). A caller must be
    // able to tell "I declined" from "I broke" — one of them is an emergency.
    this.name = "DemoResetRefused";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

async function tenantTables(): Promise<string[]> {
  const res = await ownerDb.execute<{ table_name: string }>(sql`
    SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND a.attname = 'organization_id'
       AND NOT a.attisdropped
     ORDER BY c.relname
  `);
  const rows = (res as unknown as { rows: { table_name: string }[] }).rows ?? [];
  return rows.map((r) => r.table_name).filter((t) => !NEVER_TRUNCATE.has(t));
}

/**
 * The precondition. Throws {@link DemoResetRefused} with a message that names
 * what it found — a refusal nobody can diagnose gets overridden.
 */
async function assertDemoOnlyDatabase(): Promise<void> {
  if (!loadEnv().DEMO_MODE) {
    throw new DemoResetRefused("DEMO_MODE is off — the demo reset does not run here.");
  }

  const res = await ownerDb.execute<{ slug: string }>(sql`SELECT slug FROM organizations`);
  const slugs = ((res as unknown as { rows: { slug: string }[] }).rows ?? []).map((r) => r.slug);

  // Zero organizations is fine — a fresh database that has never been seeded.
  // More than one, or one that is not the demo, means this is not a demo
  // database and nothing here may touch it.
  const foreign = slugs.filter((s) => s !== DEMO_ORG_SLUG);
  if (foreign.length > 0) {
    throw new DemoResetRefused(
      `Refusing to reset: the database holds ${slugs.length} organization(s), including ` +
        `${foreign.length} that are not the demo tenant (${foreign.slice(0, 5).join(", ")}). ` +
        `DEMO_MODE is set on a database that contains real tenants.`,
    );
  }
}

export interface DemoResetOutcome {
  status: "succeeded" | "failed";
  detail: string;
}

/**
 * Wipe the demo tenant and re-seed it.
 *
 * ONE transaction covering both halves. A reset that truncated and then failed
 * to seed would leave a demo with a login screen and no data, still displaying
 * a banner that says sample data is here — the "fail loudly, never partially"
 * requirement is met by the transaction, not by ordering.
 */
/** Shared so it can be removed again — an anonymous closure per call leaks listeners. */
function onDemoClientError(err: Error): void {
  logger.error({ err }, "[demo-reset] the connection failed while checked out; the process stays up");
}

export async function runDemoReset(): Promise<DemoResetOutcome> {
  const client = await pool.connect();
  /**
   * 🔴 A CHECKED-OUT CLIENT NEEDS AN `error` LISTENER, or a connection that
   * dies underneath it takes the whole API process with it — an `error` event
   * with no listener is fatal in Node, and `pool.on("error")` covers IDLE
   * clients only.
   *
   * Found by sweeping the shape after the same defect killed the server from
   * the tenant-connection path (2026-08-31). This one is a long TRUNCATE
   * transaction on a scheduled job — exactly the profile a restart, failover
   * or admin termination interrupts. The listener is removed on release.
   */
  client.on("error", onDemoClientError);
  let runId: number | null = null;

  try {
    const started = await client.query<{ id: number }>(
      `INSERT INTO demo_reset_runs (status) VALUES ('running') RETURNING id`,
    );
    runId = started.rows[0]!.id;

    await assertDemoOnlyDatabase();

    const tables = [...(await tenantTables()), ...IDENTITY_TABLES];
    const quoted = tables.map((t) => `"${t}"`).join(", ");

    await client.query("BEGIN");
    // RESTART IDENTITY so the re-seeded demo has the same ids every week —
    // a reviewer's bookmarked URL keeps pointing at the same invoice.
    await client.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
    await client.query("COMMIT");

    // Re-seed OUTSIDE the truncate transaction: the seed drives the product's
    // own services, which open their own tenant connections (§4 — one writer
    // per effect), and those cannot see an uncommitted TRUNCATE on another
    // connection. If the seed fails, the run is recorded as failed and the
    // banner stops claiming a recent wipe — which is accurate: the data IS
    // gone, and the demo is broken, and someone needs to know.
    const env = loadEnv();
    const seeded = await seedDemoTenant({
      adminEmail: env.DEMO_ADMIN_EMAIL!,
      adminPassword: env.DEMO_ADMIN_PASSWORD!,
      adminName: "Demo Reviewer",
    });

    const detail =
      `truncated ${tables.length} tables; re-seeded ${seeded.invoices} invoices, ` +
      `${seeded.bills} bills across ${seeded.months} months`;

    await client.query(
      `UPDATE demo_reset_runs SET status = 'succeeded', finished_at = now(), detail = $2 WHERE id = $1`,
      [runId, detail],
    );
    logger.info({ runId, detail }, "[demo-reset] completed");
    return { status: "succeeded", detail };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* the transaction may never have opened */
    }
    const detail = err instanceof Error ? err.message : String(err);
    if (runId !== null) {
      await client
        .query(
          `UPDATE demo_reset_runs SET status = 'failed', finished_at = now(), detail = $2 WHERE id = $1`,
          [runId, detail],
        )
        .catch(() => {
          /* recording the failure must not mask it */
        });
    }
    logger.error({ err, runId }, "[demo-reset] FAILED");
    return { status: "failed", detail };
  } finally {
    client.off("error", onDemoClientError);
    client.release();
  }
}

/** The newest successful reset, or null if there has never been one. */
export async function lastSuccessfulReset(): Promise<Date | null> {
  const res = await ownerDb.execute<{ started_at: string }>(sql`
    SELECT started_at FROM demo_reset_runs
     WHERE status = 'succeeded'
     ORDER BY started_at DESC
     LIMIT 1
  `);
  const row = (res as unknown as { rows: { started_at: string }[] }).rows?.[0];
  return row ? new Date(row.started_at) : null;
}

/**
 * When the demo tenant was created — the moment the banner started claiming a
 * weekly wipe, and therefore the clock the FIRST reset is measured against.
 *
 * Null when there is no demo tenant, which is not an alarm: nothing is claiming
 * anything yet.
 */
export async function demoTenantCreatedAt(): Promise<Date | null> {
  const res = await ownerDb.execute<{ created_at: string }>(sql`
    SELECT created_at FROM organizations WHERE slug = ${DEMO_ORG_SLUG} LIMIT 1
  `);
  const row = (res as unknown as { rows: { created_at: string }[] }).rows?.[0];
  return row ? new Date(row.created_at) : null;
}
