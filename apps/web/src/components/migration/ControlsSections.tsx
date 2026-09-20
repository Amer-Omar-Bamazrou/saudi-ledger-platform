/**
 * Batch 1C — the two control views.
 *
 *   ValidationSection    — runs the server's validation (zero ledger writes),
 *                          shows every control as PASS / WARNING / BLOCKED /
 *                          NOT APPLICABLE, and for each blocked control offers
 *                          the way to the staging records it points at
 *                          (`sectionForCheck`), plus the list of every staged
 *                          row that carries a problem today, each one a link
 *                          to that exact record.
 *   ReconciliationSection— the pre-commit controls that mirror R2/R3/R4/R9/R10
 *                          on the staged position, and R1–R10 as the commit
 *                          computed them on the POSTED ledger (stored on the
 *                          batch; null before commit).
 *
 * Nothing here is computed on the client.
 */
import { useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowRight, ListChecks, ShieldCheck } from "lucide-react";
import { sectionForCheck, summariseChecks } from "@/lib/migrationImport";
import { Money, VerdictBadge, invalidateMigration, storedReconciliation, storedValidation, useAdvances, useCanRunMigration, useChart, useOpenItems, useOpeningPosition, useParties, useWorkspaceNav, SECTION_LABELS } from "./shared";
import type { MigrationBatchDetail, MigrationControlCheck, MigrationValidation } from "@workspace/api-client-react";

function CheckRow({ c, onGo }: { c: MigrationControlCheck; onGo?: () => void }) {
  const { t } = useLanguage();
  // Walk defect 2026-09-20: a control's expected/actual is sometimes a COUNT (problems, rows) and sometimes an
  // AMOUNT; forcing "SAR" on every number read "SAR 1.00" for one blocked item. Numbers render as numbers.
  const fmtVal = (v: number | string | null) => (v == null ? "—" : typeof v === "number" ? <span dir="ltr" className="font-mono">{v.toLocaleString("en-SA", { maximumFractionDigits: 2 })}</span> : <span dir="ltr">{v}</span>);
  return (
    <div className="rounded-md border border-border p-3 flex flex-col sm:flex-row sm:items-start gap-2" data-testid={`check-${c.id}`} data-status={c.status}>
      <div className="sm:w-36 shrink-0 flex sm:flex-col gap-2 sm:gap-1 items-center sm:items-start"><VerdictBadge check={c} /><span className="font-mono text-xs text-muted-foreground">{c.id}</span></div>
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">{c.title}</p>
        <p className="text-xs text-muted-foreground break-words mt-0.5">{c.detail}</p>
        {(c.expected != null || c.actual != null) && <p className="text-xs mt-1"><span className="text-muted-foreground">{t("expected", "المتوقع")}:</span> {fmtVal(c.expected)} · <span className="text-muted-foreground">{t("actual", "الفعلي")}:</span> {fmtVal(c.actual)}</p>}
      </div>
      {onGo && c.status === "fail" && <Button variant="outline" size="sm" className="h-8 text-xs shrink-0" onClick={onGo} data-testid={`go-${c.id}`}>{t("Go to affected records", "الانتقال إلى السجلات المتأثرة")}<ArrowRight className="w-3 h-3 ms-1 rtl:rotate-180" /></Button>}
    </div>
  );
}

export function ValidationSection({ batch }: { batch: MigrationBatchDetail }) {
  const { t, lang } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const canRun = useCanRunMigration();
  const { go } = useWorkspaceNav();
  const editable = batch.status === "draft" || batch.status === "validated";
  const validation = storedValidation(batch);
  const { data: chart } = useChart(batch.id);
  const { data: parties } = useParties(batch.id);
  const { data: items } = useOpenItems(batch.id);
  const { data: advances } = useAdvances(batch.id);
  const { data: position } = useOpeningPosition(batch.id);

  const run = useMutation({
    mutationFn: () => apiFetch<MigrationValidation>(`/migration/batches/${batch.id}/validate`, { method: "POST" }),
    onSuccess: (v) => {
      invalidateMigration(qc, batch.id);
      const s = summariseChecks(v.checks);
      toast({ title: v.ok ? t("Validation passed", "نجح التحقق") : t(`Validation blocked — ${s.blocking} issue(s)`, `التحقق محظور — ${s.blocking} مشكلة`), description: t("Nothing was posted: validation never writes to the ledger.", "لم يُرحَّل شيء: التحقق لا يكتب في الدفاتر أبدًا."), variant: v.ok ? undefined : "destructive" });
    },
  });

  // Every staged record with a server problem, in one list, each linking to itself.
  const problemRows = useMemo(() => {
    const out: Array<{ id: number; section: "chart" | "parties" | "ar" | "ap" | "advances"; label: string; problems: string[] }> = [];
    for (const r of chart?.rows ?? []) if (r.problems.length) out.push({ id: r.id, section: "chart", label: `${r.sourceCode} ${r.sourceName}`, problems: r.problems });
    for (const r of parties?.rows ?? []) if (r.problems.length) out.push({ id: r.id, section: "parties", label: `${r.partyType} ${r.sourceId} ${r.name}`, problems: r.problems });
    for (const r of items?.rows ?? []) if (r.problems.length) out.push({ id: r.id, section: r.itemType, label: `${r.itemType.toUpperCase()} ${r.documentNumber}`, problems: r.problems });
    for (const r of advances?.rows ?? []) if (r.problems.length) out.push({ id: r.id, section: "advances", label: `${t("advance", "دفعة مقدمة")} ${r.sourceId}`, problems: r.problems });
    return out;
  }, [chart, parties, items, advances, t]);

  const checks = validation?.checks ?? position?.controls ?? [];
  const s = summariseChecks(checks);
  const stale = !validation && position;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t("Validation", "التحقق")}</h2>
          <p className="text-sm text-muted-foreground">{t("Server-authoritative, zero-ledger-write. A BLOCKED control stops the commit; a WARNING does not. Fix the staging record it points at and validate again.", "بمرجعية الخادم، دون أي كتابة في الدفاتر. الضابط المحظور يوقف الاعتماد؛ والتحذير لا يوقفه. صحّح سجل التجهيز الذي يشير إليه ثم أعد التحقق.")}</p>
        </div>
        {editable && canRun && <Button size="sm" disabled={run.isPending} onClick={() => run.mutate()} data-testid="run-validation"><ShieldCheck className="w-3.5 h-3.5 me-1" />{run.isPending ? t("Validating…", "جارٍ التحقق…") : validation ? t("Validate again", "إعادة التحقق") : t("Run validation", "تشغيل التحقق")}</Button>}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[[t("Blocking", "محظور"), s.blocking, s.blocking > 0 ? "text-negative" : "text-positive"], [t("Warnings", "تحذيرات"), s.warnings, s.warnings > 0 ? "text-attention" : ""], [t("Passed", "ناجح"), s.passed, "text-positive"], [t("Last run", "آخر تشغيل"), validation?.at ? new Date(validation.at).toLocaleString(lang === "ar" ? "ar-SA-u-ca-gregory-nu-latn" : "en-SA") : t("never", "لم يُشغَّل")]].map(([l, v, c], i) => (
          <Card key={i}><CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground">{l}</CardTitle></CardHeader><CardContent><div className={`text-base font-semibold ${c ?? ""}`} data-testid={`validation-kpi-${i}`}>{v}</div></CardContent></Card>
        ))}
      </div>
      {stale && <p className="text-xs text-muted-foreground" data-testid="validation-preview-note">{t("Showing the controls as they stand on the staged position now (a preview). Run validation to record a result on the batch.", "تُعرض الضوابط كما هي على المركز المجهّز الآن (معاينة). شغّل التحقق لتسجيل نتيجة على الدفعة.")}</p>}
      {validation && batch.status === "draft" && !validation.ok && <p className="text-sm text-negative" data-testid="validation-blocked-banner">{t(`The last validation was BLOCKED by ${s.blocking} control(s). The batch cannot be committed until they pass.`, `آخر تحقق كان محظورًا بسبب ${s.blocking} ضابط. لا يمكن اعتماد الدفعة حتى تنجح.`)}</p>}
      {validation && batch.status === "validated" && <p className="text-sm text-positive" data-testid="validation-ok-banner">{t("Validated. The staged content is sealed by a content hash — any staging change re-opens the batch.", "تم التحقق. المحتوى المجهّز مختوم بتجزئة محتوى — أي تغيير في التجهيز يعيد فتح الدفعة.")}</p>}

      <div className="space-y-2" data-testid="validation-checks">
        {checks.length === 0 ? <p className="text-sm text-muted-foreground">{t("Stage the chart first — there is nothing to validate yet.", "جهّز الدليل أولًا — لا يوجد ما يُتحقق منه بعد.")}</p>
          : checks.map((c) => <CheckRow key={c.id} c={c} onGo={() => go(sectionForCheck(c.id), { blocked: true })} />)}
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><ListChecks className="w-4 h-4" />{t(`Staged records with problems (${problemRows.length})`, `سجلات مجهّزة بها مشاكل (${problemRows.length})`)}</CardTitle></CardHeader>
        <CardContent>
          {problemRows.length === 0 ? <p className="text-sm text-positive">{t("No staged record carries a problem.", "لا يحمل أي سجل مجهّز مشكلة.")}</p> : (
            <ul className="divide-y divide-border/50" data-testid="problem-rows">
              {problemRows.map((r) => (
                <li key={`${r.section}-${r.id}`} className="py-2 flex flex-col sm:flex-row sm:items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium break-words"><span className="text-xs text-muted-foreground uppercase me-2">{SECTION_LABELS[r.section][lang === "ar" ? 1 : 0]}</span>{r.label}</p>
                    <ul className="text-xs text-negative">{r.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
                  </div>
                  <Button variant="outline" size="sm" className="h-8 text-xs shrink-0" onClick={() => go(r.section, { focus: r.id })} data-testid={`open-problem-${r.id}`}>{t("Open record", "فتح السجل")}<ArrowRight className="w-3 h-3 ms-1 rtl:rotate-180" /></Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function ReconciliationSection({ batch }: { batch: MigrationBatchDetail }) {
  const { t } = useLanguage();
  const { go } = useWorkspaceNav();
  const rec = storedReconciliation(batch);
  const { data: position } = useOpeningPosition(batch.id);
  const pre = (position?.controls ?? []).filter((c) => /\(R\d+\)/.test(c.title));
  const figures = rec?.figures ?? null;
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">{t("Reconciliation — R1 to R10", "المطابقة — R1 إلى R10")}</h2>
        <p className="text-sm text-muted-foreground">{t("The ten gates are computed by the server AT COMMIT, against the ledger it has just posted, inside the same transaction: a failing gate rolls the whole commit back. Every gate is blocking. Before commit, the staged position's own controls preview the ones that can be checked without posting (R2, R3, R4, R9, R10).", "تُحتسب البوابات العشر على الخادم عند الاعتماد، مقابل الدفاتر التي رحّلها للتو، داخل المعاملة نفسها: أي بوابة فاشلة تلغي الاعتماد كله. كل بوابة حاجبة. قبل الاعتماد، تعاين ضوابط المركز المجهّز ما يمكن فحصه دون ترحيل (R2، R3، R4، R9، R10).")}</p>
      </div>
      {rec ? (
        <>
          <p className="text-sm text-positive" data-testid="reconciliation-committed">{t("Computed at commit on the posted ledger.", "احتُسبت عند الاعتماد على الدفاتر المرحَّلة.")}</p>
          <div className="space-y-2" data-testid="reconciliation-checks">{rec.checks.map((c) => <CheckRow key={c.id} c={c} />)}</div>
          {figures && (
            <Card><CardHeader className="pb-2"><CardTitle className="text-sm">{t("Committed figures", "الأرقام المعتمدة")}</CardTitle></CardHeader><CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 text-sm">{Object.entries(figures).map(([k, v]) => <div key={k} className="rounded border border-border/60 p-2"><p className="text-[11px] text-muted-foreground font-mono">{k}</p><Money v={v} /></div>)}</div>
            </CardContent></Card>
          )}
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground" data-testid="reconciliation-pending">{t("Not computed yet — R1–R10 exist only once the migration is committed.", "لم تُحتسب بعد — لا توجد R1–R10 إلا بعد اعتماد الترحيل.")}</p>
          <h3 className="text-sm font-medium">{t("Pre-commit controls on the staged position", "ضوابط ما قبل الاعتماد على المركز المجهّز")}</h3>
          <div className="space-y-2" data-testid="precommit-checks">{pre.length === 0 ? <p className="text-sm text-muted-foreground">{t("Stage the chart first.", "جهّز الدليل أولًا.")}</p> : pre.map((c) => <CheckRow key={c.id} c={c} onGo={() => go(sectionForCheck(c.id), { blocked: true })} />)}</div>
        </>
      )}
    </div>
  );
}
