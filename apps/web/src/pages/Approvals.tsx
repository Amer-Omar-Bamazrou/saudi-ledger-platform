/**
 * Approvals worklist — the surface where money is released.
 *
 * One server-built queue across every draftable entity (journal entries,
 * bills, invoices, payroll runs) with the workflow actions wired to the API:
 * submit / approve / send-back / reject. Role enforcement is the server's (a
 * bookkeeper clicking Approve gets a 403 toast); this page shows the actions
 * by state and lets the backend be the authority.
 *
 * 🔴 REBUILT 2026-09-15 (item 4 of the second core-path walk). The M10.6
 * version was "minimal, functional, unstyled": inline styles, a hard-coded
 * `textAlign: "left"` in an RTL app, raw English statuses in the Arabic UI,
 * and a success toast that printed the raw action name (`تم: approve`). It
 * was functionally correct — every click on the core path went through it —
 * and it was where issuing happens, reading as unfinished. Now it uses the
 * app's own primitives (Card, Badge, Button), logical alignment, the shared
 * `statusLabel`, and a toast that names the act in the reader's language.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck } from "lucide-react";
import { apiFetch, fmtNum } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { statusLabel } from "@/lib/statusLabel";
import { PageHeader, Panel, EmptyState } from "@/components/kit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import type { ApprovalPendingRow } from "@workspace/api-client-react";

type EntityKey = ApprovalPendingRow["entity"];
type Action = "submit" | "approve" | "send-back" | "reject";

/**
 * 🔴 ONE server-built queue (contract batch 5, owner decision A). This page
 * used to fetch the default PAGE (50) of each entity's list and filter
 * client-side — so pending drafts older than the newest 50 documents were
 * invisible: "nothing pending" while money waited, a wrong statement about the
 * tenant's own obligations. `/approvals/pending` is UNBOUNDED by design and
 * built on the server from all four tables, with a journal entry's amount from
 * the same line aggregate the ledger uses. AUD-9 still holds: a non-array is
 * an ERROR, never an empty queue.
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
};

export default function Approvals() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t, lang } = useLanguage();

  const queue = usePendingQueue();
  const byEntity = (entity: EntityKey) => queue.data?.filter((r) => r.entity === entity);

  // The act, named in the reader's language — never the raw route segment.
  const ACTION_DONE: Record<Action, string> = {
    submit: t("Submitted for approval", "أُرسل للاعتماد"),
    approve: t("Approved", "تم الاعتماد"),
    "send-back": t("Sent back for editing", "أُعيد للتعديل"),
    reject: t("Rejected", "تم الرفض"),
  };

  const act = useMutation({
    mutationFn: async ({ key, id, action }: { key: EntityKey; id: number; action: Action }) => {
      let body: string | undefined;
      if (action === "send-back") {
        const note = window.prompt(t("Reason for sending back (optional):", "سبب الإعادة للتعديل (اختياري):")) ?? "";
        body = JSON.stringify({ note });
      }
      return apiFetch(`/${key}/${id}/${action}`, { method: "POST", body });
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ["approvals", "pending"] });
      toast({ title: ACTION_DONE[v.action] });
    },
    onError: (e: Error) => toast({ title: t("Action failed", "فشل الإجراء"), description: e.message, variant: "destructive" as any }),
  });

  const Section = ({ title, entityKey, rows, canSubmit }: { title: string; entityKey: EntityKey; rows?: ApprovalPendingRow[]; canSubmit: boolean }) => (
    <Panel
      flush
      title={
        <span className="inline-flex items-center gap-2">
          {title}
          {rows && rows.length > 0 && <span className="rounded bg-attention-surface/15 px-1.5 text-[12px] font-medium tabular-nums text-attention">{rows.length}</span>}
        </span>
      }
    >
        {!rows || rows.length === 0 ? (
          <EmptyState className="py-8" icon={ClipboardCheck} title={t("Nothing pending.", "لا يوجد شيء قيد الانتظار.")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-start px-3">#</th>
                  <th className="text-start px-3">{t("Status", "الحالة")}</th>
                  <th className="text-end px-3">{t("Amount", "المبلغ")}</th>
                  <th className="text-end px-3">{t("Actions", "إجراءات")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} data-row className="border-b border-border/70 last:border-b-0 hover:bg-muted/40 transition-colors">
                    <td className="py-3 px-3 font-medium text-primary whitespace-nowrap">{r.label}</td>
                    <td className="py-3 px-3"><Badge className={`text-xs capitalize ${STATUS_STYLES[r.status] ?? ""}`}>{statusLabel(r.status, lang)}</Badge></td>
                    <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">{typeof r.amount === "number" ? fmtNum(r.amount) : "—"}</td>
                    <td className="py-3 px-3">
                      <div className="flex flex-wrap justify-end gap-1">
                        {r.status === "draft" && canSubmit && (
                          <Button variant="outline" size="sm" className="h-7 text-xs" disabled={act.isPending} onClick={() => act.mutate({ key: entityKey, id: r.id, action: "submit" })}>{t("Submit", "إرسال")}</Button>
                        )}
                        <Button size="sm" className="h-7 text-xs" disabled={act.isPending} onClick={() => act.mutate({ key: entityKey, id: r.id, action: "approve" })}>{t("Approve", "اعتماد")}</Button>
                        {r.status === "submitted" && (
                          <Button variant="ghost" size="sm" className="h-7 text-xs" disabled={act.isPending} onClick={() => act.mutate({ key: entityKey, id: r.id, action: "send-back" })}>{t("Send back", "إعادة للتعديل")}</Button>
                        )}
                        <Button variant="ghost" size="sm" className="h-7 text-xs text-negative" disabled={act.isPending} onClick={() => act.mutate({ key: entityKey, id: r.id, action: "reject" })}>{t("Reject", "رفض")}</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </Panel>
  );

  return (
    <div className="space-y-6 max-w-5xl">
      <PageHeader
        title={t("Approvals", "الاعتمادات")}
        description={t(
            "Pending drafts across all financial records. Submit is a bookkeeper action; approve / send-back / reject require approver authority (enforced by the server).",
            "المسودات المعلّقة في كل السجلات المالية. الإرسال إجراء لمُدخل البيانات؛ أما الاعتماد والإعادة والرفض فتتطلب صلاحية اعتماد (يفرضها الخادم).",
          )}
      />
      {queue.isError && <p className="text-sm text-negative">{(queue.error as Error).message}</p>}
      {/* Journal entries have no submit stage — approved (posted) straight from draft. */}
      <Section title={t("Journal Entries", "قيود اليومية")} entityKey="journal-entries" rows={byEntity("journal-entries")} canSubmit={false} />
      <Section title={t("Bills", "فواتير الموردين")} entityKey="bills" rows={byEntity("bills")} canSubmit />
      <Section title={t("Invoices", "فواتير العملاء")} entityKey="invoices" rows={byEntity("invoices")} canSubmit />
      <Section title={t("Payroll Runs", "مسيرات الرواتب")} entityKey="payroll" rows={byEntity("payroll")} canSubmit />
    </div>
  );
}
