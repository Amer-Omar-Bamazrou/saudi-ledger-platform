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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, AlertTriangle, Layers } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { DualDate } from "@/components/DualDate";
import { Link } from "wouter";
import { businessToday } from "@workspace/shared";
import type { FixedAssetReport as Report } from "@workspace/api-client-react";

const Money = ({ v }: { v: number }) => <span className="font-mono" dir="ltr">{fmtNum(v)}</span>;

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
    <div className="p-4 sm:p-6 space-y-5 max-w-full" data-testid="page-fixed-asset-report">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2"><Layers className="w-6 h-6" />{t("Fixed assets — movement and reconciliation", "الأصول الثابتة — الحركة والمطابقة")}</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
          {t("The IAS 16.73(e) roll-forward for the window — what the company held, what it bought, what left, and what it holds now — and the question underneath it: does the register still agree with the general ledger?",
             "حركة الأصول وفق المعيار المحاسبي الدولي 16 (73/هـ) خلال الفترة — ما كانت تملكه المنشأة وما اشترته وما خرج وما تملكه الآن — والسؤال الذي تحتها: هل ما زال السجل متفقًا مع دفتر الأستاذ؟")}
        </p>
        <Link href="/assets" className="text-sm text-primary hover:underline" data-testid="link-register">{t("The register →", "السجل ←")}</Link>
      </div>

      <div className="flex flex-wrap gap-3 items-end">
        <div><Label className="text-xs">{t("From", "من")}</Label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="report-from" dir="ltr" className="w-44" /></div>
        <div><Label className="text-xs">{t("To", "إلى")}</Label><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} data-testid="report-to" dir="ltr" className="w-44" /></div>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>}
      {error && <p className="text-sm text-destructive">{t("The report could not be loaded.", "تعذر تحميل التقرير.")} {(error as Error).message}</p>}

      {data && (
        <>
          <Card data-testid="reconciliation">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                {data.reconciles
                  ? <><CheckCircle2 className="w-4 h-4 text-positive" />{t("The register and the ledger agree", "السجل ودفتر الأستاذ متفقان")}</>
                  : <><AlertTriangle className="w-4 h-4 text-negative" />{t("The register and the ledger DISAGREE", "السجل ودفتر الأستاذ غير متفقين")}</>}
                <Badge variant="outline" className="text-[10px]" data-testid="reconciles">{data.reconciles ? "reconciles" : "differs"}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {data.controls.length === 0 && <p className="text-sm text-muted-foreground" data-testid="no-controls">{t("There are no asset categories yet, so there is nothing to reconcile.", "لا توجد فئات أصول بعد، فلا شيء يُطابَق.")}</p>}
              {data.controls.map((c, i) => (
                <div key={i} className="rounded-md border border-border p-3" data-testid={`control-${c.id}-${c.categoryName}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className={c.status === "pass" ? "bg-positive-surface/20 text-positive" : "bg-negative-surface/20 text-negative"} data-testid={`control-status-${c.id}-${c.categoryName}`}>
                      {c.status === "pass" ? t("Agrees", "متفق") : t("Differs", "مختلف")}
                    </Badge>
                    <span className="text-sm font-medium">{c.categoryName}</span>
                    <span className="text-xs text-muted-foreground">{c.title}</span>
                  </div>
                  <div className="mt-1 text-xs flex flex-wrap gap-4">
                    <span>{t("Register", "السجل")}: <Money v={c.register} /></span>
                    <span>{t("Ledger", "دفتر الأستاذ")}: <Money v={c.ledger} /></span>
                    {c.status !== "pass" && <span className="text-negative">{t("Difference", "الفرق")}: <Money v={c.difference} /></span>}
                  </div>
                  {c.status !== "pass" && <p className="text-xs text-muted-foreground mt-1">{c.detail}</p>}
                </div>
              ))}
            </CardContent>
          </Card>

          <Card data-testid="movement">
            <CardHeader className="pb-2"><CardTitle className="text-base">{t("Movement", "الحركة")}</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {[t("Category", "الفئة"), t("Opening cost", "التكلفة الافتتاحية"), t("Additions", "الإضافات"), t("Disposals", "الاستبعادات"), t("Closing cost", "التكلفة الختامية"), t("Opening accum.", "المجمع الافتتاحي"), t("Charge", "إهلاك الفترة"), t("On disposals", "على الاستبعادات"), t("Closing accum.", "المجمع الختامي"), t("NBV", "الصافي")].map((h, i) => (
                    <th key={i} className="text-start pb-2 pe-3 font-medium whitespace-nowrap">{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {data.movement.map((m) => (
                    <tr key={m.categoryId} className="border-b border-border/50" data-testid={`movement-${m.categoryName}`}>
                      <td className="py-2 pe-3">{m.categoryName}</td>
                      <td className="py-2 pe-3 text-end"><Money v={m.openingCost} /></td>
                      <td className="py-2 pe-3 text-end"><Money v={m.additions} /></td>
                      <td className="py-2 pe-3 text-end"><Money v={m.disposalsCost} /></td>
                      <td className="py-2 pe-3 text-end font-semibold"><Money v={m.closingCost} /></td>
                      <td className="py-2 pe-3 text-end text-muted-foreground"><Money v={m.openingAccumulated} /></td>
                      <td className="py-2 pe-3 text-end text-muted-foreground"><Money v={m.charge} /></td>
                      <td className="py-2 pe-3 text-end text-muted-foreground"><Money v={m.disposalsAccumulated} /></td>
                      <td className="py-2 pe-3 text-end text-muted-foreground"><Money v={m.closingAccumulated} /></td>
                      <td className="py-2 pe-3 text-end font-semibold"><Money v={m.closingNetBookValue} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr className="font-semibold border-t border-border">
                  <td className="py-2 pe-3">{t("Total", "الإجمالي")}</td>
                  <td className="py-2 pe-3 text-end"><Money v={data.totals.openingCost} /></td>
                  <td className="py-2 pe-3 text-end"><Money v={data.totals.additions} /></td>
                  <td className="py-2 pe-3 text-end"><Money v={data.totals.disposalsCost} /></td>
                  <td className="py-2 pe-3 text-end" data-testid="total-closing-cost"><Money v={data.totals.closingCost} /></td>
                  <td className="py-2 pe-3 text-end"><Money v={data.totals.openingAccumulated} /></td>
                  <td className="py-2 pe-3 text-end"><Money v={data.totals.charge} /></td>
                  <td className="py-2 pe-3 text-end"><Money v={data.totals.disposalsAccumulated} /></td>
                  <td className="py-2 pe-3 text-end"><Money v={data.totals.closingAccumulated} /></td>
                  <td className="py-2 pe-3 text-end" data-testid="total-nbv"><Money v={data.totals.closingNetBookValue} /></td>
                </tr></tfoot>
              </table>
              <p className="text-[11px] text-muted-foreground mt-2">
                {t("Every figure is an EVENT in the window, not a balance read at the end of it — so an asset bought and disposed of inside the window appears in both additions and disposals, which is the movement a reader most needs to see.",
                   "كل رقم هنا حدثٌ داخل الفترة لا رصيدًا في نهايتها — ولذلك يظهر الأصل الذي اشتُري واستُبعد داخل الفترة في الإضافات والاستبعادات معًا، وهي الحركة التي يحتاج القارئ إلى رؤيتها أكثر من غيرها.")}
              </p>
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card data-testid="additions-list">
              <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t(`Additions (${data.additions.length})`, `الإضافات (${data.additions.length})`)}</CardTitle></CardHeader>
              <CardContent>
                {data.additions.length === 0 ? <p className="text-xs text-muted-foreground">{t("None in this window.", "لا شيء في هذه الفترة.")}</p> : (
                  <table className="w-full text-sm"><tbody>
                    {data.additions.map((a) => (
                      <tr key={a.assetId} className="border-b border-border/50" data-testid={`addition-${a.assetNumber}`}>
                        <td className="py-1.5 pe-2">
                          <Link href={`/assets/${a.assetId}`} className="hover:underline">{a.name}</Link>
                          <span className="block text-[11px] text-muted-foreground font-mono" dir="ltr">{a.assetNumber} · {a.categoryName}</span>
                        </td>
                        <td className="py-1.5 pe-2 text-xs text-muted-foreground"><DualDate date={a.date} inline /></td>
                        <td className="py-1.5 text-end"><Money v={a.cost} /></td>
                      </tr>
                    ))}
                  </tbody></table>
                )}
              </CardContent>
            </Card>

            <Card data-testid="disposals-list">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground">{t(`Disposals (${data.disposals.length})`, `الاستبعادات (${data.disposals.length})`)}</CardTitle>
              </CardHeader>
              <CardContent>
                {data.disposals.length === 0 ? <p className="text-xs text-muted-foreground">{t("None in this window.", "لا شيء في هذه الفترة.")}</p> : (
                  <>
                    <table className="w-full text-sm"><tbody>
                      {data.disposals.map((d) => (
                        <tr key={d.assetId} className="border-b border-border/50" data-testid={`disposal-${d.assetNumber}`}>
                          <td className="py-1.5 pe-2">
                            <Link href={`/assets/${d.assetId}`} className="hover:underline">{d.name}</Link>
                            <span className="block text-[11px] text-muted-foreground font-mono" dir="ltr">{d.assetNumber} · {d.kind}</span>
                          </td>
                          <td className="py-1.5 pe-2 text-xs text-muted-foreground"><DualDate date={d.date} inline /></td>
                          <td className="py-1.5 pe-2 text-end text-xs">{t("proceeds", "المتحصلات")} <Money v={d.proceeds} /></td>
                          <td className="py-1.5 text-end"><Money v={d.gainLoss} /></td>
                        </tr>
                      ))}
                    </tbody></table>
                    <p className="text-xs mt-2" data-testid="disposal-gain-loss">
                      {t("Result of the window's disposals", "نتيجة استبعادات الفترة")}: <Money v={data.disposalGainLoss} />
                      <span className="block text-[11px] text-muted-foreground">
                        {t("IAS 16.68: the result of a disposal is not revenue. It sits in other income or expense, never in sales.",
                           "المعيار 16 (68): نتيجة الاستبعاد ليست إيرادًا. فهي ضمن الإيرادات أو المصروفات الأخرى، لا ضمن المبيعات.")}
                      </span>
                    </p>
                  </>
                )}
              </CardContent>
            </Card>
          </div>

          <Card data-testid="zakat-feed">
            <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Net fixed assets, for Zakat", "صافي الأصول الثابتة، لأغراض الزكاة")}</CardTitle></CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground mb-2">
                {t("Zakat takes the BOOK figures (Zakat Regulations Art. 48(1)(b), 49, 63(2)) — the same closing net book value as above, stated once so the two cannot disagree. Income tax uses a different basis entirely; see the Art. 17 pool.",
                   "تعتمد الزكاة الأرقام الدفترية (لائحة الزكاة المواد 48(1)(ب) و49 و63(2)) — وهي صافي القيمة الدفترية الختامية نفسها أعلاه، تُذكر مرة واحدة كي لا يختلفا. أما ضريبة الدخل فتقوم على أساس مختلف تمامًا؛ انظر وعاء المادة 17.")}
              </p>
              <table className="w-full text-sm"><tbody>
                {data.zakatNetFixedAssets.map((z) => (
                  <tr key={z.categoryName} className="border-b border-border/50" data-testid={`zakat-${z.categoryName}`}>
                    <td className="py-1.5 pe-2">{z.categoryName}</td>
                    <td className="py-1.5 text-end"><Money v={z.netBookValue} /></td>
                  </tr>
                ))}
              </tbody></table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
