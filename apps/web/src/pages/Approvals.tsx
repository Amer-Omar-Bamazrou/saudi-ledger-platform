/**
 * Approvals worklist — the surface where money is released.
 *
 * One server-built queue across every approvable record (journal entries,
 * bills, invoices, payroll runs — and, since Phase 16/17, submitted tax
 * computations, pending treaty reliefs and planned payments) with the workflow
 * actions wired to each record's OWN route. Role enforcement is the server's
 * (a bookkeeper clicking Approve gets a 403 toast); this page shows the
 * actions by state and lets the backend be the authority.
 *
 * 🔴 REBUILT 2026-09-15 (item 4 of the second core-path walk). The M10.6
 * version was "minimal, functional, unstyled": inline styles, a hard-coded
 * `textAlign: "left"` in an RTL app, raw English statuses in the Arabic UI,
 * and a success toast that printed the raw action name (`تم: approve`). It
 * was functionally correct — every click on the core path went through it —
 * and it was where issuing happens, reading as unfinished. Now it uses the
 * app's own primitives (Card, Badge, Button), logical alignment, the shared
 * `statusLabel`, and a toast that names the act in the reader's language.
 *
 * 🔴 PHASE 16/17 (QA-15, 2026-10-04): a bookkeeper "submitted" a Zakat
 * computation, recorded a treaty relief, planned a payment — and no approver
 * was ever told: the queue knew four entities. The three joined it here, not in
 * a second inbox; each action posts to the record's own route and permission.
 * A reason the server requires (revoking a relief, cancelling a plan) or a note
 * it accepts (sending back) is typed inline — never a browser prompt — and every
 * action is single-flight (a double-click sends ONE request, F-19).
 */
import { Fragment, useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck } from "lucide-react";
import {
  approveTaxComputationVersion, sendBackTaxComputationVersion, rejectTaxComputationVersion,
  approveWhtRelief, revokeWhtRelief, approvePaymentPlan, cancelPaymentPlan,
  type ApprovalPendingRow,
} from "@workspace/api-client-react";
import { apiFetch, fmtNum } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { statusLabel } from "@/lib/statusLabel";
import { whtTypeLabel } from "@/lib/taxLabels";
import { useGuarded } from "@/lib/singleSubmit";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type EntityKey = ApprovalPendingRow["entity"];
type Action = "submit" | "approve" | "send-back" | "reject";
type Legacy = "invoices" | "bills" | "journal-entries" | "payroll";
const LEGACY: readonly EntityKey[] = ["invoices", "bills", "journal-entries", "payroll"];

/**
 * 🔴 ONE server-built queue (contract batch 5, owner decision A). This page
 * used to fetch the default PAGE (50) of each entity's list and filter
 * client-side — so pending drafts older than the newest 50 documents were
 * invisible: "nothing pending" while money waited, a wrong statement about the
 * tenant's own obligations. `/approvals/pending` is UNBOUNDED by design and
 * built on the server, with a journal entry's amount from the same line
 * aggregate the ledger uses. AUD-9 still holds: a non-array is an ERROR, never
 * an empty queue.
 */
function usePendingQueue() {
  return useQuery<ApprovalPendingRow[]>({
    queryKey: ["approvals", "pending"],
    queryFn: async () => {
      const rows = await apiFetch<ApprovalPendingRow[]>("/approvals/pending");
      if (!Array.isArray(rows)) {
        throw new Error("/approvals/pending did not return a list — the approvals queue cannot be shown.");
      }
      return rows;
    },
  });
}

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  submitted: "bg-attention-surface/20 text-attention",
  pending: "bg-attention-surface/20 text-attention",
  planned: "bg-attention-surface/20 text-attention",
};

/** Which acts a row offers, by entity and state — the server still decides each one. */
function actionsOf(r: ApprovalPendingRow, canSubmit: boolean): Action[] {
  if (r.entity === "wht-reliefs" || r.entity === "payment-plans") return ["approve", "reject"];
  if (r.entity === "tax-computations") return ["approve", "send-back", "reject"];
  const out: Action[] = [];
  if (r.status === "draft" && canSubmit) out.push("submit");
  out.push("approve");
  if (r.status === "submitted") out.push("send-back");
  out.push("reject");
  return out;
}

/** Every section, in page order, with its name — the summary line names the ones with something waiting. */
const SECTIONS: { key: EntityKey; label: [string, string] }[] = [
  { key: "journal-entries", label: ["Journal entries", "قيود اليومية"] },
  { key: "bills", label: ["Bills", "فواتير الموردين"] },
  { key: "invoices", label: ["Invoices", "فواتير العملاء"] },
  { key: "payroll", label: ["Payroll runs", "مسيرات الرواتب"] },
  { key: "tax-computations", label: ["Zakat and income-tax computations", "احتسابات الزكاة وضريبة الدخل"] },
  { key: "wht-reliefs", label: ["Treaty reliefs", "إعفاءات الاتفاقيات"] },
  { key: "payment-plans", label: ["Planned payments", "الدفعات المخططة"] },
];

/** A reject that needs the server's reason (≥ 3 characters) rather than a confirmation. */
const reasonRequired = (e: EntityKey) => e === "wht-reliefs" || e === "payment-plans";

/** Where the record is reviewed before it is approved. */
function reviewHref(r: ApprovalPendingRow): string | null {
  if (r.entity === "tax-computations" && r.parentId != null) return `/tax/computations/${r.parentId}`;
  if (r.entity === "wht-reliefs") return "/tax/withholding?tab=reliefs";
  if (r.entity === "payment-plans") return "/treasury?tab=plans";
  return null;
}

/** The act itself — the four documents through their shared route shape, the rest through the generated client. */
async function perform(r: ApprovalPendingRow, action: Action, text: string): Promise<unknown> {
  if (LEGACY.includes(r.entity)) {
    const key = r.entity as Legacy;
    const id = r.id;
    const body = action === "send-back" ? JSON.stringify({ note: text }) : undefined;
    return apiFetch(`/${key}/${id}/${action}`, { method: "POST", body });
  }
  if (r.entity === "tax-computations") {
    if (r.parentId == null) throw new Error("This computation version names no computation.");
    if (action === "approve") return approveTaxComputationVersion(r.parentId, r.id);
    if (action === "send-back") return sendBackTaxComputationVersion(r.parentId, r.id, { note: text.trim() || null });
    if (action === "reject") return rejectTaxComputationVersion(r.parentId, r.id);
  }
  if (r.entity === "wht-reliefs") {
    if (action === "approve") return approveWhtRelief(r.id);
    if (action === "reject") return revokeWhtRelief(r.id, { reason: text.trim() });
  }
  if (r.entity === "payment-plans") {
    if (action === "approve") return approvePaymentPlan(r.id);
    if (action === "reject") return cancelPaymentPlan(r.id, { reason: text.trim() });
  }
  throw new Error(`${action} is not offered for this record.`);
}

export default function Approvals() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t, n, lang } = useLanguage();

  const queue = usePendingQueue();
  const byEntity = (entity: EntityKey) => queue.data?.filter((r) => r.entity === entity);
  /** The row whose note / reason / confirmation is open, and what was typed. */
  const [open, setOpen] = useState<{ entity: EntityKey; id: number; action: Action } | null>(null);
  const [text, setText] = useState("");

  // The act, named in the reader's language — never the raw route segment.
  const ACTION_DONE: Record<Action, string> = {
    submit: t("Submitted for approval", "أُرسل للاعتماد"),
    approve: t("Approved", "تم الاعتماد"),
    "send-back": t("Sent back for editing", "أُعيد للتعديل"),
    reject: t("Rejected", "تم الرفض"),
  };

  const act = useGuarded(useMutation({
    mutationFn: ({ row, action, note }: { row: ApprovalPendingRow; action: Action; note: string }) => perform(row, action, note),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ["approvals", "pending"] });
      // the record's own pages read their own queries (a computation's detail, the WHT preview a relief changes, the
      // forecast a plan commits) — refresh every tax and treasury read, so none shows the state before this act
      if (!LEGACY.includes(v.row.entity)) {
        qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === "string" && (q.queryKey[0].startsWith("/api/tax/") || q.queryKey[0].startsWith("/api/treasury/")) });
      }
      setOpen(null);
      setText("");
      toast({ title: v.row.entity === "payment-plans" && v.action === "reject" ? t("Plan cancelled", "أُلغيت الخطة") : v.row.entity === "wht-reliefs" && v.action === "reject" ? t("Relief revoked", "أُلغي الإعفاء") : ACTION_DONE[v.action] });
    },
    onError: (e: Error) => toast({ title: t("Action failed", "فشل الإجراء"), description: e.message, variant: "destructive" as any }),
  }));

  const ACTION_LABEL: Record<Action, string> = {
    submit: t("Submit", "إرسال"),
    approve: t("Approve", "اعتماد"),
    "send-back": t("Send back", "إعادة للتعديل"),
    reject: t("Reject", "رفض"),
  };

  /** What the row's first column says — the server's label, the party in the reader's language, the kind named. */
  const labelOf = (r: ApprovalPendingRow) => {
    const main = n(r.label, r.labelAr ?? null);
    if (r.entity === "tax-computations") return `${r.subtype === "income_tax" ? t("Income tax", "ضريبة الدخل") : t("Zakat", "الزكاة")} ${main}`;
    return main;
  };

  // a render FUNCTION, not a component declared in this one: a component re-created on every render remounts its
  // subtree, and the reason input would lose focus at every keystroke
  const section = ({ title, entityKey, rows, canSubmit, hint }: { title: string; entityKey: EntityKey; rows?: ApprovalPendingRow[]; canSubmit: boolean; hint?: string }) => (
    <Card key={entityKey} id={`approvals-${entityKey}`} className="border-border bg-card scroll-mt-4" data-testid={`approvals-${entityKey}`}>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          {title}
          {rows && rows.length > 0 && <Badge variant="outline" className="font-mono text-xs">{rows.length}</Badge>}
        </CardTitle>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardHeader>
      <CardContent>
        {!rows || rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("Nothing pending.", "لا يوجد شيء قيد الانتظار.")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  <th className="text-start pb-2 pe-4 font-medium">#</th>
                  <th className="text-start pb-2 pe-4 font-medium">{t("Status", "الحالة")}</th>
                  <th className="text-end pb-2 pe-4 font-medium">{t("Amount", "المبلغ")}</th>
                  <th className="text-start pb-2 font-medium">{t("Actions", "إجراءات")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {rows.map((r) => {
                  const href = reviewHref(r);
                  const isOpen = open?.entity === r.entity && open.id === r.id;
                  const needsReason = isOpen && open!.action === "reject" && reasonRequired(r.entity);
                  const confirmOk = !needsReason || text.trim().length >= 3;
                  return (
                    <Fragment key={r.id}>
                    <tr data-row data-testid={`approval-${r.entity}-${r.id}`}>
                      <td className="py-2 pe-4">
                        <span className="text-xs" data-testid={`approval-label-${r.entity}-${r.id}`}>
                          {href ? <Link href={href} className="hover:underline">{labelOf(r)}</Link> : <span className="font-mono">{labelOf(r)}</span>}
                        </span>
                        {r.entity === "wht-reliefs" && r.subtype && <span className="block text-xs text-muted-foreground">{whtTypeLabel(r.subtype, t)}</span>}
                      </td>
                      <td className="py-2 pe-4"><Badge className={`text-xs ${STATUS_STYLES[r.status] ?? ""}`}>{statusLabel(r.status, lang)}</Badge></td>
                      <td className="py-2 pe-4 text-end font-mono" dir="ltr">{typeof r.amount === "number" ? fmtNum(r.amount) : "—"}</td>
                      <td className="py-2">
                        <div className="flex flex-wrap gap-1">
                          {actionsOf(r, canSubmit).map((a) => {
                            // the immediate acts: submit and approve (and a document's reject, as before); the rest open a note / reason / confirmation
                            const immediate = a === "submit" || a === "approve" || (a === "reject" && LEGACY.includes(r.entity));
                            return (
                              <Button key={a} size="sm" variant={a === "approve" ? "default" : a === "reject" ? "ghost" : "outline"}
                                className={`h-7 text-xs ${a === "reject" ? "text-negative" : ""}`} disabled={act.isPending}
                                data-testid={`approval-${a}-${r.entity}-${r.id}`}
                                onClick={() => {
                                  if (immediate) act.mutate({ row: r, action: a, note: "" });
                                  else { setOpen(isOpen && open!.action === a ? null : { entity: r.entity, id: r.id, action: a }); setText(""); }
                                }}>
                                {ACTION_LABEL[a]}
                              </Button>
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                      {isOpen ? (
                        <tr><td colSpan={4} className="pb-3">
                          <div className="flex flex-wrap items-end gap-2" data-testid={`approval-confirm-${r.entity}-${r.id}`}>
                            {open!.action === "send-back" || needsReason ? (
                              <div className="grow min-w-48">
                                <label className="text-xs text-muted-foreground">
                                  {open!.action === "send-back"
                                    ? t("Note to the preparer (optional)", "ملاحظة للمُعِد (اختياري)")
                                    : r.entity === "payment-plans"
                                      ? t("Why is this plan cancelled? (at least 3 characters; the record keeps it)", "لماذا تُلغى هذه الخطة؟ (3 أحرف على الأقل؛ يحفظها السجل)")
                                      : t("Why is this relief revoked? (at least 3 characters; the record keeps it)", "لماذا يُلغى هذا الإعفاء؟ (3 أحرف على الأقل؛ يحفظه السجل)")}
                                </label>
                                <Input className="mt-1 h-8 text-sm" maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} data-testid={`approval-text-${r.entity}-${r.id}`} />
                              </div>
                            ) : (
                              <p className="text-sm grow">{t("Rejecting removes this version (an open version is a draft, not a record).", "الرفض يحذف هذا الإصدار (الإصدار المفتوح مسودة لا سجل).")}</p>
                            )}
                            <Button size="sm" className="h-8" disabled={!confirmOk || act.isPending} data-testid={`approval-confirm-submit-${r.entity}-${r.id}`}
                              onClick={() => act.mutate({ row: r, action: open!.action, note: text })}>
                              {ACTION_LABEL[open!.action]}
                            </Button>
                            <Button size="sm" variant="ghost" className="h-8" onClick={() => { setOpen(null); setText(""); }}>{t("Back", "رجوع")}</Button>
                          </div>
                        </td></tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-4 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2"><ClipboardCheck className="w-6 h-6" />{t("Approvals", "الاعتمادات")}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {t(
            "Everything waiting for an approver: draft and submitted financial records, submitted tax computations, treaty reliefs and planned payments. Submit is a bookkeeper action; approve / send-back / reject require approver authority (enforced by the server).",
            "كل ما ينتظر معتمِدًا: السجلات المالية المسودة والمرسلة، واحتسابات الضرائب المقدَّمة، وإعفاءات الاتفاقيات، والدفعات المخططة. الإرسال إجراء لمُدخل البيانات؛ أما الاعتماد والإعادة والرفض فتتطلب صلاحية اعتماد (يفرضها الخادم).",
          )}
        </p>
      </div>
      {queue.isError && <p className="text-sm text-negative">{(queue.error as Error).message}</p>}
      {/* what is waiting, at the top — the tax and treasury sections sit below four document sections that are often empty */}
      {queue.data && (
        <p className="text-sm" data-testid="approvals-summary">
          {queue.data.length === 0
            ? t("Nothing is waiting for approval.", "لا شيء بانتظار الاعتماد.")
            : <>
                {t("Waiting for approval:", "بانتظار الاعتماد:")}{" "}
                {SECTIONS.filter((x) => (byEntity(x.key)?.length ?? 0) > 0).map((x, i) => (
                  <span key={x.key}>{i > 0 ? " · " : ""}<a href={`#approvals-${x.key}`} className="underline">{t(...x.label)} ({byEntity(x.key)!.length})</a></span>
                ))}
              </>}
        </p>
      )}
      {/* Journal entries have no submit stage — approved (posted) straight from draft. */}
      {section({ title: t("Journal Entries", "قيود اليومية"), entityKey: "journal-entries", rows: byEntity("journal-entries"), canSubmit: false })}
      {section({ title: t("Bills", "فواتير الموردين"), entityKey: "bills", rows: byEntity("bills"), canSubmit: true })}
      {section({ title: t("Invoices", "فواتير العملاء"), entityKey: "invoices", rows: byEntity("invoices"), canSubmit: true })}
      {section({ title: t("Payroll Runs", "مسيرات الرواتب"), entityKey: "payroll", rows: byEntity("payroll"), canSubmit: true })}
      {section({
        title: t("Zakat and income-tax computations", "احتسابات الزكاة وضريبة الدخل"), entityKey: "tax-computations", rows: byEntity("tax-computations"), canSubmit: false,
        hint: t("Submitted working papers. Open one to review its figures before approving — approval posts the accrual, once the year has ended.", "أوراق عمل مقدَّمة. افتح كلًّا منها لمراجعة أرقامها قبل الاعتماد — الاعتماد يرحّل الاستحقاق بعد انتهاء السنة."),
      })}
      {section({
        title: t("Treaty reliefs (withholding tax)", "إعفاءات الاتفاقيات (ضريبة الاستقطاع)"), entityKey: "wht-reliefs", rows: byEntity("wht-reliefs"), canSubmit: false,
        hint: t("A recorded treaty rate relieves nothing until it is approved. Check the ZATCA approval reference and the residency certificate on the withholding-tax page first.", "لا تُطبَّق نسبة الاتفاقية المسجلة حتى تُعتمد. تحقّق أولًا من مرجع موافقة الهيئة وشهادة الإقامة في صفحة ضريبة الاستقطاع."),
      })}
      {section({
        title: t("Planned payments", "الدفعات المخططة"), entityKey: "payment-plans", rows: byEntity("payment-plans"), canSubmit: false,
        hint: t("Approving a plan commits it in the cash forecast; it is paid later through the bill's ordinary payment. Nothing is sent to a bank.", "اعتماد الخطة يجعلها ملتزمًا بها في توقع النقد؛ وتُدفع لاحقًا عبر سداد الفاتورة المعتاد. لا يُرسل شيء إلى أي بنك."),
      })}
    </div>
  );
}
