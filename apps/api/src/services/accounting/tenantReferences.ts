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
 * passes. Company-scoped targets add the company (`assertAssetOwnedByCompany`).
 */
import { db, categoriesTable, customersTable, vendorsTable, productsTable, fixedAssetsTable } from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
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
