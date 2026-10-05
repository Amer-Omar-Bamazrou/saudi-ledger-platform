/**
 * ACCOUNTANT Q1 (2026-10-05) — CORRECTING A WHT-BEARING PAYMENT.
 * Record: docs/product/phase-16-17-tax-treasury-decision-pack.md §14.1.
 *
 * Reversal + re-entry, never a mutation. In ONE transaction:
 *
 *   1. the ORIGINAL — the payment and its withholding — stays exactly as it
 *      was (both append-only; nothing here updates them);
 *   2. the REVERSAL — the mirror of the payment's own entry, through the ONE
 *      mirror writer (`journalEntriesService.reverse`, owner `wht_withholding`),
 *      dated the correction date, plus the `wht_corrections` record: why, who,
 *      when, the month whose return carries it, and the state the original was
 *      in (its filing, what of its month was remitted — written by the
 *      database);
 *   3. the CORRECTED transaction — a NEW payment through the existing pay path
 *      (`payBill` / `supplierPaymentsService.create`: one writer per effect),
 *      linked both ways (its withholding names the correction; the correction
 *      names it). Optional: a payment that should never have been recorded is
 *      reversed with no re-entry.
 *
 * The return month (Q1, the accountant): before the original's month is
 * filed, the correction is reflected IN that month's return. After filing, a
 * filed return is never rewritten silently — the person states the treatment:
 * `subsequent_period` (the accountant's recommendation: reported in the
 * correction's own, unfiled month) or `amendment` (ZATCA supports amendment:
 * the filed month's live figure changes and it reads "amendment due" until an
 * amendment filing is recorded). Which the law requires when is the adviser's
 * call (§14.1, open W-13b) — the product records the choice, it does not make it.
 *
 * Refused, never approximated: a payment touched since (a later allocation, a
 * refund, a moved balance), a cash line reconciled to the bank, a closed
 * period, a second correction (one per withholding — the database's unique
 * index; a double-click waits on the advisory lock and is answered by name, a
 * retried request with its idempotency key is replayed).
 */
import { sql } from "drizzle-orm";
import { businessToday } from "@workspace/shared";
import { db } from "@workspace/db";
import { BadRequestError, BusinessRuleError, NotFoundError } from "../../lib/errors";
import { taxRepository } from "../../repositories/tax.repository";
import { billsRepository } from "../../repositories/bills.repository";
import { journalEntriesRepository } from "../../repositories/journalEntries.repository";
import { journalEntriesService } from "../journalEntries.service";
import { payBill } from "../bills.payment";
import { supplierPaymentsService } from "../accounting/supplierPayments.service";
import { checkPeriodOpen } from "../accounting/periodLock";
import { latestFilingOf, WHT_FILED_MONTH_TREATMENTS, type WhtFiledMonthTreatment } from "../accounting/wht";
import { auditService } from "../audit.service";
import { whtService } from "./wht.service";

const MAX_ID = 2_147_483_647;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const refuse = (status: number, code: string, error: string, field?: string): never => {
  throw new BusinessRuleError(status, { code, error, ...(field ? { field } : {}) });
};
const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

export const whtCorrectionService = {
  /**
   * Correct the withholding `withholdingId` (and so its payment): reverse it, and re-enter the corrected payment when
   * `reentry` is given. Approver authority (the route is `…/reverse`).
   */
  async correct(withholdingId: number, body: Record<string, unknown>, userId: number | null) {
    if (!Number.isSafeInteger(withholdingId) || withholdingId <= 0 || withholdingId > MAX_ID) throw new NotFoundError("Withholding not found.");
    const idempotencyKey = str(body.idempotencyKey) ?? null;
    if (idempotencyKey) {
      const prior = await taxRepository.correctionByIdempotencyKey(idempotencyKey);
      if (prior) return { ...(await this.lineage(prior.withholdingId)), replayed: true };
    }
    // 🔴 one correction of one withholding at a time: a double-click or a second tab WAITS here, then finds the first
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`wht-correct:${withholdingId}`}))`);

    const w = await taxRepository.withholdingById(withholdingId);
    if (!w) throw new NotFoundError("Withholding not found.");
    const existing = await taxRepository.correctionOf(withholdingId);
    if (existing) {
      refuse(409, "wht_already_corrected", `This withholding was already corrected on ${existing.correctedOn} (correction #${existing.id}); the correction is the record. Correct its re-entry if that is wrong too.`);
    }
    const superseding = await taxRepository.supersedingOf(withholdingId);
    if (superseding) refuse(409, "wht_correction_superseded", `This record was replaced when the payment was reclassified; correct the payment's current record (#${superseding.id}).`);

    const reason = str(body.reason) ?? "";
    if (reason.length < 10) refuse(422, "reason_required", "Say why the payment is corrected — at least a sentence; the record keeps it with the original for ten years (IR Art. 63(9)(c)).", "reason");
    const today = businessToday();
    const date = str(body.date) ?? today;
    if (!ISO.test(date)) throw new BadRequestError("date is a YYYY-MM-DD date.");
    if (date > today) refuse(422, "date_in_future", "A correction is recorded on a day that has happened.", "date");
    if (date < w.paymentDate) refuse(422, "date_before_payment", `The payment was made on ${w.paymentDate}; it cannot be reversed before it happened.`, "date");

    // ── the payment: still as it was posted ─────────────────────────────────
    let billPayment: Awaited<ReturnType<typeof taxRepository.billPaymentById>> | null = null;
    let ownAllocations: Awaited<ReturnType<typeof taxRepository.ownAllocations>> = [];
    if (w.sourceKind === "bill_payment") {
      billPayment = await taxRepository.billPaymentById(w.billPaymentId!);
      if (!billPayment) throw new NotFoundError("The withholding's bill payment was not found.");
      await billsRepository.outstandingOf(billPayment.bill_id, { lock: true }); // the pay path's lock order: the bill row
    } else {
      const payment = await supplierPaymentsService.findOrThrow(w.supplierPaymentId!, { lock: true });
      const touches = await taxRepository.supplierPaymentTouches(payment.id, payment.journalEntryId);
      if (touches.length > 0) {
        refuse(409, "wht_correction_payment_touched", `This payment has been acted on since it was posted — ${touches.join("; ")} — so reversing its entry would no longer undo exactly what it did. Unwind those first; nothing was changed.`);
      }
      ownAllocations = await taxRepository.ownAllocations(payment.id, payment.journalEntryId);
    }
    const [entry] = await journalEntriesRepository.findById(w.journalEntryId);
    if (!entry || entry.status !== "posted") refuse(409, "wht_correction_entry_not_posted", "The payment's entry is not a posted entry; it cannot be reversed.");
    if (await journalEntriesRepository.reconciledToStatement(w.journalEntryId)) {
      refuse(409, "wht_payment_reconciled", "A bank statement line is reconciled to this payment. Undo that reconciliation in the Reconciliation Workbench first — the correction re-enters the payment, and the statement line is then reconciled to the corrected one.");
    }

    // ── 🔴 the return month of the reversal: never a filed return, silently ─────
    const correctionPeriod = date.slice(0, 7);
    const treatmentIn = str(body.filedMonthTreatment) ?? null;
    if (treatmentIn && !(WHT_FILED_MONTH_TREATMENTS as readonly string[]).includes(treatmentIn)) {
      throw new BadRequestError("filedMonthTreatment is subsequent_period or amendment.");
    }
    const filedOriginal = w.status === "withheld" ? await latestFilingOf(w.returnPeriod) : null;
    let treatment: WhtFiledMonthTreatment | null = null;
    let reversalReturnPeriod = w.returnPeriod;
    if (filedOriginal) {
      if (!treatmentIn) {
        refuse(409, "wht_month_filed",
          `${w.returnPeriod}'s withholding return (Form 06) is recorded as FILED on ${filedOriginal.filedOn} (${filedOriginal.zatcaReference}). The filed return is not rewritten: say how the correction is reported — in this month's own, unfiled return (subsequent period, the accountant's recommendation), or by amending ${w.returnPeriod}'s return (amendment).`,
          "filedMonthTreatment");
      }
      treatment = treatmentIn as WhtFiledMonthTreatment;
      if (treatment === "subsequent_period") {
        if (correctionPeriod <= w.returnPeriod) {
          refuse(422, "wht_subsequent_period_unavailable", `A subsequent-period correction is reported in the correction's month, which must be after ${w.returnPeriod}; ${date} is not. Date it in a later month, or amend ${w.returnPeriod}'s return.`, "date");
        }
        if (await latestFilingOf(correctionPeriod)) {
          refuse(409, "wht_subsequent_period_unavailable", `${correctionPeriod}'s return is recorded as filed too. Date the correction in a month whose return is not yet filed, or amend ${w.returnPeriod}'s return.`, "date");
        }
        reversalReturnPeriod = correctionPeriod;
      }
    }
    // 🔴 period locks: the mirror's month (and the re-entry's, by its own pay path) — refused before anything is written
    await checkPeriodOpen(date);
    const plansPaid = billPayment ? await taxRepository.plansPaidBy(billPayment.id) : [];

    // ── 2. the REVERSAL: the one mirror writer; the record written before the original is marked ──
    let correction: Awaited<ReturnType<typeof taxRepository.insertCorrection>>[number] | undefined;
    const mirror = await journalEntriesService.reverse(w.journalEntryId, { reason: `WHT correction: ${reason}`, date }, {
      document: "wht_withholding",
      beforeFlip: async (mirrorId) => {
        [correction] = await taxRepository.insertCorrection({
          withholdingId, sourceKind: w.sourceKind, billPaymentId: w.billPaymentId, supplierPaymentId: w.supplierPaymentId,
          reason, correctedOn: date, correctionPeriod, reversalJournalEntryId: mirrorId,
          reversalReturnPeriod, filedMonthTreatment: treatment,
          remittedAtCorrection: "0", // written by the database (the month's live remittances at this moment)
          idempotencyKey, createdBy: userId,
        });
      },
    });
    if (!correction) throw new Error("WHT correction: the record was not written beside its mirror");

    // ── the payment's own subledger effect, undone as the mirror undid the GL ──
    if (billPayment) {
      // the legacy counter is Σ live bill payments: the reversed one leaves it, so billPosition reads the bill as owing again
      if (!(await billsRepository.reverseBillPayment(billPayment.bill_id, Number(billPayment.amount)))) {
        throw new Error(`WHT correction: bill ${billPayment.bill_id}'s payment counter is below the payment being reversed`);
      }
      await supplierPaymentsService.refreshBill(billPayment.bill_id);
    } else {
      // the payment's own allocations are superseded by the same mirror (their AP debit is in it), each with the reason
      for (const a of ownAllocations) {
        await supplierPaymentsService.recordAllocationSuperseded(a.id, `Payment reversed (WHT correction #${correction.id}): ${reason}`, mirror.reversalId, userId);
        await supplierPaymentsService.refreshBill(a.bill_id);
      }
    }

    // ── 3. the CORRECTED transaction: a new payment through the existing pay path ──
    let reentry: { kind: "bill_payment" | "supplier_payment"; id: number } | null = null;
    const r = body.reentry && typeof body.reentry === "object" ? (body.reentry as Record<string, unknown>) : null;
    if (r) {
      const link = { correction: { id: correction.id, correctionPeriod } };
      const decl = {
        whtPaymentType: r.whtPaymentType, whtNotSubjectReason: r.whtNotSubjectReason, whtNotSubjectNote: r.whtNotSubjectNote,
        // the person's one treatment applies to whichever leg falls in a filed month
        whtFiledMonthTreatment: r.whtFiledMonthTreatment ?? treatmentIn ?? undefined,
      };
      if (w.sourceKind === "bill_payment") {
        const billId = r.billId == null || r.billId === "" ? billPayment!.bill_id : Number(r.billId);
        if (!Number.isSafeInteger(billId) || billId <= 0) throw new BadRequestError("reentry.billId must be a bill id.");
        const paid = await payBill(billId, {
          amount: r.amount, paidAt: str(r.paidAt) ?? w.paymentDate,
          bankAccountId: r.bankAccountId ?? billPayment!.bank_account_id, ...decl,
        } as Parameters<typeof payBill>[1], userId, link);
        await taxRepository.linkCorrection(correction.id, { correctedBillPaymentId: paid.billPaymentId });
        reentry = { kind: "bill_payment", id: paid.billPaymentId };
      } else {
        const original = await supplierPaymentsService.findOrThrow(w.supplierPaymentId!);
        const created = await supplierPaymentsService.create({
          vendorId: r.vendorId ?? original.vendorId, bankAccountId: r.bankAccountId ?? original.bankAccountId,
          amount: r.amount, paidAt: str(r.paidAt) ?? original.paidAt,
          classification: str(r.classification) ?? original.classification,
          allocations: Array.isArray(r.allocations) ? r.allocations : ownAllocations.map((a) => ({ billId: a.bill_id, amount: Number(a.amount) })),
          reference: str(r.reference) ?? original.reference ?? undefined, ...decl,
        }, userId, link) as { id: number };
        await taxRepository.linkCorrection(correction.id, { correctedSupplierPaymentId: created.id });
        reentry = { kind: "supplier_payment", id: created.id };
      }
    }

    await auditService.record({
      action: "wht_correct", entityType: "wht_withholding", entityId: withholdingId,
      before: { withholding: w, entryId: w.journalEntryId, returnPeriod: w.returnPeriod, filing: filedOriginal ? { id: filedOriginal.id, filedOn: filedOriginal.filedOn } : null },
      after: { correctionId: correction.id, reason, correctedOn: date, reversalJournalEntryId: mirror.reversalId, reversalReturnPeriod, filedMonthTreatment: treatment, reentry, plansPaidByTheOriginal: plansPaid, by: userId },
    });
    return { ...(await this.lineage(withholdingId)), replayed: false };
  },

  /**
   * One withholding's LINEAGE: the original (as recorded), its state (its return month's filing and remittances), its
   * correction and the corrected re-entry — or, for a re-entry, the original it corrects. Read-only.
   */
  async lineage(withholdingId: number) {
    if (!Number.isSafeInteger(withholdingId) || withholdingId <= 0 || withholdingId > MAX_ID) throw new NotFoundError("Withholding not found.");
    const [row] = await taxRepository.withholdings({ id: withholdingId });
    if (!row) {
      // a superseded record is not in the live lists; its lineage is its successor's
      const raw = await taxRepository.withholdingById(withholdingId);
      if (!raw) throw new NotFoundError("Withholding not found.");
      const next = await taxRepository.supersedingOf(withholdingId);
      refuse(409, "wht_correction_superseded", `This record was replaced when the payment was reclassified; see record #${next?.id ?? "?"}.`);
    }
    const ret = await whtService.monthlyReturn(row!.return_period);
    const original = [...ret.schedule, ...ret.excluded, ...ret.pending, ...ret.corrected].find((x) => x.id === withholdingId)!;
    const correction = row!.corr_id != null ? await taxRepository.correctionById(row!.corr_id) : null;
    const reentryRow = correction ? await taxRepository.reentryOf(correction.id) : null;
    const reentry = reentryRow ? await rowById(reentryRow.id) : null;
    const correctsRow = row!.correction_id != null ? await taxRepository.correctionById(row!.correction_id) : null;
    const corrects = correctsRow ? await rowById(correctsRow.withholdingId) : null;
    return {
      withholding: original,
      state: {
        returnPeriod: row!.return_period, filingStatus: ret.filing.status, latestFiling: ret.filing.latest,
        monthTaxWithheld: ret.totals.taxWithheld, monthRemitted: ret.totals.remitted, monthOutstanding: ret.totals.outstanding, monthStatus: ret.status,
      },
      correction: correction ? {
        id: correction.id, reason: correction.reason, correctedOn: correction.correctedOn, correctionPeriod: correction.correctionPeriod,
        reversalJournalEntryId: correction.reversalJournalEntryId, reversalReturnPeriod: correction.reversalReturnPeriod,
        filedMonthTreatment: (correction.filedMonthTreatment ?? null) as WhtFiledMonthTreatment | null,
        originalFilingId: correction.originalFilingId ?? null, remittedAtCorrection: Number(correction.remittedAtCorrection),
        correctedBillPaymentId: correction.correctedBillPaymentId ?? null, correctedSupplierPaymentId: correction.correctedSupplierPaymentId ?? null,
        createdBy: correction.createdBy ?? null, createdAt: correction.createdAt.toISOString(),
      } : null,
      reentry,
      corrects,
    };
  },
};

/** One withholding as the return lists it (its own return month's read), or null. */
async function rowById(id: number) {
  const [row] = await taxRepository.withholdings({ id });
  if (!row) return null;
  const ret = await whtService.monthlyReturn(row.return_period);
  return [...ret.schedule, ...ret.excluded, ...ret.pending, ...ret.corrected].find((x) => x.id === id) ?? null;
}
