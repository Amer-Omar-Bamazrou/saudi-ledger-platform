import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum, fmtDate } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, BookOpen, CheckCircle, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface JELine { accountId?: number; accountName: string; description?: string; debitAmount: number; creditAmount: number; }
interface JournalEntry { id: number; entryNumber: string; date: string; description: string; reference: string; status: string; totalDebit: number; totalCredit: number; lines: JELine[]; }
interface Category { id: number; name: string; type: string; }

const STATUS_STYLES: Record<string, string> = { draft: "bg-secondary text-muted-foreground", posted: "bg-emerald-500/20 text-emerald-400", reversed: "bg-red-500/20 text-red-400" };

const emptyLine: JELine = { accountName: "", description: "", debitAmount: 0, creditAmount: 0 };

export default function JournalEntries() {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [form, setForm] = useState({ entryNumber: `JE-${Date.now().toString().slice(-6)}`, date: new Date().toISOString().split("T")[0], description: "", reference: "", notes: "" });
  const [lines, setLines] = useState<JELine[]>([{ ...emptyLine }, { ...emptyLine }]);
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: entries = [], isLoading } = useQuery<JournalEntry[]>({ queryKey: ["journal-entries"], queryFn: () => apiFetch("/journal-entries") });
  const { data: categories = [] } = useQuery<Category[]>({ queryKey: ["categories"], queryFn: () => apiFetch("/categories") });
  const selectedEntry = entries.find(e => e.id === selectedId);

  const createMut = useMutation({
    mutationFn: (body: any) => apiFetch("/journal-entries", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["journal-entries"] }); setOpen(false); toast({ title: "Journal entry created" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const postMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/journal-entries/${id}/post`, { method: "POST" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["journal-entries"] }); toast({ title: "Entry posted to ledger" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const reverseMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/journal-entries/${id}/reverse`, { method: "POST" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["journal-entries"] }); toast({ title: "Entry reversed" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const totalDebit = lines.reduce((s, l) => s + Number(l.debitAmount || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + Number(l.creditAmount || 0), 0);
  const balanced = Math.abs(totalDebit - totalCredit) < 0.01;

  const updateLine = (i: number, k: keyof JELine, v: any) => setLines(prev => prev.map((l, idx) => idx === i ? { ...l, [k]: v } : l));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">General Ledger</h1>
          <p className="text-muted-foreground text-sm mt-1">Double-entry journal entries · {entries.length} entries</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button className="gap-2"><Plus className="w-4 h-4" /> New Entry</Button></DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader><DialogTitle>New Journal Entry</DialogTitle></DialogHeader>
            <div className="grid grid-cols-3 gap-3 mt-2">
              <div><Label className="text-xs text-muted-foreground">Entry Number</Label><Input value={form.entryNumber} onChange={e=>setForm(p=>({...p,entryNumber:e.target.value}))} className="mt-1 h-8 text-sm" /></div>
              <div><Label className="text-xs text-muted-foreground">Date</Label><Input type="date" value={form.date} onChange={e=>setForm(p=>({...p,date:e.target.value}))} className="mt-1 h-8 text-sm" /></div>
              <div><Label className="text-xs text-muted-foreground">Reference</Label><Input value={form.reference} onChange={e=>setForm(p=>({...p,reference:e.target.value}))} className="mt-1 h-8 text-sm" /></div>
              <div className="col-span-3"><Label className="text-xs text-muted-foreground">Description</Label><Input value={form.description} onChange={e=>setForm(p=>({...p,description:e.target.value}))} className="mt-1 h-8 text-sm" /></div>
            </div>

            <div className="mt-4">
              <div className="flex justify-between items-center mb-2">
                <Label className="text-xs text-muted-foreground uppercase tracking-wide">Journal Lines</Label>
                <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={()=>setLines(p=>[...p,{...emptyLine}])}>+ Add Line</Button>
              </div>
              <table className="w-full text-xs">
                <thead><tr className="border-b border-border text-muted-foreground uppercase">{["Account","Description","Debit (SAR)","Credit (SAR)",""].map(h=><th key={h} className="text-left pb-1 pr-2">{h}</th>)}</tr></thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={i}>
                      <td className="pr-2 py-1">
                        <Select value={String(l.accountId??"")} onValueChange={v=>{const cat=categories.find(c=>String(c.id)===v);updateLine(i,"accountId",Number(v));updateLine(i,"accountName",cat?.name??v);}}>
                          <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="Account..." /></SelectTrigger>
                          <SelectContent>{categories.map(c=><SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}</SelectContent>
                        </Select>
                      </td>
                      <td className="pr-2 py-1"><Input value={l.description??""} onChange={e=>updateLine(i,"description",e.target.value)} className="h-7 text-xs" placeholder="Description..." /></td>
                      <td className="pr-2 py-1"><Input type="number" value={l.debitAmount||""} onChange={e=>updateLine(i,"debitAmount",Number(e.target.value))} className="h-7 text-xs text-right font-mono" /></td>
                      <td className="pr-2 py-1"><Input type="number" value={l.creditAmount||""} onChange={e=>updateLine(i,"creditAmount",Number(e.target.value))} className="h-7 text-xs text-right font-mono" /></td>
                      <td className="py-1"><Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={()=>setLines(p=>p.filter((_,idx)=>idx!==i))}><Trash2 className="w-3 h-3 text-muted-foreground" /></Button></td>
                    </tr>
                  ))}
                  <tr className="border-t border-border font-semibold">
                    <td colSpan={2} className="py-1 text-xs text-muted-foreground">Totals</td>
                    <td className={`py-1 font-mono text-xs text-right ${balanced?"text-emerald-400":"text-red-400"}`}>{fmtNum(totalDebit)}</td>
                    <td className={`py-1 font-mono text-xs text-right ${balanced?"text-emerald-400":"text-red-400"}`}>{fmtNum(totalCredit)}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
              {!balanced && <p className="text-xs text-red-400 mt-1">⚠ Entry must balance: debits ({fmtNum(totalDebit)}) ≠ credits ({fmtNum(totalCredit)})</p>}
            </div>

            <Button className="w-full mt-4" onClick={()=>createMut.mutate({...form,lines:lines.map(l=>({...l,debitAmount:String(l.debitAmount),creditAmount:String(l.creditAmount)}))})} disabled={!form.description||!balanced||createMut.isPending}>
              {createMut.isPending ? "Saving..." : "Save Journal Entry"}
            </Button>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Total Entries</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold font-mono text-primary">{entries.length}</div></CardContent></Card>
        <Card className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Posted</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold font-mono text-emerald-400">{entries.filter(e=>e.status==="posted").length}</div></CardContent></Card>
        <Card className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Drafts</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold font-mono text-amber-400">{entries.filter(e=>e.status==="draft").length}</div></CardContent></Card>
      </div>

      <div className="grid grid-cols-5 gap-4">
        <Card className="col-span-3 border-border bg-card">
          <CardContent className="pt-4">
            {isLoading ? <div className="text-muted-foreground text-sm p-4">Loading...</div> : entries.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground"><BookOpen className="w-8 h-8 mx-auto mb-3 opacity-40" /><p>No journal entries yet.</p></div>
            ) : (
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border text-muted-foreground text-xs uppercase">{["Entry #","Date","Description","Debit","Credit","Status",""].map(h=><th key={h} className="text-left pb-2 pr-3 font-medium">{h}</th>)}</tr></thead>
                <tbody>{entries.map(e=>(
                  <tr key={e.id} className={`border-b border-border/50 transition-colors cursor-pointer ${selectedId===e.id?"bg-primary/5":"hover:bg-secondary/20"}`} onClick={()=>setSelectedId(selectedId===e.id?null:e.id)}>
                    <td className="py-2 pr-3 font-mono text-xs text-primary">{e.entryNumber}</td>
                    <td className="py-2 pr-3 text-xs text-muted-foreground">{fmtDate(e.date)}</td>
                    <td className="py-2 pr-3 max-w-[140px] truncate">{e.description}</td>
                    <td className="py-2 pr-3 font-mono text-xs text-emerald-400">{fmtNum(e.totalDebit)}</td>
                    <td className="py-2 pr-3 font-mono text-xs text-red-400">{fmtNum(e.totalCredit)}</td>
                    <td className="py-2 pr-3"><Badge className={`text-xs ${STATUS_STYLES[e.status]??""}`}>{e.status}</Badge></td>
                    <td className="py-2">
                      {e.status==="draft"&&<Button variant="ghost" size="sm" className="h-6 text-xs text-emerald-400" onClick={ev=>{ev.stopPropagation();postMut.mutate(e.id);}}>Post</Button>}
                      {e.status==="posted"&&<Button variant="ghost" size="sm" className="h-6 text-xs text-muted-foreground" onClick={ev=>{ev.stopPropagation();reverseMut.mutate(e.id);}}>Reverse</Button>}
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </CardContent>
        </Card>

        <Card className="col-span-2 border-border bg-card">
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Entry Detail</CardTitle></CardHeader>
          <CardContent>
            {!selectedEntry ? <div className="text-center py-8 text-muted-foreground text-sm">Select an entry to view its lines</div> : (
              <div className="space-y-3">
                <div className="flex justify-between text-sm"><span className="text-muted-foreground">{selectedEntry.entryNumber}</span><Badge className={`text-xs ${STATUS_STYLES[selectedEntry.status]??""}`}>{selectedEntry.status}</Badge></div>
                <p className="text-xs text-foreground font-medium">{selectedEntry.description}</p>
                {selectedEntry.reference && <p className="text-xs text-muted-foreground">Ref: {selectedEntry.reference}</p>}
                <table className="w-full text-xs mt-2">
                  <thead><tr className="border-b border-border text-muted-foreground">{["Account","Dr","Cr"].map(h=><th key={h} className="text-left pb-1 pr-2">{h}</th>)}</tr></thead>
                  <tbody>{selectedEntry.lines.map((l, i) => (
                    <tr key={i} className="border-b border-border/30">
                      <td className="py-1 pr-2 text-foreground">{l.accountName}</td>
                      <td className={`py-1 pr-2 font-mono ${l.debitAmount>0?"text-emerald-400":"text-muted-foreground"}`}>{l.debitAmount>0?fmtNum(l.debitAmount):"—"}</td>
                      <td className={`py-1 font-mono ${l.creditAmount>0?"text-red-400":"text-muted-foreground"}`}>{l.creditAmount>0?fmtNum(l.creditAmount):"—"}</td>
                    </tr>
                  ))}</tbody>
                  <tfoot><tr className="font-semibold border-t border-border"><td className="py-1 text-muted-foreground">Total</td><td className="py-1 font-mono text-emerald-400">{fmtNum(selectedEntry.totalDebit)}</td><td className="py-1 font-mono text-red-400">{fmtNum(selectedEntry.totalCredit)}</td></tr></tfoot>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
