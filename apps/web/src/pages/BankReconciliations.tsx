/**
 * PERIOD RECONCILIATION (Phase 12D, 2026-09-23).
 * Record: docs/product/phase-12-banking-reconciliation-decision-pack.md §6.
 *
 * For one bank as of a date: the bank's closing balance, set against the
 * ledger and every item that explains the gap —
 *     ledger balance − in the books, not yet on the statement
 *                    + on the statement, not yet in the books   = what the bank should say
 * Completed ONLY when the difference is zero. 🔴 There is no adjustment
 * button and no "close enough": a difference is something to find (a missing
 * line, an unrecorded charge, a wrong link), and the page says so.
 *
 * Every figure is the server's; the page adds nothing up.
 */
import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Scale } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { useBankOptions } from "@/components/payments/shared";
import {
  useGetBankReconciliationPosition, getGetBankReconciliationPositionQueryKey,
  useListBankReconciliations, getListBankReconciliationsQueryKey,
  completeBankReconciliation, reopenBankReconciliation,
  ApiError, type GetBankReconciliationPositionParams, type BankReconciliationRecord,
} from "@workspace/api-client-react";

const Money = ({ v }: { v: number }) => <span className="font-mono" dir="ltr">{fmtNum(v)}</span>;
const messageOf = (e: unknown) => (e instanceof ApiError ? ((e.data as { error?: string } | undefined)?.error ?? e.message) : (e as Error).message);

export default function BankReconciliations() {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { active } = useBankOptions();
  const [bank, setBank] = useState<string>("");
  const [asOf, setAsOf] = useState("");
  const [balance, setBalance] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reopening, setReopening] = useState<BankReconciliationRecord | null>(null);

  const params: GetBankReconciliationPositionParams = {
    bankAccountId: Number(bank),
    ...(asOf ? { asOf } : {}),
    ...(balance.trim() !== "" && Number.isFinite(Number(balance)) ? { statementBalance: Number(balance) } : {}),
  };
  const { data: p, isLoading } = useGetBankReconciliationPosition(params, {
    query: { queryKey: getGetBankReconciliationPositionQueryKey(params), enabled: bank !== "" },
  });
  const listParams = bank ? { bankAccountId: Number(bank) } : {};
  const { data: done } = useListBankReconciliations(listParams, { query: { queryKey: getListBankReconciliationsQueryKey(listParams) } });

  const refresh = () => {
    for (const key of ["/api/bank-reconciliations", "/api/bank-reconciliations/position", "/api/cash-position"]) void qc.invalidateQueries({ queryKey: [key] });
  };
  const complete = async () => {
    setBusy(true); setError(null);
    try {
      await completeBankReconciliation({ bankAccountId: Number(bank), asOf: p!.asOf, statementBalance: Number(balance) });
      toast({ title: t("Reconciliation completed", "اكتملت التسوية") });
      refresh();
    } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  };

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-full" data-testid="page-bank-reconciliations">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2"><Scale className="w-6 h-6" />{t("Period reconciliation", "التسوية البنكية للفترة")}</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
          {t("The bank's closing balance at a date, against the books and every item that explains the gap. It completes only when the difference is zero — there is no adjustment account. A completed reconciliation locks that bank's lines and postings up to its date.",
             "رصيد البنك الختامي في تاريخ محدد، مقابل الدفاتر وكل بند يفسّر الفرق. لا تكتمل التسوية إلا عندما يكون الفرق صفرًا — لا يوجد حساب تسوية. التسوية المكتملة تقفل أسطر ذلك البنك وقيوده حتى تاريخها.")}
        </p>
      </div>

      <Card>
        <CardContent className="p-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="grid gap-1">
            <Label>{t("Bank account", "الحساب البنكي")}</Label>
            <Select value={bank} onValueChange={setBank}>
              <SelectTrigger data-testid="brec-bank"><SelectValue placeholder={t("Choose a bank", "اختر بنكًا")} /></SelectTrigger>
              <SelectContent>{active.map((b) => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label>{t("As of (statement closing date)", "كما في (تاريخ إقفال الكشف)")}</Label>
            <Input type="date" dir="ltr" value={asOf} onChange={(e) => setAsOf(e.target.value)} data-testid="brec-asof" />
          </div>
          <div className="grid gap-1">
            <Label>{t("Bank's closing balance", "الرصيد الختامي لدى البنك")}</Label>
            <Input inputMode="decimal" dir="ltr" value={balance} onChange={(e) => setBalance(e.target.value)} data-testid="brec-balance" />
          </div>
        </CardContent>
      </Card>

      {bank === "" ? (
        <p className="text-sm text-muted-foreground">{t("Choose a bank account to see its reconciliation.", "اختر حسابًا بنكيًا لعرض تسويته.")}</p>
      ) : isLoading || !p ? (
        <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>
      ) : (
        <>
          <Card data-testid="brec-terms">
            <CardContent className="p-4 space-y-2 text-sm">
              {p.reconciledThrough && (
                <p className="text-muted-foreground" data-testid="brec-through">{t("Reconciled through ", "مسوّى حتى ")}<span dir="ltr">{p.reconciledThrough}</span></p>
              )}
              <div className="flex justify-between gap-3"><span>{t("Ledger balance at ", "الرصيد الدفتري في ")}<span dir="ltr">{p.asOf}</span></span><Money v={p.ledgerBalance} /></div>
              <div className="flex justify-between gap-3"><span>{t("− In the books, not yet on the statement", "− في الدفاتر وليس في الكشف بعد")}</span><span data-testid="brec-ledger-only-total"><Money v={-p.ledgerOnlyTotal} /></span></div>
              <div className="flex justify-between gap-3"><span>{t("+ On the statement, not yet in the books", "+ في الكشف وليس في الدفاتر بعد")}</span><span data-testid="brec-statement-only-total"><Money v={p.statementOnlyTotal} /></span></div>
              <div className="flex justify-between gap-3 font-medium border-t pt-2"><span>{t("= What the bank should say", "= ما يجب أن يظهره البنك")}</span><span data-testid="brec-expected"><Money v={p.expectedStatement} /></span></div>
              <div className="flex justify-between gap-3"><span>{t("The bank says", "رصيد البنك")}</span>{p.statementBalance == null ? <span className="text-muted-foreground">{t("not entered", "غير مُدخل")}</span> : <Money v={p.statementBalance} />}</div>
              <div className="flex justify-between gap-3 font-semibold" data-testid="brec-difference">
                <span>{t("Difference", "الفرق")}</span>
                {p.difference == null
                  ? <span className="text-muted-foreground">{t("enter the bank's balance", "أدخل رصيد البنك")}</span>
                  : <span className={p.balanced ? "text-positive" : "text-attention"}><Money v={p.difference} /></span>}
              </div>
              {p.difference != null && !p.balanced && (
                <p className="text-sm text-muted-foreground" data-testid="brec-find">
                  {t("Find the difference before completing: a statement line not imported, a charge not recorded, or a line reconciled to the wrong movement. There is no adjustment account.",
                     "ابحث عن الفرق قبل الإكمال: سطر كشف لم يُستورد، أو رسوم لم تُسجَّل، أو سطر سُوّي مع حركة خاطئة. لا يوجد حساب تسوية.")}
                </p>
              )}
              {error && <p className="text-sm text-destructive" data-testid="brec-error">{error}</p>}
              <div className="flex justify-end">
                <Button onClick={complete} disabled={busy || !p.balanced} data-testid="brec-complete">{t("Complete reconciliation", "إكمال التسوية")}</Button>
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ItemsCard title={t("In the books, not yet on the statement", "في الدفاتر وليس في الكشف بعد")} testId="brec-ledger-only" empty={t("None.", "لا شيء.")}
              rows={p.ledgerOnly.map((i) => ({ key: `l${i.journalLineId}`, date: i.date, label: `${i.entryNumber}${i.description ? ` — ${i.description}` : ""}`, amount: i.signedOutstanding }))} />
            <ItemsCard title={t("On the statement, not yet in the books", "في الكشف وليس في الدفاتر بعد")} testId="brec-statement-only" empty={t("None.", "لا شيء.")}
              rows={p.statementOnly.map((i) => ({ key: `s${i.transactionId}`, date: i.date, label: i.description, amount: i.signedOutstanding, href: "/bank-reconciliation" }))} />
          </div>
        </>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">{t("Completed reconciliations", "التسويات المكتملة")}</CardTitle></CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          {(done?.reconciliations ?? []).length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground" data-testid="brec-none">{t("None yet.", "لا توجد بعد.")}</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-muted-foreground border-b">
                <tr>
                  <th className="text-start p-3">{t("Bank", "البنك")}</th>
                  <th className="text-start p-3">{t("As of", "كما في")}</th>
                  <th className="text-end p-3">{t("Bank balance", "رصيد البنك")}</th>
                  <th className="text-end p-3">{t("Ledger balance", "الرصيد الدفتري")}</th>
                  <th className="text-start p-3">{t("State", "الحالة")}</th>
                  <th className="p-3" />
                </tr>
              </thead>
              <tbody>
                {done!.reconciliations.map((r) => (
                  <tr key={r.id} className="border-b last:border-0" data-testid={`brec-row-${r.id}`}>
                    <td className="p-3">{r.bankName}</td>
                    <td className="p-3" dir="ltr">{r.asOf}</td>
                    <td className="p-3 text-end"><Money v={r.statementBalance} /></td>
                    <td className="p-3 text-end"><Money v={r.ledgerBalance} /></td>
                    <td className="p-3">
                      {r.reopening
                        ? <><Badge variant="outline">{t("Reopened", "أعيد فتحها")}</Badge><div className="text-xs text-muted-foreground mt-1">{r.reopening.reason}</div></>
                        : <Badge variant="outline">{t("Completed", "مكتملة")}</Badge>}
                    </td>
                    <td className="p-3 text-end">
                      {!r.reopening && <Button size="sm" variant="outline" onClick={() => setReopening(r)} data-testid={`brec-reopen-${r.id}`}>{t("Reopen", "إعادة فتح")}</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {reopening && <ReopenDialog rec={reopening} onClose={() => setReopening(null)} onDone={() => { setReopening(null); refresh(); toast({ title: t("Reconciliation reopened", "أعيد فتح التسوية") }); }} />}
    </div>
  );
}

function ItemsCard({ title, rows, testId, empty }: { title: string; testId: string; empty: string; rows: Array<{ key: string; date: string; label: string; amount: number; href?: string }> }) {
  return (
    <Card data-testid={testId}>
      <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{empty}</p> : (
          <ul className="divide-y text-sm">
            {rows.map((r) => (
              <li key={r.key} className="flex items-center justify-between gap-3 p-3">
                <span className="min-w-0"><span className="text-muted-foreground me-2" dir="ltr">{r.date}</span>{r.href ? <Link className="underline" href={r.href}>{r.label}</Link> : r.label}</span>
                <Money v={r.amount} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ReopenDialog({ rec, onClose, onDone }: { rec: BankReconciliationRecord; onClose: () => void; onDone: () => void }) {
  const { t } = useLanguage();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setError(null);
    try { await reopenBankReconciliation(rec.id, { reason: reason.trim() }); onDone(); } catch (e) { setError(messageOf(e)); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md" data-testid="brec-reopen-dialog">
        <DialogHeader>
          <DialogTitle>{t("Reopen this reconciliation", "إعادة فتح هذه التسوية")}</DialogTitle>
          <DialogDescription>{t("The record stays, with your reason; the bank is unlocked back to the reconciliation before it. Only the latest one can be reopened.", "يبقى السجل مع السبب؛ ويُفك قفل البنك حتى التسوية السابقة. لا يمكن إعادة فتح إلا الأحدث.")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <p className="text-sm">{rec.bankName} · <span dir="ltr">{rec.asOf}</span></p>
          <Label>{t("Why is it being reopened?", "لماذا يعاد فتحها؟")}</Label>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} data-testid="brec-reopen-reason" />
          {error && <p className="text-sm text-destructive" data-testid="brec-reopen-error">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>{t("Cancel", "إلغاء")}</Button>
            <Button onClick={submit} disabled={!reason.trim()} data-testid="brec-reopen-submit">{t("Reopen", "إعادة فتح")}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
