/**
 * Accountant Q1 (2026-10-05) — the WHT month's FILING record and the CORRECTION of a WHT-bearing payment.
 * Record: docs/product/phase-16-17-tax-treasury-decision-pack.md §14.1.
 *
 * 🔴 Nothing here decides anything:
 *   - the return's figures, its filing state ("amendment due" included) and the snapshot AS FILED are the server's;
 *   - a correction is reversal + re-entry on the server, in one transaction; this form only states the facts — why,
 *     when, the corrected payment, and (for a filed month) the person's treatment, which is never preselected;
 *   - the re-entry's withholding is the server's preview (`<WhtFields>` → `decideWithholding`).
 * The platform does not file with ZATCA; the filing form records that a person did.
 */
import { useRef, useState } from "react";
import {
  useFileWhtReturn, useCorrectWhtWithholding, useGetWhtWithholdingLineage, useGetVendor, useListBills, useListVendors,
  getGetWhtWithholdingLineageQueryKey, getGetVendorQueryKey, getListBillsQueryKey,
  type WhtWithholding, type WhtFilingState, type ListBillsParams,
} from "@workspace/api-client-react";
import { businessToday } from "@workspace/shared";
import { fmtDate, fmtNum } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { useGuarded } from "@/lib/singleSubmit";
import { BankPicker } from "@/components/payments/shared";
import { WhtFields, type WhtDeclarationValue } from "@/components/payments/WhtFields";
import { whtFilingStatusLabel, whtTreatmentLabel, whtTypeLabel, notSubjectLabel, whtMonthStatusLabel } from "@/lib/taxLabels";

const money = (x: number | null | undefined) => (x == null ? "—" : fmtNum(x));

/** The month's Form 06 filing state, the snapshot AS FILED beside the ledger's live figure, and the act of recording a filing or an amendment. */
export function WhtFilingCard({ period, filing, liveTax, onDone }: { period: string; filing: WhtFilingState; liveTax: number; onDone: () => void }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [filedOn, setFiledOn] = useState(businessToday());
  const [reference, setReference] = useState("");
  const file = useGuarded(useFileWhtReturn({ mutation: { onSuccess: () => { toast({ title: t("Filing recorded", "تم تسجيل التقديم") }); setReference(""); onDone(); } } }));
  const latest = filing.latest;
  const canRecord = filing.status === "unfiled" || filing.status === "amendment_due";
  return (
    <div className="rounded border border-border p-3 space-y-2 text-sm" data-testid="wht-filing">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-medium">{t("Form 06 filing", "تقديم النموذج 06")}</span>
        <span data-testid="wht-filing-status">{whtFilingStatusLabel(filing.status, t)}</span>
        {latest && (
          <span className="text-muted-foreground" data-testid="wht-filing-latest">
            {latest.kind === "amendment" ? t("amendment", "تعديل") : t("filed", "قُدِّم")} {fmtDate(latest.filedOn)} · <span className="font-mono" dir="ltr">{latest.zatcaReference}</span> · {t("tax as filed", "الضريبة كما قُدِّمت")} <span className="font-mono" dir="ltr" data-testid="wht-filing-filed-tax">{money(latest.taxWithheld)}</span>
          </span>
        )}
      </div>
      {filing.status === "amendment_due" && latest && (
        <p className="text-xs" data-testid="wht-filing-differs">
          {t(`The ledger now carries ${fmtNum(liveTax)} for ${period}; ${fmtNum(latest.taxWithheld)} was filed. A correction chose to amend this return: amend it on ZATCA's portal, then record the amendment here.`,
             `تحمل الدفاتر الآن ${fmtNum(liveTax)} لشهر ${period}؛ وقُدِّم ${fmtNum(latest.taxWithheld)}. اختير تصحيح بتعديل هذا الإقرار: عدّله في بوابة الهيئة ثم سجّل التعديل هنا.`)}
        </p>
      )}
      {filing.filings.length > 1 && (
        <ul className="text-xs text-muted-foreground space-y-0.5" data-testid="wht-filing-history">
          {filing.filings.map((f) => <li key={f.id}>{f.kind === "amendment" ? t("Amendment", "تعديل") : t("Original", "أصلي")} · {fmtDate(f.filedOn)} · <span className="font-mono" dir="ltr">{f.zatcaReference}</span> · <span className="font-mono" dir="ltr">{money(f.taxWithheld)}</span></li>)}
        </ul>
      )}
      {canRecord && (
        <div className="grid gap-2 sm:grid-cols-3 items-end" data-testid="wht-filing-form">
          <div><Label className="text-xs text-muted-foreground">{filing.status === "unfiled" ? t("Filed on", "تاريخ التقديم") : t("Amendment filed on", "تاريخ تقديم التعديل")}</Label>
            <Input type="date" dir="ltr" value={filedOn} onChange={(e) => setFiledOn(e.target.value)} data-testid="wht-filing-date" /></div>
          <div><Label className="text-xs text-muted-foreground">{t("ZATCA reference", "مرجع الهيئة")}</Label>
            <Input dir="ltr" value={reference} onChange={(e) => setReference(e.target.value)} data-testid="wht-filing-reference" /></div>
          <Button size="sm" disabled={reference.trim().length < 3 || file.isPending} data-testid="wht-filing-submit"
            onClick={() => file.mutate({ period, data: { filedOn, zatcaReference: reference.trim() } })}>
            {filing.status === "unfiled" ? t("Record filing", "تسجيل التقديم") : t("Record amendment", "تسجيل التعديل")}
          </Button>
          <p className="sm:col-span-3 text-[11px] text-muted-foreground">{t("The platform does not file with ZATCA; this records that you did. The figures recorded are the ledger's at this moment, so a later correction is measured against what was filed.", "لا تقدّم المنصة الإقرار للهيئة؛ هذا يسجّل أنك قدّمته. والأرقام المسجَّلة هي أرقام الدفاتر في هذه اللحظة، ليُقاس عليها أي تصحيح لاحق.")}</p>
        </div>
      )}
    </div>
  );
}

/**
 * Correct one withholding — reversal + re-entry (Q1). The original is never edited; the server records why, when and
 * by whom, and the corrected payment goes through the same pay path.
 */
export function WhtCorrectionPanel({ row, monthFilingStatus, onDone, onCancel }: { row: WhtWithholding; monthFilingStatus: WhtFilingState["status"]; onDone: () => void; onCancel: () => void }) {
  const { t, n } = useLanguage();
  const { toast } = useToast();
  const [reason, setReason] = useState("");
  const [date, setDate] = useState(businessToday());
  const [treatment, setTreatment] = useState<"" | "subsequent_period" | "amendment">("");
  const [reenter, setReenter] = useState(true);
  const [amount, setAmount] = useState(String(row.baseAmount));
  const [paidAt, setPaidAt] = useState(row.paymentDate);
  const [bank, setBank] = useState("");
  const isBill = row.sourceKind === "bill_payment";
  const [classification, setClassification] = useState<string>(row.paymentClass === "allocated" || !row.paymentClass || row.paymentClass === "bill_payment" ? "advance" : row.paymentClass);
  // the wrong-supplier case: a different supplier (and, for a bill payment, one of its open bills)
  const [vendorSearch, setVendorSearch] = useState("");
  const [otherVendor, setOtherVendor] = useState("");
  const [billId, setBillId] = useState("");
  const vendorId = otherVendor ? Number(otherVendor) : row.vendorId;
  const vendor = useGetVendor(vendorId, { query: { queryKey: getGetVendorQueryKey(vendorId) } });
  const vendors = useListVendors({ search: vendorSearch.trim() || undefined, limit: 50 });
  const billParams: ListBillsParams = { vendor_id: vendorId, limit: 200 };
  const bills = useListBills(billParams, { query: { enabled: isBill && !!otherVendor, queryKey: getListBillsQueryKey(billParams) } });
  const openBills = (bills.data?.items ?? []).filter((b) => b.vendorId === vendorId && !["draft", "submitted"].includes(b.status) && b.documentType !== "credit_note" && Number(b.outstanding ?? 0) >= 0.01);
  const [wht, setWht] = useState<{ declaration: WhtDeclarationValue; ready: boolean }>({ declaration: {}, ready: true });
  const key = useRef(crypto.randomUUID());
  const correct = useGuarded(useCorrectWhtWithholding({ mutation: { onSuccess: () => { toast({ title: t("Correction recorded — the original is kept beside it", "سُجِّل التصحيح — ويُحتفظ بالأصل بجانبه") }); key.current = crypto.randomUUID(); onDone(); } } }));
  // a filed month's treatment is asked for the REVERSAL here (the re-entry's own month is asked by its preview)
  const needsTreatment = row.status === "withheld" && monthFilingStatus !== "unfiled";
  const ready = reason.trim().length >= 10 && (!needsTreatment || !!treatment) && (!reenter || (Number(amount) > 0 && wht.ready && (!isBill || !otherVendor || !!billId)));
  return (
    <div className="mt-3 rounded border border-border p-3 space-y-3 text-sm" data-testid={`wht-correct-panel-${row.id}`}>
      <p className="font-medium">{t("Correct this payment", "تصحيح هذه الدفعة")} — {n(row.vendorName, row.vendorNameAr)} · {fmtDate(row.paymentDate)} · <span className="font-mono" dir="ltr">{money(row.baseAmount)}</span></p>
      <p className="text-xs text-muted-foreground">{t("The payment is REVERSED (a mirror of its entry; the original record is kept unchanged) and, if you re-enter it, the corrected payment is recorded through the same pay path. Both are linked to this correction.", "تُعكس الدفعة (قيد معاكس لقيدها؛ ويُحتفظ بالسجل الأصلي دون تغيير)، وإذا أعدت إدخالها تُسجَّل الدفعة المصححة عبر مسار الدفع نفسه. ويرتبط كلاهما بهذا التصحيح.")}</p>
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="sm:col-span-2"><Label className="text-xs text-muted-foreground">{t("Why is it corrected? (kept with the record)", "سبب التصحيح (يُحفظ مع السجل)")}</Label>
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="wht-correct-reason" /></div>
        <div><Label className="text-xs text-muted-foreground">{t("Reversal dated", "تاريخ العكس")}</Label>
          <Input type="date" dir="ltr" value={date} onChange={(e) => setDate(e.target.value)} data-testid="wht-correct-date" /></div>
      </div>
      {needsTreatment && (
        <div className="rounded bg-secondary/30 p-2 space-y-1 text-xs" role="radiogroup" aria-label={t("Filed month treatment", "معالجة الشهر المُقدَّم")} data-testid="wht-correct-treatment">
          <p className="font-medium">{t(`${row.returnPeriod}'s return is recorded as filed. It is not rewritten silently — how is this correction reported?`, `إقرار ${row.returnPeriod} مُسجَّل بأنه مُقدَّم. لا يُعاد كتابته بصمت — كيف يُقرَّر هذا التصحيح؟`)}</p>
          <label className="flex items-center gap-2"><input type="radio" name={`wht-corr-treatment-${row.id}`} className="accent-primary" checked={treatment === "subsequent_period"} onChange={() => setTreatment("subsequent_period")} data-testid="wht-correct-subsequent" />
            {t("In the return of the correction's month (subsequent period — recommended by the accountant)", "في إقرار شهر التصحيح (فترة لاحقة — يوصي بها المحاسب)")}</label>
          <label className="flex items-center gap-2"><input type="radio" name={`wht-corr-treatment-${row.id}`} className="accent-primary" checked={treatment === "amendment"} onChange={() => setTreatment("amendment")} data-testid="wht-correct-amendment" />
            {t("By amending the filed return", "بتعديل الإقرار المُقدَّم")}</label>
        </div>
      )}
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" className="accent-primary" checked={reenter} onChange={(e) => setReenter(e.target.checked)} data-testid="wht-correct-reenter" />
        {t("Re-enter the corrected payment (untick only if the payment never happened, e.g. it was entered twice)", "إعادة إدخال الدفعة المصححة (ألغِ التحديد فقط إن لم تحدث الدفعة، كأن تكون أُدخلت مرتين)")}</label>
      {reenter && (
        <div className="space-y-2" data-testid="wht-correct-reentry">
          <div className="grid gap-2 sm:grid-cols-3">
            <div><Label className="text-xs text-muted-foreground">{t("Amount credited to the supplier", "المبلغ المقيَّد للمورد")}</Label>
              <Input dir="ltr" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="wht-correct-amount" /></div>
            <div><Label className="text-xs text-muted-foreground">{t("Paid on", "تاريخ الدفع")}</Label>
              <Input type="date" dir="ltr" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} data-testid="wht-correct-paid-at" /></div>
            <BankPicker value={bank} onChange={setBank} testId="wht-correct-bank" label={t("Paid from (default: the original's bank)", "دُفع من (افتراضيًا: بنك الدفعة الأصلية)")} />
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <div><Label className="text-xs text-muted-foreground">{t("Find another supplier (if it was the wrong one)", "ابحث عن مورد آخر (إن كان المورد خطأ)")}</Label>
              <Input value={vendorSearch} onChange={(e) => setVendorSearch(e.target.value)} data-testid="wht-correct-vendor-search" /></div>
            <div><Label className="text-xs text-muted-foreground">{t("Supplier", "المورد")}</Label>
              <Select value={otherVendor} onValueChange={(v) => { setOtherVendor(v); setBillId(""); }}>
                <SelectTrigger className="h-9 text-sm" data-testid="wht-correct-vendor"><SelectValue placeholder={n(row.vendorName, row.vendorNameAr)} /></SelectTrigger>
                <SelectContent>{(vendors.data?.items ?? []).map((x) => <SelectItem key={x.id} value={String(x.id)}>{n(x.name, x.nameAr)}</SelectItem>)}</SelectContent>
              </Select></div>
            {isBill ? (otherVendor ? (
              <div><Label className="text-xs text-muted-foreground">{t("Its bill", "فاتورته")}</Label>
                <Select value={billId} onValueChange={setBillId}>
                  <SelectTrigger className="h-9 text-sm" data-testid="wht-correct-bill"><SelectValue placeholder={t("Choose the bill", "اختر الفاتورة")} /></SelectTrigger>
                  <SelectContent>{openBills.map((b) => <SelectItem key={b.id} value={String(b.id)}>{b.billNumber} · {fmtNum(Number(b.outstanding ?? 0))}</SelectItem>)}</SelectContent>
                </Select></div>
            ) : <p className="text-xs text-muted-foreground self-end">{t("Re-entered against the same bill", "يُعاد إدخالها على الفاتورة نفسها")} ({row.document ?? "—"})</p>) : (
              <div><Label className="text-xs text-muted-foreground">{t("What the money is", "طبيعة المبلغ")}</Label>
                <Select value={classification} onValueChange={setClassification}>
                  <SelectTrigger className="h-9 text-sm" data-testid="wht-correct-classification"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="advance">{t("Advance", "دفعة مقدمة")}</SelectItem>
                    <SelectItem value="security_deposit">{t("Refundable deposit", "تأمين مسترد")}</SelectItem>
                    <SelectItem value="erroneous">{t("Erroneous payment", "دفعة خاطئة")}</SelectItem>
                    <SelectItem value="unknown">{t("Not yet identified", "غير محددة بعد")}</SelectItem>
                  </SelectContent>
                </Select></div>
            )}
          </div>
          {vendor.data && (
            <WhtFields vendorId={vendorId} residency={vendor.data.residency} defaultType={vendor.data.whtDefaultPaymentType}
              amount={Number(amount) || 0} date={paidAt}
              {...(isBill ? {} : { classification: classification as "advance" | "security_deposit" | "erroneous" | "unknown", allocatedAmount: 0 })}
              onChange={(declaration, ok) => setWht({ declaration, ready: ok })} />
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!ready || correct.isPending} data-testid="wht-correct-submit"
          onClick={() => correct.mutate({ id: row.id, data: {
            reason: reason.trim(), date, filedMonthTreatment: needsTreatment ? (treatment || null) : null, idempotencyKey: key.current,
            reentry: reenter ? {
              amount: Number(amount), paidAt, bankAccountId: bank ? Number(bank) : null,
              ...(isBill ? (billId ? { billId: Number(billId) } : {}) : { vendorId: otherVendor ? Number(otherVendor) : null, classification: classification as "advance" }),
              ...wht.declaration,
            } : null,
          } })}>
          {reenter ? t("Reverse and re-enter", "عكس وإعادة إدخال") : t("Reverse only", "عكس فقط")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>{t("Cancel", "إلغاء")}</Button>
      </div>
    </div>
  );
}

/** One withholding's lineage — original → reversal → corrected — and the state its month was in. Read-only. */
export function WhtLineageView({ id }: { id: number }) {
  const { t, n } = useLanguage();
  const l = useGetWhtWithholdingLineage(id, { query: { queryKey: getGetWhtWithholdingLineageQueryKey(id) } });
  if (!l.data) return <p className="text-xs text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>;
  const d = l.data;
  const line = (w: WhtWithholding) => `${fmtDate(w.paymentDate)} · ${n(w.vendorName, w.vendorNameAr)} · ${fmtNum(w.baseAmount)} · ${w.status === "withheld" ? `${whtTypeLabel(w.paymentType, t)} ${fmtNum(w.whtAmount)}` : notSubjectLabel(w.notSubjectReason, t)}`;
  return (
    <div className="text-xs space-y-1 rounded bg-secondary/20 p-2" data-testid={`wht-lineage-${id}`}>
      {d.corrects && <p>{t("Re-enters the corrected payment", "يعيد إدخال الدفعة المصححة")}: <span dir="auto">{line(d.corrects)}</span></p>}
      <p>{t("Original", "الأصل")}: <span dir="auto">{line(d.withholding)}</span> · {t("return", "الإقرار")} <span className="font-mono" dir="ltr">{d.state.returnPeriod}</span> ({whtFilingStatusLabel(d.state.filingStatus, t)}; {whtMonthStatusLabel(d.state.monthStatus, t)})</p>
      {d.correction && (
        <p data-testid={`wht-lineage-correction-${id}`}>
          {t("Reversed", "عُكست")} {fmtDate(d.correction.correctedOn)} — {d.correction.reason} · {t("reported in", "تُقرَّر في")} <span className="font-mono" dir="ltr">{d.correction.reversalReturnPeriod}</span>
          {d.correction.filedMonthTreatment ? ` · ${whtTreatmentLabel(d.correction.filedMonthTreatment, t)}` : ""}
          {d.correction.originalFilingId != null ? ` · ${t("the month was filed", "كان الشهر مُقدَّمًا")}` : ""}
          {d.correction.remittedAtCorrection > 0 ? ` · ${t("remitted at the time", "المسدَّد حينها")} ${fmtNum(d.correction.remittedAtCorrection)}` : ""}
        </p>
      )}
      {d.reentry && <p data-testid={`wht-lineage-reentry-${id}`}>{t("Corrected", "المصحح")}: <span dir="auto">{line(d.reentry)}</span> · {t("return", "الإقرار")} <span className="font-mono" dir="ltr">{d.reentry.returnPeriod}</span></p>}
      {d.correction && !d.reentry && (d.correction.correctedBillPaymentId != null || d.correction.correctedSupplierPaymentId != null) && <p>{t("Re-entered to a supplier with no withholding record", "أُعيد إدخالها لمورد بلا سجل استقطاع")}</p>}
    </div>
  );
}
