/**
 * G55 / DR-42 (2026-10-14) — A BANK'S CASH ACCOUNT TAKES ENTRIES ONLY FROM ITS
 * OWN COMPANY. The regression suite for the fix (owner-authorised 2026-10-14,
 * HIGH; register DR-42 options (a) + (b)).
 *
 * The S1 proof (`phase18-s1-dr42-cross-company-bank-leaf.test.ts`, landed
 * unchanged) shows the two reproduced paths now post nothing. This file holds
 * what the proof does not:
 *  - WHERE each refusal fires: drafting (a manual journal, a prepayment
 *    schedule — the field named), the posting seam for every caller of
 *    `postJournalEntry`, and manual-journal APPROVAL, which never reaches the
 *    seam;
 *  - what was written BEFORE the rule: a draft is refused at approval, a
 *    schedule at recognition (and the month-end run reports it skipped,
 *    posting nothing for it), and a POSTED entry can still be REVERSED — the
 *    correction stays open;
 *  - what did NOT change: the company's own bank (an INACTIVE one included —
 *    no new restriction, owner 2026-10-14), company B on its own bank, and
 *    another organisation's account (still G04's refusal, which names nothing);
 *  - the rule itself in each company context: A, B, and none (fails closed).
 *
 * 🔴 STAND-INS, named: rows "written before the rule" are FIXTURES inserted by
 * SQL — no path of the product can write them any longer, which is the point.
 * Company B is reached through its own tenant transaction (HTTP always acts as
 * the organisation's first-created company, A — lib/tenant.ts).
 *
 * DB-backed; skips on the DB-free placeholder.
 */

process.env.PORT ??= "3145";
process.env.SESSION_SECRET ??= "g55-cross-company-bank-leaf-session-secret-01";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, beginTenantConnection } from "@workspace/db";
import { __resetRateLimitsForTests } from "../routes/auth";
import { bankAccountsService } from "../services/bankAccounts.service";
import { journalEntriesService } from "../services/journalEntries.service";
import { postJournalEntry } from "../services/accounting/glPosting";
import { bankLeavesOutsideCompany } from "../services/accounting/tenantReferences";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PW = "G55RegressionPw123!";
const DATE = "2026-10-05";

describeMaybe("G55 / DR-42 — a bank's cash account takes entries only from its own company", () => {
  const h = g04Harness("g55reg");
  let orgX = "";
  let coA = "";
  let coB = "";
  let adminId = 0;
  let bookkeeperId = 0;
  let bankA = 0;
  let bankA2 = 0;
  let bankB = 0;
  let leafA = 0;
  let leafA2 = 0;
  let leafB = 0;
  let leafY = 0;
  let expense = 0;
  let seq = 0;

  const leafOf = async (bankId: number) =>
    (await pool.query(`SELECT id FROM categories WHERE bank_account_id = $1`, [bankId])).rows[0].id as number;
  const accountOf = async (code: string) =>
    (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2 AND is_posting`, [orgX, code])).rows[0].id as number;
  /** In-books lines on `leafId` written under company `companyId`: their count and Σ (Dr − Cr). */
  const linesOn = async (leafId: number, companyId: string) => {
    const r = (await pool.query(
      `SELECT count(*)::int AS n, coalesce(sum(l.debit_amount - l.credit_amount), 0)::text AS net
         FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
        WHERE l.account_id = $1 AND e.company_id = $2 AND e.status IN ('posted','reversed')`, [leafId, companyId],
    )).rows[0];
    return { n: Number(r.n), net: Number(r.net) };
  };
  /** A manual journal body: Dr expense / Cr `creditAccount` for `amount`. */
  const journal = (creditAccount: number, amount = 100) => {
    seq += 1;
    return {
      entryNumber: `G55R-MJ-${seq}`,
      date: DATE,
      description: "G55 regression manual journal",
      lines: [
        { accountId: expense, accountName: "debit", debitAmount: amount, creditAmount: 0 },
        { accountId: creditAccount, accountName: "credit", debitAmount: 0, creditAmount: amount },
      ],
    };
  };
  /** FIXTURE: a manual journal as a pre-rule writer left it — a draft, or posted — in company A, Cr `creditAccount` 100. */
  async function preRuleEntry(creditAccount: number, status: "draft" | "posted"): Promise<number> {
    seq += 1;
    const id = (await pool.query(
      `INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status)
       VALUES ($1,$2,$3,$4,'G55 pre-rule fixture','draft') RETURNING id`, [orgX, coA, `G55R-OLD-${seq}`, DATE],
    )).rows[0].id as number;
    await pool.query(
      `INSERT INTO journal_entry_lines (organization_id, company_id, journal_entry_id, account_id, account_name, debit_amount, credit_amount)
       VALUES ($1,$2,$3,$4,'debit',100,0), ($1,$2,$3,$5,'credit',0,100)`, [orgX, coA, id, expense, creditAccount],
    );
    if (status === "posted") await pool.query(`UPDATE journal_entries SET status = 'posted', posted_at = now() WHERE id = $1`, [id]);
    return id;
  }

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await h.cleanup();
    orgX = await h.mkOrg("x");
    coA = await h.mkCompany(orgX, "G55 Reg A", "318282828282833"); // first-created: the company HTTP acts as
    coB = await h.mkCompany(orgX, "G55 Reg B", "318282828282843");
    const orgY = await h.mkOrg("y");
    const coY = await h.mkCompany(orgY, "G55 Reg Y", "318282828282853");
    adminId = await h.mkUser("admin", PW, orgX, "admin");
    bookkeeperId = await h.mkUser("bookkeeper", PW, orgX, "bookkeeper");
    await h.start();
    for (const who of ["admin", "bookkeeper"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
    const mkBankA = async (name: string) => {
      const r = await h.api("admin", "POST", "/bank-accounts", { name, bankName: "Al Rajhi", currency: "SAR", balance: 0, openingBalance: 0 });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.id as number;
    };
    bankA = await mkBankA("G55 Reg A Main");
    bankA2 = await mkBankA("G55 Reg A Reserve");
    bankB = (await h.inTenant(orgX, coB, adminId, () => bankAccountsService.create({ name: "G55 Reg B Main", bankName: "SNB", currency: "SAR" })) as { id: number }).id;
    const bankY = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'G55 Reg Y Main','ANB') RETURNING id`, [orgY, coY])).rows[0].id as number;
    [leafA, leafA2, leafB, leafY] = [await leafOf(bankA), await leafOf(bankA2), await leafOf(bankB), await leafOf(bankY)];
    expense = await accountOf("RENT_UTILITIES");
    // The premise: B's bank belongs to B, and every leaf is its own account.
    const owners = (await pool.query(`SELECT company_id FROM bank_accounts WHERE id = ANY($1::int[]) ORDER BY id`, [[bankA, bankA2, bankB]])).rows;
    expect(owners.map((r) => r.company_id)).toEqual([coA, coA, coB]);
    expect(new Set([leafA, leafA2, leafB, leafY]).size).toBe(4);
  }, 120_000);

  afterAll(async () => {
    await h.stop();
    await h.cleanup();
  });

  it("the rule in each company context: A finds B's leaf foreign, B finds A's, and no company context refuses both (fails closed)", async () => {
    const probe = () => bankLeavesOutsideCompany([leafA, leafB, expense]);
    expect([...(await h.inTenant(orgX, coA, adminId, probe)).keys()]).toEqual([leafB]);
    expect([...(await h.inTenant(orgX, coB, adminId, probe)).keys()]).toEqual([leafA]);
    const conn = await beginTenantConnection({ organizationId: orgX, companyId: null, role: "authenticated" });
    try {
      // The org-wide read sees BOTH banks (RLS's empty-company arm); the explicit company predicate matches neither.
      const banksSeen = await conn.run(async () => (await bankAccountsService.list()).length);
      expect(banksSeen, "the org-wide connection can see the banks — the refusal is the predicate's, not RLS's").toBeGreaterThanOrEqual(3);
      expect([...(await conn.run(probe)).keys()].sort((p, q) => p - q)).toEqual([leafA, leafB].sort((p, q) => p - q));
    } finally {
      await conn.rollback();
    }
  });

  it("DRAFTING: a manual journal naming B's leaf is refused at create, naming the line and the bank; nothing is written — A's own leaf is accepted", async () => {
    const body = journal(leafB);
    const refused = await h.api("bookkeeper", "POST", "/journal-entries", body);
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body).toMatchObject({ code: "reference_not_found", field: "lines[1].accountId" });
    expect(refused.body.error).toContain("G55 Reg B Main");
    expect(refused.body.error).toContain("another company");
    const written = (await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1 AND entry_number = $2`, [orgX, body.entryNumber])).rows[0].n;
    expect(written, "no draft row").toBe(0);

    const accepted = await h.api("bookkeeper", "POST", "/journal-entries", journal(leafA));
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    expect(accepted.body.status).toBe("draft");
  });

  it("DRAFTING: a bookkeeper's prepayment naming B's leaf is refused at create on balanceAccountId; no schedule is written", async () => {
    const reference = "G55R-RS-NEW";
    const refused = await h.api("bookkeeper", "POST", "/recognition-schedules", {
      kind: "prepayment", totalAmount: 300, periods: 3, startPeriod: "2026-10",
      description: "G55 regression prepayment", expenseAccountId: expense, balanceAccountId: leafB, reference,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body).toMatchObject({ code: "balance_account_unknown", field: "balanceAccountId" });
    expect(refused.body.error).toContain("G55 Reg B Main");
    const written = (await pool.query(`SELECT count(*)::int AS n FROM recognition_schedules WHERE organization_id = $1 AND reference = $2`, [orgX, reference])).rows[0].n;
    expect(written).toBe(0);
  });

  it("THE SEAM: postJournalEntry in company A refuses B's leaf for every caller, before anything is written; A's own leaf posts and moves", async () => {
    const before = { b: await linesOn(leafB, coA), a: await linesOn(leafA, coA) };
    const lines = (credit: number) => [
      { accountId: expense, accountName: "debit", debitAmount: 50, creditAmount: 0 },
      { accountId: credit, accountName: "credit", debitAmount: 0, creditAmount: 50 },
    ];
    await expect(
      h.inTenant(orgX, coA, adminId, () => postJournalEntry({ entryNumber: "G55R-SEAM-1", date: DATE, description: "seam", lines: lines(leafB) })),
    ).rejects.toMatchObject({ statusCode: 422, payload: { code: "reference_not_found", field: "lines[1].accountId" } });
    expect(await linesOn(leafB, coA), "absence: nothing on B's leaf in A's books").toEqual(before.b);
    const headers = (await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1 AND entry_number = 'G55R-SEAM-1'`, [orgX])).rows[0].n;
    expect(headers, "no header row either").toBe(0);

    await h.inTenant(orgX, coA, adminId, () => postJournalEntry({ entryNumber: "G55R-SEAM-2", date: DATE, description: "seam", lines: lines(leafA) }));
    expect(await linesOn(leafA, coA), "movement: A's own leaf").toEqual({ n: before.a.n + 1, net: before.a.net - 50 });
  });

  it("APPROVAL: a draft written before the rule (fixture) is refused when approved, against the entry's company; it stays a draft and posts nothing", async () => {
    const id = await preRuleEntry(leafB, "draft");
    const before = await linesOn(leafB, coA);
    const approved = await h.api("admin", "POST", `/journal-entries/${id}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(422);
    expect(approved.body).toMatchObject({ code: "reference_not_found", field: "lines[1].accountId" });
    const status = (await pool.query(`SELECT status FROM journal_entries WHERE id = $1`, [id])).rows[0].status;
    expect(status).toBe("draft");
    expect(await linesOn(leafB, coA)).toEqual(before);
  });

  it("RECOGNITION: a schedule written before the rule (fixture) is refused when recognised, and the month-end run reports it skipped and posts nothing for it", async () => {
    const reference = "G55R-RS-OLD";
    const id = (await pool.query(
      `INSERT INTO recognition_schedules (organization_id, company_id, reference, kind, description, expense_account_id, balance_account_id, total_amount, periods, start_period, status)
       VALUES ($1,$2,$3,'prepayment','G55 pre-rule schedule',$4,$5,300,3,'2026-10','draft') RETURNING id`, [orgX, coA, reference, expense, leafB],
    )).rows[0].id as number;
    const before = await linesOn(leafB, coA);
    const activated = await h.api("bookkeeper", "POST", `/recognition-schedules/${id}/activate`, {});
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);

    const recognised = await h.api("bookkeeper", "POST", `/recognition-schedules/${id}/recognise`, { period: "2026-10" });
    expect(recognised.status, JSON.stringify(recognised.body)).toBe(422);
    expect(recognised.body).toMatchObject({ code: "reference_not_found" });

    const run = await h.api("bookkeeper", "POST", "/recognition-schedules/runs", { period: "2026-10" });
    expect(run.status, JSON.stringify(run.body)).toBe(200);
    expect((run.body.posted as Array<{ reference: string }>).map((p) => p.reference)).not.toContain(reference);
    const skip = (run.body.skipped as Array<{ reference: string; reason: string }>).find((s) => s.reference === reference);
    expect(skip?.reason, "the run says why it skipped this schedule").toContain("another company");

    expect(await linesOn(leafB, coA)).toEqual(before);
    const rows = (await pool.query(`SELECT count(*)::int AS n FROM recognition_schedule_rows WHERE schedule_id = $1 AND journal_entry_id IS NOT NULL`, [id])).rows[0].n;
    expect(rows, "no period marked recognised").toBe(0);
  });

  it("REVERSAL: an entry POSTED before the rule (fixture) can still be reversed — the correction stays open, and B's leaf nets to zero in A's books", async () => {
    const before = await linesOn(leafB, coA);
    const id = await preRuleEntry(leafB, "posted");
    expect(await linesOn(leafB, coA), "the pre-rule entry is in A's books").toEqual({ n: before.n + 1, net: before.net - 100 });
    const reversed = await h.api("admin", "POST", `/journal-entries/${id}/reverse`, { reason: "G55: posted on another company's bank" });
    expect(reversed.status, JSON.stringify(reversed.body)).toBeLessThan(300);
    expect(await linesOn(leafB, coA), "movement back to where it was").toEqual({ n: before.n + 2, net: before.net });
  });

  it("UNCHANGED: the company's own INACTIVE bank still takes a manual journal — no new restriction", async () => {
    const off = await h.api("admin", "PATCH", `/bank-accounts/${bankA2}`, { isActive: false });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect((await pool.query(`SELECT is_active FROM bank_accounts WHERE id = $1`, [bankA2])).rows[0].is_active).toBe(false);
    const before = await linesOn(leafA2, coA);
    const created = await h.api("bookkeeper", "POST", "/journal-entries", journal(leafA2));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const approved = await h.api("admin", "POST", `/journal-entries/${created.body.id}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await linesOn(leafA2, coA)).toEqual({ n: before.n + 1, net: before.net - 100 });
  });

  it("UNCHANGED, and symmetric: company B posts to its OWN bank (movement in B, absence in A), and B naming A's leaf is refused", async () => {
    const before = { inB: await linesOn(leafB, coB), inA: await linesOn(leafB, coA) };
    const draft = (await h.inTenant(orgX, coB, bookkeeperId, () => journalEntriesService.create(journal(leafB), bookkeeperId))) as { id: number };
    await h.inTenant(orgX, coB, adminId, () => journalEntriesService.approve(draft.id, adminId));
    expect(await linesOn(leafB, coB), "movement: B's own bank, in B's books").toEqual({ n: before.inB.n + 1, net: before.inB.net - 100 });
    expect(await linesOn(leafB, coA), "absence: nothing new in A's books").toEqual(before.inA);

    await expect(
      h.inTenant(orgX, coB, bookkeeperId, () => journalEntriesService.create(journal(leafA), bookkeeperId)),
    ).rejects.toMatchObject({ statusCode: 422, payload: { code: "reference_not_found", field: "lines[1].accountId" } });
  });

  it("UNCHANGED: another ORGANISATION's bank leaf is still G04's refusal, which names nothing of that organisation", async () => {
    const refused = await h.api("bookkeeper", "POST", "/journal-entries", journal(leafY));
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body).toMatchObject({ code: "reference_not_found", field: "lines[1].accountId" });
    expect(refused.body.error).toBe("Line 2 names an account that does not exist for this organization.");
    expect(JSON.stringify(refused.body)).not.toContain("G55 Reg Y Main");
  });
});
