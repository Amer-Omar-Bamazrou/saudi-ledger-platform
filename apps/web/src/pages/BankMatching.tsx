/**
 * Bank matching (Batch 1B Phase D → F, 2026-09-17).
 *
 * A statement row is a bank movement; a receipt or refund is the accounting
 * event; a MATCH links them. The server classifies every row and this page
 * shows the classification WITH its evidence — never a guess dressed as a
 * fact:
 *
 *   DETERMINISTIC  one candidate, identified by a reference in the narrative,
 *                  same bank / direction / exact amount / date window — the
 *                  user still clicks to record it (§9: suggestions are
 *                  pre-selected, the human clicks).
 *   AMBIGUOUS      candidates exist but nothing identifies one; the reason
 *                  says why, and an authorised user may match by hand with a
 *                  reason that is kept as the audit trail.
 *   UNMATCHED      no candidate at all in the window.
 *   INCONSISTENT   the narrative names a payment that fails another clause;
 *                  the conflict is shown so a human can say which fact is wrong.
 *   MATCHED        an active match exists (or the receipt was created from
 *                  this row); it can be superseded by an unmatch, never deleted.
 *
 * 🔴 The scope of every act is named before it happens: "Accept" records the
 * deterministic matches for ONE bank on ONE date, and says how many that is.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowDownLeft, ArrowUpRight, ChevronDown, ChevronUp, ListChecks } from "lucide-react";
import { DualDate } from "@/components/DualDate";
import { BankName, PermissionHint, invalidatePaymentQueries, newIdempotencyKey, receiptNumber, refundNumber, useBankOptions, useCanPostPayments } from "@/components/payments/shared";

import type { MatchCandidate, MatchOverrideInput, MatchingApplyResult, StatementMatch, StatementRowClassification, UnmatchInput } from "@workspace/api-client-react";

const json = {
  override: (b: MatchOverrideInput) => JSON.stringify(b),
  unmatch: (b: UnmatchInput) => JSON.stringify(b),
};

type Cls = StatementRowClassification["classification"];

const CLS: Record<Cls, { en: string; ar: string; cls: string }> = {
  MATCHED: { en: "Matched", ar: "مطابَق", cls: "bg-positive-surface/20 text-positive" },
  DETERMINISTIC: { en: "Deterministic match", ar: "مطابقة قطعية", cls: "bg-info-surface/20 text-info" },
  AMBIGUOUS: { en: "Ambiguous", ar: "غير محسوم", cls: "bg-attention-surface/20 text-attention" },
  UNMATCHED: { en: "Unmatched", ar: "غير مطابَق", cls: "bg-secondary text-muted-foreground" },
  INCONSISTENT: { en: "Inconsistent", ar: "متعارض", cls: "bg-negative-surface/20 text-negative" },
};

const candidateNumber = (c: MatchCandidate) => (c.kind === "payment" ? receiptNumber(c.id) : refundNumber(c.id));

function Candidates({ list, target }: { list: MatchCandidate[]; target: MatchCandidate | null }) {
  const { t } = useLanguage();
  const rows = target && !list.some((c) => c.id === target.id && c.kind === target.kind) ? [target, ...list] : list;
  if (rows.length === 0) return <p className="text-xs text-muted-foreground">{t("No candidate receipt or refund in this bank, for this amount, inside the date window.", "لا يوجد إيصال أو ردّ مرشّح في هذا البنك بهذا المبلغ داخل نافذة التاريخ.")}</p>;
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-muted-foreground uppercase">
          <th className="text-start pb-1 pe-3 font-medium">{t("Candidate", "المرشّح")}</th>
          <th className="text-start pb-1 pe-3 font-medium">{t("Amount", "المبلغ")}</th>
          <th className="text-start pb-1 pe-3 font-medium">{t("Date", "التاريخ")}</th>
          <th className="text-start pb-1 pe-3 font-medium">{t("Reference", "المرجع")}</th>
          <th className="text-start pb-1 font-medium">{t("Identified by", "مُعرَّف بواسطة")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => (
          <tr key={`${c.kind}-${c.id}`} className={target && target.id === c.id && target.kind === c.kind ? "font-semibold" : ""} data-testid={`candidate-${c.kind}-${c.id}`}>
            <td className="py-1 pe-3 font-mono">{candidateNumber(c)}</td>
            <td className="py-1 pe-3 font-mono">{fmtNum(c.amount)}</td>
            <td className="py-1 pe-3">{c.date}</td>
            <td className="py-1 pe-3 font-mono">{c.reference ?? "—"}</td>
            <td className="py-1">{c.identifiedBy ?? <span className="text-muted-foreground">{t("nothing in the narrative", "لا شيء في الوصف")}</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MatchEvidence({ m }: { m: StatementMatch }) {
  const { t } = useLanguage();
  const ev = (m.evidence ?? {}) as Record<string, unknown>;
  const pairs = Object.entries(ev).filter(([, v]) => v != null && typeof v !== "object");
  return (
    <div className="text-xs space-y-1" data-testid={`match-evidence-${m.id}`}>
      <p>
        <span className="text-muted-foreground">{t("Match", "المطابقة")} #{m.id} · </span>
        <Badge variant="outline" className="text-xs">{m.method === "deterministic" ? t("deterministic", "قطعية") : m.method === "manual" ? t("manual override", "يدوية") : t("by construction (settlement)", "بالبناء (تسوية)")}</Badge>
        <span className="text-muted-foreground"> · {m.createdAt.slice(0, 10)} · {m.paymentId != null ? receiptNumber(m.paymentId) : m.refundId != null ? refundNumber(m.refundId) : ""}</span>
      </p>
      {m.reason && <p><span className="text-muted-foreground">{t("Reason", "السبب")}:</span> {m.reason}</p>}
      {pairs.length > 0 && (
        <p className="text-muted-foreground font-mono break-all">{pairs.map(([k, v]) => `${k}=${String(v)}`).join(" · ")}</p>
      )}
      {m.reversedBy && <p className="text-attention">{t("Unmatched on", "أُلغيت المطابقة في")} {m.reversedBy.createdAt.slice(0, 10)} · {m.reversedBy.reason}</p>}
    </div>
  );
}

function OverrideDialog({ row, onClose }: { row: StatementRowClassification; onClose: () => void }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [choice, setChoice] = useState<string>(row.candidates[0] ? `${row.candidates[0].kind}-${row.candidates[0].id}` : "other");
  const [otherId, setOtherId] = useState("");
  const [reason, setReason] = useState("");
  const [key] = useState(() => newIdempotencyKey("match"));
  const kind = row.direction === "in" ? "payment" : "refund";
  const chosen = choice === "other" ? null : row.candidates.find((c) => `${c.kind}-${c.id}` === choice) ?? null;
  const targetId = chosen ? chosen.id : Number(otherId);
  const valid = Number.isInteger(targetId) && targetId > 0 && reason.trim().length > 0;
  const diff = chosen ? Math.round((row.amount - chosen.amount) * 100) / 100 : null;

  const mut = useMutation({
    mutationFn: () =>
      apiFetch("/payments/matching/override", {
        method: "POST",
        body: json.override({ transactionId: row.transactionId, paymentId: kind === "payment" ? targetId : null, refundId: kind === "refund" ? targetId : null, reason: reason.trim(), idempotencyKey: key }),
      }),
    onSuccess: () => { invalidatePaymentQueries(qc); toast({ title: t("Match recorded", "تم تسجيل المطابقة") }); onClose(); },
  });

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-lg" data-testid="override-dialog">
        <DialogHeader>
          <DialogTitle>{t("Match this statement row by hand", "مطابقة سطر الكشف يدويًا")}</DialogTitle>
          <DialogDescription>
            {t("The system could not identify a counterpart on its own. Your choice, your reason and the evidence are recorded as the audit trail. Bank and direction cannot be overridden; an amount difference is recorded, not corrected.",
               "لم يتمكن النظام من تحديد الطرف المقابل بنفسه. يُسجَّل اختيارك وسببك والأدلة كسجل تدقيق. لا يمكن تجاوز البنك والاتجاه؛ ويُسجَّل فرق المبلغ ولا يُصحَّح.")}
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border border-border p-3 text-sm space-y-1">
          <div className="flex justify-between gap-2"><span className="text-muted-foreground">{t("Statement row", "سطر الكشف")}</span><span className="font-mono">#{row.transactionId} · {row.date} · {fmtNum(row.amount)} {row.direction === "in" ? t("in", "وارد") : t("out", "صادر")}</span></div>
          <div className="flex justify-between gap-2"><span className="text-muted-foreground">{t("Bank", "البنك")}</span><span><BankName id={row.bankAccountId} /></span></div>
          <div className="flex justify-between gap-2"><span className="text-muted-foreground">{t("Narrative", "الوصف")}</span><span className="text-end text-xs">{row.description}</span></div>
          <div className="flex justify-between gap-2"><span className="text-muted-foreground">{t("Why not automatic", "لماذا لم تتم تلقائيًا")}</span><span className="text-end text-xs">{row.reason}</span></div>
        </div>
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{kind === "payment" ? t("Counterpart receipt *", "الإيصال المقابل *") : t("Counterpart refund *", "الردّ المقابل *")}</p>
          {row.candidates.map((c) => (
            <label key={`${c.kind}-${c.id}`} className="flex items-start gap-2 text-sm cursor-pointer">
              <input type="radio" name="candidate" className="mt-1" checked={choice === `${c.kind}-${c.id}`} onChange={() => setChoice(`${c.kind}-${c.id}`)} data-testid={`override-choice-${c.id}`} />
              <span><span className="font-mono">{candidateNumber(c)}</span> · {fmtNum(c.amount)} · {c.date}{c.reference ? ` · ${c.reference}` : ""}</span>
            </label>
          ))}
          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input type="radio" name="candidate" className="mt-1" checked={choice === "other"} onChange={() => setChoice("other")} />
            <span className="flex items-center gap-2 flex-wrap">
              {kind === "payment" ? t("Another receipt number", "رقم إيصال آخر") : t("Another refund number", "رقم ردّ آخر")}
              <Input value={otherId} onChange={(e) => { setOtherId(e.target.value); setChoice("other"); }} className="h-8 w-28 text-sm font-mono" placeholder={kind === "payment" ? t("receipt number", "رقم الإيصال") : t("refund number", "رقم الردّ")} inputMode="numeric" data-testid="override-other-id" />
            </span>
          </label>
          {diff != null && Math.abs(diff) > 0.005 && (
            <p className="text-xs text-attention">{t(`Amount difference of ${fmtNum(Math.abs(diff))} will be recorded as evidence.`, `سيُسجَّل فرق مبلغ قدره ${fmtNum(Math.abs(diff))} كدليل.`)}</p>
          )}
        </div>
        <div>
          <p className="text-xs text-muted-foreground mb-1">{t("Reason *", "السبب *")}</p>
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="override-reason" placeholder={t("What tells you these are the same movement", "ما الذي يدلّك على أنهما الحركة نفسها")} />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>{t("Cancel", "إلغاء")}</Button>
          <Button onClick={() => mut.mutate()} disabled={!valid || mut.isPending} data-testid="override-submit">{mut.isPending ? t("Recording…", "جارٍ التسجيل…") : t("Record match", "تسجيل المطابقة")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ReasonDialog({ title, description, confirmLabel, onConfirm, onClose, pending, testId }: { title: string; description: string; confirmLabel: string; onConfirm: (reason: string) => void; onClose: () => void; pending: boolean; testId: string }) {
  const { t } = useLanguage();
  const [reason, setReason] = useState("");
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md" data-testid={testId}>
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
        <div>
          <p className="text-xs text-muted-foreground mb-1">{t("Reason *", "السبب *")}</p>
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} data-testid={`${testId}-reason`} />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>{t("Cancel", "إلغاء")}</Button>
          <Button variant="destructive" onClick={() => onConfirm(reason.trim())} disabled={!reason.trim() || pending} data-testid={`${testId}-submit`}>{confirmLabel}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function BankMatching() {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const canPost = useCanPostPayments();
  const { active: banks } = useBankOptions();
  const [bank, setBank] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [only, setOnly] = useState<"all" | Cls>("all");
  const [openRow, setOpenRow] = useState<number | null>(null);
  const [overriding, setOverriding] = useState<StatementRowClassification | null>(null);
  const [unmatching, setUnmatching] = useState<StatementMatch | null>(null);
  const [accepting, setAccepting] = useState<StatementRowClassification | null>(null);

  const qs = [bank !== "all" && `bank_account_id=${bank}`, from && `date_from=${from}`, to && `date_to=${to}`, "limit=500"].filter(Boolean).join("&");
  const { data: rows = [], isLoading, error } = useQuery<StatementRowClassification[]>({
    queryKey: ["matching", bank, from, to],
    queryFn: () => apiFetch(`/payments/matching?${qs}`),
  });

  const counts = useMemo(() => {
    const c: Record<Cls, number> = { MATCHED: 0, DETERMINISTIC: 0, AMBIGUOUS: 0, UNMATCHED: 0, INCONSISTENT: 0 };
    for (const r of rows) c[r.classification]++;
    return c;
  }, [rows]);
  const shown = only === "all" ? rows : rows.filter((r) => r.classification === only);

  const apply = useMutation({
    mutationFn: (scope: { bankAccountId: number; date: string }) =>
      apiFetch<MatchingApplyResult>(`/payments/matching/apply?bank_account_id=${scope.bankAccountId}&date_from=${scope.date}&date_to=${scope.date}`, { method: "POST" }),
    onSuccess: (res) => {
      invalidatePaymentQueries(qc);
      toast({ title: t(`${res.recorded.length} match(es) recorded`, `تم تسجيل ${res.recorded.length} مطابقة`) });
      setAccepting(null);
    },
    onError: () => setAccepting(null),
  });
  const unmatch = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => apiFetch(`/payments/matching/${id}/unmatch`, { method: "POST", body: json.unmatch({ reason }) }),
    onSuccess: () => { invalidatePaymentQueries(qc); toast({ title: t("Match superseded", "تم إلغاء المطابقة") }); setUnmatching(null); },
  });

  // The scope an Accept names: every DETERMINISTIC row of the same bank on the same date.
  const acceptScope = (r: StatementRowClassification) => rows.filter((x) => x.classification === "DETERMINISTIC" && x.bankAccountId === r.bankAccountId && x.date === r.date);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t("Bank Matching", "مطابقة كشوف البنك")}</h1>
        <p className="text-muted-foreground text-sm mt-1">{t("Statement rows against receipts and refunds. A match is recorded only by a click; the evidence for every classification is shown beside it.", "أسطر الكشف مقابل الإيصالات والمبالغ المردودة. لا تُسجَّل المطابقة إلا بنقرة؛ وتُعرض أدلة كل تصنيف بجانبه.")}</p>
      </div>
      <PermissionHint />

      <div className="flex items-end gap-3 flex-wrap">
        <div>
          <p className="text-xs text-muted-foreground mb-1">{t("Bank account", "الحساب البنكي")}</p>
          <Select value={bank} onValueChange={setBank}>
            <SelectTrigger className="h-9 w-56 text-sm" data-testid="matching-bank"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("All banks", "كل البنوك")}</SelectItem>
              {banks.map((b) => <SelectItem key={b.id} value={String(b.id)}>{b.name} — {b.bankName}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div><p className="text-xs text-muted-foreground mb-1">{t("From", "من")}</p><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 text-sm" /></div>
        <div><p className="text-xs text-muted-foreground mb-1">{t("To", "إلى")}</p><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 text-sm" /></div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <button type="button" onClick={() => setOnly("all")} className={`rounded-md border p-3 text-start ${only === "all" ? "border-primary" : "border-border"}`} data-testid="filter-all">
          <p className="text-xs text-muted-foreground">{t("All rows", "كل الأسطر")}</p><p className="text-xl font-mono font-semibold">{rows.length}</p>
        </button>
        {(Object.keys(CLS) as Cls[]).map((k) => (
          <button type="button" key={k} onClick={() => setOnly(k)} className={`rounded-md border p-3 text-start ${only === k ? "border-primary" : "border-border"}`} data-testid={`filter-${k}`}>
            <p className="text-xs text-muted-foreground">{t(CLS[k].en, CLS[k].ar)}</p><p className="text-xl font-mono font-semibold" data-testid={`count-${k}`}>{counts[k]}</p>
          </button>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-muted-foreground flex items-center gap-2"><ListChecks className="w-4 h-4" />{t("Statement rows", "أسطر الكشف")} ({shown.length})</CardTitle>
          {rows.length >= 500 && (
            <p className="text-xs text-attention">{t("Showing the newest 500 rows — narrow the bank or the dates to see the rest.", "يُعرض أحدث 500 سطر — ضيّق البنك أو التواريخ لرؤية البقية.")}</p>
          )}
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground p-4">{t("Loading…", "جارٍ التحميل…")}</p>
          ) : error ? (
            <p className="text-sm text-destructive p-4">{t("Statement rows could not be loaded.", "تعذر تحميل أسطر الكشف.")} {(error as Error).message}</p>
          ) : shown.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground"><ListChecks className="w-8 h-8 mx-auto mb-3 opacity-40" /><p>{t("No statement rows here. Import a bank statement with a bank account to see them.", "لا توجد أسطر كشف هنا. استورد كشف بنك مع حساب بنكي لرؤيتها.")}</p></div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                    <th className="text-start pb-2 pe-3 font-medium">{t("Date", "التاريخ")}</th>
                    <th className="text-start pb-2 pe-3 font-medium hidden md:table-cell">{t("Bank", "البنك")}</th>
                    <th className="text-start pb-2 pe-3 font-medium">{t("Direction", "الاتجاه")}</th>
                    <th className="text-start pb-2 pe-3 font-medium">{t("Amount", "المبلغ")}</th>
                    <th className="text-start pb-2 pe-3 font-medium hidden sm:table-cell">{t("Reference / narrative", "المرجع / الوصف")}</th>
                    <th className="text-start pb-2 pe-3 font-medium">{t("Status", "الحالة")}</th>
                    <th className="pb-2" />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => {
                    const c = CLS[r.classification];
                    const open = openRow === r.transactionId;
                    const scope = r.classification === "DETERMINISTIC" ? acceptScope(r) : [];
                    return (
                      <RowGroup key={r.transactionId}>
                        <tr className="border-b border-border/50 hover:bg-secondary/20" data-testid={`statement-row-${r.transactionId}`} data-classification={r.classification}>
                          <td className="py-3 pe-3 whitespace-nowrap text-muted-foreground"><DualDate date={r.date} inline /></td>
                          <td className="py-3 pe-3 hidden md:table-cell text-xs"><BankName id={r.bankAccountId} /></td>
                          <td className="py-3 pe-3">
                            {r.direction === "in"
                              ? <span className="inline-flex items-center gap-1 text-positive text-xs"><ArrowDownLeft className="w-3 h-3" />{t("In", "وارد")}</span>
                              : <span className="inline-flex items-center gap-1 text-negative text-xs"><ArrowUpRight className="w-3 h-3" />{t("Out", "صادر")}</span>}
                          </td>
                          <td className="py-3 pe-3 font-mono">{fmtNum(r.amount)}</td>
                          <td className="py-3 pe-3 hidden sm:table-cell text-xs text-muted-foreground max-w-[18rem] truncate" title={r.description}>{r.description}</td>
                          <td className="py-3 pe-3"><Badge className={`text-xs ${c.cls}`}>{t(c.en, c.ar)}</Badge></td>
                          <td className="py-3 text-end whitespace-nowrap">
                            {r.classification === "DETERMINISTIC" && (
                              <Button size="sm" className="h-7 text-xs me-1" disabled={!canPost} onClick={() => setAccepting(r)} data-testid={`accept-${r.transactionId}`}>{t("Accept", "قبول")}</Button>
                            )}
                            {(r.classification === "AMBIGUOUS" || r.classification === "UNMATCHED" || r.classification === "INCONSISTENT") && (
                              <Button size="sm" variant="outline" className="h-7 text-xs me-1" disabled={!canPost} onClick={() => setOverriding(r)} data-testid={`override-${r.transactionId}`}>{t("Match manually", "مطابقة يدوية")}</Button>
                            )}
                            {r.classification === "MATCHED" && r.match && !r.match.reversedBy && (
                              <Button size="sm" variant="ghost" className="h-7 text-xs me-1" disabled={!canPost} onClick={() => setUnmatching(r.match)} data-testid={`unmatch-${r.transactionId}`}>{t("Unmatch", "إلغاء المطابقة")}</Button>
                            )}
                            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setOpenRow(open ? null : r.transactionId)} data-testid={`evidence-${r.transactionId}`} aria-expanded={open}>
                              {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                            </Button>
                          </td>
                        </tr>
                        {open && (
                          <tr className="border-b border-border/50 bg-secondary/10">
                            <td colSpan={7} className="py-3 px-2 sm:px-4 space-y-2" data-testid={`evidence-panel-${r.transactionId}`}>
                              <p className="text-xs"><span className="text-muted-foreground">{t("Narrative", "الوصف")}:</span> {r.description}</p>
                              <p className="text-xs"><span className="text-muted-foreground">{t("Why", "السبب")}:</span> <span data-testid={`reason-${r.transactionId}`}>{r.reason}</span></p>
                              <p className="text-xs text-muted-foreground">{t(`Date window ${r.window.from} → ${r.window.to} (±${r.window.days} days) · same bank · same direction · exact amount`, `نافذة التاريخ ${r.window.from} → ${r.window.to} (±${r.window.days} أيام) · نفس البنك · نفس الاتجاه · المبلغ بالضبط`)}</p>
                              {r.match ? <MatchEvidence m={r.match} /> : <Candidates list={r.candidates} target={r.target} />}
                              {r.classification === "MATCHED" && !r.match && r.target && (
                                <p className="text-xs text-muted-foreground">{t(`Matched by construction: receipt ${receiptNumber(r.target.id)} was created from this row when it was settled from Review.`, `مطابَق بالبناء: أُنشئ الإيصال ${receiptNumber(r.target.id)} من هذا السطر عند تسويته من المراجعة.`)}</p>
                              )}
                              {r.classification === "DETERMINISTIC" && scope.length > 1 && (
                                <p className="text-xs text-attention">{t(`Accept records ${scope.length} deterministic rows for this bank on ${r.date}.`, `يسجّل القبول ${scope.length} أسطر قطعية لهذا البنك في ${r.date}.`)}</p>
                              )}
                            </td>
                          </tr>
                        )}
                      </RowGroup>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {accepting && (
        <Dialog open onOpenChange={(o) => { if (!o) setAccepting(null); }}>
          <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md" data-testid="accept-dialog">
            <DialogHeader>
              <DialogTitle>{t("Record the deterministic match", "تسجيل المطابقة القطعية")}</DialogTitle>
              <DialogDescription>
                {t(`This records every deterministic match for this bank on ${accepting.date} — ${acceptScope(accepting).length} row(s). Nothing is posted; a match only links the statement row to its receipt or refund.`,
                   `يسجّل هذا كل مطابقة قطعية لهذا البنك في ${accepting.date} — ${acceptScope(accepting).length} سطر. لا يُرحَّل شيء؛ المطابقة تربط سطر الكشف بإيصاله أو ردّه فقط.`)}
              </DialogDescription>
            </DialogHeader>
            {accepting.target && (
              <div className="rounded-md border border-border p-3 text-sm space-y-1">
                <div className="flex justify-between gap-2"><span className="text-muted-foreground">{t("Statement row", "سطر الكشف")}</span><span className="font-mono">{fmtNum(accepting.amount)} · {accepting.date}</span></div>
                <div className="flex justify-between gap-2"><span className="text-muted-foreground">{t("Counterpart", "الطرف المقابل")}</span><span className="font-mono">{candidateNumber(accepting.target)} · {fmtNum(accepting.target.amount)} · {accepting.target.date}</span></div>
                <div className="flex justify-between gap-2"><span className="text-muted-foreground">{t("Identified by", "مُعرَّف بواسطة")}</span><span>{accepting.target.identifiedBy}</span></div>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setAccepting(null)}>{t("Cancel", "إلغاء")}</Button>
              <Button onClick={() => apply.mutate({ bankAccountId: accepting.bankAccountId, date: accepting.date })} disabled={apply.isPending} data-testid="accept-confirm">{apply.isPending ? t("Recording…", "جارٍ التسجيل…") : t("Record match", "تسجيل المطابقة")}</Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
      {overriding && <OverrideDialog row={overriding} onClose={() => setOverriding(null)} />}
      {unmatching && (
        <ReasonDialog
          testId="unmatch-dialog"
          title={t(`Unmatch #${unmatching.id}`, `إلغاء المطابقة #${unmatching.id}`)}
          description={t("The match stays on record; a reversal names it and the statement row returns to the unmatched set.", "تبقى المطابقة في السجل؛ ويُضاف سجل إلغاء يشير إليها ويعود سطر الكشف إلى الأسطر غير المطابَقة.")}
          confirmLabel={t("Unmatch", "إلغاء المطابقة")}
          pending={unmatch.isPending}
          onClose={() => setUnmatching(null)}
          onConfirm={(reason) => unmatch.mutate({ id: unmatching.id, reason })}
        />
      )}
    </div>
  );
}

/** A fragment with a key — two `<tr>`s per row without an unkeyed fragment. */
function RowGroup({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
