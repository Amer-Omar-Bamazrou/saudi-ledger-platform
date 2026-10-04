/**
 * Phase 16B/16C/16D — one Zakat or income-tax computation (decision pack §3–§5).
 *
 * A computation is a frozen fiscal year with VERSIONS — draft → submitted →
 * approved → superseded, through the ONE approval engine. A draft or submitted
 * version is a LIVE working paper read from the ledger every time; an approved
 * version is shown FROM ITS SNAPSHOT, with the live recomputation beside it and
 * "the inputs have changed since approval" when they differ (a verification is
 * a claim about a moment). The only ledger effect is the approval's accrual
 * (Dr Zakat/income-tax expense, Cr the payable), posted for the DIFFERENCE from
 * what earlier versions accrued — never on a draft, never before the year ends.
 *
 * Adjustments move the computation only, never the ledger; each carries its
 * reason and its article. Every figure on this page is the server's.
 */
import { useState } from "react";
import { Link, useLocation, useParams, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetTaxComputation, getGetTaxComputationQueryKey, getListTaxComputationsQueryKey,
  useSubmitTaxComputationVersion, useApproveTaxComputationVersion, useSendBackTaxComputationVersion, useRejectTaxComputationVersion,
  useReviseTaxComputation, useDeleteTaxComputation, useAddTaxAdjustment, useRemoveTaxAdjustment, useSetTaxLosses,
  type TaxComputationDetail as Detail, type TaxComputationLive, type ZakatReconciliation, type IncomeTaxReconciliation,
  type TaxAdjustmentInputTarget, type TaxAdjustmentInputEffect,
} from "@workspace/api-client-react";
import { fmtDate, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { useGuarded } from "@/lib/singleSubmit";
import { ReportExportButtons } from "@/components/reports/ReportExport";
import {
  computationStatusLabel, stepLabel, zakatClassLabel, adjustmentTargetLabel, blockerLabel, minimumRuleLabel, articleLabel,
} from "@/lib/taxLabels";

const money = (x: number | null | undefined) => (x == null ? "—" : fmtNum(x));
type T = (en: string, ar: string) => string;

export default function TaxComputationDetail() {
  const { id: idParam } = useParams<{ id: string }>();
  const id = Number(idParam);
  const search = useSearch();
  const [, navigate] = useLocation();
  const versionParam = new URLSearchParams(search).get("version_id");
  const versionId = versionParam && /^\d+$/.test(versionParam) ? Number(versionParam) : undefined;
  const params = versionId != null ? { version_id: versionId } : undefined;
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const q = useGetTaxComputation(id, params, { query: { queryKey: getGetTaxComputationQueryKey(id, params), enabled: Number.isSafeInteger(id) && id > 0 } });
  const d = q.data;

  const refresh = () => {
    qc.invalidateQueries({ predicate: (x) => typeof x.queryKey[0] === "string" && (x.queryKey[0] as string).startsWith("/api/tax") });
  };
  const ok = (msg: [string, string]) => () => { refresh(); toast({ title: t(...msg) }); };
  const submit = useGuarded(useSubmitTaxComputationVersion({ mutation: { onSuccess: ok(["Submitted for approval", "قُدِّم للاعتماد"]) } }));
  const approve = useGuarded(useApproveTaxComputationVersion({ mutation: { onSuccess: ok(["Approved — the accrual is posted", "اعتُمد — رُحِّل الاستحقاق"]) } }));
  const sendBack = useGuarded(useSendBackTaxComputationVersion({ mutation: { onSuccess: ok(["Sent back to draft", "أُعيد إلى المسودة"]) } }));
  const reject = useGuarded(useRejectTaxComputationVersion({ mutation: { onSuccess: () => { refresh(); toast({ title: t("Version rejected and removed", "رُفض الإصدار وحُذف") }); navigate(`/tax/computations/${id}`); } } }));
  const revise = useGuarded(useReviseTaxComputation({ mutation: { onSuccess: (r) => { refresh(); toast({ title: t("Revision started as a new draft", "بدأت مراجعة كمسودة جديدة") }); if (r.version) navigate(`/tax/computations/${id}?version_id=${r.version.id}`); } } }));
  const remove = useGuarded(useDeleteTaxComputation({ mutation: { onSuccess: () => { qc.invalidateQueries({ queryKey: getListTaxComputationsQueryKey() }); toast({ title: t("Computation deleted", "حُذف الاحتساب") }); navigate(d?.kind === "income_tax" ? "/tax/income-tax" : "/zakat"); } } }));
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState<"send-back" | "reject" | "delete" | null>(null);

  if (!Number.isSafeInteger(id) || id <= 0) return <p className="text-sm text-muted-foreground p-4">{t("Computation not found.", "الاحتساب غير موجود.")}</p>;
  if (q.isLoading) return <p className="text-sm text-muted-foreground p-4">{t("Loading…", "جارٍ التحميل…")}</p>;
  if (q.isError || !d) return <p className="text-sm text-muted-foreground p-4" data-testid="tax-computation-not-found">{t("Computation not found.", "الاحتساب غير موجود.")}</p>;

  const v = d.version;
  const kindLabel = d.kind === "zakat" ? t("Zakat", "الزكاة") : t("Income tax", "ضريبة الدخل");
  const back = d.kind === "zakat" ? "/zakat" : "/tax/income-tax";
  const isDraft = v?.status === "draft";
  const isOpen = v?.status === "draft" || v?.status === "submitted";
  const everApproved = d.versions.some((x) => x.status === "approved" || x.status === "superseded");
  const busy = submit.isPending || approve.isPending || sendBack.isPending || reject.isPending || revise.isPending || remove.isPending;
  const pair = v ? { id, versionId: v.id } : null;

  return (
    <div className="space-y-6" data-testid="tax-computation-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs"><Link href={back} className="underline text-muted-foreground">{kindLabel}</Link></p>
          <h1 className="text-2xl font-bold text-foreground">{d.kind === "zakat" ? t("Zakat working paper", "ورقة عمل الزكاة") : t("Income-tax computation", "احتساب ضريبة الدخل")} · <span className="font-mono" dir="ltr">{d.fiscalYear.label}</span></h1>
          <p className="text-sm text-muted-foreground mt-1">
            {fmtDate(d.fiscalYear.startDate)} – {fmtDate(d.fiscalYear.endDate)} · {d.fiscalYear.calendar === "hijri" ? t("Hijri year", "سنة هجرية") : t("Gregorian year", "سنة ميلادية")} · {t("due", "الاستحقاق")} {fmtDate(d.dueDate)}
          </p>
        </div>
        {v && <ReportExportButtons report="tax-computation" params={{ computation_id: String(id), version_id: String(v.id) }} />}
      </div>

      {/* versions */}
      <div className="flex flex-wrap items-center gap-2" data-testid="tax-versions">
        {d.versions.map((x) => (
          <Link key={x.id} href={`/tax/computations/${id}?version_id=${x.id}`}>
            <Button size="sm" variant={v?.id === x.id ? "default" : "outline"} className="h-7" data-testid={`tax-version-${x.versionNo}`}>
              v{x.versionNo} · {computationStatusLabel(x.status, t)}
            </Button>
          </Link>
        ))}
      </div>

      {v && (
        <Card className="border-border" data-testid="tax-version-status">
          <CardContent className="pt-4 space-y-3">
            <p className="text-sm">
              <span className="font-medium">{t("Version", "الإصدار")} {v.versionNo}: {computationStatusLabel(v.status, t)}</span>
              {v.submittedAt && <> · {t("submitted", "قُدِّم")} {fmtDate(v.submittedAt)}</>}
              {v.approvedAt && <> · {t("approved", "اعتُمد")} {fmtDate(v.approvedAt)}</>}
              {v.supersededAt && <> · {t("superseded", "استُبدل")} {fmtDate(v.supersededAt)}</>}
            </p>
            {v.sendBackNote && <p className="text-sm" data-testid="tax-send-back-note">{t("Sent back:", "أُعيد مع ملاحظة:")} {v.sendBackNote}</p>}
            {v.status === "approved" || v.status === "superseded" ? (
              <p className="text-sm" data-testid="tax-accrual">
                {t("Result", "النتيجة")} <span className="font-mono font-semibold" dir="ltr">{money(v.resultAmount)}</span>
                {" · "}{t("this approval posted", "رحّل هذا الاعتماد")} <span className="font-mono" dir="ltr">{money(v.accruedAmount)}</span>
                {v.accrualDate ? <> {t("on", "بتاريخ")} {fmtDate(v.accrualDate)}</> : null}
                {v.accrualJournalEntryId ? <> · {t("journal entry", "قيد اليومية")} <Link href="/journal-entries" className="underline font-mono" dir="ltr">#{v.accrualJournalEntryId}</Link></> : <> · {t("nothing to post (no difference from earlier versions)", "لا شيء يُرحَّل (لا فرق عن الإصدارات السابقة)")}</>}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {isDraft && pair && <Button size="sm" variant="outline" disabled={busy} onClick={() => submit.mutate(pair)} data-testid="tax-submit">{t("Submit for approval", "تقديم للاعتماد")}</Button>}
              {isOpen && pair && <Button size="sm" disabled={busy} onClick={() => approve.mutate(pair)} data-testid="tax-approve">{t("Approve and post", "اعتماد وترحيل")}</Button>}
              {v.status === "submitted" && <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm("send-back")} data-testid="tax-send-back">{t("Send back", "إعادة")}</Button>}
              {isOpen && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm("reject")} data-testid="tax-reject">{t("Reject this version", "رفض هذا الإصدار")}</Button>}
              {v.status === "approved" && !d.openVersionId && <Button size="sm" variant="outline" disabled={busy} onClick={() => revise.mutate({ id })} data-testid="tax-revise">{t("Revise", "مراجعة")}</Button>}
              {!everApproved && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm("delete")} data-testid="tax-delete">{t("Delete computation", "حذف الاحتساب")}</Button>}
            </div>
            {isOpen && <p className="text-xs text-muted-foreground">{t("Approving is an approver's act and posts the accrual; it waits until the fiscal year has ended — until then the working paper is a live projection.", "الاعتماد من صلاحية المعتمِد ويرحّل الاستحقاق؛ وينتظر انتهاء السنة المالية — وحتى ذلك الحين ورقة العمل إسقاط حي.")}</p>}
            {!everApproved && <p className="text-xs text-muted-foreground">{t("Deleting a computation that was never approved is an administrator's act.", "حذف احتساب لم يُعتمد قط من صلاحية المسؤول.")}</p>}
            {confirm && (
              <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3" data-testid="tax-confirm">
                {confirm === "send-back" && <div className="grow min-w-48"><Label className="text-xs text-muted-foreground">{t("Note to the preparer (optional)", "ملاحظة للمُعِد (اختياري)")}</Label><Input value={note} onChange={(e) => setNote(e.target.value)} data-testid="tax-send-back-input" /></div>}
                <p className="text-sm">{confirm === "reject" ? t("Rejecting removes this version (an open version is a draft, not a record).", "الرفض يحذف هذا الإصدار (الإصدار المفتوح مسودة لا سجل).") : confirm === "delete" ? t("Delete this computation and its draft?", "حذف هذا الاحتساب ومسودته؟") : null}</p>
                <Button size="sm" disabled={busy} data-testid="tax-confirm-yes" onClick={() => {
                  if (confirm === "send-back" && pair) sendBack.mutate({ ...pair, data: { note: note.trim() || null } });
                  if (confirm === "reject" && pair) reject.mutate(pair);
                  if (confirm === "delete") remove.mutate({ id });
                  setConfirm(null); setNote("");
                }}>{t("Confirm", "تأكيد")}</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>{t("Cancel", "إلغاء")}</Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* the approved snapshot, beside the live paper */}
      {d.approvedSnapshot && (
        <Card className="border-border" data-testid="tax-snapshot">
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("The approved figure (frozen)", "الرقم المعتمد (مجمّد)")}</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>{kindLabel} <span className="font-mono font-semibold" dir="ltr" data-testid="tax-snapshot-amount">{money(d.approvedSnapshot.computation.amount)}</span> · {t("frozen", "جُمِّد")} {fmtDate(d.approvedSnapshot.frozenAt)}</p>
            <p className="text-xs text-muted-foreground">{t("Previously accrued", "المستحق سابقًا")} <span className="font-mono" dir="ltr">{money(d.approvedSnapshot.accrual.previouslyAccrued)}</span> · {t("posted by this approval", "رحّله هذا الاعتماد")} <span className="font-mono" dir="ltr">{money(d.approvedSnapshot.accrual.thisApproval)}</span></p>
            {d.ledgerChangedSinceApproval === true && (
              <p className="pt-1" data-testid="tax-ledger-changed">{t("The inputs have changed since this was approved — the ledger in that year, or an account's Zakat classification. The approved figure stays the approved figure; the live working paper below shows today's reading. Revise to approve the new figure (only the difference is posted).", "تغيّرت المدخلات منذ الاعتماد — دفاتر تلك السنة أو تصنيف حساب زكويًا. يبقى الرقم المعتمد كما هو؛ وتعرض ورقة العمل الحية أدناه قراءة اليوم. راجِع لاعتماد الرقم الجديد (يُرحَّل الفرق فقط).")}</p>
            )}
          </CardContent>
        </Card>
      )}

      {d.live && <LivePaper d={d} live={d.live} t={t} />}

      {v && d.live && <Adjustments d={d} live={d.live} versionId={v.id} editable={isDraft} onChanged={refresh} />}
      {v && d.kind === "income_tax" && <Losses d={d} versionId={v.id} editable={isDraft} onChanged={refresh} />}
    </div>
  );
}

function LivePaper({ d, live, t }: { d: Detail; live: TaxComputationLive; t: T }) {
  const { n } = useLanguage();
  const glHref = (accountId: number | null) => accountId == null ? null : `/reports/general-ledger?account_id=${accountId}&date_from=${d.fiscalYear.startDate}&date_to=${d.fiscalYear.endDate}`;
  return (
    <>
      {live.blockers.length > 0 && (
        <Card className="border-border" data-testid="tax-blockers">
          <CardHeader className="pb-2"><CardTitle className="text-sm">{t("Why this cannot be computed yet", "لماذا لا يمكن الاحتساب بعد")}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {live.blockers.map((b) => (
              <div key={b.code} className="text-sm" data-testid={`tax-blocker-${b.code}`}>
                <p>{blockerLabel(b.code, b.message, t)}</p>
                {(b.accounts ?? []).length > 0 && (
                  <ul className="text-xs mt-1 space-y-0.5">{(b.accounts ?? []).map((a) => <li key={a.key}>{n(a.name, a.nameAr)} · <span className="font-mono" dir="ltr">{money(a.amount)}</span></li>)}</ul>
                )}
                {b.code === "zakat_unclassified_accounts" && <Link href="/zakat/classification" className="text-xs underline">{t("Classify these accounts", "صنِّف هذه الحسابات")}</Link>}
                {(b.code.includes("ownership") || b.code === "foreign_share_not_declared") && <Link href="/company" className="text-xs underline">{t("Company Settings", "إعدادات الشركة")}</Link>}
                {b.code.startsWith("income_tax_pool") && <Link href="/assets/income-tax-pool" className="text-xs underline">{t("Income-tax pool", "وعاء ضريبة الدخل")}</Link>}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card className="border-border" data-testid="tax-live">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-muted-foreground">{d.version && (d.version.status === "approved" || d.version.status === "superseded") ? t("Live recomputation (today's reading of the same year)", "إعادة الاحتساب الحية (قراءة اليوم للسنة نفسها)") : t("The working paper (live from the ledger)", "ورقة العمل (حية من الدفاتر)")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-lg" data-testid="tax-live-amount">{d.kind === "zakat" ? t("Zakat", "الزكاة") : t("Income tax", "ضريبة الدخل")}: <span className="font-mono font-semibold" dir="ltr">{live.amount == null ? t("not computed", "لم يُحتسب") : money(live.amount)}</span></p>

          {live.zakat?.result && (
            <>
              <StepsTable steps={live.zakat.result.steps} t={t} testId="tax-zakat-steps" />
              <div className="text-sm space-y-1">
                <p data-testid="tax-minimum-rule">{minimumRuleLabel(live.zakat.result.minimumRule, t)}</p>
                {live.zakat.result.maximumApplied && <p>{t("The maximum base (Art. 28 — equity, provisions and the difference) bound.", "طُبِّق الحد الأعلى للوعاء (المادة 28 — حقوق الملكية والمخصصات والفرق).")}</p>}
                {live.zakat.result.floorAboveCeiling && <p data-testid="tax-floor-above-ceiling">{t("The minimum base came out ABOVE the maximum; the maximum is applied after it, as the text orders them — open question Z-4.", "خرج الحد الأدنى للوعاء أعلى من الحد الأعلى؛ ويُطبَّق الحد الأعلى بعده كما رتّبهما النص — سؤال مفتوح Z-4.")}</p>}
                <p className="text-xs text-muted-foreground" data-testid="tax-rate">{t("Rate", "النسبة")} <span className="font-mono" dir="ltr">{live.zakat.result.rate.display}</span> — {live.zakat.calendar === "hijri" ? t("Art. 15(1): 2.5 % of the base for a Hijri year.", "المادة 15(1): 2.5% من الوعاء للسنة الهجرية.") : t(`Art. 15(2): 2.5 % ÷ 354 × the ${live.zakat.fiscalYearDays} days of the year (divisor per owner decision Q3; open question Z-1).`, `المادة 15(2): 2.5% ÷ 354 × أيام السنة البالغة ${live.zakat.fiscalYearDays} (المقسوم وفق قرار المالك Q3؛ سؤال مفتوح Z-1).`)}</p>
              </div>
              <div className="grid gap-3 md:grid-cols-2 text-sm">
                <div><p className="text-xs text-muted-foreground">{t("Book net profit (the income statement for the year)", "صافي الربح الدفتري (قائمة الدخل للسنة)")}</p><p className="font-mono" dir="ltr">{money(live.zakat.result.bookNetProfit)}</p></div>
                <div><p className="text-xs text-muted-foreground">{t("Adjusted net profit (book + declared adjustments)", "صافي الربح المعدل (الدفتري + التعديلات المُقرّة)")}</p><p className="font-mono" dir="ltr">{money(live.zakat.result.adjustedNetProfit)}</p></div>
                <div><p className="text-xs text-muted-foreground">{t("Non-current liabilities left out for undeducted assets (Art. 25(1))", "التزامات غير متداولة مستبعدة مقابل الأصول غير المحسومة (المادة 25(1))")}</p><p className="font-mono" dir="ltr">{money(live.zakat.result.nonCurrentLiabilitiesExcludedTotal)}</p></div>
                <div><p className="text-xs text-muted-foreground">{t("Current liabilities added for deducted current assets (Art. 25(2)) + excess over current assets (Art. 29(2)(b))", "التزامات متداولة مضافة مقابل الأصول المتداولة المحسومة (المادة 25(2)) + زيادتها على الأصول المتداولة (المادة 29(2)(ب))")}</p><p className="font-mono" dir="ltr">{money(live.zakat.result.currentLiabilitiesAddedForDeductedTotal)} + {money(live.zakat.result.currentLiabilitiesExcessOverCurrentAssets)}</p></div>
              </div>
            </>
          )}

          {live.zakat && (
            <div className="overflow-x-auto">
              <p className="text-xs font-medium mb-1">{t("The lines read from the balance sheet at the year-end, by class", "البنود المقروءة من قائمة المركز المالي في نهاية السنة، حسب التصنيف")}</p>
              <table className="w-full text-sm" data-testid="tax-zakat-lines">
                <thead><tr className="border-b border-border text-xs text-muted-foreground">{[t("Account", "الحساب"), t("Class", "التصنيف"), t("Article", "المادة"), t("Amount", "المبلغ")].map((h) => <th key={h} className="text-start pb-2 pe-3 font-medium">{h}</th>)}</tr></thead>
                <tbody>{live.zakat.lines.map((l) => {
                  const href = glHref(l.accountId);
                  return (
                    <tr key={l.key} className="border-b border-border/50">
                      <td className="py-1.5 pe-3">{href ? <Link href={href} className="underline">{n(l.name, l.nameAr)}</Link> : n(l.name, l.nameAr)}</td>
                      <td className="py-1.5 pe-3">{zakatClassLabel(l.zakatClass, t)}</td>
                      <td className="py-1.5 pe-3 font-mono text-xs" dir="ltr">{l.article}</td>
                      <td className="py-1.5 pe-3 text-end font-mono" dir="ltr">{money(l.amount)}</td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          )}

          {live.incomeTax && (
            <>
              <StepsTable steps={live.incomeTax.steps} t={t} testId="tax-income-steps" />
              <div className="grid gap-3 md:grid-cols-3 text-sm">
                <div><p className="text-xs text-muted-foreground">{t("Losses used (cap: 25 % of the income)", "الخسائر المستخدمة (السقف: 25% من الدخل)")}</p><p className="font-mono" dir="ltr">{money(live.incomeTax.lossUsed)} / {money(live.incomeTax.lossCap)}</p></div>
                <div><p className="text-xs text-muted-foreground">{t("The non-Saudi share", "حصة غير السعوديين")}</p><p className="font-mono" dir="ltr">{live.incomeTax.foreignSharePct}%</p></div>
                <div><p className="text-xs text-muted-foreground">{t("Loss of the year (carried forward if negative income)", "خسارة السنة (تُرحَّل إن كان الدخل سالبًا)")}</p><p className="font-mono" dir="ltr">{money(live.incomeTax.lossOfTheYear)}</p></div>
              </div>
              <p className="text-xs text-muted-foreground">{t("Current tax only — deferred tax (IAS 12) is not computed.", "الضريبة الجارية فقط — لا تُحتسب الضريبة المؤجلة (معيار المحاسبة الدولي 12).")}</p>
            </>
          )}

          <Reconciliation live={live} t={t} />
        </CardContent>
      </Card>
    </>
  );
}

function StepsTable({ steps, t, testId }: { steps: { key: string; article: string; amount: number }[]; t: T; testId: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid={testId}>
        <thead><tr className="border-b border-border text-xs text-muted-foreground">{[t("Step", "الخطوة"), t("Article", "المادة"), t("Amount", "المبلغ")].map((h) => <th key={h} className="text-start pb-2 pe-3 font-medium">{h}</th>)}</tr></thead>
        <tbody>{steps.map((s) => (
          <tr key={s.key} className="border-b border-border/50" data-testid={`${testId}-${s.key}`}>
            <td className="py-1.5 pe-3">{stepLabel(s.key, t)}</td>
            <td className="py-1.5 pe-3 font-mono text-xs" dir="ltr">{articleLabel(s.article, t)}</td>
            <td className="py-1.5 pe-3 text-end font-mono" dir="ltr">{money(s.amount)}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function Reconciliation({ live, t }: { live: TaxComputationLive; t: T }) {
  const r = live.reconciliation;
  if ("balanceSheetTotalAssets" in r) {
    const z = r as ZakatReconciliation;
    return (
      <div className="text-xs text-muted-foreground space-y-0.5 border-t border-border pt-3" data-testid="tax-reconciliation">
        <p>{t("Z1 — assets read from the balance sheet", "Z1 — الأصول المقروءة من قائمة المركز المالي")} <span className="font-mono" dir="ltr">{money(z.assetsRead)}</span> · {t("the balance sheet's total assets", "إجمالي أصول القائمة")} <span className="font-mono" dir="ltr">{money(z.balanceSheetTotalAssets)}</span>{z.excludedOwnAccruals > 0 ? t(" (this computation's own accrual taken out)", " (بعد إخراج استحقاق هذا الاحتساب نفسه)") : ""}</p>
        <p>{t("Z2 — book net profit", "Z2 — صافي الربح الدفتري")} <span className="font-mono" dir="ltr">{money(z.bookNetProfit)}</span>{z.balanceSheetYearResult != null ? <> · {t("the balance sheet's result of the year", "نتيجة السنة في القائمة")} <span className="font-mono" dir="ltr">{money(z.balanceSheetYearResult)}</span> · {z.bookProfitMatchesBalanceSheet ? t("equal", "متساويان") : t("NOT equal", "غير متساويين")}</> : <> · {t("(the company's fiscal year differs from this computation's — not compared)", "(تختلف السنة المالية للشركة عن سنة هذا الاحتساب — لم تُقارن)")}</>}</p>
      </div>
    );
  }
  const it = r as IncomeTaxReconciliation;
  return (
    <div className="text-xs text-muted-foreground space-y-0.5 border-t border-border pt-3" data-testid="tax-reconciliation">
      <p>{t("Net profit per the income statement", "صافي الربح حسب قائمة الدخل")} <span className="font-mono" dir="ltr">{money(it.profitPerIncomeStatement)}</span> · {t("Zakat and income tax added back", "الزكاة وضريبة الدخل المُضافة")} <span className="font-mono" dir="ltr">{money(it.zakatAndIncomeTaxAddedBack)}</span></p>
      <p>{t("Art. 17 pool", "وعاء المادة 17")}: {it.pool.status === "computed" ? t("computed", "محسوب") : it.pool.status === "not_requested" ? t("not read (income tax does not apply)", "لم يُقرأ (ضريبة الدخل لا تنطبق)") : it.pool.status}{it.pool.reason ? ` — ${it.pool.reason}` : ""}</p>
    </div>
  );
}

function Adjustments({ d, live, versionId, editable, onChanged }: { d: Detail; live: TaxComputationLive; versionId: number; editable: boolean; onChanged: () => void }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const targets: TaxAdjustmentInputTarget[] = d.kind === "zakat" ? ["adjusted_net_profit", "zakat_base"] : ["taxable_income"];
  const [form, setForm] = useState({ target: targets[0]!, effect: "increase" as TaxAdjustmentInputEffect, amount: "", reason: "", legalReference: "", sourceReference: "" });
  const add = useGuarded(useAddTaxAdjustment({ mutation: { onSuccess: () => { onChanged(); toast({ title: t("Adjustment added", "أُضيف التعديل") }); setForm((f) => ({ ...f, amount: "", reason: "", legalReference: "", sourceReference: "" })); } } }));
  const remove = useGuarded(useRemoveTaxAdjustment({ mutation: { onSuccess: () => { onChanged(); toast({ title: t("Adjustment removed", "أُزيل التعديل") }); } } }));
  const valid = Number(form.amount) > 0 && form.reason.trim().length > 0 && form.legalReference.trim().length > 0;
  return (
    <Card className="border-border" data-testid="tax-adjustments">
      <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Declared adjustments", "التعديلات المُقرّة")}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{d.kind === "zakat"
          ? t("Adjustments to net profit (Arts 62–65) or directly to the base, each with its reason and its article. They move the working paper only — never the ledger.", "تعديلات على صافي الربح (المواد 62–65) أو على الوعاء مباشرة، لكل منها سببه ومادته. تحرّك ورقة العمل فقط — لا الدفاتر.")
          : t("Non-deductible items, provisions, bad debts and other differences you declare (Arts 12–15), each with its reason and its article. They move the computation only — never the ledger.", "البنود غير القابلة للحسم والمخصصات والديون المعدومة وغيرها من الفروق التي تُقرّها (المواد 12–15)، لكل منها سببه ومادته. تحرّك الاحتساب فقط — لا الدفاتر.")}</p>
        {live.adjustments.length === 0 ? <p className="text-sm text-muted-foreground">{t("No adjustment declared.", "لا تعديل مُقر.")}</p> : (
          <div className="overflow-x-auto"><table className="w-full text-sm" data-testid="tax-adjustments-table">
            <thead><tr className="border-b border-border text-xs text-muted-foreground">{[t("Target", "الهدف"), t("Effect", "الأثر"), t("Amount", "المبلغ"), t("Reason", "السبب"), t("Article", "المادة"), t("Source", "المصدر"), ""].map((h) => <th key={h} className="text-start pb-2 pe-3 font-medium">{h}</th>)}</tr></thead>
            <tbody>{live.adjustments.map((a) => (
              <tr key={a.id} className="border-b border-border/50" data-testid={`tax-adjustment-${a.id}`}>
                <td className="py-1.5 pe-3">{adjustmentTargetLabel(a.target, t)}</td>
                <td className="py-1.5 pe-3">{a.effect === "increase" ? t("Increase", "زيادة") : t("Decrease", "نقص")}</td>
                <td className="py-1.5 pe-3 text-end font-mono" dir="ltr">{money(a.amount)}</td>
                <td className="py-1.5 pe-3">{a.reason}</td>
                <td className="py-1.5 pe-3 text-xs">{a.legalReference}</td>
                <td className="py-1.5 pe-3 text-xs">{a.sourceReference ?? "—"}</td>
                <td className="py-1.5">{editable && <Button size="sm" variant="ghost" className="h-7" disabled={remove.isPending} onClick={() => remove.mutate({ id: d.id, versionId, adjustmentId: a.id })} data-testid={`tax-adjustment-remove-${a.id}`}>{t("Remove", "إزالة")}</Button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {editable ? (
          <div className="grid gap-3 sm:grid-cols-3 items-end border-t border-border pt-3" data-testid="tax-adjustment-form">
            <div><Label className="text-xs text-muted-foreground">{t("Target", "الهدف")}</Label>
              <Select value={form.target} onValueChange={(x) => setForm((f) => ({ ...f, target: x as TaxAdjustmentInputTarget }))}><SelectTrigger className="h-9 text-sm" data-testid="tax-adjustment-target"><SelectValue /></SelectTrigger>
                <SelectContent>{targets.map((x) => <SelectItem key={x} value={x}>{adjustmentTargetLabel(x, t)}</SelectItem>)}</SelectContent></Select></div>
            <div><Label className="text-xs text-muted-foreground">{t("Effect", "الأثر")}</Label>
              <Select value={form.effect} onValueChange={(x) => setForm((f) => ({ ...f, effect: x as TaxAdjustmentInputEffect }))}><SelectTrigger className="h-9 text-sm" data-testid="tax-adjustment-effect"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="increase">{t("Increase", "زيادة")}</SelectItem><SelectItem value="decrease">{t("Decrease", "نقص")}</SelectItem></SelectContent></Select></div>
            <div><Label className="text-xs text-muted-foreground">{t("Amount", "المبلغ")}</Label><Input dir="ltr" inputMode="decimal" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} data-testid="tax-adjustment-amount" /></div>
            <div className="sm:col-span-2"><Label className="text-xs text-muted-foreground">{t("Reason", "السبب")}</Label><Input value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} data-testid="tax-adjustment-reason" /></div>
            <div><Label className="text-xs text-muted-foreground">{t("Article", "المادة")}</Label><Input value={form.legalReference} onChange={(e) => setForm((f) => ({ ...f, legalReference: e.target.value }))} placeholder={d.kind === "zakat" ? t("e.g. Zakat Regulations Art. 62", "مثلًا: لائحة الزكاة المادة 62") : t("e.g. Income Tax Law Art. 13", "مثلًا: نظام ضريبة الدخل المادة 13")} data-testid="tax-adjustment-article" /></div>
            <div className="sm:col-span-2"><Label className="text-xs text-muted-foreground">{t("Source document (optional)", "المستند المصدر (اختياري)")}</Label><Input value={form.sourceReference} onChange={(e) => setForm((f) => ({ ...f, sourceReference: e.target.value }))} data-testid="tax-adjustment-source" /></div>
            <Button disabled={!valid || add.isPending} data-testid="tax-adjustment-add"
              onClick={() => add.mutate({ id: d.id, versionId, data: { target: form.target, effect: form.effect, amount: Number(form.amount), reason: form.reason.trim(), legalReference: form.legalReference.trim(), sourceReference: form.sourceReference.trim() || null } })}>
              {t("Add adjustment", "إضافة تعديل")}
            </Button>
          </div>
        ) : <p className="text-xs text-muted-foreground">{t("Only a draft version's adjustments are edited; revise an approved computation to change them.", "تُعدَّل تعديلات المسودة فقط؛ راجِع الاحتساب المعتمد لتغييرها.")}</p>}
      </CardContent>
    </Card>
  );
}

function Losses({ d, versionId, editable, onChanged }: { d: Detail; versionId: number; editable: boolean; onChanged: () => void }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const v = d.version;
  const [amount, setAmount] = useState(v?.lossCarryforwardAvailable == null ? "" : String(v.lossCarryforwardAvailable));
  const [reference, setReference] = useState(v?.lossCarryforwardReference ?? "");
  const save = useGuarded(useSetTaxLosses({ mutation: { onSuccess: () => { onChanged(); toast({ title: t("Losses carried forward saved", "حُفظت الخسائر المرحلة") }); } } }));
  return (
    <Card className="border-border" data-testid="tax-losses">
      <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Losses carried forward", "الخسائر المرحلة")}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{t("Only losses shown in audited statutory accounts are carried forward (IR Art. 11), and a change of 50 % or more in ownership ends them (Art. 21). The deduction is capped at 25 % of the year's taxable income.", "لا تُرحَّل إلا الخسائر الظاهرة في القوائم النظامية المدققة (المادة 11 من اللائحة)، وينهيها تغيّر الملكية بنسبة 50% أو أكثر (المادة 21). ويُحدّ الحسم بنسبة 25% من الدخل الخاضع للضريبة للسنة.")}</p>
        {editable ? (
          <div className="grid gap-3 sm:grid-cols-3 items-end">
            <div><Label className="text-xs text-muted-foreground">{t("Available (blank = none)", "المتاح (فارغ = لا شيء)")}</Label><Input dir="ltr" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="tax-losses-amount" /></div>
            <div><Label className="text-xs text-muted-foreground">{t("Audited accounts they come from", "القوائم المدققة المصدر")}</Label><Input value={reference} onChange={(e) => setReference(e.target.value)} data-testid="tax-losses-reference" /></div>
            <Button disabled={save.isPending} data-testid="tax-losses-save" onClick={() => save.mutate({ id: d.id, versionId, data: { amount: amount.trim() === "" ? null : Number(amount), reference: reference.trim() || null } })}>{t("Save", "حفظ")}</Button>
          </div>
        ) : <p className="text-sm">{t("Available", "المتاح")} <span className="font-mono" dir="ltr">{money(v?.lossCarryforwardAvailable)}</span>{v?.lossCarryforwardReference ? ` · ${v.lossCarryforwardReference}` : ""}</p>}
      </CardContent>
    </Card>
  );
}
