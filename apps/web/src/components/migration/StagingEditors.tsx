/**
 * Batch 1C — how staged data gets INTO a batch, and how one row is corrected.
 *
 * The backend stages each set with one PUT that REPLACES the set (chart rows,
 * parties, open items, advances). So:
 *
 *   ImportDialog   — paste or upload CSV / JSON → parsed client-side into the
 *                    PUT body (coercion only; every rule stays on the server)
 *                    → one PUT. Re-importing the chart or the parties resets
 *                    their decisions, and the dialog says so before the click.
 *   RowEditorDialog— edit / add / remove ONE row of a set: the client re-PUTs
 *                    the whole current set with that one change. Same
 *                    endpoint, same server validation, same audit record.
 *
 * Neither writes anything to the ledger: staging is zero-ledger-write by
 * construction (only `commit` posts), and any staging write re-opens a
 * validated batch to draft on the server (`touch`).
 */
import { useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Download, Upload } from "lucide-react";
import { FIELDS_OF, coerceRow, csvTemplate, parseStagedText, type FieldSpec, type StagedKind } from "@/lib/migrationImport";
import { invalidateMigration } from "./shared";

const PATH: Record<StagedKind, string> = { chart: "chart", parties: "parties", openItems: "open-items", advances: "advances" };
const TITLE: Record<StagedKind, [string, string]> = {
  chart: ["Chart of accounts", "دليل الحسابات"],
  parties: ["Customers & suppliers", "العملاء والموردون"],
  openItems: ["Open items (AR / AP)", "البنود المفتوحة (مدينة / دائنة)"],
  advances: ["Customer advances", "دفعات العملاء المقدمة"],
};

function downloadText(name: string, text: string) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

// ── import ──────────────────────────────────────────────────────────────────

export function ImportDialog({ batchId, kind, hasRows, onClose }: { batchId: number; kind: StagedKind; hasRows: boolean; onClose: () => void }) {
  const { t, lang } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const parsed = useMemo(() => parseStagedText(kind, text), [kind, text]);
  const title = TITLE[kind][lang === "ar" ? 1 : 0];

  const mut = useMutation({
    mutationFn: () => apiFetch(`/migration/batches/${batchId}/${PATH[kind]}`, { method: "PUT", body: JSON.stringify({ rows: parsed.rows }) }),
    onSuccess: () => {
      invalidateMigration(qc, batchId);
      toast({ title: t(`${parsed.rows.length} row(s) staged`, `تم تجهيز ${parsed.rows.length} صفًا`), description: t("Nothing is posted — staging never touches the ledger.", "لم يُرحَّل شيء — التجهيز لا يمس الدفاتر أبدًا.") });
      onClose();
    },
  });

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setText(await f.text());
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-2xl max-h-[calc(100vh-2rem)] overflow-y-auto" data-testid={`import-dialog-${kind}`}>
        <DialogHeader>
          <DialogTitle>{t(`Import ${title}`, `استيراد ${title}`)}</DialogTitle>
          <DialogDescription>
            {t("Paste CSV (header row = the column names below) or JSON (an array of rows), or choose a file. Rows are read on this screen only; the server validates every accounting rule when it stages them.",
               "الصق CSV (صف العناوين = أسماء الأعمدة أدناه) أو JSON (مصفوفة صفوف)، أو اختر ملفًا. تُقرأ الصفوف هنا فقط؛ ويتحقق الخادم من كل قاعدة محاسبية عند التجهيز.")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {hasRows && (
            <p className="text-xs rounded-md border border-attention/40 bg-attention-surface/10 text-attention p-2" data-testid="import-replaces-warning">
              {kind === "chart" || kind === "parties"
                ? t("Importing REPLACES the staged set and resets every mapping decision on it.", "الاستيراد يستبدل المجموعة المجهّزة ويعيد تعيين كل قرارات الربط فيها.")
                : t("Importing REPLACES the staged set (every row, not only the ones in the file).", "الاستيراد يستبدل المجموعة المجهّزة (كل الصفوف، لا الموجودة في الملف فقط).")}
            </p>
          )}
          <div className="flex flex-wrap gap-2 items-center">
            <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}><Upload className="w-3.5 h-3.5 me-1" />{t("Choose file", "اختر ملفًا")}</Button>
            <input ref={fileRef} type="file" accept=".csv,.json,text/csv,application/json" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} data-testid="import-file" />
            <Button type="button" variant="ghost" size="sm" onClick={() => downloadText(`migration-${PATH[kind]}-template.csv`, csvTemplate(kind))}><Download className="w-3.5 h-3.5 me-1" />{t("CSV template", "قالب CSV")}</Button>
          </div>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} dir="ltr" className="font-mono text-xs" placeholder={csvTemplate(kind).split("\n")[0]} data-testid="import-text" />
          <p className="text-[11px] text-muted-foreground break-words" dir="ltr">
            {t("Columns:", "الأعمدة:")} {FIELDS_OF[kind].map((f) => f.name).join(", ")}
          </p>
          {parsed.format !== "empty" && (
            <div className="text-sm space-y-1" data-testid="import-preview">
              <p>{t(`${parsed.rows.length} row(s) ready`, `${parsed.rows.length} صفًا جاهزًا`)}{parsed.errors.length > 0 && <span className="text-negative"> · {t(`${parsed.errors.length} problem(s)`, `${parsed.errors.length} مشكلة`)}</span>}</p>
              {parsed.errors.length > 0 && (
                <ul className="text-xs text-negative max-h-32 overflow-y-auto space-y-0.5" dir="ltr">
                  {parsed.errors.slice(0, 50).map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              )}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={onClose}>{t("Cancel", "إلغاء")}</Button>
            <Button size="sm" disabled={parsed.rows.length === 0 || parsed.errors.some((e) => e.startsWith("row ")) || mut.isPending} onClick={() => mut.mutate()} data-testid="import-submit">
              {mut.isPending ? t("Staging…", "جارٍ التجهيز…") : t(`Stage ${parsed.rows.length} row(s)`, `تجهيز ${parsed.rows.length} صفًا`)}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── one row ─────────────────────────────────────────────────────────────────

type Raw = Record<string, unknown>;
const getNested = (obj: Raw, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o != null && typeof o === "object" ? (o as Raw)[k] : undefined), obj);
const setNested = (obj: Raw, path: string, value: unknown) => {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};
    cur = cur[parts[i]] as Raw;
  }
  cur[parts[parts.length - 1]] = value;
};
/** A staged row as the editor's string state. */
function toFormState(fields: readonly FieldSpec[], row: Raw | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = row ? getNested(row, f.name) : undefined;
    out[f.name] = v == null ? "" : typeof v === "boolean" ? String(v) : String(v);
  }
  return out;
}
function fromFormState(fields: readonly FieldSpec[], state: Record<string, string>): Raw {
  const raw: Raw = {};
  for (const f of fields) {
    const v = state[f.name];
    if (v === "" || v == null) continue;
    setNested(raw, f.name, f.kind === "boolean" ? v === "true" : v);
  }
  return raw;
}

/** The staged row → the PUT input row. The read shape carries server-only keys (id, problems, resolvedId, …); only spec fields travel. */
export function toInputRow(kind: StagedKind, row: Raw): Raw {
  const raw: Raw = {};
  for (const f of FIELDS_OF[kind]) {
    const v = getNested(row, f.name);
    if (v != null && v !== "") setNested(raw, f.name, v);
  }
  return raw;
}

export function RowEditorDialog({
  batchId, kind, rows, index, onClose,
}: {
  batchId: number; kind: StagedKind;
  /** The CURRENT staged set (read shape). */
  rows: Raw[];
  /** Index of the row being edited; -1 adds a row. */
  index: number;
  onClose: () => void;
}) {
  const { t, lang } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const fields = FIELDS_OF[kind];
  const editing = index >= 0 ? rows[index] : null;
  const [state, setState] = useState<Record<string, string>>(() => toFormState(fields, editing));
  const [submitError, setSubmitError] = useState<string[]>([]);
  const title = TITLE[kind][lang === "ar" ? 1 : 0];

  const put = useMutation({
    mutationFn: (next: Raw[]) => apiFetch(`/migration/batches/${batchId}/${PATH[kind]}`, { method: "PUT", body: JSON.stringify({ rows: next }) }),
    onSuccess: () => {
      invalidateMigration(qc, batchId);
      toast({ title: t("Staging updated", "تم تحديث التجهيز"), description: t("The batch is a draft again until it is validated.", "أصبحت الدفعة مسودة من جديد حتى يُعاد التحقق منها.") });
      onClose();
    },
  });

  const save = () => {
    const { row, errors } = coerceRow(kind, fromFormState(fields, state), t("this row", "هذا الصف"));
    if (!row) { setSubmitError(errors); return; }
    const next = rows.map((r) => toInputRow(kind, r));
    if (index >= 0) next[index] = row; else next.push(row);
    setSubmitError([]);
    put.mutate(next);
  };
  const remove = () => {
    const next = rows.filter((_, i) => i !== index).map((r) => toInputRow(kind, r));
    put.mutate(next);
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-2xl max-h-[calc(100vh-2rem)] overflow-y-auto" data-testid={`row-editor-${kind}`}>
        <DialogHeader>
          <DialogTitle>{editing ? t(`Correct staged row — ${title}`, `تصحيح صف مجهّز — ${title}`) : t(`Add a staged row — ${title}`, `إضافة صف مجهّز — ${title}`)}</DialogTitle>
          <DialogDescription>
            {t("Saving re-stages the whole set with this change. Nothing posts; the server re-checks every row and the batch must be validated again.",
               "الحفظ يعيد تجهيز المجموعة كاملة بهذا التغيير. لا يُرحَّل شيء؛ ويعيد الخادم فحص كل صف ويجب إعادة التحقق من الدفعة.")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {fields.map((f) => (
            <Field key={f.name} spec={f} value={state[f.name] ?? ""} onChange={(v) => setState((s) => ({ ...s, [f.name]: v }))} />
          ))}
        </div>
        {submitError.length > 0 && <ul className="text-xs text-negative mt-2 space-y-0.5" data-testid="row-editor-errors">{submitError.map((e, i) => <li key={i}>{e}</li>)}</ul>}
        <div className="flex flex-wrap justify-between gap-2 pt-3">
          <div>{editing && rows.length > 1 && <Button variant="ghost" size="sm" className="text-negative" disabled={put.isPending} onClick={remove} data-testid="row-editor-remove">{t("Remove this row", "إزالة هذا الصف")}</Button>}</div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>{t("Cancel", "إلغاء")}</Button>
            <Button size="sm" disabled={put.isPending} onClick={save} data-testid="row-editor-save">{put.isPending ? t("Saving…", "جارٍ الحفظ…") : t("Save and re-stage", "حفظ وإعادة تجهيز")}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({ spec, value, onChange }: { spec: FieldSpec; value: string; onChange: (v: string) => void }) {
  const { t, lang } = useLanguage();
  const label = lang === "ar" ? spec.labelAr : spec.label;
  const id = `field-${spec.name.replace(/\./g, "-")}`;
  const hint = lang === "ar" ? spec.hintAr : spec.hint;
  const body =
    spec.kind === "boolean" ? (
      <div className="flex items-center gap-2 h-9">
        <Checkbox id={id} checked={value === "true"} onCheckedChange={(c) => onChange(c ? "true" : "false")} data-testid={id} />
        <span className="text-xs text-muted-foreground">{value === "true" ? t("Yes", "نعم") : t("No", "لا")}</span>
      </div>
    ) : spec.kind === "select" ? (
      <Select value={value === "" ? "__blank" : value} onValueChange={(v) => onChange(v === "__blank" ? "" : v)}>
        <SelectTrigger id={id} className="h-9 text-sm" data-testid={id}><SelectValue placeholder={t("Choose", "اختر")} /></SelectTrigger>
        <SelectContent>
          {(spec.options ?? []).map((o) => <SelectItem key={o.value || "__blank"} value={o.value || "__blank"}>{lang === "ar" ? o.labelAr : o.label}</SelectItem>)}
        </SelectContent>
      </Select>
    ) : (
      <Input id={id} type={spec.kind === "number" ? "number" : spec.kind === "date" ? "date" : spec.kind === "time" ? "time" : "text"} step={spec.kind === "number" ? "0.01" : spec.kind === "time" ? "1" : undefined}
        dir={spec.kind === "text" ? undefined : "ltr"} value={value} onChange={(e) => onChange(e.target.value)} className="h-9 text-sm" data-testid={id} />
    );
  return (
    <div className={spec.name === "description" || spec.name === "evidenceNote" || spec.name === "address" ? "sm:col-span-2" : ""}>
      <Label htmlFor={id} className="text-xs text-muted-foreground">{label}{spec.required ? " *" : ""}</Label>
      <div className="mt-1">{body}</div>
      {hint && <p className="text-[11px] text-muted-foreground mt-1">{hint}</p>}
    </div>
  );
}
