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
import { PageHeader, StatStrip, Stat, Panel, EmptyState } from "@/components/kit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Building2 } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import {
  useListSupplierPositions, useGetSupplierStatement, useListVendors,
  getGetSupplierStatementQueryKey, type SupplierStatementBalance,
} from "@workspace/api-client-react";

const Money = ({ v }: { v: number }) => <span className="tabular-nums whitespace-nowrap" dir="ltr">{fmtNum(v)}</span>;

const ROW = "border-b border-border/70 hover:bg-muted/40 transition-colors";
const th = (num: boolean) => `${num ? "text-end" : "text-start"} px-3`;

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
    <div className="space-y-6" data-testid="page-supplier-statements">
      <PageHeader
        title={t("Supplier statements", "كشوف حساب الموردين")}
        description={t("What we owe each supplier, and what each supplier holds. Advances, deposits and unapplied credit notes are ASSETS — never negative payables — so the net is shown as its own derived figure.",
             "ما ندين به لكل مورد، وما يحتفظ به كل مورد. الدفعات المقدمة والتأمينات وإشعارات الدائن غير المطبقة أصول — لا ذمم دائنة سالبة — ولذلك يُعرض الصافي كرقم مشتق مستقل.")}
      />

      <Panel flush>
        <div className="overflow-x-auto">
          {isLoading ? <p className="text-sm text-muted-foreground p-5">{t("Loading…", "جارٍ التحميل…")}</p>
           : isError ? <p className="text-sm text-negative p-5">{t("Could not load supplier positions.", "تعذّر تحميل مراكز الموردين.")}</p>
           : (data?.items ?? []).length === 0 ? <EmptyState icon={Building2} title={t("No supplier activity yet.", "لا يوجد نشاط للموردين بعد.")} data-testid="no-supplier-positions" />
           : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border">
                {([[t("Supplier", "المورد"), false], [t("Payable", "المستحق عليها"), true], [t("Credit notes", "إشعارات دائن"), true], [t("Advances", "دفعات مقدمة"), true], [t("Deposits", "تأمينات"), true], [t("Unidentified", "غير محددة"), true], [t("Net", "الصافي"), true], ["", false]] as const).map(([h, num], i) => (
                  <th key={i} className={th(num)}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {(data?.items ?? []).map((p) => (
                  <tr key={p.vendorId} className={ROW} data-testid={`supplier-position-${p.vendorId}`}>
                    <td className="py-3 px-3 font-medium min-w-[10rem]">{nameOf(p.vendorId)}</td>
                    <td className="py-3 px-3 text-end" data-testid={`position-payable-${p.vendorId}`}><Money v={p.payable} /></td>
                    <td className="py-3 px-3 text-end text-info"><Money v={p.creditBalance} /></td>
                    <td className="py-3 px-3 text-end text-info"><Money v={p.advanceBalance} /></td>
                    <td className="py-3 px-3 text-end text-info"><Money v={p.depositBalance} /></td>
                    <td className="py-3 px-3 text-end text-info"><Money v={p.unidentifiedBalance} /></td>
                    <td className="py-3 px-3 text-end font-semibold" data-testid={`position-net-${p.vendorId}`}><Money v={p.netPosition} /></td>
                    <td className="py-3 px-3 text-end">
                      <Link href={`/supplier-statements/${p.vendorId}`}>
                        <Button size="sm" variant="ghost" data-testid={`open-statement-${p.vendorId}`}>{t("Statement", "الكشف")}</Button>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Panel>
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
    <tr className="border-b border-border bg-muted/50 font-medium" data-testid={testId}>
      <td className="py-3 px-3" colSpan={4}>{label}</td>
      <td className="py-3 px-3 text-end"><Money v={b.payable} /></td>
      <td className="py-3 px-3 text-end text-info"><Money v={b.onAccount} /></td>
      <td className="py-3 px-3 text-end font-semibold" data-testid={`${testId}-net`}><Money v={b.net} /></td>
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

  if (isLoading) return <div className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</div>;
  if (isError || !data) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-negative" data-testid="statement-error">{t("Could not load this statement.", "تعذّر تحميل هذا الكشف.")} {(error as Error | null)?.message ?? ""}</p>
        <Button size="sm" variant="outline" onClick={() => { setFrom(""); setTo(""); }}>{t("Clear the dates", "مسح التواريخ")}</Button>
      </div>
    );
  }

  const p = data.position;
  const r = data.reconciliation;
  const g = data.gl;

  return (
    <div className="space-y-6" data-testid="page-supplier-statement">
      <div>
        <Link
          href="/supplier-statements"
          className="mb-2 inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
          data-testid="back-to-positions"
        >
          <span aria-hidden className="rtl:-scale-x-100 inline-block">←</span>
          {t("All suppliers", "كل الموردين")}
        </Link>
        <PageHeader
          title={<span data-testid="statement-vendor">{lang === "ar" && data.vendor.nameAr ? data.vendor.nameAr : data.vendor.name}</span>}
          description={t("Supplier statement", "كشف حساب المورد")}
          className="mb-0"
        />
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card px-5 py-4">
        <div className="space-y-1">
          <Label htmlFor="stmt-from" className="text-[13px]">{t("From", "من")}</Label>
          <Input id="stmt-from" type="date" dir="ltr" className="w-44" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="stmt-from" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="stmt-to" className="text-[13px]">{t("To", "إلى")}</Label>
          <Input id="stmt-to" type="date" dir="ltr" className="w-44" value={to} onChange={(e) => setTo(e.target.value)} data-testid="stmt-to" />
        </div>
        {(from || to) && <Button size="sm" variant="ghost" onClick={() => { setFrom(""); setTo(""); }} data-testid="stmt-clear-window">{t("Whole history", "كامل السجل")}</Button>}
        <p className="text-[13px] text-muted-foreground max-w-md">
          {t("The position below is as of today. The dates choose which events are listed, with the balance brought forward and carried.",
             "المركز أدناه كما هو اليوم. والتواريخ تحدد الأحداث المعروضة، مع الرصيد المنقول من قبل والمرحَّل إلى بعد.")}
        </p>
      </div>

      <StatStrip cols={5} className="lg:grid-cols-6">
        {([
          [t("Payable", "المستحق عليها"), p.payable, "stmt-payable"],
          [t("− Credit notes", "− إشعارات دائن"), p.creditBalance, "stmt-credits"],
          [t("− Advances", "− دفعات مقدمة"), p.advanceBalance, "stmt-advances"],
          [t("− Deposits", "− تأمينات"), p.depositBalance, "stmt-deposits"],
          [t("− Unidentified", "− غير محددة"), p.unidentifiedBalance, "stmt-unidentified"],
          [t("= Net (derived)", "= الصافي (مشتق)"), p.netPosition, "stmt-net"],
        ] as [string, number, string][]).map(([label, value, id]) => (
          <Stat key={id} label={label} value={<span data-testid={id}>{fmtNum(value)}</span>} className={id === "stmt-net" ? "bg-accent/40" : undefined} />
        ))}
      </StatStrip>

      {/*
        🔴 The check is shown whether it passes or fails. A green tick that is
        never wrong is a tick nobody reads; the figures are printed beside it so
        a disagreement names both numbers and their difference.
      */}
      <Panel
        title={t("Does the event stream agree with the position?", "هل يتفق سجل الأحداث مع المركز؟")}
        actions={
          <Badge variant="outline" className={r.agrees ? "text-positive" : "text-negative"} data-testid="stmt-agrees">
            {r.agrees ? t("They agree", "متفقان") : t("They disagree", "غير متفقين")}
          </Badge>
        }
      >
        <dl className="grid gap-4 sm:grid-cols-3 text-sm">
          <div><dt className="text-[12px] text-muted-foreground">{t("From the position", "من المركز")}</dt><dd className="mt-0.5"><Money v={r.fromPosition} /></dd></div>
          <div><dt className="text-[12px] text-muted-foreground">{t("From the events", "من الأحداث")}</dt><dd className="mt-0.5"><Money v={r.fromEvents} /></dd></div>
          <div><dt className="text-[12px] text-muted-foreground">{t("Difference", "الفرق")}</dt><dd className="mt-0.5 font-medium"><span data-testid="stmt-difference"><Money v={r.difference} /></span></dd></div>
        </dl>
      </Panel>

      {/*
        🔴 The subledger ↔ GL tie, per account, shown agreeing or not. Pre-N3
        control lines carried no party and cannot be attributed to a supplier,
        so a difference is REPORTED with both figures rather than assumed away.
      */}
      <Panel
        flush
        title={t("Does the subledger agree with the general ledger?", "هل يتفق دفتر الموردين مع دفتر الأستاذ العام؟")}
        actions={<Badge variant="outline" className={g.agrees ? "text-positive" : "text-negative"} data-testid="stmt-gl-agrees">{g.agrees ? t("They agree", "متفقان") : t("They disagree", "غير متفقين")}</Badge>}
      >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border">
                {([[t("Account", "الحساب"), false], [t("Subledger", "دفتر الموردين"), true], [t("General ledger", "الأستاذ العام"), true]] as const).map(([h, num]) => <th key={h} className={th(num)}>{h}</th>)}
              </tr></thead>
              <tbody>
                {([
                  [t("Accounts payable (payable − credit notes)", "الذمم الدائنة (المستحق − إشعارات الدائن)"), g.components.ap, "ap"],
                  [t("Supplier advances", "دفعات مقدمة للموردين"), g.components.advances, "advances"],
                  [t("Security deposits paid", "تأمينات مدفوعة"), g.components.deposits, "deposits"],
                  [t("Unidentified payments", "مدفوعات غير محددة"), g.components.unidentified, "unidentified"],
                ] as const).map(([label, c, id]) => (
                  <tr key={id} className={ROW} data-testid={`stmt-gl-${id}`}>
                    <td className="py-3 px-3">{label}</td>
                    <td className="py-3 px-3 text-end"><Money v={c.fromSubledger} /></td>
                    <td className="py-3 px-3 text-end"><Money v={c.fromGl} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
      </Panel>

      <Panel flush title={t("Every event, in date order", "كل حدث، بترتيب التاريخ")}>
        <div className="overflow-x-auto">
          {data.lines.length === 0 && !from && !to ? (
            <EmptyState title={t("Nothing has happened with this supplier yet.", "لم يحدث شيء مع هذا المورد بعد.")} data-testid="no-statement-lines" />
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border">
                {([[t("Date", "التاريخ"), false], [t("What", "الحدث"), false], [t("Document", "المستند"), false], [t("Description", "الوصف"), false], [t("Payable", "المستحق"), true], [t("On account", "على الحساب"), true], [t("Running net", "الرصيد الجاري"), true]] as const).map(([h, num], i) => (
                  <th key={i} className={th(num)}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                <BalanceRow label={t("Brought forward", "رصيد منقول")} b={data.opening} testId="stmt-opening" />
                {data.lines.length === 0 && (
                  <tr><td colSpan={7} className="py-3 px-3 text-[13px] text-muted-foreground" data-testid="no-lines-in-window">{t("No events in these dates.", "لا أحداث في هذه التواريخ.")}</td></tr>
                )}
                {data.lines.map((l, i) => (
                  <tr key={`${l.kind}-${l.id}-${i}`} className={ROW} data-testid={`statement-line-${i}`}>
                    <td className="py-3 px-3 whitespace-nowrap tabular-nums text-muted-foreground" dir="ltr">{l.date}</td>
                    <td className="py-3 px-3">
                      <Badge variant="outline" className="text-[11px] whitespace-nowrap">{t(KIND_LABELS[l.kind]?.en ?? l.kind, KIND_LABELS[l.kind]?.ar ?? l.kind)}</Badge>
                    </td>
                    <td className="py-3 px-3 font-medium text-primary whitespace-nowrap" dir="ltr">{l.documentNumber}</td>
                    <td className="py-3 px-3 text-[13px] text-muted-foreground">{l.description}</td>
                    <td className="py-3 px-3 text-end"><Money v={l.runningPayable ?? 0} /></td>
                    <td className="py-3 px-3 text-end text-info"><Money v={l.runningOnAccount ?? 0} /></td>
                    <td className="py-3 px-3 text-end font-semibold"><Money v={l.runningNet} /></td>
                  </tr>
                ))}
                <BalanceRow label={t("Carried forward", "رصيد مرحَّل")} b={data.closing} testId="stmt-closing" />
              </tbody>
            </table>
          )}
        </div>
      </Panel>
    </div>
  );
}
