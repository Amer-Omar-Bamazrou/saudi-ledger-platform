/**
 * 🔴 The manual journal's own refusals, explained in the reader's language and
 * keyed on the structured CODE (CLAUDE.md §3: "key the UI on the structured
 * CODE, so rewording copy cannot break it"). Phase 18; owner decisions of
 * 2026-10-23 (decision 2: "a clear refusal in Arabic and English") and
 * 2026-10-27 (midday item 2: `entry_number_reserved` on this screen).
 *
 *  - `journal_entry_zero_amounts`: every amount is blank or zero, so the entry
 *    records nothing; refused when it is saved and when it is posted.
 *  - `entry_number_reserved` (T1d): the typed number has a shape the system
 *    writes. The server names which of three shapes; the English description
 *    is its own sentence, and the Arabic one is written to be true of all three.
 *
 * Both error classes are read, like `refusalOf`: `apiFetch`'s (`.body`) and the
 * generated client's (`.data`).
 */
import { refusalOf } from "./openingVatRefusals";

type T = (en: string, ar: string) => string;

/** The toast for a manual journal's own refusal, or null when the error is something else. */
export function journalRefusalToast(e: unknown, t: T) {
  const { code, words } = refusalOf(e);
  if (code === "journal_entry_zero_amounts") {
    return {
      title: t("This entry records nothing", "هذا القيد لا يسجّل شيئاً"),
      description: t(
        "Every amount in this entry is blank or zero. Enter the debit and credit amounts, then save. Nothing was saved.",
        "جميع مبالغ هذا القيد فارغة أو صفر. أدخل مبالغ المدين والدائن ثم احفظ. لم يُحفظ شيء.",
      ),
      variant: "destructive" as const,
    };
  }
  if (code === "entry_number_reserved") {
    return {
      title: t("That entry number is reserved", "رقم القيد هذا محجوز"),
      description: t(
        words,
        "رقم القيد المكتوب بصيغة يستخدمها النظام لقيوده: الترقيم التلقائي (JE- مع أرقام)، أو بادئة قيد مستند، أو اللاحقة ‎-REV الخاصة بالعكس. اختر رقماً آخر، أو اترك الحقل فارغاً ليرقّم النظام القيد. لم يُحفظ شيء.",
      ),
      variant: "destructive" as const,
    };
  }
  return null;
}

/** Save stays disabled while every amount is blank or zero — the same rule the server refuses. */
export function journalRecordsNothing(totalDebit: number, totalCredit: number): boolean {
  return !(totalDebit > 0 || totalCredit > 0);
}
