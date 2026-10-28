/**
 * 🔴 Phase 18 G2a — VAT CORRECTIONS (owner decisions 9–12 and A5(a), 2026-10-27).
 *
 * An error found in a FILED VAT return is recorded here, once, with the date it
 * was ACTUALLY discovered and, separately, any earlier date it arguably became
 * apparent (decision 10). The server aggregates every error of one return on
 * the NET tax difference (decision 9) and names the route (decision 11):
 * amend and notify within 20 days; or the return for the period of discovery;
 * or, where that return is already filed, the user's choice with ZATCA's
 * direction. Nothing is automated, and no penalty waiver is ever applied
 * (decision 12). Below, the VAT entries recorded after a filing in its period
 * (A5(a)): allowed, and listed so a correction can be recorded.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListVatCorrections, useRecordVatCorrection, getListVatCorrectionsQueryKey, useListVatEntriesAfterFiling,
  type VatReturnFiling,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { fmtNum } from "@/lib/api";
import { correctionRouteText } from "@/lib/vatCorrections";

export function VatCorrections({ canRecord, filings }: { canRecord: boolean; filings: VatReturnFiling[] }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const view = useListVatCorrections();
  const after = useListVatEntriesAfterFiling();
  const empty = { correctsZatcaReference: "", description: "", netTaxDifference: "", discoveredOn: "", apparentOn: "" };
  const [c, setC] = useState(empty);
  const record = useRecordVatCorrection({
    mutation: {
      onSuccess: () => { setC(empty); qc.invalidateQueries({ queryKey: getListVatCorrectionsQueryKey() }); toast({ title: t("Recorded", "سُجِّل") }); },
      onError: (e: unknown) => toast({ title: t("Not recorded", "لم يُسجَّل"), description: e instanceof Error ? e.message : String(e), variant: "destructive" }),
    },
  });
  const withErrors = (view.data?.returns ?? []).filter((r) => r.errors > 0);
  const field = "space-y-1";

  return (
    <Card data-testid="vat-corrections">
      <CardHeader><CardTitle className="text-base">{t("Errors found in filed VAT returns", "الأخطاء المكتشفة في إقرارات ضريبة القيمة المضافة المقدّمة")}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          {t("Every error of one return is added together, on the NET tax difference, before the SAR 15,000 threshold is read; exactly SAR 15,000 needs notification. No penalty waiver is ever applied automatically.",
             "تُجمع أخطاء الإقرار الواحد كلها على صافي فرق الضريبة قبل قراءة حد 15,000 ريال؛ ومبلغ 15,000 ريال بالضبط يستلزم الإبلاغ. ولا يُطبَّق أي إعفاء من الغرامات تلقائيًا أبدًا.")}
        </p>
        {withErrors.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("No error recorded.", "لم يُسجَّل أي خطأ.")}</p>
        ) : (
          <ul className="space-y-3" data-testid="vat-correction-returns">
            {withErrors.map((r) => (
              <li key={r.zatcaReference} className="rounded-md border border-border p-3 text-sm space-y-1" data-testid={`vat-correction-return-${r.zatcaReference}`}>
                <div className="flex flex-wrap gap-x-3">
                  <span className="font-mono" dir="ltr">{r.periodFrom === r.periodTo ? r.periodFrom : `${r.periodFrom}–${r.periodTo}`}</span>
                  <span className="font-mono text-muted-foreground" dir="ltr">{r.zatcaReference}</span>
                  <span>{t("Errors", "الأخطاء")}: {r.errors}</span>
                  <span>{t("Net tax difference", "صافي فرق الضريبة")}: <span className="font-mono" dir="ltr">{fmtNum(r.netTaxDifference)}</span></span>
                </div>
                <p data-testid={`vat-correction-route-${r.zatcaReference}`}>{correctionRouteText(r, t)}</p>
                {r.repeatedErrors && <p className="text-xs text-muted-foreground">{t("Errors are recorded against more than one return — review them together.", "سُجّلت أخطاء على أكثر من إقرار — راجعها مجتمعة.")}</p>}
                {r.resolution1117.mayQualify && (
                  <p className="text-xs text-muted-foreground">
                    {t(`This return was due on ${r.resolution1117.returnDueOn}, before 1 July 2026: under Resolution 1117 its late-payment and late-filing fines may be waived if the full principal is paid, or an instalment request filed, by ${r.resolution1117.conditionsBy}. Fines already paid are not refunded. Nothing is applied automatically.`,
                       `كان موعد هذا الإقرار ${r.resolution1117.returnDueOn}، قبل 1 يوليو 2026: بموجب القرار 1117 قد تُعفى غرامات التأخر في السداد والتقديم إذا سُدّد أصل الضريبة كاملًا، أو قُدّم طلب تقسيط، في موعد أقصاه ${r.resolution1117.conditionsBy}. ولا تُرد الغرامات المسدّدة سابقًا. لا يُطبَّق شيء تلقائيًا.`)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}

        {canRecord && filings.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2" data-testid="vat-correction-form">
            <div className={field}>
              <Label>{t("Filed return", "الإقرار المقدّم")}</Label>
              <Select value={c.correctsZatcaReference || "unset"} onValueChange={(x) => setC({ ...c, correctsZatcaReference: x === "unset" ? "" : x })}>
                <SelectTrigger data-testid="vat-correction-return"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="unset">{t("— Choose —", "— اختر —")}</SelectItem>
                  {filings.map((f) => <SelectItem key={f.id} value={f.zatcaReference}>{f.periodFrom}{f.periodTo !== f.periodFrom ? `–${f.periodTo}` : ""} · {f.zatcaReference}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className={field}><Label htmlFor="vc-desc">{t("The error", "الخطأ")}</Label><Input id="vc-desc" data-testid="vat-correction-description" value={c.description} onChange={(e) => setC({ ...c, description: e.target.value })} /></div>
            <div className={field}>
              <Label htmlFor="vc-net">{t("Net tax difference (+ understated, − overstated)", "صافي فرق الضريبة (+ نقص، − زيادة)")}</Label>
              <Input id="vc-net" data-testid="vat-correction-net" type="number" step="0.01" dir="ltr" value={c.netTaxDifference} onChange={(e) => setC({ ...c, netTaxDifference: e.target.value })} />
            </div>
            <div className={field}><Label htmlFor="vc-disc">{t("Date actually discovered", "تاريخ الاكتشاف الفعلي")}</Label><Input id="vc-disc" data-testid="vat-correction-discovered" type="date" value={c.discoveredOn} onChange={(e) => setC({ ...c, discoveredOn: e.target.value })} /></div>
            <div className={field}><Label htmlFor="vc-app">{t("Earlier date it arguably became apparent (optional)", "تاريخ سابق ربما اتضح فيه الخطأ (اختياري)")}</Label><Input id="vc-app" data-testid="vat-correction-apparent" type="date" value={c.apparentOn} onChange={(e) => setC({ ...c, apparentOn: e.target.value })} /></div>
            <div className="flex items-end">
              <Button size="sm" data-testid="vat-correction-submit" disabled={record.isPending || !c.correctsZatcaReference || !c.description.trim() || !c.netTaxDifference || !c.discoveredOn}
                onClick={() => record.mutate({ data: {
                  correctsZatcaReference: c.correctsZatcaReference, description: c.description.trim(), netTaxDifference: Number(c.netTaxDifference),
                  discoveredOn: c.discoveredOn, ...(c.apparentOn ? { apparentOn: c.apparentOn } : {}),
                } })}>
                {t("Record the error", "تسجيل الخطأ")}
              </Button>
            </div>
          </div>
        )}

        <div className="space-y-1" data-testid="vat-entries-after-filing">
          <p className="text-sm font-medium">{t("VAT entries recorded after their period's return was filed", "قيود ضريبية سُجّلت بعد تقديم إقرار فترتها")}</p>
          {(after.data?.items ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("None.", "لا يوجد.")}</p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">{t("These are allowed. An Art. 63 correction may be needed: record the error against the return above.", "هذه القيود مسموح بها، وقد يلزم تصحيح وفق المادة 63: سجّل الخطأ على الإقرار أعلاه.")}</p>
              <ul className="text-xs divide-y divide-border/60">
                {(after.data?.items ?? []).map((e) => (
                  <li key={e.entryId} className="py-1 flex flex-wrap gap-x-3">
                    <span className="font-mono" dir="ltr">{e.entryNumber}</span>
                    <span dir="ltr">{e.date}</span>
                    <span className="text-muted-foreground" dir="ltr">{e.zatcaReference}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
