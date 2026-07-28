/** Bank accounts service — numeric (de)serialization. Behavior preserved from pre-M6. */
import { NotFoundError } from "../lib/errors";
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
    return toView(row);
  },

  async update(id: number, data: Record<string, unknown>) {
    const updates = { ...data } as Record<string, unknown>;
    if (updates.balance != null) updates.balance = String(updates.balance);
    const [row] = await bankAccountsRepository.update(id, updates as Partial<typeof bankAccountsTable.$inferInsert>);
    if (!row) throw new NotFoundError("Not found");
    return toView(row);
  },

  async remove(id: number) {
    await bankAccountsRepository.remove(id);
  },
};
