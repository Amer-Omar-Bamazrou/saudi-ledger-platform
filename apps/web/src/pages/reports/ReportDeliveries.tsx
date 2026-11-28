/**
 * 🔴 19B S6 (v4 §9, D7) — DELIVERED REPORTS: the copies scheduled reports delivered to this member, in the app.
 *
 * The list is each copy's facts only. Opening one asks the server, which decides again at every open: an expired copy
 * is a message with no data; a copy the role may no longer run, or one that failed its integrity check, is refused in
 * the server's words; a value the role may no longer read is marked withheld where it would be — never shown blank.
 * There is no download and no link: a copy is read here.
 */
import { useState } from "react";
import { useListReportDatasets, useListReportDeliveries, useOpenReportDelivery, type ReportDatasetColumn } from "@workspace/api-client-react";
import { fmtNum } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { GroupTotals } from "@/components/reports/GroupTotals";

const CLASS_WORDS: Record<string, [string, string]> = {
  bank_narrative: ["the bank text permission", "صلاحية نص كشف البنك"],
  contact: ["the contact details permission", "صلاحية بيانات الاتصال"],
  identity: ["the identity permission", "صلاحية بيانات الهوية"],
  compensation: ["the pay permission", "صلاحية الرواتب"],
  bank_account: ["the bank account permission", "صلاحية الحسابات البنكية"],
};
const day = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh" }).format(new Date(iso));

export default function ReportDeliveries() {
  const { t, lang } = useLanguage();
  const { data, isLoading } = useListReportDeliveries();
  const datasets = useListReportDatasets().data?.items ?? [];
  const [openId, setOpenId] = useState<number | null>(null);
  const items = data?.items ?? [];
  const titleOf = (dataset: string) => { const d = datasets.find((x) => x.name === dataset); return d ? (lang === "ar" ? d.titleAr : d.title) : dataset; };

  return (
    <div className="space-y-6" data-testid="report-deliveries-page">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t("Delivered reports", "التقارير المُسلَّمة")}</h1>
        <p className="text-muted-foreground text-sm mt-1">{t("Copies of scheduled reports delivered to you. Each shows only what your role allows, checked every time you open it.", "نسخ التقارير المجدولة المُسلَّمة إليك. كل نسخة تعرض فقط ما يسمح به دورك، ويُفحص ذلك في كل مرة تفتحها.")}</p>
      </div>

      <Card className="border-border bg-card">
        <CardContent className="pt-4">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="deliveries-empty">{t("Nothing has been delivered to you yet.", "لم يُسلَّم إليك شيء بعد.")}</p>
          ) : (
            <ul className="divide-y divide-border" data-testid="deliveries-list">
              {items.map((d) => (
                <li key={d.id} className="py-3 flex flex-wrap items-center gap-3" data-testid={`delivery-item-${d.id}`}>
                  <div className="flex-1 min-w-[12rem]">
                    <p className="text-sm font-medium text-foreground">{d.reportName}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {titleOf(d.dataset)} · <span dir="ltr">{d.window.from ?? "…"} – {d.window.to ?? "…"}</span> · {t(`${d.rowCount} rows`, `${d.rowCount} سطراً`)}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5" data-testid={`delivery-status-${d.id}`}>
                      {t("Delivered", "سُلِّم")} <span dir="ltr">{day(d.createdAt)}</span> ·{" "}
                      {d.status === "expired" ? t("expired", "منتهي الصلاحية") : <>{t("kept until", "يُحفظ حتى")} <span dir="ltr">{day(d.expiresAt)}</span></>}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" className="h-8" onClick={() => setOpenId(openId === d.id ? null : d.id)} data-testid={`delivery-open-${d.id}`}>{openId === d.id ? t("Close", "إغلاق") : t("Open", "فتح")}</Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {openId != null && <Opened key={openId} id={openId} />}
    </div>
  );
}

function Opened({ id }: { id: number }) {
  const { t, lang } = useLanguage();
  // never served from an earlier open: what the reader may see is decided at each one
  const { data, isLoading, error } = useOpenReportDelivery(id, { query: { queryKey: ["report-delivery", id], staleTime: 0, gcTime: 0 } });
  const refusal = (error as { data?: { error?: string; errorAr?: string } } | null)?.data;
  const needs = (c: ReportDatasetColumn) => {
    const [en, ar] = CLASS_WORDS[c.class] ?? [c.class, c.class];
    return t(`Withheld — needs ${en}`, `محجوب — يحتاج ${ar}`);
  };
  // every column of the copy's dataset, so a grouping by a column the report does not SHOW is still named in the
  // reader's language (never by its key)
  const names = useListReportDatasets().data?.items.find((d) => d.name === data?.dataset)?.columns;
  const rows = (data ? Object.values(data.rows)[0] ?? [] : []) as Record<string, unknown>[];
  const cell = (c: ReportDatasetColumn, row: Record<string, unknown>) => {
    if (!(c.key in row)) return <span className="text-[11px] text-muted-foreground italic" data-testid="delivery-cell-withheld">{t("withheld", "محجوب")}</span>;
    const v = row[c.key];
    if (v == null || v === "") return "—";
    if (typeof v === "boolean") return v ? t("yes", "نعم") : t("no", "لا");
    if (c.kind === "money") return fmtNum(Number(v));
    return String(v);
  };

  return (
    <Card className="border-border bg-card">
      <CardContent className="pt-4 overflow-x-auto" data-testid="delivery-opened">
        {isLoading && <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>}
        {error != null && <p className="text-sm text-attention" data-testid="delivery-refusal">{refusal ? (lang === "ar" ? refusal.errorAr ?? refusal.error : refusal.error) : t("This copy was not found.", "لم يُعثر على هذه النسخة.")}</p>}
        {data?.status === "expired" && <p className="text-sm text-muted-foreground" data-testid="delivery-expired">{lang === "ar" ? data.messageAr ?? data.message : data.message}</p>}
        {data?.status === "available" && (
          <>
            <h2 className="text-sm font-semibold text-foreground pb-2">{data.reportName}</h2>
            {data.withheld.length > 0 && <p className="text-xs text-muted-foreground pb-2" data-testid="delivery-withheld-note">{t("Some values are withheld for your role; each is marked where it would be.", "بعض القيم محجوبة لدورك، وكل منها مُعلَّم في مكانه.")}</p>}
            {data.groupedBy && data.groups && <GroupTotals groupedBy={data.groupedBy} groups={data.groups} grandTotal={data.grandTotal} columns={data.columns} withheld={data.withheld} names={names} testId="delivery-groups" />}
            <table className="w-full text-sm" data-testid="delivery-table">
              <thead>
                <tr className="text-muted-foreground border-b border-border">
                  {data.columns.map((c) => (
                    <th key={c.key} className="text-start py-2 pe-3 font-medium align-bottom" data-testid={`delivery-col-${c.key}`} data-level={c.level}>
                      {lang === "ar" ? c.labelAr : c.label}
                      {c.level !== "read" && <span className="block text-[10px] font-normal text-attention">{needs(c)}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-b border-border/50" data-testid="delivery-row">
                    {data.columns.map((c) => <td key={c.key} className={`py-2 pe-3 ${c.kind === "money" ? "font-mono" : ""}`}>{cell(c, r)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="pt-3 text-xs text-muted-foreground" data-testid="delivery-count">{t(`${data.total} rows`, `${data.total} سطراً`)}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
