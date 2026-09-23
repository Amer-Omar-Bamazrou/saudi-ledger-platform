/**
 * TRANSFERS BETWEEN OWN BANKS (Phase 12C, 2026-09-23).
 * Record: docs/product/phase-12-banking-reconciliation-decision-pack.md §5.
 *
 * Recording a transfer posts ONE entry — the destination bank up, the source
 * bank down — and nothing else. When the banks' statements arrive, their two
 * lines are reconciled to it in the Reconciliation Workbench; they are never
 * accepted to post, which would move the cash twice.
 *
 * 🔴 A possible duplicate is EXPLAINED, not hidden: the server's refusal names
 * the transfers (or already-posted clearing legs) it may repeat, and the
 * person can record it anyway only by saying why it is a different movement.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { fmtNum } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeftRight, Plus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { useBankOptions } from "@/components/payments/shared";
import {
  useListBankTransfers, getListBankTransfersQueryKey, createBankTransfer, reverseBankTransfer,
  ApiError, type BankTransfer, type ListBankTransfersParams,
} from "@workspace/api-client-react";

const Money = ({ v }: { v: number }) => <span className="font-mono" dir="ltr">{fmtNum(v)}</span>;

type Duplicate = { kind: "bank_transfer" | "clearing_leg"; id: number; date: string; amount: number; description: string };

const errorOf = (e: unknown): { code?: string; message: string; duplicates?: Duplicate[] } => {
  if (e instanceof ApiError) {
    const d = (e.data ?? {}) as { code?: string; error?: string; duplicates?: Duplicate[] };
    return { code: d.code, message: d.error ?? e.message, duplicates: d.duplicates };
  }
  return { message: (e as Error).message };
};

export default function BankTransfers() {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { banks, active } = useBankOptions();
  const [bank, setBank] = useState<string>("all");
  const [creating, setCreating] = useState(false);
  const [reversing, setReversing] = useState<BankTransfer | null>(null);

  const params: ListBankTransfersParams = { ...(bank !== "all" ? { bankAccountId: Number(bank) } : {}), limit: 100 };
  const { data, isLoading, isError } = useListBankTransfers(params, { query: { queryKey: getListBankTransfersQueryKey(params) } });
  const refresh = () => {
    for (const key of ["/api/bank-transfers", "/api/bank-reconciliation/lines", "/api/journal-entries"]) void qc.invalidateQueries({ queryKey: [key] });
    void qc.invalidateQueries({ queryKey: ["bank-accounts"] });
  };
  const items = data?.transfers ?? [];

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-full" data-testid="page-bank-transfers">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><ArrowLeftRight className="w-6 h-6" />{t("Transfers between own banks", "التحويلات بين الحسابات البنكية")}</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
            {t("Recording a transfer posts one entry: the destination bank up, the source bank down. When the statements arrive, reconcile both bank lines to it in the Reconciliation Workbench — never accept them, or the money moves twice.",
               "تسجيل التحويل يُرحِّل قيدًا واحدًا: يزيد البنك المستلم وينقص البنك المحوِّل. عند وصول الكشوف، سوِّ سطري البنكين مع التحويل في منصة التسوية — ولا تقبلهما، وإلا تحركت الأموال مرتين.")}
          </p>
        </div>
        <Button className="gap-2" onClick={() => setCreating(true)} disabled={active.length < 2} data-testid="trf-new">
          <Plus className="w-4 h-4" />{t("Record a transfer", "تسجيل تحويل")}
        </Button>
      </div>
      {active.length < 2 && (
        <p className="text-sm text-muted-foreground" data-testid="trf-needs-two">
          {t("A transfer needs two active bank accounts. Add the second one under Bank Accounts first.", "يتطلب التحويل حسابين بنكيين نشطين. أضف الحساب الثاني من صفحة الحسابات البنكية أولًا.")}
        </p>
      )}

      <div className="w-64">
        <Select value={bank} onValueChange={setBank}>
          <SelectTrigger data-testid="trf-bank"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("All bank accounts", "كل الحسابات البنكية")}</SelectItem>
            {banks.map((b) => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {isLoading ? <p className="p-6 text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>
            : isError ? <p className="p-6 text-sm text-destructive">{t("Could not load transfers.", "تعذر تحميل التحويلات.")}</p>
            : items.length === 0 ? <p className="p-6 text-sm text-muted-foreground" data-testid="trf-empty">{t("No transfers recorded.", "لا توجد تحويلات مسجلة.")}</p>
            : (
              <table className="w-full text-sm">
                <thead className="text-muted-foreground border-b">
                  <tr>
                    <th className="text-start p-3">{t("Date", "التاريخ")}</th>
                    <th className="text-start p-3">{t("From", "من")}</th>
                    <th className="text-start p-3">{t("To", "إلى")}</th>
                    <th className="text-end p-3">{t("Amount", "المبلغ")}</th>
                    <th className="text-start p-3">{t("Statement lines", "أسطر الكشف")}</th>
                    <th className="p-3" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((x) => (
                    <tr key={x.id} className="border-b last:border-0" data-testid={`trf-row-${x.id}`}>
                      <td className="p-3 whitespace-nowrap" dir="ltr">{x.transferDate}</td>
                      <td className="p-3">{x.fromBankName}</td>
                      <td className="p-3">{x.toBankName}</td>
                      <td className="p-3 text-end"><Money v={x.amount} /></td>
                      <td className="p-3" data-testid={`trf-state-${x.id}`}>
                        {x.reversal
                          ? <Badge variant="outline">{t("Reversed", "معكوس")}</Badge>
                          : <Badge variant="outline">{t(`${x.reconciledLines} of 2 reconciled`, `${x.reconciledLines} من 2 مسوّى`)}</Badge>}
                        <div className="text-xs text-muted-foreground mt-1">{x.entryNumber}{x.reference ? ` · ${x.reference}` : ""}</div>
                        {x.duplicateConfirmationReason && (
                          <div className="text-xs text-muted-foreground mt-1">{t("Confirmed not a duplicate: ", "مؤكَّد أنه ليس مكررًا: ")}{x.duplicateConfirmationReason}</div>
                        )}
                        {x.reversal && <div className="text-xs text-muted-foreground mt-1">{t("Reason: ", "السبب: ")}{x.reversal.reason}</div>}
                      </td>
                      <td className="p-3 text-end">
                        {!x.reversal && (
                          <Button size="sm" variant="outline" onClick={() => setReversing(x)} data-testid={`trf-reverse-${x.id}`}>{t("Reverse", "عكس")}</Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </CardContent>
      </Card>

      {creating && <CreateDialog onClose={() => setCreating(false)} onDone={() => { setCreating(false); refresh(); toast({ title: t("Transfer recorded", "سُجِّل التحويل") }); }} />}
      {reversing && <ReverseDialog transfer={reversing} onClose={() => setReversing(null)} onDone={() => { setReversing(null); refresh(); toast({ title: t("Transfer reversed", "عُكس التحويل") }); }} />}
    </div>
  );
}

function CreateDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useLanguage();
  const { active } = useBankOptions();
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");
  const [reference, setReference] = useState("");
  const [duplicates, setDuplicates] = useState<Duplicate[] | null>(null);
  const [confirmReason, setConfirmReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      await createBankTransfer({
        fromBankAccountId: Number(from), toBankAccountId: Number(to), amount: Number(amount),
        ...(date ? { transferDate: date } : {}), ...(reference.trim() ? { reference: reference.trim() } : {}),
        ...(duplicates ? { confirmDuplicate: true, duplicateConfirmationReason: confirmReason.trim() } : {}),
      });
      onDone();
    } catch (e) {
      const err = errorOf(e);
      if (err.code === "possible_duplicate_transfer" && err.duplicates && !duplicates) setDuplicates(err.duplicates);
      else setError(err.message);
    } finally { setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg" data-testid="trf-dialog">
        <DialogHeader>
          <DialogTitle>{t("Record a transfer", "تسجيل تحويل")}</DialogTitle>
          <DialogDescription>{t("Money moved between two of the business's own bank accounts.", "أموال انتقلت بين حسابين بنكيين للمنشأة.")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label>{t("From (money left)", "من (خرجت منه الأموال)")}</Label>
            <Select value={from} onValueChange={(v) => { setFrom(v); setDuplicates(null); }}>
              <SelectTrigger data-testid="trf-from"><SelectValue placeholder={t("Choose a bank", "اختر بنكًا")} /></SelectTrigger>
              <SelectContent>{active.map((b) => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label>{t("To (money arrived)", "إلى (وصلت إليه الأموال)")}</Label>
            <Select value={to} onValueChange={(v) => { setTo(v); setDuplicates(null); }}>
              <SelectTrigger data-testid="trf-to"><SelectValue placeholder={t("Choose a bank", "اختر بنكًا")} /></SelectTrigger>
              <SelectContent>{active.filter((b) => String(b.id) !== from).map((b) => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="grid gap-1">
              <Label>{t("Amount", "المبلغ")}</Label>
              <Input inputMode="decimal" dir="ltr" value={amount} onChange={(e) => { setAmount(e.target.value); setDuplicates(null); }} data-testid="trf-amount" />
            </div>
            <div className="grid gap-1">
              <Label>{t("Date (today if blank)", "التاريخ (اليوم إن تُرك فارغًا)")}</Label>
              <Input type="date" dir="ltr" value={date} onChange={(e) => { setDate(e.target.value); setDuplicates(null); }} data-testid="trf-date" />
            </div>
          </div>
          <div className="grid gap-1">
            <Label>{t("Reference (optional)", "المرجع (اختياري)")}</Label>
            <Input value={reference} onChange={(e) => setReference(e.target.value)} data-testid="trf-reference" />
          </div>

          {duplicates && (
            <div className="rounded-md border border-attention/40 p-3 space-y-2" data-testid="trf-duplicates">
              <p className="text-sm font-medium">{t("This looks like a transfer already in the books:", "يبدو أن هذا التحويل مسجل مسبقًا:")}</p>
              <ul className="text-sm list-disc ps-5">
                {duplicates.map((d) => (
                  <li key={`${d.kind}-${d.id}`}>
                    <span dir="ltr">{d.date}</span> · <Money v={d.amount} /> · {d.kind === "bank_transfer" ? t("recorded transfer", "تحويل مسجل") : t("bank line already posted as an own-account transfer", "سطر بنكي مُرحَّل مسبقًا كتحويل بين الحسابات")} — {d.description}
                  </li>
                ))}
              </ul>
              <Label>{t("If this is a DIFFERENT movement, say why:", "إن كانت حركة مختلفة، اذكر السبب:")}</Label>
              <Input value={confirmReason} onChange={(e) => setConfirmReason(e.target.value)} data-testid="trf-duplicate-reason" />
            </div>
          )}
          {error && <p className="text-sm text-destructive" data-testid="trf-error">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>{t("Cancel", "إلغاء")}</Button>
            <Button onClick={submit} disabled={busy || !from || !to || !(Number(amount) > 0) || (duplicates != null && !confirmReason.trim())} data-testid="trf-submit">
              {duplicates ? t("Record anyway", "سجِّل على أي حال") : t("Record transfer", "سجِّل التحويل")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ReverseDialog({ transfer, onClose, onDone }: { transfer: BankTransfer; onClose: () => void; onDone: () => void }) {
  const { t } = useLanguage();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setError(null);
    try { await reverseBankTransfer(transfer.id, { reason: reason.trim() }); onDone(); }
    catch (e) { setError(errorOf(e).message); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md" data-testid="trf-reverse-dialog">
        <DialogHeader>
          <DialogTitle>{t("Reverse this transfer", "عكس هذا التحويل")}</DialogTitle>
          <DialogDescription>
            {t("A mirror entry posts today (an open period); the transfer keeps its record and your reason. A transfer a bank line is reconciled to must have that reconciliation undone first.",
               "يُرحَّل قيد عكسي اليوم (في فترة مفتوحة)؛ ويبقى سجل التحويل مع السبب. التحويل المسوّى مع سطر بنكي يجب إلغاء تسويته أولًا.")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <p className="text-sm">{transfer.fromBankName} → {transfer.toBankName} · <Money v={transfer.amount} /></p>
          <Label>{t("Why is it being reversed?", "لماذا يُعكس؟")}</Label>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} data-testid="trf-reverse-reason" />
          {error && <p className="text-sm text-destructive" data-testid="trf-reverse-error">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>{t("Cancel", "إلغاء")}</Button>
            <Button variant="destructive" onClick={submit} disabled={busy || !reason.trim()} data-testid="trf-reverse-submit">{t("Reverse", "عكس")}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
