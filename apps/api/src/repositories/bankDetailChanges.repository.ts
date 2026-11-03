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
  bankAccountsTable,
  type BankDetailChangeKind,
} from "@workspace/db";
import { and, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { companyScoped } from "./companyScope";

const withSubject = () =>
  db
    .select({ ...getTableColumns(t), vendorName: vendorsTable.name, bankAccountName: bankAccountsTable.name })
    .from(t)
    .leftJoin(vendorsTable, eq(vendorsTable.id, t.vendorId))
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
    bankAccountId?: number | null;
    ibanBefore: string | null;
    ibanAfter: string | null;
    requestedBy: number;
  }) {
    return db.insert(t).values(values).returning({ id: t.id });
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
