import { useEffect, useMemo, useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "wouter";
import { apiFetch, fmtNum, fmtDate } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BookOpen, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useReportDefaultRange, type ReportDefaultRange } from "@/hooks/useReportDefaultRange";
import { FiscalRangeNotice, ReportRangeLoading } from "@/components/FiscalRangeNotice";
import { PeriodShortcuts } from "@/components/PeriodShortcuts";
import { DualDate } from "@/components/DualDate";
import { ReportExportButtons } from "@/components/reports/ReportExport";
import { journalEntryHref } from "@/lib/reportDrill";

import { useListCustomers, useListVendors, type Category, type GeneralLedgerReport } from "@workspace/api-client-react";

type PartyType = "none" | "customer" | "vendor";
type Applied = { accountId: string; from: string; to: string; partyType: PartyType; partyId: string };

/**
 * Phase 14 — the general ledger, now a drill-down TARGET (D14-09) and
 * filterable by party (D14-11).
 *
 * 🔴 It READS its scope from the URL: `account_id`, `date_from`, `date_to`,
 * `party_type` + `customer_id` / `vendor_id`. A statement row links here with
 * those, and the page answers THAT question — never a broader default one
 * (CLAUDE.md §3: "a navigation can lose the scope the user chose, and every
 * static check stays green"). `useSearch` keeps it reactive: a drill from one
 * ledger view to another on this same route re-reads the scope.
 */
export default function GeneralLedger() {
  // M20.1 — the report does not mount until its default window is known.
  const range = useReportDefaultRange();
  if (!range.ready) return <ReportRangeLoading />;
  return <GeneralLedgerInner range={range} />;
}

function scopeFromSearch(search: string, range: ReportDefaultRange): { applied: Applied | null; draft: Applied } {
  const p = new URLSearchParams(search);
  const accountId = p.get("account_id");
  const partyType = (p.get("party_type") === "customer" || p.get("party_type") === "vendor" ? p.get("party_type") : "none") as PartyType;
  const partyId = partyType === "customer" ? (p.get("customer_id") ?? "") : partyType === "vendor" ? (p.get("vendor_id") ?? "") : "";
  const draft: Applied = { accountId: accountId ?? "all", from: p.get("date_from") ?? range.from, to: p.get("date_to") ?? range.to, partyType, partyId };
  // A link that names an account or a party IS the request — answer it at once.
  const applied = accountId || (partyType !== "none" && partyId) ? draft : null;
  return { applied, draft };
}

function GeneralLedgerInner({ range }: { range: ReportDefaultRange }) {
  const { n, t } = useLanguage();
  const search = useSearch();
  const initial = useMemo(() => scopeFromSearch(search, range), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [draft, setDraft] = useState<Applied>(initial.draft);
  const [applied, setApplied] = useState<Applied | null>(initial.applied);
  const [partySearch, setPartySearch] = useState("");

  // the URL changed under us (a drill from this same page): adopt its scope
  useEffect(() => {
    const next = scopeFromSearch(search, range);
    setDraft(next.draft);
    if (next.applied) setApplied(next.applied);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: cats = [] } = useQuery<Category[]>({
    queryKey: ["categories"],
    queryFn: () => apiFetch("/categories"),
  });
  const customers = useListCustomers({ search: partySearch || undefined, limit: 50 }, { query: { enabled: draft.partyType === "customer" } as never });
  const vendors = useListVendors({ search: partySearch || undefined, limit: 50 }, { query: { enabled: draft.partyType === "vendor" } as never });
  const partyList = draft.partyType === "customer" ? customers.data : draft.partyType === "vendor" ? vendors.data : undefined;

  const queryParams = (a: Applied) => {
    const params: Record<string, string> = { date_from: a.from, date_to: a.to };
    if (a.accountId !== "all") params.account_id = a.accountId;
    if (a.partyType !== "none" && a.partyId) {
      params.party_type = a.partyType;
      params[a.partyType === "customer" ? "customer_id" : "vendor_id"] = a.partyId;
    }
    return params;
  };

  const { data, isLoading, isError, error } = useQuery<GeneralLedgerReport>({
    queryKey: ["general-ledger", applied],
    queryFn: () => apiFetch(`/reports/general-ledger?${new URLSearchParams(queryParams(applied!))}`),
    enabled: !!applied,
  });

  const partyLabel = data?.party
    ? data.party.type === "customer" ? t("Customer", "العميل") : t("Supplier", "المورد")
    : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("General Ledger", "دفتر الأستاذ العام")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("All journal entry lines in date order with running balance", "جميع سطور قيود اليومية بترتيب التاريخ مع الرصيد الجاري")}</p>
        </div>
        {applied && <ReportExportButtons report="general-ledger" params={queryParams(applied)} />}
      </div>

      <FiscalRangeNotice source={range.source} />

      <Card className="border-border bg-card">
        <CardContent className="pt-4">
          <div className="flex items-end gap-4 flex-wrap">
            <div className="min-w-56">
              <Label className="text-xs text-muted-foreground">{t("Account", "الحساب")}</Label>
              <Select value={draft.accountId} onValueChange={(v) => setDraft({ ...draft, accountId: v })}>
                <SelectTrigger className="mt-1 h-8 text-sm" data-testid="gl-account"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("All Accounts", "جميع الحسابات")}</SelectItem>
                  {cats.map(c => <SelectItem key={c.id} value={String(c.id)}>{n(c.name, c.nameAr ?? "")}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div><Label className="text-xs text-muted-foreground">{t("From", "من")}</Label><Input type="date" value={draft.from} onChange={e => setDraft({ ...draft, from: e.target.value })} className="mt-1 h-8 text-sm w-40" data-testid="gl-from" /></div>
            <div><Label className="text-xs text-muted-foreground">{t("To", "إلى")}</Label><Input type="date" value={draft.to} onChange={e => setDraft({ ...draft, to: e.target.value })} className="mt-1 h-8 text-sm w-40" data-testid="gl-to" /></div>
            {/* D14-11 — the party dimension: lines that NAME one customer or supplier */}
            <div className="min-w-40">
              <Label className="text-xs text-muted-foreground">{t("Party", "الطرف")}</Label>
              <Select value={draft.partyType} onValueChange={(v) => { setDraft({ ...draft, partyType: v as PartyType, partyId: "" }); setPartySearch(""); }}>
                <SelectTrigger className="mt-1 h-8 text-sm" data-testid="gl-party-type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("Any party", "أي طرف")}</SelectItem>
                  <SelectItem value="customer">{t("A customer", "عميل")}</SelectItem>
                  <SelectItem value="vendor">{t("A supplier", "مورد")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {draft.partyType !== "none" && (
              <div className="min-w-56">
                <Label className="text-xs text-muted-foreground">{t("Search", "بحث")}</Label>
                <Input value={partySearch} onChange={(e) => setPartySearch(e.target.value)} className="mt-1 h-8 text-sm" placeholder={t("Name…", "الاسم…")} data-testid="gl-party-search" />
                <Select value={draft.partyId} onValueChange={(v) => setDraft({ ...draft, partyId: v })}>
                  <SelectTrigger className="mt-1 h-8 text-sm" data-testid="gl-party"><SelectValue placeholder={t("Choose…", "اختر…")} /></SelectTrigger>
                  <SelectContent>
                    {(partyList?.items ?? []).map((p) => <SelectItem key={p.id} value={String(p.id)}>{n(p.name, (p as { nameAr?: string | null }).nameAr ?? "")}</SelectItem>)}
                  </SelectContent>
                </Select>
                {partyList && (
                  <p className="text-[11px] text-muted-foreground mt-1" data-testid="gl-party-count">
                    {t(`Showing ${partyList.items.length} of ${partyList.page.total} — narrow the search to find others`, `يُعرض ${partyList.items.length} من ${partyList.page.total} — ضيّق البحث للعثور على غيرهم`)}
                  </p>
                )}
              </div>
            )}
            <Button size="sm" className="h-8" onClick={() => setApplied({ ...draft })} data-testid="gl-generate">{t("Generate", "إنشاء")}</Button>
          </div>
          <div className="mt-3">
            <PeriodShortcuts from={draft.from} to={draft.to} onSelect={(r) => { const next = { ...draft, from: r.from, to: r.to }; setDraft(next); setApplied(next); }} />
          </div>
        </CardContent>
      </Card>

      {data && (
        <>
          {data.party && (
            <div className="flex items-center gap-2 text-xs" data-testid="gl-party-scope">
              <span className="rounded-md border border-border px-2 py-1">{partyLabel} #{data.party.id}</span>
              <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => { const next: Applied = { ...draft, partyType: "none", partyId: "" }; setDraft(next); setApplied(next); }}>
                <X className="w-3 h-3 me-1" />{t("Clear party", "إلغاء الطرف")}
              </Button>
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[
              [t("Account", "الحساب"), n(data.accountName, data.accountNameAr), "text-primary", "gl-kpi-account"],
              [t("Opening Balance", "الرصيد الافتتاحي"), fmtNum(data.openingBalance), "text-primary", "gl-kpi-opening"],
              [t("Total Debits", "إجمالي المدين"), fmtNum(data.totalDebit), "text-info", "gl-kpi-debit"],
              [t("Total Credits", "إجمالي الدائن"), fmtNum(data.totalCredit), "text-positive", "gl-kpi-credit"],
            ].map(([l, v, c, id]) => (
              <Card key={String(l)} className="border-border bg-card">
                <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader>
                <CardContent><div className={cn("text-lg font-bold font-mono truncate", c)} data-testid={id}>{v}</div></CardContent>
              </Card>
            ))}
          </div>
          {/* D14-09: the ledger opens on the trial-balance row it came from — say so when that is the fiscal-year start */}
          {data.plResetFrom && (
            <p className="text-xs text-muted-foreground" data-testid="gl-pl-reset">
              {t(
                `An income or expense account opens at the start of its fiscal year (${fmtDate(data.plResetFrom)}); earlier years are the trial balance's "prior fiscal years" row.`,
                `يبدأ حساب الإيرادات أو المصروفات من بداية سنته المالية (${fmtDate(data.plResetFrom)})؛ والسنوات السابقة هي سطر «أرباح / خسائر سنوات مالية سابقة» في ميزان المراجعة.`,
              )}
            </p>
          )}
        </>
      )}

      {isLoading ? (
        <div className="text-sm text-muted-foreground p-4">{t("Loading…", "جارٍ التحميل…")}</div>
      ) : isError ? (
        <Card className="border-border bg-card"><CardContent className="pt-6">
          <p className="text-sm text-negative text-center py-10" data-testid="gl-error">{t("The ledger could not be produced:", "تعذّر إنشاء الدفتر:")} {(error as Error)?.message}</p>
        </CardContent></Card>
      ) : !applied ? (
        <Card className="border-border bg-card">
          <CardContent className="pt-6">
            <div className="text-center py-16 text-muted-foreground">
              <BookOpen className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">{t("Select an account and date range, then click Generate.", "اختر حساباً ونطاق تاريخ، ثم انقر على إنشاء.")}</p>
            </div>
          </CardContent>
        </Card>
      ) : !data || data.movements.length === 0 ? (
        <Card className="border-border bg-card">
          <CardContent className="pt-6">
            <div className="text-center py-16 text-muted-foreground" data-testid="gl-empty">
              <BookOpen className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">{t("No posted movements for this account in the selected period.", "لا توجد حركات مرحّلة لهذا الحساب في الفترة المختارة.")}</p>
              {data && <p className="text-xs mt-2">{t("Opening and closing balance", "الرصيد الافتتاحي والختامي")}: <span className="font-mono" dir="ltr">{fmtNum(data.closingBalance)}</span></p>}
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-border bg-card">
          <CardContent className="pt-6">
            <div className="overflow-x-auto"><table className="w-full text-sm" data-testid="gl-table">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {[t("Date", "التاريخ"), t("Entry #", "رقم القيد"), t("Reference", "المرجع"), t("Description", "الوصف"), t("Debit", "مدين"), t("Credit", "دائن"), t("Running Balance", "الرصيد الجاري")].map(h => (
                    <th key={h} className="text-start pb-2.5 pe-4 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-border/50 bg-secondary/20">
                  <td colSpan={6} className="py-2 px-2 text-xs font-semibold text-muted-foreground">{t("Opening Balance", "الرصيد الافتتاحي")}</td>
                  <td className="py-2 font-mono text-xs font-bold">{fmtNum(data.openingBalance)}</td>
                </tr>
                {data.movements.map((m, i) => (
                  <tr key={i} className="border-b border-border/30 hover:bg-secondary/10" data-testid={`gl-line-${m.jeId}`}>
                    <td className="py-2 pe-4 text-xs text-muted-foreground whitespace-nowrap"><DualDate date={m.date} /></td>
                    {/* D14-09: a ledger line opens its journal entry */}
                    <td className="py-2 pe-4 font-mono text-xs"><Link href={journalEntryHref(m.jeId)} className="text-primary hover:underline" data-testid={`gl-entry-${m.jeId}`}>{m.entryNumber}</Link></td>
                    <td className="py-2 pe-4 text-xs text-muted-foreground">{m.reference ?? "—"}</td>
                    <td className="py-2 pe-4 text-xs">{m.description}</td>
                    <td className="py-2 pe-4 font-mono text-xs text-info">{m.debit > 0 ? fmtNum(m.debit) : "—"}</td>
                    <td className="py-2 pe-4 font-mono text-xs text-positive">{m.credit > 0 ? fmtNum(m.credit) : "—"}</td>
                    <td className={cn("py-2 font-mono text-xs font-semibold", m.balance < 0 ? "text-negative" : "")}>{fmtNum(m.balance)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border font-bold">
                  <td colSpan={4} className="pt-3 text-xs font-semibold text-muted-foreground">{t("Closing Balance", "الرصيد الختامي")}</td>
                  <td className="pt-3 font-mono text-xs text-info">{fmtNum(data.totalDebit)}</td>
                  <td className="pt-3 font-mono text-xs text-positive">{fmtNum(data.totalCredit)}</td>
                  <td className={cn("pt-3 font-mono text-sm font-bold", data.closingBalance < 0 ? "text-negative" : "")} data-testid="gl-closing">{fmtNum(data.closingBalance)}</td>
                </tr>
              </tfoot>
            </table></div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
