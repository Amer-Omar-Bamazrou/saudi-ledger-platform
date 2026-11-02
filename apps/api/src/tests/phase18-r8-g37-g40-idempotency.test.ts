/**
 * 🔴 Phase 18 R-8 — G37/G40, memo §2e (register §11.104): idempotency keys on
 * ALLOCATE, APPLY and REFUND — customer and supplier side, six paths — by
 * #217's one implementation (the bill payment's key: a request fingerprint on
 * the effect row, replay-or-refuse before any write and again under the lock).
 *
 * For each path, the memo's five cases:
 *   1. same key, same body → the same answer, ONE effect;
 *   2. same key, different body → refused 409 `idempotency_key_reused`, nothing written;
 *   3. two requests with the same key AT ONCE (forced: both queue behind a
 *      holder's row lock before either runs) → one effect, and the second is
 *      answered the replay;
 *   4. the same key in the SISTER company of the same organisation → independent;
 *   5. a first attempt that rolls back after its rows were written (its audit
 *      write fails) → the retry with the same key is one effect.
 * And: keys are scoped to the OPERATION — the same key on an allocate and an
 * apply of one company are independent, on each side; a prior keyed row that
 * carries no fingerprint (recorded before the rule) is refused, never replayed.
 *
 * The services are called in-process inside real tenant transactions (the app
 * role, RLS on), as the request runs them. DB-backed (sl_test / CI).
 */
process.env.PORT ??= "3218";
process.env.SESSION_SECRET ??= "r8-g37-g40-idempotency-0000000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
import { lockWaiters, until } from "./helpers/g08rRace";
import { createApproved } from "./helpers/createApproved";
import { invoicesService } from "../services/invoices.service";
import { paymentsService } from "../services/payments.service";
import { bankAccountsService } from "../services/bankAccounts.service";
import { billsService } from "../services/bills.service";
import { supplierPaymentsService } from "../services/accounting/supplierPayments.service";
import { supplierCreditNotesService } from "../services/accounting/supplierCreditNotes.service";
import { auditService } from "../services/audit.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const DATE = "2026-06-15";

type Run = <T>(fn: () => Promise<T>) => Promise<T>;
type Co = { run: Run; bank: number; label: string };
type Ctx = { source: number; target?: number; co: Co };
type Path = {
  name: string;
  /** The row the operation locks — held to force two requests to queue. */
  lock: { table: string };
  audit: { action: string; entityType: string };
  prepare: (co: Co) => Promise<Ctx>;
  call: (ctx: Ctx, key: string, amount: number) => Promise<any>;
  /** The answer, reduced to what a replay must repeat. */
  project: (out: any) => unknown;
  /** The effect rows this operation wrote for this source. */
  effects: (ctx: Ctx) => Promise<number>;
};

describeMaybe("Phase 18 R-8 (G37/G40) — idempotency keys on allocate, apply and refund, one implementation", () => {
  const h = g04Harness("r8idem");
  let orgId = "";
  let userId = 0;
  let customerId = 0;
  let vendorId = 0;
  const cos: Record<"A" | "B", Co> = {} as never;
  let seq = 0;
  const count = async (sql: string, id: number) => Number((await pool.query(sql, [id])).rows[0].n);

  // ── fixtures, through the product's own services ──────────────────────────
  const invoice = (co: Co, net: number) => co.run(() => createApproved<{ id: number }>(invoicesService,
    { invoiceNumber: `R8-${co.label}-${++seq}`, date: DATE, dueDate: DATE, customerId, items: [{ description: "Work", quantity: 1, unitPrice: net, vatRate: 15 }] }, userId));
  const creditNote = (co: Co, originalId: number, net: number) => co.run(() => createApproved<{ id: number }>(invoicesService,
    { invoiceNumber: `R8-${co.label}-${++seq}`, date: DATE, dueDate: DATE, customerId, documentType: "credit_note", originalInvoiceId: originalId, noteReason: "Return",
      items: [{ description: "Return", quantity: 1, unitPrice: net, vatRate: 15 }] }, userId));
  const receipt = (co: Co, amount: number) => co.run(() => paymentsService.receive({ customerId, amount, paidAt: DATE, bankAccountId: co.bank, allocations: [] }, userId));
  const bill = async (co: Co, total: number) => {
    const b = await co.run(() => billsService.create({ billNumber: `R8-B-${co.label}-${++seq}`, date: DATE, vendorId, items: [{ description: "Supply", quantity: 1, unitPrice: total, vatRate: 0 }] }, userId));
    return co.run(() => billsService.approve(b.id, {}, userId));
  };
  const advance = (co: Co, amount: number) => co.run(() => supplierPaymentsService.create(
    { vendorId, amount, bankAccountId: co.bank, paidAt: DATE, classification: "advance", reference: `R8-ADV-${co.label}-${++seq}` }, userId));
  const supplierNote = async (co: Co, againstBillId: number, amount: number) => {
    const n = await co.run(() => billsService.create({ supplierDocumentKind: "tax_invoice", vendorReference: `R8-SN-${co.label}-${++seq}`, billNumber: `R8-SN-${co.label}-${seq}`,
      date: DATE, vendorId, documentType: "credit_note", creditNoteAgainstBillId: againstBillId, items: [{ description: "Return", quantity: 1, unitPrice: amount, vatRate: 0 }] }, userId));
    return co.run(() => billsService.approve(n.id, {}, userId));
  };

  const PATHS: Path[] = [
    {
      name: "customer allocate (a receipt's deposit to an invoice)", lock: { table: "payments" }, audit: { action: "allocate", entityType: "payment" },
      prepare: async (co) => ({ co, target: (await invoice(co, 1000)).id, source: (await receipt(co, 500)).id }),
      call: (c, key, amount) => c.co.run(() => paymentsService.allocate(c.source, { allocations: [{ invoiceId: c.target!, amount }], idempotencyKey: key }, userId)),
      project: (o) => [o.id, o.allocatedAmount],
      effects: (c) => count(`SELECT count(*)::int n FROM payment_allocations WHERE payment_id = $1`, c.source),
    },
    {
      name: "customer credit-note apply", lock: { table: "invoices" }, audit: { action: "apply", entityType: "credit_note" },
      prepare: async (co) => {
        // the original is PAID first: a note against an unpaid invoice settles it at issue, leaving nothing to apply
        const original = await invoice(co, 1000);
        await co.run(() => paymentsService.receive({ customerId, amount: 1150, paidAt: DATE, bankAccountId: co.bank, allocations: [{ invoiceId: original.id, amount: 1150 }] }, userId));
        return { co, source: (await creditNote(co, original.id, 400)).id, target: (await invoice(co, 1000)).id };
      },
      call: (c, key, amount) => c.co.run(() => paymentsService.applyCreditNote(c.source, { allocations: [{ invoiceId: c.target!, amount }], idempotencyKey: key }, userId)),
      project: (o) => [o.creditNoteId, o.appliedAmount],
      effects: (c) => count(`SELECT count(*)::int n FROM payment_allocations WHERE credit_note_id = $1`, c.source),
    },
    {
      name: "customer refund (of a receipt's deposit)", lock: { table: "payments" }, audit: { action: "refund", entityType: "customer_refund" },
      prepare: async (co) => ({ co, source: (await receipt(co, 500)).id }),
      call: (c, key, amount) => c.co.run(() => paymentsService.refund({ customerId, origin: "deposit", paymentId: c.source, amount, bankAccountId: c.co.bank, refundedAt: DATE, reason: "R8 refund", idempotencyKey: key }, userId)),
      project: (o) => [o.id, o.amount],
      effects: (c) => count(`SELECT count(*)::int n FROM customer_refunds WHERE payment_id = $1`, c.source),
    },
    {
      name: "supplier allocate (an advance to a bill)", lock: { table: "supplier_payments" }, audit: { action: "allocate", entityType: "supplier_payment" },
      prepare: async (co) => ({ co, target: (await bill(co, 1000)).id, source: (await advance(co, 500)).id }),
      call: (c, key, amount) => c.co.run(() => supplierPaymentsService.allocate(c.source, { allocations: [{ billId: c.target!, amount }], date: DATE, idempotencyKey: key } as never, userId)),
      project: (o) => [o.id, o.availableAmount],
      effects: (c) => count(`SELECT count(*)::int n FROM supplier_payment_allocations WHERE supplier_payment_id = $1`, c.source),
    },
    {
      name: "supplier credit-note apply", lock: { table: "bills" }, audit: { action: "apply", entityType: "supplier_credit_note" },
      prepare: async (co) => {
        const original = await bill(co, 1000);
        return { co, source: (await supplierNote(co, original.id, 400)).id, target: (await bill(co, 1000)).id };
      },
      call: (c, key, amount) => c.co.run(() => supplierCreditNotesService.apply(c.source, { allocations: [{ billId: c.target!, amount }], idempotencyKey: key } as never, userId)),
      project: (o) => [o.id, o.availableAmount],
      effects: (c) => count(`SELECT count(*)::int n FROM supplier_payment_allocations WHERE supplier_credit_note_id = $1`, c.source),
    },
    {
      name: "supplier refund (of an advance)", lock: { table: "supplier_payments" }, audit: { action: "create", entityType: "supplier_refund" },
      prepare: async (co) => ({ co, source: (await advance(co, 500)).id }),
      call: (c, key, amount) => c.co.run(() => supplierPaymentsService.refund(c.source, { amount, bankAccountId: c.co.bank, refundedAt: DATE, reason: "R8 refund", idempotencyKey: key } as never, userId)),
      project: (o) => [o.id, o.amount],
      effects: (c) => count(`SELECT count(*)::int n FROM supplier_refunds WHERE supplier_payment_id = $1`, c.source),
    },
  ];

  /** Hold `table`'s row `id`; send each act, see it queue behind the hold; release; every act's settled result. */
  async function queued(table: string, id: number, acts: Array<() => Promise<unknown>>) {
    const holder = await pool.connect();
    let open = false;
    try {
      await holder.query("BEGIN");
      open = true;
      const pid = Number((await holder.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
      await holder.query(`SELECT id FROM "${table}" WHERE id = $1 FOR UPDATE`, [id]);
      const sent: Promise<unknown>[] = [];
      for (const act of acts) {
        sent.push(act());
        const k = sent.length;
        await until(`request ${k} did not queue on ${table} ${id}`, async () => (await lockWaiters(pid)) >= k);
      }
      await holder.query("COMMIT");
      open = false;
      return await Promise.allSettled(sent);
    } finally {
      if (open) await holder.query("ROLLBACK");
      holder.release();
    }
  }
  const refusal = (e: any) => [e?.statusCode, e?.payload?.code];

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    const coA = await h.mkCompany(orgId, "R8 Co A", "319191919191103");
    const coB = await h.mkCompany(orgId, "R8 Co B", "319191919191203");
    userId = await h.mkUser("admin", "R8IdemPw123!", orgId, "admin");
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'R8 Customer') RETURNING id`, [orgId])).rows[0].id;
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name, residency) VALUES ($1,'R8 Supplier','resident') RETURNING id`, [orgId])).rows[0].id;
    for (const [label, companyId] of [["A", coA], ["B", coB]] as const) {
      const run: Run = (fn) => h.inTenant(orgId, companyId, userId, fn);
      const bank = (await run(() => bankAccountsService.create({ name: `R8 Bank ${label}`, bankName: "SNB", currency: "SAR" }))).id as number;
      cos[label] = { run, bank, label };
    }
  }, 120_000);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await h.cleanup(); });

  for (const p of PATHS) {
    describe(p.name, () => {
      it("1 — same key, same body: the same answer, ONE effect", async () => {
        const c = await p.prepare(cos.A);
        const key = `r8-${++seq}`;
        const first = await p.call(c, key, 100);
        const again = await p.call(c, key, 100);
        expect(p.project(again)).toEqual(p.project(first));
        expect(await p.effects(c)).toBe(1);
      });

      it("🔴 2 — same key, a DIFFERENT body: refused 409 idempotency_key_reused, nothing written", async () => {
        const c = await p.prepare(cos.A);
        const key = `r8-${++seq}`;
        await p.call(c, key, 100);
        const err = await p.call(c, key, 60).then(() => null, (e) => e);
        expect(refusal(err)).toEqual([409, "idempotency_key_reused"]);
        expect(await p.effects(c)).toBe(1);
      });

      it("🔴 3 — two requests with the same key AT ONCE: one effect, and the second is answered the replay", async () => {
        const c = await p.prepare(cos.A);
        const key = `r8-${++seq}`;
        const [a, b] = await queued(p.lock.table, c.source, [() => p.call(c, key, 100), () => p.call(c, key, 100)]);
        expect([a!.status, b!.status], JSON.stringify([a, b].map((r) => (r!.status === "rejected" ? refusal((r as PromiseRejectedResult).reason) : "ok")))).toEqual(["fulfilled", "fulfilled"]);
        expect(p.project((b as PromiseFulfilledResult<unknown>).value)).toEqual(p.project((a as PromiseFulfilledResult<unknown>).value));
        expect(await p.effects(c)).toBe(1);
      });

      it("4 — the same key in the SISTER company is independent: one effect in each", async () => {
        const ca = await p.prepare(cos.A);
        const cb = await p.prepare(cos.B);
        const key = `r8-${++seq}`;
        await p.call(ca, key, 100);
        await p.call(cb, key, 100);
        expect([await p.effects(ca), await p.effects(cb)]).toEqual([1, 1]);
      });

      it("5 — a first attempt rolled back after its rows were written, then the retry: ONE effect", async () => {
        const c = await p.prepare(cos.A);
        const key = `r8-${++seq}`;
        const original = auditService.record.bind(auditService);
        let planted = false;
        vi.spyOn(auditService, "record").mockImplementation(async (input) => {
          if (!planted && input.action === p.audit.action && input.entityType === p.audit.entityType) {
            planted = true;
            throw new Error("R8 planted failure after the effect rows");
          }
          return original(input);
        });
        await expect(p.call(c, key, 100)).rejects.toThrow(/R8 planted failure/);
        expect(planted).toBe(true);
        expect(await p.effects(c)).toBe(0);
        vi.restoreAllMocks();
        await p.call(c, key, 100);
        expect(await p.effects(c)).toBe(1);
      });
    });
  }

  describe("keys are scoped to the OPERATION", () => {
    it("🔴 customer side: one key on an allocate and on a credit-note apply of the same company — independent", async () => {
      const [alloc, apply] = [PATHS[0]!, PATHS[1]!];
      const ca = await alloc.prepare(cos.A);
      const cp = await apply.prepare(cos.A);
      const key = `r8-${++seq}`;
      await alloc.call(ca, key, 100);
      await apply.call(cp, key, 100);
      expect([await alloc.effects(ca), await apply.effects(cp)]).toEqual([1, 1]);
    });
    it("🔴 supplier side: one key on an allocate and on a credit-note apply of the same company — independent", async () => {
      const [alloc, apply] = [PATHS[3]!, PATHS[4]!];
      const ca = await alloc.prepare(cos.A);
      const cp = await apply.prepare(cos.A);
      const key = `r8-${++seq}`;
      await alloc.call(ca, key, 100);
      await apply.call(cp, key, 100);
      expect([await alloc.effects(ca), await apply.effects(cp)]).toEqual([1, 1]);
    });
  });

  it("🔴 a prior keyed row with NO fingerprint (recorded before the rule) is refused, never replayed", async () => {
    const { replayOrRefuse } = await import("../lib/idempotency");
    const idem = { key: "legacy-key", fingerprint: "f".repeat(64) };
    const legacy = () => replayOrRefuse({ requestFingerprint: null }, idem, "allocation");
    expect(legacy).toThrow();
    let code: unknown;
    try { legacy(); } catch (e: any) { code = [e?.statusCode, e?.payload?.code]; }
    expect(code).toEqual([409, "idempotency_key_reused"]);
    expect(replayOrRefuse({ requestFingerprint: idem.fingerprint }, idem, "allocation")).toBe(true);
    expect(replayOrRefuse(undefined, idem, "allocation")).toBe(false);
  });
});
