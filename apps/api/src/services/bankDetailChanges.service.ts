/**
 * 🔴 Phase 18 R-6 — DR-23 (D-6), its dual control (register §11.98, §11.99):
 * "Dual control only where two admins exist."
 *
 * A bank-detail change — a supplier's IBAN, a company bank account's IBAN, or
 * an account BECOMING the default (the IBAN printed on future invoices, G30) —
 * in an organisation with two or more USABLE admins (G03's definition, read
 * from the database's one definition) is not written: it is recorded here as a
 * PENDING request, and the rest of the write goes ahead. Below two admins it is
 * written at once, as before (H-8's audit record).
 *
 * This module HOLDS; `bankDetailChangeDecisions.service` decides. The split
 * keeps the import graph acyclic: the supplier and bank-account services call
 * the hold, and the decision calls their apply functions.
 *
 * The database is the boundary (0151): a held change cannot be written by any
 * path without an approval recorded in the same transaction.
 */
import { auditContext } from "../lib/auditContext";
import { afterCommit } from "../lib/afterCommit";
import { membersRepository } from "../repositories/members.repository";
import { bankDetailChangesRepository as repo, type BankDetailChangeRow } from "../repositories/bankDetailChanges.repository";
import { auditService } from "./audit.service";
import type { BankDetailChangeKind, vendorsTable, bankAccountsTable } from "@workspace/db";

type Vendor = typeof vendorsTable.$inferSelect;
type BankAccount = typeof bankAccountsTable.$inferSelect;

export type BankDetailChangeOut = {
  id: number;
  kind: BankDetailChangeKind;
  vendorId: number | null;
  bankAccountId: number | null;
  subjectName: string | null;
  ibanBefore: string | null;
  ibanAfter: string | null;
  status: "pending" | "approved" | "rejected";
  requestedBy: number;
  requestedByName: string | null;
  requestedAt: string;
  decidedBy: number | null;
  decidedByName: string | null;
  decidedAt: string | null;
};

function actor(): { userId: number; organizationId: string } {
  const ctx = auditContext.get();
  if (!ctx || ctx.userId == null) throw new Error("a bank-detail change is recorded inside a signed-in request");
  return { userId: ctx.userId, organizationId: ctx.organizationId };
}

/** Two or more usable admins: a bank-detail change waits for a second one. */
async function dualControlApplies(): Promise<boolean> {
  return (await membersRepository.usableAdminCount(actor().organizationId)) >= 2;
}

const iso = (d: Date | string | null) => (d == null ? null : new Date(d).toISOString());

/**
 * Requests as the API answers them, the requester's and decider's names resolved in the identity layer.
 *
 * 🔴 TR-5: the names are read AFTER the request's transaction commits. They come through the owner connection, and
 * reading them with the tenant transaction open held that transaction's row locks for as long as the identity tables
 * took to answer: past 15 seconds, the idle-in-transaction timeout killed the decision. The objects returned here are
 * filled in by that step, before the response is written.
 */
export async function toOut(rows: BankDetailChangeRow[]): Promise<BankDetailChangeOut[]> {
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.flatMap((r) => [r.requestedBy, r.decidedBy]).filter((x): x is number => x != null))];
  const organizationId = actor().organizationId;
  const out: BankDetailChangeOut[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    vendorId: r.vendorId,
    bankAccountId: r.bankAccountId,
    subjectName: r.vendorName ?? r.bankAccountName ?? null,
    ibanBefore: r.ibanBefore,
    ibanAfter: r.ibanAfter,
    status: r.status,
    requestedBy: r.requestedBy,
    requestedByName: null,
    requestedAt: iso(r.requestedAt)!,
    decidedBy: r.decidedBy,
    decidedByName: null,
    decidedAt: iso(r.decidedAt),
  }));
  const fillNames = async () => {
    const names = await membersRepository.memberNamesByIds(organizationId, ids);
    for (const o of out) {
      o.requestedByName = names.get(o.requestedBy) ?? null;
      o.decidedByName = o.decidedBy != null ? (names.get(o.decidedBy) ?? null) : null;
    }
  };
  if (!afterCommit(fillNames)) await fillNames();
  return out;
}

/** Record a held change (pending), with its audit record. */
async function record(values: {
  kind: BankDetailChangeKind;
  vendorId?: number;
  bankAccountId?: number;
  ibanBefore: string | null;
  ibanAfter: string | null;
}): Promise<number> {
  const [row] = await repo.insert({ ...values, requestedBy: actor().userId });
  await auditService.created("bank_detail_change_request", row.id, values);
  return row.id;
}

const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? null) === (b ?? null);

export const bankDetailChangesService = {
  /**
   * The supplier PATCH: where two admins exist, a change of the IBAN is held
   * and removed from the values to write. A second change of the same
   * supplier's IBAN while one waits is refused by the database's partial unique
   * index (409 `bank_detail_change_pending`, lib/dbRefusals) and the whole
   * request rolls back — the index is the rule, so no check here repeats it.
   */
  async holdVendorIban<V extends { iban?: string | null }>(before: Vendor, values: V): Promise<{ values: V; held: number[] }> {
    if (!("iban" in values) || same(values.iban, before.iban)) return { values, held: [] };
    if (!(await dualControlApplies())) return { values, held: [] };
    const id = await record({ kind: "vendor_iban", vendorId: before.id, ibanBefore: before.iban ?? null, ibanAfter: values.iban ?? null });
    const { iban: _held, ...rest } = values;
    return { values: rest as V, held: [id] };
  },

  /**
   * The bank-account PATCH: an IBAN change and the account becoming the
   * default are each held where two admins exist. A second request while one
   * waits is refused by the partial unique index, and the request rolls back
   * whole — so a refusal writes nothing.
   */
  async holdBankAccountUpdate<U extends { iban?: unknown; isDefault?: unknown }>(before: BankAccount, updates: U): Promise<{ updates: U; held: number[] }> {
    const ibanChange = "iban" in updates && !same(updates.iban as string | null, before.iban);
    const becomesDefault = updates.isDefault === true && !before.isDefault;
    if (!ibanChange && !becomesDefault) return { updates, held: [] };
    if (!(await dualControlApplies())) return { updates, held: [] };
    const rest: Record<string, unknown> = { ...updates };
    const held: number[] = [];
    if (ibanChange) {
      held.push(await record({ kind: "bank_account_iban", bankAccountId: before.id, ibanBefore: before.iban ?? null, ibanAfter: (updates.iban as string | null) ?? null }));
      delete rest.iban;
    }
    if (becomesDefault) {
      // The printed IBAN after is the account's STORED IBAN — a change of it held above is not yet its IBAN.
      const current = await repo.currentDefaultAccount();
      held.push(await record({ kind: "default_bank_account", bankAccountId: before.id, ibanBefore: current?.iban ?? null, ibanAfter: before.iban ?? null }));
      delete rest.isDefault;
    }
    return { updates: rest as U, held };
  },

  /** The bank-account CREATE: is becoming the default held? (Then the account is created as not default.) */
  async holdsNewDefault(isDefault: unknown): Promise<boolean> {
    return isDefault === true && (await dualControlApplies());
  },

  /** …and the request for the account just created. */
  async recordNewDefault(account: BankAccount): Promise<number[]> {
    const current = await repo.currentDefaultAccount();
    return [await record({ kind: "default_bank_account", bankAccountId: account.id, ibanBefore: current?.iban ?? null, ibanAfter: account.iban ?? null })];
  },

  /** The held requests, as the API answers them (for a write's `pendingBankDetailChanges`). */
  async out(ids: number[]): Promise<BankDetailChangeOut[]> {
    // Nothing held (one admin, or no bank detail changed): no read, and no request context needed.
    if (ids.length === 0) return [];
    return toOut(await repo.findByIds(ids));
  },

  async list(): Promise<{ items: BankDetailChangeOut[] }> {
    return { items: await toOut(await repo.list()) };
  },
};
