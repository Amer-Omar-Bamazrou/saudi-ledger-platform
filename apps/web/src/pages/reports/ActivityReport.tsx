import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

const STATUS_STYLES: Record<string, string> = { posted: "bg-positive-surface/20 text-positive", draft: "bg-secondary text-muted-foreground", reversed: "bg-negative-surface/20 text-negative" };

export default function ActivityReport() {
  const { t } = useLanguage();
  const today = new Date().toISOString().split("T")[0];
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Activity Report", "تقرير النشاط")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("All journal entry activity — posted, draft, and reversed", "كل نشاط قيود اليومية — المرحّلة والمسودات والمعكوسة")}</p>
        </div>
      </div>

      <Card className="border-border bg-card">
        <CardContent className="pt-4">
          <div className="flex items-end gap-4">
            <div><Label className="text-xs text-muted-foreground">{t("From", "من")}</Label><Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <div><Label className="text-xs text-muted-foreground">{t("To", "إلى")}</Label><Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <Button size="sm" className="h-8" onClick={() => setApplied({ from: dateFrom, to: dateTo })}>{t("Generate", "إنشاء")}</Button>
          </div>
          <div className="mt-3">
            <PeriodShortcuts from={dateFrom} to={dateTo} onSelect={(r)=>{setDateFrom(r.from);setDateTo(r.to);setApplied(r);}} />
          </div>
        </CardContent>
      </Card>

      {data && (
        <div className="grid grid-cols-3 gap-4">
          {[
            [t("Total Entries", "إجمالي القيود"), data.count, "text-primary"],
            [t("Posted", "مرحّلة"), data.hasPosted, "text-positive"],
            [t("Draft", "مسودات"), data.hasDraft, "text-muted-foreground"],
          ].map(([l, v, c]) => (
            <Card key={String(l)} className="border-border bg-card">
              <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader>
              <CardContent><div className={`text-2xl font-bold font-mono ${c}`}>{v}</div></CardContent>
            </Card>
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="text-sm text-muted-foreground p-4">{t("Loading…", "جارٍ التحميل…")}</div>
      ) : !data || data.activities.length === 0 ? (
        <Card className="border-border bg-card">
          <CardContent className="pt-6">
            <div className="text-center py-16 text-muted-foreground">
              <Activity className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">{t("No journal activity in this period.", "لا يوجد نشاط قيود في هذه الفترة.")}</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-border bg-card">
          <CardContent className="pt-6">
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {[t("Entry #", "رقم القيد"), t("Date", "التاريخ"), t("Description", "الوصف"), t("Reference", "المرجع"), t("Lines", "السطور"), t("Total", "الإجمالي"), t("Accounts", "الحسابات"), t("Status", "الحالة")].map(h => (
                    <th key={h} className="text-start pb-2.5 pe-4 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.activities.map(a => (
                  <tr key={a.id} className="border-b border-border/30 hover:bg-secondary/10">
                    <td className="py-2.5 pe-4 font-mono text-xs text-primary">{a.entryNumber}</td>
                    <td className="py-2.5 pe-4 text-xs text-muted-foreground whitespace-nowrap"><DualDate date={a.date} /></td>
                    <td className="py-2.5 pe-4 text-xs max-w-48 truncate">{a.description}</td>
                    <td className="py-2.5 pe-4 text-xs text-muted-foreground">{a.reference ?? "—"}</td>
                    <td className="py-2.5 pe-4 text-xs font-mono">{a.lineCount}</td>
                    <td className="py-2.5 pe-4 font-mono text-xs">{fmtNum(a.totalDebit)}</td>
                    <td className="py-2.5 pe-4 text-xs text-muted-foreground max-w-40 truncate">{a.accounts.join(", ")}</td>
                    <td className="py-2.5"><Badge className={`text-xs ${STATUS_STYLES[a.status] ?? ""}`}>{STATUS_LABELS[a.status] ?? a.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
