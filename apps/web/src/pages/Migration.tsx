/**
 * Batch 1C — `/migration`: this company's migration batches, and the one act
 * that starts one (source system + cut-over date). One committed migration
 * per company at a time; a reversed one can be replaced by a corrected
 * re-run, which the server links to it automatically.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { apiFetch } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Database, Plus } from "lucide-react";
import { DualDate } from "@/components/DualDate";
import { BatchStatusBadge, EmptyState, MigrationPermissionHint, migrationKeys, useCanRunMigration } from "@/components/migration/shared";
import type { CreateMigrationBatchInput, MigrationBatch } from "@workspace/api-client-react";

export default function Migration() {
  const { t, lang } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const canRun = useCanRunMigration();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ sourceSystem: "", sourceVersion: "", cutoverDate: "", notes: "" });
  const { data: batches = [], isLoading, error } = useQuery<MigrationBatch[]>({ queryKey: migrationKeys.list, queryFn: () => apiFetch("/migration/batches") });

  const create = useMutation({
    mutationFn: (body: CreateMigrationBatchInput) => apiFetch<MigrationBatch>("/migration/batches", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (b) => { qc.invalidateQueries({ queryKey: ["migration"] }); setOpen(false); toast({ title: t(`Migration #${b.id} created`, `تم إنشاء الترحيل #${b.id}`) }); navigate(`/migration/${b.id}?section=chart`); },
  });
  const valid = form.sourceSystem.trim().length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(form.cutoverDate);
  const fmtTs = (v: string) => new Date(v).toLocaleString(lang === "ar" ? "ar-SA-u-ca-gregory-nu-latn" : "en-SA", { dateStyle: "medium", timeStyle: "short" });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Migration & Opening Balances", "الترحيل والأرصدة الافتتاحية")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("Bring a business with history in: the previous system's chart and closing balances, its customers and suppliers, the open receivables and payables, advances, bank balances and VAT position — staged, validated, then committed as ONE opening journal with the subledgers behind it.", "أدخِل منشأة لها تاريخ: دليل النظام السابق وأرصدته الختامية، وعملاءه وموردوه، والذمم المدينة والدائنة المفتوحة، والدفعات المقدمة، وأرصدة البنوك، والموقف الضريبي — تُجهَّز وتُتحقق ثم تُعتمد كقيد افتتاح واحد ومعه الدفاتر المساعدة.")}</p>
        </div>
        <Button className="gap-2" disabled={!canRun} onClick={() => setOpen(true)} data-testid="new-migration"><Plus className="w-4 h-4" />{t("Start a migration", "بدء ترحيل")}</Button>
      </div>
      <MigrationPermissionHint />

      {isLoading ? <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>
        : error ? <p className="text-sm text-destructive">{t("Migrations could not be loaded.", "تعذر تحميل عمليات الترحيل.")} {(error as Error).message}</p>
        : batches.length === 0 ? (
          <Card><CardContent>
            <EmptyState icon={Database} title={t("No migration yet", "لا يوجد ترحيل بعد")} hint={t("Start one with the previous system's name and the cut-over date (the first day this company runs here). The opening date is the day before.", "ابدأ واحدًا باسم النظام السابق وتاريخ القطع (أول يوم تعمل فيه الشركة هنا). تاريخ الافتتاح هو اليوم السابق.")}
              action={canRun ? <Button size="sm" onClick={() => setOpen(true)}><Plus className="w-3.5 h-3.5 me-1" />{t("Start a migration", "بدء ترحيل")}</Button> : undefined} />
          </CardContent></Card>
        ) : (
          <Card><CardContent className="pt-4">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border text-muted-foreground text-xs uppercase">{[t("Batch", "الدفعة"), t("Status", "الحالة"), t("Source system", "النظام المصدر"), t("Opening date", "تاريخ الافتتاح"), t("Created", "تاريخ الإنشاء"), t("Validated", "تم التحقق"), t("Committed", "معتمد"), ""].map((h, i) => <th key={i} className="text-start pb-2 pe-3 font-medium">{h}</th>)}</tr></thead>
                <tbody>
                  {batches.map((b) => (
                    <tr key={b.id} className="border-b border-border/50 hover:bg-secondary/20" data-testid={`batch-row-${b.id}`}>
                      <td className="py-3 pe-3 font-mono text-xs">#{b.id}{b.replacesBatchId != null && <span className="block text-[11px] text-muted-foreground">{t(`replaces #${b.replacesBatchId}`, `يستبدل #${b.replacesBatchId}`)}</span>}</td>
                      <td className="py-3 pe-3"><BatchStatusBadge status={b.status} /></td>
                      <td className="py-3 pe-3">{b.sourceSystem}{b.sourceVersion ? ` ${b.sourceVersion}` : ""}</td>
                      <td className="py-3 pe-3 text-xs text-muted-foreground"><DualDate date={b.openingDate} inline /></td>
                      <td className="py-3 pe-3 text-xs text-muted-foreground">{fmtTs(b.createdAt)}</td>
                      <td className="py-3 pe-3 text-xs text-muted-foreground">{b.validatedAt ? fmtTs(b.validatedAt) : "—"}</td>
                      <td className="py-3 pe-3 text-xs text-muted-foreground">{b.committedAt ? fmtTs(b.committedAt) : "—"}</td>
                      <td className="py-3"><Link href={`/migration/${b.id}`} className="text-xs text-primary hover:underline" data-testid={`open-batch-${b.id}`}>{t("Open →", "فتح ←")}</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent></Card>
        )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md" data-testid="new-migration-dialog">
          <DialogHeader>
            <DialogTitle>{t("Start a migration", "بدء ترحيل")}</DialogTitle>
            <DialogDescription>{t("Nothing is posted by starting a batch. The cut-over date is the first day this company runs on Saudi Ledger; the opening position is stated as at the day before.", "لا يُرحَّل شيء ببدء دفعة. تاريخ القطع هو أول يوم تعمل فيه الشركة على Saudi Ledger؛ ويُذكر المركز الافتتاحي كما في اليوم السابق.")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div><Label className="text-xs text-muted-foreground" htmlFor="mig-source">{t("Previous system *", "النظام السابق *")}</Label><Input id="mig-source" value={form.sourceSystem} onChange={(e) => setForm({ ...form, sourceSystem: e.target.value })} placeholder={t("e.g. Sage 50, Excel, Odoo", "مثال: Sage 50، Excel، Odoo")} className="mt-1 h-9 text-sm" data-testid="mig-source-system" /></div>
            <div><Label className="text-xs text-muted-foreground" htmlFor="mig-version">{t("Version (optional)", "الإصدار (اختياري)")}</Label><Input id="mig-version" value={form.sourceVersion} onChange={(e) => setForm({ ...form, sourceVersion: e.target.value })} className="mt-1 h-9 text-sm" data-testid="mig-source-version" /></div>
            <div><Label className="text-xs text-muted-foreground" htmlFor="mig-cutover">{t("Cut-over date *", "تاريخ القطع *")}</Label><Input id="mig-cutover" type="date" dir="ltr" value={form.cutoverDate} onChange={(e) => setForm({ ...form, cutoverDate: e.target.value })} className="mt-1 h-9 text-sm" data-testid="mig-cutover" />{form.cutoverDate && /^\d{4}-\d{2}-\d{2}$/.test(form.cutoverDate) && <p className="text-[11px] text-muted-foreground mt-1">{t("Opening date:", "تاريخ الافتتاح:")} <span dir="ltr">{new Date(Date.parse(form.cutoverDate) - 86_400_000).toISOString().slice(0, 10)}</span></p>}</div>
            <div><Label className="text-xs text-muted-foreground" htmlFor="mig-notes">{t("Notes", "ملاحظات")}</Label><Textarea id="mig-notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} className="mt-1 text-sm" /></div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>{t("Cancel", "إلغاء")}</Button>
            <Button size="sm" disabled={!valid || create.isPending} onClick={() => create.mutate({ sourceSystem: form.sourceSystem.trim(), sourceVersion: form.sourceVersion.trim() || null, cutoverDate: form.cutoverDate, notes: form.notes.trim() || null })} data-testid="create-migration">{create.isPending ? t("Creating…", "جارٍ الإنشاء…") : t("Create batch", "إنشاء الدفعة")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
