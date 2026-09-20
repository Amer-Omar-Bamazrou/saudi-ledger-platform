/**
 * Batch 1C — customers & suppliers of the previous system, and what each one
 * becomes here: a NEW party carrying the source identity, or an EXISTING one
 * the operator names. The platform proposes candidates (a VAT number match,
 * a name match) and never merges by itself.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Users, Upload, Pencil, Plus } from "lucide-react";
import { EmptyState, Money, Problems, focusClass, invalidateMigration, useCanRunMigration, useFocusRow, useParties, useWorkspaceNav } from "./shared";
import { ImportDialog, RowEditorDialog } from "./StagingEditors";
import type { ListCustomers200, ListVendors200, MigrationParty, MigrationPartyDecisionInput } from "@workspace/api-client-react";

function PartyDecision({ batchId, row }: { batchId: number; row: MigrationParty }) {
  const { t, n } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [pickOther, setPickOther] = useState(false);
  const [otherId, setOtherId] = useState("");
  const isCustomer = row.partyType === "customer";
  const { data: customers } = useQuery<ListCustomers200>({ queryKey: ["customers", "picker"], queryFn: () => apiFetch("/customers?limit=200"), enabled: pickOther && isCustomer });
  const { data: vendors } = useQuery<ListVendors200>({ queryKey: ["vendors", "picker"], queryFn: () => apiFetch("/vendors?limit=200"), enabled: pickOther && !isCustomer });
  const options = isCustomer ? (customers?.items ?? []).map((c) => ({ id: c.id, label: n(c.name, c.nameAr) })) : (vendors?.items ?? []).map((v) => ({ id: v.id, label: n(v.name, v.nameAr) }));

  const mut = useMutation({
    mutationFn: (body: MigrationPartyDecisionInput) => apiFetch(`/migration/batches/${batchId}/parties/${row.id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => { invalidateMigration(qc, batchId); toast({ title: t(`${row.name} decided`, `تم البتّ في ${row.name}`) }); setPickOther(false); },
  });

  return (
    <div className="flex flex-col gap-1 items-start" data-testid={`party-decision-${row.id}`}>
      {row.candidates.map((c) => (
        <Button key={c.id} variant="ghost" size="sm" className="h-7 text-xs text-primary" disabled={mut.isPending} onClick={() => mut.mutate({ decision: "use_existing", existingId: c.id })} data-testid={`use-candidate-${row.id}-${c.id}`}>
          {t(`Use existing #${c.id} ${c.name}`, `استخدام القائم #${c.id} ${c.name}`)} <span className="text-muted-foreground ms-1">({c.reason === "tax_number" ? t("same VAT number", "نفس الرقم الضريبي") : t("same name", "نفس الاسم")})</span>
        </Button>
      ))}
      <Button variant="ghost" size="sm" className="h-7 text-xs" disabled={mut.isPending || row.decision === "create"} onClick={() => mut.mutate({ decision: "create" })} data-testid={`create-party-${row.id}`}>{t("Create as new", "إنشاء كجديد")}</Button>
      {!pickOther ? (
        <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={() => setPickOther(true)} data-testid={`pick-existing-${row.id}`}>{t("Use another existing…", "استخدام طرف قائم آخر…")}</Button>
      ) : (
        <div className="flex gap-1 items-center">
          <Select value={otherId} onValueChange={setOtherId}>
            <SelectTrigger className="h-8 text-xs w-48" data-testid={`existing-picker-${row.id}`}><SelectValue placeholder={isCustomer ? t("Existing customer", "عميل قائم") : t("Existing supplier", "مورّد قائم")} /></SelectTrigger>
            <SelectContent>{options.map((o) => <SelectItem key={o.id} value={String(o.id)}>#{o.id} {o.label}</SelectItem>)}</SelectContent>
          </Select>
          <Button size="sm" className="h-8 text-xs" disabled={!otherId || mut.isPending} onClick={() => mut.mutate({ decision: "use_existing", existingId: Number(otherId) })}>{t("Use", "استخدام")}</Button>
        </div>
      )}
    </div>
  );
}

export function PartiesSection({ batchId, editable }: { batchId: number; editable: boolean }) {
  const { t, lang } = useLanguage();
  const canRun = useCanRunMigration();
  const { focus, blockedOnly } = useWorkspaceNav();
  const { data, isLoading, error } = useParties(batchId);
  const [importing, setImporting] = useState(false);
  const [editingRow, setEditingRow] = useState<number | null>(null);
  const [onlyBlocked, setOnlyBlocked] = useState(blockedOnly);
  const [type, setType] = useState<"all" | "customer" | "vendor">("all");
  useFocusRow(focus, !!data);
  const can = editable && canRun;
  const rows = useMemo(() => (data?.rows ?? []).filter((r) => (!onlyBlocked || r.problems.length > 0) && (type === "all" || r.partyType === type)), [data, onlyBlocked, type]);
  // Walk defect 2026-09-20: with "problems only" on, correcting the last problem left an EMPTY table with a 0.00
  // total. The filter switches itself off once nothing is blocked, so the corrected row is what the operator sees.
  useEffect(() => { if (onlyBlocked && data && data.summary.blocked === 0) setOnlyBlocked(false); }, [onlyBlocked, data]);

  if (isLoading) return <p className="text-sm text-muted-foreground p-4">{t("Loading…", "جارٍ التحميل…")}</p>;
  if (error || !data) return <p className="text-sm text-destructive p-4">{t("The parties could not be loaded.", "تعذر تحميل الأطراف.")} {(error as Error)?.message}</p>;
  const s = data.summary;
  const decisionText = (r: MigrationParty) =>
    r.decision === "create" ? t("Create new", "إنشاء جديد") : r.decision === "use_existing" ? t(`Use existing #${r.existingId}`, `استخدام القائم #${r.existingId}`) : t("Undecided", "لم يُقرَّر");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t("Customers & suppliers", "العملاء والموردون")}</h2>
          <p className="text-sm text-muted-foreground">{t("Each party keeps its source identity (system + id). A match is proposed, never applied: you decide whether it is the same party.", "يحتفظ كل طرف بهويته المصدرية (النظام + المعرّف). يُقترح التطابق ولا يُطبَّق: أنت تقرر إن كان الطرف نفسه.")}</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {can && <Button size="sm" variant="outline" onClick={() => setEditingRow(-1)} data-testid="parties-add-row"><Plus className="w-3.5 h-3.5 me-1" />{t("Add party", "إضافة طرف")}</Button>}
          {can && <Button size="sm" onClick={() => setImporting(true)} data-testid="parties-import"><Upload className="w-3.5 h-3.5 me-1" />{t("Import parties", "استيراد الأطراف")}</Button>}
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[[t("Customers", "العملاء"), s.customers], [t("Suppliers", "الموردون"), s.vendors], [t("Undecided", "لم يُقرَّر"), s.undecided, s.undecided > 0 ? "text-negative" : "text-positive"], [t("Using existing", "يستخدم قائمًا"), s.useExisting]].map(([l, v, c], i) => (
          <Card key={i}><CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground">{l}</CardTitle></CardHeader><CardContent><div className={`text-lg font-semibold font-mono ${c ?? ""}`}>{v}</div></CardContent></Card>
        ))}
      </div>
      {data.rows.length === 0 ? (
        <EmptyState icon={Users} title={t("No parties staged yet", "لم يُجهَّز أي طرف بعد")} hint={t("Import the customers and suppliers that open items and advances refer to, with the old system's ids.", "استورد العملاء والموردين الذين تشير إليهم البنود المفتوحة والدفعات المقدمة، بمعرّفات النظام السابق.")}
          action={can ? <Button size="sm" onClick={() => setImporting(true)}><Upload className="w-3.5 h-3.5 me-1" />{t("Import parties", "استيراد الأطراف")}</Button> : undefined} />
      ) : (
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2 flex-wrap">
            <div className="flex gap-1">
              {(["all", "customer", "vendor"] as const).map((k) => <Button key={k} variant={type === k ? "default" : "ghost"} size="sm" className="h-7 text-xs" onClick={() => setType(k)}>{k === "all" ? t("All", "الكل") : k === "customer" ? t("Customers", "العملاء") : t("Suppliers", "الموردون")}</Button>)}
            </div>
            <Button variant={onlyBlocked ? "default" : "ghost"} size="sm" className="h-7 text-xs" onClick={() => setOnlyBlocked((v) => !v)} data-testid="parties-only-blocked">{t(`Problems only (${s.blocked})`, `المشاكل فقط (${s.blocked})`)}</Button>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                    {[t("Source id", "المعرّف المصدري"), t("Name", "الاسم"), t("Type", "النوع"), t("VAT / CR", "الرقم الضريبي / السجل"), t("Open items", "البنود المفتوحة"), t("Decision", "القرار"), t("State", "الحالة"), ""].map((h, i) => <th key={i} className="text-start pb-2 pe-3 font-medium">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} id={`staged-${r.id}`} className={`border-b border-border/50 align-top ${focusClass(r.id, focus)}`} data-testid={`party-row-${r.sourceId}`}>
                      <td className="py-2 pe-3 font-mono text-xs" dir="ltr">{r.sourceId}{r.resolvedId != null && <span className="block text-[11px] text-muted-foreground">→ #{r.resolvedId}</span>}</td>
                      <td className="py-2 pe-3 max-w-[14rem] break-words">{lang === "ar" && r.nameAr ? r.nameAr : r.name}{r.city && <span className="block text-[11px] text-muted-foreground">{r.city}</span>}</td>
                      <td className="py-2 pe-3"><Badge variant="outline" className="text-xs">{r.partyType === "customer" ? t("Customer", "عميل") : t("Supplier", "مورّد")}</Badge></td>
                      <td className="py-2 pe-3 font-mono text-xs" dir="ltr">{r.taxNumber ?? "—"}{r.crNumber ? ` / ${r.crNumber}` : ""}</td>
                      <td className="py-2 pe-3 text-xs">{r.openItems} · <Money v={r.openTotal} />{r.advances > 0 && <span className="block text-muted-foreground">{t("advances", "دفعات مقدمة")}: {r.advances} · <Money v={r.advanceTotal} /></span>}</td>
                      <td className="py-2 pe-3 text-xs">{decisionText(r)}</td>
                      <td className="py-2 pe-3"><Problems list={r.problems} id={r.id} /></td>
                      <td className="py-2">
                        {can && (
                          <div className="flex flex-col gap-1 items-start">
                            <PartyDecision batchId={batchId} row={r} />
                            <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={() => setEditingRow(data.rows.indexOf(r))} data-testid={`edit-party-${r.id}`}><Pencil className="w-3 h-3 me-1" />{t("Edit row", "تعديل الصف")}</Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
      {importing && <ImportDialog batchId={batchId} kind="parties" hasRows={data.rows.length > 0} onClose={() => setImporting(false)} />}
      {editingRow != null && <RowEditorDialog batchId={batchId} kind="parties" rows={data.rows as unknown as Record<string, unknown>[]} index={editingRow} onClose={() => setEditingRow(null)} />}
    </div>
  );
}
