/**
 * WITHHOLDING TAX AT THE PAY PATHS — Phase 16 (2026-10-04).
 * Record: docs/product/phase-16-17-tax-treasury-decision-pack.md §2.
 *
 * Income Tax Law Art. 68: every RESIDENT payer — a Zakat-only company included
 * — withholds tax from an amount it PAYS to a NON-RESIDENT from a source in the
 * Kingdom, at the rate Implementing Regulations Art. 63(1) (MoF Resolution 25)
 * fixes for the payment's NATURE. This module is the ONE place that decides
 * and records it; the two existing supplier pay paths call it (`payBill`,
 * `supplierPaymentsService.create`). There is no third payment path.
 *
 *   decide   — before anything is written: whose payment, which nature, which
 *              rate, how much; refuses in words when it cannot know
 *   record   — after the pay path's entry exists: the `wht_withholdings` row
 *              the database admits only if it IS that payment (migration 0113)
 *
 * 🔴 The platform never guesses the nature: a person declares it on the
 * payment, or once on the supplier (`vendors.wht_default_payment_type`).
 * Neither → 422 `wht_classification_required`, never a default rate.
 *
 * 🔴 The tax is integer arithmetic in halalas — `round(base × rate)` with the
 * rate in basis points — so it equals the database's CHECK
 * `wht_amount = round(base_amount * rate, 2)` exactly, never "within a halala".
 */
import { and, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import {
  db, vendorsTable, whtRatesTable, vendorWhtTreatyReliefsTable, whtWithholdingsTable,
  WHT_PAYMENT_TYPES, type WhtPaymentType,
} from "@workspace/db";
import { BadRequestError, BusinessRuleError } from "../../lib/errors.js";
import { fromHalalas, toHalalas } from "../../lib/money.js";
import { companyScoped } from "../../repositories/companyScope.js";

export const WHT_NOT_SUBJECT_REASONS = ["goods", "not_kingdom_source"] as const;
export type WhtNotSubjectReason = (typeof WHT_NOT_SUBJECT_REASONS)[number];

/** What the caller stated about the payment's WHT, read from the request body. */
export interface WhtDeclaration {
  paymentType?: string | null;
  notSubjectReason?: string | null;
  notSubjectNote?: string | null;
}

/** Read the WHT fields of a pay request — the same names on every pay path. */
export function whtDeclarationFrom(body: Record<string, unknown> | null | undefined): WhtDeclaration {
  const s = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  return { paymentType: s(body?.whtPaymentType), notSubjectReason: s(body?.whtNotSubjectReason), notSubjectNote: s(body?.whtNotSubjectNote) };
}

export type WhtDecision =
  /** No supplier record: nobody's residency is known. Listed as an exception, never silently resident. */
  | { kind: "no_vendor" }
  | { kind: "resident"; vendorId: number }
  /** Residency `unknown`: nothing withheld; the payment is listed as a WHT exception (pack §2.3). */
  | { kind: "unknown_residency"; vendorId: number }
  | { kind: "not_subject"; vendorId: number; reason: WhtNotSubjectReason; note: string | null; baseH: number }
  | {
      kind: "withheld"; vendorId: number; paymentType: WhtPaymentType; baseH: number;
      rate: string; statutoryRate: string; rateId: number; treatyReliefId: number | null; whtH: number;
      legalReference: string; formRow: string;
    };

const refuse = (status: number, code: string, error: string, field?: string): never => {
  throw new BusinessRuleError(status, { code, error, ...(field ? { field } : {}) });
};

/** A rate stored as numeric(7,4) → integer basis points (0.0500 → 500). Exact: the column has four decimals. */
export function rateBasisPoints(rate: string | number): number {
  const bp = Math.round(Number(rate) * 10000);
  if (!Number.isSafeInteger(bp) || bp < 0 || bp >= 10000) throw new Error(`rate out of range: ${rate}`);
  return bp;
}

/** The tax on a base at a rate, in halalas: round half-up of base × rate (a positive base). */
export function whtHalalas(baseH: number, rate: string | number): number {
  return Math.round((baseH * rateBasisPoints(rate)) / 10000);
}

/** The `wht_rates` row in force for a nature on a date — the regulation's, never a literal. */
export async function rateInForce(paymentType: WhtPaymentType, onDate: string) {
  const [r] = await db.select().from(whtRatesTable)
    .where(and(
      eq(whtRatesTable.paymentType, paymentType),
      lte(whtRatesTable.effectiveFrom, onDate),
      or(isNull(whtRatesTable.effectiveTo), gte(whtRatesTable.effectiveTo, onDate)),
    ))
    .limit(1);
  return r ?? null;
}

/** An APPROVED treaty relief of THIS company covering the supplier, nature and date (pack §2.3). */
export async function reliefInForce(vendorId: number, paymentType: WhtPaymentType, onDate: string) {
  const [r] = await db.select().from(vendorWhtTreatyReliefsTable)
    .where(and(
      companyScoped(vendorWhtTreatyReliefsTable.companyId),
      eq(vendorWhtTreatyReliefsTable.vendorId, vendorId),
      eq(vendorWhtTreatyReliefsTable.paymentType, paymentType),
      eq(vendorWhtTreatyReliefsTable.status, "approved"),
      lte(vendorWhtTreatyReliefsTable.validFrom, onDate),
      gte(vendorWhtTreatyReliefsTable.validTo, onDate),
    ))
    .orderBy(desc(vendorWhtTreatyReliefsTable.validFrom), desc(vendorWhtTreatyReliefsTable.id))
    .limit(1);
  return r ?? null;
}

const isPaymentType = (v: string): v is WhtPaymentType => (WHT_PAYMENT_TYPES as readonly string[]).includes(v);

/**
 * Decide the WHT of ONE supplier payment, before anything is written.
 *
 * `base` is what the SUPPLIER is credited with — the "full amount paid to the
 * non-resident" of IR 63(1)/(8): the AP amount a bill payment settles, or the
 * whole of a supplier payment (allocated + on account). The cash that leaves
 * is `base − wht`.
 */
export async function decideWithholding(input: {
  vendorId: number | null | undefined;
  paymentDate: string;
  base: number;
  /** The document's currency, where it has one (a bill). */
  currency?: string | null;
  declared: WhtDeclaration;
}): Promise<WhtDecision> {
  const { declared } = input;
  if (input.vendorId == null) {
    if (declared.paymentType || declared.notSubjectReason) {
      refuse(422, "wht_vendor_required", "This payment names no supplier, so no withholding can be recorded against it. Link the bill to its supplier first.", "whtPaymentType");
    }
    return { kind: "no_vendor" };
  }
  const [vendor] = await db.select({ id: vendorsTable.id, residency: vendorsTable.residency, whtDefaultPaymentType: vendorsTable.whtDefaultPaymentType })
    .from(vendorsTable).where(eq(vendorsTable.id, input.vendorId)).limit(1);
  if (!vendor) refuse(422, "vendor_unknown", "Name the supplier this payment went to.", "vendorId");

  if (vendor!.residency !== "non_resident") {
    // A declaration on a payment to a resident (or an undeclared supplier) is a contradiction, refused in words —
    // never silently withheld at a rate the supplier's own record says does not apply.
    if (declared.paymentType || declared.notSubjectReason) {
      refuse(422, "wht_vendor_not_non_resident",
        vendor!.residency === "resident"
          ? "This supplier is declared RESIDENT: no withholding applies between residents (Income Tax Law Art. 68). Change the supplier's residency first if that is wrong."
          : "This supplier's residency is not declared. Declare it NON-RESIDENT on the supplier before withholding from a payment to it.",
        "whtPaymentType");
    }
    return vendor!.residency === "resident" ? { kind: "resident", vendorId: vendor!.id } : { kind: "unknown_residency", vendorId: vendor!.id };
  }

  // ── a NON-RESIDENT: the payment withholds, or says why it does not ────────
  if (input.currency && input.currency !== "SAR") {
    refuse(422, "wht_currency_unsupported", `This bill is in ${input.currency}. Withholding on a foreign-currency payment needs the SAMA rate of "the date of the transaction" (Income Tax Law Art. 30(B)), which this product does not yet record — open question W-11.`);
  }
  const baseH = toHalalas(input.base);
  if (!(baseH > 0)) throw new BadRequestError("A positive payment amount is required.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paymentDate)) throw new BadRequestError("The payment date is a YYYY-MM-DD date.");

  if (declared.notSubjectReason) {
    if (declared.paymentType) refuse(400, "wht_declaration_conflict", "Give EITHER the payment's nature OR the reason it is not subject to withholding — not both.", "whtNotSubjectReason");
    if (!(WHT_NOT_SUBJECT_REASONS as readonly string[]).includes(declared.notSubjectReason)) {
      refuse(400, "wht_not_subject_reason_unknown", `A payment to a non-resident is not subject only for a stated reason: ${WHT_NOT_SUBJECT_REASONS.join(", ")}.`, "whtNotSubjectReason");
    }
    const note = declared.notSubjectNote ?? null;
    if (declared.notSubjectReason === "not_kingdom_source" && (note ?? "").length < 10) {
      refuse(422, "wht_not_subject_note_required", "Say why the income has no source in the Kingdom (Income Tax Law Art. 5) — at least a sentence; the explanation is kept with the record for ten years (IR Art. 63(9)(c)).", "whtNotSubjectNote");
    }
    return { kind: "not_subject", vendorId: vendor!.id, reason: declared.notSubjectReason as WhtNotSubjectReason, note, baseH };
  }

  const stated = declared.paymentType ?? vendor!.whtDefaultPaymentType ?? null;
  if (!stated) {
    refuse(422, "wht_classification_required",
      "This supplier is NON-RESIDENT, so this payment is subject to withholding tax (Income Tax Law Art. 68). State the payment's nature (rent, technical or consulting services, royalty, management fees, …) or the reason it is not subject — the rate depends on it, and it is never assumed.",
      "whtPaymentType");
  }
  if (!isPaymentType(stated!)) refuse(400, "wht_payment_type_unknown", `"${stated}" is not a payment nature of Implementing Regulations Art. 63(1).`, "whtPaymentType");
  const paymentType = stated as WhtPaymentType;

  const rate = await rateInForce(paymentType, input.paymentDate);
  if (!rate) {
    refuse(422, "wht_rate_not_loaded", `No withholding rate for ${paymentType} is loaded for ${input.paymentDate}: the rates in force from 12-09-2023 (MoF Resolution 25) are; an earlier payment's schedule is not modelled.`, "paidAt");
  }
  const relief = await reliefInForce(vendor!.id, paymentType, input.paymentDate);
  const applied = relief ? relief.reducedRate : rate!.rate;
  return {
    kind: "withheld", vendorId: vendor!.id, paymentType, baseH,
    rate: applied, statutoryRate: rate!.rate, rateId: rate!.id, treatyReliefId: relief?.id ?? null,
    whtH: whtHalalas(baseH, applied),
    legalReference: relief ? `Treaty relief (ZATCA approval ${relief.zatcaApprovalReference})` : rate!.legalReference,
    formRow: rate!.formRow,
  };
}

/** The WHT this decision withholds, in riyals (0 unless withheld). */
export const whtOf = (d: WhtDecision): number => (d.kind === "withheld" ? fromHalalas(d.whtH) : 0);

/** The GL line crediting WHT_PAYABLE, or none. */
export function whtLine(d: WhtDecision, description: string) {
  if (d.kind !== "withheld" || d.whtH === 0) return [];
  return [{ systemCode: "WHT_PAYABLE" as const, accountName: "Withholding tax payable", description, debitAmount: 0, creditAmount: fromHalalas(d.whtH) }];
}

/**
 * Record the decision against the payment the pay path just wrote. Only a
 * payment to a NON-RESIDENT leaves a row (withheld, or not subject with its
 * reason); the database admits it only if its supplier, date, base and entry
 * are that payment's own and its rate is the one in force (migration 0113).
 */
export async function recordWithholding(
  d: WhtDecision,
  source: { kind: "bill_payment"; billPaymentId: number; billId: number } | { kind: "supplier_payment"; supplierPaymentId: number },
  paymentDate: string,
  journalEntryId: number,
  userId: number | null,
) {
  if (d.kind !== "withheld" && d.kind !== "not_subject") return null;
  const [row] = await db.insert(whtWithholdingsTable).values({
    sourceKind: source.kind,
    billPaymentId: source.kind === "bill_payment" ? source.billPaymentId : null,
    supplierPaymentId: source.kind === "supplier_payment" ? source.supplierPaymentId : null,
    billId: source.kind === "bill_payment" ? source.billId : null,
    vendorId: d.vendorId,
    paymentDate,
    period: paymentDate.slice(0, 7),
    status: d.kind,
    paymentType: d.kind === "withheld" ? d.paymentType : null,
    notSubjectReason: d.kind === "not_subject" ? d.reason : null,
    notSubjectNote: d.kind === "not_subject" ? d.note : null,
    baseAmount: fromHalalas(d.baseH).toFixed(2),
    rate: d.kind === "withheld" ? d.rate : "0",
    statutoryRate: d.kind === "withheld" ? d.statutoryRate : null,
    rateId: d.kind === "withheld" ? d.rateId : null,
    treatyReliefId: d.kind === "withheld" ? d.treatyReliefId : null,
    whtAmount: d.kind === "withheld" ? fromHalalas(d.whtH).toFixed(2) : "0.00",
    journalEntryId,
    createdBy: userId,
  }).returning();
  return row!;
}

/** Whether a supplier payment had tax withheld from it (its on-account money is then not refundable here — W-12). */
export async function supplierPaymentWasWithheld(supplierPaymentId: number): Promise<boolean> {
  const { rows } = await db.execute<{ x: boolean }>(sql`SELECT EXISTS (SELECT 1 FROM wht_withholdings
    WHERE supplier_payment_id = ${supplierPaymentId} AND status = 'withheld' AND wht_amount > 0) AS x`);
  return rows[0]?.x === true;
}
