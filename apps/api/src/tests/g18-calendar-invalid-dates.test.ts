/**
 * 🔴 G18 (calendar half, Phase 18 B-SMALL-2) — a calendar-INVALID date
 * (`2026-02-31`, `2026-04-31`) is refused at every posting path, and nothing
 * is posted.
 *
 * `journal_entries.date` is `text` under a FORMAT-only CHECK (0071:
 * `^\d{4}-\d{2}-\d{2}$`), and the posting seam validated no date, so a string
 * shaped like a date but naming no day reached the ledger: dated in no month
 * any report reads, and `checkPeriodOpen` slices `2026-02` off it and finds that
 * month open. Paths whose OTHER table holds a Postgres `date` column (bill
 * payments, transfers, supplier payments) failed instead as a raw 500 from the
 * cast, never a refusal that names the date.
 *
 * Fix-neutral invariant, per path, through the product's own HTTP endpoints:
 * the request answers 4xx, and the ledger is exactly as it was (entries, lines,
 * every document row the path writes, and no journal date in the organisation
 * that is not a real calendar day). The reversal-date RULE (before the
 * original? which day?) is DR-32 / AQ-5 and is not asserted here: every date
 * used is in an open month and after its original.
 *
 * Anti-vacuity: (1) the date predicate below is checked against a known-bad
 * and a known-good day; (2) the journal-entry CREATE path, which already
 * refused a non-day, is the known-present refusal the instrument must see;
 * (3) every path ends with a CONTROL — the same request with a real date —
 * that succeeds and moves the ledger, so the refusal is the date's alone.
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3214";
process.env.SESSION_SECRET ??= "g18-calendar-invalid-dates-proof-0000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness, type Res } from "./helpers/g04Harness";
import { postJournalEntry } from "../services/accounting/glPosting";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "G18CalendarProofPw123!";

/** Not real calendar days: shaped `YYYY-MM-DD`, so a format check alone admits them. */
const INVALID = ["2026-02-31", "2026-04-31"] as const;
/** Real days in an open month, after every original they reverse or pay. */
const VALID = "2026-10-15";
const DOC_DATE = "2026-10-01";

/** The test's OWN definition of a real day — independent of the code under test. */
function isRealDay(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

describeMaybe("G18 — a calendar-invalid date is refused at every posting path, and nothing is posted", () => {
  const h = g04Harness("g18cal");
  let orgId = "";
  let companyId = "";
  let adminId = 0;
  let vendorId = 0;
  let bankA = 0;
  let bankB = 0;
  let expenseAcct = 0;
  let incomeAcct = 0;
  let seq = 0;
  const next = () => String(++seq).padStart(3, "0");

  /** Everything a posting path could write, for this organisation. */
  async function ledger() {
    const counts = (await pool.query(
      `SELECT (SELECT count(*)::int FROM journal_entries WHERE organization_id = $1) AS entries,
              (SELECT count(*)::int FROM journal_entries WHERE organization_id = $1 AND status = 'reversed') AS reversed_entries,
              (SELECT count(*)::int FROM journal_entry_lines WHERE organization_id = $1) AS lines,
              (SELECT coalesce(sum(debit_amount), 0)::text FROM journal_entry_lines WHERE organization_id = $1) AS debits,
              (SELECT count(*)::int FROM bank_transfers WHERE organization_id = $1) AS transfers,
              (SELECT count(*)::int FROM bank_transfer_reversals WHERE organization_id = $1) AS transfer_reversals,
              (SELECT count(*)::int FROM bill_payments WHERE organization_id = $1) AS bill_payments,
              (SELECT coalesce(sum(paid_amount), 0)::text FROM bills WHERE organization_id = $1) AS bills_paid,
              (SELECT count(paid_at)::int FROM bills WHERE organization_id = $1) AS bills_with_paid_at,
              (SELECT count(*)::int FROM supplier_payments WHERE organization_id = $1) AS supplier_payments`,
      [orgId],
    )).rows[0];
    const dates = (await pool.query(`SELECT DISTINCT date FROM journal_entries WHERE organization_id = $1`, [orgId])).rows.map((r) => r.date as string);
    return { ...counts, nonDayDates: dates.filter((d) => !isRealDay(d)).sort() };
  }

  type Outcome = { date: string; status: number; body: unknown; moved: boolean };

  /**
   * Send each invalid date, recording what the path answered and whether the
   * ledger moved — ALL of them before asserting, so a red run shows every path's
   * answer (the evidence), not only the first failure.
   */
  async function probe(label: string, send: (date: string) => Promise<Res>): Promise<Outcome[]> {
    const out: Outcome[] = [];
    for (const date of INVALID) {
      const before = await ledger();
      const r = await send(date);
      const after = await ledger();
      const moved = JSON.stringify(after) !== JSON.stringify(before);
      // eslint-disable-next-line no-console
      console.log(`[G18] ${label} ${date} -> ${r.status} ${JSON.stringify(r.body)}${moved ? ` MOVED ${JSON.stringify({ before, after })}` : ""}`);
      out.push({ date, status: r.status, body: r.body, moved });
    }
    return out;
  }

  function expectRefusedNothingMoved(label: string, outcomes: Outcome[]) {
    expect(
      outcomes.map((o) => ({ date: o.date, refused4xx: o.status >= 400 && o.status < 500, moved: o.moved })),
      `${label}: ${JSON.stringify(outcomes)}`,
    ).toEqual(INVALID.map((date) => ({ date, refused4xx: true, moved: false })));
  }

  /** A posted manual journal (create → approve), the generic reverse's subject. */
  async function postedJournal(): Promise<{ id: number; entryNumber: string }> {
    const n = `G18-JE-${next()}`;
    const created = await h.api("admin", "POST", "/journal-entries", {
      entryNumber: n, date: DOC_DATE, description: "G18 proof",
      lines: [
        { accountId: expenseAcct, accountName: "debit", debitAmount: 100, creditAmount: 0 },
        { accountId: incomeAcct, accountName: "credit", debitAmount: 0, creditAmount: 100 },
      ],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const approved = await h.api("admin", "POST", `/journal-entries/${created.body.id}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    return { id: created.body.id as number, entryNumber: n };
  }

  /** An approved bill, through the product's HTTP paths. */
  async function approvedBill(): Promise<number> {
    const no = `G18-B${next()}`;
    const created = await h.api("admin", "POST", "/bills", {
      supplierDocumentKind: "tax_invoice", vendorReference: `${no}-SUP`, billNumber: no, date: DOC_DATE, dueDate: "2026-10-31", vendorId,
      items: [{ description: "Supplies", quantity: 1, unitPrice: 1_000, vatRate: 15 }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const approved = await h.api("admin", "POST", `/bills/${created.body.id}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    return created.body.id as number;
  }

  /** A posted transfer at a real date (amount varied, so the duplicate guard never answers instead). */
  async function postedTransfer(amount: number): Promise<number> {
    const r = await h.api("admin", "POST", "/bank-transfers", { fromBankAccountId: bankA, toBankAccountId: bankB, amount, transferDate: DOC_DATE });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.id as number;
  }

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "G18 Calendar Co", "318181818181885");
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'G18 Supplier','300000000000003') RETURNING id`, [orgId])).rows[0].id;
    adminId = await h.mkUser("admin", PW, orgId, "admin");
    const acct = async (code: string) =>
      (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2 AND is_posting`, [orgId, code])).rows[0].id as number;
    expenseAcct = await acct("RENT_UTILITIES");
    incomeAcct = await acct("OTHER_INCOME");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
    for (const [name, set] of [["G18 Ops A", (id: number) => { bankA = id; }], ["G18 Ops B", (id: number) => { bankB = id; }]] as const) {
      const b = await h.api("admin", "POST", "/bank-accounts", { name, bankName: "SNB", currency: "SAR" });
      expect(b.status, JSON.stringify(b.body)).toBe(201);
      set(b.body.id);
    }
  }, 120_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("INSTRUMENT: the test's day predicate rejects a non-day and accepts real ones (incl. a leap day)", () => {
    expect(INVALID.map(isRealDay)).toEqual([false, false]);
    expect(["2026-02-28", "2026-04-30", "2028-02-29", VALID, DOC_DATE].map(isRealDay)).toEqual([true, true, true, true, true]);
    expect(isRealDay("2026-02-29")).toBe(false);
  });

  it("KNOWN-PRESENT: the journal-entry CREATE path refuses a non-day (the refusal the instrument must see), and a real day is accepted", async () => {
    const outcomes = await probe("POST /journal-entries", (date) =>
      h.api("admin", "POST", "/journal-entries", {
        entryNumber: `G18-JC-${next()}`, date, description: "G18 known-present",
        lines: [
          { accountId: expenseAcct, accountName: "debit", debitAmount: 10, creditAmount: 0 },
          { accountId: incomeAcct, accountName: "credit", debitAmount: 0, creditAmount: 10 },
        ],
      }));
    expectRefusedNothingMoved("POST /journal-entries", outcomes);
    const before = await ledger();
    await postedJournal();
    const after = await ledger();
    expect(after.entries, "CONTROL: a real day creates and posts").toBe(before.entries + 1);
  });

  it("🔴 PROOF (the posting seam): postJournalEntry refuses a non-day for EVERY caller; a real day posts", async () => {
    const outcomes: Outcome[] = [];
    for (const date of INVALID) {
      const before = await ledger();
      let status = 200;
      let body: unknown = null;
      try {
        const je = await h.inTenant(orgId, companyId, adminId, () =>
          postJournalEntry({
            entryNumber: `G18-SEAM-${next()}`, date, description: "G18 seam",
            lines: [
              { accountId: expenseAcct, accountName: "debit", debitAmount: 25, creditAmount: 0 },
              { accountId: incomeAcct, accountName: "credit", debitAmount: 0, creditAmount: 25 },
            ],
          }));
        body = { id: je.id, date: je.date };
      } catch (err) {
        const e = err as { statusCode?: number; payload?: unknown; message?: string };
        status = e.statusCode ?? 500;
        body = e.payload ?? { error: e.message };
      }
      const after = await ledger();
      const moved = JSON.stringify(after) !== JSON.stringify(before);
      // eslint-disable-next-line no-console
      console.log(`[G18] seam postJournalEntry ${date} -> ${status} ${JSON.stringify(body)}${moved ? ` MOVED ${JSON.stringify({ before, after })}` : ""}`);
      outcomes.push({ date, status, body, moved });
    }
    expectRefusedNothingMoved("seam postJournalEntry", outcomes);

    const before = await ledger();
    const je = await h.inTenant(orgId, companyId, adminId, () =>
      postJournalEntry({
        entryNumber: `G18-SEAM-${next()}`, date: VALID, description: "G18 seam control",
        lines: [
          { accountId: expenseAcct, accountName: "debit", debitAmount: 25, creditAmount: 0 },
          { accountId: incomeAcct, accountName: "credit", debitAmount: 0, creditAmount: 25 },
        ],
      }));
    expect(je.date).toBe(VALID);
    expect((await ledger()).entries, "CONTROL: a real day posts through the seam").toBe(before.entries + 1);
  });

  it("🔴 PROOF (the generic reverse): POST /journal-entries/:id/reverse refuses a non-day; a real day reverses", async () => {
    // One posted original per date, so an accepted (red) reversal of the first cannot make the second refuse for another reason.
    const originals = new Map<string, number>();
    for (const d of INVALID) originals.set(d, (await postedJournal()).id);
    const outcomes = await probe("POST /journal-entries/:id/reverse", (date) =>
      h.api("admin", "POST", `/journal-entries/${originals.get(date)}/reverse`, { reason: "G18 proof", date }));
    expectRefusedNothingMoved("POST /journal-entries/:id/reverse", outcomes);

    const target = (await postedJournal()).id;
    const before = await ledger();
    const ok = await h.api("admin", "POST", `/journal-entries/${target}/reverse`, { reason: "G18 control", date: VALID });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const after = await ledger();
    expect([after.entries, after.reversed_entries], "CONTROL: one mirror posted, the original marked reversed").toEqual([before.entries + 1, before.reversed_entries + 1]);
    expect((await pool.query(`SELECT date FROM journal_entries WHERE reversal_of = $1`, [target])).rows.map((r) => r.date)).toEqual([VALID]);
  });

  it("🔴 PROOF (transfers): POST /bank-transfers refuses a non-day; a real day records one transfer", async () => {
    let amount = 300;
    const outcomes = await probe("POST /bank-transfers", (date) =>
      h.api("admin", "POST", "/bank-transfers", { fromBankAccountId: bankA, toBankAccountId: bankB, amount: amount++, transferDate: date }));
    expectRefusedNothingMoved("POST /bank-transfers", outcomes);

    const before = await ledger();
    const ok = await h.api("admin", "POST", "/bank-transfers", { fromBankAccountId: bankA, toBankAccountId: bankB, amount: 399, transferDate: VALID });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const after = await ledger();
    expect([after.transfers, after.entries], "CONTROL: one transfer, one entry").toEqual([before.transfers + 1, before.entries + 1]);
  });

  it("🔴 PROOF (transfer reversal): POST /bank-transfers/:id/reverse refuses a non-day; a real day reverses", async () => {
    const transfers = new Map<string, number>();
    let amount = 500;
    for (const d of INVALID) transfers.set(d, await postedTransfer(amount++));
    const outcomes = await probe("POST /bank-transfers/:id/reverse", (date) =>
      h.api("admin", "POST", `/bank-transfers/${transfers.get(date)}/reverse`, { reason: "G18 proof", date }));
    expectRefusedNothingMoved("POST /bank-transfers/:id/reverse", outcomes);

    const target = await postedTransfer(599);
    const before = await ledger();
    const ok = await h.api("admin", "POST", `/bank-transfers/${target}/reverse`, { reason: "G18 control", date: VALID });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const after = await ledger();
    expect([after.transfer_reversals, after.entries], "CONTROL: one reversal row, one mirror").toEqual([before.transfer_reversals + 1, before.entries + 1]);
  });

  it("🔴 PROOF (bill pay): POST /bills/:id/pay refuses a non-day paidAt; a real day pays", async () => {
    const bills = new Map<string, number>();
    for (const d of INVALID) bills.set(d, await approvedBill());
    const outcomes = await probe("POST /bills/:id/pay", (date) =>
      h.api("admin", "POST", `/bills/${bills.get(date)}/pay`, { amount: 200, paidAt: date, bankAccountId: bankA }));
    expectRefusedNothingMoved("POST /bills/:id/pay", outcomes);

    const target = await approvedBill();
    const before = await ledger();
    const ok = await h.api("admin", "POST", `/bills/${target}/pay`, { amount: 200, paidAt: VALID, bankAccountId: bankA });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const after = await ledger();
    expect([after.bill_payments, after.entries], "CONTROL: one payment row, one entry").toEqual([before.bill_payments + 1, before.entries + 1]);
    expect((await pool.query(`SELECT paid_at::text AS d FROM bill_payments WHERE bill_id = $1`, [target])).rows.map((r) => r.d)).toEqual([VALID]);
  });

  it("🔴 PROOF (a seam-only path): POST /supplier-payments refuses a non-day paidAt; a real day pays", async () => {
    let amount = 70;
    const outcomes = await probe("POST /supplier-payments", (date) =>
      h.api("admin", "POST", "/supplier-payments", { vendorId, amount: amount++, bankAccountId: bankA, paidAt: date, classification: "advance" }));
    expectRefusedNothingMoved("POST /supplier-payments", outcomes);

    const before = await ledger();
    const ok = await h.api("admin", "POST", "/supplier-payments", { vendorId, amount: 79, bankAccountId: bankA, paidAt: VALID, classification: "advance" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const after = await ledger();
    expect([after.supplier_payments, after.entries], "CONTROL: one supplier payment, one entry").toEqual([before.supplier_payments + 1, before.entries + 1]);
  });

  it("INVARIANT: no journal entry in the organisation is dated on a day that does not exist", async () => {
    const l = await ledger();
    expect(l.entries, "the suite posted real entries (non-vacuous)").toBeGreaterThan(5);
    expect(l.nonDayDates).toEqual([]);
  });
});
