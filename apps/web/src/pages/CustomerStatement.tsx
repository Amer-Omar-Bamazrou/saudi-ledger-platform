/**
 * The customer statement (Batch 1B Phase E → F, 2026-09-17).
 *
 * Every event that moved the customer's position, in chronology, with THREE
 * running balances kept apart — Accounts Receivable (what they owe), Customer
 * Credits (credit-note balances we owe), Customer Deposits (receipts held on
 * account) — and a Net Position that is DERIVED and labelled as such. A
 * liability is never rendered as "AR = −115": the statement shows which
 * liability it is.
 *
 * The page renders the API's figures and nothing else: the running balances
 * are the server's, and the server says whether the events it replayed agree
 * with the subledger (`reconciled`). Disagreement is shown, never hidden.
 */
import { useState } from "react";
import { useParams, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ArrowLeft, AlertTriangle, CheckCircle2 } from "lucide-react";
import { DualDate } from "@/components/DualDate";

import type { CustomerPosition, CustomerStatement as CustomerStatementView, CustomerStatementLine } from "@workspace/api-client-react";

const KIND_LABEL: Record<CustomerStatementLine["kind"], { en: string; ar: string; cls: string }> = {
  invoice: { en: "Invoice", ar: "فاتورة", cls: "bg-secondary text-foreground" },
  debit_note: { en: "Debit note", ar: "إشعار مدين", cls: "bg-secondary text-foreground" },
  credit_note: { en: "Credit note", ar: "إشعار دائن", cls: "bg-info-surface/20 text-info" },
  receipt: { en: "Receipt", ar: "إيصال", cls: "bg-positive-surface/20 text-positive" },
  allocation: { en: "Allocation", ar: "تخصيص", cls: "bg-positive-surface/20 text-positive" },
  credit_application: { en: "Credit applied", ar: "تطبيق رصيد دائن", cls: "bg-info-surface/20 text-info" },
  unallocation: { en: "Correction (unapplied)", ar: "تصحيح (إلغاء تخصيص)", cls: "bg-attention-surface/20 text-attention" },
  refund: { en: "Refund", ar: "ردّ", cls: "bg-attention-surface/20 text-attention" },
};

const money = (v: number) => fmtNum(v);
const delta = (v: number) => (Math.abs(v) < 0.005 ? "—" : `${v > 0 ? "+" : "−"}${fmtNum(Math.abs(v))}`);

function PositionCard({ title, p, testId, hint }: { title: string; p: CustomerPosition; testId: string; hint?: string }) {
  const { t } = useLanguage();
  const row = (k: string, v: number, id: string) => (
    <div className="flex justify-between gap-2 text-sm"><span className="text-muted-foreground">{k}</span><span className="font-mono" data-testid={`${testId}-${id}`}>{money(v)}</span></div>
  );
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{title}</CardTitle>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardHeader>
      <CardContent className="space-y-1">
        {row(t("Accounts receivable", "الذمم المدينة"), p.receivable, "receivable")}
        {row(t("Customer credits", "أرصدة دائنة"), p.creditBalance, "credits")}
        {row(t("Customer deposits", "عرابين"), p.depositBalance, "deposits")}
        <div className="flex justify-between gap-2 text-sm border-t border-border pt-1 mt-1">
          <span className="text-muted-foreground">{t("Net position (derived)", "صافي المركز (مشتق)")}</span>
          <span className="font-mono font-semibold" data-testid={`${testId}-net`}>{money(p.netPosition)}</span>
        </div>
      </CardContent>
    </Card>
  );
}

export default function CustomerStatement() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const { t } = useLanguage();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const qs = [from && `date_from=${from}`, to && `date_to=${to}`].filter(Boolean).join("&");
  const { data, isLoading, error } = useQuery<CustomerStatementView>({
    queryKey: ["customer-statement", id, from, to],
    queryFn: () => apiFetch(`/customers/${id}/statement${qs ? `?${qs}` : ""}`),
    enabled: Number.isFinite(id),
  });

  if (isLoading) return <p className="text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>;
  if (error || !data) {
    const msg = error instanceof Error ? error.message : "";
    return (
      <div className="space-y-4">
        <Link href="/customers"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4 me-2" />{t("Back to customers", "العودة إلى العملاء")}</Button></Link>
        <p className="text-destructive">{t("The statement could not be loaded.", "تعذر تحميل كشف الحساب.")} {msg}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/customers/${id}`}>
          <Button variant="ghost" size="sm" className="mb-2 -ms-2"><ArrowLeft className="w-4 h-4 me-2" />{t("Back to customer", "العودة إلى العميل")}</Button>
        </Link>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">{t("Customer statement", "كشف حساب العميل")}</h1>
            <p className="text-muted-foreground">{data.customerName}{data.customerNameAr ? ` · ${data.customerNameAr}` : ""}</p>
          </div>
          <div className="flex items-end gap-2 flex-wrap">
            <div>
              <p className="text-xs text-muted-foreground mb-1">{t("From", "من")}</p>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 text-sm" data-testid="statement-from" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">{t("To", "إلى")}</p>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 text-sm" data-testid="statement-to" />
            </div>
            {(from || to) && <Button variant="ghost" size="sm" className="h-9" onClick={() => { setFrom(""); setTo(""); }}>{t("Clear", "مسح")}</Button>}
          </div>
        </div>
      </div>

      {/* The server's own verdict on its figures — shown either way. */}
      <div className={`flex items-start gap-2 rounded-md border p-3 text-sm ${data.reconciled ? "border-border" : "border-destructive/50 bg-destructive/10"}`} data-testid="statement-reconciled" data-reconciled={String(data.reconciled)}>
        {data.reconciled ? <CheckCircle2 className="w-4 h-4 mt-0.5 text-positive shrink-0" /> : <AlertTriangle className="w-4 h-4 mt-0.5 text-destructive shrink-0" />}
        <span>
          {data.reconciled
            ? t(`Rebuilt from ${data.eventCount} events and reconciled to the subledger on all three balances.`, `أُعيد بناؤه من ${data.eventCount} حدثًا وتمت مطابقته مع الدفتر المساعد في الأرصدة الثلاثة.`)
            : t(`The events and the subledger DISAGREE — events say ${money(data.current.receivable)} / ${money(data.current.creditBalance)} / ${money(data.current.depositBalance)}, the subledger says ${money(data.subledger.receivable)} / ${money(data.subledger.creditBalance)} / ${money(data.subledger.depositBalance)}. Do not rely on this statement until it is investigated.`,
                `الأحداث والدفتر المساعد غير متطابقين — الأحداث تقول ${money(data.current.receivable)} / ${money(data.current.creditBalance)} / ${money(data.current.depositBalance)}، والدفتر المساعد يقول ${money(data.subledger.receivable)} / ${money(data.subledger.creditBalance)} / ${money(data.subledger.depositBalance)}. لا تعتمد على هذا الكشف حتى يُحقَّق فيه.`)}
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <PositionCard title={t("Opening", "الرصيد الافتتاحي")} p={data.opening} testId="opening" hint={data.period.from ? t(`before ${data.period.from}`, `قبل ${data.period.from}`) : t("no events before the first", "لا أحداث قبل الأول")} />
        <PositionCard title={t("Closing", "الرصيد الختامي")} p={data.closing} testId="closing" hint={data.period.to ? t(`as at ${data.period.to}`, `حتى ${data.period.to}`) : t("after the last event shown", "بعد آخر حدث معروض")} />
        <PositionCard title={t("Current position", "المركز الحالي")} p={data.current} testId="current" hint={t("after every event, ignoring the window", "بعد كل الأحداث، بغض النظر عن الفترة")} />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{t("Transactions", "الحركات")} ({data.lines.length})</CardTitle>
          <p className="text-xs text-muted-foreground">{t("Each line moves one or more of the three balances; the running figures after each line are the server's.", "كل سطر يحرّك واحدًا أو أكثر من الأرصدة الثلاثة؛ والأرقام الجارية بعد كل سطر من الخادم.")}</p>
        </CardHeader>
        <CardContent>
          {data.lines.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">{t("No events in this period.", "لا توجد أحداث في هذه الفترة.")}</p>
          ) : (
            <>
              {/* Desktop: the full ledger table. */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                      <th className="text-start pb-2 pe-3 font-medium">{t("Date", "التاريخ")}</th>
                      <th className="text-start pb-2 pe-3 font-medium">{t("Event", "الحدث")}</th>
                      <th className="text-start pb-2 pe-3 font-medium">{t("Document", "المستند")}</th>
                      <th className="text-start pb-2 pe-3 font-medium">{t("Description", "الوصف")}</th>
                      <th className="text-end pb-2 pe-3 font-medium">{t("Amount", "المبلغ")}</th>
                      <th className="text-end pb-2 pe-3 font-medium">{t("AR Δ", "Δ الذمم")}</th>
                      <th className="text-end pb-2 pe-3 font-medium">{t("Credits Δ", "Δ الأرصدة الدائنة")}</th>
                      <th className="text-end pb-2 pe-3 font-medium">{t("Deposits Δ", "Δ العرابين")}</th>
                      <th className="text-end pb-2 pe-3 font-medium">{t("AR", "الذمم")}</th>
                      <th className="text-end pb-2 pe-3 font-medium">{t("Credits", "أرصدة دائنة")}</th>
                      <th className="text-end pb-2 pe-3 font-medium">{t("Deposits", "عرابين")}</th>
                      <th className="text-end pb-2 font-medium">{t("Net", "الصافي")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.lines.map((l) => {
                      const k = KIND_LABEL[l.kind];
                      return (
                        <tr key={l.seq} className="border-b border-border/50 hover:bg-secondary/20" data-testid={`statement-line-${l.seq}`} data-kind={l.kind}>
                          <td className="py-2 pe-3 text-muted-foreground whitespace-nowrap"><DualDate date={l.date} inline /></td>
                          <td className="py-2 pe-3"><Badge className={`text-xs ${k.cls}`}>{t(k.en, k.ar)}</Badge></td>
                          <td className="py-2 pe-3 font-mono text-xs whitespace-nowrap">{l.documentNumber}</td>
                          <td className="py-2 pe-3 text-xs text-muted-foreground max-w-[20rem]">{l.description}</td>
                          <td className="py-2 pe-3 font-mono text-end">{money(l.amount)}</td>
                          <td className="py-2 pe-3 font-mono text-end text-xs">{delta(l.receivableDelta)}</td>
                          <td className="py-2 pe-3 font-mono text-end text-xs">{delta(l.creditDelta)}</td>
                          <td className="py-2 pe-3 font-mono text-end text-xs">{delta(l.depositDelta)}</td>
                          <td className="py-2 pe-3 font-mono text-end" data-testid={`line-${l.seq}-receivable`}>{money(l.receivable)}</td>
                          <td className="py-2 pe-3 font-mono text-end" data-testid={`line-${l.seq}-credits`}>{money(l.creditBalance)}</td>
                          <td className="py-2 pe-3 font-mono text-end" data-testid={`line-${l.seq}-deposits`}>{money(l.depositBalance)}</td>
                          <td className="py-2 font-mono text-end font-semibold">{money(l.netPosition)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {/* Phone: one card per event, the same figures. */}
              <div className="md:hidden space-y-2">
                {data.lines.map((l) => {
                  const k = KIND_LABEL[l.kind];
                  return (
                    <div key={l.seq} className="rounded-md border border-border p-3 space-y-1" data-row data-testid={`statement-card-${l.seq}`}>
                      <div className="flex items-center justify-between gap-2">
                        <Badge className={`text-xs ${k.cls}`}>{t(k.en, k.ar)}</Badge>
                        <span className="text-xs text-muted-foreground"><DualDate date={l.date} inline /></span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-xs">{l.documentNumber}</span>
                        <span className="font-mono">{money(l.amount)}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">{l.description}</p>
                      <div className="grid grid-cols-3 gap-2 text-xs pt-1 border-t border-border/50">
                        <div><p className="text-muted-foreground">{t("AR", "الذمم")}</p><p className="font-mono">{money(l.receivable)}</p></div>
                        <div><p className="text-muted-foreground">{t("Credits", "أرصدة دائنة")}</p><p className="font-mono">{money(l.creditBalance)}</p></div>
                        <div><p className="text-muted-foreground">{t("Deposits", "عرابين")}</p><p className="font-mono">{money(l.depositBalance)}</p></div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
