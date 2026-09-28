import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { PageHeader, StatStrip, Stat, Panel, EmptyState } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Activity } from "lucide-react";
import { PeriodShortcuts } from "@/components/PeriodShortcuts";
import { DualDate } from "@/components/DualDate";
import { useLanguage } from "@/contexts/LanguageContext";

/*
 * 🔴 i18n'd in the 2026-09-01 Arabic re-measurement. This page was one of eight
 * with ZERO t() calls — seven of them under /reports, including the five the
 * nav coverage check had just rescued from unreachability. Untranslated
 * because unvisited: nothing that is not visited gets translated, which is the
 * targeted-fix lesson wearing i18n clothes.
 *
 * The dead "Export" button is REMOVED rather than translated — it had no
 * onClick (one of seven such buttons found in the same sweep). Per the
 * VendorDetail precedent: omit the control rather than promise nothing.
 * Export is part of L1's document-artifact design.
 */

import type { ActivityReport as ActivityReportData } from "@workspace/api-client-react";
import { businessToday, businessDateShift } from "@workspace/shared";

const STATUS_STYLES: Record<string, string> = { posted: "bg-positive-surface/20 text-positive", draft: "bg-secondary text-muted-foreground", reversed: "bg-negative-surface/20 text-negative" };

export default function ActivityReport() {
  const { t } = useLanguage();
  const today = businessToday();
  const thirtyDaysAgo = businessDateShift(today, -30);
  const [dateFrom, setDateFrom] = useState(thirtyDaysAgo);
  const [dateTo,   setDateTo]   = useState(today);
  const [applied,  setApplied]  = useState({ from: thirtyDaysAgo, to: today });

  const { data, isLoading } = useQuery<ActivityReportData>({
    queryKey: ["activity-report", applied.from, applied.to],
    queryFn: () => apiFetch(`/reports/activity?date_from=${applied.from}&date_to=${applied.to}`),
  });

  const STATUS_LABELS: Record<string, string> = {
    posted: t("posted", "مرحّل"),
    draft: t("draft", "مسودة"),
    reversed: t("reversed", "معكوس"),
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("Activity Report", "تقرير النشاط")}
        description={t("All journal entry activity — posted, draft, and reversed", "كل نشاط قيود اليومية — المرحّلة والمسودات والمعكوسة")}
      />

      <Panel>
        <div className="flex flex-wrap items-end gap-3">
          <div><Label className="text-xs text-muted-foreground">{t("From", "من")}</Label><Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
          <div><Label className="text-xs text-muted-foreground">{t("To", "إلى")}</Label><Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
          <Button size="sm" className="h-8" onClick={() => setApplied({ from: dateFrom, to: dateTo })}>{t("Generate", "إنشاء")}</Button>
        </div>
        <div className="mt-3">
          <PeriodShortcuts from={dateFrom} to={dateTo} onSelect={(r)=>{setDateFrom(r.from);setDateTo(r.to);setApplied(r);}} />
        </div>
      </Panel>

      {data && (
        <StatStrip cols={3}>
          <Stat label={t("Total Entries", "إجمالي القيود")} value={data.count} />
          <Stat label={t("Posted", "مرحّلة")} value={data.hasPosted} />
          <Stat label={t("Draft", "مسودات")} value={data.hasDraft} />
        </StatStrip>
      )}

      {isLoading ? (
        <div className="text-sm text-muted-foreground p-4">{t("Loading…", "جارٍ التحميل…")}</div>
      ) : !data || data.activities.length === 0 ? (
        <Panel>
          <EmptyState icon={Activity} title={t("No journal activity in this period.", "لا يوجد نشاط قيود في هذه الفترة.")} />
        </Panel>
      ) : (
        <Panel flush>
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                {([
                  [t("Entry #", "رقم القيد"), false],
                  [t("Date", "التاريخ"), false],
                  [t("Description", "الوصف"), false],
                  [t("Reference", "المرجع"), false],
                  [t("Lines", "السطور"), true],
                  [t("Total", "الإجمالي"), true],
                  [t("Accounts", "الحسابات"), false],
                  [t("Status", "الحالة"), false],
                ] as const).map(([h, num]) => (
                  <th key={h} className={`${num ? "text-end" : "text-start"} px-3`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.activities.map(a => (
                <tr key={a.id} className="border-b border-border/70 hover:bg-muted/40 transition-colors">
                  <td className="py-3 px-3 font-medium text-primary whitespace-nowrap">{a.entryNumber}</td>
                  <td className="py-3 px-3 text-muted-foreground whitespace-nowrap"><DualDate date={a.date} /></td>
                  <td className="py-3 px-3 max-w-56 truncate">{a.description}</td>
                  <td className="py-3 px-3 text-muted-foreground">{a.reference ?? "—"}</td>
                  <td className="py-3 px-3 text-end tabular-nums">{a.lineCount}</td>
                  <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">{fmtNum(a.totalDebit)}</td>
                  <td className="py-3 px-3 text-muted-foreground max-w-48 truncate">{a.accounts.join(", ")}</td>
                  <td className="py-3 px-3"><Badge className={`text-xs capitalize ${STATUS_STYLES[a.status] ?? ""}`}>{STATUS_LABELS[a.status] ?? a.status}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </Panel>
      )}
    </div>
  );
}
