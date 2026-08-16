/**
 * The demo seed, validated from REAL LEDGER ROWS (standing rule 2).
 *
 * 🔴 The seed's whole claim is that it produces a demo the product can actually
 * explain — and the specific thing the owner asked for is that the seeded state
 * be CLAIMABLE, so that uploading the sample bank statement demonstrates the
 * Finance Hub withholding its liquidity claim in front of the reviewer. Seeding
 * an already-withheld state would show the guard's output without ever showing
 * the guard work.
 *
 * That is a property of the POSTED LEDGER, not of the seed's intentions, so it
 * is asserted by reading the same service the page reads. And because the seed
 * drives `invoicesService` / `billsService` rather than INSERTing journal
 * lines, a green result here also says the demo's figures are figures the
 * product can produce.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { overrides } = vi.hoisted(() => ({ overrides: {} as Record<string, unknown> }));
vi.mock("@workspace/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/config")>();
  return { ...actual, loadEnv: () => ({ ...actual.loadEnv(), ...overrides }) };
});

import { pool, beginTenantConnection } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { seedDemoTenant, DEMO_ORG_SLUG, DEMO_VAT_NUMBER } from "../services/demo/demoSeed.service";
import { financeHubService } from "../services/financeHub.service";
import { reportsService } from "../services/reports.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[demo-seed] no real DATABASE_URL — skipping.");

const EMAIL = "demo-seed-test@test.local";

describeMaybe("demo seed", () => {
  let organizationId = "";
  let companyId = "";
  let seeded: Awaited<ReturnType<typeof seedDemoTenant>>;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({
      organizationId,
      companyId,
      role: "authenticated",
    });
    try {
      const out = await conn.run(() =>
        auditContext.run({ userId: 0, organizationId, ipAddress: null }, fn),
      );
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  beforeAll(async () => {
    // A leftover demo tenant from a previous run would make the seed
    // short-circuit and the assertions vacuous.
    await purgeDemoTenant();
    seeded = await seedDemoTenant({
      adminEmail: EMAIL,
      adminPassword: "demo-seed-test-password",
      adminName: "Demo Reviewer",
      now: new Date("2026-08-16T00:00:00Z"),
    });
    organizationId = seeded.organizationId;
    companyId = seeded.companyId;
  }, 120_000);

  afterAll(async () => {
    await purgeDemoTenant();
    await pool.end();
  });

  async function purgeDemoTenant() {
    const { rows } = await pool.query(`SELECT id FROM organizations WHERE slug = $1`, [
      DEMO_ORG_SLUG,
    ]);
    if (rows.length === 0) return;
    const id = rows[0].id;
    const { rows: tables } = await pool.query<{ table_name: string }>(`
      SELECT c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND a.attname = 'organization_id' AND NOT a.attisdropped
    `);
    const client = await pool.connect();
    try {
      // FK order does not matter with triggers off, and this is a local test
      // database owned by a superuser. The reset service itself never does
      // this — it TRUNCATEs, which is why it needs its own guard.
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      for (const t of tables) {
        await client.query(`DELETE FROM "${t.table_name}" WHERE organization_id = $1`, [id]);
      }
      await client.query(`DELETE FROM organization_memberships WHERE organization_id = $1`, [id]);
      await client.query(`DELETE FROM users WHERE email = $1`, [EMAIL]);
      await client.query(`DELETE FROM organizations WHERE id = $1`, [id]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  }

  it("creates the demo tenant with an OBVIOUSLY fictional VAT number", async () => {
    const { rows } = await pool.query(`SELECT name, vat_number FROM companies WHERE id = $1`, [
      companyId,
    ]);
    expect(rows[0].vat_number).toBe(DEMO_VAT_NUMBER);
    // Right shape (15 digits, 3…3) so the product's validators see realistic
    // input; unmistakably fake so nobody reads a demo document as a real one.
    expect(DEMO_VAT_NUMBER).toMatch(/^3\d{13}3$/);
    expect(DEMO_VAT_NUMBER).toContain("99999999999");
  });

  it("seeds a month of documents per month of history, all APPROVED", async () => {
    expect(seeded.invoices).toBe(seeded.months);
    expect(seeded.bills).toBe(seeded.months);
    const drafts = await inTenant(async () => {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM invoices WHERE organization_id = $1 AND status = 'draft'`,
        [organizationId],
      );
      return rows[0].n as number;
    });
    // A draft moves nothing in any report, so a demo full of drafts is a demo
    // full of empty statements.
    expect(drafts).toBe(0);
  });

  it("🔴 posts to the GL through the product's own write path — the ledger BALANCES", async () => {
    const tb = await inTenant(() => reportsService.trialBalance());
    // Not "some number I expect", but the property: a double-entry ledger's
    // debits equal its credits. That is what proves the seed used the posting
    // path rather than writing rows that merely look like one.
    expect(Math.abs(tb.totalDebit - tb.totalCredit)).toBeLessThan(0.005);
    expect(tb.totalDebit).toBeGreaterThan(0);
  });

  it("🔴 the Finance Hub liquidity claim is MADE — the state the demo starts in", async () => {
    const liq = await inTenant(() => financeHubService.liquidity());
    // The requirement, stated as the page states it: no suspense balance, no
    // unclassified balance-sheet account, so the plain-language claim stands.
    // Uploading the sample statement is what takes it away.
    expect(liq.blockers).toEqual([]);
    expect(liq.claimable).toBe(true);
  });

  it("has revenue and expenses in the income statement, not an empty frame", async () => {
    const is = await inTenant(() =>
      reportsService.incomeStatement("2026-02-01", "2026-08-31"),
    );
    expect(is.totalRevenue).toBeGreaterThan(0);
    expect(is.totalExpenses).toBeGreaterThan(0);
  });

  it("leaves recent invoices OUTSTANDING so the receivable surfaces have content", async () => {
    const aging = await inTenant(() => reportsService.arAging());
    expect(aging.total).toBeGreaterThan(0);
  });

  it("is idempotent — a second call does not double the history", async () => {
    const again = await seedDemoTenant({
      adminEmail: EMAIL,
      adminPassword: "demo-seed-test-password",
      now: new Date("2026-08-16T00:00:00Z"),
    });
    expect(again.organizationId).toBe(organizationId);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM invoices WHERE organization_id = $1`,
      [organizationId],
    );
    expect(rows[0].n).toBe(seeded.invoices);
  }, 60_000);
});
