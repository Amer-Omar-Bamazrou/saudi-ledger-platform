/** Bank accounts service — numeric (de)serialization. Behavior preserved from pre-M6. */
import { NotFoundError } from "../lib/errors";
import { pick, assertAmount, NUMERIC_15_2_MAX as MAX } from "../lib/writeGuards";

/** H1 allowlist — user-settable bank-account fields. */
const BANK_FIELDS = [
  "name", "bankName", "accountNumber", "iban", "currency", "balance",
  "openingBalance", "isDefault", "isActive", "notes",
] as const;
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
    // 🔴 H1/H2 — ALLOWLIST + validate. `String(data.balance)` on a non-number
    // used to produce "[object Object]" → raw 500. A bank balance may be
    // negative (overdraft), so `balance` is finite-any; `openingBalance` ≥ 0.
    const picked = pick<Record<string, unknown>>(data, BANK_FIELDS);
    const balance = assertAmount(data.balance ?? data.openingBalance ?? 0, "balance", { min: -MAX });
    const openingBalance = assertAmount(data.openingBalance ?? 0, "openingBalance", { min: 0, allowZero: true });
    const values = { ...picked, balance: balance.toFixed(2), openingBalance: openingBalance.toFixed(2) } as typeof bankAccountsTable.$inferInsert;
    const [row] = await bankAccountsRepository.insert(values);
    await auditService.created("bank_account", row.id, row);
    return toView(row);
  },

  async update(id: number, data: Record<string, unknown>) {
    const [before] = await bankAccountsRepository.findById(id);
    if (!before) throw new NotFoundError("Not found");
    const updates = pick<Record<string, unknown>>(data, BANK_FIELDS);
    if (updates.balance != null) updates.balance = assertAmount(updates.balance, "balance", { min: -MAX }).toFixed(2);
    if (updates.openingBalance != null) updates.openingBalance = assertAmount(updates.openingBalance, "openingBalance", { min: 0, allowZero: true }).toFixed(2);
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
