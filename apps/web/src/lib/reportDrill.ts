/**
 * Phase 14 (D14-09) — the ONE way a statement row opens the general ledger:
 * the account and the WINDOW travel in the URL, and the GL page reads them
 * (CLAUDE.md §3: "a navigation can lose the scope the user chose, and every
 * static check stays green" — so the link is built here once, and the e2e
 * test follows it and reads the figure).
 *
 * `from` is optional: a balance-sheet row opens the ledger from inception to
 * its as-of date.
 */
export function glDrillHref(accountId: number, from: string | null | undefined, to: string | null | undefined): string {
  const qs = new URLSearchParams({ account_id: String(accountId) });
  if (from) qs.set("date_from", from);
  if (to) qs.set("date_to", to);
  return `/reports/general-ledger?${qs.toString()}`;
}

/** A GL row opens its journal entry. */
export function journalEntryHref(jeId: number): string {
  return `/journal-entries?entry=${jeId}`;
}
