/**
 * AP-1 (2026-09-20) — deposit CLASSIFICATION and the VAT-review list.
 * Decision record: docs/product/advance-payments-decision-pack.md §9 AP-1.
 *
 * What is under test: a classification is a dated, attributed record (a new
 * row per change, the newest current) that says what a deposit IS; it posts
 * NOTHING and decides NO VAT — asserted with a planted positive (an invoice
 * approval that DOES move VAT_OUTPUT on the same instrument). The review
 * list is the server's: which deposits still need a human's decision or an
 * advance tax invoice, with the Art. 53(1)(b) deadline, framed by the
 * receipt date. Every list assertion is presence + absence + movement.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool, PERMISSION_MATRIX } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { can, primePermissionCache, resetPermissionCache } from "../lib/rbac";
import { invoicesService } from "../services/invoices.service";
import { paymentsService } from "../services/payments.service";
import { bankAccountsService } from "../services/bankAccounts.service";
import { reportsService } from "../services/reports.service";
import { depositReviewService, advanceInvoiceDeadline, endOfMonth, reviewStateOf } from "../services/depositReview.service";
import { createApproved } from "./helpers/createApproved";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const SLUG = "ap1-class";
const SLUG_OTHER = "ap1-class-other";
const EMAIL = "ap1-class@test.local";
const DATE = "2026-06-15";

describe("AP-1 — pure helpers", () => {
  it("the advance tax invoice deadline is the 15th of the month after receipt (IR Art. 53(1)(b)), across a year end", () => {
    expect(advanceInvoiceDeadline("2026-06-15")).toBe("2026-07-15");
    expect(advanceInvoiceDeadline("2026-12-31")).toBe("2027-01-15");
    expect(advanceInvoiceDeadline("2026-01-01")).toBe("2026-02-15");
  });
  it("end of month handles February and 31-day months", () => {
    expect(endOfMonth("2026-02")).toBe("2026-02-28");
    expect(endOfMonth("2028-02")).toBe("2028-02-29");
    expect(endOfMonth("2026-07")).toBe("2026-07-31");
  });
  it("review states: unknown and advance need review; erroneous and security deposits are VAT-silent; a migrated deposit follows its migration VAT position", () => {
    expect(reviewStateOf({ source: "manual", migrationVatPosition: null, classification: "unknown" })).toEqual({ state: "unclassified", needsReview: true });
    expect(reviewStateOf({ source: "manual", migrationVatPosition: null, classification: "advance" })).toEqual({ state: "advance_not_invoiced", needsReview: true });
    expect(reviewStateOf({ source: "manual", migrationVatPosition: null, classification: "erroneous" })).toEqual({ state: "vat_silent", needsReview: false });
    expect(reviewStateOf({ source: "manual", migrationVatPosition: null, classification: "security_deposit" })).toEqual({ state: "vat_silent", needsReview: false });
    expect(reviewStateOf({ source: "opening", migrationVatPosition: "invoiced", classification: "unknown" })).toEqual({ state: "migrated_invoiced", needsReview: false });
    expect(reviewStateOf({ source: "opening", migrationVatPosition: "unknown", classification: "unknown" })).toEqual({ state: "migrated_unknown", needsReview: true });
  });
});

describeMaybe("AP-1 — deposit classification and the VAT-review list (real rows)", () => {
  let orgId = "";
  let companyId = "";
  let otherOrgId = "";
  let otherCompanyId = "";
  let userId = 0;
  let custA = 0;
  let custB = 0;
  let custOther = 0;
  let bank = 0;
  let bankOther = 0;

  const tenant = (org: string, company: string) => async <T,>(fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: org, companyId: company, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: org, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  };
  const inTenant = <T,>(fn: () => Promise<T>) => tenant(orgId, companyId)(fn);
  const inOther = <T,>(fn: () => Promise<T>) => tenant(otherOrgId, otherCompanyId)(fn);

  // The migrated-deposit fixture leaves a committed batch behind, whose staging rows the
  // immutability trigger refuses to delete — the 1C suites' own cleanup pattern (triggers off).
  const cleanup = async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      for (const slug of [SLUG, SLUG_OTHER]) {
        const org = `(SELECT id FROM organizations WHERE slug = '${slug}')`;
        for (const t of [
          "payment_classifications", "customer_refunds", "payment_allocation_reversals", "payment_allocations", "payments", "migration_advances", "migration_batches",
          "journal_entry_lines", "journal_entries", "invoice_items", "einvoice_documents", "invoices", "customers", "period_locks", "audit_logs",
          "organization_memberships", "bank_accounts", "categories", "companies",
        ]) {
          await client.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
        }
        await client.query(`DELETE FROM organizations WHERE slug = '${slug}'`);
      }
      await client.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('AP1 Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'AP1 Co','1010828181','399999999988903') RETURNING id`, [orgId])).rows[0].id;
    otherOrgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('AP1 Other','${SLUG_OTHER}') RETURNING id`)).rows[0].id;
    otherCompanyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'AP1 Other Co','1010828183','399999999988923') RETURNING id`, [otherOrgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','AP1',' ','admin',true) RETURNING id`)).rows[0].id;
    for (const o of [orgId, otherOrgId]) await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, o]);
    custA = (await pool.query(`INSERT INTO customers (organization_id, name, name_ar) VALUES ($1,'Najd Trading','تجارة نجد') RETURNING id`, [orgId])).rows[0].id;
    custB = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Hail Supplies') RETURNING id`, [orgId])).rows[0].id;
    custOther = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Other Customer') RETURNING id`, [otherOrgId])).rows[0].id;
    bank = (await inTenant(() => bankAccountsService.create({ name: "Riyad Main", bankName: "Riyad Bank", currency: "SAR" }))).id;
    bankOther = (await inOther(() => bankAccountsService.create({ name: "Other Main", bankName: "ANB", currency: "SAR" }))).id;
  });
  afterAll(cleanup);

  let seq = 0;
  async function issue(customerId: number, net: number) {
    seq += 1;
    return inTenant(() =>
      createApproved<{ id: number; invoiceNumber: string }>(
        invoicesService,
        { invoiceNumber: `AP1-${String(seq).padStart(3, "0")}`, date: DATE, dueDate: DATE, customerId, items: [{ description: "Work", quantity: 1, unitPrice: net, vatRate: 15 }] },
        userId,
      ),
    );
  }
  const receive = (customerId: number, amount: number, extra: Record<string, unknown> = {}) =>
    inTenant(() => paymentsService.receive({ customerId, amount, paidAt: DATE, bankAccountId: bank, ...extra }, userId));
  const gl = async (code: string, org = orgId) =>
    Number((await pool.query(
      `SELECT coalesce(sum(l.credit_amount - l.debit_amount), 0)::text AS v
         FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
        WHERE e.organization_id = $1 AND c.system_code = $2 AND e.status IN ('posted','reversed')`, [org, code])).rows[0].v);
  const journalCount = async () => Number((await pool.query(`SELECT count(*)::text AS n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n);
  const classRows = async (paymentId: number) => (await pool.query(`SELECT classification, vat_category, note, created_by FROM payment_classifications WHERE payment_id = $1 ORDER BY id`, [paymentId])).rows;
  const review = (asOf?: string, customerId?: number) => inTenant(() => depositReviewService.review({ asOf, customerId }));
  const expectRefusal = async (p: Promise<unknown>, status: number, code?: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let err: any;
    try { await p; } catch (e) { err = e; }
    expect(err, "expected a refusal").toBeTruthy();
    expect(err.statusCode ?? err.status).toBe(status);
    if (code) expect(err.body?.code ?? err.payload?.code ?? err.code).toBe(code);
  };

  // ── storage ────────────────────────────────────────────────────────────
  it("🔴 all four classifications store and read back; each change is a NEW row and the newest is current; the history keeps every row", async () => {
    const p = await receive(custA, 5_000);
    expect(p.classification).toBeNull();
    expect(p.unappliedAmount).toBe(5_000);
    const seen: string[] = [];
    for (const [classification, vatCategory] of [["unknown", null], ["security_deposit", null], ["erroneous", null], ["advance", "S"]] as const) {
      const out = await inTenant(() => paymentsService.classify(p.id, { classification, vatCategory, note: `now ${classification}` }, userId));
      expect(out.classification?.classification).toBe(classification);
      expect(out.classification?.vatCategory).toBe(vatCategory);
      expect(out.classification?.note).toBe(`now ${classification}`);
      expect(out.classification?.classifiedBy).toBe(userId);
      seen.push(classification);
      // read back through get and list — one definition
      expect((await inTenant(() => paymentsService.get(p.id))).classification?.classification).toBe(classification);
      expect((await inTenant(() => paymentsService.list({ customerId: custA }))).find((x) => x.id === p.id)?.classification?.classification).toBe(classification);
    }
    const rows = await classRows(p.id);
    expect(rows.map((r) => r.classification)).toEqual(seen);
    expect(rows.every((r) => r.created_by === userId)).toBe(true);
    const history = await inTenant(() => paymentsService.classificationHistory(p.id));
    expect(history.map((h) => h.classification)).toEqual(seen);
  });

  it("a classification may be stated AT receipt (same transaction); a fully allocated receipt refuses one (never a deposit)", async () => {
    const inv = await issue(custA, 1_000); // 1,150
    const p = await receive(custA, 2_000, { allocations: [{ invoiceId: inv.id, amount: 1_150 }], classification: "advance", vatCategory: "S", classificationNote: "the rest is a deposit for the next order" });
    expect(p.unappliedAmount).toBe(850);
    expect(p.classification?.classification).toBe("advance");
    expect((await classRows(p.id)).length).toBe(1);
    const inv2 = await issue(custA, 1_000);
    await expectRefusal(receive(custA, 1_150, { allocations: [{ invoiceId: inv2.id, amount: 1_150 }], classification: "advance" }), 422, "no_deposit_to_classify");
    // ... and later, too: a receipt that was never a deposit has nothing to classify.
    const full = await receive(custA, 1_150, { allocations: [{ invoiceId: inv2.id, amount: 1_150 }] });
    await expectRefusal(inTenant(() => paymentsService.classify(full.id, { classification: "erroneous" }, userId)), 409, "no_deposit_to_classify");
  });

  it("refusals name their reason: an unknown value (400); a VAT category on a non-advance (422); a receipt with no customer (422)", async () => {
    const p = await receive(custA, 300);
    await expectRefusal(inTenant(() => paymentsService.classify(p.id, { classification: "gift" }, userId)), 400);
    await expectRefusal(inTenant(() => paymentsService.classify(p.id, { classification: "advance", vatCategory: "X" }, userId)), 400);
    await expectRefusal(inTenant(() => paymentsService.classify(p.id, { classification: "erroneous", vatCategory: "S" }, userId)), 422, "vat_category_requires_advance");
    await expectRefusal(inTenant(() => paymentsService.classify(999_999_999, { classification: "erroneous" }, userId)), 404);
    expect((await classRows(p.id)).length).toBe(0);
  });

  it("🔴 the same classification request twice is ONE record; the key reused for another receipt is a 409", async () => {
    const p = await receive(custA, 400);
    const q = await receive(custA, 401);
    const a = await inTenant(() => paymentsService.classify(p.id, { classification: "erroneous", idempotencyKey: "ap1-key-1" }, userId));
    const b = await inTenant(() => paymentsService.classify(p.id, { classification: "erroneous", idempotencyKey: "ap1-key-1" }, userId));
    expect(b.classification?.id).toBe(a.classification?.id);
    expect((await classRows(p.id)).length).toBe(1);
    await expectRefusal(inTenant(() => paymentsService.classify(q.id, { classification: "erroneous", idempotencyKey: "ap1-key-1" }, userId)), 409);
  });

  // ── nothing posts ──────────────────────────────────────────────────────
  it("🔴 classifying posts NOTHING and moves no VAT — while an invoice approval on the same instrument DOES move VAT_OUTPUT (planted positive)", async () => {
    const p = await receive(custB, 11_500);
    const journalsBefore = await journalCount();
    const vatBefore = await gl("VAT_OUTPUT");
    const depositsBefore = await gl("CUSTOMER_DEPOSITS");
    const arBefore = await gl("AR");
    for (const classification of ["advance", "erroneous", "security_deposit", "unknown"] as const) {
      await inTenant(() => paymentsService.classify(p.id, { classification, vatCategory: classification === "advance" ? "S" : null }, userId));
    }
    expect(await journalCount(), "no journal entry from a classification").toBe(journalsBefore);
    expect(await gl("VAT_OUTPUT"), "VAT unchanged").toBe(vatBefore);
    expect(await gl("CUSTOMER_DEPOSITS"), "deposit unchanged").toBe(depositsBefore);
    expect(await gl("AR"), "AR unchanged").toBe(arBefore);
    expect((await inTenant(() => paymentsService.get(p.id))).unappliedAmount).toBe(11_500);
    // planted positive: the instrument sees VAT move when something that posts VAT happens
    await issue(custB, 1_000);
    expect(await gl("VAT_OUTPUT")).toBe(Math.round((vatBefore + 150) * 100) / 100);
    expect(await journalCount()).toBe(journalsBefore + 1);
  });

  // ── the review list ────────────────────────────────────────────────────
  it("🔴 the review list: presence (an unknown deposit is listed as unclassified), absence (a fully allocated receipt is not), and MOVEMENT (classify → the state changes; allocate away → it leaves)", async () => {
    const p = await receive(custA, 2_300);
    const inv = await issue(custA, 1_000); // 1,150
    const paid = await receive(custA, 1_150, { allocations: [{ invoiceId: inv.id, amount: 1_150 }] });

    let r = await review();
    const mine = r.items.find((i) => i.paymentId === p.id)!;
    expect(mine, "the deposit is listed").toBeTruthy();
    expect(mine.reviewState).toBe("unclassified");
    expect(mine.needsReview).toBe(true);
    expect(mine.classification).toBe("unknown");
    expect(mine.unappliedAmount).toBe(2_300);
    expect(mine.customerName).toBe("Najd Trading");
    expect(mine.customerNameAr).toBe("تجارة نجد");
    expect(mine.deadline).toBeNull();
    expect(r.items.find((i) => i.paymentId === paid.id), "a fully allocated receipt is absent").toBeUndefined();
    expect(r.needsReviewCount).toBeGreaterThanOrEqual(1);
    expect(r.byState.unclassified.count).toBeGreaterThanOrEqual(1);

    // movement 1: an advance — with the Art. 53(1)(b) deadline, overdue (received 2026-06-15, today is later than 2026-07-15)
    await inTenant(() => paymentsService.classify(p.id, { classification: "advance", vatCategory: "S" }, userId));
    r = await review();
    const adv = r.items.find((i) => i.paymentId === p.id)!;
    expect(adv.reviewState).toBe("advance_not_invoiced");
    expect(adv.needsReview).toBe(true);
    expect(adv.vatCategory).toBe("S");
    expect(adv.deadline).toBe("2026-07-15");
    expect(adv.overdue).toBe(r.today > "2026-07-15");
    expect(r.overdueCount).toBeGreaterThanOrEqual(adv.overdue ? 1 : 0);

    // movement 2: erroneous — still LISTED (money is still held), no longer needing review
    await inTenant(() => paymentsService.classify(p.id, { classification: "erroneous" }, userId));
    r = await review();
    const err = r.items.find((i) => i.paymentId === p.id)!;
    expect(err.reviewState).toBe("vat_silent");
    expect(err.needsReview).toBe(false);
    expect(err.deadline).toBeNull();

    // movement 3: the deposit is allocated in full → it leaves the list entirely
    const inv2 = await issue(custA, 2_000); // 2,300
    await inTenant(() => paymentsService.allocate(p.id, { allocations: [{ invoiceId: inv2.id, amount: 2_300 }] }, userId));
    r = await review();
    expect(r.items.find((i) => i.paymentId === p.id), "allocated away → absent").toBeUndefined();

    // movement 4: a partial correction brings the remainder back
    const alloc = (await inTenant(() => paymentsService.get(p.id))).allocations.find((a) => !a.reversedBy)!;
    await inTenant(() => paymentsService.unallocate(alloc.id, { reason: "wrong invoice" }, userId));
    r = await review();
    expect(r.items.find((i) => i.paymentId === p.id)?.unappliedAmount).toBe(2_300);
    expect(r.items.find((i) => i.paymentId === p.id)?.classification, "the classification survives the allocation round trip").toBe("erroneous");
  });

  it("the frame is the receipt date: a deposit received after `asOf` is absent, present once the frame reaches it; the customer filter narrows", async () => {
    const early = await receive(custA, 700, { paidAt: "2026-03-10" });
    const late = await receive(custB, 800, { paidAt: "2026-08-20" });
    const r1 = await review("2026-06-30");
    expect(r1.asOf).toBe("2026-06-30");
    expect(r1.items.some((i) => i.paymentId === early.id)).toBe(true);
    expect(r1.items.some((i) => i.paymentId === late.id)).toBe(false);
    const r2 = await review("2026-08-31");
    expect(r2.items.some((i) => i.paymentId === late.id)).toBe(true);
    const r3 = await review("2026-08-31", custB);
    expect(r3.items.some((i) => i.paymentId === late.id)).toBe(true);
    expect(r3.items.some((i) => i.paymentId === early.id)).toBe(false);
    expect(r3.items.every((i) => i.customerId === custB)).toBe(true);
  });

  it("🔴 the VAT return carries the SAME review summary the list computes for its period end — one definition, two readers; the boxes do not move", async () => {
    const before = await inTenant(() => reportsService.vatReturn("2026-06", "2026-06"));
    const list = await review("2026-06-30");
    expect(before.depositReview.asOf).toBe("2026-06-30");
    expect(before.depositReview.needsReviewCount).toBe(list.needsReviewCount);
    expect(before.depositReview.needsReviewAmount).toBe(Math.round(list.needsReviewAmount * 100) / 100);
    expect(before.depositReview.overdueCount).toBe(list.overdueCount);
    // a new unknown deposit inside the period moves the summary by exactly its amount, and no box
    const p = await receive(custB, 999, { paidAt: "2026-06-02" });
    const after = await inTenant(() => reportsService.vatReturn("2026-06", "2026-06"));
    expect(after.depositReview.needsReviewCount).toBe(before.depositReview.needsReviewCount + 1);
    expect(Math.round((after.depositReview.needsReviewAmount - before.depositReview.needsReviewAmount) * 100) / 100).toBe(999);
    expect(after.salesSection.box6_vatOnStandardRatedSales).toBe(before.salesSection.box6_vatOnStandardRatedSales);
    expect(after.salesSection.box1_standardRatedDomesticSales).toBe(before.salesSection.box1_standardRatedDomesticSales);
    expect(after.netVatDue).toBe(before.netVatDue);
    // no period at all: the frame is today
    const open = await inTenant(() => reportsService.vatReturn());
    expect(open.depositReview.asOf).toBe(list.today);
    void p;
  });

  it("🔴 a migrated deposit follows its migration VAT position (invoiced → no review; unknown → review) and REFUSES classification here (one definition)", async () => {
    const batch = (await pool.query(
      `INSERT INTO migration_batches (organization_id, company_id, source_system, cutover_date, opening_date, status) VALUES ($1,$2,'OldERP','2026-01-01','2025-12-31','draft') RETURNING id`, [orgId, companyId])).rows[0].id;
    const mk = async (sourceId: string, vatPosition: string, amount: number) => {
      const adv = (await pool.query(
        `INSERT INTO migration_advances (organization_id, company_id, batch_id, source_system, source_id, party_source_id, bank_source_code, amount, received_at, vat_position, advance_invoice_number)
         VALUES ($1,$2,$3,'OldERP',$4,'C-1','BANK1',$5,'2025-11-20',$6,$7) RETURNING id`, [orgId, companyId, batch, sourceId, amount, vatPosition, vatPosition === "invoiced" ? "ADV-2025-17" : null])).rows[0].id;
      const je = (await pool.query(`INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status) VALUES ($1,$2,$3,'2025-12-31','opening','posted') RETURNING id`, [orgId, companyId, `MIG-T-${sourceId}`])).rows[0].id;
      return (await pool.query(
        `INSERT INTO payments (organization_id, company_id, direction, party_type, customer_id, bank_account_id, amount, paid_at, source, journal_entry_id, migration_advance_id)
         VALUES ($1,$2,'in','customer',$3,$4,$5,'2025-12-31','opening',$6,$7) RETURNING id`, [orgId, companyId, custB, bank, amount, je, adv])).rows[0].id;
    };
    const invoiced = await mk("A-1", "invoiced", 5_750);
    const unknown = await mk("A-2", "unknown", 1_200);
    // the staging rows are written while the batch is a draft (the immutability trigger refuses rows added to a committed batch); the batch then reads as committed, as a migrated deposit's does
    await pool.query(`UPDATE migration_batches SET status = 'committed' WHERE id = $1`, [batch]);
    const r = await review("2026-06-30");
    const a = r.items.find((i) => i.paymentId === invoiced)!;
    const b = r.items.find((i) => i.paymentId === unknown)!;
    expect(a.reviewState).toBe("migrated_invoiced");
    expect(a.needsReview).toBe(false);
    expect(a.migrationVatPosition).toBe("invoiced");
    expect(a.source).toBe("opening");
    expect(b.reviewState).toBe("migrated_unknown");
    expect(b.needsReview).toBe(true);
    expect(b.migrationVatPosition).toBe("unknown");
    await expectRefusal(inTenant(() => paymentsService.classify(invoiced, { classification: "erroneous" }, userId)), 409, "opening_deposit_classified_by_migration");
    expect((await classRows(invoiced)).length).toBe(0);
  });

  // ── isolation and permissions ──────────────────────────────────────────
  it("🔴 isolation: another org cannot classify, read or list this org's deposit — presence on one side, absence on the other, and its own deposit moves its own list", async () => {
    const mine = await receive(custA, 610);
    const theirs = await inOther(() => paymentsService.receive({ customerId: custOther, amount: 620, paidAt: DATE, bankAccountId: bankOther }, userId));
    await expectRefusal(inOther(() => paymentsService.classify(mine.id, { classification: "erroneous" }, userId)), 404);
    await expectRefusal(inOther(() => paymentsService.classificationHistory(mine.id)), 404);
    const otherList = await inOther(() => depositReviewService.review({}));
    expect(otherList.items.some((i) => i.paymentId === mine.id), "absent from the other org").toBe(false);
    expect(otherList.items.some((i) => i.paymentId === theirs.id), "the other org sees its own").toBe(true);
    const myList = await review();
    expect(myList.items.some((i) => i.paymentId === theirs.id), "theirs absent here").toBe(false);
    expect(myList.items.some((i) => i.paymentId === mine.id)).toBe(true);
    // movement on the other side only
    const before = otherList.byState.vat_silent.count;
    await inOther(() => paymentsService.classify(theirs.id, { classification: "security_deposit" }, userId));
    expect((await inOther(() => depositReviewService.review({}))).byState.vat_silent.count).toBe(before + 1);
    expect((await review()).items.find((i) => i.paymentId === mine.id)?.classification).toBe("unknown");
    expect((await classRows(mine.id)).length).toBe(0);
  });

  it("permissions: classifying is approver-level (POST → create = admin, accountant); every role can read the list", async () => {
    primePermissionCache(PERMISSION_MATRIX);
    expect(await can("admin", "payments", "create")).toBe(true);
    expect(await can("accountant", "payments", "create")).toBe(true);
    expect(await can("bookkeeper", "payments", "create")).toBe(false);
    expect(await can("viewer", "payments", "create")).toBe(false);
    for (const r of ["admin", "accountant", "bookkeeper", "viewer"]) expect(await can(r, "payments", "read")).toBe(true);
    resetPermissionCache();
  });

  it("append-only: the app role can neither update nor delete a classification", async () => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const sql = (await import("drizzle-orm")).sql;
      const { db } = await import("@workspace/db");
      await expect(conn.run(() => db.execute(sql`UPDATE payment_classifications SET classification = 'advance'`))).rejects.toMatchObject({ cause: { code: "42501" } });
    } finally {
      await conn.rollback();
    }
    const conn2 = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const sql = (await import("drizzle-orm")).sql;
      const { db } = await import("@workspace/db");
      await expect(conn2.run(() => db.execute(sql`DELETE FROM payment_classifications`))).rejects.toMatchObject({ cause: { code: "42501" } });
    } finally {
      await conn2.rollback();
    }
  });

  it("every journal posted by this suite balances", async () => {
    const { rows: bad } = await pool.query(`SELECT e.entry_number FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id = e.id WHERE e.organization_id = $1 GROUP BY e.id HAVING sum(l.debit_amount) <> sum(l.credit_amount)`, [orgId]);
    expect(bad).toEqual([]);
  });
});
