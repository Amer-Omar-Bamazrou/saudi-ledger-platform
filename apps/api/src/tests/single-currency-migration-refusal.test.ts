/**
 * 🔴 MIGRATION 0062 — the REFUSAL branch, executed.
 *
 * ── Why this test exists ───────────────────────────────────────────────────
 * A green CI proves the migration RUNS. It does not prove the refusal works,
 * because the refusal only fires when non-SAR rows exist — and on every clean
 * database there are none. So the branch that matters would ship having never
 * executed: the "stub is the part that needed testing" shape, in SQL.
 *
 * This runs the DO block READ VERBATIM FROM THE MIGRATION FILE — not a
 * re-typed copy — against a deliberately-constructed violating row, inside a
 * transaction that always rolls back. Testing a hand-copied version of the
 * guard would share any defect with the original (an oracle that shares the
 * defect it is meant to detect).
 *
 * Both directions are asserted: it RAISES with a violating row present, and it
 * stays SILENT without one. The second is the anti-vacuity half — a DO block
 * that always raised would pass a raise-only test.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "@workspace/db";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) {
  console.warn("[0062-refusal] no real DATABASE_URL — the refusal branch is NOT exercised in this run.");
}

/** The DO block, lifted verbatim from the migration rather than restated. */
function guardSql(): string {
  /**
   * 🔴 Resolved from THIS FILE, not from `process.cwd()`.
   *
   * It used to be `join(process.cwd(), "../../packages/db/...")`, which is only
   * correct when vitest is invoked from `apps/api` — the way CI runs it
   * (`pnpm --filter @workspace/api-server run test`). Run from the repo root
   * (`npx vitest run --root apps/api`, which is what a full-suite run looks
   * like locally) the same expression climbs two levels ABOVE the repository
   * and reads nothing: `ENOENT ... C:\Users\packages\db\migrations\...`.
   *
   * Both failures then wore the wrong face. The ENOENT surfaced through
   * `raised.message`, so the test reported "the guard raised with no violating
   * rows" — a confident, specific, and entirely false claim about the
   * migration. A test whose location depends on how it was invoked is a test
   * that reports on the harness while appearing to report on the code.
   */
  const here = dirname(fileURLToPath(import.meta.url));
  const file = join(here, "../../../../packages/db/migrations/0062_single_currency_write_boundary.sql");
  const sql = readFileSync(file, "utf8");
  const block = sql.split("--> statement-breakpoint")[0];
  const start = block.indexOf("DO $$");
  if (start < 0) throw new Error("could not locate the DO block in migration 0062");
  return block.slice(start);
}

describeMaybe("migration 0062 — the refusal actually refuses", () => {
  let orgId: string;
  let companyId: string;

  beforeAll(async () => {
    const { rows } = await pool.query<{ organization_id: string; id: string }>(
      `SELECT organization_id, id FROM public.companies LIMIT 1`,
    );
    if (rows.length === 0) throw new Error("no company row to attach a fixture to");
    orgId = rows[0].organization_id;
    companyId = rows[0].id;
  });

  it("🔴 RAISES when a non-SAR row exists, and NAMES the table and the count", async () => {
    const client = await pool.connect();
    let raised: Error | null = null;
    try {
      await client.query("BEGIN");
      // Remove the CHECK so the violating row can be created at all — this is
      // the pre-migration world the DO block is written to detect.
      await client.query(`ALTER TABLE public.bank_accounts DROP CONSTRAINT IF EXISTS bank_accounts_currency_sar`);
      await client.query(
        `INSERT INTO public.bank_accounts (organization_id, company_id, name, bank_name, currency)
         VALUES ($1, $2, 'Offshore fixture', 'HSBC', 'USD')`,
        [orgId, companyId],
      );
      await client.query(guardSql());
    } catch (err) {
      raised = err as Error;
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }

    expect(raised, "the DO block did not raise on a non-SAR row").not.toBeNull();
    expect(raised!.message).toMatch(/bank_accounts/);
    expect(raised!.message).toMatch(/1 row/);
    // It must tell the operator what to do, not merely refuse.
    expect(raised!.message).toMatch(/Convert/i);
  });

  it("stays SILENT on a clean database (anti-vacuity: it is not always raising)", async () => {
    const client = await pool.connect();
    let raised: Error | null = null;
    try {
      await client.query("BEGIN");
      await client.query(guardSql());
    } catch (err) {
      raised = err as Error;
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
    expect(raised, `the guard raised with no violating rows: ${raised?.message}`).toBeNull();
  });

  it("the CHECK constraint is present on all nine tables", async () => {
    const { rows } = await pool.query<{ table_name: string }>(`
      SELECT rel.relname AS table_name
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
       WHERE con.contype = 'c' AND con.conname LIKE '%_currency_sar'
       ORDER BY rel.relname
    `);
    expect(rows.map((r) => r.table_name)).toEqual([
      "bank_accounts", "bills", "customers", "invoices", "products",
      "purchase_orders", "quotations", "transactions", "vendors",
    ]);
  });
});
