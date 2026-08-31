/**
 * The status filters a list page offers, and the labels the navigation uses
 * for them — declared ONCE, here.
 *
 * ── 🔴 WHY THIS IS DATA AND NOT PROSE IN FIVE PAGES ────────────────────────
 * The approved navigation tree (`docs/product/nav-tree-reconciliation.md`)
 * marks ~55 entries **FILTER-OF**: not destinations, but filters on a list that
 * already exists, deep-linked with the filter applied. Two things then have to
 * agree — the nav's `?status=` and the page's chip — and a third thing has to
 * be able to CHECK they agree, mechanically, for every entry rather than a
 * sample. Three consumers of one fact is exactly the shape that drifts, so the
 * fact lives in one place and all three read it.
 *
 * ── 🔴 THE SPEC'S LABELS ARE RENAMED TO REAL STATUSES, NEVER INVENTED ──────
 * The reconciliation rule the owner agreed: where the spec's label does not
 * match a status a writer produces, rename it to the one that does; where it
 * matches nothing at all, drop it. So "Pending Approval" is `submitted` (a real
 * state on invoices and bills), "Issued" is `sent` (the state that is hashed,
 * QR'd and posted), and the spec's separate "Sent" entry is gone — one status
 * cannot be two nav entries. `overdue` and `expired` are DERIVED and carry no
 * stored value at all; the API answers them from dates.
 *
 * Anything not listed here is not offered. A chip that returns a permanently
 * empty set is the defect this whole pass removed.
 */

export interface FilterOption {
  /** The `?status=` value, and what the API receives. */
  value: string;
  label: string;
  labelAr: string;
  /**
   * Derived from dates rather than read from a status column. Recorded so a
   * reader does not go looking for a writer that does not exist.
   */
  derived?: boolean;
}

/** Every list's "no filter" entry. Present so the option list is total. */
export const ALL: FilterOption = { value: "all", label: "All", labelAr: "الكل" };

/** `draft | submitted | sent | paid` (schema/invoices.ts), plus derived overdue. */
export const INVOICE_FILTERS: readonly FilterOption[] = [
  ALL,
  { value: "draft",     label: "Drafts",           labelAr: "مسودات" },
  { value: "submitted", label: "Pending Approval", labelAr: "بانتظار الموافقة" },
  { value: "sent",      label: "Issued",           labelAr: "صادرة" },
  { value: "paid",      label: "Paid",             labelAr: "مدفوعة" },
  { value: "overdue",   label: "Overdue",          labelAr: "متأخرة", derived: true },
];

/** `draft | submitted | received | approved | paid` (schema/bills.ts). */
export const BILL_FILTERS: readonly FilterOption[] = [
  ALL,
  { value: "draft",     label: "Drafts",           labelAr: "مسودات" },
  { value: "submitted", label: "Pending Approval", labelAr: "بانتظار الموافقة" },
  { value: "received",  label: "Received",         labelAr: "مستلمة" },
  { value: "approved",  label: "Approved",         labelAr: "معتمدة" },
  { value: "paid",      label: "Paid",             labelAr: "مدفوعة" },
  { value: "overdue",   label: "Overdue",          labelAr: "متأخرة", derived: true },
];

/**
 * `draft → posted → reversed`. 🔴 There is NO `submitted` state on a journal
 * entry — `journalEntries.approvable.ts` approves one directly — so the spec's
 * "Pending Approval" entry is dropped rather than renamed. `reversed` is real
 * here, unlike on invoices and bills.
 */
export const JOURNAL_ENTRY_FILTERS: readonly FilterOption[] = [
  ALL,
  { value: "draft",    label: "Drafts",   labelAr: "مسودات" },
  { value: "posted",   label: "Posted",   labelAr: "مرحّلة" },
  { value: "reversed", label: "Reversed", labelAr: "معكوسة" },
];

/**
 * `draft | submitted | approved | declined | closed`, plus two derived views:
 * `converted` (a conversion exists) and `expired` (past `valid_until` while
 * still live — see the repository, which is the only place that is defined).
 */
export const QUOTATION_FILTERS: readonly FilterOption[] = [
  ALL,
  { value: "draft",     label: "Drafts",              labelAr: "مسودات" },
  { value: "submitted", label: "Pending Approval",    labelAr: "بانتظار الموافقة" },
  { value: "approved",  label: "Approved",            labelAr: "معتمدة" },
  { value: "converted", label: "Converted to Invoice", labelAr: "محوّلة إلى فاتورة", derived: true },
  { value: "expired",   label: "Expired",             labelAr: "منتهية الصلاحية", derived: true },
  { value: "declined",  label: "Declined",            labelAr: "مرفوضة" },
];

export const PURCHASE_ORDER_FILTERS: readonly FilterOption[] = [
  ALL,
  { value: "draft",     label: "Drafts",           labelAr: "مسودات" },
  { value: "submitted", label: "Pending Approval", labelAr: "بانتظار الموافقة" },
  { value: "approved",  label: "Approved",         labelAr: "معتمدة" },
  { value: "converted", label: "Converted to Bill", labelAr: "محوّلة إلى فاتورة مورّد", derived: true },
];

/**
 * 🔴 The initial value comes from the URL, and JUNK FALLS BACK TO "all".
 *
 * This is the lost-scope rule (`e2e/deep-link-scope.spec.ts`) applied to every
 * list: `CustomerLedger` initialised its filter with `useState("all")` and
 * never read the query string, so arriving from one customer's page produced
 * every customer's statement — a true statement about the wrong set, which
 * reads as an answer. A nav entry that deep-links a filter makes the same
 * promise, ~55 times over.
 *
 * An unrecognised value falls back to the whole list rather than being sent to
 * the API as a filter matching nothing: showing everything is visibly wrong,
 * showing an empty set looks like a fact.
 */
export function initialStatusFilter(options: readonly FilterOption[]): string {
  if (typeof window === "undefined") return "all";
  const raw = new URLSearchParams(window.location.search).get("status");
  return raw && options.some(o => o.value === raw) ? raw : "all";
}

/**
 * Keep the address bar honest as the user clicks chips, so the URL always
 * describes what is on screen — and a copied link reproduces it. `replaceState`
 * rather than a push: a filter is not a place, and it should not take six
 * presses of Back to leave a list.
 */
export function syncStatusToUrl(value: string): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (value === "all") url.searchParams.delete("status");
  else url.searchParams.set("status", value);
  window.history.replaceState(window.history.state, "", url.toString());
}

export function filterLabel(
  options: readonly FilterOption[],
  value: string,
  lang: "en" | "ar",
): string {
  const found = options.find(o => o.value === value) ?? ALL;
  return lang === "ar" ? found.labelAr : found.label;
}
