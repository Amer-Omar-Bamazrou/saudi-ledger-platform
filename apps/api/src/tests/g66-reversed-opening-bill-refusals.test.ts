/**
 * 🔴 G66 PROOF (Phase 18, B-SMALL-1; proof first): a Policy-C REVERSED opening
 * bill is history — no supplier-side path may settle it. `payBill` refuses it
 * (`bills.payment.ts:119`, `assertNotReversedOpening` → 409
 * `opening_item_reversed`), and treasury plans refuse it
 * (`treasury/paymentPlans.service.ts:98`); the AP subledger's three other
 * settling paths did not.
 *
 * The mechanism (main at b1705b55): supplier payment CREATE with allocations
 * (`supplierPayments.service.ts:108`), ALLOCATE of on-account money (`:230`)
 * and supplier credit-note APPLY (`supplierCreditNotes.service.ts:75`) all
 * check their targets in ONE validator, `validateAllocations`
 * (`supplierPayments.service.ts:656-729`): supplier, approval status,
 * document type, outstanding — but never `reversed_at`. So:
 *  - a PARTIAL application succeeds: it settles a bill that is no longer in
 *    the books (the reversal's mirror already netted it, and every subledger
 *    reader excludes it), so the AP subledger and the GL part;
 *  - a FULL application posts, then `refreshBill` sets the bill `paid` and
 *    the 0081 freeze trigger (`opening_reversed_frozen`, a check violation
 *    `dbRefusals.ts` does not map) aborts the request — not a refusal.
 *
 * What this file asserts, fix-neutral (any 4xx refusal satisfies it):
 *  1. the instrument SEES movement: applying an advance to a LIVE bill moves
 *     the snapshot (an allocation, an entry, AP on both sides, the tie holds);
 *  2. on each path — create, allocate, apply — a full and a partial
 *     application to a reversed opening bill are REFUSED (4xx) and NOTHING
 *     moves: no payment, allocation or entry; the reversed bills unchanged;
 *     AP in the GL unchanged; the supplier statement's subledger↔GL tie and
 *     its event reconciliation still agree.
 *
 * Everything is the PRODUCT's own HTTP path on rows it created itself: the
 * migration (stage → validate → commit → reverse) creates and reverses the
 * opening bills; the bank, supplier, live bill, credit note and payments go
 * through their own routes; the database is only READ. DB-backed (sl_test /
 * CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3213";
process.env.SESSION_SECRET ??= "g66-reversed-opening-bill-refusals-proof-01";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { __resetRateLimitsForTests } from "../routes/auth";
import { g04Harness, type Res } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PW = "G66ReversedOpeningPw123!";
const PAID_AT = "2026-08-10";

describeMaybe("G66 — a reversed opening bill is refused on every supplier settling path", () => {
  const h = g04Harness("g66proof");
  let orgId = "";
  let vendorId = 0;
  let bankId = 0;
  /** The two opening bills the reversed migration created: A takes the FULL attempts, B the partial ones. */
  const reversed = { a: { id: 0, total: 0 }, b: { id: 0, total: 0 } };
  let liveBillId = 0;
  let advanceId = 0;
  let noteId = 0;

  const ok = (r: Res, status: number) => expect(r.status, JSON.stringify(r.body)).toBe(status);

  async function snapshot() {
    const count = async (sql: string) => Number((await pool.query(sql, [orgId])).rows[0].n);
    const statement = await h.api("admin", "GET", `/supplier-statements/${vendorId}`);
    ok(statement, 200);
    return {
      supplierPayments: await count(`SELECT count(*)::int AS n FROM supplier_payments WHERE organization_id = $1`),
      allocations: await count(`SELECT count(*)::int AS n FROM supplier_payment_allocations WHERE organization_id = $1`),
      journalEntries: await count(`SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1`),
      reversedBills: (await pool.query(
        `SELECT bill_number, status, reversed_at IS NOT NULL AS reversed, total::text AS total,
                (SELECT count(*)::int FROM supplier_payment_allocations a WHERE a.bill_id = b.id) AS allocations
           FROM bills b WHERE b.id = ANY($1::int[]) ORDER BY b.id`, [[reversed.a.id, reversed.b.id]],
      )).rows,
      apGl: Number((await pool.query(
        `SELECT coalesce(sum(l.credit_amount - l.debit_amount), 0)::text AS v
           FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
          WHERE e.organization_id = $1 AND e.status IN ('posted','reversed') AND c.system_code = 'AP' AND l.vendor_id = $2`, [orgId, vendorId],
      )).rows[0].v),
      glTie: statement.body.gl.components,
      glAgrees: statement.body.gl.agrees as boolean,
      eventsReconcile: statement.body.reconciliation.agrees as boolean,
    };
  }

  /** Stage a migration with two opening payables, commit it, and reverse it — all over HTTP, as the operator would. */
  async function reversedOpeningBills() {
    const created = await h.api("admin", "POST", "/migration/batches", { sourceSystem: "PreviousERP", cutoverDate: "2026-07-01" });
    ok(created, 201);
    const id = created.body.id as number;
    const chart = await h.api("admin", "PUT", `/migration/batches/${id}/chart`, { rows: [
      { sourceCode: "1100", sourceName: "Riyad Bank", sourceType: "asset", openingDebit: 20_000, sourceRole: "bank", evidenceNote: "statement 30 Jun" },
      { sourceCode: "2100", sourceName: "Trade creditors", sourceType: "liability", openingCredit: 10_000, sourceRole: "payable" },
      { sourceCode: "3100", sourceName: "Capital", sourceType: "equity", openingCredit: 10_000 },
    ] });
    ok(chart, 200);
    const rowId = (code: string) => (chart.body.rows as Array<{ id: number; sourceCode: string }>).find((r) => r.sourceCode === code)!.id;
    ok(await h.api("admin", "PATCH", `/migration/batches/${id}/chart/${rowId("1100")}`, { decision: "map_to_bank", targetBankAccountId: bankId }), 200);
    ok(await h.api("admin", "PATCH", `/migration/batches/${id}/chart/${rowId("2100")}`, { decision: "map_to_system", targetSystemCode: "AP" }), 200);
    ok(await h.api("admin", "PATCH", `/migration/batches/${id}/chart/${rowId("3100")}`, { decision: "create" }), 200);
    const parties = await h.api("admin", "PUT", `/migration/batches/${id}/parties`, { rows: [{ partyType: "vendor", sourceId: "V1", name: "G66 Proof Supplies" }] });
    ok(parties, 200);
    ok(await h.api("admin", "PATCH", `/migration/batches/${id}/parties/${parties.body.rows[0].id}`, { decision: "use_existing", existingId: vendorId }), 200);
    ok(await h.api("admin", "PUT", `/migration/batches/${id}/open-items`, { rows: [
      { itemType: "ap", sourceId: "PI-A", partySourceId: "V1", documentNumber: "G66-OPEN-A", issueDate: "2026-05-01", dueDate: "2026-06-01", originalAmount: 4_000, outstandingAmount: 4_000 },
      { itemType: "ap", sourceId: "PI-B", partySourceId: "V1", documentNumber: "G66-OPEN-B", issueDate: "2026-05-15", dueDate: "2026-06-15", originalAmount: 6_000, outstandingAmount: 6_000 },
    ] }), 200);
    const validated = await h.api("admin", "POST", `/migration/batches/${id}/validate`);
    ok(validated, 200);
    expect(validated.body.ok, JSON.stringify(validated.body.checks)).toBe(true);
    ok(await h.api("admin", "POST", `/migration/batches/${id}/commit`), 200);
    ok(await h.api("admin", "POST", `/migration/batches/${id}/reverse`, { reason: "the opening payables were taken from the wrong ledger" }), 200);
    const bills = (await pool.query(
      `SELECT id, bill_number, total::text AS total FROM bills
        WHERE organization_id = $1 AND is_opening AND reversed_at IS NOT NULL ORDER BY bill_number`, [orgId],
    )).rows as Array<{ id: number; bill_number: string; total: string }>;
    expect(bills.map((b) => [b.bill_number, Number(b.total)]), "the reversal MARKED both opening bills").toEqual([["G66-OPEN-A", 4_000], ["G66-OPEN-B", 6_000]]);
    reversed.a = { id: bills[0]!.id, total: Number(bills[0]!.total) };
    reversed.b = { id: bills[1]!.id, total: Number(bills[1]!.total) };
  }

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "G66 Proof Co", "318181818186613");
    await h.mkUser("admin", PW, orgId, "admin");
    await h.mkUser("bookkeeper", PW, orgId, "bookkeeper");
    await h.start();
    for (const who of ["admin", "bookkeeper"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);

    const bank = await h.api("admin", "POST", "/bank-accounts", { name: "G66 Proof Ops", bankName: "Riyad", currency: "SAR" });
    ok(bank, 201);
    bankId = bank.body.id;
    const vendor = await h.api("admin", "POST", "/vendors", { name: "G66 Proof Supplies", taxNumber: "300000000000003" });
    ok(vendor, 201);
    vendorId = vendor.body.id;

    await reversedOpeningBills();

    // A LIVE bill of the same supplier (no VAT), approved; a credit note against it, approved — the note's balance funds the APPLY path.
    const live = await h.api("bookkeeper", "POST", "/bills", {
      supplierDocumentKind: "tax_invoice", vendorReference: "G66-SUP-1", billNumber: "G66-LIVE-1", date: "2026-08-01", dueDate: "2026-08-31", vendorId,
      items: [{ description: "Supplies", quantity: 1, unitPrice: 10_000, vatRate: 0 }],
    });
    ok(live, 201);
    ok(await h.api("admin", "POST", `/bills/${live.body.id}/approve`, {}), 200);
    liveBillId = live.body.id;
    const note = await h.api("bookkeeper", "POST", "/bills", {
      supplierDocumentKind: "tax_invoice", vendorReference: "G66-SUP-CN-1", billNumber: "G66-CN-1", date: "2026-08-05", vendorId, documentType: "credit_note",
      creditNoteAgainstBillId: liveBillId, items: [{ description: "Returned supplies", quantity: 1, unitPrice: 5_000, vatRate: 0 }],
    });
    ok(note, 201);
    ok(await h.api("admin", "POST", `/bills/${note.body.id}/approve`, {}), 200);
    noteId = note.body.id;
    // An ADVANCE on account — the money the ALLOCATE path applies.
    const advance = await h.api("admin", "POST", "/supplier-payments", { vendorId, bankAccountId: bankId, amount: 10_000, paidAt: PAID_AT, classification: "advance" });
    ok(advance, 201);
    advanceId = advance.body.id;
  }, 180_000);

  afterAll(async () => {
    await h.stop();
    await h.cleanup();
  });

  it("🔴 the instrument sees movement: applying the advance to the LIVE bill adds an allocation and an entry, moves AP on both sides, and the tie holds", async () => {
    const before = await snapshot();
    expect([before.glAgrees, before.eventsReconcile], JSON.stringify(before.glTie)).toEqual([true, true]);
    const res = await h.api("admin", "POST", `/supplier-payments/${advanceId}/allocate`, { allocations: [{ billId: liveBillId, amount: 1_000 }] });
    ok(res, 200);
    const after = await snapshot();
    expect(after).toEqual({
      ...before,
      allocations: before.allocations + 1,
      journalEntries: before.journalEntries + 1,
      apGl: before.apGl - 1_000,
      glTie: {
        ...before.glTie,
        ap: { fromSubledger: before.glTie.ap.fromSubledger - 1_000, fromGl: before.glTie.ap.fromGl - 1_000 },
        advances: { fromSubledger: before.glTie.advances.fromSubledger - 1_000, fromGl: before.glTie.advances.fromGl - 1_000 },
      },
    });
  });

  it("🔴 create, allocate and apply each REFUSE (4xx) a full and a partial application to a reversed opening bill, and nothing moves: no payment, allocation or entry; AP subledger = GL", async () => {
    const attempts: Array<[string, () => Promise<Res>]> = [
      ["create · full", () => h.api("admin", "POST", "/supplier-payments", { vendorId, bankAccountId: bankId, amount: reversed.a.total, paidAt: PAID_AT, allocations: [{ billId: reversed.a.id, amount: reversed.a.total }] })],
      ["create · partial", () => h.api("admin", "POST", "/supplier-payments", { vendorId, bankAccountId: bankId, amount: 100, paidAt: PAID_AT, allocations: [{ billId: reversed.b.id, amount: 100 }] })],
      ["allocate · full", () => h.api("admin", "POST", `/supplier-payments/${advanceId}/allocate`, { allocations: [{ billId: reversed.a.id, amount: reversed.a.total }] })],
      ["allocate · partial", () => h.api("admin", "POST", `/supplier-payments/${advanceId}/allocate`, { allocations: [{ billId: reversed.b.id, amount: 100 }] })],
      ["apply · full", () => h.api("admin", "POST", `/supplier-credit-notes/${noteId}/apply`, { allocations: [{ billId: reversed.a.id, amount: reversed.a.total }] })],
      ["apply · partial", () => h.api("admin", "POST", `/supplier-credit-notes/${noteId}/apply`, { allocations: [{ billId: reversed.b.id, amount: 100 }] })],
    ];
    const observed: Record<string, unknown> = {};
    const expected: Record<string, unknown> = {};
    for (const [label, go] of attempts) {
      const before = await snapshot();
      const res = await go();
      const after = await snapshot();
      observed[label] = { refused4xx: res.status >= 400 && res.status < 500, http: `${res.status} ${res.body?.code ?? ""}`.trim(), ...after };
      expected[label] = { refused4xx: true, http: observed[label] && (observed[label] as { http: string }).http, ...before, glAgrees: true, eventsReconcile: true };
    }
    // One comparison, so a red run reports every path's status and every figure that moved.
    expect(observed).toEqual(expected);
  });

  it("D-4 (added with the fix, after the red runs): every path answers exactly as payBill does — 409 opening_item_reversed, naming the bill — and payBill itself still does", async () => {
    const before = await snapshot();
    const answers = [
      await h.api("admin", "POST", "/supplier-payments", { vendorId, bankAccountId: bankId, amount: 50, paidAt: PAID_AT, allocations: [{ billId: reversed.b.id, amount: 50 }] }),
      await h.api("admin", "POST", `/supplier-payments/${advanceId}/allocate`, { allocations: [{ billId: reversed.b.id, amount: 50 }] }),
      await h.api("admin", "POST", `/supplier-credit-notes/${noteId}/apply`, { allocations: [{ billId: reversed.b.id, amount: 50 }] }),
      await h.api("admin", "POST", `/bills/${reversed.b.id}/pay`, { amount: 50, paidAt: PAID_AT, bankAccountId: bankId }),
    ];
    expect(answers.map((r) => [r.status, r.body?.code, /G66-OPEN-B/.test(String(r.body?.error))]), JSON.stringify(answers.map((r) => r.body))).toEqual([
      [409, "opening_item_reversed", true],
      [409, "opening_item_reversed", true],
      [409, "opening_item_reversed", true],
      [409, "opening_item_reversed", true],
    ]);
    expect(await snapshot()).toEqual(before);
  });
});
