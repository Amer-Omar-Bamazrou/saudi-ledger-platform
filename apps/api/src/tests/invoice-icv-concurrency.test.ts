/**
 * ICV allocation and hash-chain linking under CONCURRENT approvals (M12.1b).
 *
 * ── Why this needs a real concurrency test ──────────────────────────────────
 * Both the ICV and the chain link are read-then-write: read the current head,
 * write the next position. Under Postgres READ COMMITTED, two approvals for the
 * same company can read the SAME head and then both write — minting a duplicate
 * ICV and, worse, FORKING THE CHAIN (two documents claiming the same
 * predecessor).
 *
 * The `unique(company_id, icv)` index is a BACKSTOP: it turns the duplicate into
 * an error, but it cannot unfork a chain, and a chain fork is precisely what
 * ZATCA's chain exists to make undetectable-proof. So allocation is serialised
 * with a per-company advisory lock and this test proves it under real parallel
 * transactions — the same way the M12.6 outbox claiming was proven, rather than
 * by reasoning about isolation levels.
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
if (!REAL_DB) console.warn("[icv-concurrency] no real DATABASE_URL — skipping.");

const SLUG = "icv-conc";
const CONCURRENCY = 8;

describeMaybe("ICV + hash chain under concurrent approvals", () => {
  let orgId = "";
  let companyIdA = "";
  let companyIdB = "";
  let userId = 0;
  let customerId = 0;

  /** Run one unit of work in its OWN tenant transaction (its own connection). */
  async function inTenant<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: "203.0.113.66" }, fn),
      );
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  const cleanup = async () => {
    const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    const usr = `(SELECT id FROM users WHERE email = 'icv-conc@test.local')`;
    await pool.query(`DELETE FROM journal_entry_lines WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM journal_entries WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoice_items WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoices WHERE organization_id IN ${org} AND document_type <> 'invoice'`);
    await pool.query(`DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN ${org})`);
    await pool.query(`DELETE FROM invoices WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org} OR user_id IN ${usr}`);
    await pool.query(`DELETE FROM customers WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${usr} OR organization_id IN ${org}`);
    await pool.query(`DELETE FROM users WHERE email = 'icv-conc@test.local'`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('ICV Org','${SLUG}') RETURNING id`)).rows[0].id;
    const mkCompany = async (name: string, vat: string) =>
      (
        await pool.query(
          `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,$2,'1010101010',$3) RETURNING id`,
          [orgId, name, vat],
        )
      ).rows[0].id;
    companyIdA = await mkCompany("ICV Co A", "399999999999993");
    companyIdB = await mkCompany("ICV Co B", "399999999999994");
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('icv-conc@test.local','ICV',' ','admin',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
    customerId = (
      await pool.query(`INSERT INTO customers (organization_id, name, name_ar) VALUES ($1,'Conc Client','عميل') RETURNING id`, [orgId])
    ).rows[0].id;
  });

  afterAll(async () => {
    await cleanup();
  });

  /** Create a draft, then approve it — approval is where the sequence is consumed. */
  async function createAndApprove(companyId: string, n: number): Promise<void> {
    const inv = await inTenant(companyId, () =>
      invoicesService.create(
        {
          invoiceNumber: `CONC-${companyId.slice(0, 4)}-${n}`,
          date: "2026-09-10",
          customerId,
          items: [{ description: "Item", quantity: 1, unitPrice: 100, vatRate: 15 }],
        },
        userId,
        { autoApprove: false },
      ),
    );
    await inTenant(companyId, () => invoicesService.approve(inv.id, userId));
  }

  it(`allocates a DENSE, UNIQUE ICV sequence under ${CONCURRENCY} parallel approvals`, async () => {
    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, (_, i) => createAndApprove(companyIdA, i + 1)),
    );

    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected.map((r) => String((r as PromiseRejectedResult).reason)), "no approval should fail").toEqual([]);

    const { rows } = await pool.query(
      `SELECT icv FROM invoices WHERE company_id = $1 AND icv IS NOT NULL ORDER BY icv`,
      [companyIdA],
    );
    const icvs = rows.map((r) => r.icv);

    // Dense 1..N with no duplicates and no gaps. A gap would mean a lost
    // allocation; a duplicate would mean the lock failed and the unique index
    // caught it (which would have surfaced as a rejection above).
    expect(icvs).toEqual(Array.from({ length: CONCURRENCY }, (_, i) => i + 1));
    expect(new Set(icvs).size).toBe(CONCURRENCY);
  }, 120_000);

  it("builds ONE unbroken chain — no fork, every link points at its predecessor", async () => {
    const { rows } = await pool.query(
      `SELECT icv, invoice_hash, previous_hash FROM invoices
        WHERE company_id = $1 AND icv IS NOT NULL ORDER BY icv`,
      [companyIdA],
    );

    // Every hash is distinct — two documents never claim the same identity.
    const hashes = rows.map((r) => r.invoice_hash);
    expect(new Set(hashes).size, "duplicate invoice hashes = a forked chain").toBe(rows.length);

    // And every previous_hash is distinct too: a FORK shows up as two rows
    // sharing a predecessor, which is exactly what a lost update would produce.
    const prevs = rows.map((r) => r.previous_hash);
    expect(new Set(prevs).size, "two documents sharing a predecessor = a fork").toBe(rows.length);

    // The chain is contiguous: row N's previous_hash is row N-1's hash.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].previous_hash, `link at ICV ${rows[i].icv}`).toBe(rows[i - 1].invoice_hash);
    }
    // Exactly one genesis root.
    expect(rows.filter((r) => r.previous_hash === "GENESIS")).toHaveLength(1);
  });

  it("does NOT serialise across companies — each has its own sequence", async () => {
    await Promise.all([createAndApprove(companyIdB, 101), createAndApprove(companyIdB, 102)]);

    const b = await pool.query(
      `SELECT icv FROM invoices WHERE company_id = $1 AND icv IS NOT NULL ORDER BY icv`,
      [companyIdB],
    );
    // Company B starts at 1 regardless of how many A issued — the chain and the
    // counter are per EGS unit, and the lock is keyed per company so the two do
    // not contend.
    expect(b.rows.map((r) => r.icv)).toEqual([1, 2]);
  }, 120_000);
});
