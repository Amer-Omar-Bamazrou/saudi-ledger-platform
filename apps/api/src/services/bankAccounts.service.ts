/** Bank accounts service — numeric (de)serialization. Behavior preserved from pre-M6. */
import { NotFoundError } from "../lib/errors";
import { auditService } from "./audit.service";
import { bankAccountsRepository } from "../repositories/bankAccounts.repository";
import type { bankAccountsTable } from "@workspace/db";

type BankAccount = typeof bankAccountsTable.$inferSelect;
const toNum = (v: unknown) => (v != null ? Number(v) : 0);
const toView = (b: BankAccount) => ({ ...b, balance: toNum(b.balance), openingBalance: toNum(b.openingBalance) });

export const bankAccountsService = {
  async list() {
    const rows = await bankAccountsRepository.list();
    return rows.map(toView);
  },

  async getById(id: number) {
    const [row] = await bankAccountsRepository.findById(id);
    if (!row) throw new NotFoundError("Not found");
    return toView(row);
  },

  async create(data: Record<string, unknown>) {
    const values = {
      ...data,
      balance: String(data.balance ?? data.openingBalance ?? 0),
      openingBalance: String(data.openingBalance ?? 0),
    } as typeof bankAccountsTable.$inferInsert;
    const [row] = await bankAccountsRepository.insert(values);
    await auditService.created("bank_account", row.id, row);
    return toView(row);
  },

  async update(id: number, data: Record<string, unknown>) {
    const [before] = await bankAccountsRepository.findById(id);
    if (!before) throw new NotFoundError("Not found");
    const updates = { ...data } as Record<string, unknown>;
    if (updates.balance != null) updates.balance = String(updates.balance);
    const [row] = await bankAccountsRepository.update(id, updates as Partial<typeof bankAccountsTable.$inferInsert>);
    await auditService.updated("bank_account", id, before, row);
    return toView(row);
  },

  async remove(id: number) {
    const [before] = await bankAccountsRepository.findById(id);
    await bankAccountsRepository.remove(id);
    if (before) await auditService.deleted("bank_account", id, before);
  },
};
