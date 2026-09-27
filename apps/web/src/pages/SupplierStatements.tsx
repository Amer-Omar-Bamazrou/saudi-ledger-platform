/**
 * SUPPLIER STATEMENTS AND RECONCILIATION (Phase 11 Part 2 — B5, 2026-09-22).
 * Record: docs/product/phase-11-deep-accounting-ap-decision-pack.md §14.
 *
 * 🔴 The page's job is to let someone find THE LINE where our figure and the
 * supplier's diverge. That is what a supplier reconciliation is, so every
 * event carries a running balance and the events are in business-date order —
 * the books as dated, not as typed.
 *
 * 🔴 The reconciliation between the position and the event stream is SHOWN,
 * agreeing or not. Two computations of one fact with no forcing function
 * between them drift; a statement that quietly disagrees with the ledger is a
 * reconciliation tool hiding the thing it exists to find.
 */
import { useState } from "react";
import { useRoute, Link } from "wouter";
import { fmtNum } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Building2, ArrowLeft } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import {
  useListSupplierPositions, useGetSupplierStatement, useListVendors,
  getGetSupplierStatementQueryKey, type SupplierStatementBalance,
} from "@workspace/api-client-react";

const Money = ({ v }: { v: number }) => <span className="font-mono" dir="ltr">{fmtNum(v)}</span>;

const KIND_LABELS: Record<string, { en: string; ar: string }> = {
  bill: { en: "Bill", ar: "فاتورة" },
  debit_note: { en: "Debit note", ar: "إشعار مدين" },
  credit_note: { en: "Credit note", ar: "إشعار دائن" },
  payment: { en: "Payment", ar: "دفعة" },
  bill_payment: { en: "Paid on the bill", ar: "سداد على الفاتورة" },
  allocation: { en: "Applied", ar: "تخصيص" },
  credit_application: { en: "Note applied", ar: "تطبيق إشعار" },
  unallocation: { en: "Application undone", ar: "تراجع تخصيص" },
  refund: { en: "Refund", ar: "استرداد" },
  reclassification: { en: "Reclassified", ar: "إعادة تصنيف" },
};

export default function SupplierStatements() {
  const [isDetail, params] = useRoute("/supplier-statements/:vendorId");
  return isDetail && params?.vendorId ? <OneStatement vendorId={Number(params.vendorId)} /> : <PositionList />;
}

function PositionList() {
  const { t } = useLanguage();
  const { lang } = useLanguage();
  const { data, isLoading, isError } = useListSupplierPositions();
  const { data: vendorsPage } = useListVendors({ limit: 200 });
  const nameOf = (id: number) => {
    const v = vendorsPage?.items.find((x) => x.id === id);
    return v ? (lang === "ar" && v.nameAr ? v.nameAr : v.name) : `#${id}`;
  };

  return (
    <div className="p-4 sm:p-6 space-y-5" data-testid="page-supplier-statements">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2"><Building2 className="w-6 h-6" />{t("Supplier statements", "كشوف حساب الموردين")}</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
          {t("What we owe each supplier, and what each supplier holds. Advances, deposits and unapplied credit notes are ASSETS — never negative payables — so the net is shown as its own derived figure.",
             "ما ندين به لكل مورد، وما يحتفظ به كل مورد. الدفعات المقدمة والتأمينات وإشعارات الدائن غير المطبقة أصول — لا ذمم دائنة سالبة — ولذلك يُعرض الصافي كرقم مشتق مستقل.")}
        </p>
      </div>

      <Card>
        <CardContent className="pt-6 overflow-x-auto">
          {isLoading ? <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>
           : isError ? <p className="text-sm text-negative">{t("Could not load supplier positions.", "تعذّر تحميل مراكز الموردين.")}</p>
           : (data?.items ?? []).length === 0 ? <p className="text-sm text-muted-foreground" data-testid="no-supplier-positions">{t("No supplier activity yet.", "لا يوجد نشاط للموردين بعد.")}</p>
           : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-muted-foreground text-xs uppercase">
                {[t("Supplier", "المورد"), t("Payable", "المستحق عليها"), t("Credit notes", "إشعارات دائن"), t("Advances", "دفعات مقدمة"), t("Deposits", "تأمينات"), t("Unidentified", "غير محددة"), t("Net", "الصافي"), ""].map((h, i) => (
                  <th key={i} className="text-start pb-2 pe-3 font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {(data?.items ?? []).map((p) => (
                  <tr key={p.vendorId} className="border-b border-border/50" data-testid={`supplier-position-${p.vendorId}`}>
                    <td className="py-2 pe-3 font-medium">{nameOf(p.vendorId)}</td>
                    <td className="py-2 pe-3" data-testid={`position-payable-${p.vendorId}`}><Money v={p.payable} /></td>
                    <td className="py-2 pe-3 text-info"><Money v={p.creditBalance} /></td>
                    <td className="py-2 pe-3 text-info"><Money v={p.advanceBalance} /></td>
                    <td className="py-2 pe-3 text-info"><Money v={p.depositBalance} /></td>
                    <td className="py-2 pe-3 text-info"><Money v={p.unidentifiedBalance} /></td>
                    <td className="py-2 pe-3 font-semibold" data-testid={`position-net-${p.vendorId}`}><Money v={p.netPosition} /></td>
                    <td className="py-2">
                      <Link href={`/supplier-statements/${p.vendorId}`}>
                        <Button size="sm" variant="ghost" data-testid={`open-statement-${p.vendorId}`}>{t("Statement", "الكشف")}</Button>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * One balance — brought forward or carried — as the statement prints it.
 * The net is the SERVER's (payable − credit − on account); nothing is added
 * up here.
 */
function BalanceRow({ label, b, testId }: { label: string; b: SupplierStatementBalance; testId: string }) {
  return (
    <tr className="border-b border-border bg-secondary/30 font-medium" data-testid={testId}>
      <td className="py-2 pe-3" colSpan={4}>{label}</td>
      <td className="py-2 pe-3"><Money v={b.payable} /></td>
      <td className="py-2 pe-3 text-info"><Money v={b.onAccount} /></td>
      <td className="py-2 pe-3 font-semibold" data-testid={`${testId}-net`}><Money v={b.net} /></td>
    </tr>
  );
}

function OneStatement({ vendorId }: { vendorId: number }) {
  const { t, lang } = useLanguage();
  /**
   * The WINDOW (business dates, both ends inclusive). Empty means "from the
   * beginning" / "to date". The server cuts the list and reports what is
   * brought forward and carried; the balances are computed over the whole
   * stream first, so a window's opening is exactly the previous window's
   * closing — the page never adds anything up.
   */
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const params = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const { data, isLoading, isError, error } = useGetSupplierStatement(vendorId, params, {
    query: { queryKey: getGetSupplierStatementQueryKey(vendorId, params) },
  });

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</div>;
  if (isError || !data) {
    return (
      <div className="p-6 space-y-3">
        <p className="text-sm text-negative" data-testid="statement-error">{t("Could not load this statement.", "تعذّر تحميل هذا الكشف.")} {(error as Error | null)?.message ?? ""}</p>
        <Button size="sm" variant="outline" onClick={() => { setFrom(""); setTo(""); }}>{t("Clear the dates", "مسح التواريخ")}</Button>
      </div>
    );
  }

  const p = data.position;
  const r = data.reconciliation;
  const g = data.gl;

  return (
    <div className="p-4 sm:p-6 space-y-5" data-testid="page-supplier-statement">
      <div className="flex items-center gap-3">
        <Link href="/supplier-statements"><Button size="sm" variant="ghost" className="gap-1" data-testid="back-to-positions"><ArrowLeft className="w-4 h-4" />{t("All suppliers", "كل الموردين")}</Button></Link>
      </div>
      <div>
        <h1 className="text-2xl font-semibold" data-testid="statement-vendor">{lang === "ar" && data.vendor.nameAr ? data.vendor.nameAr : data.vendor.name}</h1>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="stmt-from" className="text-xs">{t("From", "من")}</Label>
          <Input id="stmt-from" type="date" dir="ltr" className="w-44" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="stmt-from" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="stmt-to" className="text-xs">{t("To", "إلى")}</Label>
          <Input id="stmt-to" type="date" dir="ltr" className="w-44" value={to} onChange={(e) => setTo(e.target.value)} data-testid="stmt-to" />
        </div>
        {(from || to) && <Button size="sm" variant="ghost" onClick={() => { setFrom(""); setTo(""); }} data-testid="stmt-clear-window">{t("Whole history", "كامل السجل")}</Button>}
        <p className="text-xs text-muted-foreground max-w-md">
          {t("The position below is as of today. The dates choose which events are listed, with the balance brought forward and carried.",
             "المركز أدناه كما هو اليوم. والتواريخ تحدد الأحداث المعروضة، مع الرصيد المنقول من قبل والمرحَّل إلى بعد.")}
        </p>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-6 gap-3 text-sm">
        {([
          [t("Payable", "المستحق عليها"), p.payable, "stmt-payable"],
          [t("− Credit notes", "− إشعارات دائن"), p.creditBalance, "stmt-credits"],
          [t("− Advances", "− دفعات مقدمة"), p.advanceBalance, "stmt-advances"],
          [t("− Deposits", "− تأمينات"), p.depositBalance, "stmt-deposits"],
          [t("− Unidentified", "− غير محددة"), p.unidentifiedBalance, "stmt-unidentified"],
          [t("= Net (derived)", "= الصافي (مشتق)"), p.netPosition, "stmt-net"],
        ] as [string, number, string][]).map(([label, value, id]) => (
          <div key={id} className="rounded-md border border-border p-3">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="font-mono font-semibold text-lg" data-testid={id}>{fmtNum(value)}</p>
          </div>
        ))}
      </div>

      {/*
        🔴 The check is shown whether it passes or fails. A green tick that is
        never wrong is a tick nobody reads; the figures are printed beside it so
        a disagreement names both numbers and their difference.
      */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Does the event stream agree with the position?", "هل يتفق سجل الأحداث مع المركز؟")}</CardTitle></CardHeader>
        <CardContent className="text-sm">
          <div className="flex flex-wrap items-center gap-4">
            <Badge variant="outline" data-testid="stmt-agrees">
              {r.agrees ? t("They agree", "متفقان") : t("They disagree", "غير متفقين")}
            </Badge>
            <span className="text-xs text-muted-foreground">{t("From the position", "من المركز")}: <Money v={r.fromPosition} /></span>
            <span className="text-xs text-muted-foreground">{t("From the events", "من الأحداث")}: <Money v={r.fromEvents} /></span>
            <span className="text-xs text-muted-foreground">{t("Difference", "الفرق")}: <span data-testid="stmt-difference"><Money v={r.difference} /></span></span>
          </div>
        </CardContent>
      </Card>

      {/*
        🔴 The subledger ↔ GL tie, per account, shown agreeing or not. Pre-N3
        control lines carried no party and cannot be attributed to a supplier,
        so a difference is REPORTED with both figures rather than assumed away.
      */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Does the subledger agree with the general ledger?", "هل يتفق دفتر الموردين مع دفتر الأستاذ العام؟")}</CardTitle></CardHeader>
        <CardContent className="text-sm space-y-2">
          <Badge variant="outline" data-testid="stmt-gl-agrees">{g.agrees ? t("They agree", "متفقان") : t("They disagree", "غير متفقين")}</Badge>
          <div className="overflow-x-auto">
            <table className="text-xs">
              <thead><tr className="text-muted-foreground">
                {[t("Account", "الحساب"), t("Subledger", "دفتر الموردين"), t("General ledger", "الأستاذ العام")].map((h) => <th key={h} className="text-start pe-6 pb-1 font-medium">{h}</th>)}
              </tr></thead>
              <tbody>
                {([
                  [t("Accounts payable (payable − credit notes)", "الذمم الدائنة (المستحق − إشعارات الدائن)"), g.components.ap, "ap"],
                  [t("Supplier advances", "دفعات مقدمة للموردين"), g.components.advances, "advances"],
                  [t("Security deposits paid", "تأمينات مدفوعة"), g.components.deposits, "deposits"],
                  [t("Unidentified payments", "مدفوعات غير محددة"), g.components.unidentified, "unidentified"],
                ] as const).map(([label, c, id]) => (
                  <tr key={id} data-testid={`stmt-gl-${id}`}>
                    <td className="pe-6 py-0.5">{label}</td>
                    <td className="pe-6 py-0.5"><Money v={c.fromSubledger} /></td>
                    <td className="pe-6 py-0.5"><Money v={c.fromGl} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Every event, in date order", "كل حدث، بترتيب التاريخ")}</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          {data.lines.length === 0 && !from && !to ? (
            <p className="text-sm text-muted-foreground" data-testid="no-statement-lines">{t("Nothing has happened with this supplier yet.", "لم يحدث شيء مع هذا المورد بعد.")}</p>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-muted-foreground text-xs uppercase">
                {[t("Date", "التاريخ"), t("What", "الحدث"), t("Document", "المستند"), t("Description", "الوصف"), t("Payable", "المستحق"), t("On account", "على الحساب"), t("Running net", "الرصيد الجاري")].map((h, i) => (
                  <th key={i} className="text-start pb-2 pe-3 font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr></thead>
              <tbody>
                <BalanceRow label={t("Brought forward", "رصيد منقول")} b={data.opening} testId="stmt-opening" />
                {data.lines.length === 0 && (
                  <tr><td colSpan={7} className="py-3 text-xs text-muted-foreground" data-testid="no-lines-in-window">{t("No events in these dates.", "لا أحداث في هذه التواريخ.")}</td></tr>
                )}
                {data.lines.map((l, i) => (
                  <tr key={`${l.kind}-${l.id}-${i}`} className="border-b border-border/50" data-testid={`statement-line-${i}`}>
                    <td className="py-2 pe-3 font-mono text-xs" dir="ltr">{l.date}</td>
                    <td className="py-2 pe-3">
                      <Badge variant="outline" className="text-[10px]">{t(KIND_LABELS[l.kind]?.en ?? l.kind, KIND_LABELS[l.kind]?.ar ?? l.kind)}</Badge>
                    </td>
                    <td className="py-2 pe-3 font-mono text-xs" dir="ltr">{l.documentNumber}</td>
                    <td className="py-2 pe-3 text-xs text-muted-foreground">{l.description}</td>
                    <td className="py-2 pe-3"><Money v={l.runningPayable ?? 0} /></td>
                    <td className="py-2 pe-3 text-info"><Money v={l.runningOnAccount ?? 0} /></td>
                    <td className="py-2 pe-3 font-semibold"><Money v={l.runningNet} /></td>
                  </tr>
                ))}
                <BalanceRow label={t("Carried forward", "رصيد مرحَّل")} b={data.closing} testId="stmt-closing" />
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
