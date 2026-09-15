/**
 * accounts.ts — the expense accounts a bill can post to: the TENANT'S OWN
 * chart, by id. Used by the manual bill dialog and the scanner review page so
 * the two paths offer the same choices and can never drift.
 *
 * 🔴 WHY THIS IS A HOOK AND NOT A LIST (2026-09-15). This file used to hold 14
 * English account NAMES; the pages sent the chosen name and the server matched
 * it against the chart by text. Only 3 of the 14 existed in the seeded chart —
 * the other 11, the default included, matched nothing and the line posted to
 * PURCHASES while displaying the name the user had chosen. Two definitions of
 * one fact, joined by nothing. The chart is the one definition; this hook reads
 * it through the GENERATED client (the response shape is the contract's, not a
 * claim of this file's) and the pages send an id the server resolves —
 * refusing, visibly, anything it cannot.
 */
import { useListCategories, type Category } from "@workspace/api-client-react";
import { useLanguage } from "@/contexts/LanguageContext";

export interface ExpenseAccountOption {
  id: number;
  /** The account's name in the active language. */
  label: string;
  systemCode: string | null;
}

export function useExpenseAccounts(): {
  accounts: ExpenseAccountOption[];
  /** The PURCHASES system account when the chart has one — the same default the server applies when nothing is sent. */
  defaultId: number | null;
  labelOf: (id: number | null | undefined) => string;
} {
  const { lang } = useLanguage();
  const { data } = useListCategories();
  const categories: Category[] = data ?? [];
  const accounts: ExpenseAccountOption[] = categories
    .filter((c) => c.type === "expense")
    .map((c) => ({ id: c.id, label: lang === "ar" && c.nameAr ? c.nameAr : c.name, systemCode: c.systemCode ?? null }));
  const defaultId = accounts.find((a) => a.systemCode === "PURCHASES")?.id ?? accounts[0]?.id ?? null;
  const labelOf = (id: number | null | undefined) => accounts.find((a) => a.id === id)?.label ?? "";
  return { accounts, defaultId, labelOf };
}
