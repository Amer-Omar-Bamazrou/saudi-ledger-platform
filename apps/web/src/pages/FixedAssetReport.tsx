/**
 * FIXED ASSETS — the roll-forward and the register-to-GL reconciliation
 * (FA-G, 2026-09-22). Record: docs/product/fixed-assets-decision-pack.md §11, §26.
 *
 * 🔴 The reconciliation is the point of the page, so it is at the TOP and it
 * states both figures. A control either reconciles or it does not — a state,
 * not a judgement, so the status palette is used here exactly as CLAUDE.md §4
 * permits — and when it does not, the reader's next act is to open the account,
 * which is why the difference and the account's name travel with the verdict.
 *
 * 🔴 Cost and accumulated depreciation share a unit and sit on one table;
 * nothing on this page puts a ratio on the same axis as money.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { PageHeader, Panel } from "@/components/kit";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, AlertTriangle } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { DualDate } from "@/components/DualDate";
import { Link } from "wouter";
import { businessToday } from "@workspace/shared";
import type { FixedAssetReport as Report } from "@workspace/api-client-react";

const Money = ({ v }: { v: number }) => <span className="tabular-nums whitespace-nowrap" dir="ltr">{fmtNum(v)}</span>;

export default function FixedAssetReport() {
  const { t } = useLanguage();
  const today = businessToday();
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);

  const { data, isLoading, error } = useQuery<Report>({
    queryKey: ["fixed-asset-report", from, to],
    queryFn: () => apiFetch(`/assets/report?from=${from}&to=${to}`),
  });

  return (
    <div className="space-y-6" data-testid="page-fixed-asset-report">
      <PageHeader
        title={t("Fixed assets — movement and reconciliation", "الأصول الثابتة — الحركة والمطابقة")}
        description={t("The IAS 16.73(e) roll-forward for the window — what the company held, what it bought, what left, and what it holds now — and the question underneath it: does the register still agree with the general ledger?",
             "حركة الأصول وفق المعيار المحاسبي الدولي 16 (73/هـ) خلال الفترة — ما كانت تملكه المنشأة وما اشترته وما خرج وما تملكه الآن — والسؤال الذي تحتها: هل ما زال السجل متفقًا مع دفتر الأستاذ؟")}
        actions={
          <div className="flex flex-wrap gap-3 items-end">
            <div className="space-y-1"><Label className="text-[13px] text-muted-foreground">{t("From", "من")}</Label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="report-from" dir="ltr" className="w-40" /></div>
            <div className="space-y-1"><Label className="text-[13px] text-muted-foreground">{t("To", "إلى")}</Label><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} data-testid="report-to" dir="ltr" className="w-40" /></div>
          </div>
        }
      >
        <Link href="/assets" className="mt-2 inline-block text-sm text-primary hover:underline" data-testid="link-register">{t("The register →", "السجل ←")}</Link>
      </PageHeader>

      {isLoading && <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>}
      {error && <p className="text-sm text-destructive">{t("The report could not be loaded.", "تعذر تحميل التقرير.")} {(error as Error).message}</p>}

      {data && (
        <>
          <Panel
            flush
            data-testid="reconciliation"
            className={data.reconciles ? "" : "border-negative/40"}
            title={
              <span className="flex flex-wrap items-center gap-2">
                {data.reconciles
                  ? <><CheckCircle2 className="w-4 h-4 text-positive" />{t("The register and the ledger agree", "السجل ودفتر الأستاذ متفقان")}</>
                  : <><AlertTriangle className="w-4 h-4 text-negative" />{t("The register and the ledger DISAGREE", "السجل ودفتر الأستاذ غير متفقين")}</>}
                <Badge variant="outline" className="text-[11px] font-normal" data-testid="reconciles">{data.reconciles ? "reconciles" : "differs"}</Badge>
              </span>
            }
          >
            {data.controls.length === 0 && <p className="text-sm text-muted-foreground px-5 py-4" data-testid="no-controls">{t("There are no asset categories yet, so there is nothing to reconcile.", "لا توجد فئات أصول بعد، فلا شيء يُطابَق.")}</p>}
            <div className="divide-y divide-border/70">
              {data.controls.map((c, i) => (
                <div key={i} className="px-5 py-3" data-testid={`control-${c.id}-${c.categoryName}`}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <Badge className={c.status === "pass" ? "bg-positive-surface/20 text-positive" : "bg-negative-surface/20 text-negative"} data-testid={`control-status-${c.id}-${c.categoryName}`}>
                      {c.status === "pass" ? t("Agrees", "متفق") : t("Differs", "مختلف")}
                    </Badge>
                    <span className="text-sm font-medium">{c.categoryName}</span>
                    <span className="text-[13px] text-muted-foreground">{c.title}</span>
                    <span className="ms-auto flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
                      <span><span className="text-muted-foreground">{t("Register", "السجل")}:</span> <Money v={c.register} /></span>
                      <span><span className="text-muted-foreground">{t("Ledger", "دفتر الأستاذ")}:</span> <Money v={c.ledger} /></span>
                      {c.status !== "pass" && <span className="text-negative">{t("Difference", "الفرق")}: <Money v={c.difference} /></span>}
                    </span>
                  </div>
                  {c.status !== "pass" && <p className="text-[13px] text-muted-foreground mt-1.5">{c.detail}</p>}
                </div>
              ))}
            </div>
          </Panel>

          <Panel
            flush
            data-testid="movement"
            title={t("Movement", "الحركة")}
            footer={
              <p className="text-xs text-muted-foreground">
                {t("Every figure is an EVENT in the window, not a balance read at the end of it — so an asset bought and disposed of inside the window appears in both additions and disposals, which is the movement a reader most needs to see.",
                   "كل رقم هنا حدثٌ داخل الفترة لا رصيدًا في نهايتها — ولذلك يظهر الأصل الذي اشتُري واستُبعد داخل الفترة في الإضافات والاستبعادات معًا، وهي الحركة التي يحتاج القارئ إلى رؤيتها أكثر من غيرها.")}
              </p>
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border">
                  {[t("Category", "الفئة"), t("Opening cost", "التكلفة الافتتاحية"), t("Additions", "الإضافات"), t("Disposals", "الاستبعادات"), t("Closing cost", "التكلفة الختامية"), t("Opening accum.", "المجمع الافتتاحي"), t("Charge", "إهلاك الفترة"), t("On disposals", "على الاستبعادات"), t("Closing accum.", "المجمع الختامي"), t("NBV", "الصافي")].map((h, i) => (
                    <th key={i} className={`px-3 ${i === 0 ? "text-start" : "text-end"}`}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {data.movement.map((m) => (
                    <tr key={m.categoryId} className="border-b border-border/70 hover:bg-muted/40 transition-colors" data-testid={`movement-${m.categoryName}`}>
                      <td className="py-3 px-3 min-w-[9rem]">{m.categoryName}</td>
                      <td className="py-3 px-3 text-end"><Money v={m.openingCost} /></td>
                      <td className="py-3 px-3 text-end"><Money v={m.additions} /></td>
                      <td className="py-3 px-3 text-end"><Money v={m.disposalsCost} /></td>
                      <td className="py-3 px-3 text-end font-semibold"><Money v={m.closingCost} /></td>
                      <td className="py-3 px-3 text-end text-muted-foreground"><Money v={m.openingAccumulated} /></td>
                      <td className="py-3 px-3 text-end text-muted-foreground"><Money v={m.charge} /></td>
                      <td className="py-3 px-3 text-end text-muted-foreground"><Money v={m.disposalsAccumulated} /></td>
                      <td className="py-3 px-3 text-end text-muted-foreground"><Money v={m.closingAccumulated} /></td>
                      <td className="py-3 px-3 text-end font-semibold"><Money v={m.closingNetBookValue} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr className="font-semibold">
                  <td className="py-3 px-3">{t("Total", "الإجمالي")}</td>
                  <td className="py-3 px-3 text-end"><Money v={data.totals.openingCost} /></td>
                  <td className="py-3 px-3 text-end"><Money v={data.totals.additions} /></td>
                  <td className="py-3 px-3 text-end"><Money v={data.totals.disposalsCost} /></td>
                  <td className="py-3 px-3 text-end" data-testid="total-closing-cost"><Money v={data.totals.closingCost} /></td>
                  <td className="py-3 px-3 text-end"><Money v={data.totals.openingAccumulated} /></td>
                  <td className="py-3 px-3 text-end"><Money v={data.totals.charge} /></td>
                  <td className="py-3 px-3 text-end"><Money v={data.totals.disposalsAccumulated} /></td>
                  <td className="py-3 px-3 text-end"><Money v={data.totals.closingAccumulated} /></td>
                  <td className="py-3 px-3 text-end" data-testid="total-nbv"><Money v={data.totals.closingNetBookValue} /></td>
                </tr></tfoot>
              </table>
            </div>
          </Panel>

          <div className="grid gap-6 lg:grid-cols-2 items-start">
            <Panel flush data-testid="additions-list" title={t(`Additions (${data.additions.length})`, `الإضافات (${data.additions.length})`)}>
                {data.additions.length === 0 ? <p className="text-sm text-muted-foreground px-5 py-4">{t("None in this window.", "لا شيء في هذه الفترة.")}</p> : (
                  <table className="w-full text-sm"><tbody>
                    {data.additions.map((a) => (
                      <tr key={a.assetId} className="border-b border-border/70 last:border-b-0 hover:bg-muted/40 transition-colors" data-testid={`addition-${a.assetNumber}`}>
                        <td className="py-3 px-3">
                          <Link href={`/assets/${a.assetId}`} className="font-medium text-primary hover:underline">{a.name}</Link>
                          <span className="block text-xs text-muted-foreground tabular-nums" dir="ltr">{a.assetNumber} · {a.categoryName}</span>
                        </td>
                        <td className="py-3 px-3 text-[13px] text-muted-foreground whitespace-nowrap"><DualDate date={a.date} inline /></td>
                        <td className="py-3 px-3 text-end"><Money v={a.cost} /></td>
                      </tr>
                    ))}
                  </tbody></table>
                )}
            </Panel>

            <Panel
              flush
              data-testid="disposals-list"
              title={t(`Disposals (${data.disposals.length})`, `الاستبعادات (${data.disposals.length})`)}
            >
                {data.disposals.length === 0 ? <p className="text-sm text-muted-foreground px-5 py-4">{t("None in this window.", "لا شيء في هذه الفترة.")}</p> : (
                  <>
                    <table className="w-full text-sm"><tbody>
                      {data.disposals.map((d) => (
                        <tr key={d.assetId} className="border-b border-border/70 hover:bg-muted/40 transition-colors" data-testid={`disposal-${d.assetNumber}`}>
                          <td className="py-3 px-3">
                            <Link href={`/assets/${d.assetId}`} className="font-medium text-primary hover:underline">{d.name}</Link>
                            <span className="block text-xs text-muted-foreground tabular-nums" dir="ltr">{d.assetNumber} · {d.kind}</span>
                          </td>
                          <td className="py-3 px-3 text-[13px] text-muted-foreground whitespace-nowrap"><DualDate date={d.date} inline /></td>
                          <td className="py-3 px-3 text-end text-[13px] whitespace-nowrap"><span className="text-muted-foreground">{t("proceeds", "المتحصلات")}</span> <Money v={d.proceeds} /></td>
                          <td className="py-3 px-3 text-end"><Money v={d.gainLoss} /></td>
                        </tr>
                      ))}
                    </tbody></table>
                    <p className="text-sm px-5 py-3" data-testid="disposal-gain-loss">
                      <span className="font-medium">{t("Result of the window's disposals", "نتيجة استبعادات الفترة")}: <Money v={data.disposalGainLoss} /></span>
                      <span className="block mt-0.5 text-xs text-muted-foreground">
                        {t("IAS 16.68: the result of a disposal is not revenue. It sits in other income or expense, never in sales.",
                           "المعيار 16 (68): نتيجة الاستبعاد ليست إيرادًا. فهي ضمن الإيرادات أو المصروفات الأخرى، لا ضمن المبيعات.")}
                      </span>
                    </p>
                  </>
                )}
            </Panel>
          </div>

          <Panel
            flush
            data-testid="zakat-feed"
            title={t("Net fixed assets, for Zakat", "صافي الأصول الثابتة، لأغراض الزكاة")}
            description={t("Zakat takes the BOOK figures (Zakat Regulations Art. 48(1)(b), 49, 63(2)) — the same closing net book value as above, stated once so the two cannot disagree. Income tax uses a different basis entirely; see the Art. 17 pool.",
                   "تعتمد الزكاة الأرقام الدفترية (لائحة الزكاة المواد 48(1)(ب) و49 و63(2)) — وهي صافي القيمة الدفترية الختامية نفسها أعلاه، تُذكر مرة واحدة كي لا يختلفا. أما ضريبة الدخل فتقوم على أساس مختلف تمامًا؛ انظر وعاء المادة 17.")}
          >
              <table className="w-full text-sm"><tbody>
                {data.zakatNetFixedAssets.map((z) => (
                  <tr key={z.categoryName} className="border-b border-border/70 last:border-b-0" data-testid={`zakat-${z.categoryName}`}>
                    <td className="py-3 px-3">{z.categoryName}</td>
                    <td className="py-3 px-3 text-end"><Money v={z.netBookValue} /></td>
                  </tr>
                ))}
              </tbody></table>
          </Panel>
        </>
      )}
    </div>
  );
}
