/**
 * 🔴 Phase 18 R-6 — DR-23's dual control (register §11.98, §11.99): the
 * DECISION on a held bank-detail change.
 *
 *  - approve: an admin of this organisation who is not the requester (the
 *    route is admin-only by the seeded matrix; the database refuses the
 *    requester and a non-admin again, 0151). The stored value must still be
 *    the request's `ibanBefore` (otherwise 409 stale — the request no longer
 *    describes the change it would make). The request is marked approved and
 *    the change applied IN THE SAME TRANSACTION, through the owning service's
 *    write and its audit record — which is what the database checks for.
 *  - reject: marks it rejected (an admin, or the requester withdrawing it);
 *    nothing else changes.
 *  - a decision is final (409).
 */
import { auditContext } from "../lib/auditContext";
import { BadRequestError, BusinessRuleError, NotFoundError } from "../lib/errors";
import { bankDetailChangesRepository as repo, type BankDetailChangeRow } from "../repositories/bankDetailChanges.repository";
import { vendorsRepository } from "../repositories/vendors.repository";
import { bankAccountsRepository } from "../repositories/bankAccounts.repository";
import { auditService } from "./audit.service";
import { BANK_DETAIL_REFUSALS } from "../lib/dbRefusals";
import { toOut, type BankDetailChangeOut } from "./bankDetailChanges.service";
import { vendorsService } from "./vendors.service";
import { bankAccountsService } from "./bankAccounts.service";

const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? null) === (b ?? null);

/** Does the request still describe the change it would make? */
async function isStale(r: BankDetailChangeRow): Promise<boolean> {
  if (r.kind === "vendor_iban") {
    const [v] = await vendorsRepository.findById(r.vendorId!);
    return !v || !same(v.iban, r.ibanBefore);
  }
  const [account] = await bankAccountsRepository.findById(r.bankAccountId!);
  if (!account) return true;
  if (r.kind === "bank_account_iban") return !same(account.iban, r.ibanBefore);
  // default_bank_account: the printed IBAN is still the 'before', the account still carries the 'after', and it is not yet the default.
  const current = await repo.currentDefaultAccount();
  return account.isDefault || !same(current?.iban, r.ibanBefore) || !same(account.iban, r.ibanAfter);
}

async function apply(r: BankDetailChangeRow): Promise<void> {
  if (r.kind === "vendor_iban") return vendorsService.applyApprovedIban(r.vendorId!, r.ibanAfter);
  if (r.kind === "bank_account_iban") return bankAccountsService.applyApprovedIban(r.bankAccountId!, r.ibanAfter);
  return bankAccountsService.applyApprovedDefault(r.bankAccountId!);
}

export const bankDetailChangeDecisionsService = {
  async decide(id: number, decision: unknown): Promise<BankDetailChangeOut> {
    if (decision !== "approve" && decision !== "reject") throw new BadRequestError("decision must be approve or reject.");
    const userId = auditContext.get()?.userId;
    if (userId == null) throw new Error("a bank-detail change is decided inside a signed-in request");
    const [r] = await repo.findById(id);
    if (!r) throw new NotFoundError("No such bank-detail change in this company.");
    if (r.status !== "pending") throw new BusinessRuleError(409, { ...BANK_DETAIL_REFUSALS.decided, status: r.status });
    if (decision === "approve") {
      if (r.requestedBy === userId) throw new BusinessRuleError(409, { ...BANK_DETAIL_REFUSALS.secondAdmin });
      if (await isStale(r)) throw new BusinessRuleError(409, { ...BANK_DETAIL_REFUSALS.stale });
    }
    const [decided] = await repo.decide(id, decision === "approve" ? "approved" : "rejected", userId);
    if (!decided) throw new BusinessRuleError(409, { ...BANK_DETAIL_REFUSALS.decided });
    if (decision === "approve") await apply(r);
    const [after] = await repo.findById(id);
    await auditService.updated("bank_detail_change_request", id, { status: r.status }, { status: after!.status, decidedBy: after!.decidedBy });
    return (await toOut([after!]))[0]!;
  },
};
