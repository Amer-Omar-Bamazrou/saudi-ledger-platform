/**
 * PHASE 12B — RECONCILING STATEMENT LINES TO THE LEDGER (2026-09-23), on real rows.
 * Record: docs/product/phase-12-banking-reconciliation-decision-pack.md §4.
 *
 *  · 🔴 THE DEFECT: a statement line Phase D matched to a receipt stayed
 *    `pending_review`, and accepting it posted the same money a second time.
 *    Written to fail on the old code: the match now takes the line out of
 *    review, and acceptance refuses it — the bank moves ONCE.
 *  · AP lines reconcile to supplier payments, deterministically (the Phase D
 *    policy: reference + exact amount + window + one-to-one) or by hand —
 *    partial and multi-document — and NOTHING posts when they do;
 *  · the caps hold at the DATABASE: a line never beyond its amount, a ledger
 *    cash line never beyond its own, across every source;
 *  · undo is a superseding record; a bill settled from Review is linked to the
 *    payment's cash line; reconciled lines cannot be edited, deleted or
 *    accepted; append-only; isolation with presence, absence and movement.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { transactionsService } from "../services/transactions.service";
import { billsService } from "../services/bills.service";
import { paymentsService } from "../services/payments.service";
import { statementMatchingService } from "../services/statementMatching.service";
import { reconciliationService } from "../services/reconciliation.service";
import { supplierPaymentsService } from "../services/accounting/supplierPayments.service";
import { bankReconciliationService } from "../services/accounting/bankReconciliation.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

describeMaybe("Phase 12B — bank reconciliation (real rows)", () => {
  const SLUG = "p12b-rec", SLUG_B = "p12b-rec-other";
  const EMAIL = "p12b-rec@test.local";
  let orgId = "", companyId = "", userId = 0, bankId = 0, vendorId = 0, customerId = 0;
  let orgB = "", companyB = "", bankB = 0;

  const inTenant = async <T,>(fn: () => Promise<T>, org = orgId, co = companyId): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: org, companyId: co, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: org, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) { await conn.rollback(); throw err; }
  };
  const cleanup = async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      for (const slug of [SLUG, SLUG_B]) {
        const org = `(SELECT id FROM organizations WHERE slug = '${slug}')`;
        for (const t of ["bank_statement_link_reversals", "bank_statement_links", "statement_match_reversals", "statement_matches",
                         "supplier_refunds", "supplier_payment_allocation_reversals", "supplier_payment_allocations",
                         "supplier_payment_classifications", "supplier_payments", "payment_allocations", "payments",
                         "bill_payments", "bill_items", "bills", "transactions", "bank_statements",
                         "journal_entry_lines", "journal_entries", "audit_logs",
                         "organization_memberships", "vendors", "customers", "bank_accounts", "categories", "companies"]) {
          await client.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
        }
        await client.query(`DELETE FROM organizations WHERE slug = '${slug}'`);
      }
      await client.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await client.query("COMMIT");
    } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
  };
  const expectRefusal = async (p: Promise<unknown>, status: number, code?: string) => {
    let err: { statusCode?: number; status?: number; payload?: { code?: string }; message?: string } | undefined;
    try { await p; } catch (e) { err = e as typeof err; }
    expect(err, "expected a refusal").toBeTruthy();
    expect(err!.statusCode ?? err!.status, err!.message).toBe(status);
    if (code) expect(err!.payload?.code, err!.message).toBe(code);
    return err!;
  };
  /** Debit − credit on the bank's own GL leaf, in the books. */
  const bankGl = async () => Number((await pool.query(
    `SELECT coalesce(sum(v.debit_amount - v.credit_amount), 0)::text v FROM journal_line_bank_identity v
       JOIN journal_entries e ON e.id = v.journal_entry_id WHERE v.bank_account_id = $1 AND e.status IN ('posted','reversed')`, [bankId])).rows[0].v);
  const entryCount = async () => Number((await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n);
  const lineByDesc = async (d: string) => (await pool.query(`SELECT * FROM transactions WHERE organization_id = $1 AND description = $2`, [orgId, d])).rows[0];
  const importLines = (rows: Array<{ date: string; description: string; amount: number; type: "debit" | "credit" }>, bank = bankId, org = orgId, co = companyId) =>
    inTenant(() => transactionsService.upload({ rows, bankAccountId: bank, autoCategrize: false } as never, userId), org, co);
  /** The single cash line (on this bank) of a supplier payment's entry. */
  const cashLineOfSupplierPayment = async (paymentId: number) => (await pool.query(
    `SELECT v.line_id, abs(v.debit_amount - v.credit_amount)::numeric AS amount FROM supplier_payments p
       JOIN journal_line_bank_identity v ON v.journal_entry_id = p.journal_entry_id AND v.bank_account_id = p.bank_account_id WHERE p.id = $1`, [paymentId])).rows[0];

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('P12B Rec','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'P12B Co') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','P12B',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    bankId = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Rec Bank','Riyad') RETURNING id`, [orgId, companyId])).rows[0].id;
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'Acme Supplies') RETURNING id`, [orgId])).rows[0].id;
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Delta Retail') RETURNING id`, [orgId])).rows[0].id;
    orgB = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('P12B Other','${SLUG_B}') RETURNING id`)).rows[0].id;
    companyB = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'P12B Other Co') RETURNING id`, [orgB])).rows[0].id;
    bankB = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'B Bank','Alinma') RETURNING id`, [orgB, companyB])).rows[0].id;
  }, 120_000);
  afterAll(cleanup);

  it("🔴 THE DEFECT: a line Phase D matched to a receipt leaves review, and can NOT be accepted to post the money again", async () => {
    await inTenant(() => paymentsService.receive({ customerId, amount: 2000, paidAt: "2026-06-05", bankAccountId: bankId, reference: "RCPT-DELTA-5501" } as never, userId));
    await importLines([{ date: "2026-06-06", description: "Transfer from Delta Retail RCPT-DELTA-5501", amount: 2000, type: "credit" }]);
    const line = await lineByDesc("Transfer from Delta Retail RCPT-DELTA-5501");
    const glAfterReceipt = await bankGl();

    const applied = await inTenant(() => statementMatchingService.apply({ bankAccountId: bankId }, userId));
    expect(applied.recorded.map((m) => m.transactionId)).toContain(line.id);
    const after = await lineByDesc(line.description);
    expect(after).toMatchObject({ review_status: "accepted", kind: "matched", journal_entry_id: null });

    // Before 12B: the line was still pending and acceptPending([id]) posted Dr bank 2,000 again.
    await expectRefusal(inTenant(() => transactionsService.acceptPending([line.id])), 409, "line_reconciled");
    await inTenant(() => transactionsService.acceptPending());
    expect(await bankGl(), "the bank moved ONCE — by the receipt").toBeCloseTo(glAfterReceipt, 2);
    expect((await lineByDesc(line.description)).journal_entry_id).toBeNull();

    // MOVEMENT: unmatched, the line is back in review, and acceptance posts again as it always did.
    const match = (await pool.query(`SELECT id FROM statement_matches WHERE transaction_id = $1`, [line.id])).rows[0];
    await inTenant(() => statementMatchingService.unmatch(match.id, { reason: "test: not this receipt" }, userId));
    expect(await lineByDesc(line.description)).toMatchObject({ review_status: "pending_review", kind: "operating" });
  }, 90_000);

  it("🔴 AP, deterministically: a supplier payment's reference in the narrative links the line — and NOTHING posts", async () => {
    const sp = await inTenant(() => supplierPaymentsService.create({ vendorId, bankAccountId: bankId, amount: 1150, paidAt: "2026-06-10", reference: "ACME-7781", classification: "advance" }, userId));
    await importLines([{ date: "2026-06-11", description: "OUTWARD TT ACME-7781 ACME SUPPLIES", amount: 1150, type: "debit" }]);
    const line = await lineByDesc("OUTWARD TT ACME-7781 ACME SUPPLIES");
    const [entries, gl] = [await entryCount(), await bankGl()];

    const classified = await inTenant(() => bankReconciliationService.classifyAp({ bankAccountId: bankId }));
    const mine = classified.items.find((i) => i.transactionId === line.id)!;
    expect(mine.classification).toBe("DETERMINISTIC");
    expect(mine.target!.sourceKind).toBe("supplier_payment");
    expect(mine.target!.sourceId).toBe(sp.id);

    await inTenant(() => bankReconciliationService.applyAp({ bankAccountId: bankId }, userId));
    const state = await inTenant(() => bankReconciliationService.line(line.id));
    expect(state).toMatchObject({ status: "reconciled", kind: "matched", reconciledAmount: 1150, remaining: 0 });
    expect(state.reconciledBy).toHaveLength(1);
    expect(state.reconciledBy[0]).toMatchObject({ source: "link", documentKind: "supplier_payment", documentReference: "ACME-7781", amount: 1150 });
    expect(await entryCount(), "reconciling posts nothing").toBe(entries);
    expect(await bankGl()).toBeCloseTo(gl, 2);
  }, 90_000);

  it("🔴 multi-document and partial, by hand: one bank debit for two payments; one line only partly answered stays in review", async () => {
    const a = await inTenant(() => supplierPaymentsService.create({ vendorId, bankAccountId: bankId, amount: 1800, paidAt: "2026-06-15", classification: "advance" }, userId));
    const b = await inTenant(() => supplierPaymentsService.create({ vendorId, bankAccountId: bankId, amount: 1200, paidAt: "2026-06-15", classification: "advance" }, userId));
    await importLines([
      { date: "2026-06-15", description: "BATCH PAYMENT 2 BENEFICIARIES", amount: 3000, type: "debit" },
      { date: "2026-06-16", description: "PAYMENT PART ONE", amount: 800, type: "debit" },
    ]);
    const batch = await lineByDesc("BATCH PAYMENT 2 BENEFICIARIES");
    const [la, lb] = [await cashLineOfSupplierPayment(a.id), await cashLineOfSupplierPayment(b.id)];

    const multi = await inTenant(() => bankReconciliationService.link(batch.id, { lines: [{ journalLineId: la.line_id, amount: 1800 }, { journalLineId: lb.line_id, amount: 1200 }] }, userId));
    expect(multi).toMatchObject({ status: "reconciled", kind: "matched", reconciledAmount: 3000 });

    // A supplier payment of 500 answers only part of an 800 bank debit.
    const c = await inTenant(() => supplierPaymentsService.create({ vendorId, bankAccountId: bankId, amount: 500, paidAt: "2026-06-16", classification: "advance" }, userId));
    const part = await lineByDesc("PAYMENT PART ONE");
    const lc = await cashLineOfSupplierPayment(c.id);
    const partial = await inTenant(() => bankReconciliationService.link(part.id, { lines: [{ journalLineId: lc.line_id, amount: 500 }] }, userId));
    expect(partial).toMatchObject({ status: "partial", reconciledAmount: 500, remaining: 300, reviewStatus: "pending_review" });
    // 🔴 a partly reconciled line cannot be accepted — accepting would post all 800 again
    await expectRefusal(inTenant(() => transactionsService.acceptPending([part.id])), 409, "line_reconciled");
    // …and the rest of it, 300, stays visible as remaining — not quietly written off
    const listed = (await inTenant(() => bankReconciliationService.lines({ bankAccountId: bankId, status: "partial" }))).items;
    expect(listed.map((l) => l.id)).toContain(part.id);
  }, 90_000);

  it("🔴 the caps: more than the line, more than the ledger line, a posted line — refused, in words and at the database", async () => {
    await importLines([{ date: "2026-06-20", description: "CAP TEST DEBIT", amount: 400, type: "debit" }]);
    const line = await lineByDesc("CAP TEST DEBIT");
    const d = await inTenant(() => supplierPaymentsService.create({ vendorId, bankAccountId: bankId, amount: 300, paidAt: "2026-06-20", classification: "advance" }, userId));
    const ld = await cashLineOfSupplierPayment(d.id);
    await expectRefusal(inTenant(() => bankReconciliationService.link(line.id, { lines: [{ journalLineId: ld.line_id, amount: 450 }] }, userId)), 409, "exceeds_statement_line");
    await expectRefusal(inTenant(() => bankReconciliationService.link(line.id, { lines: [{ journalLineId: ld.line_id, amount: 350 }] }, userId)), 409, "exceeds_ledger_line");

    // A money-IN line cannot answer a money-OUT statement line (direction is identity).
    await inTenant(() => paymentsService.receive({ customerId, amount: 400, paidAt: "2026-06-20", bankAccountId: bankId } as never, userId));
    const inbound = (await pool.query(`SELECT v.line_id FROM payments p JOIN journal_line_bank_identity v ON v.journal_entry_id = p.journal_entry_id AND v.bank_account_id = p.bank_account_id WHERE p.organization_id = $1 AND p.amount = 400`, [orgId])).rows[0];
    await expectRefusal(inTenant(() => bankReconciliationService.link(line.id, { lines: [{ journalLineId: inbound.line_id, amount: 400 }] }, userId)), 409, "line_not_a_candidate");

    // 🔴 THE DATABASE, bypassing the service: the cap trigger refuses an over-link.
    const direct = async () => {
      const cl = await pool.connect();
      try {
        await cl.query("BEGIN");
        await cl.query(`SET LOCAL ROLE authenticated`);
        await cl.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);
        await cl.query(`SELECT set_config('app.current_company_id', $1, true)`, [companyId]);
        await cl.query(`INSERT INTO bank_statement_links (transaction_id, journal_line_id, amount, method) VALUES ($1, $2, 350, 'manual')`, [line.id, ld.line_id]);
        await cl.query("ROLLBACK");
        return "inserted";
      } catch (e) { await cl.query("ROLLBACK"); return (e as Error).message; } finally { cl.release(); }
    };
    expect(await direct()).toMatch(/already reconciled; 350 more would exceed it|would exceed it/);

    // A line that posted its OWN entry is already in the ledger: no link, no Phase D match.
    await importLines([{ date: "2026-06-21", description: "BANK CHARGE JUNE", amount: 25, type: "debit" }]);
    const fee = await lineByDesc("BANK CHARGE JUNE");
    const feeCat = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND type = 'expense' ORDER BY id LIMIT 1`, [orgId])).rows[0];
    await inTenant(() => transactionsService.update(fee.id, { categoryId: feeCat.id } as never));
    await inTenant(() => transactionsService.acceptPending([fee.id]));
    expect((await lineByDesc("BANK CHARGE JUNE")).journal_entry_id).not.toBeNull();
    await expectRefusal(inTenant(() => bankReconciliationService.link(fee.id, { lines: [{ journalLineId: ld.line_id, amount: 25 }] }, userId)), 409, "line_posted_its_own_entry");
  }, 90_000);

  it("🔴 evidence: a ledger line far from the statement date needs a reason; with one, it links", async () => {
    await importLines([{ date: "2026-07-30", description: "LATE CLEARING", amount: 260, type: "debit" }]);
    const line = await lineByDesc("LATE CLEARING");
    const e = await inTenant(() => supplierPaymentsService.create({ vendorId, bankAccountId: bankId, amount: 260, paidAt: "2026-07-10", classification: "advance" }, userId));
    const le = await cashLineOfSupplierPayment(e.id);
    await expectRefusal(inTenant(() => bankReconciliationService.link(line.id, { lines: [{ journalLineId: le.line_id, amount: 260 }] }, userId)), 422, "reason_required");
    const ok = await inTenant(() => bankReconciliationService.link(line.id, { lines: [{ journalLineId: le.line_id, amount: 260 }], reason: "Cheque cleared 20 days after it was written" }, userId));
    expect(ok.status).toBe("reconciled");
    expect(ok.reconciledBy[0]!.linkId).not.toBeNull();
  }, 60_000);

  it("🔴 undo is a SUPERSEDING record: the link stays, the line returns to review, and it cannot be undone twice", async () => {
    const line = await lineByDesc("LATE CLEARING");
    const [link] = (await pool.query(`SELECT id FROM bank_statement_links WHERE transaction_id = $1`, [line.id])).rows;
    await expectRefusal(inTenant(() => bankReconciliationService.unlink(link.id, { reason: "" }, userId)), 422, "reason_required");
    const back = await inTenant(() => bankReconciliationService.unlink(link.id, { reason: "Wrong cheque" }, userId));
    expect(back).toMatchObject({ status: "unreconciled", kind: "operating", reviewStatus: "pending_review" });
    expect((await pool.query(`SELECT count(*)::int n FROM bank_statement_links WHERE id = $1`, [link.id])).rows[0].n, "the link row stays").toBe(1);
    await expectRefusal(inTenant(() => bankReconciliationService.unlink(link.id, { reason: "again" }, userId)), 409, "link_already_reversed");
  }, 60_000);

  it("🔴 a bill settled from Review is linked to its payment's cash line; the payment names its entry", async () => {
    const draft = await inTenant(() => billsService.create({ billNumber: "P12B-BILL-1", date: "2026-06-01", dueDate: "2026-06-30", vendorId, items: [{ description: "Rent", quantity: 1, unitPrice: 1000, vatRate: 15 }] }, userId));
    const bill = await inTenant(() => billsService.approve(draft.id, {}, userId));
    await importLines([{ date: "2026-06-25", description: "RENT P12B-BILL-1", amount: 1150, type: "debit" }]);
    const line = await lineByDesc("RENT P12B-BILL-1");
    await inTenant(() => reconciliationService.settle(line.id, { billId: bill.id }, userId));
    const bp = (await pool.query(`SELECT journal_entry_id FROM bill_payments WHERE bill_id = $1`, [bill.id])).rows[0];
    expect(bp.journal_entry_id, "the payment names its entry").not.toBeNull();
    const state = await inTenant(() => bankReconciliationService.line(line.id));
    expect(state).toMatchObject({ status: "reconciled", kind: "settlement" });
    expect(state.reconciledBy[0]).toMatchObject({ source: "link", documentKind: "bill_payment", documentReference: "P12B-BILL-1" });
  }, 60_000);

  it("🔴 a reconciled line cannot be edited into a posting, nor deleted; a replayed request is ONE link", async () => {
    const line = await lineByDesc("OUTWARD TT ACME-7781 ACME SUPPLIES");
    const cat = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND type = 'expense' ORDER BY id LIMIT 1`, [orgId])).rows[0];
    await expectRefusal(inTenant(() => transactionsService.update(line.id, { categoryId: cat.id } as never)), 409, "line_reconciled");
    await expectRefusal(inTenant(() => transactionsService.remove(line.id)), 409, "line_reconciled");
    // notes stay editable (positive control)
    await inTenant(() => transactionsService.update(line.id, { notes: "checked" } as never));

    await importLines([{ date: "2026-06-26", description: "IDEMPOTENT LINK", amount: 70, type: "debit" }]);
    const idl = await lineByDesc("IDEMPOTENT LINK");
    const f = await inTenant(() => supplierPaymentsService.create({ vendorId, bankAccountId: bankId, amount: 70, paidAt: "2026-06-26", classification: "advance" }, userId));
    const lf = await cashLineOfSupplierPayment(f.id);
    const body = { lines: [{ journalLineId: lf.line_id, amount: 70 }], idempotencyKey: "p12b-idem-1" };
    await inTenant(() => bankReconciliationService.link(idl.id, body, userId));
    await inTenant(() => bankReconciliationService.link(idl.id, body, userId));
    expect((await pool.query(`SELECT count(*)::int n FROM bank_statement_links WHERE transaction_id = $1`, [idl.id])).rows[0].n).toBe(1);
  }, 60_000);

  it("🔴 append-only at the database", async () => {
    const [link] = (await pool.query(`SELECT id FROM bank_statement_links WHERE organization_id = $1 LIMIT 1`, [orgId])).rows;
    const asApp = async (sql: string) => {
      const cl = await pool.connect();
      try {
        await cl.query("BEGIN"); await cl.query(`SET LOCAL ROLE authenticated`);
        await cl.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);
        await cl.query(`SELECT set_config('app.current_company_id', $1, true)`, [companyId]);
        await cl.query(sql, [link.id]); await cl.query("ROLLBACK"); return "ok";
      } catch (e) { await cl.query("ROLLBACK"); return (e as Error).message; } finally { cl.release(); }
    };
    expect(await asApp(`UPDATE bank_statement_links SET amount = 1 WHERE id = $1`)).toMatch(/permission denied/i);
    expect(await asApp(`DELETE FROM bank_statement_links WHERE id = $1`)).toMatch(/permission denied/i);
    expect(await asApp(`DELETE FROM bank_statement_link_reversals WHERE link_id = $1`)).toMatch(/permission denied/i);
  }, 60_000);

  it("🔴 the invariants script SEES a line reconciled twice — planted past the triggers, then removed", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, readFileSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const run = (name: string) => {
      const out = join(mkdtempSync(join(tmpdir(), "p12b-inv-")), `${name}.json`);
      try {
        execFileSync(process.execPath, ["--import", "tsx", "src/scripts/ledgerInvariants.ts", "--json", out], { cwd: join(__dirname, "..", ".."), env: process.env, stdio: "pipe", timeout: 120_000 });
      } catch { /* exit 2 = something somewhere diverges; the report is still written */ }
      expect(existsSync(out)).toBe(true);
      const report = JSON.parse(readFileSync(out, "utf8")) as Record<string, Array<{ org: string; transaction_id?: number }>>;
      return (Object.entries(report).find(([k]) => k.startsWith("bank_line_reconciled_twice"))?.[1] ?? []).filter((r) => r.org === orgId);
    };
    expect(run("clean"), "nothing reconciled twice in this org").toEqual([]);

    // PLANTED: the bank charge posted its own entry; link it ALSO to a supplier payment's cash line,
    // with the triggers off — the damage the pre-12B defect could leave behind.
    const fee = await lineByDesc("BANK CHARGE JUNE");
    const g = await inTenant(() => supplierPaymentsService.create({ vendorId, bankAccountId: bankId, amount: 25, paidAt: "2026-06-21", classification: "advance" }, userId));
    const lg = await cashLineOfSupplierPayment(g.id);
    const cl = await pool.connect();
    let plantedId = 0;
    try {
      await cl.query("BEGIN");
      await cl.query("SET LOCAL session_replication_role = replica");
      plantedId = (await cl.query(`INSERT INTO bank_statement_links (organization_id, company_id, transaction_id, journal_line_id, amount, method) VALUES ($1,$2,$3,$4,25,'manual') RETURNING id`, [orgId, companyId, fee.id, lg.line_id])).rows[0].id;
      await cl.query("COMMIT");
    } catch (e) { await cl.query("ROLLBACK"); throw e; } finally { cl.release(); }
    try {
      const planted = run("planted");
      expect(planted.map((r) => r.transaction_id), "the instrument can see a line reconciled twice").toEqual([fee.id]);
    } finally {
      const c2 = await pool.connect();
      try { await c2.query("BEGIN"); await c2.query("SET LOCAL session_replication_role = replica"); await c2.query(`DELETE FROM bank_statement_links WHERE id = $1`, [plantedId]); await c2.query("COMMIT"); }
      finally { c2.release(); }
    }
  }, 300_000);

  it("🔴 isolation: another tenant sees none of these lines — and SEES its own", async () => {
    await importLines([{ date: "2026-06-03", description: "B TENANT LINE", amount: 90, type: "credit" }], bankB, orgB, companyB);
    const mine = (await inTenant(() => bankReconciliationService.lines({ limit: 200 }))).items;
    const theirs = (await inTenant(() => bankReconciliationService.lines({ limit: 200 }), orgB, companyB)).items;
    expect(theirs.map((l) => l.description)).toEqual(["B TENANT LINE"]);
    expect(mine.some((l) => l.description === "B TENANT LINE")).toBe(false);
    expect(theirs.some((l) => l.bankAccountId === bankId)).toBe(false);
    expect(mine.length).toBeGreaterThan(5);
    const someLine = mine[0]!;
    await expect(inTenant(() => bankReconciliationService.line(someLine.id), orgB, companyB)).rejects.toThrow(/not found/i);
  }, 60_000);
});
