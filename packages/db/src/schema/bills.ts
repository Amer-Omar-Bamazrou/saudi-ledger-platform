import { DEFAULT_VAT_RATE } from "@workspace/shared";
import { uniqueIndex, pgTable, serial, text, boolean, timestamp, integer, numeric, uuid, index, jsonb, foreignKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { vendorsTable } from "./vendors";
import { categoriesTable } from "./categories";
import { productsTable } from "./products";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";
import { fixedAssetsTable } from "./assets";

export const billsTable = pgTable(
  "bills",
  {
    id: serial("id").primaryKey(),
    // Multi-tenancy — enforced NOT NULL in M3 (migrations/0002).
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`app_default_org_id()`)
      .references(() => organizationsTable.id),
    companyId: uuid("company_id")
      .notNull()
      .default(sql`app_default_company_id()`)
      .references(() => companiesTable.id),
    billNumber: text("bill_number").notNull(),
    /**
     * B7 (2026-09-22) — `bill` | `credit_note` | `debit_note`.
     *
     * 🔴 A PURCHASE-SIDE NOTE IS THE SUPPLIER'S DOCUMENT, NOT OURS. The VAT
     * IR's Credit and Debit Notes ¶1 puts the obligation on "the Taxable Person
     * WHO HAS MADE THE SUPPLY": when our tenant is the customer it ISSUES
     * nothing — no ICV is consumed, no QR is minted, no position is taken in
     * the ZATCA hash chain, nothing is queued to the outbox. We RECORD a
     * document we received. That is the whole difference from
     * `invoices.document_type`, which looks identical and is not.
     *
     * 🔴 And the period is the supplier's, not ours: Art. 40(6) has the
     * CUSTOMER correct its INPUT tax "in the Tax Period in which the Credit
     * Note or Debit Note is ISSUED" — so the note carries its own `date` (the
     * supplier's issue date) and the VAT return reads that, never the original
     * bill's date and never the day we keyed it in.
     */
    documentType: text("document_type").notNull().default("bill"),
    /**
     * Z-AP1 (2026-09-24, accountant answer A) — on an `advance_invoice` (the
     * SUPPLIER'S advance-payment tax invoice, their type 386, which we RECEIVE)
     * the supplier payment it invoices; NULL on every other type (CHECK
     * `bills_advance_reference_chk`, FK `bills_advance_supplier_payment_fk` —
     * both in migration 0104, hand-written: `supplierPayments.ts` imports this
     * file, so the reference cannot be declared here without a cycle).
     */
    advanceSupplierPaymentId: integer("advance_supplier_payment_id"),
    /** The bill this note adjusts. Required on a note, forbidden on a bill. */
    creditNoteAgainstBillId: integer("credit_note_against_bill_id"),
    vendorReference: text("vendor_reference"),
    /**
     * 🔴 CHECK bills_date_format_chk (migration 0071, hand-written — the
     * 0020/0049/0062 precedent): exactly YYYY-MM-DD, below every application
     * guard. Do not drop on a snapshot diff; drizzle does not track CHECKs.
     * Why, and the audit that preceded it: findings file, "THE DATE-COLUMN
     * AUDIT" (2026-09-15).
     */
    date: text("date").notNull(),
    dueDate: text("due_date"),
    vendorId: integer("vendor_id").references(() => vendorsTable.id, { onDelete: "restrict" }),
    // Draft/approval workflow (M10.3): draft = editable, not in books nor in the
    // approval queue; submitted = awaiting approval (locked); received = approved
    // & posted to the GL (in AP/expense/VAT). paid/overdue are post-approval.
    // `overdue` removed — DERIVED from due_date (see bills.repository `OVERDUE`).
    status: text("status").notNull().default("draft"), // draft | submitted | received | approved | paid
    subtotal: numeric("subtotal", { precision: 15, scale: 2 }).notNull().default("0"),
    vatAmount: numeric("vat_amount", { precision: 15, scale: 2 }).notNull().default("0"),
    total: numeric("total", { precision: 15, scale: 2 }).notNull().default("0"),
    currency: text("currency").default("SAR"),
    paidAmount: numeric("paid_amount", { precision: 15, scale: 2 }).default("0"),
    paidAt: text("paid_at"),
    // Correction note an approver leaves when sending a submitted bill back to the
    // bookkeeper for edit; shown while editing, cleared on resubmit/approve (M10.3).
    reviewNote: text("review_note"),
    /**
     * The expense account the bill posts to, chosen at entry (2026-09-15,
     * workflow audit W2 G1). It lives ON the bill so it survives submit →
     * approve: the Approvals queue sends no body, and the choice used to exist
     * only in the post request, so every two-person bill fell back to
     * Purchases. Resolved by `resolveExpenseLine` when the post/approve body
     * supplies nothing; a body value still wins. Nullable — the seeded default
     * (PURCHASES) applies when neither is given.
     */
    expenseAccountId: integer("expense_account_id").references(() => categoriesTable.id, { onDelete: "set null" }),
    /**
     * FA-B (2026-09-22): the DRAFT fixed asset this bill buys. Set on the
     * draft bill; at approval the debit line becomes the asset category's
     * COST account and the asset is capitalised on that entry (one writer,
     * one effect — fixed-assets pack §3 A1, §21). NULL = an ordinary expense
     * bill.
     *
     * 🔴 G04 (0122): it had NO foreign key, so another tenant's asset, the
     * same organization's other company's, and a nonexistent id were all
     * stored. `bills_capitalises_asset_tenant_fk` below names the asset WITH
     * the bill's organization and company: a bill buys its own company's asset.
     */
    capitalisesAssetId: integer("capitalises_asset_id"),
    notes: text("notes"),
    /** Batch 1C: an opening payable migrated at cut-off (see invoices.isOpening). */
    isOpening: boolean("is_opening").notNull().default(false),
    migrationOpenItemId: integer("migration_open_item_id"),
    /** Batch 1C Policy C — the reversed marker and the replacement link; see invoices.reversedAt (pack §16.12.1). */
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedByMigrationBatchId: integer("reversed_by_migration_batch_id"),
    /** 2026-09-22: on an ORIGINAL opening payable corrected under A4/answer 5 — the entry whose other side is retained earnings (see invoices.openingCorrectionJournalEntryId). */
    openingCorrectionJournalEntryId: integer("opening_correction_journal_entry_id"),
    replacesBillId: integer("replaces_bill_id"),
    /**
     * 🔴 PHASE 13A (2026-09-24) — THE SUPPLIER'S DOCUMENT, AND WHETHER IT
     * EVIDENCES THE INPUT VAT THIS BILL WOULD CLAIM.
     *
     * `supplier_document_kind` is what the user states they HOLD:
     * `tax_invoice` (IR Art. 53(5)), `simplified_tax_invoice` (53(8)) or
     * `no_tax_invoice` (a receipt or statement that is not a tax invoice).
     * NULL = not stated — and a claim of VAT with nothing stated is not
     * evidenced. Never defaulted: a default would be the platform asserting a
     * document the user never said they hold.
     *
     * `vat_evidence_*` is the SERVER's verdict (`services/purchaseEvidence`),
     * written on every draft write and re-decided at approval:
     * `not_required` (nothing to claim) · `evidenced` · `awaiting_evidence` ·
     * `not_deductible` (VAT IR Art. 50) · `not_evaluated` (a row older than
     * Phase 13). CHECKs and the approval trigger are hand-written in migration
     * 0105: a draft can only become POSTED when its verdict supports the
     * claim — the rule holds for every path, including ones not yet written.
     */
    supplierDocumentKind: text("supplier_document_kind"),
    vatEvidenceStatus: text("vat_evidence_status").notNull().default("not_evaluated"),
    /** `qr_signature_verified` · `qr_unsigned` · `document_attached` · `attested` — what the verdict rests on. */
    vatEvidenceBasis: text("vat_evidence_basis"),
    /** [{ code, severity: blocking|warning|info, message }] — WHY, by structured code. */
    vatEvidenceFlags: jsonb("vat_evidence_flags"),
    vatEvidenceCheckedAt: timestamp("vat_evidence_checked_at", { withTimezone: true }),
    /**
     * 🔴 PHASE 13A (accountant answers X1/X3/X5, 2026-09-27) — WHERE this
     * posted document's input VAT sits. Written by the approval, in the same
     * UPDATE that posts it; NULL on a draft.
     *   `claimed`            in VAT_INPUT — deductible, on the return in the
     *                        period `input_vat_claimed_on` names;
     *   `awaiting_evidence`  in VAT_AWAITING_EVIDENCE (`input_vat_pending`),
     *                        never on the return until the evidence entry moves
     *                        it (Dr VAT_INPUT / Cr awaiting), dated the day the
     *                        evidence is held — that date is the claim period;
     *   `not_deductible`     in the cost (Art. 50 expense, a 0 %-recovery asset)
     *                        — never input VAT.
     * A supplier credit note follows the document it corrects. NULL on a
     * posted row = inserted posted outside the approval (opening items, older
     * rows): the pre-Phase-13 reading, claimed on its own date. Transitions and
     * the five-year window are enforced by `bills_vat_evidence_gate` (0106).
     */
    inputVatState: text("input_vat_state"),
    inputVatPending: numeric("input_vat_pending", { precision: 15, scale: 2 }).notNull().default("0"),
    inputVatClaimedOn: text("input_vat_claimed_on"),
    /** The evidence entry that moved held VAT into VAT_INPUT; NULL when claimed on the document's own entry. */
    inputVatClaimEntryId: integer("input_vat_claim_entry_id"),
    /**
     * 🔴 PHASE 13C — an EXPENSE: a purchase already paid when it is recorded.
     * It is a bill (one posting path) that states the bank it was paid from
     * and the date; its APPROVAL posts it and pays it through the existing
     * bill-payment path in the same transaction, so no payable is left
     * outstanding. The bank FK is hand-written in 0105 (no import cycle); the
     * service checks the bank is this tenant's (FK checks run outside RLS).
     */
    recordedAsExpense: boolean("recorded_as_expense").notNull().default(false),
    expensePaidFromBankAccountId: integer("expense_paid_from_bank_account_id"),
    expensePaidAt: text("expense_paid_at"),
    createdBy: integer("created_by"),    // FK to users.id (nullable for pre-auth records)
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("bills_org_status_idx").on(t.organizationId, t.status),
    // N3: a bill number means ONE bill. Declared so drizzle-kit cannot read
    // the index as drift (the N4 lesson); pinned by money-unique-indexes.
    uniqueIndex("bills_company_number_unq").on(t.companyId, t.billNumber),
    // Phase 13A: the duplicate check reads supplier + the SUPPLIER'S number.
    index("bills_company_vendor_ref_idx").on(t.companyId, t.vendorId, t.vendorReference),
    // Phase 13A: the awaiting-evidence list.
    index("bills_company_evidence_idx").on(t.companyId, t.vatEvidenceStatus),
    foreignKey({ name: "bills_capitalises_asset_tenant_fk", columns: [t.organizationId, t.companyId, t.capitalisesAssetId], foreignColumns: [fixedAssetsTable.organizationId, fixedAssetsTable.companyId, fixedAssetsTable.id] }).onDelete("restrict"),
  ],
);

export const billItemsTable = pgTable(
  "bill_items",
  {
    id: serial("id").primaryKey(),
    // Multi-tenancy — enforced NOT NULL in M3 (migrations/0002).
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`app_default_org_id()`)
      .references(() => organizationsTable.id),
    companyId: uuid("company_id")
      .notNull()
      .default(sql`app_default_company_id()`)
      .references(() => companiesTable.id),
    billId: integer("bill_id").notNull().references(() => billsTable.id, { onDelete: "cascade" }),
    productId: integer("product_id").references(() => productsTable.id, { onDelete: "set null" }),
    description: text("description").notNull(),
    descriptionAr: text("description_ar"),
    quantity: numeric("quantity", { precision: 15, scale: 3 }).notNull().default("1"),
    unitPrice: numeric("unit_price", { precision: 15, scale: 2 }).notNull(),
    vatRate: numeric("vat_rate", { precision: 5, scale: 2 }).default(String(DEFAULT_VAT_RATE)),
    vatAmount: numeric("vat_amount", { precision: 15, scale: 2 }).default("0"),
    total: numeric("total", { precision: 15, scale: 2 }).notNull().default("0"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("bill_items_org_bill_idx").on(t.organizationId, t.billId)],
);

export const insertBillSchema = createInsertSchema(billsTable).omit({ id: true, createdAt: true });
export const insertBillItemSchema = createInsertSchema(billItemsTable).omit({ id: true, createdAt: true });
export type InsertBill = z.infer<typeof insertBillSchema>;
export type Bill = typeof billsTable.$inferSelect;
export type BillItem = typeof billItemsTable.$inferSelect;
