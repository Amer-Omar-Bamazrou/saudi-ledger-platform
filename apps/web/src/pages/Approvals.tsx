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

interface Row {
  id: number;
  label: string; // human identifier (number / period)
  status: string;
  amount: number;
}

type EntityKey = "journal-entries" | "bills" | "invoices" | "payroll";

const PENDING = ["draft", "submitted"];

function useEntity(key: EntityKey, map: (r: any) => Row) {
  return useQuery<Row[]>({
    queryKey: ["approvals", key],
    queryFn: async () => {
      const data = await apiFetch<any[]>(`/${key}`);
      return (Array.isArray(data) ? data : []).filter((r) => PENDING.includes(r.status)).map(map);
    },
  });
}

export default function Approvals() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const je = useEntity("journal-entries", (r) => ({ id: r.id, label: r.entryNumber, status: r.status, amount: r.totalDebit }));
  const bills = useEntity("bills", (r) => ({ id: r.id, label: r.billNumber, status: r.status, amount: r.total }));
  const invoices = useEntity("invoices", (r) => ({ id: r.id, label: r.invoiceNumber, status: r.status, amount: r.total }));
  const payroll = useEntity("payroll", (r) => ({ id: r.id, label: r.period, status: r.status, amount: r.totalNetPay }));

  const act = useMutation({
    mutationFn: async ({ key, id, action }: { key: EntityKey; id: number; action: string }) => {
      let body: string | undefined;
      if (action === "send-back") {
        const note = window.prompt("Reason for sending back (optional):") ?? "";
        body = JSON.stringify({ note });
      }
      return apiFetch(`/${key}/${id}/${action}`, { method: "POST", body });
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ["approvals", v.key] });
      toast({ title: `Done: ${v.action}` });
    },
    onError: (e: Error) => toast({ title: "Action failed", description: e.message, variant: "destructive" as any }),
  });

  const Section = ({ title, entityKey, rows, canSubmit }: { title: string; entityKey: EntityKey; rows?: Row[]; canSubmit: boolean }) => (
    <section style={{ marginBottom: 24 }}>
      <h2 style={{ fontWeight: 600, marginBottom: 8 }}>{title}</h2>
      {!rows || rows.length === 0 ? (
        <p style={{ color: "#888", fontSize: 13 }}>Nothing pending.</p>
      ) : (
        <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>
              <th style={{ padding: 4 }}>#</th>
              <th style={{ padding: 4 }}>Status</th>
              <th style={{ padding: 4 }}>Amount</th>
              <th style={{ padding: 4 }}>Actions</th>
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
                    <button onClick={() => act.mutate({ key: entityKey, id: r.id, action: "submit" })}>Submit</button>
                  )}
                  <button onClick={() => act.mutate({ key: entityKey, id: r.id, action: "approve" })}>Approve</button>
                  {r.status === "submitted" && (
                    <button onClick={() => act.mutate({ key: entityKey, id: r.id, action: "send-back" })}>Send back</button>
                  )}
                  <button onClick={() => act.mutate({ key: entityKey, id: r.id, action: "reject" })}>Reject</button>
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
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Approvals</h1>
      <p style={{ color: "#888", fontSize: 13, marginBottom: 16 }}>
        Pending drafts across all financial records. Submit is a bookkeeper action; approve / send-back / reject require
        approver authority (enforced by the server).
      </p>
      {/* Journal entries have no submit stage — approved (posted) straight from draft. */}
      <Section title="Journal Entries" entityKey="journal-entries" rows={je.data} canSubmit={false} />
      <Section title="Bills" entityKey="bills" rows={bills.data} canSubmit />
      <Section title="Invoices" entityKey="invoices" rows={invoices.data} canSubmit />
      <Section title="Payroll Runs" entityKey="payroll" rows={payroll.data} canSubmit />
    </div>
  );
}
