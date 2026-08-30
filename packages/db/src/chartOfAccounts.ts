// `ownerDb` is the SEEDING path (deliberately cross-tenant, per CLAUDE.md §4);
// `db` stays tenant-scoped for the runtime read in loadSystemAccounts().
import { db, ownerDb } from "./index";
import { categoriesTable } from "./schema";
import { and, eq, isNotNull, sql } from "drizzle-orm";

/**
 * The MINIMAL system chart of accounts (M13) — the source of truth for the
 * accounts the posting path resolves against.
 *
 * ── Why this file has to exist ──────────────────────────────────────────────
 * Before M13, `categories` contained **zero rows in a live database and nothing
 * ever created any** — not the seed, not signup, not org creation. Every
 * category was hand-typed by a user. Meanwhile the income statement classified
 * GL lines with `cat?.type ?? "expense"`, so every invoice's Sales Revenue
 * CREDIT was filed as a negative expense. The bug survived because there was
 * never anything to resolve against: the consumer existed, the producer did not.
 *
 * ── `system_code` is the identity; the NAME is only a label ─────────────────
 * Postings name a CODE, never a name. The names below are English literals that
 * a tenant may rename or translate at will (and Arabic names are already
 * first-class here). Resolving by name would mean a rename silently breaks
 * classification — the exact bug class M13 exists to remove.
 *
 * ── Deliberately MINIMAL ────────────────────────────────────────────────────
 * This is the set the automated posting path actually touches, plus a couple of
 * ordinary expense accounts so a fresh tenant is not staring at an empty
 * Categories page. A full Saudi chart of accounts (SOCPA conventions, Zakat
 * categorisation) is **a product feature needing its own research** and is a
 * separate candidate milestone — not part of fixing a posting path.
 */

/** Stable identities referenced by the posting path. Never rename these. */
export const SYSTEM_ACCOUNTS = {
  AR: "AR",
  AP: "AP",
  SALES: "SALES",
  VAT_OUTPUT: "VAT_OUTPUT",
  VAT_INPUT: "VAT_INPUT",
  PURCHASES: "PURCHASES",
  CASH: "CASH",
  SUSPENSE: "SUSPENSE",
  TRANSFER_CLEARING: "TRANSFER_CLEARING",
  TRANSFER_SUSPENSE: "TRANSFER_SUSPENSE",
  EXTERNAL_TRANSFERS: "EXTERNAL_TRANSFERS",
  SALARIES: "SALARIES",
  SALARIES_PAYABLE: "SALARIES_PAYABLE",
  GOSI_EXPENSE: "GOSI_EXPENSE",
  GOSI_PAYABLE: "GOSI_PAYABLE",
} as const;

export type SystemAccountCode = (typeof SYSTEM_ACCOUNTS)[keyof typeof SYSTEM_ACCOUNTS];

/**
 * M18.1 — where an account sits on the liquidity scale, for the Finance Hub.
 * Balance-sheet accounts only; a DB CHECK refuses it on income/expense/equity.
 */
export type LiquidityClass = "cash" | "quick" | "current" | "non_current";

export interface SystemAccountDef {
  code: SystemAccountCode;
  name: string;
  nameAr: string;
  type: "asset" | "liability" | "equity" | "income" | "expense";
  vatApplicable?: boolean;
  /**
   * Required on assets and liabilities, omitted elsewhere. Kept here rather
   * than only in SQL so the seeded chart and the migration cannot drift — the
   * two-id-spaces lesson applied to a classification.
   */
  liquidityClass?: LiquidityClass;
  /**
   * The `journal_entry_lines.account_name` literals our own code has posted
   * since before M13. Used ONLY by the backfill, which is deterministic because
   * these strings came from our source, not from user input.
   */
  legacyNames: string[];
}

export const SYSTEM_CHART_OF_ACCOUNTS: SystemAccountDef[] = [
  { code: "AR", name: "Accounts Receivable", nameAr: "الذمم المدينة", type: "asset", liquidityClass: "quick", legacyNames: ["Accounts Receivable"] },
  { code: "CASH", name: "Cash and Bank", nameAr: "النقد والبنك", type: "asset", liquidityClass: "cash", legacyNames: ["Cash and Bank", "Cash"] },
  // 🔴 Flaw #1 (Option A): where an ACCEPTED but UNCATEGORISED bank line
  // posts. Double entry needs two accounts, and the alternative — refusing to
  // accept an uncategorised row — would strand the review queue. Posting it to
  // suspense keeps the books balanced and turns "I do not know what this is"
  // into a VISIBLE BALANCE somebody must clear, instead of a silent expense
  // (which is exactly what the dashboard used to do with it).
  { code: "SUSPENSE", name: "Suspense (unclassified)", nameAr: "حساب معلق", type: "asset", liquidityClass: "current", legacyNames: ["Suspense"] },
  // 🔴 A — GL owns cash. A DECLARED own-account transfer posts through here:
  // when both legs are uploaded the account nets to zero; a residual balance
  // is the tenant's money sitting in an own account the platform does not
  // track — a real, visible figure (liquid, hence `quick`), not noise. Only
  // declared own-account transfers touch it (B5), which is what retired the
  // "manufactures a clearing balance for every transfer" objection.
  { code: "TRANSFER_CLEARING", name: "Transfer clearing (own accounts)", nameAr: "تسوية التحويلات (حسابات خاصة)", type: "asset", liquidityClass: "quick", legacyNames: [] },
  // 🔴 An UNDECLARED transfer's offset. It posts — the bank genuinely moved,
  // so ledger cash must be right — but the offset is a visible balance
  // demanding a declaration, and like SUSPENSE a non-zero balance BLOCKS the
  // Finance Hub's liquidity claim: cash the platform cannot classify is
  // exactly what the withholding exists for (owner decision, 2026-08-17).
  { code: "TRANSFER_SUSPENSE", name: "Transfers awaiting declaration", nameAr: "تحويلات بانتظار الإقرار", type: "asset", liquidityClass: "current", legacyNames: [] },
  { code: "VAT_INPUT", name: "Input VAT Receivable", nameAr: "ضريبة القيمة المضافة على المشتريات", type: "asset", liquidityClass: "quick", legacyNames: ["Input VAT Receivable"] },

  { code: "AP", name: "Accounts Payable", nameAr: "الذمم الدائنة", type: "liability", liquidityClass: "current", legacyNames: ["Accounts Payable"] },
  { code: "VAT_OUTPUT", name: "VAT Payable", nameAr: "ضريبة القيمة المضافة المستحقة", type: "liability", liquidityClass: "current", legacyNames: ["VAT Payable"] },
  { code: "SALARIES_PAYABLE", name: "Salaries Payable", nameAr: "الرواتب المستحقة", type: "liability", liquidityClass: "current", legacyNames: ["Salaries Payable"] },
  { code: "GOSI_PAYABLE", name: "GOSI Payable", nameAr: "التأمينات الاجتماعية المستحقة", type: "liability", liquidityClass: "current", legacyNames: ["GOSI Payable"] },

  // 🔴 WHY THIS IS EQUITY (owner-approved 2026-08-17, recorded so nobody
  // re-litigates it as "why is this in equity"): the tenant DECLARED the
  // money left the business (B5's `external`), and a declared reduction of
  // net assets with no expense is definitionally a distribution in
  // double-entry. An EXPENSE would be a P&L claim the platform cannot
  // support (nothing says what was bought); an ASSET would say the money is
  // still the business's, contradicting the declaration the tenant made.
  // Drawings-shaped; an incoming external transfer symmetrically posts as a
  // contribution (credit here). Reclassifiable per-row later by changing the
  // declaration, which reverses and re-posts.
  { code: "EXTERNAL_TRANSFERS", name: "External transfers (money leaving the business)", nameAr: "تحويلات خارجية (أموال خرجت من المنشأة)", type: "equity", legacyNames: [] },

  { code: "SALES", name: "Sales Revenue", nameAr: "إيرادات المبيعات", type: "income", vatApplicable: true, legacyNames: ["Sales Revenue"] },

  { code: "PURCHASES", name: "Purchases", nameAr: "المشتريات", type: "expense", vatApplicable: true, legacyNames: ["Purchases", "Office Expense"] },
  { code: "SALARIES", name: "Salaries and Wages Expense", nameAr: "مصروف الرواتب والأجور", type: "expense", legacyNames: ["Salaries and Wages Expense"] },
  { code: "GOSI_EXPENSE", name: "GOSI Expense - Employer", nameAr: "مصروف التأمينات - حصة صاحب العمل", type: "expense", legacyNames: ["GOSI Expense - Employer"] },
];

/**
 * `account_name` → system code, for the M13 backfill of pre-existing GL lines.
 *
 * Deterministic because every name in it was emitted by our own posting code —
 * a closed set of 12 literals. A hand-typed manual-JE account name that happens
 * to match is mapped too, which is correct: it means the same account.
 */
export const LEGACY_NAME_TO_CODE: Record<string, SystemAccountCode> = Object.fromEntries(
  SYSTEM_CHART_OF_ACCOUNTS.flatMap((a) => a.legacyNames.map((n) => [n, a.code])),
) as Record<string, SystemAccountCode>;

/**
 * Idempotently ensure one organization has the system chart of accounts.
 *
 * 🔴 MUST run for EXISTING organizations, not only new ones. Every tenant
 * created before M13 has zero categories, so a seed that fires only at org
 * creation would leave all of them unresolvable — and the fail-closed posting
 * path would then reject their very next invoice. The M13 migration therefore
 * calls this for every existing org, and signup/seed call it for new ones.
 *
 * Idempotent on `(organization_id, system_code)`: safe to re-run, and safe to
 * run concurrently with another instance doing the same.
 *
 * Only ever INSERTS. It never overwrites `name`/`name_ar`, because those are
 * the tenant's to edit — the code is the identity, not the label.
 */
export async function seedChartOfAccounts(
  organizationId: string,
  client: { insert: typeof ownerDb.insert } = ownerDb,
): Promise<{ inserted: number }> {
  const rows = SYSTEM_CHART_OF_ACCOUNTS.map((a) => ({
    organizationId,
    name: a.name,
    nameAr: a.nameAr,
    type: a.type,
    systemCode: a.code,
    isSystem: true,
    vatApplicable: a.vatApplicable ?? false,
    // M18.1 — must travel with the row. This function is the CODE path that
    // seeds a new org; the DB trigger is the other. A column added to one and
    // not the other is how a tenant ends up with an unclassifiable balance
    // sheet depending on which door they came in through.
    liquidityClass: a.liquidityClass ?? null,
  }));

  const inserted = await client
    .insert(categoriesTable)
    .values(rows)
    .onConflictDoNothing({
      target: [categoriesTable.organizationId, categoriesTable.systemCode],
    })
    .returning({ id: categoriesTable.id });

  return { inserted: inserted.length };
}

/** Seed every organization that does not yet have the system accounts. */
export async function seedChartOfAccountsForAllOrgs(): Promise<{ organizations: number; inserted: number }> {
  const orgs = await ownerDb.execute<{ id: string }>(sql`SELECT id FROM organizations`);
  let inserted = 0;
  for (const row of orgs.rows) {
    const r = await seedChartOfAccounts(row.id);
    inserted += r.inserted;
  }
  return { organizations: orgs.rows.length, inserted };
}

/** Every system account for one org, keyed by code. */
export async function loadSystemAccounts(organizationId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ id: categoriesTable.id, code: categoriesTable.systemCode })
    .from(categoriesTable)
    .where(and(eq(categoriesTable.organizationId, organizationId), isNotNull(categoriesTable.systemCode)));
  return new Map(rows.filter((r) => r.code).map((r) => [r.code as string, r.id]));
}
