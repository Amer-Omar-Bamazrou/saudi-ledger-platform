/**
 * WITHHOLDING TAX — the workspace, the returns, the remittance (Phase 16A;
 * docs/product/phase-16-17-tax-treasury-decision-pack.md §2).
 *
 * Every figure here is read from the WHT ledger the pay paths write
 * (`wht_withholdings`, via `accounting/wht.ts`) and from the GL — never typed.
 * Invariant W1 is SHOWN, not assumed: GL WHT_PAYABLE beside opening + Σ
 * withheld − Σ remitted, exact.
 *
 * Dates are the regulation's: a month's tax is due by the 10th of the
 * following month (IR Art. 63(9)(a)); the annual information within 120 days
 * of the fiscal year-end (63(9)(b)); a delay costs 1 % of the unpaid tax for
 * each 30 days (Income Tax Law Art. 77(A); IR Art. 68(2) — no fine under 30
 * days) — an ESTIMATE on the page, never posted.
 */
import { businessToday } from "@workspace/shared";
import { WHT_PAYMENT_TYPES } from "@workspace/db";
import { BadRequestError, BusinessRuleError, ConflictError, NotFoundError } from "../../lib/errors";
import { fromHalalas, round2, toHalalas } from "../../lib/money";
import { fiscalYearContaining, isFiscalCalendar, resolveFiscalYear } from "../../lib/fiscalYear";
import { taxRepository, type WithholdingRow } from "../../repositories/tax.repository";
import { companiesRepository } from "../../repositories/companies.repository";
import { journalEntriesRepository } from "../../repositories/journalEntries.repository";
import { vendorsRepository } from "../../repositories/vendors.repository";
import { postJournalEntry } from "../accounting/glPosting";
import { assertBankAccount } from "../accounting/bankIdentity";
import { decideWithholding, whtDeclarationFrom } from "../accounting/wht";
import { auditService } from "../audit.service";
import { addDays } from "./taxComputations.service";

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_ID = 2_147_483_647;
const refuse = (status: number, code: string, error: string, field?: string): never => {
  throw new BusinessRuleError(status, { code, error, ...(field ? { field } : {}) });
};

/** The 10th of the month after the WHT month (IR Art. 63(9)(a): "within the first 10 days"). */
export function whtDueDate(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 10)).toISOString().slice(0, 10);
}

/** Whole days between two plain dates (b − a). */
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * The statutory delay-fine ESTIMATE on what is still unpaid: 1 % per FULL 30
 * days after the due date; nothing under 30 days (Art. 77(A); IR Art. 68(2)).
 */
export function delayFineEstimate(unpaid: number, dueDate: string, asOf: string): { blocks: number; daysLate: number; amount: number } {
  const daysLate = Math.max(0, daysBetween(dueDate, asOf));
  const blocks = Math.floor(daysLate / 30);
  const amountH = unpaid > 0 && blocks > 0 ? Math.round((toHalalas(unpaid) * blocks) / 100) : 0;
  return { blocks, daysLate, amount: fromHalalas(amountH) };
}

type PeriodStatus = "nil" | "open" | "due" | "overdue" | "remitted";
function statusOf(period: string, withheld: number, outstanding: number, today: string): PeriodStatus {
  if (withheld === 0 && outstanding === 0) return "nil";
  if (outstanding <= 0) return "remitted";
  if (today.slice(0, 7) <= period) return "open";
  return today <= whtDueDate(period) ? "due" : "overdue";
}

const rowOut = (w: WithholdingRow) => ({
  id: w.id, sourceKind: w.source_kind as "bill_payment" | "supplier_payment",
  billPaymentId: w.bill_payment_id, supplierPaymentId: w.supplier_payment_id,
  vendorId: w.vendor_id, vendorName: w.vendor_name, vendorNameAr: w.vendor_name_ar,
  vendorCountry: w.vendor_country, vendorAddress: [w.vendor_address, w.vendor_city].filter(Boolean).join(", ") || null,
  vendorForeignTaxId: w.vendor_foreign_tax_id,
  billId: w.bill_id, document: w.bill_number ?? w.supplier_payment_reference ?? (w.supplier_payment_id != null ? `SPAY-${w.supplier_payment_id}` : null),
  paymentDate: w.payment_date, period: w.period, status: w.status as "withheld" | "not_subject",
  paymentType: w.payment_type, formRow: w.form_row, notSubjectReason: w.not_subject_reason, notSubjectNote: w.not_subject_note,
  baseAmount: Number(w.base_amount), rate: Number(w.rate), statutoryRate: w.statutory_rate == null ? null : Number(w.statutory_rate),
  treatyReliefId: w.treaty_relief_id, treatyApprovalReference: w.treaty_approval_reference,
  whtAmount: Number(w.wht_amount), cashPaid: round2(Number(w.base_amount) - Number(w.wht_amount)), journalEntryId: w.journal_entry_id,
});

function remittanceOut(r: Awaited<ReturnType<typeof taxRepository.remittances>>[number]) {
  return {
    id: r.id, period: r.period, amount: Number(r.amount), fineAmount: Number(r.fine_amount), paidAt: r.paid_at,
    bankAccountId: r.bank_account_id, bankName: r.bank_name, reference: r.reference, notes: r.notes, journalEntryId: r.journal_entry_id,
    createdAt: r.created_at,
    reversal: r.reversal_id == null ? null : { id: r.reversal_id, reason: r.reversal_reason!, reversedOn: r.reversed_on!, journalEntryId: r.reversal_entry_id! },
  };
}

export const whtService = {
  /** The regulation's table, as loaded (effective-dated). */
  async rates() {
    return (await taxRepository.rates()).map((r) => ({
      id: r.id, paymentType: r.paymentType, rate: Number(r.rate), effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo ?? null,
      formRow: r.formRow, nameEn: r.nameEn, nameAr: r.nameAr, legalReference: r.legalReference,
    }));
  },

  /** What a payment of `amount` to this supplier, on this date, would withhold — the same decision the pay path takes. */
  async preview(q: Record<string, unknown>) {
    const vendorId = Number(q.vendorId);
    if (!Number.isSafeInteger(vendorId) || vendorId <= 0 || vendorId > MAX_ID) throw new BadRequestError("vendorId must be a positive integer.");
    const amount = Number(q.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestError("amount must be a positive amount.");
    const date = typeof q.date === "string" && q.date ? q.date : businessToday();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestError("date must be YYYY-MM-DD.");
    const d = await decideWithholding({ vendorId, paymentDate: date, base: amount, declared: whtDeclarationFrom(q as Record<string, unknown>) });
    const withheld = d.kind === "withheld" ? fromHalalas(d.whtH) : 0;
    return {
      kind: d.kind, amount, date,
      paymentType: d.kind === "withheld" ? d.paymentType : null,
      rate: d.kind === "withheld" ? Number(d.rate) : null,
      statutoryRate: d.kind === "withheld" ? Number(d.statutoryRate) : null,
      treatyReliefId: d.kind === "withheld" ? d.treatyReliefId : null,
      legalReference: d.kind === "withheld" ? d.legalReference : null,
      formRow: d.kind === "withheld" ? d.formRow : null,
      withheld, cashPaid: round2(amount - withheld),
      notSubjectReason: d.kind === "not_subject" ? d.reason : null,
    };
  },

  /**
   * The workspace: every WHT month with its status and due date, the opening
   * balance, invariant W1 (GL vs the WHT ledger, exact), and the exception counts.
   */
  async overview() {
    const today = businessToday();
    const [periods, opening, openingUnremitted, gl, undeclared, missed, noVendor, reliefs] = await Promise.all([
      taxRepository.periods(), taxRepository.openingBalance(), taxRepository.unremitted(null), taxRepository.glPayable(),
      taxRepository.exceptions("undeclared"), taxRepository.exceptions("possibly_missed"), taxRepository.paymentsWithoutVendor(),
      taxRepository.reliefs(),
    ]);
    const months = periods.map((p) => {
      const withheld = Number(p.withheld), remitted = Number(p.remitted);
      const outstanding = round2(withheld - remitted);
      const due = whtDueDate(p.period);
      const status = statusOf(p.period, withheld, outstanding, today);
      return {
        period: p.period, dueDate: due, status, base: Number(p.base), withheld, remitted, outstanding,
        payments: p.payments, notSubject: p.not_subject, finesPaid: Number(p.fines_paid), lastPaidAt: p.last_paid_at,
        delayFineEstimate: status === "overdue" ? delayFineEstimate(outstanding, due, today) : null,
      };
    });
    const withheldTotalH = months.reduce((s, m) => s + toHalalas(m.withheld), 0);
    const remittedTotalH = months.reduce((s, m) => s + toHalalas(m.remitted), 0);
    // opening remitted = opening − what of it is still unremitted
    const openingRemittedH = toHalalas(opening) - toHalalas(openingUnremitted);
    const expectedH = toHalalas(opening) - openingRemittedH + withheldTotalH - remittedTotalH;
    return {
      asOf: today,
      months,
      opening: { balance: opening, unremitted: openingUnremitted },
      reconciliation: {
        // W1 — exact, never "within a halala"
        glWhtPayable: gl,
        whtLedger: fromHalalas(expectedH),
        reconciles: toHalalas(gl) === expectedH,
      },
      exceptions: {
        undeclaredResidency: undeclared[0]?.total ?? 0,
        possiblyMissed: missed[0]?.total ?? 0,
        paymentsWithoutSupplier: noVendor,
        reliefsExpiringIn30Days: reliefs.filter((r) => r.status === "approved" && r.validTo >= today && r.validTo <= addDays(today, 30)).length,
      },
    };
  },

  /** The monthly return (Form 06): rows by form line, the per-beneficiary schedule, the excluded payments, remittances, status. */
  async monthlyReturn(period: string) {
    if (!PERIOD.test(period)) throw new BadRequestError("period must be YYYY-MM.");
    const today = businessToday();
    const [rows, remittances, rates] = await Promise.all([taxRepository.withholdings({ period }), taxRepository.remittances(period), taxRepository.rates()]);
    const withheld = rows.filter((r) => r.status === "withheld");
    const excluded = rows.filter((r) => r.status === "not_subject");
    // Form rows in the regulation's order; rows 07/08 have no separate band after Res. 25 (W-4) and carry nothing
    const lineTypes = WHT_PAYMENT_TYPES.map((t) => ({ t, row: rates.find((r) => r.paymentType === t)?.formRow ?? "", nameEn: rates.find((r) => r.paymentType === t)?.nameEn ?? t, nameAr: rates.find((r) => r.paymentType === t)?.nameAr ?? t }))
      .sort((a, b) => a.row.localeCompare(b.row));
    const lines = lineTypes.map((l) => {
      const mine = withheld.filter((w) => w.payment_type === l.t);
      return {
        formRow: l.row, paymentType: l.t, nameEn: l.nameEn, nameAr: l.nameAr, applicable: mine.length > 0,
        paymentTotal: fromHalalas(mine.reduce((s, w) => s + toHalalas(w.base_amount), 0)),
        taxWithheld: fromHalalas(mine.reduce((s, w) => s + toHalalas(w.wht_amount), 0)),
      };
    });
    const totalBaseH = withheld.reduce((s, w) => s + toHalalas(w.base_amount), 0);
    const totalWhtH = withheld.reduce((s, w) => s + toHalalas(w.wht_amount), 0);
    const remitted = remittances.filter((r) => r.reversal_id == null);
    const remittedH = remitted.reduce((s, r) => s + toHalalas(r.amount), 0);
    const outstanding = fromHalalas(totalWhtH - remittedH);
    const due = whtDueDate(period);
    const status = statusOf(period, fromHalalas(totalWhtH), outstanding, today);
    return {
      period, dueDate: due, status, asOf: today,
      lines,
      totals: { paymentTotal: fromHalalas(totalBaseH), taxWithheld: fromHalalas(totalWhtH), remitted: fromHalalas(remittedH), outstanding },
      delayFineEstimate: status === "overdue" ? delayFineEstimate(outstanding, due, today) : null,
      schedule: withheld.map(rowOut),
      excluded: excluded.map(rowOut),
      remittances: remittances.map(remittanceOut),
      unusedFormRows: ["07", "08"],
    };
  },

  /** The annual withholding information (IR Art. 63(9)(b)): per beneficiary and nature, for a fiscal year; due 120 days after it ends. */
  async annual(fiscalYearLabel?: unknown) {
    const company = await companiesRepository.findCurrent();
    if (!company) throw new NotFoundError("No company is configured for this organization.");
    if (company.fiscalYearStart == null) refuse(422, "fiscal_year_undeclared", "Declare the company's fiscal year in Company Settings: the annual information is per fiscal year.");
    const calendar = isFiscalCalendar(company.fiscalCalendar) ? company.fiscalCalendar : "gregorian";
    const label = fiscalYearLabel == null || fiscalYearLabel === "" ? null : Number(fiscalYearLabel);
    if (label != null && !Number.isInteger(label)) throw new BadRequestError("fiscal_year must be a year number.");
    const settings = { fiscalYearStart: company.fiscalYearStart!, calendar } as const;
    const fy = label != null ? resolveFiscalYear(settings, label) : fiscalYearContaining(settings, businessToday());
    const rows = (await taxRepository.withholdings({ from: fy.startDate, to: fy.endDate })).filter((r) => r.status === "withheld");
    const byKey = new Map<string, { vendorId: number; vendorName: string; vendorNameAr: string | null; country: string | null; address: string | null; foreignTaxId: string | null; paymentType: string; base: number; wht: number; payments: number }>();
    for (const r of rows) {
      const k = `${r.vendor_id}:${r.payment_type}`;
      const o = byKey.get(k) ?? { vendorId: r.vendor_id, vendorName: r.vendor_name, vendorNameAr: r.vendor_name_ar, country: r.vendor_country, address: [r.vendor_address, r.vendor_city].filter(Boolean).join(", ") || null, foreignTaxId: r.vendor_foreign_tax_id, paymentType: r.payment_type!, base: 0, wht: 0, payments: 0 };
      o.base = fromHalalas(toHalalas(o.base) + toHalalas(r.base_amount));
      o.wht = fromHalalas(toHalalas(o.wht) + toHalalas(r.wht_amount));
      o.payments += 1;
      byKey.set(k, o);
    }
    const beneficiaries = [...byKey.values()].sort((a, b) => a.vendorName.localeCompare(b.vendorName) || a.paymentType.localeCompare(b.paymentType));
    return {
      fiscalYear: { label: fy.label, startDate: fy.startDate, endDate: fy.endDate, calendar: fy.calendar },
      dueDate: addDays(fy.endDate, 120),
      beneficiaries,
      totals: {
        base: fromHalalas(beneficiaries.reduce((s, b) => s + toHalalas(b.base), 0)),
        wht: fromHalalas(beneficiaries.reduce((s, b) => s + toHalalas(b.wht), 0)),
        payments: beneficiaries.reduce((s, b) => s + b.payments, 0),
      },
    };
  },

  /** A beneficiary's statement (Art. 68(B)(2)): what was paid to it and withheld, by month. */
  async beneficiaryStatement(vendorId: number, period?: string) {
    if (!Number.isSafeInteger(vendorId) || vendorId <= 0 || vendorId > MAX_ID) throw new NotFoundError("Supplier not found.");
    if (period != null && period !== "" && !PERIOD.test(period)) throw new BadRequestError("period must be YYYY-MM.");
    const [vendor] = await vendorsRepository.findById(vendorId);
    if (!vendor) throw new NotFoundError("Supplier not found.");
    const rows = (await taxRepository.withholdings({ vendorId, period: period || undefined })).filter((r) => r.status === "withheld");
    return {
      vendor: { id: vendor.id, name: vendor.name, nameAr: vendor.nameAr ?? null, country: vendor.country ?? null, foreignTaxId: vendor.foreignTaxId ?? null, residency: vendor.residency },
      period: period || null,
      payments: rows.map(rowOut),
      totals: {
        base: fromHalalas(rows.reduce((s, r) => s + toHalalas(r.base_amount), 0)),
        wht: fromHalalas(rows.reduce((s, r) => s + toHalalas(r.wht_amount), 0)),
      },
    };
  },

  async exceptions(kind: unknown) {
    if (kind !== "undeclared" && kind !== "possibly_missed") throw new BadRequestError("kind must be undeclared or possibly_missed.");
    const rows = await taxRepository.exceptions(kind);
    return {
      kind, total: rows[0]?.total ?? 0, shown: rows.length,
      items: rows.map((r) => ({ sourceKind: r.source_kind, paymentId: r.payment_id, vendorId: r.vendor_id, vendorName: r.vendor_name, document: r.document, paidAt: r.paid_at, amount: Number(r.amount), journalEntryId: r.journal_entry_id })),
    };
  },

  // ── remittance ───────────────────────────────────────────────────────────
  /** Pay ZATCA a month's WHT (or, with `opening`, the migrated opening balance). Dr WHT_PAYABLE (+ Dr TAX_PENALTIES) / Cr bank. */
  async remit(periodParam: string, body: Record<string, unknown>, userId: number | null) {
    const period = periodParam === "opening" ? null : periodParam;
    if (period != null && !PERIOD.test(period)) throw new BadRequestError("period must be YYYY-MM, or opening.");
    const idempotencyKey = typeof body.idempotencyKey === "string" && body.idempotencyKey.trim() ? body.idempotencyKey.trim() : null;
    if (idempotencyKey) {
      const prior = await taxRepository.remittanceByIdempotencyKey(idempotencyKey);
      if (prior) return { remittance: remittanceOut((await taxRepository.remittances(prior.period)).find((r) => r.id === prior.id)!), replayed: true };
    }
    const unremitted = await taxRepository.unremitted(period);
    if (unremitted <= 0) refuse(409, "wht_nothing_to_remit", period ? `Nothing is owed for ${period}: its withheld tax is fully remitted (or nothing was withheld).` : "No migrated opening WHT balance is unremitted.");
    const amount = body.amount == null || body.amount === "" ? unremitted : round2(Number(body.amount));
    if (!Number.isFinite(amount) || amount <= 0) refuse(400, "amount_invalid", "A remittance pays a positive amount.", "amount");
    if (toHalalas(amount) > toHalalas(unremitted)) refuse(409, "wht_remittance_exceeds", `${period ?? "The opening balance"} still owes ${unremitted.toFixed(2)}; ${amount.toFixed(2)} was asked for. Withheld tax cannot be paid in advance of being withheld.`, "amount");
    const fine = body.fineAmount == null || body.fineAmount === "" ? 0 : round2(Number(body.fineAmount));
    if (!Number.isFinite(fine) || fine < 0) refuse(400, "fine_invalid", "A delay fine actually paid is a non-negative amount.", "fineAmount");
    const paidAt = typeof body.paidAt === "string" && body.paidAt ? body.paidAt : businessToday();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidAt)) refuse(400, "date_invalid", "paidAt is a YYYY-MM-DD date.", "paidAt");
    if (paidAt > businessToday()) refuse(422, "date_in_future", "A remittance records money already paid: it is never dated in the future.", "paidAt");
    if (period && paidAt.slice(0, 7) < period) refuse(422, "wht_paid_before_period", `${period}'s tax cannot be paid before ${period} begins.`, "paidAt");
    const bankAccountId = await assertBankAccount(body.bankAccountId, { what: "the remittance was paid from" });
    const reference = typeof body.reference === "string" && body.reference.trim() ? body.reference.trim() : null;
    const notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null;
    const label = period ?? "OPENING";
    const entry = await postJournalEntry({
      entryNumber: `WHTREM-${label}-${Date.now()}`,
      date: paidAt,
      description: `Withholding tax remitted to ZATCA for ${period ?? "the opening balance"}`,
      reference: reference ?? undefined,
      lines: [
        { systemCode: "WHT_PAYABLE", accountName: "Withholding tax payable", description: `WHT ${label}`, debitAmount: amount, creditAmount: 0 },
        ...(fine > 0 ? [{ systemCode: "TAX_PENALTIES" as const, accountName: "Tax fines and penalties", description: `WHT delay fine ${label}`, debitAmount: fine, creditAmount: 0 }] : []),
        { bankAccountId, description: `WHT remittance ${label}`, debitAmount: 0, creditAmount: round2(amount + fine) },
      ],
    });
    const [row] = await taxRepository.insertRemittance({ period, amount: amount.toFixed(2), fineAmount: fine.toFixed(2), paidAt, bankAccountId, reference, notes, journalEntryId: entry.id, idempotencyKey, createdBy: userId });
    await auditService.created("wht_remittance", row!.id, row);
    return { remittance: remittanceOut((await taxRepository.remittances(period)).find((r) => r.id === row!.id)!), replayed: false };
  },

  /** Undo a remittance (a bank error, a duplicate): a mirror entry, with its reason. Refused while a statement line is reconciled to it. */
  async reverseRemittance(id: number, body: { reason?: unknown; date?: unknown }, userId: number | null) {
    if (!Number.isSafeInteger(id) || id <= 0 || id > MAX_ID) throw new NotFoundError("Remittance not found.");
    // No row lock: the remittance table is append-only (no UPDATE grant, so no FOR UPDATE). Two
    // concurrent reversals cannot both land — the entry number WHTREMREV-<id> and the reversal's
    // remittance_id are each unique — and the loser's unique violation is answered below, by name.
    const r = await taxRepository.remittanceById(id);
    if (!r) throw new NotFoundError("Remittance not found.");
    if (await taxRepository.reversalOf(id)) refuse(409, "wht_remittance_already_reversed", "This remittance is already reversed; its reversal is the record.");
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length < 3) refuse(422, "reason_required", "Say why this remittance is being reversed — the record keeps both.", "reason");
    const date = typeof body.date === "string" && body.date ? body.date : businessToday();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) refuse(400, "date_invalid", "date is a YYYY-MM-DD date.", "date");
    if (date < r.paidAt) refuse(422, "date_before_remittance", `The remittance was paid on ${r.paidAt}; it cannot be reversed before it happened.`, "date");
    if (await journalEntriesRepository.reconciledToStatement(r.journalEntryId)) {
      refuse(409, "wht_remittance_reconciled", "A bank statement line is reconciled to this remittance. Undo that reconciliation first.");
    }
    const amount = Number(r.amount), fine = Number(r.fineAmount);
    const label = r.period ?? "OPENING";
    let row;
    try {
      const entry = await postJournalEntry({
        entryNumber: `WHTREMREV-${r.id}`,
        date,
        description: `Reversal of the WHT remittance for ${r.period ?? "the opening balance"}: ${reason}`,
        lines: [
          { bankAccountId: r.bankAccountId, description: `WHT remittance ${label} reversed`, debitAmount: round2(amount + fine), creditAmount: 0 },
          { systemCode: "WHT_PAYABLE", accountName: "Withholding tax payable", description: `WHT ${label} reversed`, debitAmount: 0, creditAmount: amount },
          ...(fine > 0 ? [{ systemCode: "TAX_PENALTIES" as const, accountName: "Tax fines and penalties", description: `WHT delay fine ${label} reversed`, debitAmount: 0, creditAmount: fine }] : []),
        ],
      });
      [row] = await taxRepository.insertRemittanceReversal({ remittanceId: id, reason, reversedOn: date, journalEntryId: entry.id, createdBy: userId });
    } catch (e) {
      const code = (e as { code?: string; cause?: { code?: string } }).code ?? (e as { cause?: { code?: string } }).cause?.code;
      if (code === "23505") refuse(409, "wht_remittance_already_reversed", "This remittance was reversed by another request a moment ago; its reversal is the record.");
      throw e;
    }
    await auditService.record({ action: "reverse", entityType: "wht_remittance", entityId: id, before: r, after: row });
    return remittanceOut((await taxRepository.remittances(r.period)).find((x) => x.id === id)!);
  },

  // ── treaty reliefs (pack §2.3) ───────────────────────────────────────────
  async reliefs(vendorId?: unknown) {
    const v = vendorId == null || vendorId === "" ? undefined : Number(vendorId);
    if (v != null && (!Number.isSafeInteger(v) || v <= 0 || v > MAX_ID)) throw new BadRequestError("vendorId must be a positive integer.");
    return (await taxRepository.reliefs({ vendorId: v })).map(reliefOut);
  },
  async createRelief(body: Record<string, unknown>, userId: number | null) {
    const vendorId = Number(body.vendorId);
    if (!Number.isSafeInteger(vendorId) || vendorId <= 0 || vendorId > MAX_ID) throw new BadRequestError("vendorId must be a positive integer.");
    const [vendor] = await vendorsRepository.findById(vendorId);
    if (!vendor) refuse(422, "vendor_unknown", "Name the supplier the relief is for.", "vendorId");
    if (vendor!.residency !== "non_resident") refuse(422, "wht_relief_not_non_resident", "A treaty relieves only a payment to a NON-RESIDENT; declare the supplier non-resident first.", "vendorId");
    const paymentType = String(body.paymentType ?? "");
    if (!(WHT_PAYMENT_TYPES as readonly string[]).includes(paymentType)) throw new BadRequestError("paymentType must be a payment nature of IR Art. 63(1).");
    const reducedRate = Number(body.reducedRate);
    if (!Number.isFinite(reducedRate) || reducedRate < 0 || reducedRate >= 1 || Math.abs(reducedRate * 10000 - Math.round(reducedRate * 10000)) > 1e-6) {
      throw new BadRequestError("reducedRate is a fraction (0.0000 to 0.9999), e.g. 0 for an exemption or 0.05 for 5 %.");
    }
    const treatyCountry = String(body.treatyCountry ?? "").toUpperCase();
    if (!/^[A-Z]{2}$/.test(treatyCountry)) throw new BadRequestError("treatyCountry is an ISO 3166-1 alpha-2 code.");
    const zatcaApprovalReference = String(body.zatcaApprovalReference ?? "").trim();
    const residencyCertificateReference = String(body.residencyCertificateReference ?? "").trim();
    if (!zatcaApprovalReference) refuse(422, "wht_relief_approval_required", "Relief at source needs ZATCA's approval of the treaty request (ZATCA DTA circular §4.1); record its reference.", "zatcaApprovalReference");
    if (!residencyCertificateReference) refuse(422, "wht_relief_certificate_required", "Record the beneficiary's tax residency certificate reference.", "residencyCertificateReference");
    const validFrom = String(body.validFrom ?? ""), validTo = String(body.validTo ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(validFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(validTo) || validFrom > validTo) throw new BadRequestError("validFrom and validTo are YYYY-MM-DD dates, in order.");
    const [row] = await taxRepository.insertRelief({
      vendorId, paymentType, reducedRate: reducedRate.toFixed(4), treatyCountry, zatcaApprovalReference, residencyCertificateReference,
      validFrom, validTo, notes: typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null, createdBy: userId,
    });
    await auditService.created("wht_treaty_relief", row!.id, row);
    return reliefById(row!.id);
  },
  async approveRelief(id: number, userId: number | null) {
    const before = await taxRepository.reliefById(id, { lock: true });
    if (!before) throw new NotFoundError("Treaty relief not found.");
    if (before.status !== "pending") throw new ConflictError(`This relief is ${before.status}.`);
    const [after] = await taxRepository.updateRelief(id, { status: "approved", approvedBy: userId, approvedAt: new Date() });
    await auditService.record({ action: "approve", entityType: "wht_treaty_relief", entityId: id, before, after });
    return reliefById(id);
  },
  async revokeRelief(id: number, body: { reason?: unknown }, userId: number | null) {
    const before = await taxRepository.reliefById(id, { lock: true });
    if (!before) throw new NotFoundError("Treaty relief not found.");
    if (before.status === "revoked") throw new ConflictError("This relief is already revoked.");
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length < 3) refuse(422, "reason_required", "Say why the relief is revoked.", "reason");
    const [after] = await taxRepository.updateRelief(id, { status: "revoked", revokedBy: userId, revokedAt: new Date(), revokeReason: reason });
    await auditService.record({ action: "revoke", entityType: "wht_treaty_relief", entityId: id, before, after });
    return reliefById(id);
  },
  async removeRelief(id: number) {
    const before = await taxRepository.reliefById(id, { lock: true });
    if (!before) throw new NotFoundError("Treaty relief not found.");
    if (before.status !== "pending") throw new ConflictError("Only a pending relief is deleted; an approved one is revoked, and stays on record.");
    await taxRepository.deleteRelief(id);
    await auditService.deleted("wht_treaty_relief", id, before);
  },
};

/** One relief as the list shows it — with its supplier named. */
async function reliefById(id: number) {
  const [r] = await taxRepository.reliefs({ id });
  if (!r) throw new NotFoundError("Treaty relief not found.");
  return reliefOut(r);
}

function reliefOut(r: Awaited<ReturnType<typeof taxRepository.reliefs>>[number]) {
  return {
    id: r.id, vendorId: r.vendorId, vendorName: r.vendorName ?? "", vendorNameAr: r.vendorNameAr ?? null, paymentType: r.paymentType, reducedRate: Number(r.reducedRate), treatyCountry: r.treatyCountry,
    zatcaApprovalReference: r.zatcaApprovalReference, residencyCertificateReference: r.residencyCertificateReference,
    validFrom: r.validFrom, validTo: r.validTo, status: r.status as "pending" | "approved" | "revoked", notes: r.notes ?? null,
    createdBy: r.createdBy ?? null, createdAt: r.createdAt.toISOString(), approvedBy: r.approvedBy ?? null, approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
    revokedBy: r.revokedBy ?? null, revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null, revokeReason: r.revokeReason ?? null,
  };
}
