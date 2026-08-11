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
import { journalEntriesTable, journalEntryLinesTable, categoriesTable } from "@workspace/db";
import type { SystemAccountCode } from "@workspace/db";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { checkPeriodOpen } from "./periodLock";

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
export type GLLine = {
  accountName: string;
  description?: string;
  debitAmount: number;
  creditAmount: number;
} & ({ systemCode: SystemAccountCode; accountId?: never } | { accountId: number; systemCode?: never });

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
    .select({ id: categoriesTable.id, code: categoriesTable.systemCode })
    .from(categoriesTable)
    .where(and(isNotNull(categoriesTable.systemCode), inArray(categoriesTable.systemCode, unique)));

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
}): Promise<typeof journalEntriesTable.$inferSelect> {
  const totalDebit = opts.lines.reduce((s, l) => s + l.debitAmount, 0);
  const totalCredit = opts.lines.reduce((s, l) => s + l.creditAmount, 0);
  if (Math.abs(totalDebit - totalCredit) > 0.005) {
    throw new Error(
      `GL entry does not balance: Dr ${totalDebit.toFixed(2)} vs Cr ${totalCredit.toFixed(2)}`
    );
  }

  // Resolve BEFORE writing anything, so an incomplete chart cannot leave a
  // half-posted entry behind.
  const accounts = await resolveAccounts(
    opts.lines.map((l) => l.systemCode).filter((c): c is SystemAccountCode => !!c),
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
    })
    .returning();

  await db.insert(journalEntryLinesTable).values(
    opts.lines.map((l) => ({
      journalEntryId: je.id,
      accountName: l.accountName,
      // One of the two is always present — the GLLine union makes "neither" a
      // type error, and `resolveAccounts` has already refused an unresolvable
      // code. So this can never write a NULL.
      accountId: l.systemCode ? accounts.get(l.systemCode)! : l.accountId!,
      description: l.description ?? null,
      debitAmount: String(l.debitAmount.toFixed(2)),
      creditAmount: String(l.creditAmount.toFixed(2)),
    }))
  );

  return je;
}
