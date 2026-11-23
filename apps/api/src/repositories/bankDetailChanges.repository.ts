/**
 * 🔴 Phase 18 R-6 — DR-23's dual control (register §11.98): the held
 * bank-detail changes of the active company. Tenant-scoped (RLS) and
 * company-scoped ({@link companyScoped}); the database decides who may insert
 * and decide a request (migration 0151's triggers), this layer only reads and
 * writes it.
 */
import {
  db,
  bankDetailChangeRequestsTable as t,
  vendorsTable,
  employeesTable,
  bankAccountsTable,
  type BankDetailChangeKind,
} from "@workspace/db";
import { and, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { companyScoped } from "./companyScope";

const withSubject = () =>
  db
    .select({ ...getTableColumns(t), vendorName: vendorsTable.name, employeeName: employeesTable.name, bankAccountName: bankAccountsTable.name })
    .from(t)
    .leftJoin(vendorsTable, eq(vendorsTable.id, t.vendorId))
    .leftJoin(employeesTable, eq(employeesTable.id, t.employeeId))
    .leftJoin(bankAccountsTable, eq(bankAccountsTable.id, t.bankAccountId));

export type BankDetailChangeRow = Awaited<ReturnType<typeof bankDetailChangesRepository.findById>>[number];

export const bankDetailChangesRepository = {
  /** Every request of the active company, newest first. */
  list() {
    return withSubject().where(companyScoped(t.companyId)).orderBy(desc(t.requestedAt), desc(t.id));
  },

  findById(id: number) {
    return withSubject().where(and(eq(t.id, id), companyScoped(t.companyId))).limit(1);
  },

  findByIds(ids: number[]) {
    if (ids.length === 0) return Promise.resolve([] as BankDetailChangeRow[]);
    return withSubject().where(and(inArray(t.id, ids), companyScoped(t.companyId))).orderBy(t.id);
  },

  /** Recorded as pending; `requested_by` must be the connection's declared actor (0151 refuses any other). */
  insert(values: {
    kind: BankDetailChangeKind;
    vendorId?: number | null;
    employeeId?: number | null;
    bankAccountId?: number | null;
    ibanBefore: string | null;
    ibanAfter: string | null;
    requestedBy: number;
    atCreation?: boolean;
  }) {
    return db.insert(t).values(values).returning({ id: t.id });
  },

  /**
   * 🔴 19B S3: the FALLBACK, recorded closed — by the requester, at now(), with its reason. The database (0170) refuses
   * it unless the requester is the only member who could ever approve bank details.
   */
  insertFallback(values: {
    kind: "vendor_iban" | "employee_iban";
    vendorId?: number | null;
    employeeId?: number | null;
    ibanBefore: string | null;
    ibanAfter: string | null;
    requestedBy: number;
    reason: string;
    atCreation?: boolean;
  }) {
    return db
      .insert(t)
      .values({ ...values, status: "applied_without_second_approver", decidedBy: values.requestedBy, decidedAt: sql`now()` })
      .returning({ id: t.id });
  },

  /**
   * 19B S3: for each subject, its party-IBAN requests that are pending or that applied without a second approver,
   * newest first — whether an IBAN waits, and the last fallback (the line its record shows).
   */
  partyIbanState(kind: "vendor_iban" | "employee_iban", subjectIds: number[]) {
    type State = { subjectId: number | null; status: string; requestedBy: number; decidedAt: Date | null; id: number };
    if (subjectIds.length === 0) return Promise.resolve([] as State[]);
    const subject = kind === "vendor_iban" ? t.vendorId : t.employeeId;
    return db
      .select({ subjectId: subject, status: t.status, requestedBy: t.requestedBy, decidedAt: t.decidedAt, id: t.id })
      .from(t)
      .where(and(eq(t.kind, kind), inArray(subject, subjectIds), inArray(t.status, ["pending", "applied_without_second_approver"])))
      .orderBy(desc(t.id)) as Promise<State[]>;
  },

  /** Decide a PENDING request, at now(), by `decidedBy` (0151: the declared actor). No row back = it was not pending. */
  decide(id: number, status: "approved" | "rejected", decidedBy: number) {
    return db
      .update(t)
      .set({ status, decidedBy, decidedAt: sql`now()` })
      .where(and(eq(t.id, id), eq(t.status, "pending"), companyScoped(t.companyId)))
      .returning({ id: t.id });
  },

  /** The account whose details print on invoices now — the company's default — if there is one. */
  async currentDefaultAccount() {
    const [row] = await db
      .select({ id: bankAccountsTable.id, iban: bankAccountsTable.iban })
      .from(bankAccountsTable)
      .where(and(companyScoped(bankAccountsTable.companyId), eq(bankAccountsTable.isDefault, true)))
      .orderBy(bankAccountsTable.id)
      .limit(1);
    return row ?? null;
  },
};
