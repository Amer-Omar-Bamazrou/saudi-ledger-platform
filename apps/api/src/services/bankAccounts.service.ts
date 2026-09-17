/**
 * Bank accounts service — numeric (de)serialization. Behavior preserved from pre-M6.
 *
 * D-3 (2026-09-16): every bank account has its own GL cash account, created
 * by the DB trigger `ensure_bank_gl_account` on INSERT (never by this
 * service — the relationship is a property of the row, not of the writer).
 * This service READS it back (`glAccountId`, `glAccountName`,
 * `ledgerBalance`) and guards the one destructive act: a bank account whose
 * GL account carries ledger history cannot be deleted — deactivate it.
 */
import { ConflictError, NotFoundError } from "../lib/errors";
import { pick, assertAmount, assertSupportedCurrency, NUMERIC_15_2_MAX as MAX } from "../lib/writeGuards";

/** H1 allowlist — user-settable bank-account fields. */
const BANK_FIELDS = [
  "name", "bankName", "accountNumber", "iban", "currency", "balance",
  "openingBalance", "isDefault", "isActive", "notes",
] as const;
import { auditService } from "./audit.service";
import { bankAccountsRepository } from "../repositories/bankAccounts.repository";
import type { bankAccountsTable } from "@workspace/db";

type BankAccount = typeof bankAccountsTable.$inferSelect;
type GlSide = { glAccountId: number; glAccountName: string; ledgerBalance: string; ledgerBalanceOnLeaf: string; attributedHistory: string };
const toNum = (v: unknown) => (v != null ? Number(v) : 0);
const toView = (b: BankAccount, gl?: GlSide) => ({
  ...b,
  balance: toNum(b.balance),
  openingBalance: toNum(b.openingBalance),
  // D-3: the GL side. Null only if the leaf is missing, which the trigger
  // and migration 0073 make impossible — surfaced rather than hidden.
  glAccountId: gl?.glAccountId ?? null,
  glAccountName: gl?.glAccountName ?? null,
  ledgerBalance: gl ? toNum(gl.ledgerBalance) : null,
  // The split behind `ledgerBalance` (annotation model): what sits on the
  // bank's own account vs. pre-per-bank history attributed to it.
  ledgerBalanceOnLeaf: gl ? toNum(gl.ledgerBalanceOnLeaf) : null,
  attributedHistory: gl ? toNum(gl.attributedHistory) : null,
});

async function withGl(rows: BankAccount[]) {
  const gl = await bankAccountsRepository.glSummary(rows.map((r) => r.id));
  return rows.map((r) => toView(r, gl.get(r.id)));
}

export const bankAccountsService = {
  async list() {
    return withGl(await bankAccountsRepository.list());
  },

  async getById(id: number) {
    const [row] = await bankAccountsRepository.findById(id);
    if (!row) throw new NotFoundError("Not found");
    return (await withGl([row]))[0];
  },

  async create(data: Record<string, unknown>) {
    // 🔴 H1/H2 — ALLOWLIST + validate. `String(data.balance)` on a non-number
    // used to produce "[object Object]" → raw 500. A bank balance may be
    // negative (overdraft), so `balance` is finite-any; `openingBalance` ≥ 0.
    const picked = pick<Record<string, unknown>>(data, BANK_FIELDS);
    assertSupportedCurrency(picked.currency);
    const balance = assertAmount(data.balance ?? data.openingBalance ?? 0, "balance", { min: -MAX });
    const openingBalance = assertAmount(data.openingBalance ?? 0, "openingBalance", { min: 0, allowZero: true });
    const values = { ...picked, balance: balance.toFixed(2), openingBalance: openingBalance.toFixed(2) } as typeof bankAccountsTable.$inferInsert;
    // 🔴 ONE DEFAULT (2026-09-15, workflow audit, coming-soon "bank-account-detail").
    // The invoice PDF prints bank details for the account flagged default and
    // nothing in the product could set that flag except the demo seed, so real
    // tenants issued invoices with no bank details. Exclusivity is enforced
    // HERE, at the write: a create or update that sets the flag clears it on
    // the tenant's other accounts first, in the same transaction.
    if (values.isDefault === true) await bankAccountsRepository.clearDefaultsExcept(null);
    const [row] = await bankAccountsRepository.insert(values);
    // D-3: the trigger created the GL leaf in the same statement. Read it
    // back and FAIL LOUDLY if it is not there — a bank account that cannot
    // receive postings must not be returned as created (the tenant
    // transaction rolls the insert back with the throw).
    const [view] = await withGl([row]);
    if (view.glAccountId == null) {
      throw new Error(`Bank account ${row.id} was created without its GL cash account — the ensure_bank_gl_account trigger did not fire. Nothing was saved.`);
    }
    await auditService.created("bank_account", row.id, { ...row, glAccountId: view.glAccountId });
    return view;
  },

  async update(id: number, data: Record<string, unknown>) {
    const [before] = await bankAccountsRepository.findById(id);
    if (!before) throw new NotFoundError("Not found");
    const updates = pick<Record<string, unknown>>(data, BANK_FIELDS);
    assertSupportedCurrency(updates.currency);
    if (updates.balance != null) updates.balance = assertAmount(updates.balance, "balance", { min: -MAX }).toFixed(2);
    if (updates.openingBalance != null) updates.openingBalance = assertAmount(updates.openingBalance, "openingBalance", { min: 0, allowZero: true }).toFixed(2);
    if (updates.isDefault === true) await bankAccountsRepository.clearDefaultsExcept(id);
    const [row] = await bankAccountsRepository.update(id, updates as Partial<typeof bankAccountsTable.$inferInsert>);
    await auditService.updated("bank_account", id, before, row);
    return (await withGl([row]))[0];
  },

  async remove(id: number) {
    const [before] = await bankAccountsRepository.findById(id);
    if (!before) throw new NotFoundError("Not found");
    // 🔴 D-3: a bank account whose GL account carries ledger lines is HISTORY.
    // Deleting it would orphan or (via the leaf's cascade) refuse at the
    // lines FK anyway — so the answer is a readable 409, and the tenant
    // deactivates the account instead. A bank with no postings deletes
    // cleanly: the leaf goes with it (FK cascade; the protection trigger
    // allows exactly that case).
    const lines = await bankAccountsRepository.ledgerLineCount(id);
    if (lines > 0) {
      throw new ConflictError(
        `This bank account's GL cash account carries ${lines} ledger line(s). A bank account with posting history cannot be deleted — mark it inactive instead.`,
      );
    }
    await bankAccountsRepository.remove(id);
    await auditService.deleted("bank_account", id, before);
  },
};
