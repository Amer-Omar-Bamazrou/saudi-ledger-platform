/**
 * ZATCA hash-chain continuity under the draft/approval workflow (M10.4) — the
 * single most important correctness property in all of M10.
 *
 * A pending/submitted invoice draft must NOT consume a hash-chain sequence
 * number. The chain is built only at approval, so a rejected/deleted draft never
 * creates a gap in the legally-required sequence. This test proves exactly that
 * end to end:
 *
 *   1. A draft carries a NULL invoice_hash (invisible to the chain).
 *   2. An approved invoice created AFTER an intervening draft chains to the last
 *      APPROVED invoice — it skips the draft, so drafts never shift the sequence.
 *   3. A draft that is rejected/deleted leaves no trace and no gap.
 *   4. Approving a draft later links it to the then-latest approved hash — the
 *      chain stays continuous (every non-GENESIS previousHash points at a real
 *      prior hash; exactly one GENESIS).
 *
 * Needs a real database; skips on the DB-free placeholder.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { invoicesService } from "../services/invoices.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) {
  // eslint-disable-next-line no-console
  console.warn("[invoices-hash-chain] no real DATABASE_URL — skipping continuity test.");
}

describeMaybe("ZATCA hash chain — drafts consume no sequence number, no gaps", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let customerId = 0;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: "203.0.113.12" }, fn),
      );
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  const mkItems = (unit: number) => [{ description: "Service", quantity: 1, unitPrice: unit, vatRate: 15 }];

  const cleanup = async () => {
    if (orgId) {
      await pool.query(`DELETE FROM journal_entry_lines WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM journal_entries WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM invoice_items WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = $1)`, [orgId]);
      await pool.query(`DELETE FROM invoices WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM audit_logs WHERE organization_id = $1`, [orgId]);
      await pool.query(`DELETE FROM customers WHERE organization_id = $1`, [orgId]);
    }
    if (userId) await pool.query(`DELETE FROM organization_memberships WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE email = 'inv-chain@test.local'`);
    await pool.query(`DELETE FROM companies WHERE name = 'CHAIN Co'`);
    await pool.query(`DELETE FROM organizations WHERE slug = 'inv-chain'`);
  };

  beforeAll(async () => {
    await pool.query(`DELETE FROM organizations WHERE slug = 'inv-chain'`);
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('CHAIN Org','inv-chain') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'CHAIN Co','1010101010','399999999999993') RETURNING id`, [orgId])).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('inv-chain@test.local','Chain',' ','admin',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    customerId = (
      await pool.query(`INSERT INTO customers (organization_id, name, name_ar) VALUES ($1,'Chain Client','عميل') RETURNING id`, [orgId])
    ).rows[0].id;
  });

  afterAll(async () => {
    await cleanup();
  });

  it("drafts carry no hash; approvals chain continuously, skipping and outliving drafts", async () => {
    // A — approver create (self-approve) → first link, previousHash GENESIS.
    const a = await inTenant(() =>
      invoicesService.create({ invoiceNumber: "CH-A", date: "2026-06-01", customerId, items: mkItems(100) }, userId, { autoApprove: true }),
    );
    expect(a.status).toBe("sent");
    expect(a.invoiceHash).toBeTruthy();
    expect(a.previousHash).toBe("GENESIS");

    // B — bookkeeper draft → NO hash consumed.
    const b = await inTenant(() =>
      invoicesService.create({ invoiceNumber: "CH-B", date: "2026-06-02", customerId, items: mkItems(200) }, userId, { autoApprove: false }),
    );
    expect(b.status).toBe("draft");
    expect(b.invoiceHash).toBeNull();

    // D — another bookkeeper draft, then REJECTED (hard-deleted). Must leave no gap.
    const d = await inTenant(() =>
      invoicesService.create({ invoiceNumber: "CH-D", date: "2026-06-03", customerId, items: mkItems(300) }, userId, { autoApprove: false }),
    );
    expect(d.invoiceHash).toBeNull();
    await inTenant(() => invoicesService.reject(d.id, userId));
    expect((await pool.query(`SELECT id FROM invoices WHERE id = $1`, [d.id])).rowCount).toBe(0);

    // C — approver create AFTER the intervening draft(s) → must chain to A, not B/D.
    const c = await inTenant(() =>
      invoicesService.create({ invoiceNumber: "CH-C", date: "2026-06-04", customerId, items: mkItems(400) }, userId, { autoApprove: true }),
    );
    expect(c.status).toBe("sent");
    expect(c.previousHash).toBe(a.invoiceHash); // skipped the draft B and the deleted D — no gap

    // Now approve B (submit → approve). It links to the then-latest approved hash (C's).
    await inTenant(() => invoicesService.submit(b.id, userId));
    const bIssued = await inTenant(() => invoicesService.approve(b.id, userId));
    expect(bIssued.status).toBe("sent");
    expect(bIssued.previousHash).toBe(c.invoiceHash);

    // ── Chain integrity across the whole tenant ──
    const rows = (
      await pool.query(
        `SELECT invoice_number, invoice_hash, previous_hash FROM invoices WHERE organization_id = $1 ORDER BY id`,
        [orgId],
      )
    ).rows as { invoice_number: string; invoice_hash: string | null; previous_hash: string | null }[];

    // Exactly the three approved invoices carry a hash; none are null.
    const hashed = rows.filter((r) => r.invoice_hash !== null);
    expect(hashed.map((r) => r.invoice_number).sort()).toEqual(["CH-A", "CH-B", "CH-C"]);

    // Exactly one GENESIS root, and every other link points at a real prior hash
    // (no gap, no dangling reference).
    const genesis = hashed.filter((r) => r.previous_hash === "GENESIS");
    expect(genesis).toHaveLength(1);
    const knownHashes = new Set(hashed.map((r) => r.invoice_hash));
    for (const r of hashed) {
      if (r.previous_hash !== "GENESIS") {
        expect(knownHashes.has(r.previous_hash), `${r.invoice_number} chains to a known hash`).toBe(true);
      }
    }

    // All hashes are distinct — no collision / reuse.
    expect(new Set(hashed.map((r) => r.invoice_hash)).size).toBe(3);
  });
});
