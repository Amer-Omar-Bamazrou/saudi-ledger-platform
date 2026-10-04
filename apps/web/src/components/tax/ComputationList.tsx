/**
 * Phase 16B/16C — the computations of one kind (Zakat or income tax), one per
 * frozen fiscal year (decision pack §5), and the act that starts one.
 *
 * Every figure is the server's: the approved amount is the approved version's
 * stored result, the due date is the statutory 120 days after the year-end
 * (Zakat Regulations Art. 102(1); Income Tax Law Art. 60(b)). A computation
 * needs a DECLARED fiscal year — the page says so and names Company Settings;
 * the server's refusal is the backstop ("explain a refusal; do not hide the
 * control", CLAUDE.md §3).
 *
 * 🔴 Q-e (QA 2026-10-04): the list used to render only where the company's
 * CURRENT ownership makes the tax apply — so an income-tax computation of a
 * company now declared Saudi (or a Zakat one of a company now mixed) existed,
 * accrued, and could not be seen or opened. Ownership is undated (a year may
 * have been computed under another), so an existing record is ALWAYS listed;
 * where the tax does not apply today, starting a new one is simply not offered
 * here (whether the server should refuse it is the owner's question, Q-e).
 */
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListTaxComputations, useCreateTaxComputation, useListFiscalYears, getListTaxComputationsQueryKey,
  type ListTaxComputationsKind,
} from "@workspace/api-client-react";
import { fmtDate, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { computationStatusLabel } from "@/lib/taxLabels";
import { useGuarded } from "@/lib/singleSubmit";
import { defaultComputationYear } from "@/lib/taxYears";
import { businessToday } from "@workspace/shared";

/** The 1445H Zakat Regulations apply to fiscal years starting on or after 1/1/2024 (Decision 1007). */
const ZAKAT_REGULATIONS_FROM = "2024-01-01";

export function ComputationList({ kind, canStart = true, notStartedWhy }: { kind: ListTaxComputationsKind; canStart?: boolean; notStartedWhy?: string }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [year, setYear] = useState("");
  const list = useListTaxComputations({ kind }, { query: { queryKey: getListTaxComputationsQueryKey({ kind }) } });
  const fiscal = useListFiscalYears();
  const declared = fiscal.data?.declared === true;
  const existing = new Set((list.data ?? []).map((c) => c.fiscalYear.label));
  const years = (fiscal.data?.periods ?? []).filter((p) => (kind === "zakat" ? p.startDate >= ZAKAT_REGULATIONS_FROM : true) && !existing.has(p.label));
  const suggested = defaultComputationYear(years, businessToday());
  const chosen = year || (suggested ? String(suggested.label) : "");
  const create = useGuarded(useCreateTaxComputation({
    mutation: {
      onSuccess: (c) => {
        qc.invalidateQueries({ queryKey: getListTaxComputationsQueryKey({ kind }) });
        toast({ title: t("Computation started — it computes live from the ledger", "بدأ الاحتساب — يُحسب مباشرة من الدفاتر") });
        navigate(`/tax/computations/${c.id}`);
      },
    },
  }));
  const what = kind === "zakat" ? t("Zakat", "الزكاة") : t("income-tax", "ضريبة الدخل");
  // where the tax does not apply today there is nothing to start — and nothing to show unless a record exists
  if (!canStart && (list.isLoading || (list.data ?? []).length === 0)) return null;

  return (
    <Card className="border-border" data-testid={`tax-computations-${kind}`}>
      <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Computations by fiscal year", "الاحتسابات حسب السنة المالية")}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {list.isLoading ? <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>
          : (list.data ?? []).length === 0 ? <p className="text-sm text-muted-foreground" data-testid="tax-computations-empty">{t(`No ${kind === "zakat" ? "Zakat" : "income-tax"} computation yet.`, `لا يوجد احتساب ${kind === "zakat" ? "زكاة" : "ضريبة دخل"} بعد.`)}</p>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="tax-computations-table">
                <thead><tr className="border-b border-border text-xs text-muted-foreground">
                  {[t("Fiscal year", "السنة المالية"), t("Period", "الفترة"), t("Latest version", "أحدث إصدار"), t("Approved amount", "المبلغ المعتمد"), t("Due", "الاستحقاق"), ""].map((h) => <th key={h} className="text-start pb-2 pe-3 font-medium whitespace-nowrap">{h}</th>)}
                </tr></thead>
                <tbody>{(list.data ?? []).map((c) => {
                  const latest = c.versions[c.versions.length - 1];
                  return (
                    <tr key={c.id} className="border-b border-border/50" data-testid={`tax-computation-row-${c.id}`}>
                      <td className="py-2 pe-3 font-mono" dir="ltr">{c.fiscalYear.label}</td>
                      <td className="py-2 pe-3 whitespace-nowrap">{fmtDate(c.fiscalYear.startDate)} – {fmtDate(c.fiscalYear.endDate)}</td>
                      <td className="py-2 pe-3">{latest ? `v${latest.versionNo} · ${computationStatusLabel(latest.status, t)}` : "—"}</td>
                      <td className="py-2 pe-3 text-end font-mono" dir="ltr" data-testid={`tax-computation-amount-${c.id}`}>{c.approvedAmount == null ? "—" : fmtNum(c.approvedAmount)}</td>
                      <td className="py-2 pe-3 whitespace-nowrap">{fmtDate(c.dueDate)}</td>
                      <td className="py-2"><Link href={`/tax/computations/${c.id}`}><Button size="sm" variant="outline" className="h-7" data-testid={`tax-computation-open-${c.id}`}>{t("Open", "فتح")}</Button></Link></td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          )}

        {!canStart ? (
          <p className="border-t border-border pt-4 text-sm text-muted-foreground" data-testid="tax-computation-not-offered">{notStartedWhy}</p>
        ) : <div className="border-t border-border pt-4" data-testid="tax-computation-create">
          {!fiscal.data ? null : !declared ? (
            <p className="text-sm text-muted-foreground" data-testid="tax-fy-undeclared">
              {t(`A ${kind === "zakat" ? "Zakat" : "income-tax"} year is the company's fiscal year, and this company has not declared one. Declare it in `, `سنة ${kind === "zakat" ? "الزكاة" : "ضريبة الدخل"} هي السنة المالية للشركة، ولم تُعلن هذه الشركة سنتها المالية بعد. أعلنها من `)}
              <Link href="/company" className="underline">{t("Company Settings", "إعدادات الشركة")}</Link>
              {t(" — it is never assumed.", " — ولا تُفترض أبداً.")}
            </p>
          ) : years.length === 0 ? (
            <p className="text-sm text-muted-foreground">{kind === "zakat"
              ? t("Every fiscal year from 2024 on already has a Zakat computation. Years before 2024 are outside the 1445H Regulations (Decision 1007) and are not computed here.", "لكل سنة مالية منذ 2024 احتساب زكاة بالفعل. السنوات قبل 2024 خارج نطاق لائحة 1445هـ (القرار 1007) ولا تُحتسب هنا.")
              : t("Every listed fiscal year already has a computation.", "لكل سنة مالية مدرجة احتساب بالفعل.")}</p>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <Label className="text-xs text-muted-foreground">{t("Fiscal year", "السنة المالية")}</Label>
                <Select value={chosen} onValueChange={setYear}>
                  <SelectTrigger className="mt-1 h-8 w-64 text-sm" data-testid="tax-computation-year"><SelectValue /></SelectTrigger>
                  <SelectContent>{years.map((p) => <SelectItem key={p.label} value={String(p.label)}>{p.label} · {fmtDate(p.startDate)} – {fmtDate(p.endDate)}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <Button size="sm" disabled={!chosen || create.isPending} data-testid="tax-computation-create-submit"
                onClick={() => create.mutate({ data: { kind, fiscalYearLabel: Number(chosen) } })}>
                {create.isPending ? t("Starting…", "جارٍ البدء…") : t(`Start the ${kind === "zakat" ? "Zakat" : "income-tax"} computation`, `بدء احتساب ${kind === "zakat" ? "الزكاة" : "ضريبة الدخل"}`)}
              </Button>
              <p className="text-xs text-muted-foreground basis-full">{t(`A draft ${what} computation moves nothing in the books. Only its approval posts the accrual — after the year has ended.`, `مسودة احتساب ${what} لا تحرّك شيئًا في الدفاتر. اعتمادها وحده يرحّل الاستحقاق — بعد انتهاء السنة.`)}</p>
            </div>
          )}
        </div>}
      </CardContent>
    </Card>
  );
}
