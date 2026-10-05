/**
 * Phase 16A — Withholding tax (docs/product/phase-16-17-tax-treasury-decision-pack.md §2).
 *
 * Every figure is the WHT ledger's and the GL's — the page computes nothing.
 * Invariant W1 is SHOWN (GL WHT payable beside the ledger, exact). The delay
 * fine is labelled an ESTIMATE and never posted. Statuses are words in neutral
 * ink (a due date is a state, but nothing here colours a judgement).
 */
import { useEffect, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetWhtOverview, useGetWhtReturn, useGetWhtAnnual, useListWhtExceptions, useListWhtReliefs, useListWhtRates, useListVendors,
  useRemitWht, useReverseWhtRemittance, useCreateWhtRelief, useApproveWhtRelief, useRevokeWhtRelief, useDeleteWhtRelief,
  getGetWhtReturnQueryKey, getListWhtExceptionsQueryKey,
} from "@workspace/api-client-react";
import { fmtDate, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { useGuarded } from "@/lib/singleSubmit";
import { ReportExportButtons } from "@/components/reports/ReportExport";
import { BankPicker } from "@/components/payments/shared";
import { legalRef, notSubjectLabel, whtMonthStatusLabel, whtTypeLabel, whtNatureBasisLabel, whtFilingStatusLabel, whtTreatmentLabel, WHT_TYPES } from "@/lib/taxLabels";
import { WhtDeterminationLines } from "@/components/payments/WhtFields";
import { WhtFilingCard, WhtCorrectionPanel, WhtLineageView } from "@/components/tax/WhtCorrection";
import { businessToday } from "@workspace/shared";

const money = (x: number | null | undefined) => (x == null ? "—" : fmtNum(x));
const pct = (r: number) => `${(r * 100).toFixed(2)}%`;

const TABS = ["months", "return", "annual", "exceptions", "reliefs", "rates"] as const;

export default function WithholdingTax() {
  const { t, lang } = useLanguage();
  const qc = useQueryClient();
  // the tab AND the month live in the URL, so a link (the navigation, a drill from Treasury, an obligations row —
  // QA-16: it used to land on the latest month whatever row was clicked) opens what it names, and back/forward and
  // a reload keep it
  const search = useSearch();
  const [location, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const fromUrl = params.get("tab");
  const tab = (TABS as readonly string[]).includes(fromUrl ?? "") ? fromUrl! : "months";
  const periodParam = params.get("period");
  const period = periodParam && /^\d{4}-(0[1-9]|1[0-2])$/.test(periodParam) ? periodParam : "";
  const go = (next: { tab?: string; period?: string }) => {
    const q = new URLSearchParams(search);
    if (next.tab) q.set("tab", next.tab);
    if (next.period) q.set("period", next.period);
    navigate(`${location}?${q.toString()}`, { replace: true });
  };
  const setTab = (next: string) => go({ tab: next });
  const setPeriod = (next: string) => go({ period: next });
  const ov = useGetWhtOverview();
  const refresh = () => qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === "string" && ((q.queryKey[0] as string).startsWith("/api/tax") || (q.queryKey[0] as string).startsWith("/api/treasury")) });

  const months = ov.data?.months ?? [];
  const chosen = period || months[0]?.period || "";

  return (
    <div className="space-y-6" data-testid="wht-page">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t("Withholding tax", "ضريبة الاستقطاع")}</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
          {t("Tax withheld from payments to non-resident suppliers (Income Tax Law Art. 68), at the rate Implementing Regulations Art. 63(1) fixes for each payment's declared nature. Remitted to ZATCA within the first 10 days of the following month.",
            "الضريبة المستقطعة من المدفوعات للموردين غير المقيمين (نظام ضريبة الدخل المادة 68)، بالنسبة التي تحددها المادة 63(1) من اللائحة التنفيذية لطبيعة كل دفعة كما يُصرَّح بها. وتُسدَّد للهيئة خلال الأيام العشرة الأولى من الشهر التالي.")}
        </p>
      </div>

      {ov.data && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="wht-summary">
          <Card className="border-border"><CardContent className="pt-4">
            <p className="text-xs text-muted-foreground">{t("WHT payable in the ledger", "ضريبة الاستقطاع المستحقة في الدفاتر")}</p>
            <p className="text-xl font-semibold font-mono" dir="ltr" data-testid="wht-gl">{money(ov.data.reconciliation.glWhtPayable)}</p>
            <p className="text-xs mt-1" data-testid="wht-reconciles">
              {ov.data.reconciliation.reconciles
                ? t("Equals the WHT records exactly.", "يطابق سجلات الاستقطاع تمامًا.")
                : t(`Does NOT equal the WHT records (${fmtNum(ov.data.reconciliation.whtLedger)}).`, `لا يطابق سجلات الاستقطاع (${fmtNum(ov.data.reconciliation.whtLedger)}).`)}
            </p>
          </CardContent></Card>
          <Card className="border-border"><CardContent className="pt-4">
            <p className="text-xs text-muted-foreground">{t("Payments the rule could not judge", "مدفوعات تعذّر الحكم عليها")}</p>
            <p className="text-xl font-semibold" data-testid="wht-undeclared-count">{ov.data.exceptions.undeclaredResidency}</p>
            <p className="text-xs text-muted-foreground mt-1">{t("paid to suppliers whose residency is not declared", "دُفعت لموردين لم يُصرَّح بإقامتهم")}</p>
          </CardContent></Card>
          <Card className="border-border"><CardContent className="pt-4">
            <p className="text-xs text-muted-foreground">{t("Possibly missed withholding", "استقطاع ربما فات")}</p>
            <p className="text-xl font-semibold" data-testid="wht-missed-count">{ov.data.exceptions.possiblyMissed}</p>
            <p className="text-xs text-muted-foreground mt-1">{t("paid to suppliers now declared non-resident, with no withholding", "دُفعت لموردين صُرِّح الآن بأنهم غير مقيمين دون استقطاع")}</p>
          </CardContent></Card>
          <Card className="border-border"><CardContent className="pt-4">
            <p className="text-xs text-muted-foreground">{t("Pending classification", "بانتظار التصنيف")}</p>
            <p className="text-xl font-semibold" data-testid="wht-pending-count">{ov.data.exceptions.pendingClassification}</p>
            <p className="text-xs text-muted-foreground mt-1">{t("paid to non-residents for a purpose not yet identified — nothing withheld", "دُفعت لغير مقيمين لغرض لم يُحدَّد بعد — دون استقطاع")}</p>
          </CardContent></Card>
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab} dir={lang === "ar" ? "rtl" : "ltr"}>
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="months" data-testid="wht-tab-months">{t("Months", "الأشهر")}</TabsTrigger>
          <TabsTrigger value="return" data-testid="wht-tab-return">{t("Monthly return", "الإقرار الشهري")}</TabsTrigger>
          <TabsTrigger value="annual" data-testid="wht-tab-annual">{t("Annual information", "البيانات السنوية")}</TabsTrigger>
          <TabsTrigger value="exceptions" data-testid="wht-tab-exceptions">{t("Exceptions", "الاستثناءات")}</TabsTrigger>
          <TabsTrigger value="reliefs" data-testid="wht-tab-reliefs">{t("Treaty reliefs", "إعفاءات الاتفاقيات")}</TabsTrigger>
          <TabsTrigger value="rates" data-testid="wht-tab-rates">{t("Rates", "النسب")}</TabsTrigger>
        </TabsList>

        <TabsContent value="months">
          <Card className="border-border"><CardContent className="pt-4">
            {ov.isLoading ? <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>
              : months.length === 0 ? <p className="text-sm text-muted-foreground" data-testid="wht-no-months">{t("Nothing has been withheld yet. A payment to a non-resident supplier withholds when it is paid.", "لم يُستقطع شيء بعد. تُستقطع الضريبة عند دفع مبلغ لمورد غير مقيم.")}</p>
              : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm" data-testid="wht-months-table">
                    <thead><tr className="border-b border-border text-xs text-muted-foreground">
                      {[t("Month", "الشهر"), t("Due", "الاستحقاق"), t("Status", "الحالة"), t("Form 06", "النموذج 06"), t("Paid to suppliers", "المدفوع للموردين"), t("Withheld", "المستقطع"), t("Remitted", "المُسدَّد"), t("Outstanding", "المتبقي"), t("Delay-fine estimate", "تقدير غرامة التأخير"), ""].map((h) => <th key={h} className="text-start pb-2 pe-3 font-medium whitespace-nowrap">{h}</th>)}
                    </tr></thead>
                    <tbody>{months.map((m) => (
                      <tr key={m.period} className="border-b border-border/50" data-testid={`wht-month-${m.period}`}>
                        <td className="py-2 pe-3 font-mono" dir="ltr">{m.period}</td>
                        <td className="py-2 pe-3">{fmtDate(m.dueDate)}</td>
                        <td className="py-2 pe-3" data-testid={`wht-month-status-${m.period}`}>{whtMonthStatusLabel(m.status, t)}</td>
                        <td className="py-2 pe-3 text-xs" data-testid={`wht-month-filing-${m.period}`}>{whtFilingStatusLabel(m.filingStatus, t)}</td>
                        <td className="py-2 pe-3 text-end font-mono" dir="ltr">{money(m.base)}</td>
                        <td className="py-2 pe-3 text-end font-mono" dir="ltr">{money(m.withheld)}</td>
                        <td className="py-2 pe-3 text-end font-mono" dir="ltr">{money(m.remitted)}</td>
                        <td className="py-2 pe-3 text-end font-mono font-semibold" dir="ltr" data-testid={`wht-month-outstanding-${m.period}`}>{money(m.outstanding)}</td>
                        <td className="py-2 pe-3 text-end font-mono" dir="ltr">{m.delayFineEstimate ? money(m.delayFineEstimate.amount) : "—"}</td>
                        <td className="py-2"><Button size="sm" variant="outline" className="h-7" onClick={() => go({ tab: "return", period: m.period })} data-testid={`wht-open-${m.period}`}>{t("Open", "فتح")}</Button></td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            <p className="text-xs text-muted-foreground mt-3">{t("The delay fine is a STATUTORY ESTIMATE — 1 % of the unpaid tax for each full 30 days after the due date (Art. 77(A); none under 30 days). It is never posted; a fine actually paid is recorded with the remittance.", "غرامة التأخير تقدير نظامي — 1% من الضريبة غير المسددة عن كل 30 يومًا كاملة بعد الاستحقاق (المادة 77(أ)؛ ولا شيء دون 30 يومًا). لا تُرحَّل أبدًا؛ وتُسجَّل الغرامة المدفوعة فعلًا مع التسديد.")}</p>
          </CardContent></Card>
        </TabsContent>

        <TabsContent value="return">{chosen ? <MonthReturn period={chosen} months={months.map((m) => m.period)} onPeriod={setPeriod} onChanged={refresh} /> : <p className="text-sm text-muted-foreground p-4">{t("No month to show yet.", "لا يوجد شهر لعرضه بعد.")}</p>}</TabsContent>
        <TabsContent value="annual"><Annual /></TabsContent>
        <TabsContent value="exceptions"><Exceptions /></TabsContent>
        <TabsContent value="reliefs"><Reliefs onChanged={refresh} /></TabsContent>
        <TabsContent value="rates"><Rates /></TabsContent>
      </Tabs>
    </div>
  );
}

function MonthReturn({ period, months, onPeriod, onChanged }: { period: string; months: string[]; onPeriod: (p: string) => void; onChanged: () => void }) {
  const { t, n } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const r = useGetWhtReturn(period, { query: { queryKey: getGetWhtReturnQueryKey(period) } });
  const [bank, setBank] = useState("");
  const [fine, setFine] = useState("");
  const [paidAt, setPaidAt] = useState("");
  const [reference, setReference] = useState("");
  const [reverseId, setReverseId] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  // Q1: the row being corrected, and the row whose lineage is open
  const [correctingId, setCorrectingId] = useState<number | null>(null);
  const [lineageId, setLineageId] = useState<number | null>(null);
  useEffect(() => { setCorrectingId(null); setLineageId(null); }, [period]);
  // One idempotency key per remittance the person means: a retried or duplicated request replays the
  // first instead of paying ZATCA twice (the server honours it — audit A-3). A new key per month and
  // after each recorded remittance.
  const remitKey = useRef(crypto.randomUUID());
  useEffect(() => { remitKey.current = crypto.randomUUID(); }, [period]);
  const done = (msg: [string, string]) => () => { onChanged(); qc.invalidateQueries({ queryKey: getGetWhtReturnQueryKey(period) }); toast({ title: t(...msg) }); setFine(""); setReference(""); setReverseId(null); setReason(""); remitKey.current = crypto.randomUUID(); };
  const remit = useGuarded(useRemitWht({ mutation: { onSuccess: done(["Remittance recorded", "تم تسجيل التسديد"]) } }));
  const reverse = useGuarded(useReverseWhtRemittance({ mutation: { onSuccess: done(["Remittance reversed", "تم عكس التسديد"]) } }));
  const d = r.data;
  return (
    <div className="space-y-4" data-testid="wht-return">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Label className="text-xs text-muted-foreground">{t("Month", "الشهر")}</Label>
          <Select value={period} onValueChange={onPeriod}>
            <SelectTrigger className="mt-1 h-8 w-40 text-sm" data-testid="wht-return-period"><SelectValue /></SelectTrigger>
            {/* a month named by a link or the URL is offered even with no withholding on it (it reads as nothing withheld) */}
            <SelectContent>{(months.includes(period) ? months : [period, ...months]).map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <ReportExportButtons report="wht-return" params={{ period }} />
      </div>
      {!d ? <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p> : (
        <>
          <p className="text-sm" data-testid="wht-return-status">
            {t("Due", "الاستحقاق")} {fmtDate(d.dueDate)} · {whtMonthStatusLabel(d.status, t)} · {t("withheld", "المستقطع")} <span className="font-mono" dir="ltr">{money(d.totals.taxWithheld)}</span> · {t("remitted", "المُسدَّد")} <span className="font-mono" dir="ltr">{money(d.totals.remitted)}</span> · {t("outstanding", "المتبقي")} <span className="font-mono font-semibold" dir="ltr" data-testid="wht-return-outstanding">{money(d.totals.outstanding)}</span>
            {d.delayFineEstimate && <> · {t("delay-fine estimate", "تقدير غرامة التأخير")} <span className="font-mono" dir="ltr">{money(d.delayFineEstimate.amount)}</span></>}
          </p>
          <WhtFilingCard period={period} filing={d.filing} liveTax={d.totals.taxWithheld} onDone={() => { onChanged(); qc.invalidateQueries({ queryKey: getGetWhtReturnQueryKey(period) }); }} />
          <Card className="border-border"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Return lines (ZATCA Form 06)", "بنود الإقرار (النموذج 06)")}</CardTitle></CardHeader><CardContent>
            <div className="overflow-x-auto"><table className="w-full text-sm" data-testid="wht-return-lines">
              <thead><tr className="border-b border-border text-xs text-muted-foreground">{[t("Row", "البند"), t("Payment", "الدفعة"), t("Payment total", "إجمالي المدفوع"), t("Tax withheld", "الضريبة المستقطعة")].map((h) => <th key={h} className="text-start pb-2 pe-3 font-medium">{h}</th>)}</tr></thead>
              <tbody>{d.lines.map((l) => (
                <tr key={l.paymentType} className={`border-b border-border/50 ${l.applicable ? "" : "text-muted-foreground"}`}>
                  <td className="py-1.5 pe-3 font-mono" dir="ltr">{l.formRow}</td><td className="py-1.5 pe-3">{whtTypeLabel(l.paymentType, t)}</td>
                  <td className="py-1.5 pe-3 text-end font-mono" dir="ltr">{money(l.paymentTotal)}</td><td className="py-1.5 pe-3 text-end font-mono" dir="ltr">{money(l.taxWithheld)}</td>
                </tr>
              ))}</tbody>
            </table></div>
            <p className="text-xs text-muted-foreground mt-2">{t("Rows 07 and 08 (services to head office / an associated company) carry no separate band since MoF Resolution 25; a related party's service is shown on its nature's row (open question W-4).", "البندان 07 و08 (خدمات للمركز الرئيسي/شركة مرتبطة) بلا شريحة مستقلة منذ القرار 25؛ تُعرض خدمة الطرف المرتبط في بند طبيعتها (سؤال مفتوح W-4).")}</p>
          </CardContent></Card>
          <Card className="border-border"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Schedule of beneficiaries", "جدول المستفيدين")}</CardTitle></CardHeader><CardContent>
            {d.schedule.length === 0 ? <p className="text-sm text-muted-foreground">{t("No payment withheld in this month.", "لا استقطاع في هذا الشهر.")}</p> : (
              <div className="overflow-x-auto"><table className="w-full text-sm" data-testid="wht-schedule">
                <thead><tr className="border-b border-border text-xs text-muted-foreground">{[t("Date", "التاريخ"), t("Beneficiary", "المستفيد"), t("Country", "الدولة"), t("Nature", "النوع"), t("Base", "المبلغ"), t("Rate", "النسبة"), t("WHT", "الضريبة"), t("Cash paid", "النقد المدفوع"), t("Document", "المستند"), t("Why", "السبب"), ""].map((h, i) => <th key={`${h}-${i}`} className="text-start pb-2 pe-3 font-medium whitespace-nowrap">{h}</th>)}</tr></thead>
                <tbody>{d.schedule.map((w) => (
                  <tr key={w.id} className="border-b border-border/50" data-testid={`wht-schedule-row-${w.id}`}>
                    <td className="py-1.5 pe-3 whitespace-nowrap">{fmtDate(w.paymentDate)}</td><td className="py-1.5 pe-3">{n(w.vendorName, w.vendorNameAr)}</td><td className="py-1.5 pe-3">{w.vendorCountry ?? "—"}</td>
                    <td className="py-1.5 pe-3">{whtTypeLabel(w.paymentType, t)}{w.natureBasis && <span className="block text-[11px] text-muted-foreground">{whtNatureBasisLabel(w.natureBasis, t)}</span>}</td><td className="py-1.5 pe-3 text-end font-mono" dir="ltr">{money(w.baseAmount)}</td>
                    <td className="py-1.5 pe-3 text-end font-mono" dir="ltr">{pct(w.rate)}{w.treatyReliefId ? ` (${t("treaty", "اتفاقية")})` : ""}</td>
                    <td className="py-1.5 pe-3 text-end font-mono" dir="ltr">{money(w.whtAmount)}</td><td className="py-1.5 pe-3 text-end font-mono" dir="ltr">{money(w.cashPaid)}</td>
                    <td className="py-1.5 pe-3 font-mono text-xs" dir="ltr">{w.document ?? "—"}</td>
                    <td className="py-1.5 pe-3 text-xs min-w-48"><details data-testid={`wht-why-${w.id}`}><summary className="cursor-pointer text-primary">{t("Determination", "التحديد")}</summary><WhtDeterminationLines d={w.determination} testId={`wht-determination-${w.id}`} /></details></td>
                    <td className="py-1.5 pe-3 text-xs whitespace-nowrap">
                      {w.correction
                        ? <span data-testid={`wht-corrected-later-${w.id}`}>{t("Corrected — reported in", "صُحِّحت — تُقرَّر في")} <span className="font-mono" dir="ltr">{w.correction.reversalReturnPeriod}</span></span>
                        : <Button size="sm" variant="outline" className="h-7" onClick={() => setCorrectingId(w.id)} data-testid={`wht-correct-${w.id}`}>{t("Correct", "تصحيح")}</Button>}
                      <Button size="sm" variant="ghost" className="h-7" onClick={() => setLineageId(lineageId === w.id ? null : w.id)} data-testid={`wht-history-${w.id}`}>{t("History", "السجل")}</Button>
                    </td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
            {lineageId != null && <div className="mt-2"><WhtLineageView id={lineageId} /></div>}
            {correctingId != null && (() => {
              const row = [...d.schedule, ...d.excluded, ...d.pending].find((x) => x.id === correctingId);
              return row ? <WhtCorrectionPanel row={row} monthFilingStatus={d.filing.status} onCancel={() => setCorrectingId(null)}
                onDone={() => { setCorrectingId(null); onChanged(); qc.invalidateQueries({ queryKey: getGetWhtReturnQueryKey(period) }); }} /> : null;
            })()}
            {d.excluded.length > 0 && (
              <div className="mt-3" data-testid="wht-excluded">
                <p className="text-xs font-medium mb-1">{t("Payments to non-residents NOT subject, with the reason recorded", "مدفوعات لغير مقيمين غير خاضعة، مع السبب المسجَّل")}</p>
                <ul className="text-xs space-y-0.5">{d.excluded.map((w) => <li key={w.id} data-testid={`wht-excluded-${w.id}`}>{fmtDate(w.paymentDate)} · {n(w.vendorName, w.vendorNameAr)} · <span className="font-mono" dir="ltr">{money(w.baseAmount)}</span> · {notSubjectLabel(w.notSubjectReason, t)}{w.notSubjectNote ? ` — ${w.notSubjectNote}` : ""}{w.paymentType ? ` · ${whtTypeLabel(w.paymentType, t)}` : ""}{" "}
                  {!w.correction && <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => setCorrectingId(w.id)} data-testid={`wht-correct-${w.id}`}>{t("Correct", "تصحيح")}</Button>}</li>)}</ul>
              </div>
            )}
            {d.pending.length > 0 && (
              <div className="mt-3" data-testid="wht-pending">
                <p className="text-xs font-medium mb-1">{t("Payments to non-residents PENDING classification — nothing withheld or claimed until their purpose is identified", "مدفوعات لغير مقيمين بانتظار التصنيف — لا استقطاع ولا مطالبة حتى يُحدَّد غرضها")}</p>
                <ul className="text-xs space-y-0.5">{d.pending.map((w) => <li key={w.id} data-testid={`wht-pending-${w.id}`}>{fmtDate(w.paymentDate)} · {n(w.vendorName, w.vendorNameAr)} · <span className="font-mono" dir="ltr">{money(w.baseAmount)}</span> · {w.document ?? "—"}{" "}
                  {!w.correction && <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => setCorrectingId(w.id)} data-testid={`wht-correct-${w.id}`}>{t("Correct", "تصحيح")}</Button>}</li>)}</ul>
                <p className="text-[11px] text-muted-foreground mt-1">{t("Classify each on the supplier payment: a deposit or an erroneous payment is not subject; identified as an advance, its nature decides.", "صنّف كلًّا منها في دفعة المورد: التأمين أو الدفعة الخاطئة غير خاضعين؛ وإذا حُدِّدت كدفعة مقدمة فطبيعتها هي الفيصل.")}</p>
              </div>
            )}
            {d.corrected.length > 0 && (
              <div className="mt-3" data-testid="wht-corrected">
                <p className="text-xs font-medium mb-1">{t("Corrected in this return — reversed, kept on record, out of the totals", "صُحِّحت في هذا الإقرار — معكوسة، محفوظة في السجل، خارج المجاميع")}</p>
                <ul className="text-xs space-y-0.5">{d.corrected.map((w) => (
                  <li key={w.id} data-testid={`wht-corrected-${w.id}`}><span className="line-through">{fmtDate(w.paymentDate)} · {n(w.vendorName, w.vendorNameAr)} · <span className="font-mono" dir="ltr">{money(w.baseAmount)}</span> · {w.status === "withheld" ? `${whtTypeLabel(w.paymentType, t)} ${money(w.whtAmount)}` : notSubjectLabel(w.notSubjectReason, t)}</span>
                    {w.correction ? ` — ${fmtDate(w.correction.correctedOn)}: ${w.correction.reason}${w.correction.filedMonthTreatment ? ` (${whtTreatmentLabel(w.correction.filedMonthTreatment, t)})` : ""}` : ""}{" "}
                    <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => setLineageId(lineageId === w.id ? null : w.id)} data-testid={`wht-history-${w.id}`}>{t("History", "السجل")}</Button></li>
                ))}</ul>
              </div>
            )}
            {d.adjustments.length > 0 && (
              <div className="mt-3" data-testid="wht-adjustments">
                <p className="text-xs font-medium mb-1">{t("Corrections of earlier, filed months reported in this return (subsequent period)", "تصحيحات لأشهر سابقة مُقدَّمة تُقرَّر في هذا الإقرار (فترة لاحقة)")}</p>
                <ul className="text-xs space-y-0.5">{d.adjustments.map((a) => (
                  <li key={a.correctionId} data-testid={`wht-adjustment-${a.correctionId}`}>{fmtDate(a.correctedOn)} · {n(a.vendorName, a.vendorNameAr)} · {t("from", "من")} <span className="font-mono" dir="ltr">{a.originalReturnPeriod}</span> · {whtTypeLabel(a.paymentType, t)} · <span className="font-mono" dir="ltr">{money(a.whtAmount)}</span> — {a.reason}</li>
                ))}</ul>
              </div>
            )}
          </CardContent></Card>
          <Card className="border-border"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Remittances to ZATCA", "التسديدات للهيئة")}</CardTitle></CardHeader><CardContent className="space-y-3">
            {d.remittances.length > 0 && (
              <ul className="text-sm space-y-1" data-testid="wht-remittances">{d.remittances.map((x) => (
                <li key={x.id} className="flex flex-wrap items-center gap-2">
                  <span>{fmtDate(x.paidAt)} · <span className="font-mono" dir="ltr">{money(x.amount)}</span>{x.fineAmount > 0 ? <> + {t("fine", "غرامة")} <span className="font-mono" dir="ltr">{money(x.fineAmount)}</span></> : null} · {x.bankName}{x.reference ? ` · ${x.reference}` : ""}</span>
                  {x.reversal ? <span className="text-xs text-muted-foreground">{t("Reversed", "معكوس")} {fmtDate(x.reversal.reversedOn)}: {x.reversal.reason}</span>
                    : <Button size="sm" variant="ghost" className="h-7" onClick={() => setReverseId(x.id)} data-testid={`wht-reverse-${x.id}`}>{t("Reverse", "عكس")}</Button>}
                </li>
              ))}</ul>
            )}
            {reverseId != null && (
              <div className="flex flex-wrap items-end gap-2">
                <div className="grow min-w-48"><Label className="text-xs text-muted-foreground">{t("Why is it being reversed?", "لماذا يُعكس؟")}</Label><Input value={reason} onChange={(e) => setReason(e.target.value)} data-testid="wht-reverse-reason" /></div>
                <Button size="sm" disabled={reason.trim().length < 3 || reverse.isPending} onClick={() => reverse.mutate({ id: reverseId, data: { reason } })} data-testid="wht-reverse-confirm">{t("Reverse remittance", "عكس التسديد")}</Button>
                <Button size="sm" variant="ghost" onClick={() => setReverseId(null)}>{t("Cancel", "إلغاء")}</Button>
              </div>
            )}
            {d.totals.outstanding > 0 && (
              <div className="grid gap-3 sm:grid-cols-4 items-end" data-testid="wht-remit-form">
                <BankPicker value={bank} onChange={setBank} testId="wht-remit-bank" label={t("Paid from", "دُفع من")} />
                <div><Label className="text-xs text-muted-foreground">{t("Paid on", "تاريخ الدفع")}</Label><Input type="date" dir="ltr" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} data-testid="wht-remit-date" /></div>
                <div><Label className="text-xs text-muted-foreground">{t("Delay fine actually paid (optional)", "غرامة تأخير مدفوعة فعلًا (اختياري)")}</Label><Input dir="ltr" inputMode="decimal" value={fine} onChange={(e) => setFine(e.target.value)} data-testid="wht-remit-fine" /></div>
                <div><Label className="text-xs text-muted-foreground">{t("SADAD reference", "رقم سداد")}</Label><Input dir="ltr" value={reference} onChange={(e) => setReference(e.target.value)} data-testid="wht-remit-reference" /></div>
                <Button className="sm:col-span-4 w-full sm:w-auto" disabled={!bank || remit.isPending} data-testid="wht-remit-submit"
                  onClick={() => remit.mutate({ period, data: { bankAccountId: Number(bank), paidAt: paidAt || null, fineAmount: fine ? Number(fine) : null, reference: reference || null, idempotencyKey: remitKey.current } })}>
                  {t(`Record remittance of ${fmtNum(d.totals.outstanding)}`, `تسجيل تسديد ${fmtNum(d.totals.outstanding)}`)}
                </Button>
              </div>
            )}
          </CardContent></Card>
        </>
      )}
    </div>
  );
}

function Annual() {
  const { t, n } = useLanguage();
  const [fy, setFy] = useState("");
  const a = useGetWhtAnnual(fy ? { fiscal_year: Number(fy) } : undefined);
  const d = a.data;
  return (
    <Card className="border-border"><CardContent className="pt-4 space-y-3" data-testid="wht-annual">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><Label className="text-xs text-muted-foreground">{t("Fiscal year", "السنة المالية")}</Label><Input dir="ltr" className="mt-1 h-8 w-32" placeholder={d ? String(d.fiscalYear.label) : ""} value={fy} onChange={(e) => setFy(e.target.value.replace(/\D/g, ""))} data-testid="wht-annual-year" /></div>
        <ReportExportButtons report="wht-annual" params={{ fiscal_year: d ? String(d.fiscalYear.label) : fy }} />
      </div>
      {!d ? <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p> : (
        <>
          <p className="text-sm">{fmtDate(d.fiscalYear.startDate)} – {fmtDate(d.fiscalYear.endDate)} · {t("due", "الاستحقاق")} {fmtDate(d.dueDate)}</p>
          {d.beneficiaries.length === 0 ? <p className="text-sm text-muted-foreground">{t("No withholding in this fiscal year.", "لا استقطاع في هذه السنة المالية.")}</p> : (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead><tr className="border-b border-border text-xs text-muted-foreground">{[t("Beneficiary", "المستفيد"), t("Country", "الدولة"), t("Registration no.", "رقم التسجيل"), t("Nature", "النوع"), t("Payments", "الدفعات"), t("Paid", "المدفوع"), t("WHT", "الضريبة")].map((h) => <th key={h} className="text-start pb-2 pe-3 font-medium">{h}</th>)}</tr></thead>
              <tbody>{d.beneficiaries.map((b) => {
                // Art. 68(B)(3): the year-end list gives each beneficiary's name, address and registration number — a
                // non-resident shown in "SA", or with no country or number, is flagged for checking (the same figures, read)
                const incomplete = !b.country || b.country.toUpperCase() === "SA" || !b.foreignTaxId;
                return (
                  <tr key={`${b.vendorId}-${b.paymentType}`} className="border-b border-border/50" data-testid={`wht-annual-row-${b.vendorId}-${b.paymentType}`}>
                    <td className="py-1.5 pe-3">{n(b.vendorName, b.vendorNameAr)}{incomplete && <span className="block text-xs text-muted-foreground" data-testid={`wht-annual-incomplete-${b.vendorId}`}>{t("Check the supplier's country and registration number on its record", "تحقّق من دولة المورد ورقم تسجيله في سجله")}</span>}</td>
                    <td className="py-1.5 pe-3">{b.country ?? "—"}</td><td className="py-1.5 pe-3 font-mono" dir="ltr">{b.foreignTaxId ?? "—"}</td><td className="py-1.5 pe-3">{whtTypeLabel(b.paymentType, t)}</td><td className="py-1.5 pe-3">{b.payments}</td><td className="py-1.5 pe-3 text-end font-mono" dir="ltr">{money(b.base)}</td><td className="py-1.5 pe-3 text-end font-mono" dir="ltr">{money(b.wht)}</td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          )}
          {d && d.beneficiaries.some((b) => !b.country || b.country.toUpperCase() === "SA" || !b.foreignTaxId) && (
            <p className="text-xs text-muted-foreground">{t("The annual information lists each beneficiary's name, address and registration number if available (Art. 68(B)(3)). A non-resident recorded with the country \"SA\", or with no country or registration number, is marked above.", "تتضمن البيانات السنوية اسم كل مستفيد وعنوانه ورقم تسجيله إن وُجد (المادة 68(ب)(3)). يُعلَّم أعلاه غير المقيم المسجَّل بدولة \"SA\" أو بلا دولة أو رقم تسجيل.")}</p>
          )}
        </>
      )}
    </CardContent></Card>
  );
}

function Exceptions() {
  const { t } = useLanguage();
  const [kind, setKind] = useState<"undeclared" | "possibly_missed" | "pending_classification">("undeclared");
  const x = useListWhtExceptions({ kind }, { query: { queryKey: getListWhtExceptionsQueryKey({ kind }) } });
  return (
    <Card className="border-border"><CardContent className="pt-4 space-y-3" data-testid="wht-exceptions">
      <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
        <SelectTrigger className="h-8 w-80 text-sm" data-testid="wht-exceptions-kind"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="undeclared">{t("Paid to a supplier whose residency is not declared", "دُفع لمورد لم يُصرَّح بإقامته")}</SelectItem>
          <SelectItem value="possibly_missed">{t("Paid to a non-resident with no withholding", "دُفع لغير مقيم دون استقطاع")}</SelectItem>
          <SelectItem value="pending_classification">{t("Paid to a non-resident, purpose not identified (pending)", "دُفع لغير مقيم لغرض غير محدد (معلّق)")}</SelectItem>
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{kind === "pending_classification"
        ? t("Nothing was withheld from these payments because their purpose is not identified (accountant Q2). Classify each on the supplier payment; if it turns out to be taxable consideration, the payer is liable for the tax not withheld (Art. 68(C)) — take it to your adviser.", "لم يُستقطع شيء من هذه المدفوعات لأن غرضها غير محدد. صنّف كلًّا منها في دفعة المورد؛ فإن تبيّن أنها مقابل خاضع، فالدافع مسؤول عن الضريبة غير المستقطعة (المادة 68(ج)) — راجع مستشارك.")
        : kind === "undeclared"
        ? t("No withholding was judged: declare each supplier's residency. If it is non-resident, the payer is liable for the tax it did not withhold (Art. 68(C)).", "لم يُحكم بأي استقطاع: صرِّح بإقامة كل مورد. فإن كان غير مقيم، فالدافع مسؤول عن الضريبة التي لم يستقطعها (المادة 68(ج)).")
        : t("The supplier is now declared non-resident, and these payments carry no withholding record — declared after paying, or paid before Phase 16. Review each with your adviser.", "صُرِّح الآن بأن المورد غير مقيم، وهذه المدفوعات بلا سجل استقطاع — صُرِّح بعد الدفع أو دُفعت قبل المرحلة 16. راجع كلًّا منها مع مستشارك.")}</p>
      {x.data && (
        <>
          <p className="text-sm" data-testid="wht-exceptions-total">{t(`${x.data.total} payment(s)`, `${x.data.total} دفعة`)}{x.data.total > x.data.shown ? t(` — the first ${x.data.shown} shown`, ` — أول ${x.data.shown} معروضة`) : ""}</p>
          <ul className="text-sm space-y-1">{x.data.items.map((i) => <li key={`${i.sourceKind}-${i.paymentId}`}>{fmtDate(i.paidAt)} · {i.vendorName} · {i.document ?? "—"} · <span className="font-mono" dir="ltr">{money(i.amount)}</span></li>)}</ul>
        </>
      )}
    </CardContent></Card>
  );
}

function Reliefs({ onChanged }: { onChanged: () => void }) {
  const { t, n } = useLanguage();
  const { toast } = useToast();
  const list = useListWhtReliefs();
  // the supplier picker searches the server (the vendor list is paged): only non-residents can hold a relief
  const [vendorSearch, setVendorSearch] = useState("");
  const vendors = useListVendors({ search: vendorSearch.trim() || undefined, limit: 200 });
  const vendorItems = (vendors.data?.items ?? []).filter((v) => v.residency === "non_resident");
  const vendorsCapped = (vendors.data?.page.total ?? 0) > (vendors.data?.items.length ?? 0);
  // 🔴 The reduced rate starts EMPTY. It used to start at "0" — a full exemption one approval away from every
  // payment to that supplier withholding nothing (QA 2026-10-04). A rate is a declaration the person types,
  // never a default (pack §2.3); "0" stays possible, typed, for a treaty that exempts.
  const blankRelief = { vendorId: "", paymentType: "technical_consulting", reducedRate: "", treatyCountry: "", zatcaApprovalReference: "", residencyCertificateReference: "", validFrom: "", validTo: "" };
  const [form, setForm] = useState(blankRelief);
  const rateOk = /^0(\.\d{1,4})?$/.test(form.reducedRate.trim());
  // Q-d (QA 2026-10-04): the statutory rate the database will judge this relief against — the schedule's rate for the
  // nature in force on the relief's first day (trigger wht_relief_rate), read from the server's own rate table. A
  // relief AT that rate relieves nothing (accepted — whether to refuse it is the owner's question); one above it is
  // refused. Said here, before anything is recorded; the server still decides.
  const rates = useListWhtRates();
  const asOfRelief = /^\d{4}-\d{2}-\d{2}$/.test(form.validFrom) ? form.validFrom : businessToday();
  const statutory = (rates.data ?? []).find((r) => r.paymentType === form.paymentType && r.effectiveFrom <= asOfRelief && (r.effectiveTo == null || r.effectiveTo >= asOfRelief))?.rate;
  const typedBp = rateOk ? Math.round(Number(form.reducedRate) * 10_000) : null;
  const statutoryBp = statutory != null ? Math.round(statutory * 10_000) : null;
  const [revoke, setRevoke] = useState<{ id: number; reason: string } | null>(null);
  const done = (msg: [string, string]) => () => { onChanged(); list.refetch(); toast({ title: t(...msg) }); setRevoke(null); };
  const create = useGuarded(useCreateWhtRelief({ mutation: { onSuccess: () => { done(["Relief recorded — pending approval", "سُجِّل الإعفاء — بانتظار الاعتماد"])(); setForm(blankRelief); } } }));
  const approve = useGuarded(useApproveWhtRelief({ mutation: { onSuccess: done(["Relief approved", "اعتُمد الإعفاء"]) } }));
  const revokeM = useGuarded(useRevokeWhtRelief({ mutation: { onSuccess: done(["Relief revoked", "أُلغي الإعفاء"]) } }));
  const remove = useGuarded(useDeleteWhtRelief({ mutation: { onSuccess: done(["Relief deleted", "حُذف الإعفاء"]) } }));
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <div className="space-y-4" data-testid="wht-reliefs">
      <p className="text-sm text-muted-foreground">{t("A treaty's reduced rate applies at source only with ZATCA's approval of the treaty request (ZATCA DTA circular §4.1), inside its validity window, and once approved here. Otherwise the statutory rate is withheld and the beneficiary claims a refund.", "لا تُطبَّق النسبة المخفضة للاتفاقية عند المنبع إلا بموافقة الهيئة على طلب الاتفاقية، وضمن مدة صلاحيتها، وبعد اعتمادها هنا. وإلا تُستقطع النسبة النظامية ويطالب المستفيد بالاسترداد.")}</p>
      <Card className="border-border"><CardContent className="pt-4 grid gap-3 sm:grid-cols-4 items-end">
        <div className="sm:col-span-2 grid gap-2 sm:grid-cols-2">
          <div><Label className="text-xs text-muted-foreground">{t("Find the supplier", "ابحث عن المورد")}</Label><Input value={vendorSearch} onChange={(e) => setVendorSearch(e.target.value)} data-testid="wht-relief-vendor-search" /></div>
          <div><Label className="text-xs text-muted-foreground">{t("Supplier (non-resident)", "المورد (غير مقيم)")}</Label>
            <Select value={form.vendorId} onValueChange={(v) => setForm((f) => ({ ...f, vendorId: v }))}><SelectTrigger className="h-9 text-sm" data-testid="wht-relief-vendor"><SelectValue placeholder={t("Choose…", "اختر…")} /></SelectTrigger>
              <SelectContent>{vendorItems.map((v) => <SelectItem key={v.id} value={String(v.id)}>{n(v.name, v.nameAr)}</SelectItem>)}</SelectContent></Select>
            {vendorsCapped && <p className="text-xs text-muted-foreground mt-1">{t("More suppliers match than are listed — narrow the search.", "يطابق موردون أكثر مما هو معروض — ضيّق البحث.")}</p>}
            {vendors.data && vendorItems.length === 0 && <p className="text-xs text-muted-foreground mt-1">{t("No non-resident supplier matches. Declare a supplier non-resident on its record first.", "لا يطابق أي مورد غير مقيم. صرِّح بأن المورد غير مقيم في سجله أولًا.")}</p>}
          </div>
        </div>
        <div><Label className="text-xs text-muted-foreground">{t("Nature", "النوع")}</Label>
          <Select value={form.paymentType} onValueChange={(v) => setForm((f) => ({ ...f, paymentType: v }))}><SelectTrigger className="h-9 text-sm" data-testid="wht-relief-type"><SelectValue /></SelectTrigger>
            <SelectContent>{WHT_TYPES.map((x) => <SelectItem key={x} value={x}>{whtTypeLabel(x, t)}</SelectItem>)}</SelectContent></Select></div>
        <div><Label className="text-xs text-muted-foreground">{t("Reduced rate (0.05 = 5 %)", "النسبة المخفضة (0.05 = 5%)")}</Label><Input dir="ltr" inputMode="decimal" placeholder="0.05" value={form.reducedRate} onChange={set("reducedRate")} data-testid="wht-relief-rate" />
          <p className="text-[11px] text-muted-foreground mt-1">{t("The treaty's rate as a fraction, below the statutory rate. 0 is a full exemption — type it only if the treaty exempts.", "نسبة الاتفاقية ككسر، أقل من النسبة النظامية. الصفر إعفاء كامل — اكتبه فقط إذا كانت الاتفاقية تُعفي.")}</p>
          {statutory != null && <p className="text-[11px] text-muted-foreground" data-testid="wht-relief-statutory">{t(`Statutory rate for this nature: ${pct(statutory)}.`, `النسبة النظامية لهذا النوع: ${pct(statutory)}.`)}</p>}
          {typedBp != null && statutoryBp != null && typedBp === statutoryBp && <p className="text-[11px]" data-testid="wht-relief-equals-statutory">{t("This equals the statutory rate — the relief would withhold exactly what no relief withholds. Check the treaty's rate.", "هذه هي النسبة النظامية نفسها — لن يغيّر الإعفاء ما يُستقطع شيئًا. تحقّق من نسبة الاتفاقية.")}</p>}
          {typedBp != null && statutoryBp != null && typedBp > statutoryBp && <p className="text-[11px]" data-testid="wht-relief-above-statutory">{t("This is above the statutory rate — a treaty only reduces it, and the server refuses it.", "هذه أعلى من النسبة النظامية — الاتفاقية تخفّضها فقط، ويرفضها الخادم.")}</p>}
        </div>
        <div><Label className="text-xs text-muted-foreground">{t("Treaty country (ISO code)", "دولة الاتفاقية (الرمز)")}</Label><Input dir="ltr" maxLength={2} value={form.treatyCountry} onChange={set("treatyCountry")} data-testid="wht-relief-country" /></div>
        <div><Label className="text-xs text-muted-foreground">{t("ZATCA approval reference", "رقم موافقة الهيئة")}</Label><Input dir="ltr" value={form.zatcaApprovalReference} onChange={set("zatcaApprovalReference")} data-testid="wht-relief-approval" /></div>
        <div><Label className="text-xs text-muted-foreground">{t("Residency certificate reference", "رقم شهادة الإقامة الضريبية")}</Label><Input dir="ltr" value={form.residencyCertificateReference} onChange={set("residencyCertificateReference")} data-testid="wht-relief-certificate" /></div>
        <div><Label className="text-xs text-muted-foreground">{t("Valid from", "صالح من")}</Label><Input type="date" dir="ltr" value={form.validFrom} onChange={set("validFrom")} data-testid="wht-relief-from" /></div>
        <div><Label className="text-xs text-muted-foreground">{t("Valid to", "صالح حتى")}</Label><Input type="date" dir="ltr" value={form.validTo} onChange={set("validTo")} data-testid="wht-relief-to" /></div>
        <Button className="sm:col-span-4 w-full sm:w-auto" disabled={!form.vendorId || !rateOk || create.isPending} data-testid="wht-relief-create"
          onClick={() => create.mutate({ data: { vendorId: Number(form.vendorId), paymentType: form.paymentType as never, reducedRate: Number(form.reducedRate), treatyCountry: form.treatyCountry.toUpperCase(), zatcaApprovalReference: form.zatcaApprovalReference, residencyCertificateReference: form.residencyCertificateReference, validFrom: form.validFrom, validTo: form.validTo } })}>
          {t("Record relief (pending approval)", "تسجيل الإعفاء (بانتظار الاعتماد)")}
        </Button>
      </CardContent></Card>
      <div className="overflow-x-auto"><table className="w-full text-sm" data-testid="wht-reliefs-table">
        <thead><tr className="border-b border-border text-xs text-muted-foreground">{[t("Supplier", "المورد"), t("Nature", "النوع"), t("Rate", "النسبة"), t("Window", "المدة"), t("ZATCA approval", "موافقة الهيئة"), t("Status", "الحالة"), ""].map((h) => <th key={h} className="text-start pb-2 pe-3 font-medium">{h}</th>)}</tr></thead>
        <tbody>{(list.data ?? []).map((r) => (
          <tr key={r.id} className="border-b border-border/50" data-testid={`wht-relief-${r.id}`}>
            <td className="py-1.5 pe-3">{n(r.vendorName, r.vendorNameAr)}</td><td className="py-1.5 pe-3">{whtTypeLabel(r.paymentType, t)}</td><td className="py-1.5 pe-3 font-mono" dir="ltr">{pct(r.reducedRate)}</td>
            <td className="py-1.5 pe-3 whitespace-nowrap">{fmtDate(r.validFrom)} – {fmtDate(r.validTo)}</td><td className="py-1.5 pe-3 font-mono text-xs" dir="ltr">{r.zatcaApprovalReference}</td>
            <td className="py-1.5 pe-3">{r.status === "pending" ? t("Pending", "معلق") : r.status === "approved" ? t("Approved", "معتمد") : t("Revoked", "ملغى")}</td>
            <td className="py-1.5 flex flex-wrap gap-1">
              {r.status === "pending" && <Button size="sm" variant="outline" className="h-7" onClick={() => approve.mutate({ id: r.id })} data-testid={`wht-relief-approve-${r.id}`}>{t("Approve", "اعتماد")}</Button>}
              {r.status === "pending" && <Button size="sm" variant="ghost" className="h-7" onClick={() => remove.mutate({ id: r.id })}>{t("Delete", "حذف")}</Button>}
              {r.status !== "revoked" && <Button size="sm" variant="ghost" className="h-7" onClick={() => setRevoke({ id: r.id, reason: "" })}>{t("Revoke", "إلغاء")}</Button>}
            </td>
          </tr>
        ))}</tbody>
      </table></div>
      {revoke && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="grow min-w-48"><Label className="text-xs text-muted-foreground">{t("Why is it revoked?", "لماذا يُلغى؟")}</Label><Input value={revoke.reason} onChange={(e) => setRevoke({ ...revoke, reason: e.target.value })} /></div>
          <Button size="sm" disabled={revoke.reason.trim().length < 3} onClick={() => revokeM.mutate({ id: revoke.id, data: { reason: revoke.reason } })}>{t("Revoke relief", "إلغاء الإعفاء")}</Button>
        </div>
      )}
    </div>
  );
}

function Rates() {
  const { t, lang } = useLanguage();
  const rates = useListWhtRates();
  return (
    <Card className="border-border"><CardContent className="pt-4" data-testid="wht-rates">
      <div className="overflow-x-auto"><table className="w-full text-sm">
        <thead><tr className="border-b border-border text-xs text-muted-foreground">{[t("Form row", "البند"), t("Payment", "الدفعة"), t("Rate", "النسبة"), t("In force from", "سارية من"), t("Source", "المصدر")].map((h) => <th key={h} className="text-start pb-2 pe-3 font-medium">{h}</th>)}</tr></thead>
        <tbody>{(rates.data ?? []).map((r) => (
          <tr key={r.id} className="border-b border-border/50"><td className="py-1.5 pe-3 font-mono" dir="ltr">{r.formRow}</td><td className="py-1.5 pe-3">{lang === "ar" ? r.nameAr : r.nameEn}</td><td className="py-1.5 pe-3 font-mono" dir="ltr">{pct(r.rate)}</td><td className="py-1.5 pe-3">{fmtDate(r.effectiveFrom)}</td><td className="py-1.5 pe-3 text-xs" title={r.legalReference}>{legalRef(r.legalReference, lang)}</td></tr>
        ))}</tbody>
      </table></div>
      <p className="text-xs text-muted-foreground mt-2">{t("The regulation's table, read-only. A payment uses the rate in force on its date, and keeps it.", "جدول اللائحة للقراءة فقط. تأخذ كل دفعة النسبة السارية في تاريخها وتحتفظ بها.")}</p>
    </CardContent></Card>
  );
}
