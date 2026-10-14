/**
 * PHASE 18 · S1 · DR-42 PROOF (research OBS-2; contract G55 / NF-2): a posting
 * in company A that names company B's bank GL leaf, in the SAME organisation.
 * PROOF ONLY, NOT A FIX.
 *
 * Authorised by the owner on 2026-10-11 ("Phase 18 S1: proof tests only").
 * Definition: the owner decision register, DR-42 ("keep G55 in T0 … Add the
 * recognition path to its proof test"; "Consider HIGH if the bookkeeper
 * recognition path is reproduced"); the contract, G55 ("a manual JE can post
 * to the same organization's other company's bank GL leaf", "NO TEST FOUND")
 * and SG-6 ("every line on a bank leaf resolves to an active bank of the
 * active company, whether named by bankAccountId or by accountId"); research
 * §6.16 OBS-2.
 *
 * The mechanism (read at HEAD 44427b23):
 *  - categories (GL accounts) have NO company_id. Their RLS is organisation-
 *    only, so company A sees company B's bank leaf (`categories.bank_account_id`,
 *    created by trigger 0073 `ensure_bank_gl_account`);
 *  - the seam's `bankAccountId` arm is company-bounded (glPosting.ts:208-225,
 *    an INNER JOIN on RLS-scoped bank_accounts). The `accountId` arm checks only
 *    ORGANISATION ownership, header and party codes (glPosting.ts:348-367;
 *    tenantReferences.ts:26-29, 54-62);
 *  - (a) a MANUAL JOURNAL names accounts by `accountId` only
 *    (journalEntries.service.ts; .approvable.ts): drafted by a bookkeeper,
 *    posted by an approver;
 *  - (b) a RECOGNITION SCHEDULE (prepayment) accepts any `asset`-type account as
 *    its balance account (recognitionSchedules.service.ts:39, 76-85), and a bank
 *    leaf is type `asset`. Create, activate and recognise all resolve to the
 *    `create` action (rbac.ts:61), so a BOOKKEEPER posts it with no approver.
 *
 * HTTP always acts as the organisation's FIRST-created company
 * (lib/tenant.ts:129-135), which here is company A. Company B is reached only
 * through its own tenant transaction, for its bank and for what B itself sees.
 *
 * The SAFE invariant (SG-6): **nothing posted in company A names company B's
 * bank leaf.** It is asserted after each path, presence/absence/movement-style:
 *  - CONTROL (movement): the same paths naming A's OWN leaf, or a normal
 *    prepayment account, do post and move A's figures;
 *  - CONTROL (refusal exists): the same paths naming ANOTHER ORGANISATION's
 *    bank leaf are refused (the G04 boundary), so the probe can see a refusal.
 *
 * 🔴 On unmodified code this proof FAILED BY DESIGN: S1, 2026-10-11, and again
 * on 2026-10-13 after #194 — both PROOFs red (−SAR 100.00 on B's leaf in A's
 * books by each path; B's own figure 0.00), all four CONTROLs green. It lands,
 * with its assertions unchanged, together with the owner-authorised G55 fix
 * (2026-10-14: a bank's cash account takes entries only from its own company —
 * `assertBankLeavesInCompany`, services/accounting/tenantReferences.ts, held at
 * drafting, at the posting seam and at manual-journal approval), as that fix's
 * regression proof. It must never be weakened to pass; see also
 * `g55-cross-company-bank-leaf.test.ts`.
 *
 * DB-backed; skips on the DB-free placeholder.
 */

process.env.PORT ??= "3144";
process.env.SESSION_SECRET ??= "phase18-s1-dr42-proof-session-secret-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { __resetRateLimitsForTests } from "../routes/auth";
import { bankAccountsService } from "../services/bankAccounts.service";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PW = "S1DR42ProofPw123!";

describeMaybe("Phase 18 S1 · DR-42 proof — company A posting to company B's bank leaf (same organisation)", () => {
  const h = g04Harness("s1dr42");
  let orgX = "";
  let coA = "";
  let coB = "";
  let orgY = "";
  let adminId = 0;
  let bankA = 0;
  let bankB = 0;
  let leafA = 0;
  let leafB = 0;
  let leafY = 0;
  let expense = 0;
  let prepaid = 0;
  let seq = 0;

  const leafOf = async (bankId: number) =>
    (await pool.query(`SELECT id FROM categories WHERE bank_account_id = $1`, [bankId])).rows[0].id as number;
  const accountOf = async (code: string) =>
    (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2 AND is_posting`, [orgX, code])).rows[0].id as number;
  /** In-books lines on `leafId` posted under company `companyId`: their count and Σ (Dr − Cr). */
  const linesOn = async (leafId: number, companyId: string) => {
    const r = (await pool.query(
      `SELECT count(*)::int AS n, coalesce(sum(l.debit_amount - l.credit_amount), 0)::text AS net
         FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
        WHERE l.account_id = $1 AND e.company_id = $2 AND e.status IN ('posted','reversed')`, [leafId, companyId],
    )).rows[0];
    return { n: Number(r.n), net: Number(r.net) };
  };
  /** What company B ITSELF sees for its bank: the product's own read, in B's tenant transaction. */
  const bLedgerBalance = async () =>
    (await h.inTenant(orgX, coB, adminId, () => bankAccountsService.getById(bankB)) as { ledgerBalance: number | null }).ledgerBalance;
  /** Manual journal Dr expense / Cr `creditAccount` 100: drafted by the bookkeeper, approved by the admin. */
  async function manualJournal(creditAccount: number) {
    seq += 1;
    const created = await h.api("bookkeeper", "POST", "/journal-entries", {
      entryNumber: `S1D42-MJ-${seq}`,
      date: "2026-10-05",
      description: "S1 DR-42 manual journal",
      lines: [
        { accountId: expense, accountName: "debit", debitAmount: 100, creditAmount: 0 },
        { accountId: creditAccount, accountName: "credit", debitAmount: 0, creditAmount: 100 },
      ],
    });
    const approved = created.status === 201 ? await h.api("admin", "POST", `/journal-entries/${created.body.id}/approve`, {}) : null;
    return { create: [created.status, created.body?.code ?? null], approve: approved ? [approved.status, approved.body?.code ?? null] : null };
  }
  /** Prepayment 300 over 3 months from 2026-10, with `balanceAccount`: created, activated and recognised by the BOOKKEEPER. */
  async function bookkeeperPrepayment(balanceAccount: number) {
    seq += 1;
    const created = await h.api("bookkeeper", "POST", "/recognition-schedules", {
      kind: "prepayment", totalAmount: 300, periods: 3, startPeriod: "2026-10",
      description: "S1 DR-42 prepayment", expenseAccountId: expense, balanceAccountId: balanceAccount, reference: `S1D42-RS-${seq}`,
    });
    if (created.status !== 201) return { create: [created.status, created.body?.code ?? null], activate: null, recognise: null };
    const activated = await h.api("bookkeeper", "POST", `/recognition-schedules/${created.body.id}/activate`, {});
    const recognised = await h.api("bookkeeper", "POST", `/recognition-schedules/${created.body.id}/recognise`, { period: "2026-10" });
    return {
      create: [created.status, null],
      activate: [activated.status, activated.body?.code ?? null],
      recognise: [recognised.status, recognised.body?.code ?? null, recognised.body?.journalEntryId ?? null],
    };
  }

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await h.cleanup();
    orgX = await h.mkOrg("x");
    coA = await h.mkCompany(orgX, "S1 DR42 A", "318181818181833"); // first-created: the company HTTP acts as
    coB = await h.mkCompany(orgX, "S1 DR42 B", "318181818181843");
    orgY = await h.mkOrg("y");
    const coY = await h.mkCompany(orgY, "S1 DR42 Y", "318181818181853");
    adminId = await h.mkUser("admin", PW, orgX, "admin");
    await h.mkUser("bookkeeper", PW, orgX, "bookkeeper");
    await h.start();
    for (const who of ["admin", "bookkeeper"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
    // A's bank over HTTP (A is the request company); B's bank in B's own tenant transaction; Y's bank as a fixture.
    const a = await h.api("bookkeeper", "POST", "/bank-accounts", { name: "S1 DR42 A Main", bankName: "Al Rajhi", currency: "SAR", balance: 0, openingBalance: 0 });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    bankA = a.body.id;
    bankB = (await h.inTenant(orgX, coB, adminId, () => bankAccountsService.create({ name: "S1 DR42 B Main", bankName: "SNB", currency: "SAR" })) as { id: number }).id;
    const bankY = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'S1 DR42 Y Main','ANB') RETURNING id`, [orgY, coY])).rows[0].id as number;
    [leafA, leafB, leafY] = [await leafOf(bankA), await leafOf(bankB), await leafOf(bankY)];
    expense = await accountOf("RENT_UTILITIES");
    prepaid = await accountOf("PREPAID_EXPENSES");
    // The premise of the whole file: B's bank belongs to B, and its leaf is a different account from A's.
    const owners = (await pool.query(`SELECT id, company_id FROM bank_accounts WHERE id = ANY($1::int[]) ORDER BY id`, [[bankA, bankB]])).rows;
    expect(owners.map((r) => r.company_id)).toEqual([coA, coB]);
    expect(new Set([leafA, leafB, leafY]).size).toBe(3);
  }, 120_000);

  afterAll(async () => {
    await h.stop();
    await h.cleanup();
  });

  it("CONTROL (movement): a manual journal crediting A's OWN bank leaf posts, and moves A's bank by −100", async () => {
    const before = await linesOn(leafA, coA);
    const r = await manualJournal(leafA);
    const after = await linesOn(leafA, coA);
    // eslint-disable-next-line no-console
    console.warn("[S1 DR42] CONTROL manual journal → A's own leaf", JSON.stringify({ r, before, after }));
    expect(r.create[0]).toBe(201);
    expect(r.approve?.[0]).toBe(200);
    expect(after.n - before.n).toBe(1);
    expect(Math.round((after.net - before.net) * 100) / 100).toBe(-100);
  });

  it("CONTROL (refusal exists): a manual journal crediting ANOTHER ORGANISATION's bank leaf is refused, nothing posted", async () => {
    const r = await manualJournal(leafY);
    // eslint-disable-next-line no-console
    console.warn("[S1 DR42] CONTROL manual journal → org Y's leaf", JSON.stringify(r));
    expect(r.create[0]).toBe(422);
    expect(await linesOn(leafY, coA)).toEqual({ n: 0, net: 0 });
  });

  it("🔴 PROOF (a): a manual journal in company A naming company B's bank leaf — nothing is posted on B's leaf in A's books", async () => {
    const bBefore = await bLedgerBalance();
    const r = await manualJournal(leafB);
    const evidence = {
      r,
      linesOnLeafBInA: await linesOn(leafB, coA),
      linesOnLeafBInB: await linesOn(leafB, coB),
      bLedgerBalanceSeenByB: { before: bBefore, after: await bLedgerBalance() },
      bankIdentityRows: (await pool.query(
        `SELECT v.bank_account_id, v.company_id AS posting_company, (v.debit_amount - v.credit_amount)::text AS net
           FROM journal_line_bank_identity v WHERE v.bank_account_id = $1`, [bankB],
      )).rows,
    };
    // eslint-disable-next-line no-console
    console.warn("[S1 DR42] PROOF (a) manual journal → B's leaf", JSON.stringify(evidence));
    expect.soft(evidence.linesOnLeafBInA, "no line in company A's books may name company B's bank leaf").toEqual({ n: 0, net: 0 });
  });

  it("CONTROL (movement): a BOOKKEEPER prepayment on PREPAID_EXPENSES is created, activated and recognised — posted with no approver", async () => {
    const before = await linesOn(prepaid, coA);
    const r = await bookkeeperPrepayment(prepaid);
    const after = await linesOn(prepaid, coA);
    // eslint-disable-next-line no-console
    console.warn("[S1 DR42] CONTROL bookkeeper prepayment → PREPAID_EXPENSES", JSON.stringify({ r, before, after }));
    expect(r.create[0]).toBe(201);
    expect(r.activate?.[0]).toBe(200);
    expect(r.recognise?.[0]).toBe(200);
    expect(Math.round((after.net - before.net) * 100) / 100).toBe(-100);
  });

  it("CONTROL (refusal exists): a bookkeeper prepayment naming ANOTHER ORGANISATION's bank leaf is refused at create", async () => {
    const r = await bookkeeperPrepayment(leafY);
    // eslint-disable-next-line no-console
    console.warn("[S1 DR42] CONTROL bookkeeper prepayment → org Y's leaf", JSON.stringify(r));
    expect(r.create[0]).toBe(422);
    expect(await linesOn(leafY, coA)).toEqual({ n: 0, net: 0 });
  });

  it("🔴 PROOF (b): a BOOKKEEPER prepayment in company A naming company B's bank leaf — nothing is posted on B's leaf in A's books", async () => {
    const before = await linesOn(leafB, coA);
    const bBefore = await bLedgerBalance();
    const r = await bookkeeperPrepayment(leafB);
    const after = await linesOn(leafB, coA);
    const evidence = {
      r,
      linesOnLeafBInA: { before, after },
      bLedgerBalanceSeenByB: { before: bBefore, after: await bLedgerBalance() },
    };
    // eslint-disable-next-line no-console
    console.warn("[S1 DR42] PROOF (b) bookkeeper prepayment → B's leaf", JSON.stringify(evidence));
    expect.soft(after.n - before.n, "a bookkeeper's recognition must not post on company B's bank leaf from company A").toBe(0);
    expect.soft(Math.round((after.net - before.net) * 100) / 100, "company B's bank leaf must not move in company A's books").toBe(0);
  });
});
