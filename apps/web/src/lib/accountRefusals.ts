/**
 * G55 / DR-42 (2026-10-14) — an account THIS company cannot post to, explained
 * in the reader's language and keyed on the structured CODE and FIELD
 * (CLAUDE.md §3: "key the UI on the structured CODE, so rewording copy cannot
 * break it").
 *
 * The server answers three facts with ONE not-found code — another company's
 * bank account (G55), another organisation's account and a missing one (G04:
 * foreign ≡ missing) — so the Arabic sentence is written to be true of all
 * three. In English the server's own sentence stays the description: it names
 * the bank account where it may (the same organisation's other company, whose
 * account is on the user's own chart) and names nothing where it may not.
 *
 * Both error classes are read, like `refusalOf`: `apiFetch`'s (`.body`) and the
 * generated client's (`.data`).
 */
import { refusalOf } from "./openingVatRefusals";

type T = (en: string, ar: string) => string;

/** Where the refusal was met: a journal's own lines, or a recognition schedule (its form, or the entry it posts). */
export type AccountRefusalContext = "journal" | "schedule";

const BOTH_CASES_AR = "إما الحساب النقدي لبنك تابع لشركة أخرى، وإما حساب غير موجود";

/** The toast for an account this company cannot post to, or null when the error is something else. */
export function accountRefusalToast(e: unknown, t: T, context: AccountRefusalContext = "journal") {
  const { code, words } = refusalOf(e);
  const err = e as { body?: { field?: unknown }; data?: { field?: unknown } } | null;
  const field = String(err?.body?.field ?? err?.data?.field ?? "");
  const title = t("This company cannot post to that account", "لا يمكن لهذه الشركة الترحيل إلى هذا الحساب");
  const line = /^lines\[(\d+)\]\.accountId$/.exec(field);
  if (code === "reference_not_found" && line) {
    const ar =
      context === "schedule"
        ? `قيد هذا الجدول يستخدم حسابًا لا يمكن لهذه الشركة الترحيل إليه: ${BOTH_CASES_AR}. لم يُرحَّل شيء.`
        : `السطر ${Number(line[1]) + 1} يستخدم حسابًا لا يمكن لهذه الشركة الترحيل إليه: ${BOTH_CASES_AR}. اختر أحد حسابات هذه الشركة.`;
    return { title, description: t(words, ar), variant: "destructive" as const };
  }
  if (code === "balance_account_unknown" && field === "balanceAccountId") {
    const ar = `حساب الميزانية المختار لا يمكن لهذه الشركة استخدامه: ${BOTH_CASES_AR}. اختر أحد حسابات هذه الشركة.`;
    return { title, description: t(words, ar), variant: "destructive" as const };
  }
  return null;
}
