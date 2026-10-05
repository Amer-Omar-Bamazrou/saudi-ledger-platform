import { pgTable, serial, text, timestamp, integer, smallint, numeric, uuid, date, jsonb, index, uniqueIndex, check, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { categoriesTable } from "./categories";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";
import { vendorsTable } from "./vendors";
import { billsTable } from "./bills";
import { billPaymentsTable } from "./payments";
import { supplierPaymentsTable } from "./supplierPayments";
import { bankAccountsTable } from "./bankAccounts";
import { journalEntriesTable } from "./journalEntries";
import { WHT_PAYMENT_TYPES_SQL, WHT_NOT_SUBJECT_REASONS_SQL, WHT_PAYMENT_CLASSES_SQL, WHT_NATURE_BASES_SQL } from "./whtTypes";

/**
 * Phase 16 — Saudi tax expansion (docs/product/phase-16-17-tax-treasury-decision-pack.md).
 *
 *   wht_rates (global, effective-dated)        vendor_wht_treaty_reliefs
 *   wht_withholdings ── one per pay-path event  wht_remittances ──< wht_remittance_reversals
 *   zakat_account_classifications (org chart)
 *   tax_computations ──< tax_computation_versions ──< tax_adjustments
 *
 * 🔴 The lifecycle and the arithmetic are enforced AT THE DATABASE (migration
 * 0113): a withholding's tax IS round(base × rate, 2) by CHECK; every line on a
 * WHT_PAYABLE account is owned by a WHT record (deferred trigger); an approved
 * computation version and its adjustments are immutable. Actor columns are
 * plain ids (the 0110/0112 pattern).
 */

// The payment natures (IR Art. 63(1), Res. 25) — the ONE definition is ./whtTypes.
const WHT_TYPES_SQL = WHT_PAYMENT_TYPES_SQL;

// Why a payment to a non-resident carries no WHT (pack §2.3, §14.2) — the ONE definition is ./whtTypes
// (`WHT_NOT_SUBJECT_REASONS`); the CHECK below is built from it.

/**
 * 🔴 GLOBAL REFERENCE — the regulation's rates, effective-dated. No
 * organization_id: a rate is the Kingdom's, not a tenant's. Tenants READ it;
 * nobody but the owner role writes it (migration 0113 grants SELECT only).
 * A withholding stores the rate it applied AND this row's id, so a later rate
 * change never rewrites history.
 */
export const whtRatesTable = pgTable(
  "wht_rates",
  {
    id: serial("id").primaryKey(),
    paymentType: text("payment_type").notNull(),
    /** A fraction: 0.0500 = 5 %. */
    rate: numeric("rate", { precision: 7, scale: 4 }).notNull(),
    effectiveFrom: date("effective_from").notNull(),
    /** Inclusive; NULL = in force. */
    effectiveTo: date("effective_to"),
    /** ZATCA Form 06 row ("01".."13"). */
    formRow: text("form_row").notNull(),
    nameEn: text("name_en").notNull(),
    nameAr: text("name_ar").notNull(),
    legalReference: text("legal_reference").notNull(),
  },
  (t) => [
    uniqueIndex("wht_rates_type_from_unq").on(t.paymentType, t.effectiveFrom),
    check("wht_rates_type_chk", sql`${t.paymentType} in (${WHT_TYPES_SQL})`),
    check("wht_rates_rate_chk", sql`${t.rate} >= 0 and ${t.rate} < 1`),
    check("wht_rates_window_chk", sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`),
  ],
);

/**
 * A treaty's reduced rate for ONE supplier and ONE payment nature (pack §2.3),
 * valid only with a recorded ZATCA approval reference, inside its window, and
 * once APPROVED here by an approver. pending → approved → revoked.
 */
export const vendorWhtTreatyReliefsTable = pgTable(
  "vendor_wht_treaty_reliefs",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_org_id', true), ''))::uuid`)
      .references(() => organizationsTable.id),
    companyId: uuid("company_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_company_id', true), ''))::uuid`)
      .references(() => companiesTable.id),
    vendorId: integer("vendor_id").notNull().references(() => vendorsTable.id, { onDelete: "restrict" }),
    paymentType: text("payment_type").notNull(),
    reducedRate: numeric("reduced_rate", { precision: 7, scale: 4 }).notNull(),
    /** ISO 3166-1 alpha-2 of the treaty partner (the beneficiary's residence). */
    treatyCountry: text("treaty_country").notNull(),
    zatcaApprovalReference: text("zatca_approval_reference").notNull(),
    residencyCertificateReference: text("residency_certificate_reference").notNull(),
    validFrom: date("valid_from").notNull(),
    validTo: date("valid_to").notNull(),
    /** pending | approved | revoked */
    status: text("status").notNull().default("pending"),
    notes: text("notes"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    approvedBy: integer("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    revokedBy: integer("revoked_by"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokeReason: text("revoke_reason"),
  },
  (t) => [
    index("vendor_wht_treaty_reliefs_vendor_idx").on(t.companyId, t.vendorId, t.paymentType),
    check("vendor_wht_treaty_reliefs_type_chk", sql`${t.paymentType} in (${WHT_TYPES_SQL})`),
    check("vendor_wht_treaty_reliefs_status_chk", sql`${t.status} in ('pending', 'approved', 'revoked')`),
    check("vendor_wht_treaty_reliefs_rate_chk", sql`${t.reducedRate} >= 0 and ${t.reducedRate} < 1`),
    check("vendor_wht_treaty_reliefs_window_chk", sql`${t.validFrom} <= ${t.validTo}`),
    check("vendor_wht_treaty_reliefs_country_chk", sql`${t.treatyCountry} ~ '^[A-Z]{2}$'`),
    check("vendor_wht_treaty_reliefs_refs_chk", sql`length(btrim(${t.zatcaApprovalReference})) > 0 and length(btrim(${t.residencyCertificateReference})) > 0`),
    check("vendor_wht_treaty_reliefs_revoke_chk", sql`(${t.status} = 'revoked') = (${t.revokeReason} is not null)`),
  ],
);

/**
 * ONE row per supplier payment to a NON-RESIDENT (pack §2.4): the WHT the pay
 * path withheld, or the recorded reason it withheld none. Append-only.
 *
 * 🔴 The arithmetic is a CHECK: `wht_amount = round(base_amount × rate, 2)` —
 * a row whose tax is not its base times its rate cannot be stored.
 */
export const whtWithholdingsTable = pgTable(
  "wht_withholdings",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_org_id', true), ''))::uuid`)
      .references(() => organizationsTable.id),
    companyId: uuid("company_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_company_id', true), ''))::uuid`)
      .references(() => companiesTable.id),
    /** bill_payment | supplier_payment */
    sourceKind: text("source_kind").notNull(),
    billPaymentId: integer("bill_payment_id").references(() => billPaymentsTable.id, { onDelete: "restrict" }),
    supplierPaymentId: integer("supplier_payment_id").references(() => supplierPaymentsTable.id, { onDelete: "restrict" }),
    vendorId: integer("vendor_id").notNull().references(() => vendorsTable.id, { onDelete: "restrict" }),
    billId: integer("bill_id").references(() => billsTable.id, { onDelete: "restrict" }),
    paymentDate: date("payment_date").notNull(),
    /** YYYY-MM of `payment_date` (CHECK) — the WHT month the return and the remittance name. */
    period: text("period").notNull(),
    /**
     * withheld | not_subject | pending. `pending` (accountant Q2, 2026-10-05):
     * money on account whose purpose nobody has identified — nothing withheld,
     * no tax claimed for it, listed until it is classified (pack §14.2).
     */
    status: text("status").notNull(),
    paymentType: text("payment_type"),
    notSubjectReason: text("not_subject_reason"),
    notSubjectNote: text("not_subject_note"),
    /** What the SUPPLIER was credited with — the "full amount paid" of IR 63(1)/(8). */
    baseAmount: numeric("base_amount", { precision: 15, scale: 2 }).notNull(),
    /** The rate applied (a treaty's reduced rate where one applied). */
    rate: numeric("rate", { precision: 7, scale: 4 }).notNull(),
    /** The statutory rate in force on the payment date, kept beside a treaty rate. */
    statutoryRate: numeric("statutory_rate", { precision: 7, scale: 4 }),
    rateId: integer("rate_id").references(() => whtRatesTable.id, { onDelete: "restrict" }),
    treatyReliefId: integer("treaty_relief_id").references(() => vendorWhtTreatyReliefsTable.id, { onDelete: "restrict" }),
    whtAmount: numeric("wht_amount", { precision: 15, scale: 2 }).notNull(),
    /** The pay path's entry (Dr AP or on-account / Cr bank / Cr WHT_PAYABLE). */
    journalEntryId: integer("journal_entry_id").notNull().references(() => journalEntriesTable.id, { onDelete: "restrict" }),
    /**
     * Q2 provenance, frozen at the decision (NULL only on rows written before
     * migration 0116 — the admit trigger requires both on every new row): what
     * the money was (`WHT_PAYMENT_CLASSES`) and how its nature was established
     * (`WHT_NATURE_BASES`). A later change to the supplier's default nature or
     * the payment's classification never rewrites them.
     */
    paymentClass: text("payment_class"),
    natureBasis: text("nature_basis"),
    /**
     * A RECLASSIFICATION's record: the pending or not-subject determination this
     * one replaces after the payment was classified (deposit → advance, unknown →
     * erroneous …). The replaced row stays, beside this one — the lineage. Never
     * a withholding (a tax nobody withheld at payment is open question W-16).
     */
    supersedesWithholdingId: integer("supersedes_withholding_id").references((): AnyPgColumn => whtWithholdingsTable.id, { onDelete: "restrict" }),
    /**
     * Accountant Q1 (2026-10-05; pack §14.1): the month whose RETURN carries
     * this withholding. `period` is a fact (the payment month, by CHECK); the
     * return month equals it unless that month's Form 06 is recorded FILED and
     * the person chose the subsequent-period treatment — then it is a later,
     * unfiled month. Set at insert; the admit refuses any other value.
     */
    returnPeriod: text("return_period").notNull(),
    /** subsequent_period | amendment — stated only when the payment month's return is filed (0117 admit). */
    filedMonthTreatment: text("filed_month_treatment"),
    /** The correction this withholding RE-ENTERS (the corrected transaction of original → reversal → corrected). */
    correctionId: integer("correction_id").references((): AnyPgColumn => whtCorrectionsTable.id, { onDelete: "restrict" }),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("wht_withholdings_bill_payment_unq").on(t.billPaymentId).where(sql`bill_payment_id is not null`),
    // one ORIGINAL determination per supplier payment; each later one supersedes exactly one before it
    uniqueIndex("wht_withholdings_supplier_payment_unq").on(t.supplierPaymentId).where(sql`supplier_payment_id is not null and supersedes_withholding_id is null`),
    uniqueIndex("wht_withholdings_supersedes_unq").on(t.supersedesWithholdingId).where(sql`supersedes_withholding_id is not null`),
    uniqueIndex("wht_withholdings_correction_unq").on(t.correctionId).where(sql`correction_id is not null`),
    index("wht_withholdings_return_period_idx").on(t.companyId, t.returnPeriod),
    index("wht_withholdings_period_idx").on(t.companyId, t.period),
    index("wht_withholdings_vendor_idx").on(t.companyId, t.vendorId, t.paymentDate),
    index("wht_withholdings_entry_idx").on(t.journalEntryId),
    check("wht_withholdings_source_chk", sql`(${t.sourceKind} = 'bill_payment' and ${t.billPaymentId} is not null and ${t.supplierPaymentId} is null)
      or (${t.sourceKind} = 'supplier_payment' and ${t.supplierPaymentId} is not null and ${t.billPaymentId} is null)`),
    check("wht_withholdings_period_chk", sql`${t.period} = to_char(${t.paymentDate}, 'YYYY-MM')`),
    check("wht_withholdings_status_chk", sql`${t.status} in ('withheld', 'not_subject', 'pending')`),
    check("wht_withholdings_type_chk", sql`${t.paymentType} is null or ${t.paymentType} in (${WHT_TYPES_SQL})`),
    check("wht_withholdings_base_chk", sql`${t.baseAmount} > 0`),
    check("wht_withholdings_rate_chk", sql`${t.rate} >= 0 and ${t.rate} < 1`),
    // 🔴 THE ARITHMETIC: the tax IS the base times the rate, rounded once (half away from zero = half-up for a positive base).
    check("wht_withholdings_amount_chk", sql`${t.whtAmount} = round(${t.baseAmount} * ${t.rate}, 2)`),
    check("wht_withholdings_withheld_chk", sql`${t.status} <> 'withheld' or (${t.paymentType} is not null and ${t.rateId} is not null and ${t.statutoryRate} is not null and ${t.notSubjectReason} is null)`),
    check("wht_withholdings_not_subject_chk", sql`${t.status} <> 'not_subject' or (${t.rate} = 0 and ${t.notSubjectReason} in (${WHT_NOT_SUBJECT_REASONS_SQL}) and ${t.rateId} is null and ${t.treatyReliefId} is null)`),
    // a deposit or an erroneous payment is not consideration: no nature applies to it
    check("wht_withholdings_class_reason_chk", sql`${t.notSubjectReason} is null or ${t.notSubjectReason} not in ('refundable_deposit', 'erroneous_payment') or ${t.paymentType} is null`),
    // 🔴 PENDING claims nothing: no nature, no rate, no tax, no relief
    check("wht_withholdings_pending_chk", sql`${t.status} <> 'pending' or (${t.rate} = 0 and ${t.whtAmount} = 0 and ${t.paymentType} is null and ${t.notSubjectReason} is null and ${t.rateId} is null and ${t.statutoryRate} is null and ${t.treatyReliefId} is null)`),
    check("wht_withholdings_class_chk", sql`${t.paymentClass} is null or ${t.paymentClass} in (${WHT_PAYMENT_CLASSES_SQL})`),
    check("wht_withholdings_basis_chk", sql`${t.natureBasis} is null or ${t.natureBasis} in (${WHT_NATURE_BASES_SQL})`),
    // a return month is the payment month or later — a correction never attributes tax to an EARLIER return
    check("wht_withholdings_return_period_chk", sql`${t.returnPeriod} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' and ${t.returnPeriod} >= ${t.period}`),
    check("wht_withholdings_filed_treatment_chk", sql`${t.filedMonthTreatment} is null or ${t.filedMonthTreatment} in ('subsequent_period', 'amendment')`),
    check("wht_withholdings_note_chk", sql`${t.notSubjectReason} is distinct from 'not_kingdom_source' or length(btrim(coalesce(${t.notSubjectNote}, ''))) >= 10`),
    check("wht_withholdings_treaty_chk", sql`${t.treatyReliefId} is null or ${t.rate} <= ${t.statutoryRate}`),
  ],
);

/**
 * Money paid to ZATCA for one WHT month (pack §2.5): Dr WHT_PAYABLE (amount),
 * Dr TAX_PENALTIES (a delay fine actually paid) / Cr <bank>. Append-only; a
 * mistake is undone by a reversal row with a reason, never an edit.
 */
export const whtRemittancesTable = pgTable(
  "wht_remittances",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_org_id', true), ''))::uuid`)
      .references(() => organizationsTable.id),
    companyId: uuid("company_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_company_id', true), ''))::uuid`)
      .references(() => companiesTable.id),
    /**
     * The WHT month remitted (YYYY-MM), or NULL for the OPENING balance a
     * migration brought onto WHT_PAYABLE (Batch 1C may map a previous system's
     * WHT payable there) — remitted without a month because its months are the
     * previous system's.
     */
    period: text("period"),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    fineAmount: numeric("fine_amount", { precision: 15, scale: 2 }).notNull().default("0"),
    paidAt: date("paid_at").notNull(),
    bankAccountId: integer("bank_account_id").notNull().references(() => bankAccountsTable.id, { onDelete: "restrict" }),
    /** The SADAD / ZATCA payment reference. */
    reference: text("reference"),
    notes: text("notes"),
    journalEntryId: integer("journal_entry_id").notNull().references(() => journalEntriesTable.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("wht_remittances_period_idx").on(t.companyId, t.period),
    index("wht_remittances_entry_idx").on(t.journalEntryId),
    uniqueIndex("wht_remittances_idempotency_unq").on(t.companyId, t.idempotencyKey).where(sql`idempotency_key is not null`),
    check("wht_remittances_period_chk", sql`${t.period} is null or ${t.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check("wht_remittances_amount_chk", sql`${t.amount} > 0`),
    check("wht_remittances_fine_chk", sql`${t.fineAmount} >= 0`),
    // a month's tax is paid in or after that month — never before it exists
    check("wht_remittances_paid_after_period_chk", sql`${t.period} is null or to_char(${t.paidAt}, 'YYYY-MM') >= ${t.period}`),
  ],
);

export const whtRemittanceReversalsTable = pgTable(
  "wht_remittance_reversals",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_org_id', true), ''))::uuid`)
      .references(() => organizationsTable.id),
    companyId: uuid("company_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_company_id', true), ''))::uuid`)
      .references(() => companiesTable.id),
    remittanceId: integer("remittance_id").notNull().references(() => whtRemittancesTable.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    reversedOn: date("reversed_on").notNull(),
    journalEntryId: integer("journal_entry_id").notNull().references(() => journalEntriesTable.id, { onDelete: "restrict" }),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("wht_remittance_reversals_one_unq").on(t.remittanceId),
    index("wht_remittance_reversals_entry_idx").on(t.journalEntryId),
    check("wht_remittance_reversals_reason_chk", sql`length(btrim(${t.reason})) >= 3`),
  ],
);

/**
 * Accountant Q1 (2026-10-05; pack §14.1) — the RECORD that a month's Form 06
 * was FILED with ZATCA, and of each amendment of it. The platform does not
 * file (§2.5, LIMITATION); a person records that they did. The snapshot is the
 * return AS FILED — the admit refuses a figure the WHT ledger does not show at
 * that moment — so a later correction is measured against what was filed, and
 * a filed return is never rewritten silently. Append-only.
 */
export const whtReturnFilingsTable = pgTable(
  "wht_return_filings",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_org_id', true), ''))::uuid`)
      .references(() => organizationsTable.id),
    companyId: uuid("company_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_company_id', true), ''))::uuid`)
      .references(() => companiesTable.id),
    period: text("period").notNull(),
    /** original | amendment */
    kind: text("kind").notNull(),
    amendsFilingId: integer("amends_filing_id").references((): AnyPgColumn => whtReturnFilingsTable.id, { onDelete: "restrict" }),
    filedOn: date("filed_on").notNull(),
    zatcaReference: text("zatca_reference").notNull(),
    /** The return's totals as filed — equal to the WHT ledger's at insert (admit). May be negative (a month carrying a correction). */
    taxWithheld: numeric("tax_withheld", { precision: 15, scale: 2 }).notNull(),
    paymentTotal: numeric("payment_total", { precision: 15, scale: 2 }).notNull(),
    notes: text("notes"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("wht_return_filings_one_original_unq").on(t.companyId, t.period).where(sql`kind = 'original'`),
    index("wht_return_filings_period_idx").on(t.companyId, t.period),
    check("wht_return_filings_period_chk", sql`${t.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check("wht_return_filings_kind_chk", sql`${t.kind} in ('original', 'amendment') and ((${t.kind} = 'original') = (${t.amendsFilingId} is null))`),
    check("wht_return_filings_reference_chk", sql`length(btrim(${t.zatcaReference})) >= 3`),
    // Form 06 is filed in the month AFTER the WHT month (IR Art. 63(9)(a)): never before that month begins
    check("wht_return_filings_after_month_chk", sql`${t.filedOn} >= (to_date(${t.period} || '-01', 'YYYY-MM-DD') + interval '1 month')::date`),
  ],
);

/**
 * Accountant Q1 (2026-10-05; pack §14.1) — the CORRECTION of a posted
 * withholding: original → reversal → corrected. The original withholding and
 * its payment stay exactly as they were; this record holds the reversal (the
 * mirror of the payment's entry, its date, why, who), the month whose return
 * carries it (`reversal_return_period` — the original's month while unfiled;
 * after filing, the person's choice: a later month or an amendment), the state
 * the original was in (its filing, what of its month was remitted) and the
 * corrected re-entry once it exists. One per withholding (no double
 * correction); append-only except the one-time link to the re-entry.
 */
export const whtCorrectionsTable = pgTable(
  "wht_corrections",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_org_id', true), ''))::uuid`)
      .references(() => organizationsTable.id),
    companyId: uuid("company_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_company_id', true), ''))::uuid`)
      .references(() => companiesTable.id),
    withholdingId: integer("withholding_id").notNull().references((): AnyPgColumn => whtWithholdingsTable.id, { onDelete: "restrict" }),
    sourceKind: text("source_kind").notNull(),
    billPaymentId: integer("bill_payment_id").references(() => billPaymentsTable.id, { onDelete: "restrict" }),
    supplierPaymentId: integer("supplier_payment_id").references(() => supplierPaymentsTable.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    /** The date the reversal is posted (the mirror entry's date). */
    correctedOn: date("corrected_on").notNull(),
    /** YYYY-MM of `corrected_on` (CHECK). */
    correctionPeriod: text("correction_period").notNull(),
    reversalJournalEntryId: integer("reversal_journal_entry_id").notNull().references(() => journalEntriesTable.id, { onDelete: "restrict" }),
    /** The month whose return carries the reversal (admit-checked). */
    reversalReturnPeriod: text("reversal_return_period").notNull(),
    /** subsequent_period | amendment — only when the original's return month was filed and it withheld tax. */
    filedMonthTreatment: text("filed_month_treatment"),
    /** The original's state when corrected: its return month's latest filing, and what of that month was remitted. */
    originalFilingId: integer("original_filing_id").references(() => whtReturnFilingsTable.id, { onDelete: "restrict" }),
    remittedAtCorrection: numeric("remitted_at_correction", { precision: 15, scale: 2 }).notNull(),
    /** The corrected re-entry (null for a reversal with no re-entry). Set once, after the re-entry is written. */
    correctedBillPaymentId: integer("corrected_bill_payment_id").references(() => billPaymentsTable.id, { onDelete: "restrict" }),
    correctedSupplierPaymentId: integer("corrected_supplier_payment_id").references(() => supplierPaymentsTable.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("wht_corrections_withholding_unq").on(t.withholdingId),
    uniqueIndex("wht_corrections_entry_unq").on(t.reversalJournalEntryId),
    uniqueIndex("wht_corrections_idempotency_unq").on(t.companyId, t.idempotencyKey).where(sql`idempotency_key is not null`),
    index("wht_corrections_return_period_idx").on(t.companyId, t.reversalReturnPeriod),
    index("wht_corrections_bill_payment_idx").on(t.billPaymentId),
    index("wht_corrections_supplier_payment_idx").on(t.supplierPaymentId),
    check("wht_corrections_source_chk", sql`(${t.sourceKind} = 'bill_payment' and ${t.billPaymentId} is not null and ${t.supplierPaymentId} is null)
      or (${t.sourceKind} = 'supplier_payment' and ${t.supplierPaymentId} is not null and ${t.billPaymentId} is null)`),
    check("wht_corrections_reason_chk", sql`length(btrim(${t.reason})) >= 10`),
    check("wht_corrections_period_chk", sql`${t.correctionPeriod} = to_char(${t.correctedOn}, 'YYYY-MM') and ${t.reversalReturnPeriod} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check("wht_corrections_treatment_chk", sql`${t.filedMonthTreatment} is null or ${t.filedMonthTreatment} in ('subsequent_period', 'amendment')`),
    check("wht_corrections_reentry_chk", sql`${t.correctedBillPaymentId} is null or ${t.correctedSupplierPaymentId} is null`),
  ],
);

/** The eight Zakat-base classes (pack §3.3), each tied to its article of the 1445H Regulations. */
export const ZAKAT_CLASSES = [
  "equity", "provision_as_equity", "noncurrent_liability", "current_liability",
  "noncurrent_asset_deducted", "noncurrent_asset_not_deducted", "current_asset_deducted", "current_asset_not_deducted",
] as const;
export type ZakatClass = (typeof ZAKAT_CLASSES)[number];
const ZAKAT_CLASSES_SQL = sql.raw(ZAKAT_CLASSES.map((c) => `'${c}'`).join(", "));

/**
 * A person's classification of ONE chart account for the Zakat base (Q6: on
 * the chart; the chart is org-level, so this is too). Only CONFIRMED
 * classifications are stored — a suggestion lives in code until someone
 * accepts it. Audited on every change.
 */
export const zakatAccountClassificationsTable = pgTable(
  "zakat_account_classifications",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_org_id', true), ''))::uuid`)
      .references(() => organizationsTable.id),
    accountId: integer("account_id").notNull().references(() => categoriesTable.id, { onDelete: "cascade" }),
    classification: text("classification").notNull(),
    basisNote: text("basis_note"),
    confirmedBy: integer("confirmed_by"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("zakat_account_classifications_account_unq").on(t.organizationId, t.accountId),
    check("zakat_account_classifications_class_chk", sql`${t.classification} in (${ZAKAT_CLASSES_SQL})`),
  ],
);

/**
 * One Zakat or income-tax computation per company, kind and FROZEN fiscal year
 * (pack §5) — the fiscal year is frozen exactly as a budget freezes it.
 */
export const taxComputationsTable = pgTable(
  "tax_computations",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_org_id', true), ''))::uuid`)
      .references(() => organizationsTable.id),
    companyId: uuid("company_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_company_id', true), ''))::uuid`)
      .references(() => companiesTable.id),
    /** zakat | income_tax */
    kind: text("kind").notNull(),
    fiscalCalendar: text("fiscal_calendar").notNull(),
    fiscalStartMonth: smallint("fiscal_start_month").notNull(),
    fiscalLabel: integer("fiscal_label").notNull(),
    fiscalYearStart: text("fiscal_year_start").notNull(),
    fiscalYearEnd: text("fiscal_year_end").notNull(),
    notes: text("notes"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("tax_computations_company_kind_year_unq").on(t.companyId, t.kind, t.fiscalYearStart),
    check("tax_computations_kind_chk", sql`${t.kind} in ('zakat', 'income_tax')`),
    check("tax_computations_calendar_chk", sql`${t.fiscalCalendar} in ('gregorian', 'hijri')`),
    check("tax_computations_start_month_chk", sql`${t.fiscalStartMonth} between 1 and 12`),
    check("tax_computations_year_order_chk", sql`${t.fiscalYearStart} < ${t.fiscalYearEnd}`),
    check("tax_computations_year_format_chk", sql`${t.fiscalYearStart} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and ${t.fiscalYearEnd} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`),
  ],
);

/**
 * draft → submitted → approved → superseded, through the ONE approval engine.
 * At approval the version stores its SNAPSHOT (every input, intermediate and
 * adjustment) and the accrual it posted — the difference against what earlier
 * versions of the same computation accrued (pack §3.5).
 */
export const taxComputationVersionsTable = pgTable(
  "tax_computation_versions",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_org_id', true), ''))::uuid`)
      .references(() => organizationsTable.id),
    companyId: uuid("company_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_company_id', true), ''))::uuid`)
      .references(() => companiesTable.id),
    computationId: integer("computation_id").notNull().references(() => taxComputationsTable.id, { onDelete: "cascade" }),
    versionNo: integer("version_no").notNull(),
    status: text("status").notNull().default("draft"),
    basedOnVersionId: integer("based_on_version_id"),
    notes: text("notes"),
    sendBackNote: text("send_back_note"),
    /** Income tax only: losses carried forward available (taxpayer-declared, from audited accounts — Art. 21). */
    lossCarryforwardAvailable: numeric("loss_carryforward_available", { precision: 15, scale: 2 }),
    lossCarryforwardReference: text("loss_carryforward_reference"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    submittedBy: integer("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    approvedBy: integer("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    /** Frozen at approval. */
    snapshot: jsonb("snapshot"),
    inputsFingerprint: text("inputs_fingerprint"),
    resultAmount: numeric("result_amount", { precision: 15, scale: 2 }),
    accrualJournalEntryId: integer("accrual_journal_entry_id").references(() => journalEntriesTable.id, { onDelete: "restrict" }),
    /** Signed: what THIS approval posted (Dr expense when positive). */
    accruedAmount: numeric("accrued_amount", { precision: 15, scale: 2 }),
    accrualDate: date("accrual_date"),
  },
  (t) => [
    uniqueIndex("tax_computation_versions_no_unq").on(t.computationId, t.versionNo),
    uniqueIndex("tax_computation_versions_one_approved_unq").on(t.computationId).where(sql`status = 'approved'`),
    uniqueIndex("tax_computation_versions_one_open_unq").on(t.computationId).where(sql`status in ('draft', 'submitted')`),
    index("tax_computation_versions_company_idx").on(t.companyId),
    check("tax_computation_versions_status_chk", sql`${t.status} in ('draft', 'submitted', 'approved', 'superseded')`),
    check("tax_computation_versions_no_chk", sql`${t.versionNo} >= 1`),
    check("tax_computation_versions_loss_chk", sql`${t.lossCarryforwardAvailable} is null or ${t.lossCarryforwardAvailable} >= 0`),
    check("tax_computation_versions_loss_ref_chk", sql`coalesce(${t.lossCarryforwardAvailable}, 0) = 0 or length(btrim(coalesce(${t.lossCarryforwardReference}, ''))) > 0`),
    check("tax_computation_versions_approved_chk", sql`${t.status} not in ('approved', 'superseded') or (${t.snapshot} is not null and ${t.resultAmount} is not null and ${t.approvedAt} is not null)`),
  ],
);

/**
 * THE TAX-ADJUSTMENT MODEL (pack §5): one row per declared adjustment to a
 * computation version — what it moves, which way, how much, why, under which
 * article, from which document. Never a ledger write.
 */
export const taxAdjustmentsTable = pgTable(
  "tax_adjustments",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_org_id', true), ''))::uuid`)
      .references(() => organizationsTable.id),
    companyId: uuid("company_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_company_id', true), ''))::uuid`)
      .references(() => companiesTable.id),
    versionId: integer("version_id").notNull().references(() => taxComputationVersionsTable.id, { onDelete: "cascade" }),
    /** adjusted_net_profit | zakat_base | taxable_income */
    target: text("target").notNull(),
    /** increase | decrease */
    effect: text("effect").notNull(),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    reason: text("reason").notNull(),
    legalReference: text("legal_reference").notNull(),
    sourceReference: text("source_reference"),
    accountId: integer("account_id").references(() => categoriesTable.id, { onDelete: "restrict" }),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("tax_adjustments_version_idx").on(t.versionId),
    check("tax_adjustments_target_chk", sql`${t.target} in ('adjusted_net_profit', 'zakat_base', 'taxable_income')`),
    check("tax_adjustments_effect_chk", sql`${t.effect} in ('increase', 'decrease')`),
    check("tax_adjustments_amount_chk", sql`${t.amount} > 0`),
    check("tax_adjustments_reason_chk", sql`length(btrim(${t.reason})) >= 3`),
    check("tax_adjustments_reference_chk", sql`length(btrim(${t.legalReference})) >= 2`),
  ],
);

export type WhtRate = typeof whtRatesTable.$inferSelect;
export type VendorWhtTreatyRelief = typeof vendorWhtTreatyReliefsTable.$inferSelect;
export type WhtWithholding = typeof whtWithholdingsTable.$inferSelect;
export type WhtRemittance = typeof whtRemittancesTable.$inferSelect;
export type WhtReturnFiling = typeof whtReturnFilingsTable.$inferSelect;
export type WhtCorrection = typeof whtCorrectionsTable.$inferSelect;
export type ZakatAccountClassification = typeof zakatAccountClassificationsTable.$inferSelect;
export type TaxComputation = typeof taxComputationsTable.$inferSelect;
export type TaxComputationVersion = typeof taxComputationVersionsTable.$inferSelect;
export type TaxAdjustment = typeof taxAdjustmentsTable.$inferSelect;
