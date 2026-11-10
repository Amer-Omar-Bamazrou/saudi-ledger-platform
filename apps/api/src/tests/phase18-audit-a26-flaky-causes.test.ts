/**
 * 🔴 Phase 18 audit (2026-11-09), finding A26 — the causes found behind two of the four flaky tests, fixed in the code.
 *
 * g55 (`g55-cross-company-bank-leaf.test.ts:207` named `lines[0]` where it expects `lines[1]`): the approval reads a
 * draft's lines with NO order (`journalEntriesRepository.linesByEntry`) and names a refused line by its position. A
 * read with no ORDER BY returns rows in physical order; a delete + VACUUM, or an update, reshuffles it (demonstrated in
 * the audit: sweep-3f-g55-order-demo-b.log). The invoice items the signed e-invoice numbers its lines from had the same
 * unordered read (`invoicesRepository.itemsByInvoice`). Both now read in the order the rows were written.
 *
 * The login 429s (phase18-r1-dr27, phase18-t1b, local Windows runs): the rate-limit store's test namespace was the PID
 * alone; Windows reuses a PID within seconds (25 of 150 measured), and the counts live in Postgres for the window, so a
 * fork inherited a dead fork's login count. The namespace now carries a per-process tag.
 *
 * (The other two — smoke-crawl `/bank-accounts` and the fixed-assets navigation click — were test timing, fixed in
 * their specs.) DB-backed for the line order (sl_test / CI); the namespace case runs everywhere.
 */
process.env.PORT ??= "3398";
process.env.SESSION_SECRET ??= "phase18-audit-a26-flaky-causes-0000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
// Static, so vi.resetModules() in the namespace case cannot hand these a second @workspace/db outside the tenant transaction.
import { journalEntriesRepository } from "../repositories/journalEntries.repository";
import { invoicesRepository } from "../repositories/invoices.repository";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "AuditA26FlakyCausesPw1!";

describe("A26 — the rate-limit test namespace is a process's, not a PID's", () => {
  it("🔴 two loads of the store module in ONE process (one PID — as a new fork handed a dead fork's PID) get different namespaces; one load shares its namespace across stores of one name", async () => {
    vi.resetModules();
    const a = await import("../lib/rateLimitStore");
    vi.resetModules();
    const b = await import("../lib/rateLimitStore");
    const first = new a.PostgresRateLimitStore("a26-probe");
    expect(new a.PostgresRateLimitStore("a26-probe").prefix, "one process, one name: one budget").toBe(first.prefix);
    expect(new b.PostgresRateLimitStore("a26-probe").prefix, "another process with the same PID: its own budget").not.toBe(first.prefix);
    expect(first.prefix).toContain(`:p${process.pid}`);
  });
});

describeMaybe("A26 — a document's lines are read in the order they were written", () => {
  const h = g04Harness("auda26");
  let orgId = "", companyId = "", adminId = 0, customerId = 0;

  /** Ids as the database returns them with no ORDER BY, by a sequential scan — the physical order. */
  const physical = async (table: string, fk: string, id: number) => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL enable_indexscan = off");
      await c.query("SET LOCAL enable_bitmapscan = off");
      return (await c.query(`SELECT id FROM ${table} WHERE ${fk} = $1`, [id])).rows.map((r) => r.id as number);
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  };
  /** The product's read, in a tenant transaction whose planner is forced to the same sequential scan. */
  const productRead = <T,>(fn: () => Promise<T>) => h.inTenant(orgId, companyId, adminId, async () => {
    await db.execute(sql`SET LOCAL enable_indexscan = off`);
    await db.execute(sql`SET LOCAL enable_bitmapscan = off`);
    return fn();
  });

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = (await pool.query(
      `INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, building_number, street, district, city, postal_code, additional_number)
       VALUES ($1,'Audit A26 Co','1010868391','310123456789013',1,'1234','King Fahd Road','Al Olaya','Riyadh','12345','6789') RETURNING id`, [orgId])).rows[0].id;
    adminId = await h.mkUser("admin", PW, orgId, "admin");
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'A26 Buyer') RETURNING id`, [orgId])).rows[0].id;
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 a draft journal's lines: after its FIRST line is updated, the product still reads them first-to-last", async () => {
    const accts = (await pool.query(
      `SELECT id, name FROM categories WHERE organization_id = $1 AND is_posting AND system_code IN ('RENT_UTILITIES', 'OFFICE_SUPPLIES') ORDER BY system_code DESC`, [orgId])).rows as Array<{ id: number; name: string }>;
    expect(accts).toHaveLength(2);
    const je = await h.api("admin", "POST", "/journal-entries", {
      date: "2026-10-05", description: "A26 line order",
      lines: [{ accountId: accts[0]!.id, accountName: accts[0]!.name, debitAmount: 10, creditAmount: 0 }, { accountId: accts[1]!.id, accountName: accts[1]!.name, debitAmount: 0, creditAmount: 10 }],
    });
    expect(je.status, JSON.stringify(je.body)).toBe(201);
    const written = (await pool.query(`SELECT id FROM journal_entry_lines WHERE journal_entry_id = $1 ORDER BY id`, [je.body.id])).rows.map((r) => r.id as number);
    await pool.query(`UPDATE journal_entry_lines SET description = coalesce(description, '') || ' (edited)' WHERE id = $1`, [written[0]]);
    expect(await physical("journal_entry_lines", "journal_entry_id", je.body.id), "premise: the update moved the first line after the second, physically").toEqual([written[1], written[0]]);
    expect((await productRead(() => journalEntriesRepository.linesByEntry(je.body.id))).map((l) => l.id)).toEqual(written);
  });

  it("🔴 an invoice's items: after its FIRST item is updated, the product (and the signed e-invoice's line numbers) still read them first-to-last", async () => {
    const inv = await h.api("admin", "POST", "/invoices", { customerId, date: "2026-10-05", items: [
      { description: "First", quantity: 1, unitPrice: 100, vatRate: 15 }, { description: "Second", quantity: 1, unitPrice: 200, vatRate: 15 },
    ] });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    const written = (await pool.query(`SELECT id FROM invoice_items WHERE invoice_id = $1 ORDER BY id`, [inv.body.id])).rows.map((r) => r.id as number);
    await pool.query(`UPDATE invoice_items SET description = description || ' (edited)' WHERE id = $1`, [written[0]]);
    expect(await physical("invoice_items", "invoice_id", inv.body.id), "premise: the update moved the first item after the second, physically").toEqual([written[1], written[0]]);
    expect((await productRead(() => invoicesRepository.itemsByInvoice(inv.body.id))).map((i) => i.id)).toEqual(written);
  });
});
