/**
 * 🔴 G04 (2026-10-07) — A REFERENCE IS PROVEN OWNED, NEVER INFERRED FROM
 * WHAT A LOOKUP HAPPENS TO SEE.
 *
 * THE DEFECT THIS REPLACES: the manual journal, `postJournalEntry` and journal
 * approval each looked a line's account up under RLS and then refused only the
 * accounts they FOUND (a header, a control account without its party). Another
 * tenant's id is invisible under RLS, so it was simply absent from the result
 * — no rule ran on it — and Postgres checks a foreign key OUTSIDE RLS, so the
 * line was stored: written, approved and posted on another tenant's account. A
 * missing id failed the key as a raw 23503 (a 500), and 201-vs-500 told any
 * tenant which ids exist on the platform.
 *
 * THE RULE: every id a write is about to store is checked against THIS
 * transaction's organization by an explicit predicate on the transaction's own
 * `app.current_org_id` — not by RLS visibility — and anything not owned is
 * refused. A foreign id and a missing id are the same fact here and get ONE
 * controlled 422 `reference_not_found`, whose body does not even echo the id,
 * so the two refusals are byte-identical. Outside a tenant transaction the
 * predicate is NULL and matches nothing: the check fails closed.
 *
 * The database holds the same rule beneath every writer (migration 0122: the
 * keys carry `organization_id`), so this check and the constraint fail
 * independently — this one exists to explain the refusal in words, and so a
 * caller that is not the manual journal (the seam, approval, reversal) cannot
 * reach the database with an id it was merely handed.
 *
 * Organization-level entities stay organization-level: accounts, customers,
 * vendors and products are owned by the ORGANIZATION, so every company of it
 * passes. Company-scoped targets add the company (`assertAssetOwnedByCompany`),
 * and so does the one account that is company-scoped through what it stands
 * for: a bank's GL leaf (`assertBankLeavesInCompany`, G55).
 */
import { db, categoriesTable, customersTable, vendorsTable, productsTable, fixedAssetsTable } from "@workspace/db";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { BusinessRuleError } from "../../lib/errors";

/** This transaction's organization — NULL outside a tenant transaction, which matches no row. */
const CURRENT_ORG_ID = sql`nullif(current_setting('app.current_org_id', true), '')::uuid`;
const CURRENT_COMPANY_ID = sql`nullif(current_setting('app.current_company_id', true), '')::uuid`;

/** The one refusal for "this id is not yours" — identical whether it is another tenant's or nobody's. */
export class ReferenceNotFoundError extends BusinessRuleError {
  constructor(field: string, subject: string) {
    super(422, { code: "reference_not_found", error: `${subject} that does not exist for this organization.`, field });
  }
}

const OWNED = {
  account: categoriesTable,
  customer: customersTable,
  vendor: vendorsTable,
  product: productsTable,
} as const;

/** The subset of `ids` that THIS organization owns. */
async function ownedIds(kind: keyof typeof OWNED, ids: Array<number | null | undefined>): Promise<Set<number>> {
  const wanted = [...new Set(ids.filter((id): id is number => id != null).map(Number))];
  if (wanted.length === 0) return new Set();
  const table = OWNED[kind];
  const rows = await db
    .select({ id: table.id })
    .from(table)
    .where(and(inArray(table.id, wanted), eq(table.organizationId, CURRENT_ORG_ID)));
  return new Set(rows.map((r) => r.id));
}

export interface LineReferences {
  accountId?: number | null;
  customerId?: number | null;
  vendorId?: number | null;
}

/**
 * Refuse a journal line whose account, customer or vendor this organization
 * does not own. `field` is the request field the lines came from (`lines`), so
 * the refusal names `lines[2].accountId` the way the UI reads it.
 */
export async function assertLineReferencesOwned(lines: LineReferences[], field = "lines"): Promise<void> {
  const accounts = await ownedIds("account", lines.map((l) => l.accountId));
  const customers = await ownedIds("customer", lines.map((l) => l.customerId));
  const vendors = await ownedIds("vendor", lines.map((l) => l.vendorId));
  for (const [i, l] of lines.entries()) {
    if (l.accountId != null && !accounts.has(Number(l.accountId))) throw new ReferenceNotFoundError(`${field}[${i}].accountId`, `Line ${i + 1} names an account`);
    if (l.customerId != null && !customers.has(Number(l.customerId))) throw new ReferenceNotFoundError(`${field}[${i}].customerId`, `Line ${i + 1} names a customer`);
    if (l.vendorId != null && !vendors.has(Number(l.vendorId))) throw new ReferenceNotFoundError(`${field}[${i}].vendorId`, `Line ${i + 1} names a vendor`);
  }
}

/**
 * 🔴 G55 / DR-42 (2026-10-14) — A BANK'S CASH ACCOUNT TAKES ENTRIES ONLY FROM
 * ITS OWN COMPANY.
 *
 * Accounts are organization-level (above), but a bank account belongs to ONE
 * company, and its GL leaf (`categories.bank_account_id`, created by trigger
 * for every bank) is that bank's cash. Naming the BANK was already
 * company-bounded (glPosting's `resolveBankLeaves`); naming its LEAF by account
 * id passed the organization check above, so company A could post a manual
 * journal or a prepayment release onto company B's bank — in A's books, and
 * invisible in B's own figure for that bank (S1 proof,
 * `tests/phase18-s1-dr42-cross-company-bank-leaf.test.ts`).
 *
 * THE RULE: an account id that is a bank leaf must be a leaf of a bank of the
 * company the entry is written in — the entry's own `companyId` when it already
 * exists, else this transaction's company — by an explicit predicate, not by
 * what RLS lets the lookup see. Outside a company context the predicate is NULL
 * and matches no bank, so every bank leaf is refused: fail closed. Whose bank it
 * is, and nothing else: an INACTIVE bank of the same company still passes
 * (owner, 2026-10-14).
 *
 * The generic REVERSAL deliberately does not call this: the mirror of an entry
 * already sitting on another company's bank is how that entry is corrected.
 *
 * Returns the offending account ids with the leaf's name; each caller refuses
 * in its own vocabulary (`assertBankLeavesInCompany` for journal lines).
 */
export async function bankLeavesOutsideCompany(accountIds: Array<number | null | undefined>, companyId?: string): Promise<Map<number, string>> {
  const wanted = [...new Set(accountIds.filter((id): id is number => id != null).map(Number))];
  if (wanted.length === 0) return new Map();
  const company = companyId ? sql`${companyId}::uuid` : CURRENT_COMPANY_ID;
  const rows = await db
    .select({ id: categoriesTable.id, name: categoriesTable.name })
    .from(categoriesTable)
    .where(
      and(
        inArray(categoriesTable.id, wanted),
        isNotNull(categoriesTable.bankAccountId),
        sql`NOT EXISTS (SELECT 1 FROM bank_accounts b WHERE b.id = ${categoriesTable}."bank_account_id" AND b.company_id = ${company})`,
      ),
    );
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * Refuse a journal line that names another company's bank leaf (see
 * `bankLeavesOutsideCompany`). The same 422 `reference_not_found` a foreign or
 * missing account gets, on the same field (`lines[i].accountId`); the sentence
 * says which bank account and why, since within one organization its name is
 * already on the user's own chart.
 */
export async function assertBankLeavesInCompany(
  lines: Array<{ accountId?: number | null }>,
  opts: { field?: string; companyId?: string } = {},
): Promise<void> {
  const field = opts.field ?? "lines";
  const foreign = await bankLeavesOutsideCompany(lines.map((l) => l.accountId), opts.companyId);
  for (const [i, l] of lines.entries()) {
    const name = l.accountId != null ? foreign.get(Number(l.accountId)) : undefined;
    if (name === undefined) continue;
    throw new BusinessRuleError(422, {
      code: "reference_not_found",
      error: `Line ${i + 1} posts to "${name}", the cash account of a bank account that belongs to another company. A bank account's cash account takes entries only from its own company — choose one of this company's own bank accounts.`,
      field: `${field}[${i}].accountId`,
    });
  }
}

/** Refuse a document line whose product this organization does not own. */
export async function assertProductsOwned(items: Array<{ productId?: unknown }>, field = "items"): Promise<void> {
  const ids = items.map((it) => (it.productId == null || it.productId === "" ? null : Number(it.productId)));
  const owned = await ownedIds("product", ids);
  for (const [i, id] of ids.entries()) {
    if (id != null && !owned.has(id)) throw new ReferenceNotFoundError(`${field}[${i}].productId`, `Item ${i + 1} names a product`);
  }
}

/**
 * Refuse an asset id that is not THIS COMPANY's — fixed assets are
 * company-scoped, so the same organization's other company's asset is refused
 * exactly like another tenant's (a bill capitalises its own company's asset).
 */
export async function assertAssetOwnedByCompany(assetId: unknown, field: string): Promise<void> {
  if (assetId == null) return;
  const id = Number(assetId);
  const [row] = Number.isInteger(id)
    ? await db
        .select({ id: fixedAssetsTable.id })
        .from(fixedAssetsTable)
        .where(and(eq(fixedAssetsTable.id, id), eq(fixedAssetsTable.organizationId, CURRENT_ORG_ID), eq(fixedAssetsTable.companyId, CURRENT_COMPANY_ID)))
        .limit(1)
    : [];
  if (!row) {
    throw new BusinessRuleError(422, { code: "reference_not_found", error: "The asset to capitalise does not exist for this company.", field });
  }
}
