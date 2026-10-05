/**
 * WITHHOLDING TAX AT THE PAY PATHS — Phase 16 (2026-10-04); category-aware
 * since the accountant's Q2 (2026-10-05).
 * Record: docs/product/phase-16-17-tax-treasury-decision-pack.md §2, §14.2.
 *
 * Income Tax Law Art. 68: every RESIDENT payer — a Zakat-only company included
 * — withholds tax from an amount it PAYS to a NON-RESIDENT from a source in the
 * Kingdom, at the rate Implementing Regulations Art. 63(1) (MoF Resolution 25)
 * fixes for the payment's NATURE. This module is the ONE place that decides
 * and records it; the two existing supplier pay paths call it (`payBill`,
 * `supplierPaymentsService.create`), the preview and a plan's estimate call it.
 * There is no third payment path and no second engine.
 *
 *   decide   — before anything is written: whose payment, what the money was,
 *              which nature, which rate, how much; refuses in words when it
 *              cannot know
 *   record   — after the pay path's entry exists: the `wht_withholdings` row
 *              the database admits only if it IS that payment (0113) and its
 *              determination is one its class allows (0116)
 *
 * 🔴 THE DETERMINATION HAS FOUR DIMENSIONS, and none decides alone (Q2):
 *   1. the RECIPIENT — only a supplier declared non-resident is judged; a
 *      resident is not, and an undeclared one is listed, never assumed;
 *   2. the SOURCE — in the Kingdom unless a person declares otherwise with the
 *      reason (Art. 5; `not_kingdom_source`) — a presumption, stated as one;
 *   3. what the money WAS — consideration (a bill payment, an advance, a
 *      payment allocated to bills) is judged by its nature; a refundable
 *      deposit and an erroneous payment are NOT SUBJECT; money whose purpose
 *      nobody has identified is PENDING — nothing withheld, nothing claimed;
 *   4. the RATE — the regulation's for the declared nature on the payment
 *      date, or an approved treaty relief covering it.
 * "Non-resident = withhold" and "a taxable nature = withhold" are both
 * inexpressible: the class gate runs before the nature is read, and the
 * database refuses the same rows (migration 0116 `wht_withholding_class`).
 *
 * 🔴 The platform never guesses the nature: a person declares it on the
 * payment, or once on the supplier (`vendors.wht_default_payment_type`). The
 * supplier's default applies to CONSIDERATION only — never to a deposit, an
 * erroneous or an unidentified payment (that was D-12). Neither → 422
 * `wht_classification_required`, never a default rate.
 *
 * 🔴 The tax is integer arithmetic in halalas — `round(base × rate)` with the
 * rate in basis points — so it equals the database's CHECK
 * `wht_amount = round(base_amount * rate, 2)` exactly, never "within a halala".
 */
import { and, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import {
  db, vendorsTable, whtRatesTable, vendorWhtTreatyReliefsTable, whtWithholdingsTable, whtReturnFilingsTable,
  WHT_PAYMENT_TYPES, WHT_DECLARABLE_NOT_SUBJECT_REASONS,
  type WhtPaymentType, type WhtNotSubjectReason, type WhtPaymentClass, type WhtNatureBasis,
} from "@workspace/db";
import { BadRequestError, BusinessRuleError } from "../../lib/errors.js";
import { fromHalalas, toHalalas } from "../../lib/money.js";
import { companyScoped } from "../../repositories/companyScope.js";

export { WHT_NOT_SUBJECT_REASONS, type WhtNotSubjectReason } from "@workspace/db";

/** What the caller stated about the payment's WHT, read from the request body. */
export interface WhtDeclaration {
  paymentType?: string | null;
  notSubjectReason?: string | null;
  notSubjectNote?: string | null;
  /** Q1 (pack §14.1): only when the payment's month is recorded FILED — where its tax is reported. */
  filedMonthTreatment?: string | null;
}

/** Read the WHT fields of a pay request — the same names on every pay path. */
export function whtDeclarationFrom(body: Record<string, unknown> | null | undefined): WhtDeclaration {
  const s = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  return {
    paymentType: s(body?.whtPaymentType), notSubjectReason: s(body?.whtNotSubjectReason), notSubjectNote: s(body?.whtNotSubjectNote),
    filedMonthTreatment: s(body?.whtFiledMonthTreatment),
  };
}

export const WHT_FILED_MONTH_TREATMENTS = ["subsequent_period", "amendment"] as const;
export type WhtFiledMonthTreatment = (typeof WHT_FILED_MONTH_TREATMENTS)[number];

/** The latest filing recorded for a month of THIS company, or null — the "is it filed" fact every Q1 rule reads. */
export async function latestFilingOf(period: string) {
  const [f] = await db.select().from(whtReturnFilingsTable)
    .where(and(companyScoped(whtReturnFilingsTable.companyId), eq(whtReturnFilingsTable.period, period)))
    .orderBy(desc(whtReturnFilingsTable.id)).limit(1);
  return f ?? null;
}

/**
 * 🔴 Q1 (pack §14.1): WHICH MONTH'S RETURN carries a withholding. Its own
 * payment month — unless that month's Form 06 is recorded FILED and it
 * withholds tax: then the person states the treatment, and a filed return is
 * never changed silently.
 *   · `subsequent_period` (the accountant's recommendation) — reported in a
 *     later, unfiled month: the correction's month for a re-entry, otherwise
 *     the month of `today` (a late-entered payment);
 *   · `amendment` — reported in its own month, which then shows the filed
 *     return differs and is to be amended (ZATCA supports amendment).
 * Neither stated → 409 `wht_month_filed`, nothing written. The database
 * admits the same rule only (0117).
 */
export async function returnPeriodFor(
  d: WhtDecision, paymentDate: string, treatment: string | null | undefined,
  ctx: { today: string; correctionPeriod?: string | null },
): Promise<{ returnPeriod: string; filedMonthTreatment: WhtFiledMonthTreatment | null; monthFiled: boolean }> {
  const period = paymentDate.slice(0, 7);
  const filed = d.kind === "withheld" ? await latestFilingOf(period) : null;
  // not filed (or nothing withheld): its own month's return carries it — a stated treatment does not apply and is not stored
  if (!filed) return { returnPeriod: period, filedMonthTreatment: null, monthFiled: false };
  if (!treatment) {
    refuse(409, "wht_month_filed",
      `${period}'s withholding return (Form 06) is recorded as FILED on ${filed.filedOn} (${filed.zatcaReference}). A withholding dated in it would change a filed return, so say where it is reported: in a later, unfiled return (subsequent period — the accountant's recommendation), or by amending ${period}'s return (amendment).`,
      "whtFiledMonthTreatment");
  }
  if (!(WHT_FILED_MONTH_TREATMENTS as readonly string[]).includes(treatment!)) {
    refuse(400, "wht_filed_month_treatment_unknown", "The treatment of a filed month is subsequent_period or amendment.", "whtFiledMonthTreatment");
  }
  if (treatment === "amendment") return { returnPeriod: period, filedMonthTreatment: "amendment", monthFiled: true };
  const target = (ctx.correctionPeriod ?? ctx.today).slice(0, 7);
  if (target <= period) {
    refuse(422, "wht_subsequent_period_unavailable", `A subsequent-period report goes in a month after ${period}; ${target} is not later. Date the correction in a later month, or amend ${period}'s return instead.`, "whtFiledMonthTreatment");
  }
  const targetFiled = await latestFilingOf(target);
  if (targetFiled) {
    refuse(409, "wht_subsequent_period_unavailable", `${target}'s return is recorded as filed too; a subsequent-period report goes in a month whose return is not yet filed. Amend ${period}'s return instead, or record the correction in an unfiled month.`, "whtFiledMonthTreatment");
  }
  return { returnPeriod: target, filedMonthTreatment: "subsequent_period", monthFiled: true };
}

const ON_ACCOUNT_CLASSES = ["advance", "security_deposit", "erroneous", "unknown"] as const;
type OnAccountClass = (typeof ON_ACCOUNT_CLASSES)[number];

/**
 * 🔴 THE ONE DEFINITION of a supplier payment's class for WHT: wholly
 * allocated to bills → `allocated` (consideration); otherwise what its
 * on-account part was classified as. The database derives the same class from
 * the same two facts (0116 admit) — the create path and the preview call this.
 */
export function supplierPaymentClassOf(classification: string, amount: number, allocated: number): WhtPaymentClass {
  if (!(ON_ACCOUNT_CLASSES as readonly string[]).includes(classification)) {
    throw new BadRequestError("classification must be advance, security_deposit, erroneous or unknown.");
  }
  return toHalalas(amount) - toHalalas(allocated) <= 0 ? "allocated" : (classification as OnAccountClass);
}

/**
 * 🔴 One payment, one purpose — for a NON-RESIDENT. A payment that settles
 * bills (consideration) and leaves money on account as a deposit, an error or
 * unidentified would need its one base split between a withheld and a
 * not-subject part; it is refused instead, and recorded as two payments. The
 * create path and the preview both call this, so the dialog says what the
 * server will.
 */
export function assertSinglePurpose(p: { residency: string | null | undefined; classification: string; amount: number; allocated: number }) {
  const onAccountH = toHalalas(p.amount) - toHalalas(p.allocated);
  if (p.residency !== "non_resident" || p.allocated <= 0 || onAccountH <= 0 || p.classification === "advance") return;
  const what = p.classification === "security_deposit" ? "a refundable deposit" : p.classification === "erroneous" ? "an erroneous payment" : "money not yet identified";
  refuse(422, "wht_mixed_payment_unsupported",
    `This payment to a non-resident settles bills AND leaves ${fromHalalas(onAccountH).toFixed(2)} on account as ${what}. Withholding is judged on what the money was, so record the two as separate payments: the bills' payment, and the ${p.classification === "unknown" ? "unidentified money" : "deposit or erroneous payment"} on its own.`,
    "classification");
}

/** Consideration for a supply — the only money a nature (and so a rate) is ever read for. */
const isConsideration = (c: WhtPaymentClass) => c === "bill_payment" || c === "advance" || c === "allocated";

export type WhtDecision =
  /** No supplier record: nobody's residency is known. Listed as an exception, never silently resident. */
  | { kind: "no_vendor"; paymentClass: WhtPaymentClass }
  | { kind: "resident"; vendorId: number; paymentClass: WhtPaymentClass }
  /** Residency `unknown`: nothing withheld; the payment is listed as a WHT exception (pack §2.3). */
  | { kind: "unknown_residency"; vendorId: number; paymentClass: WhtPaymentClass }
  | {
      kind: "not_subject"; vendorId: number; reason: WhtNotSubjectReason; note: string | null; baseH: number;
      paymentClass: WhtPaymentClass; natureBasis: WhtNatureBasis;
      /** The nature, where one is known and the payment is not subject for another reason (not a source in the Kingdom). */
      paymentType: WhtPaymentType | null;
    }
  /** Q2: a non-resident's payment whose purpose is not identified — nothing withheld, nothing claimed, listed. */
  | { kind: "pending"; vendorId: number; baseH: number; paymentClass: "unknown"; natureBasis: "payment_class" }
  | {
      kind: "withheld"; vendorId: number; paymentType: WhtPaymentType; baseH: number;
      rate: string; statutoryRate: string; rateId: number; treatyReliefId: number | null; whtH: number;
      legalReference: string; formRow: string; paymentClass: WhtPaymentClass; natureBasis: WhtNatureBasis;
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
 *
 * `paymentClass` is what the money WAS (`supplierPaymentClassOf` for a
 * supplier payment; `bill_payment` for a bill's) — required, so no caller can
 * reach a nature without first saying whether the money was consideration.
 */
export async function decideWithholding(input: {
  vendorId: number | null | undefined;
  paymentDate: string;
  base: number;
  paymentClass: WhtPaymentClass;
  /** The document's currency, where it has one (a bill). */
  currency?: string | null;
  declared: WhtDeclaration;
}): Promise<WhtDecision> {
  const { declared, paymentClass } = input;
  const anyDeclaration = !!(declared.paymentType || declared.notSubjectReason);
  if (input.vendorId == null) {
    if (anyDeclaration) {
      refuse(422, "wht_vendor_required", "This payment names no supplier, so no withholding can be recorded against it. Link the bill to its supplier first.", "whtPaymentType");
    }
    return { kind: "no_vendor", paymentClass };
  }
  const [vendor] = await db.select({ id: vendorsTable.id, residency: vendorsTable.residency, whtDefaultPaymentType: vendorsTable.whtDefaultPaymentType })
    .from(vendorsTable).where(eq(vendorsTable.id, input.vendorId)).limit(1);
  if (!vendor) refuse(422, "vendor_unknown", "Name the supplier this payment went to.", "vendorId");

  // ── dimension 1: the recipient ─────────────────────────────────────────────
  if (vendor!.residency !== "non_resident") {
    // A declaration on a payment to a resident (or an undeclared supplier) is a contradiction, refused in words —
    // never silently withheld at a rate the supplier's own record says does not apply. A taxable NATURE does not
    // make a resident's payment subject: the nature is never read before the recipient (Q2).
    if (anyDeclaration) {
      refuse(422, "wht_vendor_not_non_resident",
        vendor!.residency === "resident"
          ? "This supplier is declared RESIDENT: no withholding applies between residents (Income Tax Law Art. 68). Change the supplier's residency first if that is wrong."
          : "This supplier's residency is not declared. Declare it NON-RESIDENT on the supplier before withholding from a payment to it.",
        "whtPaymentType");
    }
    return vendor!.residency === "resident" ? { kind: "resident", vendorId: vendor!.id, paymentClass } : { kind: "unknown_residency", vendorId: vendor!.id, paymentClass };
  }

  // ── a NON-RESIDENT: the payment is judged ─────────────────────────────────
  if (input.currency && input.currency !== "SAR") {
    refuse(422, "wht_currency_unsupported", `This bill is in ${input.currency}. Withholding on a foreign-currency payment needs the SAMA rate of "the date of the transaction" (Income Tax Law Art. 30(B)), which this product does not yet record — open question W-11.`);
  }
  const baseH = toHalalas(input.base);
  if (!(baseH > 0)) throw new BadRequestError("A positive payment amount is required.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paymentDate)) throw new BadRequestError("The payment date is a YYYY-MM-DD date.");

  // ── dimension 3: what the money WAS — before any nature is read (Q2) ──────
  if (paymentClass === "security_deposit" || paymentClass === "erroneous") {
    if (anyDeclaration) {
      refuse(422, "wht_declaration_conflict",
        paymentClass === "security_deposit"
          ? "A refundable security deposit is money the supplier holds and owes back, not a payment for a service or a supply: no nature applies to it and nothing is withheld (recorded not subject, with that reason). Leave the withholding fields empty."
          : "An erroneous payment is not consideration for anything: no nature applies to it and nothing is withheld (recorded not subject, with that reason). Leave the withholding fields empty.",
        "whtPaymentType");
    }
    return {
      kind: "not_subject", vendorId: vendor!.id, baseH, paymentClass, natureBasis: "payment_class", paymentType: null, note: null,
      reason: paymentClass === "security_deposit" ? "refundable_deposit" : "erroneous_payment",
    };
  }
  if (paymentClass === "unknown") {
    if (anyDeclaration) {
      refuse(422, "wht_unidentified_payment_declared",
        "This payment's purpose is not identified, so its withholding cannot be judged yet: it is recorded PENDING — nothing withheld, nothing claimed — and listed until it is classified. Classify it as an advance to declare its nature, or as a deposit or an erroneous payment.",
        "whtPaymentType");
    }
    return { kind: "pending", vendorId: vendor!.id, baseH, paymentClass: "unknown", natureBasis: "payment_class" };
  }
  if (!isConsideration(paymentClass)) throw new Error(`unhandled payment class ${paymentClass}`);

  // ── consideration: the source, then the nature, then the rate ────────────
  if (declared.notSubjectReason) {
    if (!(WHT_DECLARABLE_NOT_SUBJECT_REASONS as readonly string[]).includes(declared.notSubjectReason)) {
      refuse(400, "wht_not_subject_reason_unknown",
        `A payment for a supply is not subject only for a stated reason: ${WHT_DECLARABLE_NOT_SUBJECT_REASONS.join(", ")}. A refundable deposit or an erroneous payment is recorded as a supplier payment with that classification.`,
        "whtNotSubjectReason");
    }
    // goods IS the nature: a second nature contradicts it. Not a source in the Kingdom may carry the nature it has.
    if (declared.notSubjectReason === "goods" && declared.paymentType) {
      refuse(400, "wht_declaration_conflict", "Give EITHER the payment's nature OR the reason it is not subject to withholding — not both.", "whtNotSubjectReason");
    }
    if (declared.paymentType && !isPaymentType(declared.paymentType)) refuse(400, "wht_payment_type_unknown", `"${declared.paymentType}" is not a payment nature of Implementing Regulations Art. 63(1).`, "whtPaymentType");
    const note = declared.notSubjectNote ?? null;
    if (declared.notSubjectReason === "not_kingdom_source" && (note ?? "").length < 10) {
      refuse(422, "wht_not_subject_note_required", "Say why the income has no source in the Kingdom (Income Tax Law Art. 5) — at least a sentence; the explanation is kept with the record for ten years (IR Art. 63(9)(c)).", "whtNotSubjectNote");
    }
    return {
      kind: "not_subject", vendorId: vendor!.id, reason: declared.notSubjectReason as WhtNotSubjectReason, note, baseH,
      paymentClass, natureBasis: "declared", paymentType: (declared.paymentType as WhtPaymentType | null) ?? null,
    };
  }

  const natureBasis: WhtNatureBasis = declared.paymentType ? "declared" : "supplier_default";
  const stated = declared.paymentType ?? vendor!.whtDefaultPaymentType ?? null;
  if (!stated) {
    refuse(422, "wht_classification_required",
      "This supplier is NON-RESIDENT and this payment is for a supply, so it is judged by its nature (Income Tax Law Art. 68; IR Art. 63(1)). State the payment's nature (rent, technical or consulting services, royalty, management fees, …) or the reason it is not subject — the rate depends on it, and it is never assumed.",
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
    formRow: rate!.formRow, paymentClass, natureBasis,
  };
}

/** The WHT this decision withholds, in riyals (0 unless withheld). */
export const whtOf = (d: WhtDecision): number => (d.kind === "withheld" ? fromHalalas(d.whtH) : 0);

/** The GL line crediting WHT_PAYABLE, or none. */
export function whtLine(d: WhtDecision, description: string) {
  if (d.kind !== "withheld" || d.whtH === 0) return [];
  return [{ systemCode: "WHT_PAYABLE" as const, accountName: "Withholding tax payable", description, debitAmount: 0, creditAmount: fromHalalas(d.whtH) }];
}

// ── the determination, as words a person can check ────────────────────────────

export type WhtOutcome = "taxable_wht" | "exempt_relief" | "not_wht" | "pending_classification";

/**
 * 🔴 ONE description of a determination, for a decision (the preview) and for
 * a stored record (the return) alike — so the page explaining a posted payment
 * and the dialog explaining an unposted one cannot disagree. Every dimension
 * is named; nothing here decides anything.
 */
export function describeDetermination(d: {
  status: "withheld" | "not_subject" | "pending" | "resident" | "unknown_residency" | "no_vendor";
  treatyReliefId?: number | null;
  notSubjectReason?: string | null;
  paymentType?: string | null;
  paymentClass?: string | null;
  natureBasis?: string | null;
}) {
  const recipient = d.status === "resident" ? "resident" : d.status === "unknown_residency" ? "unknown" : d.status === "no_vendor" ? "no_supplier" : "non_resident";
  const judged = recipient === "non_resident" && d.status !== "pending" && (d.paymentClass == null || isConsideration(d.paymentClass as WhtPaymentClass));
  const outcome: WhtOutcome =
    d.status === "withheld" ? (d.treatyReliefId != null ? "exempt_relief" : "taxable_wht")
    : d.status === "pending" || d.status === "unknown_residency" || d.status === "no_vendor" ? "pending_classification"
    : "not_wht";
  const reasonCode =
    d.status === "withheld" ? (d.treatyReliefId != null ? "treaty_relief" : "statutory_rate")
    : d.status === "not_subject" ? (d.notSubjectReason ?? "not_subject")
    : d.status === "pending" ? "payment_unidentified"
    : d.status === "resident" ? "resident_recipient"
    : d.status === "unknown_residency" ? "residency_undeclared"
    : "no_supplier";
  return {
    outcome,
    reasonCode,
    recipient: recipient as "non_resident" | "resident" | "unknown" | "no_supplier",
    /** A source in the Kingdom is presumed for consideration unless declared otherwise (Art. 5) — never assessed for money that was not consideration. */
    kingdomSource: (d.notSubjectReason === "not_kingdom_source" ? "declared_not_kingdom_source" : judged ? "presumed" : "not_assessed") as
      "presumed" | "declared_not_kingdom_source" | "not_assessed",
    paymentClass: (d.paymentClass ?? null) as WhtPaymentClass | null,
    paymentType: d.paymentType ?? null,
    natureBasis: (d.natureBasis ?? null) as WhtNatureBasis | null,
  };
}

/** The description of a decision (the preview's). */
export function determinationOf(d: WhtDecision) {
  return describeDetermination({
    status: d.kind,
    treatyReliefId: d.kind === "withheld" ? d.treatyReliefId : null,
    notSubjectReason: d.kind === "not_subject" ? d.reason : null,
    paymentType: d.kind === "withheld" ? d.paymentType : d.kind === "not_subject" ? d.paymentType : null,
    paymentClass: d.paymentClass,
    natureBasis: d.kind === "withheld" || d.kind === "not_subject" || d.kind === "pending" ? d.natureBasis : null,
  });
}

/**
 * Record the decision against the payment the pay path just wrote. Only a
 * payment to a NON-RESIDENT leaves a row (withheld; not subject with its
 * reason; or pending); the database admits it only if its supplier, date, base
 * and entry are that payment's own, its rate is the one in force (0113) and its
 * determination is one its class allows (0116).
 */
export async function recordWithholding(
  d: WhtDecision,
  source: { kind: "bill_payment"; billPaymentId: number; billId: number } | { kind: "supplier_payment"; supplierPaymentId: number },
  paymentDate: string,
  journalEntryId: number,
  userId: number | null,
  opts: {
    supersedesWithholdingId?: number | null;
    /** Q1: the return month (`returnPeriodFor`); the payment month when absent. */
    returnPeriod?: string | null;
    filedMonthTreatment?: WhtFiledMonthTreatment | null;
    /** Q1: the correction this payment RE-ENTERS. */
    correctionId?: number | null;
  } = {},
) {
  if (d.kind !== "withheld" && d.kind !== "not_subject" && d.kind !== "pending") return null;
  const [row] = await db.insert(whtWithholdingsTable).values({
    sourceKind: source.kind,
    billPaymentId: source.kind === "bill_payment" ? source.billPaymentId : null,
    supplierPaymentId: source.kind === "supplier_payment" ? source.supplierPaymentId : null,
    billId: source.kind === "bill_payment" ? source.billId : null,
    vendorId: d.vendorId,
    paymentDate,
    period: paymentDate.slice(0, 7),
    status: d.kind,
    paymentType: d.kind === "withheld" ? d.paymentType : d.kind === "not_subject" ? d.paymentType : null,
    notSubjectReason: d.kind === "not_subject" ? d.reason : null,
    notSubjectNote: d.kind === "not_subject" ? d.note : null,
    baseAmount: fromHalalas(d.baseH).toFixed(2),
    rate: d.kind === "withheld" ? d.rate : "0",
    statutoryRate: d.kind === "withheld" ? d.statutoryRate : null,
    rateId: d.kind === "withheld" ? d.rateId : null,
    treatyReliefId: d.kind === "withheld" ? d.treatyReliefId : null,
    whtAmount: d.kind === "withheld" ? fromHalalas(d.whtH).toFixed(2) : "0.00",
    journalEntryId,
    paymentClass: d.paymentClass,
    natureBasis: d.natureBasis,
    supersedesWithholdingId: opts.supersedesWithholdingId ?? null,
    returnPeriod: opts.returnPeriod ?? paymentDate.slice(0, 7),
    filedMonthTreatment: opts.filedMonthTreatment ?? null,
    correctionId: opts.correctionId ?? null,
    createdBy: userId,
  }).returning();
  return row!;
}

/**
 * The LIVE determination of a supplier payment — the record no later one
 * supersedes (a reclassification adds a record; the replaced one stays).
 */
export async function liveWithholdingOfSupplierPayment(supplierPaymentId: number) {
  const { rows } = await db.execute<{ id: number; status: string; not_subject_reason: string | null; wht_amount: string; payment_class: string | null }>(sql`
    SELECT w.id, w.status, w.not_subject_reason, w.wht_amount::text, w.payment_class FROM wht_withholdings w
     WHERE w.supplier_payment_id = ${supplierPaymentId}
       AND NOT EXISTS (SELECT 1 FROM wht_withholdings s WHERE s.supersedes_withholding_id = w.id)
     ORDER BY w.id DESC LIMIT 1`);
  return rows[0] ?? null;
}

/** Whether a supplier payment had tax withheld from it (its on-account money is then not refundable here — W-12). */
export async function supplierPaymentWasWithheld(supplierPaymentId: number): Promise<boolean> {
  const { rows } = await db.execute<{ x: boolean }>(sql`SELECT EXISTS (SELECT 1 FROM wht_withholdings
    WHERE supplier_payment_id = ${supplierPaymentId} AND status = 'withheld' AND wht_amount > 0) AS x`);
  return rows[0]?.x === true;
}
