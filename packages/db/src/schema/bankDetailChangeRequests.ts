/**
 * 🔴 Phase 18 R-6 — DR-23 (D-6), its dual control (register §11.98): "Dual
 * control only where two admins exist."
 *
 * A bank-detail change — a supplier's IBAN, a company bank account's IBAN, or
 * which account is the DEFAULT (the IBAN printed on future invoices, G30) — in
 * an organisation with two or more usable admins is not written; it is
 * recorded here as PENDING, and a second admin (never the requester) applies
 * it. The database enforces both halves (migration 0151): a request is
 * inserted only as pending by the declared actor and decided once; and the
 * supplier / bank-account write itself is refused unless a matching request
 * was approved in the same transaction.
 *
 * `iban_before` / `iban_after` are stored normalised. For a default switch they
 * are the PRINTED IBAN before (the current default's, or null) and after (the
 * account being made default).
 */
import { pgTable, serial, uuid, integer, text, timestamp, check, uniqueIndex, foreignKey, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";
import { vendorsTable } from "./vendors";
import { bankAccountsTable } from "./bankAccounts";

export const BANK_DETAIL_CHANGE_KINDS = ["vendor_iban", "bank_account_iban", "default_bank_account"] as const;
export type BankDetailChangeKind = (typeof BANK_DETAIL_CHANGE_KINDS)[number];
export const BANK_DETAIL_CHANGE_STATUSES = ["pending", "approved", "rejected"] as const;
export type BankDetailChangeStatus = (typeof BANK_DETAIL_CHANGE_STATUSES)[number];

export const bankDetailChangeRequestsTable = pgTable(
  "bank_detail_change_requests",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_org_id', true), ''))::uuid`)
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_company_id', true), ''))::uuid`)
      .references(() => companiesTable.id, { onDelete: "cascade" }),
    kind: text("kind").$type<BankDetailChangeKind>().notNull(),
    vendorId: integer("vendor_id"),
    bankAccountId: integer("bank_account_id"),
    ibanBefore: text("iban_before"),
    ibanAfter: text("iban_after"),
    status: text("status").$type<BankDetailChangeStatus>().notNull().default("pending"),
    /** The connection's declared actor (T1b) — the database refuses any other. */
    requestedBy: integer("requested_by")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_user_id', true), ''))::integer`),
    requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
    decidedBy: integer("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [
    check("bank_detail_change_kind_chk", sql`${t.kind} in ('vendor_iban', 'bank_account_iban', 'default_bank_account')`),
    check("bank_detail_change_status_chk", sql`${t.status} in ('pending', 'approved', 'rejected')`),
    check(
      "bank_detail_change_subject_chk",
      sql`(${t.kind} = 'vendor_iban' and ${t.vendorId} is not null and ${t.bankAccountId} is null) or (${t.kind} <> 'vendor_iban' and ${t.bankAccountId} is not null and ${t.vendorId} is null)`,
    ),
    check("bank_detail_change_decision_chk", sql`(${t.status} = 'pending') = (${t.decidedBy} is null and ${t.decidedAt} is null)`),
    foreignKey({
      name: "bank_detail_change_vendor_tenant_fk",
      columns: [t.organizationId, t.vendorId],
      foreignColumns: [vendorsTable.organizationId, vendorsTable.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "bank_detail_change_bank_account_tenant_fk",
      columns: [t.organizationId, t.bankAccountId],
      foreignColumns: [bankAccountsTable.organizationId, bankAccountsTable.id],
    }).onDelete("cascade"),
    uniqueIndex("bank_detail_change_pending_vendor_unq").on(t.vendorId).where(sql`${t.status} = 'pending' and ${t.kind} = 'vendor_iban'`),
    uniqueIndex("bank_detail_change_pending_account_unq").on(t.bankAccountId).where(sql`${t.status} = 'pending' and ${t.kind} = 'bank_account_iban'`),
    uniqueIndex("bank_detail_change_pending_default_unq").on(t.companyId).where(sql`${t.status} = 'pending' and ${t.kind} = 'default_bank_account'`),
    index("bank_detail_change_company_idx").on(t.companyId, t.requestedAt),
  ],
);

export type BankDetailChangeRequest = typeof bankDetailChangeRequestsTable.$inferSelect;
