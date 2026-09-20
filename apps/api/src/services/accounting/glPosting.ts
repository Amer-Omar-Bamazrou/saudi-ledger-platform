/**
 * GL Posting helper — creates a balanced, immediately-posted journal entry.
 * Called by invoices, bills and payroll to keep AR/AP wired to the GL.
 *
 * ── M13: every line MUST resolve to a real account ──────────────────────────
 * This function used to write `accountId: l.accountId ?? null`, and no automated
 * caller ever supplied one. The income statement classifies with
 * `cat?.type ?? "expense"`, so every invoice's Sales Revenue CREDIT was filed as
 * a NEGATIVE EXPENSE: revenue read as zero, expenses were understated by the
 * same amount, and net profit came out right — which is exactly why it survived.
 *
 * Callers now name a **system code** (`SALES`, `AR`, `VAT_OUTPUT`, …), never an
 * account name. Names are labels a tenant may rename or translate; codes are
 * identity. See `packages/db/src/chartOfAccounts.ts`.
 */
import { db } from "@workspace/db";
import { round2 } from "../../lib/money";
import { journalEntriesTable, journalEntryLinesTable, categoriesTable, bankAccountsTable } from "@workspace/db";
import type { SystemAccountCode } from "@workspace/db";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { checkPeriodOpen } from "./periodLock";
import { PARTY_REQUIRED_SYSTEM_CODES } from "@workspace/shared";
import { BusinessRuleError } from "../../lib/errors";

/**
 * One posting line. It MUST identify its account in exactly one of two ways.
 *
 * `systemCode` — for accounts OUR code names (`SALES`, `AR`, `VAT_OUTPUT`, …).
 *   Resolved through the system chart. Never resolve these by name: the names
 *   are English literals in our source that a tenant may rename or translate,
 *   and a rename silently breaking classification is the bug M13 removes.
 *
 * `accountId` — for an account the USER chose (a manual journal entry line, or
 *   a bill's expense account). Already a real `categories.id`; nothing to
 *   resolve. Name-based lookup is legitimate at the point the user names their
 *   OWN account — that is a different thing from resolving our literals.
 *
 * `accountName` is written alongside either for display and for the existing
 * report paths, but it is NO LONGER the identity of the account.
 */
/**
 * 🔴 N3 (2026-09-03): the PARTY on a control-account line. A receivable is a
 * receivable FROM someone; a payable is a payable TO someone. ERPNext enforces
 * this at the GL row ("Customer is required against Receivable account") and
 * it is the reason their aging IS the ledger while ours was a parallel
 * computation that structurally could not agree with it.
 */
export type GLParty =
  | { type: "customer"; customerId: number }
  | { type: "vendor"; vendorId: number }
  /**
   * 🔴 "No party" is a STATEMENT, not an omission. A simplified (B2C) ZATCA
   * invoice legitimately has no identified customer — so the ERPNext rule
   * ("Customer is required against Receivable") cannot be unconditional here.
   * What CAN be unconditional: the caller must say so. `reason` is recorded
   * nowhere (the columns stay NULL) — it exists to make the call site
   * self-explaining and the thoughtless omission inexpressible.
   */
  | { type: "none"; reason: string };

/**
 * 🔴 D-3 (2026-09-16): the THIRD way a line names its account — by BANK.
 *
 * `bankAccountId` — a cash line. Resolved to the bank's own GL leaf through
 *   `categories.bank_account_id` (created by construction for every bank
 *   account; see migration 0073). Never by name, never by `CASH`: "Cash and
 *   Bank" is a non-posting header now, and a cash line that cannot name its
 *   bank is refused — there is no default account to fall back to.
 */
export type GLLine = {
  description?: string;
  debitAmount: number;
  creditAmount: number;
  /** Required on systemCode AR/AP lines — enforced below. */
  party?: GLParty;
} & (
  | { systemCode: SystemAccountCode; accountName: string; accountId?: never; bankAccountId?: never }
  | { accountId: number; accountName: string; systemCode?: never; bankAccountId?: never }
  /** A bank line takes the leaf's own name — the caller does not label it. */
  | { bankAccountId: number; accountName?: never; systemCode?: never; accountId?: never }
);

/**
 * 🔴 A control-account line without a party is refused — BOTH arms since
 * 2026-09-14: the system-code path (every document posting path) and the
 * accountId path (an account named by id), now that the manual-JE form has
 * its party picker and its own readable 422 at journalEntries.service. The
 * named gap in §5's traps closed with it.
 */
const PARTY_REQUIRED: ReadonlySet<string> = new Set(PARTY_REQUIRED_SYSTEM_CODES);

export class MissingPartyError extends Error {
  readonly statusCode = 500; // an internal caller built the line wrong — our bug, not the user's
  constructor(systemCode: string, accountName: string) {
    super(
      `GL line on ${systemCode} (${accountName}) carries no party. A receivable/payable line must name ` +
        `its customer/vendor — pass \`party\` on the GLLine. Nothing was posted.`,
    );
    this.name = "MissingPartyError";
  }
}

/**
 * The one tolerance for "these debits and credits are the same money".
 *
 * 🔴 EXPORTED, and imported by every other writer that gates on balance, because
 * this invariant had TWO numbers: `journalEntries.service` refused a manual
 * entry at `> 0.01` while this file refuses at `> 0.005`. Nothing crossed the
 * two today — a manual entry posts through its own approvable and never reaches
 * `postJournalEntry` — so the gap was latent rather than live (checked, not
 * assumed). But it is the two-id-spaces shape: one invariant, two constants, no
 * forcing function, and the outer gate LOOSER than the inner one, so the day a
 * JE-creating path did call `postJournalEntry`, an imbalance in (0.005, 0.01]
 * would pass the user-facing 400 and die as an opaque 500 on approval.
 *
 * Half a halala: anything larger rounds to a different smallest unit of money.
 */
export const GL_BALANCE_TOLERANCE = 0.005;

/**
 * Thrown when a set of lines does not balance.
 *
 * 🔴 TYPED, and the reason is the audit that found it: this was a bare `Error`
 * — the only untyped throw in the accounting core — guarding the single most
 * important invariant in the system. The central error handler duck-types on
 * `statusCode`, so a bare Error becomes the generic 500 wall and the two totals
 * survive only in the log. Its neighbours in this very function were already
 * typed (`AccountResolutionError` carries its diagnosis at 500; `PeriodLockedError`
 * is structured at 423), which is what made the odd one out visible.
 *
 * 500 and not 4xx, deliberately: every caller builds these lines itself, and
 * user-supplied lines are balance-checked at their own write boundary before
 * they ever reach here. Arriving here means OUR arithmetic is wrong, which is a
 * server fault — so the status stays 500 and what changes is that the response
 * SAYS what did not balance instead of "Internal server error".
 */
export class UnbalancedEntryError extends Error {
  readonly statusCode = 500;
  constructor(
    readonly totalDebit: number,
    readonly totalCredit: number,
  ) {
    super(
      `GL entry does not balance: Dr ${totalDebit.toFixed(2)} vs Cr ${totalCredit.toFixed(2)} ` +
        `(difference ${Math.abs(totalDebit - totalCredit).toFixed(4)}, tolerance ${GL_BALANCE_TOLERANCE}). ` +
        "Nothing was posted.",
    );
    this.name = "UnbalancedEntryError";
  }
}

/** Thrown when a posting names an account the tenant's chart does not contain. */
export class AccountResolutionError extends Error {
  readonly statusCode = 500;
  constructor(public readonly missing: string[]) {
    super(
      `Chart of accounts is incomplete: no account for ${missing.join(", ")}. ` +
        "The system chart of accounts is seeded for every organization, so this means it was " +
        "removed or never seeded. Re-run the database seed for this organization.",
    );
    this.name = "AccountResolutionError";
  }
}

/**
 * Thrown when a cash line names a bank account that has no GL leaf in the
 * tenant's chart. Unreachable in normal operation — the leaf is created by
 * the DB trigger on every bank-account INSERT and backfilled by 0073 — so
 * reaching it means the bank id belongs to another tenant (RLS hides it) or
 * the chart was tampered with. 500: an internal invariant, not user input.
 * Callers validate the bank id at their own write boundary (422) first.
 */
export class BankAccountUnresolvedError extends Error {
  readonly statusCode = 500;
  constructor(public readonly bankAccountIds: number[]) {
    super(
      `No GL account exists for bank account(s) ${bankAccountIds.join(", ")} in this organization. ` +
        "Every bank account gets one by construction (migration 0073); this bank either belongs to another " +
        "organization or its chart entry was removed. Nothing was posted.",
    );
    this.name = "BankAccountUnresolvedError";
  }
}

/**
 * 🔴 D-3: a NON-POSTING account (a header — `CASH` today) accepts no line.
 * 422 rather than 500 because one arm IS user-reachable: a bill's expense
 * account or a manual-JE line can name any account by id. The DB trigger
 * `refuse_non_posting_account_line` is the boundary beneath this one.
 */
export class NonPostingAccountError extends BusinessRuleError {
  constructor(accountName: string) {
    super(422, {
      error:
        `${accountName} is a header account and accepts no postings. A cash line names a bank account ` +
        "and posts to that bank's own GL account.",
      code: "account_not_posting",
      field: "accountId",
    });
  }
}

/**
 * Resolve bank accounts → their GL leaves for the ACTIVE tenant (RLS-scoped,
 * like `resolveAccounts`). Fails closed on any bank with no leaf.
 */
async function resolveBankLeaves(bankAccountIds: number[]): Promise<Map<number, { id: number; name: string }>> {
  const unique = [...new Set(bankAccountIds)];
  if (unique.length === 0) return new Map();
  // The INNER JOIN on bank_accounts is the company boundary: the chart is
  // per organization, but a bank account belongs to ONE company, and RLS
  // (N1's company arm) hides another company's bank rows from this request
  // — so a leaf whose bank this company cannot see resolves to nothing and
  // the posting is refused. A cross-company cash posting is inexpressible.
  const rows = await db
    .select({ id: categoriesTable.id, name: categoriesTable.name, bankAccountId: categoriesTable.bankAccountId })
    .from(categoriesTable)
    .innerJoin(bankAccountsTable, eq(bankAccountsTable.id, categoriesTable.bankAccountId))
    .where(and(isNotNull(categoriesTable.bankAccountId), inArray(categoriesTable.bankAccountId, unique)));
  const map = new Map(rows.map((r) => [r.bankAccountId as number, { id: r.id, name: r.name }]));
  const missing = unique.filter((b) => !map.has(b));
  if (missing.length > 0) throw new BankAccountUnresolvedError(missing);
  return map;
}

/**
 * Resolve system codes → `categories.id` for the ACTIVE tenant.
 *
 * No organization filter is written here on purpose: this runs inside the
 * request's tenant transaction, so RLS already confines `categories` to the
 * active organization. Adding an explicit filter would need an org id this
 * function does not take, and RLS is the mechanism everywhere else in the
 * business layer.
 */
async function resolveAccounts(codes: SystemAccountCode[]): Promise<Map<string, number>> {
  const unique = [...new Set(codes)];
  if (unique.length === 0) return new Map();

  const rows = await db
    .select({ id: categoriesTable.id, code: categoriesTable.systemCode, name: categoriesTable.name, isPosting: categoriesTable.isPosting })
    .from(categoriesTable)
    .where(and(isNotNull(categoriesTable.systemCode), inArray(categoriesTable.systemCode, unique)));

  // 🔴 D-3: a system code that names a HEADER (`CASH`) is refused here, so
  // the old `{ systemCode: "CASH" }` line is inexpressible for every caller
  // — the type still admits the code, the seam does not.
  const header = rows.find((r) => r.isPosting === false);
  if (header) throw new NonPostingAccountError(header.name);

  const map = new Map(rows.filter((r) => r.code).map((r) => [r.code as string, r.id]));

  // 🔴 FAIL CLOSED. A NULL account_id does not fail — it silently misfiles the
  // line, on the primary financial statement, undetected. That is precisely the
  // defect M13 removes, so we refuse to write one.
  //
  // This costs nothing in normal operation: the chart is seeded for every
  // organization (including every pre-M13 one, back-filled by migration 0024)
  // and system accounts cannot be deleted. It is reachable only if that seeding
  // failed — which is exactly the case we could not otherwise see.
  const missing = unique.filter((c) => !map.has(c));
  if (missing.length > 0) throw new AccountResolutionError(missing);

  return map;
}

export async function postJournalEntry(opts: {
  entryNumber: string;
  date: string;
  description: string;
  reference?: string;
  lines: GLLine[];
  /**
   * Batch 1C: provenance readers key on. `opening` / `opening_reversal` are
   * written ONLY by the migration service. Omitted (NULL) for every ordinary
   * entry — their provenance stays the number prefix, as before. (There is
   * no `opening_clearing`: the OBE mechanism was removed — A5, 2026-09-20.)
   */
  source?: "opening" | "opening_reversal";
  migrationBatchId?: number;
  /**
   * Batch 1C: the entry this one mirrors. Only the migration's reversal names
   * it (`source = 'opening_reversal'`), so the reversal of an opening journal
   * carries the same `reversal_of` marker every other reversal carries and
   * every reader keys on. Refused without a migration source.
   */
  reversalOf?: number;
}): Promise<typeof journalEntriesTable.$inferSelect> {
  if (opts.reversalOf != null && opts.source !== "opening_reversal") {
    throw new BusinessRuleError(422, { error: "reversalOf is only written by the migration's reversal.", code: "reversal_of_refused", field: "reversalOf" });
  }
  /**
   * 🔴 N2 (2026-09-03): the balance check runs on the ROUNDED lines — the
   * values that will actually persist — not on the raw floats. The old order
   * (check unrounded, then round each line independently at the INSERT) meant
   * the check and the stored rows were computed from different numbers: an
   * entry admitted at a 0.004 residual could persist as rows whose stored sum
   * differed from what was checked, and a caller whose header drifted a
   * halala from its rounded lines (payroll, for 10.3% of salary values —
   * measured) threw here as a 500. ERPNext's `process_debit_credit_difference`
   * does the same thing in the same order, for the same reason.
   *
   * After `round2`, both totals are exact 2-decimal values, so any REAL
   * imbalance is ≥ 0.01 and throws; the tolerance now absorbs only the float
   * dust of summing 2dp doubles, which is what it was always meant to absorb.
   * There is deliberately NO round-off account (owner option, 2026-09-03):
   * every writer is our own service and each is required to make
   * header = Σ rounded lines by construction, so a residual here is our
   * arithmetic bug — the loud throw IS the correct behaviour, and the error
   * names both totals.
   */
  const lines = opts.lines.map((l) => ({
    ...l,
    debitAmount: round2(l.debitAmount),
    creditAmount: round2(l.creditAmount),
  }));
  for (const l of lines) {
    if (l.systemCode && PARTY_REQUIRED.has(l.systemCode) && l.party === undefined) {
      throw new MissingPartyError(l.systemCode, l.accountName ?? "");
    }
  }
  const totalDebit = round2(lines.reduce((s, l) => s + l.debitAmount, 0));
  const totalCredit = round2(lines.reduce((s, l) => s + l.creditAmount, 0));
  if (Math.abs(totalDebit - totalCredit) > GL_BALANCE_TOLERANCE) {
    throw new UnbalancedEntryError(totalDebit, totalCredit);
  }

  // 🔴 N3's remaining half (closed 2026-09-14): the accountId arm is gated
  // too. A caller naming the AR/AP account BY ID was the one way to reach a
  // control account party-less — the manual-JE form now has its picker (and
  // its own 422 at journalEntries.service), so the ERPNext-grade rule can be
  // unconditional here: one lookup, every path, no override. Placed AFTER
  // the pure checks: this is the function's first DB read, and the balance
  // guard must fire before any query does (its own test proves it without a
  // database).
  // The accountId arm is looked up once for two rules: the party rule (N3)
  // and, since D-3, the non-posting rule — a header named by id is refused
  // the same way a header named by code is.
  const idLines = lines.filter((l) => l.accountId != null);
  if (idLines.length > 0) {
    const rows = await db
      .select({ id: categoriesTable.id, code: categoriesTable.systemCode, name: categoriesTable.name, isPosting: categoriesTable.isPosting })
      .from(categoriesTable)
      .where(inArray(categoriesTable.id, [...new Set(idLines.map((l) => l.accountId!))]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const l of idLines) {
      const row = byId.get(l.accountId!);
      if (row && row.isPosting === false) throw new NonPostingAccountError(row.name);
      if (row?.code && PARTY_REQUIRED.has(row.code) && l.party === undefined) throw new MissingPartyError(row.code, l.accountName ?? "");
    }
  }

  // Resolve BEFORE writing anything, so an incomplete chart cannot leave a
  // half-posted entry behind.
  const accounts = await resolveAccounts(lines.map((l) => l.systemCode).filter((c): c is SystemAccountCode => !!c));
  // D-3: every cash line names a bank; the bank's leaf is the account.
  const bankLeaves = await resolveBankLeaves(
    lines.map((l) => l.bankAccountId).filter((b): b is number => b != null),
  );

  // Enforce period lock — block posting into closed periods
  await checkPeriodOpen(opts.date);

  const now = new Date();
  const [je] = await db
    .insert(journalEntriesTable)
    .values({
      entryNumber: opts.entryNumber,
      date: opts.date,
      description: opts.description,
      reference: opts.reference ?? null,
      status: "posted",
      postedAt: now,
      source: opts.source ?? null,
      migrationBatchId: opts.migrationBatchId ?? null,
      reversalOf: opts.reversalOf ?? null,
    })
    .returning();

  await db.insert(journalEntryLinesTable).values(
    lines.map((l) => ({
      journalEntryId: je.id,
      // A bank line carries the LEAF's current name, so the denormalised
      // history label matches the account the line actually sits on.
      accountName: l.bankAccountId != null ? bankLeaves.get(l.bankAccountId)!.name : l.accountName!,
      // One of the three is always present — the GLLine union makes "none" a
      // type error, and the resolvers have already refused anything
      // unresolvable. So this can never write a NULL.
      accountId: l.systemCode
        ? accounts.get(l.systemCode)!
        : l.bankAccountId != null
          ? bankLeaves.get(l.bankAccountId)!.id
          : l.accountId!,
      description: l.description ?? null,
      // `l` is already round2'd above, so this stores EXACTLY what the
      // balance check saw — money2 would re-round to the same value; toFixed
      // on the rounded number is equivalent and kept for the narrow diff.
      debitAmount: l.debitAmount.toFixed(2),
      creditAmount: l.creditAmount.toFixed(2),
      partyType: l.party && l.party.type !== "none" ? l.party.type : null,
      customerId: l.party?.type === "customer" ? l.party.customerId : null,
      vendorId: l.party?.type === "vendor" ? l.party.vendorId : null,
    }))
  );

  return je;
}
