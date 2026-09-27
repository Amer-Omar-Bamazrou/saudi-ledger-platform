/**
 * ACCRUALS AND PREPAYMENTS (Phase 11 A2/A3, 2026-09-22).
 * Record: docs/product/phase-11-deep-accounting-ap-decision-pack.md §2, §3.
 *
 * 🔴 The page says which liability an accrual is, because the distinction is
 * the whole accounting decision. IAS 37.11: a trade payable has been INVOICED;
 * an accrual has not. So an accrual never sits in Accounts Payable, and the
 * form refuses it there rather than letting a payable appear in a supplier's
 * balance that no statement can match.
 *
 * 🔴 Recognised and remaining are the SERVER's derived figures, from the posted
 * rows. Nothing on this page adds up a schedule itself.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CalendarClock, Plus, Play, Ban, CheckCircle2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { businessToday } from "@workspace/shared";
import type { RecognitionSchedule, RecognitionScheduleDetail } from "@workspace/api-client-react";

type Category = { id: number; name: string; nameAr: string | null; type: string; systemCode: string | null; isPosting?: boolean };

const Money = ({ v }: { v: number }) => <span className="font-mono" dir="ltr">{fmtNum(v)}</span>;

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-secondary text-muted-foreground",
  active: "bg-positive-surface/20 text-positive",
  completed: "bg-secondary text-muted-foreground",
  cancelled: "bg-negative-surface/20 text-negative",
};

export default function RecognitionSchedules() {
  const { t, lang } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);

  const { data, isLoading } = useQuery<{ items: RecognitionSchedule[] }>({
    queryKey: ["recognition-schedules"],
    queryFn: () => apiFetch("/recognition-schedules"),
  });
  // 🔴 `/categories` answers a BARE ARRAY, not `{ items }` — the same shape
  // every other page reads. Assuming the envelope gave an empty account list
  // and a select with nothing in it, which reads as "no accounts exist".
  const { data: cats = [] } = useQuery<Category[]>({ queryKey: ["categories", "all"], queryFn: () => apiFetch("/categories") });
  const { data: detail } = useQuery<RecognitionScheduleDetail>({
    queryKey: ["recognition-schedules", detailId],
    queryFn: () => apiFetch(`/recognition-schedules/${detailId}`),
    enabled: detailId != null,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["recognition-schedules"] });
  };
  const act = useMutation({
    mutationFn: ({ id, what, body }: { id: number; what: string; body?: unknown }) =>
      apiFetch(`/recognition-schedules/${id}/${what}`, { method: "POST", body: JSON.stringify(body ?? {}) }),
    onSuccess: (_d, v) => { invalidate(); toast({ title: t(`Done: ${v.what}`, "تم") }); },
    onError: (e: Error) => toast({ title: t("Refused", "مرفوض"), description: e.message, variant: "destructive" }),
  });

  const all = cats;
  const expenses = all.filter((c) => c.type === "expense" && c.isPosting !== false);
  const liabilities = all.filter((c) => c.type === "liability" && c.isPosting !== false && c.systemCode !== "AP");
  const assets = all.filter((c) => c.type === "asset" && c.isPosting !== false);
  const name = (c: Category) => (lang === "ar" && c.nameAr ? c.nameAr : c.name);

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-full" data-testid="page-recognition-schedules">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><CalendarClock className="w-6 h-6" />{t("Accruals & prepayments", "المستحقات والمصروفات المدفوعة مقدمًا")}</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
            {t("An ACCRUAL is an expense you have incurred and not yet been invoiced for — it credits accrued liabilities, never Accounts Payable, because AP is the invoiced payable your supplier's statement shows (IAS 37.11). A PREPAYMENT is value you paid for in advance: the asset already exists, and the schedule releases it to expense month by month.",
               "المستحق مصروف تحمّلته ولم تُفاتَر به بعد — ويُقيَّد في المصروفات المستحقة لا في الذمم الدائنة، لأن الذمم الدائنة هي الالتزام المُفاتَر الذي يُظهره كشف المورّد (المعيار 37 فقرة 11). أما المدفوع مقدمًا فقيمة سددتها سلفًا: الأصل قائم فعلًا، ويطلقه الجدول إلى المصروف شهرًا بشهر.")}
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button className="gap-2" data-testid="new-schedule"><Plus className="w-4 h-4" />{t("New schedule", "جدول جديد")}</Button></DialogTrigger>
          <NewScheduleDialog
            expenses={expenses} liabilities={liabilities} assets={assets} name={name} t={t}
            onDone={() => { setOpen(false); invalidate(); }}
          />
        </Dialog>
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Schedules", "الجداول")}</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          {isLoading ? <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>
           : (data?.items ?? []).length === 0 ? <p className="text-sm text-muted-foreground" data-testid="no-schedules">{t("No accruals or prepayments yet.", "لا توجد مستحقات أو مدفوعات مقدمة بعد.")}</p>
           : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-muted-foreground text-xs uppercase">
                {[t("Reference", "المرجع"), t("Kind", "النوع"), t("Description", "الوصف"), t("Total", "الإجمالي"), t("Recognised", "المعترف به"), t("Remaining", "المتبقي"), t("Next", "التالي"), t("Status", "الحالة"), ""].map((h, i) => (
                  <th key={i} className="text-start pb-2 pe-3 font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {(data?.items ?? []).map((s) => (
                  <tr key={s.id} className="border-b border-border/50" data-testid={`schedule-row-${s.reference}`}>
                    <td className="py-2 pe-3">
                      <button className="font-mono text-primary hover:underline" dir="ltr" onClick={() => setDetailId(s.id)} data-testid={`open-schedule-${s.reference}`}>{s.reference}</button>
                    </td>
                    <td className="py-2 pe-3">
                      <Badge variant="outline" className="text-[10px]" data-testid={`kind-${s.reference}`}>
                        {s.kind === "accrual" ? t("Accrual", "مستحق") : t("Prepayment", "مدفوع مقدمًا")}
                      </Badge>
                    </td>
                    <td className="py-2 pe-3">{s.description}</td>
                    <td className="py-2 pe-3 text-end"><Money v={s.totalAmount} /></td>
                    <td className="py-2 pe-3 text-end" data-testid={`recognised-${s.reference}`}><Money v={s.recognisedAmount} /></td>
                    <td className="py-2 pe-3 text-end font-semibold"><Money v={s.remainingAmount} /></td>
                    <td className="py-2 pe-3 font-mono text-xs" dir="ltr">{s.nextPeriod ?? "—"}</td>
                    <td className="py-2 pe-3"><Badge className={`text-xs ${STATUS_STYLES[s.status] ?? ""}`} data-testid={`status-${s.reference}`}>{s.status}</Badge></td>
                    <td className="py-2">
                      <div className="flex gap-1">
                        {s.status === "draft" && (
                          <Button size="sm" variant="outline" className="h-7 text-xs" data-testid={`activate-${s.reference}`}
                            onClick={() => act.mutate({ id: s.id, what: "activate" })}><Play className="w-3 h-3 me-1" />{t("Activate", "تفعيل")}</Button>
                        )}
                        {s.status === "active" && (
                          <>
                            <Button size="sm" className="h-7 text-xs" data-testid={`recognise-${s.reference}`}
                              onClick={() => act.mutate({ id: s.id, what: "recognise" })}><CheckCircle2 className="w-3 h-3 me-1" />{t("Recognise", "اعتراف")}</Button>
                            <CancelButton onCancel={(reason) => act.mutate({ id: s.id, what: "cancel", body: { reason } })} reference={s.reference} t={t} />
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {detailId != null && detail && (
        <Dialog open onOpenChange={(o) => { if (!o) setDetailId(null); }}>
          <DialogContent data-testid="schedule-detail">
            <DialogHeader>
              <DialogTitle>{detail.reference} — {detail.description}</DialogTitle>
              <DialogDescription>
                {t(`${detail.periods} period(s) from ${detail.startPeriod}. Recognised ${fmtNum(detail.recognisedAmount)} of ${fmtNum(detail.totalAmount)}.`,
                   `${detail.periods} فترة ابتداءً من ${detail.startPeriod}. تم الاعتراف بـ ${fmtNum(detail.recognisedAmount)} من ${fmtNum(detail.totalAmount)}.`)}
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-80 overflow-y-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {[t("Period", "الفترة"), t("Amount", "المبلغ"), t("Entry", "القيد")].map((h, i) => <th key={i} className="text-start pb-2 pe-3 font-medium">{h}</th>)}
                </tr></thead>
                <tbody>
                  {detail.rows.map((r) => (
                    <tr key={r.id} className="border-b border-border/50" data-testid={`period-${r.period}`}>
                      <td className="py-1.5 pe-3 font-mono" dir="ltr">{r.period}</td>
                      <td className="py-1.5 pe-3 text-end"><Money v={r.amount} /></td>
                      <td className="py-1.5 pe-3 text-xs">
                        {r.journalEntryId == null
                          ? <span className="text-muted-foreground">{t("planned", "مخطط")}</span>
                          : <span className="font-mono text-positive" dir="ltr">#{r.journalEntryId}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {detail.cancelReason && (
              <p className="text-xs text-muted-foreground">{t("Cancelled:", "أُلغي:")} {detail.cancelReason}</p>
            )}
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function CancelButton({ onCancel, reference, t }: { onCancel: (reason: string) => void; reference: string; t: (en: string, ar: string) => string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" className="h-7 text-xs" data-testid={`cancel-${reference}`}><Ban className="w-3 h-3 me-1" />{t("Stop", "إيقاف")}</Button>
      </DialogTrigger>
      <DialogContent data-testid="cancel-dialog">
        <DialogHeader>
          <DialogTitle>{t("Stop the remaining periods", "إيقاف الفترات المتبقية")}</DialogTitle>
          <DialogDescription>
            {t("The periods already recognised stay in the books — this stops the future only. To undo a period that has posted, reverse its journal entry.",
               "تبقى الفترات المعترف بها في الدفاتر — وهذا يوقف المستقبل فقط. ولعكس فترة مُرحَّلة، اعكس قيدها.")}
          </DialogDescription>
        </DialogHeader>
        <Label className="text-xs">{t("Why", "السبب")}</Label>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} data-testid="cancel-reason" />
        <Button disabled={reason.trim() === ""} data-testid="cancel-submit" onClick={() => { onCancel(reason); setOpen(false); }}>
          {t("Stop the schedule", "إيقاف الجدول")}
        </Button>
      </DialogContent>
    </Dialog>
  );
}

function NewScheduleDialog({ expenses, liabilities, assets, name, t, onDone }: {
  expenses: Category[]; liabilities: Category[]; assets: Category[];
  name: (c: Category) => string; t: (en: string, ar: string) => string; onDone: () => void;
}) {
  const { toast } = useToast();
  const [kind, setKind] = useState("accrual");
  const [form, setForm] = useState({ reference: "", description: "", totalAmount: "", periods: "3", startPeriod: businessToday().slice(0, 7), expenseAccountId: "", balanceAccountId: "" });
  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));
  // 🔴 The balance account offered depends on the KIND, and AP is filtered out
  // of the accrual list entirely — the server refuses it, so offering it would
  // be a control that leads to a refusal.
  const balanceOptions = kind === "accrual" ? liabilities : assets;

  const create = useMutation({
    mutationFn: (body: unknown) => apiFetch("/recognition-schedules", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => { toast({ title: t("Schedule created", "تم إنشاء الجدول") }); onDone(); },
    onError: (e: Error) => toast({ title: t("Not created", "لم يُنشأ"), description: e.message, variant: "destructive" }),
  });

  return (
    <DialogContent data-testid="new-schedule-dialog">
      <DialogHeader>
        <DialogTitle>{t("New accrual or prepayment", "مستحق أو مدفوع مقدمًا جديد")}</DialogTitle>
        <DialogDescription>
          {t("Nothing posts until you activate it, and a draft moves nothing in any report.", "لا يُرحَّل شيء حتى التفعيل، والمسودة لا تحرّك شيئًا في أي تقرير.")}
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-3">
        <div>
          <Label className="text-xs">{t("Kind", "النوع")}</Label>
          <Select value={kind} onValueChange={(v) => { setKind(v); set("balanceAccountId", ""); }}>
            <SelectTrigger data-testid="schedule-kind"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="accrual">{t("Accrual — incurred, not yet invoiced", "مستحق — تحمّلته ولم تُفاتَر به")}</SelectItem>
              <SelectItem value="prepayment">{t("Prepayment — paid before the benefit", "مدفوع مقدمًا — سُدد قبل المنفعة")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div><Label className="text-xs">{t("Reference", "المرجع")}</Label><Input value={form.reference} onChange={(e) => set("reference", e.target.value)} data-testid="schedule-reference" dir="ltr" /></div>
        <div><Label className="text-xs">{t("Description *", "الوصف *")}</Label><Input value={form.description} onChange={(e) => set("description", e.target.value)} data-testid="schedule-description" /></div>
        <div className="grid grid-cols-3 gap-2">
          <div><Label className="text-xs">{t("Total *", "الإجمالي *")}</Label><Input value={form.totalAmount} onChange={(e) => set("totalAmount", e.target.value)} data-testid="schedule-total" dir="ltr" /></div>
          <div><Label className="text-xs">{t("Periods *", "عدد الفترات *")}</Label><Input value={form.periods} onChange={(e) => set("periods", e.target.value)} data-testid="schedule-periods" dir="ltr" /></div>
          <div><Label className="text-xs">{t("From *", "من *")}</Label><Input value={form.startPeriod} onChange={(e) => set("startPeriod", e.target.value)} data-testid="schedule-start" dir="ltr" placeholder="YYYY-MM" /></div>
        </div>
        <div>
          <Label className="text-xs">{t("Expense account *", "حساب المصروف *")}</Label>
          <Select value={form.expenseAccountId} onValueChange={(v) => set("expenseAccountId", v)}>
            <SelectTrigger data-testid="schedule-expense"><SelectValue placeholder={t("Choose", "اختر")} /></SelectTrigger>
            <SelectContent>{expenses.map((c) => <SelectItem key={c.id} value={String(c.id)}>{name(c)}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">{kind === "accrual" ? t("Accrued liability account *", "حساب المصروف المستحق *") : t("Prepaid asset account *", "حساب المدفوع مقدمًا *")}</Label>
          <Select value={form.balanceAccountId} onValueChange={(v) => set("balanceAccountId", v)}>
            <SelectTrigger data-testid="schedule-balance"><SelectValue placeholder={t("Choose", "اختر")} /></SelectTrigger>
            <SelectContent>{balanceOptions.map((c) => <SelectItem key={c.id} value={String(c.id)}>{name(c)}</SelectItem>)}</SelectContent>
          </Select>
          {kind === "accrual" && (
            <p className="text-[11px] text-muted-foreground mt-1">
              {t("Accounts Payable is not offered: it is the INVOICED payable your supplier's statement shows (IAS 37.11), and an accrual has no invoice.",
                 "لا تُعرض الذمم الدائنة: فهي الالتزام المُفاتَر الذي يظهر في كشف المورّد (المعيار 37 فقرة 11)، والمستحق لا فاتورة له.")}
            </p>
          )}
        </div>
        <Button
          data-testid="schedule-submit"
          disabled={create.isPending}
          onClick={() => create.mutate({
            kind, reference: form.reference.trim() || undefined, description: form.description,
            totalAmount: Number(form.totalAmount), periods: Number(form.periods), startPeriod: form.startPeriod,
            expenseAccountId: Number(form.expenseAccountId), balanceAccountId: Number(form.balanceAccountId),
          })}
        >
          {t("Create as draft", "إنشاء كمسودة")}
        </Button>
      </div>
    </DialogContent>
  );
}
