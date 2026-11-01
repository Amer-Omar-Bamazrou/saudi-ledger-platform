/**
 * 🔴 Phase 18 R-3 — AC-5, memo §2f (register §11.90): a non-manual source
 * names its row by a POSITIVE id. T1d's CHECK (0129) required an id; 0149
 * requires it to point at something that can exist — serials start at 1 — so a
 * zero (what three fixtures wrote) or a negative is refused at the database,
 * whatever wrote it. The manual / recurring arms are unchanged.
 *
 * Acts through the posting seam inside a tenant transaction, so the refusal is
 * the one every product writer would meet. DB-backed; skips without a database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { postJournalEntry } from "../services/accounting/glPosting";
import { releasePostedJournalsForTeardown } from "./helpers/journalFixtures";
import { deleterFor } from "./helpers/replica";

const connectionString = process.env.DATABASE_URL;
const describeMaybe = connectionString && !connectionString.includes("placeholder") ? describe : describe.skip;
const SLUG = "p18-r3-source-id";

describeMaybe("Phase 18 R-3 — a required source id is a positive id (journal_entries_source_id_chk, 0149)", () => {
  let orgId = "", companyId = "", office = 0, sales = 0, n = 0;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId: null, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (e) {
      await conn.rollback().catch(() => undefined);
      throw e;
    }
  }
  const lines = () => [
    { accountId: office, accountName: "Office", debitAmount: 10, creditAmount: 0 },
    { accountId: sales, accountName: "Sales", debitAmount: 0, creditAmount: 10 },
  ];
  const seam = (sourceType: string, sourceId: number | null) =>
    inTenant(() => postJournalEntry({ entryNumber: `R3-${++n}`, date: "2026-05-10", description: `R3 ${sourceType} ${sourceId}`, sourceType: sourceType as never, sourceId: sourceId as never, lines: lines() }));
  // drizzle wraps the driver's error: the constraint name is on `cause` (or on the error itself from a plain query)
  const constraintOf = (e: unknown) => (e as { constraint?: string; cause?: { constraint?: string } })?.constraint ?? (e as { cause?: { constraint?: string } })?.cause?.constraint;
  const refusedByCheck = async (sourceType: string, sourceId: number | null) =>
    expect(seam(sourceType, sourceId)).rejects.toSatisfy((e) => constraintOf(e) === "journal_entries_source_id_chk", "refused by journal_entries_source_id_chk");

  const cleanup = async () => {
    const O = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    await releasePostedJournalsForTeardown(`organization_id IN ${O}`);
    for (const t of ["journal_entry_lines", "journal_entries", "audit_logs", "categories", "companies"]) {
      await deleterFor(pool, t).query(`DELETE FROM ${t} WHERE organization_id IN ${O}`).catch((e: Error) => { if (!/does not exist/.test(e.message)) throw e; });
    }
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('R3 Source Id Org', '${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1, 'R3 Co', '1010101010', '399999999999973') RETURNING id`, [orgId])).rows[0].id;
    const byCode = async (code: string) => Number((await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2 AND is_posting`, [orgId, code])).rows[0].id);
    office = await byCode("OFFICE_SUPPLIES");
    sales = await byCode("SALES");
  });
  afterAll(cleanup);

  it("control: a document source with a positive id posts through the seam", async () => {
    // (a manual entry is not the seam's to post — T1d's approver trigger refuses the flip without an approval — so the
    // manual arm is exercised only through its refusal below)
    const a = await seam("invoice", 1);
    const rows = (await pool.query(`SELECT id, source_type, source_id FROM journal_entries WHERE id = $1`, [a.id])).rows;
    expect(rows.map((r) => [r.source_type, r.source_id])).toEqual([["invoice", 1]]);
  });

  it("🔴 a document source with id 0 — the three fixtures' stand-in — is refused by the database", async () => {
    await refusedByCheck("invoice", 0);
    await refusedByCheck("bank_transaction", 0);
    await refusedByCheck("payroll_run", 0);
  });

  it("🔴 a negative id is refused too, and the manual arm still refuses an id", async () => {
    await refusedByCheck("bill", -1);
    await refusedByCheck("manual", 1);
  });

  it("nothing that was refused was written", async () => {
    const r = await pool.query(`SELECT count(*)::int AS c FROM journal_entries WHERE organization_id = $1 AND (source_id IS NOT NULL AND source_id <= 0)`, [orgId]);
    expect(r.rows[0].c).toBe(0);
  });
});
