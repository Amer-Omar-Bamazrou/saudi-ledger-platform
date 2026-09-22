/**
 * ONE FIXED ASSET (FA-B, 2026-09-22): its facts, its schedule and the two acts
 * that move it — RUN a period (Dr depreciation expense / Cr accumulated) and
 * CHANGE THE ESTIMATE (IAS 16.51, prospective).
 *
 * Capitalisation is not an act here: it happens on the BILL that buys the
 * asset (one writer, one effect), and this page says so while the asset is a
 * draft rather than offering a control that does not exist.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRoute, Link } from "wouter";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { DualDate } from "@/components/DualDate";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { businessToday } from "@workspace/shared";
import { ArrowLeft, TrendingDown, Pencil, Trash2 } from "lucide-react";
import { statusLabel } from "./Assets";
import type { AssetDetail as AssetDetailShape, DepreciateAssetInput, ChangeAssetEstimateInput, DisposeAssetInput } from "@workspace/api-client-react";

export default function AssetDetail() {
  const [, params] = useRoute("/assets/:id");
  const id = Number(params?.id);
  const { t, lang } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [runOpen, setRunOpen] = useState(false);
  const [postingDate, setPostingDate] = useState("");
  const [estimateOpen, setEstimateOpen] = useState(false);
  const [estimate, setEstimate] = useState({ usefulLifeMonths: "", residualValue: "", reason: "" });
  const [disposeOpen, setDisposeOpen] = useState(false);
  const [disposal, setDisposal] = useState({ date: businessToday(), kind: "scrapped", reason: "" });

  const { data: asset, isLoading, error } = useQuery<AssetDetailShape>({
    queryKey: ["asset", id],
    queryFn: () => apiFetch(`/assets/${id}`),
    enabled: Number.isInteger(id) && id > 0,
  });

  const runMut = useMutation({
    mutationFn: () => {
      const body: DepreciateAssetInput = { period: asset!.nextPeriod!, postingDate: postingDate || null };
      return apiFetch(`/assets/${id}/depreciate`, { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: (out: { period: string; amount: number; caughtUp: boolean }) => {
      qc.invalidateQueries({ queryKey: ["asset", id] });
      qc.invalidateQueries({ queryKey: ["assets"] });
      setRunOpen(false); setPostingDate("");
      toast({ title: t("Depreciation posted", "رُحّل الإهلاك"), description: `${out.period} · ${fmtNum(out.amount)}${out.caughtUp ? ` · ${t("caught up in an open month", "استُدرك في شهر مفتوح")}` : ""}` });
    },
  });
  const estimateMut = useMutation({
    mutationFn: () => {
      const body: ChangeAssetEstimateInput = {
        reason: estimate.reason.trim(),
        usefulLifeMonths: estimate.usefulLifeMonths === "" ? null : Number(estimate.usefulLifeMonths),
        residualValue: estimate.residualValue === "" ? null : Number(estimate.residualValue),
      };
      return apiFetch(`/assets/${id}/estimate`, { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["asset", id] });
      qc.invalidateQueries({ queryKey: ["assets"] });
      setEstimateOpen(false); setEstimate({ usefulLifeMonths: "", residualValue: "", reason: "" });
      toast({ title: t("Estimate changed", "تم تغيير التقدير"), description: t("The periods already posted are untouched; the remaining schedule is regenerated.", "لم تُمس الفترات المرحَّلة؛ وأُعيد توليد بقية الجدول.") });
    },
  });

  const disposeMut = useMutation({
    mutationFn: () => {
      const body: DisposeAssetInput = { date: disposal.date, kind: disposal.kind as DisposeAssetInput["kind"], reason: disposal.reason.trim() };
      return apiFetch(`/assets/${id}/dispose`, { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: (out: { disposal: { gainLoss: number }; depreciatedFirst: Array<{ period: string }> }) => {
      qc.invalidateQueries({ queryKey: ["asset", id] });
      qc.invalidateQueries({ queryKey: ["assets"] });
      setDisposeOpen(false);
      toast({
        title: t("Asset disposed", "تم استبعاد الأصل"),
        description: `${out.disposal.gainLoss < 0 ? t("Loss", "خسارة") : t("Gain", "ربح")} ${fmtNum(Math.abs(out.disposal.gainLoss))}`
          + (out.depreciatedFirst.length > 0 ? ` · ${t(`${out.depreciatedFirst.length} period(s) depreciated first`, `أُهلكت ${out.depreciatedFirst.length} فترة أولًا`)}` : ""),
      });
    },
  });

  if (isLoading) return <p className="text-sm text-muted-foreground p-4">{t("Loading…", "جارٍ التحميل…")}</p>;
  if (error || !asset) return <p className="text-sm text-destructive p-4">{t("The asset could not be loaded.", "تعذّر تحميل الأصل.")} {(error as Error)?.message}</p>;

  const rows = asset.schedule.length > 0 ? asset.schedule : (asset.plannedSchedule ?? []).map((r) => ({ ...r, id: -r.sequence, assetId: asset.id, journalEntryId: null, postedAt: null }));
  const facts: Array<[string, React.ReactNode, string]> = [
    [t("Cost", "التكلفة"), fmtNum(asset.cost), "detail-cost"],
    [t("Accumulated depreciation", "مجمع الإهلاك"), fmtNum(asset.accumulatedDepreciation), "detail-accumulated"],
    [t("Carrying amount", "القيمة الدفترية"), fmtNum(asset.carryingAmount), "detail-carrying"],
    [t("Residual value", "القيمة المتبقية"), fmtNum(asset.residualValue), "detail-residual"],
    [t("Useful life", "العمر الإنتاجي"), `${asset.postedPeriods}/${asset.usefulLifeMonths} ${t("months", "شهرًا")}`, "detail-life"],
    [t("Available for use", "جاهز للاستخدام"), asset.availableForUseDate ? <DualDate date={asset.availableForUseDate} inline /> : "—", "detail-available"],
    [t("Income tax group (Art. 17)", "مجموعة ضريبة الدخل (المادة 17)"), `${asset.incomeTaxGroup} · ${asset.incomeTaxRatePct}%`, "detail-tax-group"],
    [t("VAT capital asset (Art. 52)", "أصل رأسمالي لضريبة القيمة المضافة (المادة 52)"), asset.vatAdjustmentPeriodYears != null ? `${asset.vatCapitalAssetClass} · ${asset.vatAdjustmentPeriodYears} ${t("years", "سنوات")}` : t("not a capital asset", "ليس أصلًا رأسماليًا"), "detail-vat-class"],
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/assets" className="inline-flex items-center gap-1 text-xs text-primary mb-1" data-testid="back-to-assets"><ArrowLeft className="w-3 h-3" />{t("Fixed Assets", "الأصول الثابتة")}</Link>
          <h1 className="text-2xl font-bold text-foreground">{lang === "ar" && asset.nameAr ? asset.nameAr : asset.name}</h1>
          <p className="text-muted-foreground text-sm mt-1 font-mono" dir="ltr">{asset.assetNumber} · {asset.categoryName}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge data-testid="detail-status">{statusLabel(t, asset)}</Badge>
          {asset.status === "in_service" && asset.nextPeriod && (
            <Button size="sm" className="gap-1" onClick={() => setRunOpen(true)} data-testid="run-depreciation"><TrendingDown className="w-4 h-4" />{t(`Depreciate ${asset.nextPeriod}`, `إهلاك ${asset.nextPeriod}`)}</Button>
          )}
          {asset.status === "in_service" && (
            <Button size="sm" variant="outline" className="gap-1" onClick={() => setEstimateOpen(true)} data-testid="change-estimate"><Pencil className="w-4 h-4" />{t("Change estimate", "تغيير التقدير")}</Button>
          )}
          {asset.status === "in_service" && (
            <Button size="sm" variant="outline" className="gap-1" onClick={() => setDisposeOpen(true)} data-testid="dispose-asset"><Trash2 className="w-4 h-4" />{t("Scrap / write off", "شطب / استبعاد")}</Button>
          )}
        </div>
      </div>

      {asset.disposal && (
        <Card className="border-border bg-card"><CardContent className="pt-4">
          <p className="text-sm" data-testid="disposal-notice">
            <span className="font-medium">{({ sold: t("Sold", "بيع"), scrapped: t("Scrapped", "شُطب"), destroyed: t("Destroyed", "أُتلف"), stolen: t("Stolen", "سُرق"), withdrawn: t("Withdrawn", "سُحب") } as Record<string, string>)[asset.disposal.kind]}</span>
            {" "}<span dir="ltr">{asset.disposal.date}</span>
            {" · "}{asset.disposal.gainLoss < 0 ? t("loss", "خسارة") : t("gain", "ربح")} <span className="font-mono">{fmtNum(Math.abs(asset.disposal.gainLoss))}</span>
            {" · "}{t("carrying amount on disposal", "القيمة الدفترية عند الاستبعاد")} <span className="font-mono">{fmtNum(asset.disposal.carryingAmountAtDisposal)}</span>
            {asset.disposal.nominalSupplyValue != null && (
              <> · <span data-testid="nominal-supply">{t("nominal supply (VAT Art. 52(8))", "توريد اعتباري (المادة 52(8))")} <span className="font-mono">{fmtNum(asset.disposal.nominalSupplyValue)}</span></span></>
            )}
            {asset.disposal.reason && <span className="block text-muted-foreground text-xs mt-1">{asset.disposal.reason}</span>}
          </p>
        </CardContent></Card>
      )}

      {asset.status === "draft" && (
        <Card className="border-border bg-card"><CardContent className="pt-4">
          <p className="text-sm" data-testid="draft-notice">
            {t("This asset is a draft: nothing is in the books yet. It is capitalised by the BILL that buys it — enter the vendor bill and choose this asset on it; approving the bill posts the cost and starts the schedule below.",
               "هذا الأصل مسودة: لا شيء في الدفاتر بعد. تتم رسملته عبر فاتورة المورد التي تشتريه — أدخل الفاتورة واختر هذا الأصل فيها؛ واعتماد الفاتورة يرحّل التكلفة ويبدأ الجدول أدناه.")}
          </p>
        </CardContent></Card>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {facts.map(([l, v, id]) => (
          <Card key={id} className="border-border bg-card"><CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground">{l}</CardTitle></CardHeader><CardContent><div className="text-sm font-semibold font-mono" data-testid={id}>{v}</div></CardContent></Card>
        ))}
      </div>

      <Card className="border-border bg-card">
        <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{asset.schedule.length > 0 ? t("Depreciation schedule", "جدول الإهلاك") : t("Planned schedule (nothing posted yet)", "الجدول المخطط (لم يُرحَّل شيء بعد)")}</CardTitle></CardHeader>
        <CardContent>
          <div className="overflow-x-auto max-h-[28rem]"><table className="w-full text-sm">
            <thead className="sticky top-0 bg-card"><tr className="border-b border-border text-muted-foreground text-xs uppercase">
              {["#", t("Period", "الفترة"), t("Amount", "المبلغ"), t("Accumulated", "المتراكم"), t("Carrying", "الدفترية"), t("State", "الحالة")].map((h) => <th key={h} className="text-start pb-2 pe-3 font-medium">{h}</th>)}
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.sequence} className="border-b border-border/50" data-testid={`schedule-${r.period}`}>
                  <td className="py-1.5 pe-3 text-xs text-muted-foreground">{r.sequence}</td>
                  <td className="py-1.5 pe-3 font-mono text-xs" dir="ltr">{r.period}</td>
                  <td className="py-1.5 pe-3 font-mono">{fmtNum(r.amount)}</td>
                  <td className="py-1.5 pe-3 font-mono text-muted-foreground">{fmtNum(r.accumulatedAfter)}</td>
                  <td className="py-1.5 pe-3 font-mono">{fmtNum(r.carryingAfter)}</td>
                  <td className="py-1.5 pe-3 text-xs">{r.journalEntryId != null
                    ? <Link href={`/journal-entries?entry=${r.journalEntryId}`} className="text-primary" data-testid={`posted-${r.period}`}>{t("posted", "مرحَّل")} #{r.journalEntryId}</Link>
                    : <span className="text-muted-foreground">{t("planned", "مخطط")}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </CardContent>
      </Card>

      <Card className="border-border bg-card">
        <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("History", "السجل")}</CardTitle></CardHeader>
        <CardContent>
          <ul className="space-y-1 text-xs">
            {asset.events.map((e) => (
              <li key={e.id} className="flex flex-wrap gap-2" data-testid={`event-${e.kind}`}>
                <span className="font-mono text-muted-foreground" dir="ltr">{e.occurredOn}</span>
                <span className="font-medium">{e.kind}</span>
                {e.journalEntryId != null && <Link href={`/journal-entries?entry=${e.journalEntryId}`} className="text-primary">#{e.journalEntryId}</Link>}
                {e.documentRef && <span className="text-muted-foreground" dir="ltr">{e.documentRef}</span>}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Dialog open={runOpen} onOpenChange={(o) => { if (!o) setRunOpen(false); }}>
        <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-sm" data-testid="run-depreciation-dialog">
          <DialogHeader>
            <DialogTitle>{t("Depreciate", "إهلاك")} {asset.nextPeriod}</DialogTitle>
            <DialogDescription>
              {t("Posts the schedule's own amount: Dr depreciation expense / Cr accumulated depreciation, dated the last day of the period. If that month is closed, name a date in an open month — the entry then says which period it depreciates.",
                 "يُرحّل مبلغ الجدول نفسه: من ح/ مصروف الإهلاك إلى ح/ مجمع الإهلاك، بتاريخ آخر يوم في الفترة. وإن كان ذلك الشهر مقفلًا، فحدّد تاريخًا في شهر مفتوح — ويذكر القيد حينها الفترة التي يُهلكها.")}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-border p-3 text-sm flex justify-between">
            <span className="text-muted-foreground">{t("Amount", "المبلغ")}</span>
            <span className="font-mono" data-testid="run-amount">{fmtNum(rows.find((r) => r.period === asset.nextPeriod)?.amount ?? 0)}</span>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">{t("Catch-up date (only if the period is closed)", "تاريخ الاستدراك (فقط إذا كانت الفترة مقفلة)")}</Label>
            <Input type="date" value={postingDate} onChange={(e) => setPostingDate(e.target.value)} className="mt-1 h-9" data-testid="run-posting-date" />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setRunOpen(false)}>{t("Cancel", "إلغاء")}</Button>
            <Button onClick={() => runMut.mutate()} disabled={runMut.isPending} data-testid="run-submit">{runMut.isPending ? t("Posting…", "جارٍ الترحيل…") : t("Post depreciation", "ترحيل الإهلاك")}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={disposeOpen} onOpenChange={(o) => { if (!o) setDisposeOpen(false); }}>
        <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md" data-testid="dispose-dialog">
          <DialogHeader>
            <DialogTitle>{t("Scrap or write off", "شطب أو استبعاد")}</DialogTitle>
            <DialogDescription>
              {t("For an asset that leaves with NO proceeds. A SALE is a tax invoice that names this asset, so the supply and its VAT are documented. Every period up to the month it left is depreciated first (IAS 16.55), then the cost and its accumulated depreciation come off the books and the carrying amount becomes a loss.",
                 "للأصل الذي يخرج دون مقابل. أما البيع فهو فاتورة ضريبية تسمّي هذا الأصل، ليُوثَّق التوريد وضريبته. تُهلك أولًا كل فترة حتى شهر الخروج (معيار 16.55)، ثم تخرج التكلفة ومجمع إهلاكها من الدفاتر وتصبح القيمة الدفترية خسارة.")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs text-muted-foreground">{t("What happened", "ما الذي حدث")}</Label>
              <Select value={disposal.kind} onValueChange={(v) => setDisposal((p) => ({ ...p, kind: v }))}>
                <SelectTrigger className="mt-1 h-9" data-testid="dispose-kind"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="scrapped">{t("Scrapped", "شُطب")}</SelectItem>
                  <SelectItem value="destroyed">{t("Destroyed", "أُتلف")}</SelectItem>
                  <SelectItem value="stolen">{t("Stolen", "سُرق")}</SelectItem>
                  <SelectItem value="withdrawn">{t("Withdrawn from the business (still usable)", "سُحب من النشاط (وما زال صالحًا)")}</SelectItem>
                </SelectContent>
              </Select>
              {disposal.kind === "withdrawn" && (
                <p className="text-[11px] text-muted-foreground mt-1" data-testid="withdrawn-hint">
                  {t("A withdrawal while the asset is still usable is a NOMINAL SUPPLY for VAT (Art. 52(8)); its value is computed and recorded on the disposal.",
                     "سحب الأصل وهو ما زال صالحًا للاستخدام يُعد توريدًا اعتباريًا لأغراض ضريبة القيمة المضافة (المادة 52(8))؛ وتُحتسب قيمته وتُسجَّل مع الاستبعاد.")}
                </p>
              )}
            </div>
            <div><Label className="text-xs text-muted-foreground">{t("Date", "التاريخ")}</Label><Input type="date" value={disposal.date} onChange={(e) => setDisposal((p) => ({ ...p, date: e.target.value }))} className="mt-1 h-9" data-testid="dispose-date" /></div>
            <div><Label className="text-xs text-muted-foreground">{t("Reason and evidence", "السبب والإثبات")}</Label><Textarea rows={2} value={disposal.reason} onChange={(e) => setDisposal((p) => ({ ...p, reason: e.target.value }))} className="mt-1" data-testid="dispose-reason" /></div>
            <div className="rounded-md border border-border p-3 text-sm flex justify-between">
              <span className="text-muted-foreground">{t("Loss on disposal (the carrying amount today)", "الخسارة عند الاستبعاد (القيمة الدفترية اليوم)")}</span>
              <span className="font-mono" data-testid="dispose-loss">{fmtNum(asset.carryingAmount)}</span>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDisposeOpen(false)}>{t("Cancel", "إلغاء")}</Button>
            <Button onClick={() => disposeMut.mutate()} disabled={!disposal.reason.trim() || disposeMut.isPending} data-testid="dispose-submit">{disposeMut.isPending ? t("Posting…", "جارٍ الترحيل…") : t("Dispose", "استبعاد")}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={estimateOpen} onOpenChange={(o) => { if (!o) setEstimateOpen(false); }}>
        <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md" data-testid="estimate-dialog">
          <DialogHeader>
            <DialogTitle>{t("Change the estimate", "تغيير التقدير")}</DialogTitle>
            <DialogDescription>
              {t("A change in the useful life, residual value or method is a change in ESTIMATE (IAS 16.51, IAS 8): it applies from here on. The periods already posted are never touched; the remaining schedule is regenerated from the current carrying amount.",
                 "تغيير العمر الإنتاجي أو القيمة المتبقية أو الطريقة هو تغيير في التقدير (معيار 16.51 و8): يُطبَّق من الآن فصاعدًا. ولا تُمس الفترات المرحَّلة؛ ويُعاد توليد بقية الجدول من القيمة الدفترية الحالية.")}
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div><Label className="text-xs text-muted-foreground">{t("Useful life (months)", "العمر الإنتاجي (أشهر)")}</Label><Input type="number" min={1} value={estimate.usefulLifeMonths} onChange={(e) => setEstimate((p) => ({ ...p, usefulLifeMonths: e.target.value }))} placeholder={String(asset.usefulLifeMonths)} className="mt-1 h-9 font-mono" dir="ltr" data-testid="estimate-life" /></div>
            <div><Label className="text-xs text-muted-foreground">{t("Residual value", "القيمة المتبقية")}</Label><Input type="number" min={0} step="0.01" value={estimate.residualValue} onChange={(e) => setEstimate((p) => ({ ...p, residualValue: e.target.value }))} placeholder={fmtNum(asset.residualValue)} className="mt-1 h-9 font-mono" dir="ltr" data-testid="estimate-residual" /></div>
            <div className="col-span-2"><Label className="text-xs text-muted-foreground">{t("Reason (disclosed — IAS 8)", "السبب (يُفصح عنه — معيار 8)")}</Label><Textarea rows={2} value={estimate.reason} onChange={(e) => setEstimate((p) => ({ ...p, reason: e.target.value }))} className="mt-1" data-testid="estimate-reason" /></div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setEstimateOpen(false)}>{t("Cancel", "إلغاء")}</Button>
            <Button onClick={() => estimateMut.mutate()} disabled={!estimate.reason.trim() || estimateMut.isPending} data-testid="estimate-submit">{estimateMut.isPending ? t("Saving…", "جارٍ الحفظ…") : t("Apply from here on", "التطبيق من الآن فصاعدًا")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
