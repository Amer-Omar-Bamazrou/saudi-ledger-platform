/**
 * A JOURNAL ENTRY WITHOUT A DATE CANNOT EXIST (2026-09-14).
 *
 * Found by the spread-into-body sweep: the JE form spreads `...form`, its
 * date input is clearable, and `date: ""` sailed through create because
 * every guard was written `if (jeData.date) …` — falsy "" SKIPPED both
 * assertDateString and checkPeriodOpen. The stored "" satisfied NOT NULL,
 * approval's checkPeriodOpen("") matched no lock (toPeriod("") is ""), so
 * the entry POSTED — and then fell outside every date-ranged report: in
 * the books, invisible to periods. The triage check's first and third
 * questions in one row (posts + hides).
 *
 * The rule now lives at the write boundary: a missing OR empty date is a
 * readable 400, unconditionally — an entry that cannot say when it
 * happened cannot be a journal entry.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { journalEntriesService } from "../services/journalEntries.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[je-empty-date] no real DATABASE_URL — skipping.");

const SLUG = "je-empty-date";

describeMaybe("journal entry date — required at the write boundary", () => {
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
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('JED Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'JED','1010101063','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    const acc = async (type: string, notIn: string) =>
      (await pool.query(
        `SELECT id FROM categories WHERE organization_id = $1 AND type = $2 AND system_code NOT IN (${notIn}) LIMIT 1`,
        [orgId, type],
      )).rows[0].id;
    expenseId = await acc("expense", "'AR','AP'");
    cashId = await acc("asset", "'AR','AP'");
  });

  afterAll(cleanup);

  const entry = (date: unknown) => ({
    date,
    description: "empty-date probe",
    lines: [
      { accountId: expenseId, accountName: "Expense", debitAmount: 10, creditAmount: 0 },
      { accountId: cashId, accountName: "Asset", debitAmount: 0, creditAmount: 10 },
    ],
  });

  it("🔴 an EMPTY date is refused with a readable 400 — it used to skip validation AND the period lock", async () => {
    await expect(inTenant(() => journalEntriesService.create(entry(""), null))).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("a MISSING date is the same refusal", async () => {
    await expect(inTenant(() => journalEntriesService.create(entry(undefined), null))).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("movement: a real date still creates — the gate refuses the absence, not the entry", async () => {
    const out = await inTenant(() => journalEntriesService.create(entry("2026-09-10"), null));
    expect(out.id).toBeTruthy();
  });
});
