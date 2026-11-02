/**
 * 🔴 Phase 18 R-10 — DR-34, finished under its accepted rule (memo §2a; register §11.109): "Refuse the generic
 * reverse for every type that has, or gets, its own correction path." For EVERY T1d source type, the generic reverse
 * (`journalEntriesService.reverse`, the one mirror writer) either refuses the entry in words that NAME the type's own
 * correction path, or reverses it keeping the mirror's attribution and its link.
 *
 *  - THE MATRIX: one posted entry per source type, planted through the posting seam (the product's own writer) with a
 *    source id that names no document, so only the entry's RECORDED SOURCE TYPE can identify it — the case of a writer
 *    that forgets its owner's link, which a type-level rule exists to hold. A manual and a recurring entry go through
 *    their own create + approve, and a mirror through the generic reverse itself.
 *  - THE SIX NEWLY REFUSED TYPES, ALSO FROM REAL ROWS: each produced by its own product path (a receipt's allocation,
 *    a credit note's application, a receipt's classification, a supplier advance's allocation, a supplier payment's
 *    classification, a VAT return's filing), then refused by name.
 *  - Refused: 409, the words name the path, nothing written, the original still `posted`.
 *  - Allowed: the mirror is sourced `reversal` from the original (`source_id` and `reversal_of`), created by the actor,
 *    dated today (DR-32: at discovery), posted, with its audit row by the actor; the original reads `reversed`.
 *
 * Two types stay allowed as QUESTIONS for the owner (§11.109 #10, #18): a customer allocation correction and a
 * supplier allocation reversal are themselves corrections that nothing undoes.
 *
 * The services run in-process inside real tenant transactions (the app role, RLS on), as the request runs them.
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3219";
process.env.SESSION_SECRET ??= "r10-dr34-source-type-matrix-00000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, JOURNAL_SOURCE_TYPES, type JournalSourceType } from "@workspace/db";
import { businessToday } from "@workspace/shared";
import { g04Harness } from "./helpers/g04Harness";
import { createApproved } from "./helpers/createApproved";
import { postJournalEntry } from "../services/accounting/glPosting";
import { journalEntriesService } from "../services/journalEntries.service";
import { invoicesService } from "../services/invoices.service";
import { paymentsService } from "../services/payments.service";
import { bankAccountsService } from "../services/bankAccounts.service";
import { billsService } from "../services/bills.service";
import { supplierPaymentsService } from "../services/accounting/supplierPayments.service";
import { periodRecordsService } from "../services/periodRecords.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const DATE = "2026-06-15";
/** A planted entry's source id: positive (0149), and naming no document of any table. */
const PLANTED = 2_100_000_000;

/** The words each correction path is named by. A refusal must name its path. */
const NAMES = {
  creditNote: /credit or debit note/i,
  writeOff: /bad debt/i,
  unallocate: /Unallocate/,
  classifyReceipt: /Classify the receipt again/i,
  classifyPayment: /Classify the payment again/i,
  reverseAllocation: /Reverse the allocation/i,
  amendFiling: /amendment of the filing/i,
  supplierCreditNote: /supplier credit note/i,
  vatMovement: /new VAT movement/i,
  reverseTransfer: /Reverse the transfer/i,
  statementLine: /statement line/i,
  computation: /revising and approving the computation/i,
  remittance: /Reverse the remittance/i,
  itselfCorrection: /itself the correction/i,
  mirror: /itself the reversal of another entry/i,
  migration: /migration workspace/i,
} as const;

type Decision = { refused: RegExp } | { allowed: true; question: boolean };
const refused = (words: RegExp): Decision => ({ refused: words });
const allowed: Decision = { allowed: true, question: false };
const question: Decision = { allowed: true, question: true };

/** Register §11.109's table, one row per T1d source type (the compiler holds every type present, the first case only those). */
const MATRIX: Record<JournalSourceType, Decision> = {
  manual: allowed,
  recurring: allowed,
  reversal: refused(NAMES.mirror),
  invoice: refused(NAMES.creditNote),
  invoice_correction: refused(NAMES.creditNote),
  invoice_write_off: refused(NAMES.writeOff),
  credit_note_application: refused(NAMES.unallocate),
  customer_payment: allowed,
  customer_payment_allocation: refused(NAMES.unallocate),
  customer_allocation_correction: question,
  customer_refund: allowed,
  customer_payment_reclassification: refused(NAMES.classifyReceipt),
  bill: refused(NAMES.supplierCreditNote),
  bill_payment: allowed,
  vat_evidence: refused(NAMES.vatMovement),
  supplier_payment: allowed,
  supplier_advance_allocation: refused(NAMES.reverseAllocation),
  supplier_allocation_reversal: question,
  supplier_payment_reclassification: refused(NAMES.classifyPayment),
  supplier_refund: allowed,
  bank_transfer: refused(NAMES.reverseTransfer),
  bank_transaction: refused(NAMES.statementLine),
  payroll_run: allowed,
  payroll_net_pay: allowed,
  payroll_gosi_payment: allowed,
  depreciation: allowed,
  asset_disposal: allowed,
  recognition: allowed,
  tax_computation: refused(NAMES.computation),
  wht_remittance: refused(NAMES.remittance),
  wht_remittance_reversal: refused(NAMES.itselfCorrection),
  migration_opening: refused(NAMES.migration),
  migration_reversal: refused(NAMES.migration),
  opening_correction: refused(NAMES.migration),
  vat_return_filing: refused(NAMES.amendFiling),
};

describe("R-10 — the matrix is register §11.109's table, over T1d's list exactly", () => {
  it("names every T1d source type and only those (35)", () => {
    expect(JOURNAL_SOURCE_TYPES.length).toBe(35);
    expect(Object.keys(MATRIX).sort()).toEqual([...JOURNAL_SOURCE_TYPES].sort());
  });
});

describeMaybe("Phase 18 R-10 (DR-34) — the generic reverse, decided per source type", () => {
  const h = g04Harness("r10dr34");
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let bank = 0;
  let customerId = 0;
  let vendorId = 0;
  let expense = 0;
  let income = 0;
  let seq = 0;
  const run = <T,>(fn: () => Promise<T>) => h.inTenant(orgId, companyId, userId, fn);

  const entry = async (id: number) => (await pool.query(
    `SELECT id, status, source_type, source_id, reversal_of, created_by, left(date::text, 10) AS date FROM journal_entries WHERE id = $1`, [id])).rows[0];
  const entryCount = async () => Number((await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n);
  const textOf = (e: any) => String(e?.payload?.error ?? e?.message ?? e);
  const reverse = (id: number) => run(() => journalEntriesService.reverse(id, { reason: "R-10 per source type" }))
    .then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e }));

  // ── the entries ─────────────────────────────────────────────────────────────
  /** One posted entry of `type` through the posting seam, its source id naming no document. */
  const plant = (type: JournalSourceType) => {
    const n = ++seq;
    return run(async () => (await postJournalEntry({
      // The seam's TYPE excludes manual, recurring and reversal; `reversal` is planted only for the source-type case below.
      sourceType: type as never, sourceId: PLANTED + n,
      entryNumber: `R10-${n}-${type}`, date: DATE, description: `R-10 planted ${type}`,
      lines: [
        { systemCode: "OTHER_EXPENSES", accountName: "Other Expenses", debitAmount: 100, creditAmount: 0 },
        { systemCode: "OTHER_INCOME", accountName: "Other Income", debitAmount: 0, creditAmount: 100 },
      ],
    } as never)).id as number);
  };
  /** A manual (or a recurring rule's) entry, created and approved as two acts. */
  const manual = async (origin?: { sourceType: "recurring" }) => {
    const n = ++seq;
    const je: any = await run(() => journalEntriesService.create({ entryNumber: `R10M-${n}`, date: DATE, description: `R-10 ${origin ? "recurring" : "manual"} ${n}`, lines: [
      { accountId: expense, accountName: "Other Expenses", debitAmount: 100, creditAmount: 0 },
      { accountId: income, accountName: "Other Income", debitAmount: 0, creditAmount: 100 },
    ] }, userId, origin));
    await run(() => journalEntriesService.approve(je.id, userId));
    return je.id as number;
  };
  /** A mirror, written by the generic reverse itself. */
  const mirrorOf = async (id: number) => {
    const out = await reverse(id);
    if (!out.ok) throw out.e;
    return out.r.reversalId as number;
  };
  const make = (type: JournalSourceType) =>
    type === "manual" ? manual() : type === "recurring" ? manual({ sourceType: "recurring" }) : type === "reversal" ? manual().then(mirrorOf) : plant(type);

  // ── the two verdicts ────────────────────────────────────────────────────────
  async function expectRefused(id: number, words: RegExp) {
    expect((await entry(id)).status, "the entry is posted before the attempt").toBe("posted");
    const before = await entryCount();
    const out = await reverse(id);
    expect(out.ok, `entry ${id} (${(await entry(id)).source_type}): the generic reverse refuses it`).toBe(false);
    const e = (out as { e: any }).e;
    expect(e?.statusCode, textOf(e)).toBe(409);
    expect(textOf(e), "the refusal names the path").toMatch(words);
    expect(await entryCount(), "nothing written").toBe(before);
    expect((await entry(id)).status, "the original stays posted").toBe("posted");
  }
  async function expectReversed(id: number) {
    const out = await reverse(id);
    if (!out.ok) throw new Error(`entry ${id} was refused: ${textOf(out.e)}`);
    const mirrorId = out.r.reversalId as number;
    expect(await entry(mirrorId), "the mirror keeps its attribution and its link").toMatchObject({
      status: "posted", source_type: "reversal", source_id: id, reversal_of: id, created_by: userId, date: businessToday(),
    });
    expect((await entry(id)).status).toBe("reversed");
    const audit = async (entityId: number) => (await pool.query(
      `SELECT action, user_id FROM audit_logs WHERE organization_id = $1 AND entity_type = 'journal_entry' AND entity_id = $2 ORDER BY id`,
      [orgId, String(entityId)])).rows.map((r) => [r.action, r.user_id]);
    expect(await audit(mirrorId), "the mirror's audit row, by the actor").toContainEqual(["create", userId]);
    expect(await audit(id), "the original's flip, by the actor").toContainEqual(["update", userId]);
  }

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "R10 Co", "319191919191303");
    userId = await h.mkUser("admin", "R10Dr34Pw123!", orgId, "admin");
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'R10 Customer') RETURNING id`, [orgId])).rows[0].id;
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name, residency) VALUES ($1,'R10 Supplier','resident') RETURNING id`, [orgId])).rows[0].id;
    bank = (await run(() => bankAccountsService.create({ name: "R10 Bank", bankName: "SNB", currency: "SAR" }))).id as number;
    const cat = async (code: string) => (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`, [orgId, code])).rows[0].id as number;
    expense = await cat("OTHER_EXPENSES");
    income = await cat("OTHER_INCOME");
  }, 120_000);
  afterAll(async () => { await h.cleanup(); });

  describe("THE MATRIX — one entry per source type, reversed by the generic reverse", () => {
    for (const type of JOURNAL_SOURCE_TYPES) {
      const d = MATRIX[type];
      const label = "refused" in d
        ? `🔴 ${type}: refused, naming its own path`
        : `${type}: ${d.question ? "a QUESTION for the owner, unchanged — " : ""}reversed, keeping its attribution and its link`;
      it(label, async () => {
        const id = await make(type);
        if ("refused" in d) await expectRefused(id, d.refused);
        else await expectReversed(id);
      });
    }

    it("🔴 reversal, by its source type alone (no reversal_of — a state no path writes today): refused as a mirror", async () => {
      await expectRefused(await plant("reversal"), NAMES.mirror);
    });
  });

  describe("THE SIX NEWLY REFUSED TYPES — produced by their own product paths", () => {
    /** The entry the path posted: of this type, not one of the matrix's planted ones. */
    const posted = async (type: JournalSourceType) => {
      const row = (await pool.query(
        `SELECT id FROM journal_entries WHERE organization_id = $1 AND source_type = $2 AND source_id < $3 ORDER BY id DESC LIMIT 1`, [orgId, type, PLANTED])).rows[0];
      expect(row, `the ${type} path posted its entry`).toBeTruthy();
      return row.id as number;
    };
    const invoice = (net: number, date = DATE) => run(() => createApproved<{ id: number }>(invoicesService,
      { invoiceNumber: `R10-INV-${++seq}`, date, dueDate: date, customerId, items: [{ description: "Work", quantity: 1, unitPrice: net, vatRate: 15 }] }, userId));
    const receipt = (amount: number, extra: Record<string, unknown> = {}) => run(() => paymentsService.receive(
      { customerId, amount, paidAt: DATE, bankAccountId: bank, allocations: [], ...extra } as never, userId));
    const bill = async (total: number) => {
      const b: any = await run(() => billsService.create({ billNumber: `R10-B-${++seq}`, date: DATE, vendorId, items: [{ description: "Supply", quantity: 1, unitPrice: total, vatRate: 0 }] } as never, userId));
      return run(() => billsService.approve(b.id, {}, userId)) as Promise<{ id: number }>;
    };
    const supplierPayment = (classification: string) => run(() => supplierPaymentsService.create(
      { vendorId, amount: 500, bankAccountId: bank, paidAt: DATE, classification, reference: `R10-SP-${++seq}` } as never, userId)) as Promise<{ id: number }>;

    it("🔴 a receipt's ALLOCATION to an invoice: refused, naming Unallocate", async () => {
      const inv = await invoice(1000);
      const rc: any = await receipt(500);
      await run(() => paymentsService.allocate(rc.id, { allocations: [{ invoiceId: inv.id, amount: 100 }] } as never, userId));
      await expectRefused(await posted("customer_payment_allocation"), NAMES.unallocate);
    });

    it("🔴 a credit note's APPLICATION to another invoice: refused, naming Unallocate", async () => {
      // the original is PAID first: a note against an unpaid invoice settles it at issue, leaving nothing to apply
      const original = await invoice(1000);
      await run(() => paymentsService.receive({ customerId, amount: 1150, paidAt: DATE, bankAccountId: bank, allocations: [{ invoiceId: original.id, amount: 1150 }] } as never, userId));
      const note = await run(() => createApproved<{ id: number }>(invoicesService, { invoiceNumber: `R10-CN-${++seq}`, date: DATE, dueDate: DATE, customerId,
        documentType: "credit_note", originalInvoiceId: original.id, noteReason: "Return", items: [{ description: "Return", quantity: 1, unitPrice: 400, vatRate: 15 }] }, userId));
      const target = await invoice(1000);
      await run(() => paymentsService.applyCreditNote(note.id, { allocations: [{ invoiceId: target.id, amount: 100 }] } as never, userId));
      await expectRefused(await posted("credit_note_application"), NAMES.unallocate);
    });

    it("🔴 a receipt's RECLASSIFICATION: refused, naming classify", async () => {
      const rc: any = await receipt(500, { classification: "unknown" });
      await run(() => paymentsService.classify(rc.id, { classification: "security_deposit" }, userId));
      await expectRefused(await posted("customer_payment_reclassification"), NAMES.classifyReceipt);
    });

    it("🔴 a supplier advance's ALLOCATION to a bill: refused, naming the allocation's reverse", async () => {
      const b = await bill(1000);
      const adv = await supplierPayment("advance");
      await run(() => supplierPaymentsService.allocate(adv.id, { allocations: [{ billId: b.id, amount: 100 }], date: DATE } as never, userId));
      await expectRefused(await posted("supplier_advance_allocation"), NAMES.reverseAllocation);
    });

    it("🔴 a supplier payment's RECLASSIFICATION: refused, naming classify", async () => {
      const sp = await supplierPayment("unknown");
      await run(() => supplierPaymentsService.classify(sp.id, { classification: "security_deposit" }, userId));
      await expectRefused(await posted("supplier_payment_reclassification"), NAMES.classifyPayment);
    });

    it("🔴 a VAT return's FILING (its clearing entry, 0138): refused, naming the amendment", async () => {
      await invoice(1000, "2026-04-15");
      await run(() => periodRecordsService.recordVatFiling({ periodFrom: "2026-04", periodTo: "2026-04", filedOn: "2026-05-20", zatcaReference: "R10-VAT-2604" }, userId));
      await expectRefused(await posted("vat_return_filing"), NAMES.amendFiling);
    });
  });
});
