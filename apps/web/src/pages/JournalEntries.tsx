import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, BookOpen, CheckCircle, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { DualDate } from "@/components/DualDate";
import { FilterScope } from "@/components/FilterScope";
import { JOURNAL_ENTRY_FILTERS, initialStatusFilter, syncStatusToUrl } from "@/lib/listFilters";

import type { Category, CreateJournalEntryInput, JournalEntry, JournalEntryLineInput, ListJournalEntries200 } from "@workspace/api-client-react";

/** Request bodies go through the GENERATED input types (contract batch 4): a request the server does not accept is a compile error here. */
const json = { create: (b: CreateJournalEntryInput) => JSON.stringify(b) };
/** A line being typed: the generated line input with the account not yet chosen — the server refuses a line without one. */
type LineForm = Omit<JournalEntryLineInput, "accountId"> & { accountId?: number };
const JE_PAGE_SIZE = 50;



const STATUS_STYLES: Record<string, string> = { draft: "bg-secondary text-muted-foreground", posted: "bg-positive-surface/20 text-positive", reversed: "bg-negative-surface/20 text-negative" };

const emptyLine: LineForm = { accountName: "", description: "", debitAmount: 0, creditAmount: 0 };

export default function JournalEntries() {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  /** Two-step delete: the second click is the confirmation (draft only). */
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [form, setForm] = useState({ entryNumber: "", date: new Date().toISOString().split("T")[0], description: "", reference: "", notes: "" });
  const [lines, setLines] = useState<LineForm[]>([{ ...emptyLine }, { ...emptyLine }]);
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t, lang } = useLanguage();
  /**
   * 🔴 This page had NO status filter, while the API had accepted `status`
   * all along — the honest-message shape: nothing here was untrue, a
   * capability simply never surfaced. Three nav entries now point at it
   * (Drafts, Posted, Reversed). There is deliberately no "Pending Approval":
   * a journal entry has no `submitted` state, so that chip would have
   * returned a permanently empty set.
   */
  const [statusFilter, setStatusFilter] = useState(() => initialStatusFilter(JOURNAL_ENTRY_FILTERS));
  const applyFilter = (v: string) => { setStatusFilter(v); setPage(0); syncStatusToUrl(v); };

  /** A PAGE plus the set-wide count — see the note on Invoices.tsx. */
  const { data: jePage, isLoading } = useQuery<ListJournalEntries200>({
    queryKey: ["journal-entries", statusFilter, page],
    queryFn: () =>
      apiFetch(
        `/journal-entries?limit=${JE_PAGE_SIZE}&offset=${page * JE_PAGE_SIZE}` +
          (statusFilter !== "all" ? `&status=${statusFilter}` : ""),
      ),
  });
  const entries = jePage?.items ?? [];
  const jePageInfo = jePage?.page;
  const { data: categories = [] } = useQuery<Category[]>({ queryKey: ["categories"], queryFn: () => apiFetch("/categories") });
  /**
   * 🔴 The detail panel FETCHES the entry (contract batch 4). It used to read
   * `lines` from the LIST row, and list rows carry no lines — so the panel
   * showed an entry with an empty line table and zero totals, for every entry.
   */
  const { data: selectedEntry } = useQuery<JournalEntry>({
    queryKey: ["journal-entries", "detail", selectedId],
    queryFn: () => apiFetch(`/journal-entries/${selectedId}`),
    enabled: selectedId !== null,
  });

  const createMut = useMutation({
    mutationFn: (body: CreateJournalEntryInput) => apiFetch("/journal-entries", { method: "POST", body: json.create(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["journal-entries"] }); setOpen(false); toast({ title: t("Journal entry created", "تم إنشاء قيد اليومية") }); },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/journal-entries/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["journal-entries"] });
      setConfirmDelete(null);
      toast({ title: t("Draft deleted", "تم حذف المسودة") });
    },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" }),
  });

  const postMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/journal-entries/${id}/post`, { method: "POST" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["journal-entries"] }); toast({ title: t("Entry posted to ledger", "تم ترحيل القيد إلى دفتر الأستاذ") }); },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" }),
  });

  const reverseMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/journal-entries/${id}/reverse`, { method: "POST" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["journal-entries"] }); toast({ title: t("Entry reversed", "تم عكس القيد") }); },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" }),
  });

  const totalDebit = lines.reduce((s, l) => s + Number(l.debitAmount || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + Number(l.creditAmount || 0), 0);
  const balanced = Math.abs(totalDebit - totalCredit) < 0.01;

  const updateLine = (i: number, k: keyof LineForm, v: any) => setLines(prev => prev.map((l, idx) => idx === i ? { ...l, [k]: v } : l));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("General Ledger", "دفتر الأستاذ العام")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("Double-entry journal entries", "قيود اليومية ذات القيد المزدوج")} · {entries.length} {t("entries", "قيود")}</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button className="gap-2"><Plus className="w-4 h-4" /> {t("New Entry", "قيد جديد")}</Button></DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader><DialogTitle>{t("New Journal Entry", "قيد يومية جديد")}</DialogTitle></DialogHeader>
            <div className="grid grid-cols-3 gap-3 mt-2">
              <div><Label className="text-xs text-muted-foreground">{t("Entry Number", "رقم القيد")}</Label><Input value={form.entryNumber} onChange={e=>setForm(p=>({...p,entryNumber:e.target.value}))} className="mt-1 h-8 text-sm" /></div>
              <div><Label className="text-xs text-muted-foreground">{t("Date", "التاريخ")}</Label><Input type="date" value={form.date} onChange={e=>setForm(p=>({...p,date:e.target.value}))} className="mt-1 h-8 text-sm" /></div>
              <div><Label className="text-xs text-muted-foreground">{t("Reference", "المرجع")}</Label><Input value={form.reference} onChange={e=>setForm(p=>({...p,reference:e.target.value}))} className="mt-1 h-8 text-sm" /></div>
              <div className="col-span-3"><Label className="text-xs text-muted-foreground">{t("Description", "الوصف")}</Label><Input value={form.description} onChange={e=>setForm(p=>({...p,description:e.target.value}))} className="mt-1 h-8 text-sm" /></div>
            </div>

            <div className="mt-4">
              <div className="flex justify-between items-center mb-2">
                <Label className="text-xs text-muted-foreground uppercase tracking-wide">{t("Journal Lines", "سطور القيد")}</Label>
                <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={()=>setLines(p=>[...p,{...emptyLine}])}>+ {t("Add Line", "إضافة سطر")}</Button>
              </div>
              <div className="overflow-x-auto"><table className="w-full text-xs">
                <thead><tr className="border-b border-border text-muted-foreground uppercase">{[
                  t("Account", "الحساب"),
                  t("Description", "الوصف"),
                  t("Debit (SAR)", "مدين (ر.س)"),
                  t("Credit (SAR)", "دائن (ر.س)"),
                  "",
                ].map(h=><th key={h} className="text-start pb-1 pe-2">{h}</th>)}</tr></thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={i}>
                      <td className="pe-2 py-1">
                        <Select value={String(l.accountId??"")} onValueChange={v=>{const cat=categories.find(c=>String(c.id)===v);updateLine(i,"accountId",Number(v));updateLine(i,"accountName",cat?.name??v);}}>
                          <SelectTrigger className="h-7 text-xs"><SelectValue placeholder={t("Account...", "الحساب...")} /></SelectTrigger>
                          <SelectContent>{categories.map(c=><SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}</SelectContent>
                        </Select>
                      </td>
                      <td className="pe-2 py-1"><Input value={l.description??""} onChange={e=>updateLine(i,"description",e.target.value)} className="h-7 text-xs" placeholder={t("Description...", "الوصف...")} /></td>
                      <td className="pe-2 py-1"><Input type="number" value={l.debitAmount||""} onChange={e=>updateLine(i,"debitAmount",Number(e.target.value))} className="h-7 text-xs text-end font-mono" /></td>
                      <td className="pe-2 py-1"><Input type="number" value={l.creditAmount||""} onChange={e=>updateLine(i,"creditAmount",Number(e.target.value))} className="h-7 text-xs text-end font-mono" /></td>
                      <td className="py-1"><Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={()=>setLines(p=>p.filter((_,idx)=>idx!==i))}><Trash2 className="w-3 h-3 text-muted-foreground" /></Button></td>
                    </tr>
                  ))}
                  <tr className="border-t border-border font-semibold">
                    <td colSpan={2} className="py-1 text-xs text-muted-foreground">{t("Totals", "الإجماليات")}</td>
                    <td className={`py-1 font-mono text-xs text-end ${balanced?"text-positive":"text-negative"}`}>{fmtNum(totalDebit)}</td>
                    <td className={`py-1 font-mono text-xs text-end ${balanced?"text-positive":"text-negative"}`}>{fmtNum(totalCredit)}</td>
                    <td />
                  </tr>
                </tbody>
              </table></div>
              {!balanced && <p className="text-xs text-negative mt-1">⚠ {t("Entry must balance: debits", "يجب أن يكون القيد متوازناً: المدين")} ({fmtNum(totalDebit)}) ≠ {t("credits", "الدائن")} ({fmtNum(totalCredit)})</p>}

            {/*
              🔴 The page says what it is showing and of how many, and gives a
              way to the rest. A list that silently stops at 50 is the same
              defect as a count that saturates at 200 — the number describes a
              set the reader does not think they are looking at (B-6).
            */}
            {jePageInfo && jePageInfo.total > 0 && (
              <div className="flex items-center justify-between pt-3 text-sm text-muted-foreground">
                <span>
                  {t(
                    `Showing ${jePageInfo.offset + 1}–${Math.min(jePageInfo.offset + entries.length, jePageInfo.total)} of ${jePageInfo.total}`,
                    `عرض ${jePageInfo.offset + 1}–${Math.min(jePageInfo.offset + entries.length, jePageInfo.total)} من ${jePageInfo.total}`,
                  )}
                </span>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                    {t("Previous", "السابق")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={jePageInfo.offset + entries.length >= jePageInfo.total}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    {t("Next", "التالي")}
                  </Button>
                </div>
              </div>
            )}
            </div>

            <Button className="w-full mt-4" onClick={()=>createMut.mutate({ ...form, lines: lines.map(l => ({ ...l, accountId: l.accountId as number, debitAmount: Number(l.debitAmount), creditAmount: Number(l.creditAmount) })) })} disabled={!form.description||!balanced||createMut.isPending}>
              {createMut.isPending ? t("Saving...", "جارٍ الحفظ...") : t("Save Journal Entry", "حفظ قيد اليومية")}
            </Button>
          </DialogContent>
        </Dialog>
      </div>

      {/*
        🔴 THESE COUNTS USED TO DESCRIBE THE PAGE AND CLAIM TO DESCRIBE THE SET.
        All three were computed from `entries` — one fetched page of 50 — so
        "Total Entries" read 50 on an org with 4,000, and "Posted" counted the
        posted rows that happened to be on screen. That is the volume defect
        exactly: a count taken from a capped list, invisible to every fixture we
        own because our fixtures are smaller than the cap.

        Adding a status filter would have made it worse (the counts would then
        describe the filtered page), so they are replaced rather than carried
        forward: ONE figure, the server's total for the set actually being
        shown. The per-status breakdown is not re-derived here — the chips below
        answer that question by asking the server, which is the only place the
        real count exists.
      */}
      <div className="grid grid-cols-3 gap-4">
        <Card className="border-border bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">{t("Entries", "القيود")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono text-primary">
              {jePageInfo ? jePageInfo.total.toLocaleString() : "—"}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="border-border bg-card">
        <CardHeader className="pb-3">
          <div className="flex gap-2 flex-wrap">
            {JOURNAL_ENTRY_FILTERS.map(o => (
              <Button key={o.value} variant={statusFilter === o.value ? "default" : "ghost"} size="sm"
                className="h-7 text-xs" onClick={() => applyFilter(o.value)}>
                {lang === "ar" ? o.labelAr : o.label}
              </Button>
            ))}
          </div>
          <div className="mt-3">
            <FilterScope options={JOURNAL_ENTRY_FILTERS} value={statusFilter} total={jePageInfo?.total} onClear={() => applyFilter("all")} />
          </div>
        </CardHeader>
      </Card>

      <div className="grid grid-cols-5 gap-4">
        <Card className="col-span-3 border-border bg-card">
          <CardContent className="pt-4">
            {isLoading ? <div className="text-muted-foreground text-sm p-4">{t("Loading...", "جارٍ التحميل...")}</div> : entries.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground"><BookOpen className="w-8 h-8 mx-auto mb-3 opacity-40" /><p>{t("No journal entries yet.", "لا توجد قيود يومية بعد.")}</p></div>
            ) : (
              <div className="overflow-x-auto"><table className="w-full text-sm">
                <thead><tr className="border-b border-border text-muted-foreground text-xs uppercase">{[
                  t("Entry #", "رقم القيد"),
                  t("Date", "التاريخ"),
                  t("Description", "الوصف"),
                  t("Debit", "مدين"),
                  t("Credit", "دائن"),
                  t("Status", "الحالة"),
                  "",
                ].map(h=><th key={h} className="text-start pb-2 pe-3 font-medium">{h}</th>)}</tr></thead>
                <tbody>{entries.map(e=>(
                  <tr key={e.id} className={`border-b border-border/50 transition-colors cursor-pointer ${selectedId===e.id?"bg-primary/5":"hover:bg-secondary/20"}`} onClick={()=>setSelectedId(selectedId===e.id?null:e.id)}>
                    <td className="py-2 pe-3 font-mono text-xs text-primary">{e.entryNumber}</td>
                    <td className="py-2 pe-3 text-xs text-muted-foreground"><DualDate date={e.date} /></td>
                    <td className="py-2 pe-3 max-w-[140px] truncate">{e.description}</td>
                    <td className="py-2 pe-3 font-mono text-xs text-positive">{fmtNum(e.totalDebit)}</td>
                    <td className="py-2 pe-3 font-mono text-xs text-negative">{fmtNum(e.totalCredit)}</td>
                    <td className="py-2 pe-3"><Badge className={`text-xs ${STATUS_STYLES[e.status]??""}`}>{e.status}</Badge></td>
                    <td className="py-2">
                      {e.status==="draft"&&<Button variant="ghost" size="sm" className="h-6 text-xs text-positive" onClick={ev=>{ev.stopPropagation();postMut.mutate(e.id);}}>{t("Post", "ترحيل")}</Button>}
                      {/* 🔴 AUD-12: draft-only delete. `DELETE /journal-entries/:id`
                          existed with no caller, so a mistyped draft entry could not
                          be removed. A POSTED entry is corrected by a reversing
                          entry — the service refuses it and says so. */}
                      {e.status==="draft"&&<Button variant="ghost" size="sm" className="h-6 text-xs text-negative" onClick={ev=>{ev.stopPropagation();if(confirmDelete!==e.id){setConfirmDelete(e.id);}else{deleteMut.mutate(e.id);}}}>{confirmDelete===e.id?t("Confirm delete", "تأكيد الحذف"):t("Delete", "حذف")}</Button>}
                      {e.status==="posted"&&<Button variant="ghost" size="sm" className="h-6 text-xs text-muted-foreground" onClick={ev=>{ev.stopPropagation();reverseMut.mutate(e.id);}}>{t("Reverse", "عكس")}</Button>}
                    </td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </CardContent>
        </Card>

        <Card className="col-span-2 border-border bg-card">
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Entry Detail", "تفاصيل القيد")}</CardTitle></CardHeader>
          <CardContent>
            {!selectedEntry ? <div className="text-center py-8 text-muted-foreground text-sm">{t("Select an entry to view its lines", "اختر قيداً لعرض سطوره")}</div> : (
              <div className="space-y-3">
                <div className="flex justify-between text-sm"><span className="text-muted-foreground">{selectedEntry.entryNumber}</span><Badge className={`text-xs ${STATUS_STYLES[selectedEntry.status]??""}`}>{selectedEntry.status}</Badge></div>
                <p className="text-xs text-foreground font-medium">{selectedEntry.description}</p>
                {selectedEntry.reference && <p className="text-xs text-muted-foreground">{t("Ref:", "المرجع:")} {selectedEntry.reference}</p>}
                <div className="overflow-x-auto"><table className="w-full text-xs mt-2">
                  <thead><tr className="border-b border-border text-muted-foreground">{[
                    t("Account", "الحساب"),
                    t("Dr", "مدين"),
                    t("Cr", "دائن"),
                  ].map(h=><th key={h} className="text-start pb-1 pe-2">{h}</th>)}</tr></thead>
                  <tbody>{selectedEntry.lines.map((l, i) => (
                    <tr key={i} className="border-b border-border/30">
                      <td className="py-1 pe-2 text-foreground">{l.accountName}</td>
                      <td className={`py-1 pe-2 font-mono ${l.debitAmount>0?"text-positive":"text-muted-foreground"}`}>{l.debitAmount>0?fmtNum(l.debitAmount):"—"}</td>
                      <td className={`py-1 font-mono ${l.creditAmount>0?"text-negative":"text-muted-foreground"}`}>{l.creditAmount>0?fmtNum(l.creditAmount):"—"}</td>
                    </tr>
                  ))}</tbody>
                  <tfoot><tr className="font-semibold border-t border-border"><td className="py-1 text-muted-foreground">{t("Total", "الإجمالي")}</td><td className="py-1 font-mono text-positive">{fmtNum(selectedEntry.totalDebit)}</td><td className="py-1 font-mono text-negative">{fmtNum(selectedEntry.totalCredit)}</td></tr></tfoot>
                </table></div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
