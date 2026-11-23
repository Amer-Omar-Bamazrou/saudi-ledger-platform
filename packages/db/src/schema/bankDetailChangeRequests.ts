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
 *
 * 🔴 19B S3 (v4 §6.3, D2; migration 0170): a VENDOR's and an EMPLOYEE's IBAN —
 * the first and every later one — is ALWAYS held, whoever enters it, and approved
 * by a member whose role holds `bank_detail:approve` (accountant, admin), never
 * the requester. The one exception, the fallback: when the requester is the only
 * member who could ever approve it, it applies at once and the row is written
 * closed as `applied_without_second_approver`, with its `reason`. The company's
 * own bank accounts keep DR-23's rule above.
 */
import { pgTable, serial, uuid, integer, text, boolean, timestamp, check, uniqueIndex, foreignKey, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";
import { vendorsTable } from "./vendors";
import { bankAccountsTable } from "./bankAccounts";
import { employeesTable } from "./employees";

export const BANK_DETAIL_CHANGE_KINDS = ["vendor_iban", "employee_iban", "bank_account_iban", "default_bank_account"] as const;
export type BankDetailChangeKind = (typeof BANK_DETAIL_CHANGE_KINDS)[number];
/** 19B S3: the kinds S3's rule governs — held always, approved by `bank_detail:approve`, with the fallback. */
export const PARTY_IBAN_KINDS = ["vendor_iban", "employee_iban"] as const satisfies readonly BankDetailChangeKind[];
export const BANK_DETAIL_CHANGE_STATUSES = ["pending", "approved", "rejected", "applied_without_second_approver"] as const;
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
    /** 19B S3: the employee whose IBAN this changes (kind `employee_iban`). */
    employeeId: integer("employee_id"),
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
    /** 19B S3: why an IBAN applied without a second approver (the fallback) — set exactly then. */
    reason: text("reason"),
    /**
     * 19B S3: the IBAN was entered WITH the supplier or employee, on the create form — their first, so `iban_before` is
     * null. Before S3 that IBAN was written in the record's creation and was never a CHANGE; S3 now applies it after
     * the creation, and this keeps it out of what reads IBAN changes (H-9 / A23's change-then-pay finding,
     * `companyControls.repository`). Fixed once written (the guard).
     */
    atCreation: boolean("at_creation").notNull().default(false),
  },
  (t) => [
    check("bank_detail_change_kind_chk", sql`${t.kind} in ('vendor_iban', 'employee_iban', 'bank_account_iban', 'default_bank_account')`),
    check("bank_detail_change_status_chk", sql`${t.status} in ('pending', 'approved', 'rejected', 'applied_without_second_approver')`),
    check(
      "bank_detail_change_subject_chk",
      sql`(${t.kind} = 'vendor_iban' and ${t.vendorId} is not null and ${t.employeeId} is null and ${t.bankAccountId} is null) or (${t.kind} = 'employee_iban' and ${t.employeeId} is not null and ${t.vendorId} is null and ${t.bankAccountId} is null) or (${t.kind} in ('bank_account_iban', 'default_bank_account') and ${t.bankAccountId} is not null and ${t.vendorId} is null and ${t.employeeId} is null)`,
    ),
    check("bank_detail_change_decision_chk", sql`(${t.status} = 'pending') = (${t.decidedBy} is null and ${t.decidedAt} is null)`),
    // 19B S3: the fallback carries its reason, only a party IBAN may take it, and nothing else carries a reason.
    check(
      "bank_detail_change_fallback_chk",
      sql`(${t.status} = 'applied_without_second_approver') = (${t.reason} is not null) and (${t.status} <> 'applied_without_second_approver' or ${t.kind} in ('vendor_iban', 'employee_iban'))`,
    ),
    // 19B S3: only a supplier's or an employee's FIRST IBAN is entered at creation
    check(
      "bank_detail_change_at_creation_chk",
      sql`not ${t.atCreation} or (${t.ibanBefore} is null and ${t.kind} in ('vendor_iban', 'employee_iban'))`,
    ),
    foreignKey({
      name: "bank_detail_change_employee_tenant_fk",
      columns: [t.organizationId, t.employeeId],
      foreignColumns: [employeesTable.organizationId, employeesTable.id],
    }).onDelete("cascade"),
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
    uniqueIndex("bank_detail_change_pending_employee_unq").on(t.employeeId).where(sql`${t.status} = 'pending' and ${t.kind} = 'employee_iban'`),
    uniqueIndex("bank_detail_change_pending_account_unq").on(t.bankAccountId).where(sql`${t.status} = 'pending' and ${t.kind} = 'bank_account_iban'`),
    uniqueIndex("bank_detail_change_pending_default_unq").on(t.companyId).where(sql`${t.status} = 'pending' and ${t.kind} = 'default_bank_account'`),
    index("bank_detail_change_company_idx").on(t.companyId, t.requestedAt),
  ],
);

export type BankDetailChangeRequest = typeof bankDetailChangeRequestsTable.$inferSelect;
