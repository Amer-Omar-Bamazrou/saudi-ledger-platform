/**
 * Phase 16A — the withholding-tax declaration on a supplier payment, and the
 * SERVER's preview of it. Used by the two supplier pay dialogs (Bills → Pay,
 * Supplier payments → New payment) — the two pay paths that withhold.
 * Record: docs/product/phase-16-17-tax-treasury-decision-pack.md §2.3–§2.4.
 *
 * 🔴 Nothing here decides anything:
 *   - the supplier's residency is the supplier record's — never inferred here;
 *   - the rate, the tax and the cash are the server's preview
 *     (`GET /tax/wht/preview` → `decideWithholding`, the same function the pay
 *     paths call) — never computed here, never a default rate;
 *   - a nature nobody declared is never assumed — the server refuses it in
 *     words, and the words are shown.
 *
 * Only "withheld FROM the payment" exists: payer-borne WHT / gross-up is not
 * built (pack §2.4, OPEN W-2), and the copy says so.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { usePreviewWht, getPreviewWhtQueryKey, type PreviewWhtParams } from "@workspace/api-client-react";
import { fmtNum } from "@/lib/api";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLanguage } from "@/contexts/LanguageContext";
import { refusalOf } from "@/lib/openingVatRefusals";
import { notSubjectLabel, whtTypeLabel, WHT_TYPES } from "@/lib/taxLabels";

/** The WHT fields of a pay request — the same names on both pay paths (`whtDeclarationFrom`). Absent = not stated. */
export type WhtDeclarationValue = {
  whtPaymentType?: string;
  whtNotSubjectReason?: "goods" | "not_kingdom_source";
  whtNotSubjectNote?: string;
};

type WhtFieldsProps = {
  vendorId: number | null | undefined;
  /** The supplier record's `residency` — `undefined` while it loads (nothing renders). */
  residency: string | null | undefined;
  /** The supplier's declared default nature (`vendors.wht_default_payment_type`). */
  defaultType: string | null | undefined;
  /** What the SUPPLIER is credited with — the base the server withholds on. */
  amount: number;
  /** The payment date (YYYY-MM-DD) — the rate in force is the date's. */
  date: string;
  /**
   * The declaration, and whether it says what the screen shows. `ready` is
   * false only while "Not subject" is chosen without a reason: sent as it
   * stands, that request would carry NO declaration and the server would
   * apply the supplier's default nature — the opposite of what the screen says.
   */
  onChange: (declaration: WhtDeclarationValue, ready: boolean) => void;
};

/** A primitive held still for `ms` — so typing an amount asks the server once, not per keystroke. */
function useDebounced<T extends string | number>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const h = setTimeout(() => setV(value), ms);
    return () => clearTimeout(h);
  }, [value, ms]);
  return v;
}

/** A rate the server sent (a fraction) as a percentage — display only. */
const pct = (r: number) => `${Number((r * 100).toFixed(2))}%`;

export function WhtFields({ vendorId, residency, defaultType, amount, date, onChange }: WhtFieldsProps) {
  const { t } = useLanguage();
  const [mode, setMode] = useState<"withhold" | "not_subject">("withhold");
  const [nature, setNature] = useState<string>(defaultType ?? "");
  const [reason, setReason] = useState<"" | "goods" | "not_kingdom_source">("");
  const [note, setNote] = useState("");

  // A different supplier (or its record arriving) starts the declaration again, from ITS declared default.
  useEffect(() => {
    setMode("withhold");
    setNature(defaultType ?? "");
    setReason("");
    setNote("");
  }, [vendorId, defaultType]);

  const isNonResident = residency === "non_resident";
  const trimmedNote = note.trim();
  const ready = !(isNonResident && mode === "not_subject" && !reason);

  // Report the declaration up whenever it changes; the parent's callback identity is not a change.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    const declaration: WhtDeclarationValue = !isNonResident
      ? {}
      : mode === "withhold"
        ? (nature ? { whtPaymentType: nature } : {})
        : {
            ...(reason ? { whtNotSubjectReason: reason } : {}),
            ...(reason === "not_kingdom_source" && trimmedNote ? { whtNotSubjectNote: trimmedNote } : {}),
          };
    onChangeRef.current(declaration, ready);
  }, [isNonResident, mode, nature, reason, trimmedNote, ready]);

  const debouncedAmount = useDebounced(amount);
  const debouncedNote = useDebounced(trimmedNote);
  const params: PreviewWhtParams = {
    vendorId: vendorId ?? 0,
    amount: debouncedAmount,
    date,
    ...(mode === "withhold"
      ? (nature ? { whtPaymentType: nature } : {})
      : {
          ...(reason ? { whtNotSubjectReason: reason } : {}),
          ...(reason === "not_kingdom_source" && debouncedNote ? { whtNotSubjectNote: debouncedNote } : {}),
        }),
  };
  const previewEnabled = isNonResident && vendorId != null && debouncedAmount > 0 && ready;
  const preview = usePreviewWht(params, {
    query: { queryKey: getPreviewWhtQueryKey(params), enabled: previewEnabled, retry: false },
  });

  if (residency === "unknown") {
    return (
      <p className="mt-3 rounded border border-border bg-secondary/30 p-2 text-xs text-muted-foreground text-start" data-testid="wht-unknown-residency">
        {t("This supplier's residency is not declared, so nothing is withheld from this payment — and it is listed as a withholding-tax exception until the residency is declared.",
           "لم يُصرَّح بإقامة هذا المورد، لذا لا يُستقطع شيء من هذه الدفعة — وتُدرج ضمن استثناءات ضريبة الاستقطاع إلى أن يُصرَّح بالإقامة.")}
        {vendorId != null && (
          <>
            {" "}
            <Link href={`/vendors/${vendorId}`} className="text-primary underline">{t("Declare it on the supplier", "صرّح بها في بيانات المورد")}</Link>
          </>
        )}
      </p>
    );
  }
  if (!isNonResident) return null;

  const p = preview.data;
  const refusal = preview.isError ? refusalOf(preview.error).words : null;

  return (
    <div className="mt-3 space-y-2 rounded border border-border p-3 text-start" data-testid="wht-fields">
      <p className="text-sm font-medium">{t("Withholding tax — non-resident supplier", "ضريبة الاستقطاع — مورد غير مقيم")}</p>
      <p className="text-[11px] text-muted-foreground">
        {t("This supplier is declared non-resident, so tax is withheld FROM this payment (Income Tax Law Art. 68): the supplier is credited with the full amount, the bank pays the amount less the tax, and the tax is owed to ZATCA by the 10th of next month. The rate is the regulation's for the nature you declare. Paying the tax on the supplier's behalf (grossing up) is not supported.",
           "هذا المورد مُصرَّح بأنه غير مقيم، لذا تُستقطع الضريبة من هذه الدفعة (نظام ضريبة الدخل المادة 68): يُقيَّد للمورد كامل المبلغ، ويدفع البنك المبلغ ناقصًا الضريبة، وتُستحق الضريبة للهيئة بحلول العاشر من الشهر التالي. والنسبة هي ما تحدده اللائحة للطبيعة التي تصرّح بها. ولا يُدعم تحمّل الضريبة عن المورد (تغطيتها).")}
      </p>

      <div className="flex flex-wrap gap-x-4 gap-y-1" role="radiogroup" aria-label={t("Withholding on this payment", "الاستقطاع على هذه الدفعة")}>
        <label className="flex items-center gap-2 text-xs">
          <input type="radio" name="wht-mode" className="accent-primary" checked={mode === "withhold"}
            onChange={() => setMode("withhold")} data-testid="wht-mode-withhold" />
          {t("Withhold — nature of the payment", "استقطاع — طبيعة الدفعة")}
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input type="radio" name="wht-mode" className="accent-primary" checked={mode === "not_subject"}
            onChange={() => setMode("not_subject")} data-testid="wht-mode-not-subject" />
          {t("Not subject to withholding", "غير خاضعة للاستقطاع")}
        </label>
      </div>

      {mode === "withhold" ? (
        <div>
          <Select value={nature} onValueChange={setNature}>
            <SelectTrigger className="h-8 text-sm" data-testid="wht-nature"><SelectValue placeholder={t("Choose the payment's nature", "اختر طبيعة الدفعة")} /></SelectTrigger>
            <SelectContent>
              {WHT_TYPES.map((code) => <SelectItem key={code} value={code} className="text-xs">{whtTypeLabel(code, t)}</SelectItem>)}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground mt-1">
            {defaultType
              ? t("The supplier's declared default is preselected; change it if this payment is for something else.", "الطبيعة الافتراضية المُصرَّح بها للمورد مختارة مسبقًا؛ غيّرها إن كانت هذه الدفعة لغير ذلك.")
              : t("This supplier has no declared default nature — choose one; it is never assumed.", "لا توجد للمورد طبيعة افتراضية مُصرَّح بها — اختر واحدة؛ فلا تُفترض أبدًا.")}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <Select value={reason} onValueChange={(v) => setReason(v as "goods" | "not_kingdom_source")}>
            <SelectTrigger className="h-8 text-sm" data-testid="wht-not-subject-reason"><SelectValue placeholder={t("Why is it not subject?", "لماذا ليست خاضعة؟")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="goods" className="text-xs">{notSubjectLabel("goods", t)}</SelectItem>
              <SelectItem value="not_kingdom_source" className="text-xs">{notSubjectLabel("not_kingdom_source", t)}</SelectItem>
            </SelectContent>
          </Select>
          {reason === "not_kingdom_source" && (
            <div>
              <Label className="text-xs text-muted-foreground">
                {t("Why the income has no source in the Kingdom (at least 10 characters — kept with the record for ten years)", "سبب عدم وجود مصدر للدخل في المملكة (10 أحرف على الأقل — يُحفظ مع السجل عشر سنوات)")}
              </Label>
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000}
                className="mt-1 text-sm min-h-[56px]" data-testid="wht-not-subject-note" />
            </div>
          )}
        </div>
      )}

      <div className="rounded bg-secondary/30 p-2 text-xs space-y-1" data-testid="wht-preview" aria-live="polite">
        {!ready ? (
          <p className="text-muted-foreground">{t("Choose why it is not subject.", "اختر سبب عدم الخضوع.")}</p>
        ) : !(debouncedAmount > 0) ? (
          <p className="text-muted-foreground">{t("Enter the amount to see the withholding.", "أدخل المبلغ لعرض الاستقطاع.")}</p>
        ) : refusal ? (
          <p className="text-destructive" data-testid="wht-preview-error">{refusal}</p>
        ) : !p ? (
          <p className="text-muted-foreground">{t("Asking the server…", "جارٍ الاستعلام من الخادم…")}</p>
        ) : (
          <>
            {p.kind === "withheld" && (
              <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                <span>
                  {p.treatyReliefId != null ? t("Treaty rate", "نسبة الاتفاقية") : t("Rate", "النسبة")}{" "}
                  <span className="font-mono" dir="ltr">{p.rate != null ? pct(p.rate) : "—"}</span>
                  {p.treatyReliefId != null && p.statutoryRate != null && (
                    <span className="text-muted-foreground"> ({t("statutory", "النظامية")} <span className="font-mono" dir="ltr">{pct(p.statutoryRate)}</span>)</span>
                  )}
                </span>
                {p.formRow && <span>{t("Form 06 row", "سطر النموذج 06")} <span className="font-mono" dir="ltr">{p.formRow}</span></span>}
              </div>
            )}
            {p.kind === "withheld" && p.legalReference && (
              <p className="text-muted-foreground">{t("Legal basis", "السند النظامي")}: <span dir="ltr">{p.legalReference}</span></p>
            )}
            {p.kind === "not_subject" && (
              <p className="text-muted-foreground">
                {t("Not subject — nothing is withheld. The payment is recorded with its reason in the return's excluded list", "غير خاضعة — لا يُستقطع شيء. تُسجَّل الدفعة مع سببها في قائمة المستبعدات في الإقرار")}
                {p.notSubjectReason ? `: ${notSubjectLabel(p.notSubjectReason, t)}` : ""}
              </p>
            )}
            <div className="flex flex-wrap justify-between gap-x-3">
              <span className="text-muted-foreground">{t("Credited to the supplier", "المقيَّد للمورد")}</span>
              <span className="font-mono" dir="ltr">{fmtNum(p.amount)}</span>
            </div>
            <div className="flex flex-wrap justify-between gap-x-3">
              <span className="text-muted-foreground">{t("Tax withheld from the payment", "الضريبة المستقطعة من الدفعة")}</span>
              <span className="font-mono" dir="ltr" data-testid="wht-preview-withheld">{fmtNum(p.withheld)}</span>
            </div>
            <div className="flex flex-wrap justify-between gap-x-3 font-medium">
              <span>{t("Cash that leaves the bank", "النقد الخارج من البنك")}</span>
              <span className="font-mono" dir="ltr" data-testid="wht-preview-cash">{fmtNum(p.cashPaid)}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
