/**
 * 🔴 19B (v4 §4, D4): what a page shows where the server WITHHELD a field — the key is absent from the response, so the
 * page says so and names the permission it needs. Never a blank (which reads as "no value") and never a zero.
 * The class comes from the server's own field-access answer (GET /employees/field-access, /payroll/field-access).
 */
import { useLanguage } from "@/contexts/LanguageContext";

const CLASS_LABELS: Record<string, [string, string]> = {
  identity: ["identity", "الهوية"],
  compensation: ["pay", "الرواتب"],
  bank_account: ["bank account", "الحساب البنكي"],
  contact: ["contact details", "بيانات الاتصال"],
  bank_narrative: ["bank text", "نص كشف البنك"],
  member_security: ["member security", "أمان الأعضاء"],
};

export function Withheld({ cls, testId }: { cls: string | undefined; testId?: string }) {
  const { t } = useLanguage();
  const [en, ar] = CLASS_LABELS[cls ?? ""] ?? ["this", "هذه"];
  return (
    <span className="text-xs text-muted-foreground italic" data-testid={testId} title={t(`Withheld — needs the ${en} permission`, `محجوب — يحتاج صلاحية ${ar}`)}>
      {t(`Withheld (${en})`, `محجوب (${ar})`)}
    </span>
  );
}

/**
 * 🔴 19B S2c (D4): a record's bank text — the bank's own words on a statement line, a transaction, or a journal line
 * posted from one (bank_narrative). Shown as served; where the server WITHHELD it (the key is absent), marked withheld —
 * never a blank, which would read as "the bank sent no text". `empty` is what an honest null shows (e.g. "—").
 */
export function BankText({ row, field = "description", empty = "", testId }: { row: object; field?: string; empty?: string; testId?: string }) {
  const r = row as Record<string, unknown>;
  if (!(field in r)) return <Withheld cls="bank_narrative" testId={testId} />;
  const v = r[field];
  return <>{v == null || v === "" ? empty : String(v)}</>;
}

/** The same, as plain text — for a title attribute or a composed label. */
export function bankTextLabel(row: object, t: (en: string, ar: string) => string, field = "description"): string {
  const r = row as Record<string, unknown>;
  if (!(field in r)) return t("Withheld (bank text)", "محجوب (نص كشف البنك)");
  const v = r[field];
  return v == null ? "" : String(v);
}

export function PayNotSet({ testId }: { testId?: string }) {
  const { t } = useLanguage();
  return (
    <span className="inline-block rounded border border-attention/40 px-1.5 py-0.5 text-xs text-attention" data-testid={testId}>
      {t("Pay not set", "الراتب غير محدد")}
    </span>
  );
}
