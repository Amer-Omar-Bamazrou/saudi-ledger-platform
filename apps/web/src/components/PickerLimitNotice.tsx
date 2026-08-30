import { useLanguage } from "@/contexts/LanguageContext";

/**
 * Rendered inside a dropdown when the tenant has more options than the picker
 * asked for.
 *
 * 🔴 It exists so that truncation is a STATEMENT rather than an absence. A
 * `<Select>` that quietly holds 200 of a tenant's 340 customers looks
 * identical to one holding all of them — the missing customer is simply not
 * there, and the user concludes the record does not exist. Naming the cut is
 * the same move as the closed-period dialog: explain the refusal rather than
 * hide the control (§3).
 */
export function PickerLimitNotice({ shown, total }: { shown: number; total: number }) {
  const { t } = useLanguage();
  if (total <= shown) return null;
  return (
    <div className="px-2 py-1.5 text-xs text-attention border-t border-border">
      {t(
        `Showing ${shown} of ${total}. Use the full list page to find the rest.`,
        `عرض ${shown} من ${total}. استخدم صفحة القائمة الكاملة للعثور على البقية.`,
      )}
    </div>
  );
}
