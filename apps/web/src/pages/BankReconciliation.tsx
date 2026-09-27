/**
 * THE RECONCILIATION WORKBENCH (Phase 12B, 2026-09-23).
 * Record: docs/product/phase-12-banking-reconciliation-decision-pack.md §4.
 *
 * Each bank statement line, and how much of it the ledger already answers —
 * by the line's own posting, a receipt match, a Review settlement, or a
 * reconciliation link. A line is reconciled to ledger cash lines that ALREADY
 * EXIST (a supplier payment, a refund, a bill payment, a journal), in whole or
 * in part, to one or several of them. Nothing on this page posts: it records
 * which ledger movement the bank line IS.
 *
 * 🔴 Every figure is the server's (the view `bank_line_reconciliation`); the
 * page adds nothing up except the running total of what the user is about to
 * link, which the server re-checks — and a database trigger re-checks after it.
 */
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { fmtNum } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Scale, Wand2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { useBankOptions } from "@/components/payments/shared";
import {
  useListReconciliationLines, getListReconciliationLinesQueryKey,
  useGetReconciliationLine, getGetReconciliationLineQueryKey,
  useClassifyApReconciliation, getClassifyApReconciliationQueryKey,
  linkReconciliationLine, reverseReconciliationLink, applyApReconciliation,
  type ListReconciliationLinesParams, type ReconciliationStatus, type ReconciliationLineDetail,
} from "@workspace/api-client-react";

const Money = ({ v }: { v: number }) => <span className="font-mono" dir="ltr">{fmtNum(v)}</span>;

const STATUS: Record<ReconciliationStatus, { en: string; ar: string; cls: string }> = {
  unreconciled: { en: "Unreconciled", ar: "غير مسوّى", cls: "text-attention border-attention/40" },
  partial: { en: "Partly reconciled", ar: "مسوّى جزئيًا", cls: "text-attention border-attention/40" },
  reconciled: { en: "Reconciled", ar: "مسوّى", cls: "text-positive border-positive/40" },
};

const DOCUMENT: Record<string, { en: string; ar: string }> = {
  supplier_payment: { en: "Supplier payment", ar: "دفعة مورد" },
  supplier_refund: { en: "Supplier refund", ar: "استرداد من مورد" },
  bill_payment: { en: "Bill payment", ar: "سداد فاتورة مورد" },
  receipt: { en: "Customer receipt", ar: "مقبوضات عميل" },
  customer_refund: { en: "Customer refund", ar: "رد مبلغ لعميل" },
  statement_line: { en: "Accepted bank line", ar: "سطر بنكي مقبول" },
  bank_transfer: { en: "Bank transfer", ar: "تحويل بنكي" },
  journal: { en: "Journal entry", ar: "قيد يومية" },
};

const SOURCE: Record<string, { en: string; ar: string }> = {
  posted: { en: "posted as its own entry", ar: "رُحِّل كقيد مستقل" },
  ar_match: { en: "matched to a receipt", ar: "مطابق لمقبوضات" },
  ar_settlement: { en: "settled from review", ar: "سُوّي من المراجعة" },
  link: { en: "reconciled here", ar: "سُوّي هنا" },
};

export default function BankReconciliation() {
  const { t, lang } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { banks, byId } = useBankOptions();
  const [bank, setBank] = useState<string>("all");
  const [status, setStatus] = useState<string>("unreconciled");
  const [open, setOpen] = useState<number | null>(null);

  const params: ListReconciliationLinesParams = {
    ...(bank !== "all" ? { bankAccountId: Number(bank) } : {}),
    ...(status !== "all" ? { status: status as ReconciliationStatus } : {}),
    limit: 100,
  };
  const { data, isLoading, isError } = useListReconciliationLines(params, { query: { queryKey: getListReconciliationLinesQueryKey(params) } });
  const apParams = bank !== "all" ? { bankAccountId: Number(bank) } : {};
  const { data: ap } = useClassifyApReconciliation(apParams, { query: { queryKey: getClassifyApReconciliationQueryKey(apParams) } });
  const deterministic = (ap?.items ?? []).filter((i) => i.classification === "DETERMINISTIC").length;

  const refresh = () => {
    for (const key of ["/api/bank-reconciliation/lines", "/api/bank-reconciliation/ap-matching", "/api/transactions", "/api/bank-statements"]) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
  };
  const [applying, setApplying] = useState(false);
  const applyAp = async () => {
    setApplying(true);
    try {
      const res = await applyApReconciliation(apParams);
      toast({ title: t(`${res.summary.deterministic} line(s) reconciled`, `سُوّي ${res.summary.deterministic} سطر`), description: t(`${res.summary.ambiguous} ambiguous and ${res.summary.unmatched} unmatched lines need a person.`, `${res.summary.ambiguous} غامض و${res.summary.unmatched} بلا مقابل تحتاج إلى قرار بشري.`) });
      refresh();
    } catch (e) {
      toast({ title: t("Refused", "مرفوض"), description: (e as Error).message, variant: "destructive" });
    } finally { setApplying(false); }
  };

  const items = data?.items ?? [];
  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-full" data-testid="page-bank-reconciliation">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><Scale className="w-6 h-6" />{t("Bank reconciliation", "التسوية البنكية")}</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
            {t("Each bank line, and how much of it the ledger already records. Reconcile a line to the payments, refunds or entries that ARE that money — wholly, partly, or across several. Nothing here posts.",
               "كل سطر بنكي، ومقدار ما يسجله الدفتر منه. سوِّ السطر مع الدفعات أو المستردات أو القيود التي تمثل تلك الأموال — كليًا أو جزئيًا أو عبر عدة مستندات. لا يُرحَّل شيء من هنا.")}
          </p>
        </div>
        <Button className="gap-2" onClick={applyAp} disabled={applying || deterministic === 0} data-testid="rec-apply-ap">
          <Wand2 className="w-4 h-4" />{t(`Reconcile ${deterministic} supplier line(s) by reference`, `تسوية ${deterministic} سطر للموردين بالمرجع`)}
        </Button>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="w-64">
          <Select value={bank} onValueChange={setBank}>
            <SelectTrigger data-testid="rec-bank"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("All bank accounts", "كل الحسابات البنكية")}</SelectItem>
              {banks.map((b) => <SelectItem key={b.id} value={String(b.id)}>{b.name} — {b.bankName}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="w-56">
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger data-testid="rec-status"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("All lines", "كل الأسطر")}</SelectItem>
              {(Object.keys(STATUS) as ReconciliationStatus[]).map((s) => <SelectItem key={s} value={s}>{t(STATUS[s].en, STATUS[s].ar)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6 overflow-x-auto">
          {isLoading ? <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>
           : isError ? <p className="text-sm text-negative">{t("Could not load the lines.", "تعذّر تحميل الأسطر.")}</p>
           : items.length === 0 ? <p className="text-sm text-muted-foreground" data-testid="rec-empty">{t("No lines in this view.", "لا أسطر في هذا العرض.")}</p>
           : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-muted-foreground text-xs uppercase">
                {[t("Date", "التاريخ"), t("Bank", "البنك"), t("Description", "الوصف"), t("In / out", "داخل / خارج"), t("Amount", "المبلغ"), t("Left to reconcile", "المتبقي"), t("Status", "الحالة"), ""].map((h, i) => (
                  <th key={i} className="text-start pb-2 pe-3 font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {items.map((l) => (
                  <tr key={l.id} className="border-b border-border/50" data-testid={`rec-line-${l.id}`}>
                    <td className="py-2 pe-3 font-mono text-xs whitespace-nowrap" dir="ltr">{l.date}</td>
                    <td className="py-2 pe-3 text-xs">{byId(l.bankAccountId)?.name ?? `#${l.bankAccountId}`}</td>
                    <td className="py-2 pe-3 text-xs max-w-72 truncate" title={l.description}>{l.description}</td>
                    <td className="py-2 pe-3 text-xs">{l.direction === "in" ? t("In", "داخل") : t("Out", "خارج")}</td>
                    <td className="py-2 pe-3"><Money v={l.amount} /></td>
                    <td className="py-2 pe-3" data-testid={`rec-remaining-${l.id}`}><Money v={l.remaining} /></td>
                    <td className="py-2 pe-3"><Badge variant="outline" className={`text-[10px] ${STATUS[l.status].cls}`} data-testid={`rec-status-${l.id}`}>{t(STATUS[l.status].en, STATUS[l.status].ar)}</Badge></td>
                    <td className="py-2"><Button size="sm" variant="ghost" onClick={() => setOpen(l.id)} data-testid={`rec-open-${l.id}`}>{t("Open", "فتح")}</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Dialog open={open != null} onOpenChange={(v) => !v && setOpen(null)}>
        {open != null && <LineDialog id={open} lang={lang} t={t} onChanged={refresh} onClose={() => setOpen(null)} />}
      </Dialog>
    </div>
  );
}

function LineDialog({ id, t, onChanged, onClose }: { id: number; lang: string; t: (en: string, ar: string) => string; onChanged: () => void; onClose: () => void }) {
  const { toast } = useToast();
  const { data, refetch } = useGetReconciliationLine(id, { query: { queryKey: getGetReconciliationLineQueryKey(id) } });
  const [picked, setPicked] = useState<Record<number, string>>({});
  const [reason, setReason] = useState("");
  const [undoReason, setUndoReason] = useState("");
  const [busy, setBusy] = useState(false);
  const total = useMemo(() => Object.values(picked).reduce((s, v) => s + (Number(v) || 0), 0), [picked]);

  if (!data) return <DialogContent><p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p></DialogContent>;
  const line: ReconciliationLineDetail = data;

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast({ title: done });
      setPicked({}); setReason(""); setUndoReason("");
      await refetch(); onChanged();
    } catch (e) {
      // The server's refusal, in its words — the caps, the evidence rule, the reason.
      toast({ title: t("Refused", "مرفوض"), description: (e as Error).message, variant: "destructive" });
    } finally { setBusy(false); }
  };

  return (
    <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto" data-testid="rec-line-dialog">
      <DialogHeader>
        <DialogTitle className="text-base">{line.description}</DialogTitle>
        <DialogDescription>
          <span dir="ltr" className="font-mono">{line.date}</span>{" · "}
          {line.direction === "in" ? t("money in", "أموال داخلة") : t("money out", "أموال خارجة")}{" · "}
          <Money v={line.amount} />{" · "}
          {t("left to reconcile", "المتبقي")}: <span data-testid="rec-dialog-remaining"><Money v={line.remaining} /></span>
        </DialogDescription>
      </DialogHeader>

      {line.reconciledBy.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">{t("Reconciled to", "مسوّى مع")}</h3>
          {line.reconciledBy.map((r) => (
            <div key={`${r.source}-${r.sourceId}-${r.journalLineId}`} className="flex flex-wrap items-center gap-2 text-xs border border-border rounded p-2" data-testid={`rec-by-${r.journalLineId}`}>
              <Badge variant="outline" className="text-[10px]">{t(DOCUMENT[r.documentKind]?.en ?? r.documentKind, DOCUMENT[r.documentKind]?.ar ?? r.documentKind)}</Badge>
              <span className="font-mono" dir="ltr">{r.documentReference ?? r.entryNumber}</span>
              {r.party && <span className="text-muted-foreground">{r.party}</span>}
              <Money v={r.amount} />
              <span className="text-muted-foreground">({t(SOURCE[r.source]?.en ?? r.source, SOURCE[r.source]?.ar ?? r.source)})</span>
              {r.linkId != null && (
                <Button size="sm" variant="ghost" className="h-6 text-xs ms-auto" disabled={busy} data-testid={`rec-undo-${r.linkId}`}
                  onClick={() => act(() => reverseReconciliationLink(r.linkId!, { reason: undoReason }), t("Reconciliation undone", "أُلغيت التسوية"))}>
                  {t("Undo", "تراجع")}
                </Button>
              )}
            </div>
          ))}
          {line.reconciledBy.some((r) => r.linkId != null) && (
            <Input placeholder={t("Why is it being undone?", "لماذا يجري التراجع؟")} value={undoReason} onChange={(e) => setUndoReason(e.target.value)} data-testid="rec-undo-reason" />
          )}
        </section>
      )}

      {line.status !== "reconciled" && !line.postedOwnEntry && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">{t("Ledger movements that could be this money", "حركات دفترية قد تمثل هذه الأموال")}</h3>
          {line.candidates.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="rec-no-candidates">{t("Nothing in the ledger on this bank, moving money this way, is still unreconciled near this date. Record the payment first, or accept the line as its own entry from Review.", "لا شيء في الدفتر على هذا البنك وبهذا الاتجاه ما زال غير مسوّى قرب هذا التاريخ. سجّل الدفعة أولًا، أو اقبل السطر كقيد مستقل من المراجعة.")}</p>
          ) : (
            <div className="space-y-2">
              {line.candidates.map((c) => (
                <div key={c.journalLineId} className="flex flex-wrap items-center gap-2 text-xs border border-border rounded p-2" data-testid={`rec-cand-${c.journalLineId}`}>
                  <Badge variant="outline" className="text-[10px]">{t(DOCUMENT[c.sourceKind]?.en ?? c.sourceKind, DOCUMENT[c.sourceKind]?.ar ?? c.sourceKind)}</Badge>
                  <span className="font-mono" dir="ltr">{c.sourceReference ?? c.entryNumber}</span>
                  <span className="font-mono text-muted-foreground" dir="ltr">{c.date}</span>
                  {c.party && <span className="text-muted-foreground">{c.party}</span>}
                  <span>{t("open", "غير مسوّى")}: <Money v={c.remaining} /></span>
                  <Input type="number" step="0.01" dir="ltr" className="h-7 w-28 ms-auto" placeholder="0.00"
                    value={picked[c.journalLineId] ?? ""} onChange={(e) => setPicked((p) => ({ ...p, [c.journalLineId]: e.target.value }))}
                    data-testid={`rec-amount-${c.journalLineId}`} />
                  <Button size="sm" variant="ghost" className="h-7 text-xs"
                    onClick={() => setPicked((p) => ({ ...p, [c.journalLineId]: String(Math.min(c.remaining, line.remaining)) }))}
                    data-testid={`rec-fill-${c.journalLineId}`}>{t("Use", "استخدم")}</Button>
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span>{t("Selected", "المحدد")}: <span data-testid="rec-selected-total"><Money v={total} /></span> / <Money v={line.remaining} /></span>
                <Input className="flex-1 min-w-48 h-8" placeholder={t("Reason (needed when the dates are far apart)", "السبب (مطلوب عند تباعد التواريخ)")} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="rec-reason" />
                <Button size="sm" disabled={busy || total <= 0} data-testid="rec-submit"
                  onClick={() => act(() => linkReconciliationLine(id, {
                    lines: Object.entries(picked).filter(([, v]) => Number(v) > 0).map(([k, v]) => ({ journalLineId: Number(k), amount: Number(v) })),
                    reason: reason || null,
                  }), t("Reconciled", "تمت التسوية"))}>
                  {t("Reconcile", "تسوية")}
                </Button>
              </div>
            </div>
          )}
        </section>
      )}
      <div className="flex justify-end"><Button variant="outline" size="sm" onClick={onClose} data-testid="rec-close">{t("Close", "إغلاق")}</Button></div>
    </DialogContent>
  );
}
