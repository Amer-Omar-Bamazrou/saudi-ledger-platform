/**
 * VAT CAPITAL ASSETS — the Art. 52 adjustment working paper (FA-F, 2026-09-22).
 *
 * Record: docs/product/fixed-assets-decision-pack.md §7, §25.
 *
 * 🔴 Three clocks, and the page says so. The register on /assets depreciates
 * over the ACCOUNTING life; Art. 52 adjusts over 6 or 10 years (or the life, if
 * shorter) counted from the TAX PERIOD of acquisition; Art. 51's fraction runs
 * on the CALENDAR year. A reader who assumes any two of them coincide will
 * chase a difference that is correct.
 *
 * 🔴 Every adjustment of nil carries its REASON. Art. 52(6) ("no change in
 * use") and "nobody has told us what the use was" are the same number and
 * different facts, and a working paper that showed only the number could
 * evidence neither.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Receipt, Info, Pencil } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { Link } from "wouter";
import type { VatAdjustmentReport, VatAdjustmentAsset, VatAdjustmentWindow } from "@workspace/api-client-react";

const BASES: [string, string, string][] = [
  ["exclusive_use", "Used exclusively in one activity", "مستخدم حصريًا في نشاط واحد"],
  ["approved_alternative_method", "An alternative method approved under Art. 51(8)", "طريقة بديلة معتمدة وفق المادة 51(8)"],
  ["year_end_true_up", "The Art. 51(7) year-end true-up", "التسوية السنوية وفق المادة 51(7)"],
  ["other", "Other", "أخرى"],
];

const Money = ({ v }: { v: number }) => <span className="font-mono" dir="ltr">{fmtNum(v)}</span>;

export default function VatCapitalAssets() {
  const { t, lang } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<{ assetId: number; periodIndex: number; assetName: string } | null>(null);

  const { data, isLoading, error } = useQuery<VatAdjustmentReport>({ queryKey: ["vat-adjustments"], queryFn: () => apiFetch("/assets/vat-adjustments") });

  const declare = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiFetch("/assets/vat-adjustments/use-records", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["vat-adjustments"] });
      setEditing(null);
      toast({ title: t("Use recorded", "تم تسجيل الاستخدام") });
    },
    onError: (e: Error) => toast({ title: t("Not recorded", "لم يُسجّل"), description: e.message, variant: "destructive" }),
  });

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</div>;
  if (error || !data) return <div className="p-6 text-sm text-destructive">{t("The adjustments could not be loaded.", "تعذر تحميل التعديلات.")} {(error as Error)?.message}</div>;

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-full" data-testid="page-vat-capital-assets">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2"><Receipt className="w-6 h-6" />{t("VAT — capital-asset adjustments (Art. 52)", "ضريبة القيمة المضافة — تعديلات الأصول الرأسمالية (المادة 52)")}</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
          {t("A working paper, not an entry. Input tax deducted on a capital asset is revisited once a year for the length of its adjustment period — six years for movable assets, ten for immovable, or the accounting life if that is shorter. The clock is NOT the depreciation clock: it starts at the beginning of the tax period in which the asset was bought, and each year's adjustment belongs to one named VAT return.",
             "ورقة عمل لا قيد. تُراجَع ضريبة المدخلات المخصومة على الأصل الرأسمالي مرة كل سنة طوال فترة التعديل — ست سنوات للأصول المنقولة وعشر لغير المنقولة، أو العمر المحاسبي إن كان أقصر. وليست هذه ساعة الإهلاك: فهي تبدأ من أول الفترة الضريبية التي اقتُني فيها الأصل، ويخص تعديلُ كل سنة إقرارًا ضريبيًا واحدًا محددًا.")}
        </p>
        <Link href="/assets" className="text-sm text-primary hover:underline" data-testid="link-register">{t("The book register →", "السجل الدفتري ←")}</Link>
      </div>

      {data.status !== "computed" ? (
        <Card data-testid="vat-blocked">
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Info className="w-4 h-4" />{t("No windows yet — and this is not a company with no capital assets", "لا توجد فترات بعد — وليست هذه منشأة بلا أصول رأسمالية")}</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <Badge variant="outline" data-testid="vat-status">{data.status}</Badge>
            <p className="text-sm" data-testid="vat-reason">{data.reason}</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card data-testid="vat-fraction">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">{t("Art. 51(4) — the default proportional deduction, by calendar year", "المادة 51(4) — نسبة الخصم النسبي الافتراضية، بحسب السنة الميلادية")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground mb-2">
                {t("Where an asset's actual use has not been stated, this is the figure used for it — taxable supplies over taxable plus exempt, excluding sales of capital assets (Art. 51(5)(a)). It is shown so it can be checked rather than trusted.",
                   "حيثما لم يُذكر الاستخدام الفعلي للأصل، فهذه هي النسبة المستخدمة له — التوريدات الخاضعة على مجموع الخاضعة والمعفاة، مع استبعاد بيع الأصول الرأسمالية (المادة 51(5)(أ)). وتُعرض ليتسنى التحقق منها لا الوثوق بها.")}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-border text-muted-foreground text-xs uppercase">
                    {[t("Calendar year", "السنة الميلادية"), t("Taxable", "الخاضعة"), t("Exempt", "المعفاة"), t("Recovery", "نسبة الاسترداد")].map((h, i) => <th key={i} className="text-start pb-2 pe-3 font-medium">{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {data.proportionalDeduction.map((p) => (
                      <tr key={p.calendarYear} className="border-b border-border/50" data-testid={`fraction-${p.calendarYear}`}>
                        <td className="py-1.5 pe-3 font-mono" dir="ltr">{p.calendarYear}</td>
                        <td className="py-1.5 pe-3 text-end"><Money v={p.taxableSupplies} /></td>
                        <td className="py-1.5 pe-3 text-end"><Money v={p.exemptSupplies} /></td>
                        <td className="py-1.5 pe-3 text-end font-semibold">
                          {p.pct === null
                            ? <span className="text-[11px] font-normal text-muted-foreground">{t("no supplies — no fraction", "لا توريدات — لا نسبة")}</span>
                            : <span className="font-mono" dir="ltr">{p.pct}%</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {data.assets.length === 0 && (
            <Card><CardContent className="py-8 text-center text-sm text-muted-foreground" data-testid="vat-no-assets">
              {t("No capital assets are in service. An asset whose VAT class is “not a capital asset” has no adjustment period (Art. 52(2)).", "لا توجد أصول رأسمالية في الخدمة. والأصل المصنَّف «ليس أصلًا رأسماليًا» لا فترة تعديل له (المادة 52(2)).")}
            </CardContent></Card>
          )}

          {(data.assets as VatAdjustmentAsset[]).map((a) => (
            <AssetCard key={a.assetId} a={a} t={t} lang={lang} onDeclare={(periodIndex) => setEditing({ assetId: a.assetId, periodIndex, assetName: a.name })} />
          ))}
        </>
      )}

      {editing && (
        <UseDialog
          {...editing}
          busy={declare.isPending}
          t={t}
          lang={lang}
          onClose={() => setEditing(null)}
          onSubmit={(b) => declare.mutate(b)}
        />
      )}
    </div>
  );
}

function AssetCard({ a, t, lang, onDeclare }: { a: VatAdjustmentAsset; t: (en: string, ar: string) => string; lang: string; onDeclare: (periodIndex: number) => void }) {
  const total = a.windows.reduce((s, w) => s + w.adjustment, 0) + (a.disposal?.adjustment ?? 0);
  return (
    <Card data-testid={`vat-asset-${a.assetNumber}`}>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex flex-wrap items-baseline gap-2">
          <Link href={`/assets/${a.assetId}`} className="hover:underline">{a.name}</Link>
          <span className="text-xs font-normal font-mono text-muted-foreground" dir="ltr">{a.assetNumber}</span>
          <Badge variant="outline" className="text-[10px]">{a.vatCapitalAssetClass === "immovable" ? t("immovable", "غير منقول") : t("movable", "منقول")}</Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {t(`Input tax ${fmtNum(a.vatInputTaxAmount)} · recovered at ${a.initialRecoveryPct}% = ${fmtNum(a.initialDeduction)} · adjustment period ${a.adjustmentPeriodYears} year(s) · ${fmtNum(a.potentiallyAdjustable)} potentially adjustable each year (Art. 52(4))`,
             `ضريبة المدخلات ${fmtNum(a.vatInputTaxAmount)} · استُردت بنسبة ${a.initialRecoveryPct}% = ${fmtNum(a.initialDeduction)} · فترة التعديل ${a.adjustmentPeriodYears} سنة · ${fmtNum(a.potentiallyAdjustable)} قابلة للتعديل كل سنة (المادة 52(4))`)}
        </p>
        {a.vatNonDeductibleReason && <p className="text-xs text-muted-foreground">{a.vatNonDeductibleReason}</p>}
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-border text-muted-foreground text-xs uppercase">
            {[t("Window", "الفترة"), t("Twelve months", "الاثنا عشر شهرًا"), t("Filed in the return for", "يُقدَّم في إقرار"), t("Actual use", "الاستخدام الفعلي"), t("Adjustment", "التعديل"), ""].map((h, i) => <th key={i} className="text-start pb-2 pe-3 font-medium whitespace-nowrap">{h}</th>)}
          </tr></thead>
          <tbody>
            {a.windows.map((w) => <WindowRow key={w.periodIndex} w={w} assetNumber={a.assetNumber} t={t} lang={lang} onDeclare={onDeclare} />)}
          </tbody>
          <tfoot>
            <tr className="font-semibold border-t border-border">
              <td className="py-2 pe-3" colSpan={4}>{t("Total adjustment over the period", "إجمالي التعديل خلال الفترة")}</td>
              <td className="py-2 pe-3 text-end" data-testid={`vat-total-${a.assetNumber}`}><Money v={total} /></td>
              <td />
            </tr>
          </tfoot>
        </table>

        {a.disposal && (
          <div className="mt-3 rounded-md border border-border p-3" data-testid={`vat-disposal-${a.assetNumber}`}>
            <p className="text-xs font-medium">{t(`Disposed ${a.disposal.date} — ${a.disposal.kind}`, `استُبعد في ${a.disposal.date} — ${a.disposal.kind}`)}</p>
            <p className="text-xs text-muted-foreground mt-1">{a.disposal.rule}</p>
            <p className="text-sm mt-1">
              {t("Adjustment for the remainder", "تعديل ما تبقى من الفترة")}: <Money v={a.disposal.adjustment} />
              <span className="text-xs text-muted-foreground ms-2">{t(`${a.disposal.remainingPeriods} period(s) remained`, `تبقّت ${a.disposal.remainingPeriods} فترة`)}</span>
            </p>
            {a.disposal.nominalSupplyValue != null && (
              <p className="text-xs text-muted-foreground mt-1">
                {t("Art. 52(8) nominal supply value", "قيمة التوريد المفترض وفق المادة 52(8)")}: <Money v={a.disposal.nominalSupplyValue} />
              </p>
            )}
          </div>
        )}

        <p className="text-[11px] text-muted-foreground mt-2">
          {t(`Records for this asset are kept until ${a.recordsRetainedUntil} — the adjustment period plus five years from acquisition (Art. 66(1)).`,
             `تُحفظ سجلات هذا الأصل حتى ${a.recordsRetainedUntil} — فترة التعديل زائد خمس سنوات من تاريخ الاقتناء (المادة 66(1)).`)}
        </p>
      </CardContent>
    </Card>
  );
}

function WindowRow({ w, assetNumber, t, lang, onDeclare }: { w: VatAdjustmentWindow; assetNumber: string; t: (en: string, ar: string) => string; lang: string; onDeclare: (periodIndex: number) => void }) {
  const basisLabel = BASES.find((b) => b[0] === w.declaredBasis);
  return (
    <tr className="border-b border-border/50 align-top" data-testid={`vat-window-${assetNumber}-${w.periodIndex}`}>
      <td className="py-2 pe-3 font-mono" dir="ltr">{w.periodIndex}</td>
      <td className="py-2 pe-3 text-xs font-mono" dir="ltr">{w.startDate} → {w.endDate}</td>
      <td className="py-2 pe-3 text-xs font-mono" dir="ltr">
        {w.returnPeriodStart} → {w.returnPeriodEnd}
        {!w.due && <span className="block text-[10px] font-sans text-muted-foreground">{t("not yet ended", "لم تنتهِ بعد")}</span>}
      </td>
      <td className="py-2 pe-3">
        {w.actualUsePct === null ? (
          <span className="text-[11px] text-muted-foreground" data-testid={`vat-use-unavailable-${assetNumber}-${w.periodIndex}`}>
            {t("not established", "غير محدد")}
          </span>
        ) : (
          <>
            <span className="font-mono" dir="ltr">{w.actualUsePct}%</span>
            <span className="block text-[10px] text-muted-foreground">
              {w.actualUseSource === "declared"
                ? (lang === "ar" ? basisLabel?.[2] : basisLabel?.[1]) ?? t("declared", "مُقرّ")
                : t("Art. 51 default", "افتراضي المادة 51")}
            </span>
          </>
        )}
      </td>
      <td className="py-2 pe-3 text-end">
        <Money v={w.adjustment} />
        {w.noChangeOfUse && (
          <span className="block text-[10px] text-muted-foreground" data-testid={`vat-no-change-${assetNumber}-${w.periodIndex}`}>
            {t("Art. 52(6): no change of use", "المادة 52(6): لا تغيّر في الاستخدام")}
          </span>
        )}
      </td>
      <td className="py-2">
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => onDeclare(w.periodIndex)} data-testid={`vat-declare-${assetNumber}-${w.periodIndex}`}>
          <Pencil className="w-3 h-3 me-1" />{t("State use", "تحديد الاستخدام")}
        </Button>
      </td>
    </tr>
  );
}

function UseDialog({ assetId, periodIndex, assetName, busy, t, lang, onClose, onSubmit }: {
  assetId: number; periodIndex: number; assetName: string; busy: boolean;
  t: (en: string, ar: string) => string; lang: string; onClose: () => void; onSubmit: (b: Record<string, unknown>) => void;
}) {
  const [pct, setPct] = useState("");
  const [basis, setBasis] = useState("exclusive_use");
  const [note, setNote] = useState("");
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent data-testid="vat-use-dialog">
        <DialogHeader>
          <DialogTitle>{t(`${assetName} — window ${periodIndex}`, `${assetName} — الفترة ${periodIndex}`)}</DialogTitle>
          <DialogDescription>
            {t("State the share of this twelve-month window in which the asset was used to make TAXABLE supplies. It overrides the Art. 51 default for this window and no other.",
               "حدّد نسبة استخدام الأصل في إجراء توريدات خاضعة خلال هذه الفترة. ويَجُبّ ذلك افتراض المادة 51 لهذه الفترة وحدها.")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="text-xs">{t("Actual taxable use (%)", "الاستخدام الخاضع الفعلي (%)")}</Label>
            <Input value={pct} onChange={(e) => setPct(e.target.value)} data-testid="vat-use-pct" dir="ltr" type="number" min={0} max={100} step="0.01" />
          </div>
          <div>
            <Label className="text-xs">{t("Why this rather than the Art. 51 default", "سبب اختلافه عن افتراض المادة 51")}</Label>
            <Select value={basis} onValueChange={setBasis}>
              <SelectTrigger data-testid="vat-use-basis"><SelectValue /></SelectTrigger>
              <SelectContent>{BASES.map(([v, en, ar]) => <SelectItem key={v} value={v}>{lang === "ar" ? ar : en}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">{t("Note", "ملاحظة")}</Label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} data-testid="vat-use-note" />
          </div>
          <Button
            disabled={busy || pct.trim() === ""}
            data-testid="vat-use-submit"
            onClick={() => onSubmit({ assetId, periodIndex, actualUsePct: Number(pct), basis, note: note.trim() === "" ? null : note })}
          >
            {t("Record", "تسجيل")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
