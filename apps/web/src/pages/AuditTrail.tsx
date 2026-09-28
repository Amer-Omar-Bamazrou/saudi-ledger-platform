/**
 * Audit trail (M23) — the first reader UI for /audit-logs, which had been a
 * mounted API with no screen since M7 wrote the first row. The platform told
 * org admins the trail was "available" while there was nowhere to read it —
 * the last-but-one instance of the claimed-but-unreachable disease.
 *
 * Read-only by nature: the table is append-only at the grants, and this page
 * offers no mutation at all. Admin-only (permission `audit_logs` read =
 * admin), so the nav entry is gated the same way — hiding it from others is
 * honesty about the 403 they would get, not the security boundary itself.
 */
import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { PageHeader, Panel, EmptyState } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollText, ChevronDown, ChevronRight } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { DualDate } from "@/components/DualDate";

interface AuditLog {
  id: string;
  userId: number | null;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string;
  beforeState: unknown;
  afterState: unknown;
  ipAddress: string | null;
  createdAt: string;
}

interface AuditLogPage {
  total: number;
  limit: number;
  offset: number;
  logs: AuditLog[];
}

/** The entity types the audit service actually writes (from auditService callers). */
const ENTITY_TYPES = [
  "invoice", "bill", "journal_entry", "payroll", "transaction", "customer",
  "vendor", "product", "employee", "asset", "bank_account", "budget",
  "category", "quotation", "quotation_conversion", "purchase_order",
  "purchase_order_conversion", "period_lock", "company", "recurring_rule",
];

const ACTIONS = ["create", "update", "delete", "submit", "approve", "reject", "send_back"];

const ACTION_STYLES: Record<string, string> = {
  create: "bg-positive-surface/20 text-positive",
  update: "bg-info-surface/20 text-info",
  delete: "bg-negative-surface/20 text-negative",
  approve: "bg-primary/10 text-primary",
};

const PAGE_SIZE = 50;

export default function AuditTrail() {
  const { t } = useLanguage();
  const [entityType, setEntityType] = useState("all");
  const [action, setAction] = useState("all");
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data, isLoading } = useQuery<AuditLogPage>({
    queryKey: ["audit-logs", entityType, action, offset],
    queryFn: () => {
      const params = new URLSearchParams();
      if (entityType !== "all") params.set("entity_type", entityType);
      if (action !== "all") params.set("action", action);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(offset));
      return apiFetch(`/audit-logs?${params}`);
    },
  });

  const logs = data?.logs ?? [];
  const total = data?.total ?? 0;

  const resetPaging = () => setOffset(0);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("Audit Trail", "سجل التدقيق")}
        description={t(
            "Every change to this organization's records: who did it, when, from where, and what changed. This log is append-only — nothing here can be edited or deleted, including by admins.",
            "كل تغيير في سجلات هذه المؤسسة: من قام به ومتى ومن أين وما الذي تغيّر. هذا السجل للإضافة فقط — لا يمكن تعديل أو حذف أي شيء هنا، حتى من قبل المسؤولين.",
          )}
      />

      <Panel
        flush
        title={
          <span className="inline-flex items-center gap-2">
            {t("Entries", "الإدخالات")}
            {total > 0 && <span className="rounded bg-muted px-1.5 text-[12px] font-medium tabular-nums text-muted-foreground">{total.toLocaleString()}</span>}
          </span>
        }
        actions={
            <div className="flex flex-wrap items-center gap-2">
              <Select value={entityType} onValueChange={(v) => { setEntityType(v); resetPaging(); }}>
                <SelectTrigger className="h-8 w-48 text-[13px] capitalize"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("All record types", "كل أنواع السجلات")}</SelectItem>
                  {ENTITY_TYPES.map((e) => <SelectItem key={e} value={e} className="capitalize">{e.replace(/_/g, " ")}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={action} onValueChange={(v) => { setAction(v); resetPaging(); }}>
                <SelectTrigger className="h-8 w-36 text-[13px] capitalize"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("All actions", "كل الإجراءات")}</SelectItem>
                  {ACTIONS.map((a) => <SelectItem key={a} value={a} className="capitalize">{a.replace(/_/g, " ")}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
        }
      >
          {isLoading ? (
            <p className="text-sm text-muted-foreground p-5">{t("Loading…", "جارٍ التحميل…")}</p>
          ) : logs.length === 0 ? (
            <EmptyState icon={ScrollText} title={t("No entries match these filters.", "لا توجد إدخالات مطابقة لهذه المرشحات.")} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-3 w-6"></th>
                    <th className="px-3 text-start">{t("When", "متى")}</th>
                    <th className="px-3 text-start">{t("Who", "من")}</th>
                    <th className="px-3 text-start">{t("Action", "الإجراء")}</th>
                    <th className="px-3 text-start">{t("Record", "السجل")}</th>
                    <th className="px-3 text-start">{t("From (IP)", "من (IP)")}</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((l) => (
                    <Fragment key={l.id}>
                      <tr
                        className="border-b border-border/70 cursor-pointer hover:bg-muted/40 transition-colors"
                        onClick={() => setExpanded(expanded === l.id ? null : l.id)}
                      >
                        <td className="py-3 px-3 text-muted-foreground">
                          {expanded === l.id ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5 rtl:-scale-x-100" />}
                        </td>
                        <td className="py-3 px-3 text-[13px] whitespace-nowrap">
                          <DualDate date={l.createdAt.slice(0, 10)} />
                          <span className="text-muted-foreground ms-2 inline-block tabular-nums" dir="ltr">{l.createdAt.slice(11, 19)}</span>
                        </td>
                        <td className="py-3 px-3">
                          {/* An unresolved actor stays a number, honestly —
                              never a name borrowed from outside this org. */}
                          {l.actorName ?? (l.userId != null ? `${t("User", "مستخدم")} #${l.userId}` : t("system", "النظام"))}
                        </td>
                        <td className="py-3 px-3">
                          <Badge className={`text-xs capitalize ${ACTION_STYLES[l.action] ?? "bg-secondary text-muted-foreground"}`}>
                            {l.action.replace(/_/g, " ")}
                          </Badge>
                        </td>
                        <td className="py-3 px-3 text-[13px] whitespace-nowrap">
                          <span className="capitalize">{l.entityType.replace(/_/g, " ")}</span> <span className="text-muted-foreground">#{l.entityId}</span>
                        </td>
                        <td className="py-3 px-3 font-mono text-xs text-muted-foreground whitespace-nowrap" dir="ltr">{l.ipAddress ?? "—"}</td>
                      </tr>
                      {expanded === l.id && (
                        <tr className="border-b border-border/70 bg-muted/30">
                          <td></td>
                          <td colSpan={5} className="py-3 px-3">
                            <div className="grid md:grid-cols-2 gap-3 text-xs">
                              <div>
                                <p className="text-muted-foreground mb-1">{t("Before", "قبل")}</p>
                                <pre className="bg-background border border-border rounded-md p-2 overflow-x-auto max-h-64 whitespace-pre-wrap break-all">
                                  {l.beforeState ? JSON.stringify(l.beforeState, null, 2) : t("(nothing — the record was created)", "(لا شيء — أُنشئ السجل)")}
                                </pre>
                              </div>
                              <div>
                                <p className="text-muted-foreground mb-1">{t("After", "بعد")}</p>
                                <pre className="bg-background border border-border rounded-md p-2 overflow-x-auto max-h-64 whitespace-pre-wrap break-all">
                                  {l.afterState ? JSON.stringify(l.afterState, null, 2) : t("(nothing — the record was removed)", "(لا شيء — أُزيل السجل)")}
                                </pre>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {total > PAGE_SIZE && (
            <div className="flex items-center justify-between border-t border-border px-5 py-3 text-sm text-muted-foreground">
              <span>
                {t("Showing", "عرض")} {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} {t("of", "من")} {total.toLocaleString()}
              </span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                  {t("Newer", "الأحدث")}
                </Button>
                <Button size="sm" variant="outline" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>
                  {t("Older", "الأقدم")}
                </Button>
              </div>
            </div>
          )}
      </Panel>
    </div>
  );
}
