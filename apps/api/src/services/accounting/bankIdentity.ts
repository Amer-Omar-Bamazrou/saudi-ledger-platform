/**
 * D-3 / G3 (2026-09-16) — THE BANK IDENTITY OF A CASH EFFECT, checked once.
 *
 * Every path that posts cash — a payment recorded on an invoice or bill, a
 * bank row's acceptance, a settlement from review, a statement import, a
 * manual row — must name the bank account the money moved through, because
 * that bank's own GL account is where the cash line posts. "Cash and Bank"
 * is a header now and accepts nothing.
 *
 * This is the write-boundary check those paths share, so the rule has ONE
 * definition (CLAUDE.md §3: two definitions of one fact diverge):
 *
 *   missing  → 422 `bank_account_required` — the caller must say which bank;
 *              there is no default and nothing is inferred (the accountant
 *              rejected "the company has one account" as evidence, and a
 *              default flag is a presentation setting, not a fact about a
 *              movement);
 *   unknown  → 422 `reference_not_found` — RLS scopes the lookup, so another
 *              tenant's id and a non-existent id are the same refusal.
 *
 * Returns the validated id so callers can carry it into the posting line and
 * the payment record.
 */
import { BusinessRuleError, BankAccountRequiredError } from "../../lib/errors";
import { bankAccountsRepository } from "../../repositories/bankAccounts.repository";

export async function assertBankAccount(
  bankAccountId: unknown,
  opts: { field?: string; what: string },
): Promise<number> {
  const field = opts.field ?? "bankAccountId";
  if (bankAccountId == null || bankAccountId === "") {
    throw new BankAccountRequiredError(
      `Name the bank account ${opts.what}. Cash posts to that bank's own GL account; there is no shared cash account to fall back to.`,
      field,
    );
  }
  const id = Number(bankAccountId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new BusinessRuleError(422, { error: "bankAccountId must be a positive integer", code: "invalid_reference", field });
  }
  const [account] = await bankAccountsRepository.findById(id);
  if (!account) {
    throw new BusinessRuleError(422, { error: "Unknown bank account for this organization", code: "reference_not_found", field });
  }
  // The minimum the contract needs: an INACTIVE account cannot carry NEW
  // cash. Its history, its leaf and its attributions stay exactly as they are.
  if (!account.isActive) {
    throw new BusinessRuleError(422, { error: `Bank account "${account.name}" is inactive and cannot carry a new movement. Reactivate it or choose another account.`, code: "bank_account_inactive", field });
  }
  return id;
}
