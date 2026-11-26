/**
 * 🔴 19B S6 — SAVED REPORTS: the reports this member saved, and those shared with their role (scope 19.13). The list is
 * the server's: a report on data the role may not run is not in it. Opening one runs it through the builder, where the
 * run is checked for the reader's own role. Only the owner can remove one, and removal archives it — the server says so
 * for anyone else.
 */
import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { getListReportDefinitionsQueryKey, useArchiveReportDefinition, useListReportDatasets, useListReportDefinitions } from "@workspace/api-client-react";
import { REPORT_PERIOD_LABELS } from "@workspace/shared";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { ScheduleForm, ScheduleList } from "@/components/reports/ReportSchedules";

const ROLE_WORDS: Record<string, [string, string]> = {
  admin: ["Admins", "المسؤولون"], accountant: ["Accountants", "المحاسبون"], bookkeeper: ["Bookkeepers", "ماسكو الدفاتر"], viewer: ["Viewers", "المشاهدون"],
};

export default function SavedReports() {
  const { t, lang } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useListReportDefinitions();
  const datasets = useListReportDatasets().data?.items ?? [];
  const archive = useArchiveReportDefinition();
  const [scheduling, setScheduling] = useState<number | null>(null);
  const actsOf = (dataset: string) => datasets.find((x) => x.name === dataset)?.acts ?? [];

  const remove = async (id: number, name: string) => {
    try {
      await archive.mutateAsync({ id });
      await qc.invalidateQueries({ queryKey: getListReportDefinitionsQueryKey() });
      toast({ title: t("Report removed", "تمت إزالة التقرير"), description: name });
    } catch (e) {
      toast({ title: t("The report was not removed", "لم يُزل التقرير"), description: (e as Error).message, variant: "destructive" });
    }
  };
  const titleOf = (dataset: string) => { const d = datasets.find((x) => x.name === dataset); return d ? (lang === "ar" ? d.titleAr : d.title) : dataset; };
  const items = data?.items ?? [];

  return (
    <div className="space-y-6" data-testid="saved-reports-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Saved reports", "التقارير المحفوظة")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("Your reports, and those shared with your role. Each run shows only what your own role allows.", "تقاريرك والتقارير المشتركة مع دورك. كل تشغيل يعرض فقط ما يسمح به دورك.")}</p>
        </div>
        <Button asChild size="sm" className="h-8"><Link href="/reports/builder" data-testid="saved-new">{t("New report", "تقرير جديد")}</Link></Button>
      </div>

      <Card className="border-border bg-card">
        <CardContent className="pt-4">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="saved-empty">{t("No saved reports yet. Build one and save it.", "لا توجد تقارير محفوظة بعد. أنشئ تقريراً واحفظه.")}</p>
          ) : (
            <ul className="divide-y divide-border" data-testid="saved-list">
              {items.map((d) => (
                <li key={d.id} className="py-3 flex flex-wrap items-center gap-3" data-testid={`saved-item-${d.id}`}>
                  <div className="flex-1 min-w-[12rem]">
                    <Link href={`/reports/builder?id=${d.id}`} className="text-sm font-medium text-foreground underline" data-testid={`saved-open-${d.id}`}>{d.name}</Link>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {titleOf(d.dataset)} · {d.period.kind === "fixed" ? <span dir="ltr">{d.period.from} – {d.period.to}</span> : t(REPORT_PERIOD_LABELS[d.period.kind][0], REPORT_PERIOD_LABELS[d.period.kind][1])}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5" data-testid={`saved-owner-${d.id}`}>
                      {d.mine
                        ? d.sharedRoles.length
                          ? t(`Yours · shared with ${d.sharedRoles.map((r) => ROLE_WORDS[r]?.[0] ?? r).join(", ")}`, `تقريرك · مشترك مع ${d.sharedRoles.map((r) => ROLE_WORDS[r]?.[1] ?? r).join("، ")}`)
                          : t("Yours · not shared", "تقريرك · غير مشترك")
                        : t(`Shared by ${d.ownerName}`, `مشترك من ${d.ownerName}`)}
                    </p>
                  </div>
                  {actsOf(d.dataset).includes("schedule") && <Button size="sm" variant="outline" className="h-8" onClick={() => setScheduling(scheduling === d.id ? null : d.id)} data-testid={`saved-schedule-${d.id}`}>{t("Schedule", "جدولة")}</Button>}
                  {d.mine && <Button size="sm" variant="outline" className="h-8" disabled={archive.isPending} onClick={() => void remove(d.id, d.name)} data-testid={`saved-remove-${d.id}`}>{t("Remove", "إزالة")}</Button>}
                  {scheduling === d.id && <div className="basis-full"><ScheduleForm definition={d} canDeliver={actsOf(d.dataset).includes("deliver")} onDone={() => setScheduling(null)} /></div>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="border-border bg-card">
        <CardContent className="pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
            <h2 className="text-sm font-semibold text-foreground">{t("Your schedules", "جدولتك")}</h2>
            <Link href="/reports/deliveries" className="text-sm underline text-foreground" data-testid="saved-deliveries-link">{t("Delivered reports", "التقارير المُسلَّمة")}</Link>
          </div>
          <ScheduleList />
        </CardContent>
      </Card>
    </div>
  );
}
