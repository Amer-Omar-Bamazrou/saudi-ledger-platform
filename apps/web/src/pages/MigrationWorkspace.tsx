/**
 * Batch 1C — THE MIGRATION WORKSPACE (`/migration/:id`), 2026-09-20.
 *
 * One batch, twelve sections, one server. The section is in the URL
 * (`?section=`), so a validation failure can hand the operator a link to the
 * exact staging record (`&focus=`), and the header shows the SERVER's status
 * of the batch with the actions that state allows:
 *
 *   draft            → continue setup · validate
 *   validation failed→ review issues · fix · validate again
 *   validated        → review · commit
 *   committed        → results · opening records · journal · provenance ·
 *                      (admin) reverse
 *
 * Nothing on any screen is computed here; nothing here can bypass a server
 * control. OBE does not exist and is not offered; a difference blocks.
 */
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "wouter";
import { apiFetch } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Database } from "lucide-react";
import { SECTIONS, summariseChecks, type WorkspaceSection } from "@/lib/migrationImport";
import { BatchStatusBadge, Facts, MigrationPermissionHint, Money, SECTION_LABELS, isEditable, storedValidation, useBatch, useCanRunMigration, useOpeningPosition, useWorkspaceNav } from "@/components/migration/shared";
import { ChartSection } from "@/components/migration/ChartSection";
import { PartiesSection } from "@/components/migration/PartiesSection";
import { OpenItemsSection } from "@/components/migration/OpenItemsSection";
import { AdvancesSection } from "@/components/migration/AdvancesSection";
import { BanksSection, TrialBalanceSection, VatSection } from "@/components/migration/BalancesSections";
import { ReconciliationSection, ValidationSection } from "@/components/migration/ControlsSections";
import { CommitSection } from "@/components/migration/CommitSection";
import type { Company, MigrationBatchDetail } from "@workspace/api-client-react";

function Overview({ batch, companyName }: { batch: MigrationBatchDetail; companyName: string }) {
  const { t, lang } = useLanguage();
  const { go } = useWorkspaceNav();
  const canRun = useCanRunMigration();
  const { data: position } = useOpeningPosition(batch.id, isEditable(batch));
  const validation = storedValidation(batch);
  const s = validation ? summariseChecks(validation.checks) : null;
  const fmtTs = (v: string | null) => (v ? new Date(v).toLocaleString(lang === "ar" ? "ar-SA-u-ca-gregory-nu-latn" : "en-SA") : "—");
  const balanceState = !position ? null : Math.abs(position.totals.difference) < 0.005 ? "balanced" : "unbalanced";
  const validationState = batch.status === "committed" || batch.status === "reversed" ? "committed" : batch.status === "validated" ? "validated" : validation ? "failed" : "not-run";

  const actions: Array<{ label: string; section: WorkspaceSection; primary?: boolean; blocked?: boolean }> =
    batch.status === "draft" && validationState === "failed" ? [{ label: t("Review issues", "مراجعة المشاكل"), section: "validation", primary: true }, { label: t("Fix staging", "تصحيح التجهيز"), section: "chart" }, { label: t("Validate again", "إعادة التحقق"), section: "validation" }]
    : batch.status === "draft" ? [{ label: t("Continue setup", "متابعة الإعداد"), section: batch.counts.chartRows === 0 ? "chart" : batch.counts.parties === 0 ? "parties" : "validation", primary: true }, { label: t("Validate", "تحقق"), section: "validation" }]
    : batch.status === "validated" ? [{ label: t("Review migration", "مراجعة الترحيل"), section: "trial-balance" }, { label: t("Commit", "اعتماد"), section: "commit", primary: true }]
    : [{ label: t("View results", "عرض النتائج"), section: "commit", primary: true }, { label: t("Opening records", "السجلات الافتتاحية"), section: "ar" }, { label: t("Reconciliation", "المطابقة"), section: "reconciliation" }, { label: t("Provenance", "المصدر"), section: "parties" }];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2"><CardTitle className="text-sm">{t("Migration", "الترحيل")} #{batch.id}</CardTitle></CardHeader>
          <CardContent>
            <Facts items={[
              [t("Status", "الحالة"), <BatchStatusBadge key="s" status={batch.status} testId="overview-status" />],
              [t("Company", "الشركة"), companyName],
              [t("Opening date", "تاريخ الافتتاح"), <span key="od" dir="ltr">{batch.openingDate}</span>],
              [t("Cut-over (first day here)", "القطع (أول يوم هنا)"), <span key="cd" dir="ltr">{batch.cutoverDate}</span>],
              [t("Source system", "النظام المصدر"), `${batch.sourceSystem}${batch.sourceVersion ? ` ${batch.sourceVersion}` : ""}`],
              [t("Created by", "أنشأه"), batch.createdBy != null ? `#${batch.createdBy}` : "—"],
              [t("Created", "تاريخ الإنشاء"), fmtTs(batch.createdAt)],
              [t("Last validation", "آخر تحقق"), <span key="v" data-testid="overview-validation">{validationState === "committed" ? t("committed", "معتمد") : validationState === "validated" ? `${t("passed", "ناجح")} · ${fmtTs(batch.validatedAt)}` : validationState === "failed" ? `${t("BLOCKED", "محظور")} · ${fmtTs(validation?.at ?? null)}` : t("not run yet", "لم يُشغَّل بعد")}</span>],
              [t("Balance", "التوازن"), <span key="b" data-testid="overview-balance" className={balanceState === "balanced" ? "text-positive" : balanceState === "unbalanced" ? "text-negative" : ""}>{balanceState === "balanced" ? t("balanced (difference 0.00)", "متوازن (الفرق 0.00)") : balanceState === "unbalanced" ? <>{t("NOT balanced — difference", "غير متوازن — الفرق")} <Money v={position!.totals.difference} /></> : batch.status === "committed" ? t("posted, balanced", "مرحَّل ومتوازن") : "—"}</span>],
              [t("Blocking issues", "المشاكل الحاجبة"), <span key="bi" data-testid="overview-blocking" className={s && s.blocking > 0 ? "text-negative" : "text-positive"}>{s ? s.blocking : "—"}</span>],
              [t("Warnings", "التحذيرات"), s ? s.warnings : "—"],
              [t("Notes", "ملاحظات"), batch.notes ?? "—"],
            ]} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">{t("Record counts", "عدد السجلات")}</CardTitle></CardHeader>
          <CardContent>
            <ul className="text-sm space-y-1" data-testid="overview-counts">
              {[[t("Chart rows", "صفوف الدليل"), batch.counts.chartRows, "chart" as const], [t("— unmapped", "— غير مربوطة"), batch.counts.chartRowsUnmapped, "chart" as const], [t("Parties", "الأطراف"), batch.counts.parties, "parties" as const], [t("Open items", "البنود المفتوحة"), batch.counts.openItems, "ar" as const], [t("Advances", "الدفعات المقدمة"), batch.counts.advances, "advances" as const]].map(([l, v, sec], i) => (
                <li key={i} className="flex justify-between gap-2"><button className="text-start hover:underline" onClick={() => go(sec as WorkspaceSection)}>{l}</button><span className={`font-mono ${i === 1 && Number(v) > 0 ? "text-negative" : ""}`}>{v}</span></li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
      <div className="flex flex-wrap gap-2" data-testid="overview-actions">
        {actions.map((a) => <Button key={a.label} variant={a.primary ? "default" : "outline"} size="sm" onClick={() => go(a.section)}>{a.label}</Button>)}
      </div>
      {!canRun && <MigrationPermissionHint />}
      <p className="text-xs text-muted-foreground">{t("Lifecycle: draft → validated → committed → reversed, or discarded. The status shown is the server's. There is no opening-balance-equity account and no automatic balancing: an unbalanced position, an unresolved mapping, an undecided party, an invalid item, a failing VAT reconciliation or a failing bank check blocks the commit.", "دورة الحياة: مسودة ← تم التحقق ← معتمد ← معكوس، أو مهمل. الحالة المعروضة هي حالة الخادم. لا يوجد حساب حقوق ملكية للأرصدة الافتتاحية ولا موازنة تلقائية: أي مركز غير متوازن أو ربط غير محسوم أو طرف لم يُقرَّر أو بند غير صالح أو مطابقة ضريبية أو بنكية فاشلة يوقف الاعتماد.")}</p>
    </div>
  );
}

export default function MigrationWorkspace() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const { t, lang } = useLanguage();
  const { section, go } = useWorkspaceNav();
  const { data: batch, isLoading, error } = useBatch(id);
  const { data: company } = useQuery<Company>({ queryKey: ["company", "current"], queryFn: () => apiFetch("/companies/current") });
  const companyName = company ? (lang === "ar" && company.nameAr ? company.nameAr : company.name) : "—";

  if (!Number.isInteger(id) || id <= 0) return <p className="text-sm text-destructive">{t("Not a migration batch.", "ليست دفعة ترحيل.")}</p>;
  if (isLoading) return <p className="text-sm text-muted-foreground p-4">{t("Loading…", "جارٍ التحميل…")}</p>;
  if (error || !batch) return <p className="text-sm text-destructive p-4" data-testid="workspace-error">{t("This migration could not be loaded.", "تعذر تحميل هذا الترحيل.")} {(error as Error)?.message}</p>;
  const editable = isEditable(batch);
  const committed = batch.status === "committed" || batch.status === "reversed";
  const label = (s: WorkspaceSection) => SECTION_LABELS[s][lang === "ar" ? 1 : 0];

  return (
    <div className="space-y-4" data-testid="migration-workspace">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <Link href="/migration" className="text-xs text-muted-foreground inline-flex items-center gap-1 hover:underline"><ArrowLeft className="w-3 h-3 rtl:rotate-180" />{t("All migrations", "كل عمليات الترحيل")}</Link>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2 flex-wrap"><Database className="w-5 h-5" />{t("Migration", "الترحيل")} #{batch.id} <BatchStatusBadge status={batch.status} /></h1>
          <p className="text-muted-foreground text-sm mt-1">{companyName} · {t("opening date", "تاريخ الافتتاح")} <span dir="ltr">{batch.openingDate}</span> · {batch.sourceSystem}</p>
        </div>
      </div>

      {/* Section navigation: a scrollable tab strip on wide screens, a select on phones (twelve tabs do not fit a phone). */}
      {/* Walk defect 2026-09-20: twelve tabs overflowed a 1280px window into a scrolling strip with a scrollbar. They wrap instead. */}
      <div className="hidden md:block">
        <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1" role="tablist" data-testid="section-tabs">
          {SECTIONS.map((s) => (
            <button key={s} role="tab" aria-selected={section === s} onClick={() => go(s)} data-testid={`tab-${s}`}
              className={`whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-all ${section === s ? "bg-background text-foreground shadow" : "text-muted-foreground hover:text-foreground"}`}>
              {label(s)}
            </button>
          ))}
        </div>
      </div>
      <div className="md:hidden">
        <Select value={section} onValueChange={(v) => go(v as WorkspaceSection)}>
          <SelectTrigger className="h-10 text-sm" data-testid="section-select"><SelectValue /></SelectTrigger>
          <SelectContent>{SECTIONS.map((s) => <SelectItem key={s} value={s}>{label(s)}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      <div data-testid={`section-${section}`}>
        {section === "overview" && <Overview batch={batch} companyName={companyName} />}
        {section === "chart" && <ChartSection batchId={batch.id} editable={editable} />}
        {section === "parties" && <PartiesSection batchId={batch.id} editable={editable} />}
        {section === "ar" && <OpenItemsSection batchId={batch.id} editable={editable} side="ar" openingDate={batch.openingDate} committed={committed} />}
        {section === "ap" && <OpenItemsSection batchId={batch.id} editable={editable} side="ap" openingDate={batch.openingDate} committed={committed} />}
        {section === "advances" && <AdvancesSection batchId={batch.id} editable={editable} />}
        {section === "banks" && <BanksSection batchId={batch.id} openingDate={batch.openingDate} />}
        {section === "vat" && <VatSection batch={batch} editable={editable} />}
        {section === "trial-balance" && <TrialBalanceSection batchId={batch.id} openingDate={batch.openingDate} />}
        {section === "reconciliation" && <ReconciliationSection batch={batch} />}
        {section === "validation" && <ValidationSection batch={batch} />}
        {section === "commit" && <CommitSection batch={batch} companyName={companyName} />}
      </div>
    </div>
  );
}
