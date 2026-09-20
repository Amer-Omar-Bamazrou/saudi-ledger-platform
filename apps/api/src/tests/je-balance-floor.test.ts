/**
 * A JOURNAL CANNOT BECOME POSTED WHILE UNBALANCED — the invariant that matters,
 * asserted on the values the ledger STORES, not the values a request computed.
 *
 * 🔴 WHY THIS EXISTS (2026-09-15, second-opinion review item 2): the manual
 * journal-entry create path summed the RAW request amounts, compared them under
 * `GL_BALANCE_TOLERANCE`, and then stored each line through `.toFixed(2)` — so
 * two 0.015 debits (each stored as 0.01) against a 0.03 credit passed the check
 * unrounded and persisted UNBALANCED. And `onApprove` flipped `status` to
 * `posted` without reading the lines at all — a draft whose stored lines do not
 * balance became a posted entry. The owner-named rule: a tolerance applied to the
 * values you compute, not the values you store, checks a different thing than it
 * appears to.
 *
 * Also asserted, as absences that cannot be vacuous: there is NO path that
 * deletes a single line or moves a line between journals — the guard is not
 * "INSERT and UPDATE only" because the mutations do not exist (the JE router
 * exposes create / approve / post / reject / reverse / remove; `remove` deletes
 * a whole DRAFT with its lines, cascade).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { journalEntriesService } from "../services/journalEntries.service";

const connectionString = process.env.DATABASE_URL;
const describeMaybe = connectionString ? describe : describe.skip;
const SLUG = "je-balance-floor";

describeMaybe("journal entry balance — checked on the STORED values, and again at posting", () => {
  let orgId = "";
  let companyId = "";
  let expenseId = 0;
  let cashId = 0;

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
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('JBF Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'JBF','1010101071','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    const acc = async (type: string) =>
      (await pool.query(
        `SELECT id FROM categories WHERE organization_id = $1 AND type = $2 AND system_code NOT IN ('AR','AP') AND is_posting LIMIT 1`,
        [orgId, type],
      )).rows[0].id;
    expenseId = await acc("expense");
    cashId = await acc("asset");
  });
  afterAll(cleanup);

  const entry = (lines: Array<{ debitAmount: number; creditAmount: number }>) => ({
    date: "2026-09-10",
    description: "balance floor probe",
    lines: lines.map((l, i) => ({ accountId: i === 0 ? expenseId : cashId, accountName: i === 0 ? "Expense" : "Asset", ...l })),
  });

  it("🔴 the rounding edge: 0.015 + 0.015 against 0.03 is REFUSED — the check runs on what would be stored", async () => {
    // Raw sums balance (0.03 = 0.03, within tolerance); stored 2-dp values do not
    // (0.02 + 0.02 = 0.04 ≠ 0.03). Before the fix this CREATED an unbalanced draft.
    await expect(
      inTenant(() =>
        journalEntriesService.create(
          entry([
            { debitAmount: 0.015, creditAmount: 0 },
            { debitAmount: 0.015, creditAmount: 0 },
            { debitAmount: 0, creditAmount: 0.03 },
          ]),
          null,
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 422, payload: { code: "journal_entry_unbalanced" } });
    const stored = await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1`, [orgId]);
    expect(stored.rows[0].n).toBe(0);
  });

  it("🔴 a draft whose STORED lines do not balance cannot become posted — approve re-checks the rows, not the request", async () => {
    // Plant the exact state the create path used to produce: a draft with lines
    // that do not balance, inserted below the application.
    const je = (
      await pool.query(
        `INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status)
         VALUES ($1, $2, 'JBF-UNBAL', '2026-09-10', 'planted unbalanced draft', 'draft') RETURNING id`,
        [orgId, companyId],
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO journal_entry_lines (organization_id, company_id, journal_entry_id, account_id, account_name, debit_amount, credit_amount)
       VALUES ($1, $2, $3, $4, 'Expense', '10.00', '0.00'), ($1, $2, $3, $5, 'Asset', '0.00', '9.99')`,
      [orgId, companyId, je, expenseId, cashId],
    );
    await expect(inTenant(() => journalEntriesService.approve(je, null))).rejects.toMatchObject({ statusCode: 422 });
    const after = await pool.query(`SELECT status FROM journal_entries WHERE id = $1`, [je]);
    expect(after.rows[0].status).toBe("draft");
  });

  it("movement: a balanced entry still creates AND posts — the floor refuses the imbalance, not the entry", async () => {
    const out = await inTenant(() =>
      journalEntriesService.create(
        entry([
          { debitAmount: 10.005, creditAmount: 0 }, // rounds to 10.01 (round2, half-up on the double)
          { debitAmount: 0, creditAmount: 10.005 },
        ]),
        null,
      ),
    );
    const posted = await inTenant(() => journalEntriesService.approve(out.id, null));
    expect(posted.status).toBe("posted");
    const lines = await pool.query(`SELECT debit_amount, credit_amount FROM journal_entry_lines WHERE journal_entry_id = $1 ORDER BY id`, [out.id]);
    // Stored values are the rounded ones, and they balance exactly.
    expect(lines.rows.map((r) => [r.debit_amount, r.credit_amount])).toEqual([["10.01", "0.00"], ["0.00", "10.01"]]);
  });

  it("absence, not a guard: no route deletes a single line or moves one between journals", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const routes = readFileSync(join(import.meta.dirname, "../routes/journalEntries.ts"), "utf8");
    const verbs = [...routes.matchAll(/router\.(get|post|patch|put|delete)\("([^"]+)"/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(verbs).toEqual(["get /", "get /:id", "post /", "post /:id/approve", "post /:id/reject", "post /:id/post", "post /:id/reverse", "delete /:id"]);
    expect(verbs.some((v) => /lines?/.test(v) || v.startsWith("patch") || v.startsWith("put"))).toBe(false);
  });
});
