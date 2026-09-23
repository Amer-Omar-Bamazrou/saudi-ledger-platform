/**
 * PURCHASE-SIDE NOTES (Phase 11 Part 2 — B7, 2026-09-22).
 * Record: docs/product/phase-11-deep-accounting-ap-decision-pack.md §13.
 *
 * 🔴 WE RECEIVE THIS DOCUMENT; WE DO NOT ISSUE IT. The supplier made the
 * supply, so the supplier issues the note — nothing here mints an invoice
 * number in the ZATCA sense, consumes an ICV, or produces a QR. The page says
 * so, because the screen that looks most like "issue a credit note" is exactly
 * where somebody would assume otherwise.
 *
 * 🔴 CREATION GOES THROUGH `POST /bills`, the one write boundary for a bills
 * row — the same place the ceiling, the original's state and the supplier
 * inheritance are enforced. This page does not have a private creation path.
 *
 * 🔴 The DATE is the supplier's issue date, and it is the whole tax point:
 * Art. 40(6) corrects our input tax in the period the note was ISSUED, so the
 * field is asked for rather than defaulted from the original bill.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fmtNum } from "@/lib/api";
import { statusLabel } from "@/lib/statusLabel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FileMinus, Plus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { businessToday } from "@workspace/shared";
import {
  useListSupplierCreditNotes, useListBills,
  createBill, approveBill, applySupplierCreditNote, reverseSupplierAllocation,
  type SupplierCreditNote, type Bill, type BillHeaderInputDocumentType,
} from "@workspace/api-client-react";

/** What a bill still owes, from the SERVER (billPosition) — never total − paid here. */
const owes = (b: Bill) => Number(b.outstanding ?? 0);

const Money = ({ v }: { v: number }) => <span className="font-mono" dir="ltr">{fmtNum(v)}</span>;

export default function SupplierCreditNotes() {
  const { t, lang } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [applyFor, setApplyFor] = useState<SupplierCreditNote | null>(null);

  const { data, isLoading } = useListSupplierCreditNotes();
  const { data: billsPage } = useListBills({ limit: 200 });
  const bills = billsPage?.items ?? [];
  // A note adjusts a BILL (never another note) that is in the books.
  const approvedBills = bills.filter((b) => !["draft", "submitted"].includes(b.status) && b.documentType === "bill");

  // Everything a note can move: the notes, the bills it answers, the supplier's statement and the ageing.
  const invalidate = () => {
    for (const key of ["/api/supplier-credit-notes", "/api/bills", "/api/supplier-statements", "/api/vendors", "/api/reports/ap-aging"]) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
    void qc.invalidateQueries({ queryKey: ["ap-aging"] });
  };

  const approve = useMutation({
    mutationFn: (id: number) => approveBill(id, {}),
    onSuccess: () => { toast({ title: t("Note posted", "تم ترحيل الإشعار") }); invalidate(); },
    onError: (e: Error) => toast({ title: t("Refused", "مرفوض"), description: e.message, variant: "destructive" }),
  });

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-full" data-testid="page-supplier-credit-notes">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><FileMinus className="w-6 h-6" />{t("Supplier credit notes", "إشعارات الدائن من الموردين")}</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
            {t("A note your SUPPLIER issued to you. You are the customer here, so nothing is issued on your side — no invoice number is minted and no e-invoice is sent. Record the note with the date the supplier issued it: that is the period your input tax is corrected in.",
               "إشعار أصدره المورّد لك. أنت العميل هنا، فلا يصدر عنك شيء — لا يُنشأ رقم فاتورة ولا تُرسل فاتورة إلكترونية. سجّل الإشعار بتاريخ إصداره لدى المورّد: فهذه هي الفترة التي تُصحَّح فيها ضريبة المدخلات.")}
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button className="gap-2" data-testid="new-supplier-note"><Plus className="w-4 h-4" />{t("Record a note", "تسجيل إشعار")}</Button></DialogTrigger>
          <NewNoteDialog bills={approvedBills} t={t} onDone={() => { setOpen(false); invalidate(); }} />
        </Dialog>
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Notes received", "الإشعارات المستلمة")}</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          {isLoading ? <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>
           : (data?.items ?? []).length === 0 ? <p className="text-sm text-muted-foreground" data-testid="no-supplier-notes">{t("No supplier notes recorded yet.", "لم تُسجَّل إشعارات من الموردين بعد.")}</p>
           : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-muted-foreground text-xs uppercase">
                {[t("Number", "الرقم"), t("Kind", "النوع"), t("Supplier", "المورد"), t("Issued", "تاريخ الإصدار"), t("Total", "الإجمالي"), t("Left to apply", "المتبقي للتطبيق"), t("Status", "الحالة"), ""].map((h, i) => (
                  <th key={i} className="text-start pb-2 pe-3 font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {(data?.items ?? []).map((n) => (
                  <tr key={n.id} className="border-b border-border/50" data-testid={`supplier-note-row-${n.id}`}>
                    <td className="py-2 pe-3 font-mono text-xs" dir="ltr">{n.billNumber}</td>
                    <td className="py-2 pe-3">
                      <Badge variant="outline" className="text-[10px]" data-testid={`note-kind-${n.id}`}>
                        {n.documentType === "debit_note" ? t("Debit note", "إشعار مدين") : t("Credit note", "إشعار دائن")}
                      </Badge>
                    </td>
                    <td className="py-2 pe-3">{n.vendorName ?? "—"}</td>
                    <td className="py-2 pe-3 font-mono text-xs" dir="ltr">{n.date}</td>
                    <td className="py-2 pe-3"><Money v={n.total} /></td>
                    <td className="py-2 pe-3" data-testid={`note-available-${n.id}`}><Money v={n.availableAmount} /></td>
                    <td className="py-2 pe-3 text-xs" data-testid={`note-status-${n.id}`}>{statusLabel(n.status, lang)}</td>
                    <td className="py-2 whitespace-nowrap">
                      {["draft", "submitted"].includes(n.status) ? (
                        <Button size="sm" variant="secondary" onClick={() => approve.mutate(n.id)} data-testid={`approve-note-${n.id}`}>{t("Post", "ترحيل")}</Button>
                      ) : n.documentType === "credit_note" ? (
                        <Button size="sm" variant="ghost" onClick={() => setApplyFor(n)} data-testid={`apply-note-${n.id}`}>{t("Apply", "تطبيق")}</Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Dialog open={applyFor != null} onOpenChange={(v) => !v && setApplyFor(null)}>
        {applyFor && (
          <ApplyNoteDialog
            note={applyFor}
            bills={approvedBills.filter((b) => b.vendorId === applyFor.vendorId && owes(b) >= 0.01)}
            t={t}
            onDone={() => { setApplyFor(null); invalidate(); }}
          />
        )}
      </Dialog>
    </div>
  );
}

function NewNoteDialog({ bills, t, onDone }: {
  bills: Bill[]; t: (en: string, ar: string) => string; onDone: () => void;
}) {
  const { toast } = useToast();
  const [againstBillId, setAgainstBillId] = useState("");
  const [documentType, setDocumentType] = useState("credit_note");
  const [billNumber, setBillNumber] = useState("");
  const [date, setDate] = useState(businessToday());
  const [subtotal, setSubtotal] = useState("");
  const [vatAmount, setVatAmount] = useState("");

  const total = (Number(subtotal) || 0) + (Number(vatAmount) || 0);

  const create = useMutation({
    // 🔴 `POST /bills` — the one write boundary for a bills row. There is no
    // "create a credit note" endpoint, on purpose.
    mutationFn: () => createBill({
      documentType: documentType as BillHeaderInputDocumentType,
      creditNoteAgainstBillId: Number(againstBillId),
      billNumber: billNumber || undefined,
      date,
      subtotal: Number(subtotal) || 0,
      vatAmount: Number(vatAmount) || 0,
      total,
    }),
    onSuccess: () => { toast({ title: t("Note recorded as a draft", "سُجِّل الإشعار كمسودة") }); onDone(); },
    onError: (e: Error) => toast({ title: t("Refused", "مرفوض"), description: e.message, variant: "destructive" }),
  });

  return (
    <DialogContent className="max-w-xl" data-testid="new-supplier-note-dialog">
      <DialogHeader>
        <DialogTitle>{t("Record a supplier note", "تسجيل إشعار من مورد")}</DialogTitle>
        <DialogDescription>
          {t("A draft moves nothing. Posting it credits the payable and corrects the input tax — in the period of the date below, which is the supplier's issue date.",
             "المسودة لا تحرّك شيئًا. والترحيل يخفض الالتزام ويصحّح ضريبة المدخلات — في فترة التاريخ أدناه، وهو تاريخ إصدار المورّد.")}
        </DialogDescription>
      </DialogHeader>

      <div className="grid sm:grid-cols-2 gap-3">
        <div className="space-y-1 sm:col-span-2">
          <Label>{t("Against which bill?", "مقابل أي فاتورة؟")}</Label>
          <Select value={againstBillId} onValueChange={setAgainstBillId}>
            <SelectTrigger data-testid="note-against-bill"><SelectValue placeholder={t("Choose the original bill", "اختر الفاتورة الأصلية")} /></SelectTrigger>
            <SelectContent>
              {bills.map((b) => <SelectItem key={b.id} value={String(b.id)}>{b.billNumber} — {fmtNum(Number(b.total))}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>{t("Kind", "النوع")}</Label>
          <Select value={documentType} onValueChange={setDocumentType}>
            <SelectTrigger data-testid="note-kind"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="credit_note">{t("Credit note (reduces what we owe)", "إشعار دائن (يخفض ما ندين به)")}</SelectItem>
              <SelectItem value="debit_note">{t("Debit note (an extra charge)", "إشعار مدين (رسم إضافي)")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>{t("Supplier's number", "رقم المورّد")}</Label>
          <Input value={billNumber} onChange={(e) => setBillNumber(e.target.value)} data-testid="note-number" dir="ltr" />
        </div>
        <div className="space-y-1">
          <Label>{t("Issued on (the supplier's date)", "تاريخ الإصدار (تاريخ المورّد)")}</Label>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} data-testid="note-date" dir="ltr" />
        </div>
        <div className="space-y-1">
          <Label>{t("Net", "الصافي")}</Label>
          <Input type="number" step="0.01" value={subtotal} onChange={(e) => setSubtotal(e.target.value)} data-testid="note-subtotal" dir="ltr" />
        </div>
        <div className="space-y-1">
          <Label>{t("VAT", "الضريبة")}</Label>
          <Input type="number" step="0.01" value={vatAmount} onChange={(e) => setVatAmount(e.target.value)} data-testid="note-vat" dir="ltr" />
        </div>
        <div className="space-y-1">
          <Label>{t("Total", "الإجمالي")}</Label>
          <p className="font-mono text-lg" dir="ltr" data-testid="note-total">{fmtNum(total)}</p>
        </div>
      </div>

      <DialogFooter>
        <Button onClick={() => create.mutate()} disabled={create.isPending} data-testid="note-submit">
          {t("Record as draft", "تسجيل كمسودة")}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function ApplyNoteDialog({ note, bills, t, onDone }: {
  note: SupplierCreditNote; bills: Bill[]; t: (en: string, ar: string) => string; onDone: () => void;
}) {
  const { toast } = useToast();
  const [allocations, setAllocations] = useState<Record<number, string>>({});
  const [undoReason, setUndoReason] = useState("");

  const apply = useMutation({
    mutationFn: () => applySupplierCreditNote(note.id, {
      allocations: Object.entries(allocations).filter(([, v]) => Number(v) > 0)
        .map(([billId, v]) => ({ billId: Number(billId), amount: Number(v) })),
    }),
    onSuccess: () => { toast({ title: t("Applied", "طُبِّق") }); onDone(); },
    onError: (e: Error) => toast({ title: t("Refused", "مرفوض"), description: e.message, variant: "destructive" }),
  });
  /**
   * Undoing an application posts NOTHING — applying it posted nothing (the
   * note's debit has been in AP since it was posted) — so the note's balance
   * simply becomes available again and the bill owes it again. The reason is
   * the user's; the server refuses an empty one and the refusal is shown.
   */
  const undo = useMutation({
    mutationFn: (allocationId: number) => reverseSupplierAllocation(allocationId, { reason: undoReason }),
    onSuccess: () => { toast({ title: t("Application undone", "أُلغي التطبيق") }); onDone(); },
    onError: (e: Error) => toast({ title: t("Refused", "مرفوض"), description: e.message, variant: "destructive" }),
  });

  return (
    <DialogContent className="max-w-xl" data-testid="apply-note-dialog">
      <DialogHeader>
        <DialogTitle>{t("Apply", "تطبيق")} {note.billNumber}</DialogTitle>
        <DialogDescription>
          {/* 🔴 Said plainly, because it is the surprising part: nothing posts. */}
          {t("This note is already in the books — posting it moved the payable. Applying it records WHICH bills it answers, and posts nothing further.",
             "هذا الإشعار مُرحَّل بالفعل — وترحيله هو ما حرّك الالتزام. والتطبيق يسجّل الفواتير التي يقابلها، ولا يُرحِّل شيئًا إضافيًا.")}
          {" · "}
          <span data-testid="apply-available">{t("Left to apply", "المتبقي")}: <Money v={note.availableAmount} /></span>
        </DialogDescription>
      </DialogHeader>

      {bills.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="apply-no-bills">{t("This supplier has no approved bills still owing anything.", "لا توجد لهذا المورد فواتير معتمدة عليها مبالغ مستحقة.")}</p>
      ) : (
        <div className="space-y-2">
          {bills.map((b) => (
            <div key={b.id} className="flex items-center gap-3">
              <span className="font-mono text-xs w-32 shrink-0" dir="ltr">{b.billNumber}</span>
              <span className="text-xs text-muted-foreground w-28 shrink-0" title={t("Still owed", "المتبقي")}><Money v={owes(b)} /></span>
              <Input
                type="number" step="0.01" placeholder="0.00" dir="ltr"
                value={allocations[b.id] ?? ""}
                onChange={(e) => setAllocations((a) => ({ ...a, [b.id]: e.target.value }))}
                data-testid={`apply-to-${b.billNumber}`}
              />
            </div>
          ))}
        </div>
      )}

      {note.applications.length > 0 && (
        <div className="text-xs text-muted-foreground space-y-1">
          <p className="font-medium">{t("Already applied to", "مطبَّق بالفعل على")}</p>
          {note.applications.map((a) => (
            <div key={a.id} className="flex items-center gap-2" data-testid={`note-application-${a.id}`}>
              <span>{a.billNumber} · <Money v={a.amount} />{a.reversed ? ` · ${t("reversed", "معكوس")}` : ""}</span>
              {!a.reversed && (
                <Button size="sm" variant="ghost" className="h-6 text-xs" disabled={undo.isPending}
                  onClick={() => undo.mutate(a.id)} data-testid={`undo-application-${a.id}`}>{t("Undo", "تراجع")}</Button>
              )}
            </div>
          ))}
          {note.applications.some((a) => !a.reversed) && (
            <Input
              placeholder={t("Why is it being undone?", "لماذا يجري التراجع؟")}
              value={undoReason} onChange={(e) => setUndoReason(e.target.value)} data-testid="undo-application-reason"
            />
          )}
        </div>
      )}

      <DialogFooter>
        <Button onClick={() => apply.mutate()} disabled={apply.isPending || bills.length === 0} data-testid="apply-submit">
          {t("Apply", "تطبيق")}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
