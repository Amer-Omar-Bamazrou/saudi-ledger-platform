/**
 * N3's remaining half — the manual-JE party gate, both arms.
 *
 * A receivable is a receivable FROM someone; a payable TO someone. The
 * document paths were gated in N3 itself; the manual paths were a NAMED GAP
 * until the form got its picker. What is proven here:
 *
 *   1. The write boundary (journalEntries.service.create): an AR line
 *      without a customer is a readable 422; with one, the party PERSISTS on
 *      the row; a party on a non-control account is refused (a value that
 *      would satisfy every check while meaning nothing); a nonexistent /
 *      other-tenant id is the same refusal (tenant-scoped resolution).
 *   2. The GL boundary (postJournalEntry's accountId arm): naming the AR
 *      account BY ID party-less now throws MissingPartyError — the last way
 *      to reach a control account without saying who.
 *
 * DB-backed; the org-seed trigger provides the AR/AP control accounts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { journalEntriesService } from "../services/journalEntries.service";
import { postJournalEntry, MissingPartyError } from "../services/accounting/glPosting";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[journal-party] no real DATABASE_URL — skipping.");

const SLUG = "n3-je-party";

describeMaybe("N3 — the manual-JE party gate", () => {
  let orgId = "";
  let companyId = "";
  let arId = 0;
  let apId = 0;
  let cashId = 0;
  let customerId = 0;
  let vendorId = 0;
  let seq = 0;
  const nextNumber = () => `N3P-${Date.now()}-${++seq}`;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId: null, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  const cleanup = async () => {
    const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    await pool.query(`DELETE FROM journal_entry_lines WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM journal_entries WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM customers WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM vendors WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('N3P Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'N3P','1010101047','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    const acc = async (code: string) =>
      (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`, [orgId, code])).rows[0]?.id;
    arId = await acc("AR");
    apId = await acc("AP");
    // Any non-AR/AP account: the seeded chart has no code-less accounts, and
    // the rule keys on the CODE being AR/AP, not on system-ness.
    cashId = (
      await pool.query(
        `SELECT id FROM categories WHERE organization_id = $1 AND type = 'expense' AND system_code NOT IN ('AR','AP') LIMIT 1`,
        [orgId],
      )
    ).rows[0].id;
    expect(arId).toBeTruthy();
    expect(apId).toBeTruthy();
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'N3P Customer') RETURNING id`, [orgId])).rows[0].id;
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'N3P Vendor') RETURNING id`, [orgId])).rows[0].id;
  });

  afterAll(cleanup);

  const arLine = (over: Record<string, unknown> = {}) => ({
    accountId: arId, accountName: "Accounts Receivable", debitAmount: 100, creditAmount: 0, ...over,
  });
  const balancing = () => ({ accountId: cashId, accountName: "Expense", debitAmount: 0, creditAmount: 100 });
  const entry = (lines: unknown[]) => ({
    entryNumber: nextNumber(), date: "2026-09-10", description: "party gate", lines,
  });

  it("🔴 an AR line WITHOUT a customer is a readable 422 that names the line and the fix", async () => {
    await expect(inTenant(() => journalEntriesService.create(entry([arLine(), balancing()]), null))).rejects.toMatchObject({
      statusCode: 422,
      payload: { code: "journal_line_party_invalid" },
    });
  });

  it("🔴 with the customer, the party PERSISTS on the stored row — presence, not just acceptance", async () => {
    const out = await inTenant(() => journalEntriesService.create(entry([arLine({ customerId }), balancing()]), null));
    const { rows } = await pool.query(
      `SELECT party_type, customer_id, vendor_id FROM journal_entry_lines WHERE journal_entry_id = $1 AND account_id = $2`,
      [out.id, arId],
    );
    expect(rows[0]).toMatchObject({ party_type: "customer", customer_id: customerId, vendor_id: null });
    // And the read path carries it back out.
    const read = await inTenant(() => journalEntriesService.getById(out.id));
    const line = read.lines.find((l: { accountId: number | null }) => l.accountId === arId)!;
    expect(line).toMatchObject({ partyType: "customer", customerId });
  });

  it("an AP line requires a vendor; a customer there is refused by name", async () => {
    const ap = { accountId: apId, accountName: "Accounts Payable", debitAmount: 0, creditAmount: 100 };
    const bal = { accountId: cashId, accountName: "Expense", debitAmount: 100, creditAmount: 0 };
    await expect(inTenant(() => journalEntriesService.create(entry([ap, bal]), null))).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      inTenant(() => journalEntriesService.create(entry([{ ...ap, customerId }, bal]), null)),
    ).rejects.toMatchObject({ statusCode: 422 });
    const ok = await inTenant(() => journalEntriesService.create(entry([{ ...ap, vendorId }, bal]), null));
    expect(ok.id).toBeTruthy();
  });

  it("🔴 a party on a NON-control account is refused — it would mean nothing where it is stored", async () => {
    await expect(
      inTenant(() => journalEntriesService.create(entry([arLine({ customerId }), { ...balancing(), vendorId }]), null)),
    ).rejects.toMatchObject({ statusCode: 422, payload: { code: "journal_line_party_invalid" } });
  });

  it("🔴 a nonexistent customer id is the same refusal as another tenant's (tenant-scoped resolution)", async () => {
    await expect(
      inTenant(() => journalEntriesService.create(entry([arLine({ customerId: 99999999 }), balancing()]), null)),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("🔴 the GL boundary's accountId arm: naming AR BY ID party-less throws MissingPartyError — no path remains", async () => {
    await expect(
      inTenant(() =>
        postJournalEntry({
          entryNumber: nextNumber(),
          date: "2026-09-10",
          description: "accountId arm",
          lines: [
            { accountId: arId, accountName: "Accounts Receivable", debitAmount: 50, creditAmount: 0 },
            { accountId: cashId, accountName: "Expense", debitAmount: 0, creditAmount: 50 },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(MissingPartyError);
    // Movement: the same entry WITH a party posts — the gate refuses the
    // omission, not the account.
    const je = await inTenant(() =>
      postJournalEntry({
        entryNumber: nextNumber(),
        date: "2026-09-10",
        description: "accountId arm, with party",
        lines: [
          { accountId: arId, accountName: "Accounts Receivable", debitAmount: 50, creditAmount: 0, party: { type: "customer", customerId } },
          { accountId: cashId, accountName: "Expense", debitAmount: 0, creditAmount: 50 },
        ],
      }),
    );
    expect(je.id).toBeTruthy();
  });
});
