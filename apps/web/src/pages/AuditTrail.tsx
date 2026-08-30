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
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  approve: "bg-violet-500/20 text-violet-400",
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
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <ScrollText className="w-5 h-5" />
          {t("Audit Trail", "سجل التدقيق")}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {t(
            "Every change to this organization's records: who did it, when, from where, and what changed. This log is append-only — nothing here can be edited or deleted, including by admins.",
            "كل تغيير في سجلات هذه المؤسسة: من قام به ومتى ومن أين وما الذي تغيّر. هذا السجل للإضافة فقط — لا يمكن تعديل أو حذف أي شيء هنا، حتى من قبل المسؤولين.",
          )}
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <CardTitle className="text-base">
              {t("Entries", "الإدخالات")}
              {total > 0 && <span className="text-muted-foreground font-normal"> · {total.toLocaleString()}</span>}
            </CardTitle>
            <div className="flex items-center gap-2">
              <Select value={entityType} onValueChange={(v) => { setEntityType(v); resetPaging(); }}>
                <SelectTrigger className="h-8 w-48 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("All record types", "كل أنواع السجلات")}</SelectItem>
                  {ENTITY_TYPES.map((e) => <SelectItem key={e} value={e}>{e.replace(/_/g, " ")}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={action} onValueChange={(v) => { setAction(v); resetPaging(); }}>
                <SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("All actions", "كل الإجراءات")}</SelectItem>
                  {ACTIONS.map((a) => <SelectItem key={a} value={a}>{a.replace(/_/g, " ")}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground py-6 text-center">{t("Loading…", "جارٍ التحميل…")}</p>
          ) : logs.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              {t("No entries match these filters.", "لا توجد إدخالات مطابقة لهذه المرشحات.")}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-start text-xs text-muted-foreground border-b border-border">
                    <th className="pb-2 pe-2 w-6"></th>
                    <th className="pb-2 pe-4">{t("When", "متى")}</th>
                    <th className="pb-2 pe-4">{t("Who", "من")}</th>
                    <th className="pb-2 pe-4">{t("Action", "الإجراء")}</th>
                    <th className="pb-2 pe-4">{t("Record", "السجل")}</th>
                    <th className="pb-2 pe-4">{t("From (IP)", "من (IP)")}</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((l) => (
                    <>
                      <tr
                        key={l.id}
                        className="border-b border-border/50 cursor-pointer hover:bg-secondary/30"
                        onClick={() => setExpanded(expanded === l.id ? null : l.id)}
                      >
                        <td className="py-2 pe-2 text-muted-foreground">
                          {expanded === l.id ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                        </td>
                        <td className="py-2 pe-4 text-xs whitespace-nowrap">
                          <DualDate date={l.createdAt.slice(0, 10)} />
                          <span className="text-muted-foreground ms-1">{l.createdAt.slice(11, 19)}</span>
                        </td>
                        <td className="py-2 pe-4">
                          {/* An unresolved actor stays a number, honestly —
                              never a name borrowed from outside this org. */}
                          {l.actorName ?? (l.userId != null ? `${t("User", "مستخدم")} #${l.userId}` : t("system", "النظام"))}
                        </td>
                        <td className="py-2 pe-4">
                          <Badge className={`text-xs ${ACTION_STYLES[l.action] ?? "bg-secondary text-muted-foreground"}`}>
                            {l.action.replace(/_/g, " ")}
                          </Badge>
                        </td>
                        <td className="py-2 pe-4 font-mono text-xs">
                          {l.entityType.replace(/_/g, " ")} <span className="text-muted-foreground">#{l.entityId}</span>
                        </td>
                        <td className="py-2 pe-4 font-mono text-xs text-muted-foreground">{l.ipAddress ?? "—"}</td>
                      </tr>
                      {expanded === l.id && (
                        <tr key={`${l.id}-detail`} className="border-b border-border/50 bg-secondary/20">
                          <td></td>
                          <td colSpan={5} className="py-3 pe-4">
                            <div className="grid md:grid-cols-2 gap-3 text-xs">
                              <div>
                                <p className="text-muted-foreground mb-1">{t("Before", "قبل")}</p>
                                <pre className="bg-background rounded p-2 overflow-x-auto max-h-64 whitespace-pre-wrap break-all">
                                  {l.beforeState ? JSON.stringify(l.beforeState, null, 2) : t("(nothing — the record was created)", "(لا شيء — أُنشئ السجل)")}
                                </pre>
                              </div>
                              <div>
                                <p className="text-muted-foreground mb-1">{t("After", "بعد")}</p>
                                <pre className="bg-background rounded p-2 overflow-x-auto max-h-64 whitespace-pre-wrap break-all">
                                  {l.afterState ? JSON.stringify(l.afterState, null, 2) : t("(nothing — the record was removed)", "(لا شيء — أُزيل السجل)")}
                                </pre>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {total > PAGE_SIZE && (
            <div className="flex items-center justify-between pt-3">
              <span className="text-xs text-muted-foreground">
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
        </CardContent>
      </Card>
    </div>
  );
}
