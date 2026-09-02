/**
 * Approvals worklist (M10.6) — minimal, functional, unstyled.
 *
 * The first clickable surface for the draft/approval workflow: a single
 * pending-approvals view across all draftable entities (journal entries, bills,
 * invoices, payroll runs) with the workflow actions wired to the API —
 * submit / approve / send-back / reject. Role enforcement is done by the server
 * (a bookkeeper clicking Approve gets a 403 toast); this page intentionally shows
 * the actions by state and lets the backend be the authority. Styling is
 * deliberately minimal — the real worklist UX is a later design phase.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";

import type { ApprovalPendingRow } from "@workspace/api-client-react";

type EntityKey = ApprovalPendingRow["entity"];

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

export default function Approvals() {
  const qc = useQueryClient();
  const { toast } = useToast();
  // AUD-8: Arabic is a launch requirement, and this page had no i18n at all —
  // on the surface where money is released.
  const { t } = useLanguage();

  const queue = usePendingQueue();
  const byEntity = (entity: EntityKey) => queue.data?.filter((r) => r.entity === entity);

  const act = useMutation({
    mutationFn: async ({ key, id, action }: { key: EntityKey; id: number; action: string }) => {
      let body: string | undefined;
      if (action === "send-back") {
        const note = window.prompt(t("Reason for sending back (optional):", "سبب الإعادة للتعديل (اختياري):")) ?? "";
        body = JSON.stringify({ note });
      }
      return apiFetch(`/${key}/${id}/${action}`, { method: "POST", body });
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ["approvals", "pending"] });
      toast({ title: t(`Done: ${v.action}`, `تم: ${v.action}`) });
    },
    onError: (e: Error) => toast({ title: t("Action failed", "فشل الإجراء"), description: e.message, variant: "destructive" as any }),
  });

  const Section = ({ title, entityKey, rows, canSubmit }: { title: string; entityKey: EntityKey; rows?: ApprovalPendingRow[]; canSubmit: boolean }) => (
    <section style={{ marginBottom: 24 }}>
      <h2 style={{ fontWeight: 600, marginBottom: 8 }}>{title}</h2>
      {!rows || rows.length === 0 ? (
        <p style={{ color: "#888", fontSize: 13 }}>{t("Nothing pending.", "لا يوجد شيء قيد الانتظار.")}</p>
      ) : (
        <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>
              <th style={{ padding: 4 }}>#</th>
              <th style={{ padding: 4 }}>{t("Status", "الحالة")}</th>
              <th style={{ padding: 4 }}>{t("Amount", "المبلغ")}</th>
              <th style={{ padding: 4 }}>{t("Actions", "إجراءات")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ borderBottom: "1px solid #eee" }}>
                <td style={{ padding: 4, fontFamily: "monospace" }}>{r.label}</td>
                <td style={{ padding: 4 }}>{r.status}</td>
                <td style={{ padding: 4, fontFamily: "monospace" }}>{r.amount?.toLocaleString?.() ?? r.amount}</td>
                <td style={{ padding: 4, display: "flex", gap: 6 }}>
                  {r.status === "draft" && canSubmit && (
                    <button onClick={() => act.mutate({ key: entityKey, id: r.id, action: "submit" })}>{t("Submit", "إرسال")}</button>
                  )}
                  <button onClick={() => act.mutate({ key: entityKey, id: r.id, action: "approve" })}>{t("Approve", "اعتماد")}</button>
                  {r.status === "submitted" && (
                    <button onClick={() => act.mutate({ key: entityKey, id: r.id, action: "send-back" })}>{t("Send back", "إعادة للتعديل")}</button>
                  )}
                  <button onClick={() => act.mutate({ key: entityKey, id: r.id, action: "reject" })}>{t("Reject", "رفض")}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );

  return (
    <div style={{ padding: 16, maxWidth: 900 }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>{t("Approvals", "الاعتمادات")}</h1>
      <p style={{ color: "#888", fontSize: 13, marginBottom: 16 }}>
        {t(
          "Pending drafts across all financial records. Submit is a bookkeeper action; approve / send-back / reject require approver authority (enforced by the server).",
          "المسودات المعلّقة في كل السجلات المالية. الإرسال إجراء لمُدخل البيانات؛ أما الاعتماد والإعادة والرفض فتتطلب صلاحية اعتماد (يفرضها الخادم).",
        )}
      </p>
      {/* Journal entries have no submit stage — approved (posted) straight from draft. */}
      <Section title={t("Journal Entries", "قيود اليومية")} entityKey="journal-entries" rows={byEntity("journal-entries")} canSubmit={false} />
      <Section title={t("Bills", "فواتير الموردين")} entityKey="bills" rows={byEntity("bills")} canSubmit />
      <Section title={t("Invoices", "فواتير العملاء")} entityKey="invoices" rows={byEntity("invoices")} canSubmit />
      <Section title={t("Payroll Runs", "مسيرات الرواتب")} entityKey="payroll" rows={byEntity("payroll")} canSubmit />
    </div>
  );
}
