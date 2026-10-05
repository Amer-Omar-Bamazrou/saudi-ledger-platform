/**
 * PAYMENT PLANS — scheduling a supplier payment (Phase 17, D17-05;
 * docs/product/phase-16-17-tax-treasury-decision-pack.md §8.7).
 *
 *   planned ──approve──▶ approved ──pay──▶ paid
 *      │                    │
 *      └──── cancel ────────┴──▶ cancelled (with a reason)
 *
 * 🔴 A plan is an INTENTION, not a payment: it moves no ledger line. "paid"
 * is reached ONLY by paying through the EXISTING bill pay path (`payBill` —
 * WHT included, §2.4), and the database checks the payment it names is this
 * bill's, for this amount (migration 0114). Nothing here instructs a bank or
 * runs on a schedule: there is no automatic bank execution in this product.
 *
 * 🔴 Never more than the bill owes: Σ open plans of a bill ≤ `billPosition`'s
 * outstanding, checked under the BILL'S row lock (the pay path takes the same
 * lock), so a plan and a payment cannot race. A plan the bill no longer
 * covers (paid another way) is refused at execution BY NAME, never trimmed.
 */
import { businessToday } from "@workspace/shared";
import { WHT_PAYMENT_TYPES } from "@workspace/db";
import { BadRequestError, BusinessRuleError, NotFoundError } from "../../lib/errors";
import { fromHalalas, round2, toHalalas } from "../../lib/money";
import { treasuryRepository, type PlanRow } from "../../repositories/treasury.repository";
import { billsRepository } from "../../repositories/bills.repository";
import { assertBankAccount } from "../accounting/bankIdentity";
import { assertNotReversedOpening } from "../accounting/openingReversed";
import { decideWithholding } from "../accounting/wht";
import { payBill } from "../bills.payment";
import { auditService } from "../audit.service";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ID = 2_147_483_647;
const PRIORITIES = ["high", "normal", "low"] as const;
const refuse = (status: number, code: string, error: string, field?: string): never => {
  throw new BusinessRuleError(status, { code, error, ...(field ? { field } : {}) });
};
const validId = (id: number) => {
  if (!Number.isSafeInteger(id) || id <= 0 || id > MAX_ID) throw new NotFoundError("Payment plan not found.");
  return id;
};

async function planOut(p: PlanRow) {
  const today = businessToday();
  const outstanding = Number(p.bill_outstanding);
  const amount = Number(p.amount);
  // the WHT a non-resident's payment would withhold on the planned date — an ESTIMATE, decided by the pay
  // path's OWN function (QA 2026-10-04: a second rule here ignored the supplier's declared default nature
  // and an approved treaty relief, so a plan said "no estimate" or showed the statutory rate)
  // 🔴 only an OPEN plan is estimated: a paid plan shows what its payment RECORDED (QA 2026-10-04 — a paid plan
  // showed a re-estimate with today's supplier, relief and rate, a figure the payment never withheld)
  const open = p.status === "planned" || p.status === "approved";
  let whtEstimate: number | null = null;
  if (open && p.vendor_residency === "non_resident" && amount > 0) {
    try {
      const d = await decideWithholding({ vendorId: p.vendor_id, paymentDate: p.planned_date < today ? today : p.planned_date, base: amount, paymentClass: "bill_payment", declared: { paymentType: p.wht_payment_type } });
      whtEstimate = d.kind === "withheld" ? fromHalalas(d.whtH) : d.kind === "not_subject" ? 0 : null;
    } catch {
      whtEstimate = null; // undecidable until the payment states its nature — said so on the page, never a guessed rate
    }
  }
  const whtWithheld = p.status === "paid" && p.paid_wht != null ? Number(p.paid_wht) : null;
  return {
    id: p.id, billId: p.bill_id, billNumber: p.bill_number, vendorId: p.vendor_id, vendorName: p.vendor_name, vendorNameAr: p.vendor_name_ar,
    vendorResidency: p.vendor_residency, billDueDate: p.bill_due_date, billDate: p.bill_date, billOutstanding: outstanding,
    plannedDate: p.planned_date, amount, bankAccountId: p.bank_account_id, bankName: p.bank_name,
    priority: p.priority as (typeof PRIORITIES)[number], status: p.status as "planned" | "approved" | "paid" | "cancelled",
    whtPaymentType: p.wht_payment_type, whtEstimate, whtWithheld,
    cashEstimate: open ? (whtEstimate == null ? amount : round2(amount - whtEstimate)) : whtWithheld != null ? round2(amount - whtWithheld) : amount,
    notes: p.notes, createdBy: p.created_by, createdAt: p.created_at, approvedBy: p.approved_by, approvedAt: p.approved_at,
    paidBillPaymentId: p.paid_bill_payment_id, paidBy: p.paid_by, paidAt: p.paid_at,
    cancelledBy: p.cancelled_by, cancelledAt: p.cancelled_at, cancelReason: p.cancel_reason,
    /** Open and dated before today — the plan's day passed without it being paid. */
    overdue: open && p.planned_date < today,
    /** Open and larger than what the bill now owes (it was paid another way, or reversed) — refused at execution. */
    exceedsOutstanding: open && toHalalas(amount) > toHalalas(outstanding),
    /** The bill is an opening item the migration reversed (Policy C): it owes nothing, and an open plan on it is to be cancelled. */
    billReversed: p.bill_reversed === true,
  };
}

async function loadPlan(id: number, lock = false) {
  const p = await treasuryRepository.planById(validId(id), { lock });
  if (!p) throw new NotFoundError("Payment plan not found.");
  return p;
}
async function readPlan(id: number) {
  const [row] = await treasuryRepository.plans({ id });
  if (!row) throw new NotFoundError("Payment plan not found.");
  return planOut(row);
}

/** Validate a plan's terms against the bill, under the bill's row lock. */
async function checkTerms(billId: number, amount: number, excludePlanId?: number) {
  const bill = await treasuryRepository.lockBill(billId);
  if (!bill) throw new NotFoundError("Bill not found.");
  // Policy C: a reversed opening bill is history — nothing plans its payment (the database refuses it too, 0115)
  assertNotReversedOpening({ reversedAt: bill.reversed_at }, `Bill ${bill.bill_number ?? billId}`, "planned for payment");
  if (bill.status === "draft" || bill.status === "submitted") refuse(409, "plan_bill_not_posted", "Only an approved bill is planned for payment — a draft owes nothing yet.", "billId");
  if (bill.document_type !== "bill" && bill.document_type !== "debit_note") refuse(409, "plan_bill_not_payable", "Only a bill or a debit note is paid; a credit note or an advance document is not.", "billId");
  const outstanding = await billsRepository.outstandingOf(billId, { lock: false });
  const planned = await treasuryRepository.openPlannedFor(billId, excludePlanId);
  const room = round2(outstanding - planned);
  if (toHalalas(amount) > toHalalas(room)) {
    refuse(409, "plan_exceeds_outstanding", `Bill ${bill.bill_number ?? billId} owes ${outstanding.toFixed(2)}${planned > 0 ? `, of which ${planned.toFixed(2)} is already planned` : ""}; a plan of ${amount.toFixed(2)} exceeds what is left (${Math.max(0, room).toFixed(2)}).`, "amount");
  }
  return bill;
}

function parseAmount(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || Math.abs(n * 100 - Math.round(n * 100)) > 1e-6 || n > 9_999_999_999_999.99) throw new BadRequestError("amount is a positive amount with at most two decimals.");
  return n;
}
function parsePlanned(v: unknown): string {
  const d = String(v ?? "");
  if (!ISO.test(d)) throw new BadRequestError("plannedDate is a YYYY-MM-DD date.");
  if (d < businessToday()) refuse(422, "plan_date_in_past", "A plan is for a day still to come; to record a payment already made, pay the bill.", "plannedDate");
  return d;
}
function parseWhtType(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (!(WHT_PAYMENT_TYPES as readonly string[]).includes(String(v))) throw new BadRequestError("whtPaymentType must be a payment nature of IR Art. 63(1).");
  return String(v);
}
async function parseBank(v: unknown): Promise<number | null> {
  if (v == null || v === "") return null;
  return assertBankAccount(v, { what: "the plan would pay from" });
}

export const paymentPlansService = {
  async list(q: { status?: unknown; billId?: unknown } = {}) {
    const status = q.status == null || q.status === "" ? undefined : String(q.status).split(",");
    if (status && status.some((s) => !["planned", "approved", "paid", "cancelled"].includes(s))) throw new BadRequestError("status is planned, approved, paid or cancelled (comma-separated).");
    const billId = q.billId == null || q.billId === "" ? undefined : Number(q.billId);
    if (billId != null && (!Number.isSafeInteger(billId) || billId <= 0 || billId > MAX_ID)) throw new BadRequestError("billId must be a positive integer.");
    return Promise.all((await treasuryRepository.plans({ status, billId })).map(planOut));
  },

  async create(body: Record<string, unknown>, userId: number | null) {
    const billId = Number(body.billId);
    if (!Number.isSafeInteger(billId) || billId <= 0 || billId > MAX_ID) throw new BadRequestError("billId must be a positive integer.");
    const amount = parseAmount(body.amount);
    const plannedDate = parsePlanned(body.plannedDate);
    const priority = String(body.priority ?? "normal");
    if (!(PRIORITIES as readonly string[]).includes(priority)) throw new BadRequestError("priority is high, normal or low.");
    const bankAccountId = await parseBank(body.bankAccountId);
    const whtPaymentType = parseWhtType(body.whtPaymentType);
    await checkTerms(billId, amount);
    const [row] = await treasuryRepository.insertPlan({
      billId, plannedDate, amount: amount.toFixed(2), bankAccountId, priority, whtPaymentType,
      notes: typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null, createdBy: userId,
    });
    await auditService.created("scheduled_payment", row!.id, row);
    return readPlan(row!.id);
  },

  async update(id: number, body: Record<string, unknown>) {
    const before = await loadPlan(id, true);
    if (before.status !== "planned") refuse(409, "plan_locked", `This plan is ${before.status}: only a plan not yet approved is edited. Cancel it and plan again.`);
    const amount = body.amount === undefined ? Number(before.amount) : parseAmount(body.amount);
    const plannedDate = body.plannedDate === undefined ? before.plannedDate : parsePlanned(body.plannedDate);
    const priority = body.priority === undefined ? before.priority : String(body.priority);
    if (!(PRIORITIES as readonly string[]).includes(priority)) throw new BadRequestError("priority is high, normal or low.");
    const bankAccountId = body.bankAccountId === undefined ? before.bankAccountId : await parseBank(body.bankAccountId);
    const whtPaymentType = body.whtPaymentType === undefined ? before.whtPaymentType : parseWhtType(body.whtPaymentType);
    await checkTerms(before.billId, amount, before.id);
    const notes = body.notes === undefined ? before.notes : typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null;
    const [after] = await treasuryRepository.updatePlan(id, { amount: amount.toFixed(2), plannedDate, priority, bankAccountId, whtPaymentType, notes });
    await auditService.updated("scheduled_payment", id, before, after);
    return readPlan(id);
  },

  async approve(id: number, userId: number | null) {
    const before = await loadPlan(id, true);
    if (before.status !== "planned") refuse(409, "plan_not_planned", `This plan is ${before.status}; only a planned one is approved.`);
    await checkTerms(before.billId, Number(before.amount), before.id);
    const [after] = await treasuryRepository.updatePlan(id, { status: "approved", approvedBy: userId, approvedAt: new Date() });
    await auditService.record({ action: "approve", entityType: "scheduled_payment", entityId: id, before, after });
    return readPlan(id);
  },

  /**
   * Execute an APPROVED plan: ONE call to the bill pay path, for the plan's
   * amount, from the named bank, dated today or an earlier stated day — never a
   * future one. WHT (pack §2.4) is decided there, from the plan's nature or the
   * request's.
   */
  async pay(id: number, body: Record<string, unknown>, userId: number | null) {
    const before = await loadPlan(id, true);
    if (before.status !== "approved") refuse(409, "plan_not_approved", before.status === "planned" ? "This plan is not approved yet — an approver approves it before it is paid." : `This plan is ${before.status}.`);
    const today = businessToday();
    const paidAt = typeof body.paidAt === "string" && body.paidAt ? body.paidAt : today;
    if (!ISO.test(paidAt)) throw new BadRequestError("paidAt is a YYYY-MM-DD date.");
    if (paidAt > today) refuse(422, "date_in_future", "A payment records money that has left: it is never dated in the future. Pay on the day, or leave the plan approved until then.", "paidAt");
    const bankAccountId = body.bankAccountId ?? before.bankAccountId;
    // the same lock order as the pay path; refused BY NAME when the bill no longer owes the plan's amount
    const outstanding = await billsRepository.outstandingOf(before.billId, { lock: true });
    if (toHalalas(Number(before.amount)) > toHalalas(outstanding)) {
      refuse(409, "plan_exceeds_outstanding", `The bill now owes ${outstanding.toFixed(2)} — it was partly or fully paid another way — so this plan of ${Number(before.amount).toFixed(2)} cannot be paid as planned. Cancel it, and plan what is left.`);
    }
    // The WHT declaration made AT PAYMENT governs: a not-subject reason, or an explicit nature (null included), replaces
    // the plan's stored nature — falling back to it only when the request says nothing (else a plan planned with a
    // nature could never be paid as not subject: the pay path would see both and refuse the conflict).
    const declaresAtPayment = body.whtNotSubjectReason != null || "whtPaymentType" in body;
    const result = await payBill(before.billId, {
      amount: Number(before.amount), paidAt, bankAccountId,
      whtPaymentType: declaresAtPayment ? (body.whtPaymentType ?? undefined) : (before.whtPaymentType ?? undefined),
      whtNotSubjectReason: body.whtNotSubjectReason, whtNotSubjectNote: body.whtNotSubjectNote,
    }, userId);
    const [after] = await treasuryRepository.updatePlan(id, { status: "paid", paidBillPaymentId: result.billPaymentId, paidBy: userId, paidAt: new Date() });
    await auditService.record({ action: "pay", entityType: "scheduled_payment", entityId: id, before, after: { ...after, payment: { billPaymentId: result.billPaymentId, journalEntryId: result.journalEntryId, cashPaid: result.cashPaid, withheld: result.withheld } } });
    return { plan: await readPlan(id), payment: { billPaymentId: result.billPaymentId, journalEntryId: result.journalEntryId, amount: result.amount, cashPaid: result.cashPaid, withheld: result.withheld } };
  },

  /** Cancel a planned or approved plan, with its reason (an approved one by an approver — the route is `/reject`). */
  async cancel(id: number, body: { reason?: unknown }, userId: number | null) {
    const before = await loadPlan(id, true);
    if (before.status !== "planned" && before.status !== "approved") refuse(409, "plan_not_open", `This plan is ${before.status}.`);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length < 3) refuse(422, "reason_required", "Say why the plan is cancelled — the record keeps it.", "reason");
    const [after] = await treasuryRepository.updatePlan(id, { status: "cancelled", cancelledBy: userId, cancelledAt: new Date(), cancelReason: reason });
    await auditService.record({ action: "cancel", entityType: "scheduled_payment", entityId: id, before, after });
    return readPlan(id);
  },

  /** Delete a plan that was never approved (a mistake); an approved one is cancelled instead. */
  async remove(id: number) {
    const before = await loadPlan(id, true);
    if (before.status !== "planned") refuse(409, "plan_locked", `This plan is ${before.status}: it is a record — cancel it with a reason instead.`);
    await treasuryRepository.deletePlan(id);
    await auditService.deleted("scheduled_payment", id, before);
  },
};
