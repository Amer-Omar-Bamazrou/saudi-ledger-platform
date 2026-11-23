/**
 * 🔴 19B S3 (v4 §6.3, D2): a supplier's or an employee's IBAN is HELD at entry and on every change, until an accountant
 * or admin who did not enter it approves it (Company settings → Bank-detail changes). When the person who entered it is
 * the only member who could ever approve bank details, it applied at once, and the record says so.
 *
 *  - `ibanSaveNotice`: what a save that carried an IBAN tells its author — held, or applied without a second approver.
 *  - `PartyIbanLine`: what the record shows — "IBAN waiting for approval", or the fallback's line.
 * Both read the SERVER's answer (`pendingBankDetailChanges`, `ibanPending`, `ibanAppliedWithoutSecondApprover`).
 */
import { fmtDate } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";

type T = (en: string, ar: string) => string;
type PartyIban = { ibanPending?: boolean; ibanAppliedWithoutSecondApprover?: { at: string; byName: string | null } | null };

/** The notice for a save whose body carried an IBAN; null when the body carried none (the caller's own title stands). */
export function ibanSaveNotice(res: unknown, ibanGiven: boolean, t: T): { title: string; description: string } | null {
  if (!ibanGiven) return null;
  const r = (res ?? {}) as PartyIban & { pendingBankDetailChanges?: unknown[] };
  if ((r.pendingBankDetailChanges ?? []).length > 0) {
    return {
      title: t("Saved — the IBAN waits for approval", "تم الحفظ — الآيبان بانتظار الاعتماد"),
      description: t(
        "An accountant or admin who did not enter it approves it in Company settings → Bank-detail changes. Until then the previous IBAN (or none) stays.",
        "يعتمده محاسب أو مسؤول لم يُدخله، من إعدادات الشركة ← تغييرات البيانات البنكية. وحتى ذلك يبقى الآيبان السابق (أو لا آيبان).",
      ),
    };
  }
  if (r.ibanAppliedWithoutSecondApprover) {
    return {
      title: t("Saved — the IBAN applied without a second approver", "تم الحفظ — طُبِّق الآيبان دون معتمِد ثانٍ"),
      description: t(
        "No other member holds a role that can approve bank details, so it applied at once. It is recorded, and shown on the record.",
        "لا يملك أي عضو آخر دوراً يتيح اعتماد البيانات البنكية، فطُبِّق فوراً. وقد سُجِّل ذلك ويظهر على السجل.",
      ),
    };
  }
  return null;
}

/** The record's IBAN state: a change waiting, or the last IBAN that applied without a second approver. */
export function PartyIbanLine({ record, testId }: { record: PartyIban; testId: string }) {
  const { t, lang } = useLanguage();
  if (record.ibanPending) {
    return (
      <span className="inline-block rounded border border-attention/40 px-1.5 py-0.5 text-[11px] text-attention" data-testid={`${testId}-pending`}>
        {t("IBAN change waiting for approval", "تغيير الآيبان بانتظار الاعتماد")}
      </span>
    );
  }
  const f = record.ibanAppliedWithoutSecondApprover;
  if (!f) return null;
  return (
    <span className="block text-[11px] text-muted-foreground" data-testid={`${testId}-fallback`}>
      {t(
        `IBAN applied without a second approver on ${fmtDate(f.at, lang)}, entered by ${f.byName ?? "—"}`,
        `طُبِّق الآيبان دون معتمِد ثانٍ في ${fmtDate(f.at, lang)}، وأدخله ${f.byName ?? "—"}`,
      )}
    </span>
  );
}
