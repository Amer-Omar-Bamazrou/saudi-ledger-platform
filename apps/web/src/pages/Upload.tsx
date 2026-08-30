import { useState, useCallback, useRef } from "react";
import { useUploadTransactions } from "@workspace/api-client-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  UploadCloud, FileText, Loader2, Plus, Trash2,
  Download, CheckCircle2, XCircle, File, X, FileSpreadsheet,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { getListTransactionsQueryKey } from "@workspace/api-client-react";
import Papa from "papaparse";
import { parseStatementRow } from "@/lib/statementParser";
import * as XLSX from "xlsx";

/* ─── types ──────────────────────────────────────────────────────────────── */
interface TxRow {
  date: string;
  description: string;
  descriptionAr?: string;
  amount: number;
  type: "debit" | "credit";
  currency: string;
  _error?: string;
}

/* ─── template data ─────────────────────────────────────────────────────── */
const TEMPLATE_ROWS = [
  ["date", "description", "amount", "type", "currency"],
  ["2026-01-01", "Office Supplies — Al-Amoudi Stationery", "1500.50", "debit", "SAR"],
  ["2026-01-05", "Client Payment — Aramco Contract", "45000.00", "credit", "SAR"],
  ["2026-01-10", "STC Monthly Telecom Bill", "850.00", "debit", "SAR"],
  ["2026-01-15", "Saudi Electricity Company", "320.75", "debit", "SAR"],
  ["2026-01-20", "Government Grant Receipt", "10000.00", "credit", "SAR"],
];

function downloadCsvTemplate() {
  const csv = TEMPLATE_ROWS.map(r => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "ksa_ledger_template.csv"; a.click();
  URL.revokeObjectURL(url);
}

function downloadXlsxTemplate() {
  const ws = XLSX.utils.aoa_to_sheet(TEMPLATE_ROWS);
  ws["!cols"] = [{ wch: 12 }, { wch: 45 }, { wch: 12 }, { wch: 8 }, { wch: 10 }];
  // Style header row bold
  const hdr = ["A1","B1","C1","D1","E1"];
  hdr.forEach(cell => {
    if (ws[cell]) ws[cell].s = { font: { bold: true }, fill: { fgColor: { rgb: "1E293B" } } };
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Transactions");
  XLSX.writeFile(wb, "ksa_ledger_template.xlsx");
}

/* ─── row parser ─────────────────────────────────────────────────────────── */
// M15: real-export parsing moved into `statementParser` (signed single-column
// amounts, Debit/Credit columns, non-ISO and HIJRI dates, Arabic-Indic digits,
// European decimals, Arabic description extraction) — the old inline parser
// accepted only our own template and rejected or silently corrupted genuine
// Saudi bank exports.
function parseRawRows(raw: Record<string, string>[]): TxRow[] {
  return raw.map((r) => {
    const p = parseStatementRow(r);
    return {
      date: p.date,
      description: p.description,
      descriptionAr: p.descriptionAr,
      amount: p.amount,
      type: p.type,
      currency: p.currency,
      _error: p.error,
    };
  });
}

/* ─── component ──────────────────────────────────────────────────────────── */
type Tab = "file" | "paste" | "manual";

export default function Upload() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = useLanguage();
  const [tab, setTab] = useState<Tab>("file");
  const [autoCategorize, setAutoCategorize] = useState(true);
  // M16.2 — which bank account is this statement from? A statement belongs to
  // ONE account; naming it scopes duplicate detection and is the foundation
  // for transfer-leg pairing and the A2 bank feed.
  const [bankAccountId, setBankAccountId] = useState<string>("");
  const { data: bankAccounts } = useQuery<Array<{ id: number; name: string; bankName: string }>>({
    queryKey: ["bank-accounts"],
    queryFn: () => apiFetch("/bank-accounts"),
  });

  /* file tab state */
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<TxRow[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* paste tab state */
  const [csvData, setCsvData] = useState("");

  /* manual tab state */
  const [manualRows, setManualRows] = useState<Array<{ date: string; description: string; amount: string; type: "debit" | "credit" }>>([
    { date: new Date().toISOString().split("T")[0], description: "", amount: "", type: "debit" },
  ]);

  const uploadMut = useUploadTransactions({
    mutation: {
      onSuccess: (res) => {
        toast({ title: t("Import successful", "تم الاستيراد بنجاح"), description: `${res.inserted} ${t("rows inserted", "صفوف مُدرجة")} · ${res.categorized} ${t("auto-categorised", "مصنّف تلقائياً")}` });
        if (res.errors?.length) toast({ title: `${res.errors.length} ${t("row errors", "أخطاء في الصفوف")}`, description: res.errors[0], variant: "destructive" });
        /**
         * 🔴 The skipped rows, finally SHOWN.
         *
         * The API has returned `duplicates` since the audit that added it — the
         * stated mitigation for rows the import drops — and no page has ever
         * read it. An unread field standing in for a fix is worse than no fix:
         * it makes the gap look closed, which is why S-1's real defect (a
         * genuinely repeated statement line being dropped) survived as long as
         * it did. Now that the ingest counts by MULTIPLICITY, this list means
         * something narrower and true: rows this account already held.
         */
        if (res.duplicates?.length) {
          const first = res.duplicates[0]!;
          toast({
            title: `${res.duplicates.length} ${t("already in this account — skipped", "موجودة بالفعل في هذا الحساب — تم تخطيها")}`,
            description: `${first.date} · ${first.description} · ${first.amount}${
              res.duplicates.length > 1
                ? ` ${t(`and ${res.duplicates.length - 1} more`, `و${res.duplicates.length - 1} أخرى`)}`
                : ""
            }`,
          });
        }
        setPreview([]); setFileName(null); setCsvData("");
        setManualRows([{ date: new Date().toISOString().split("T")[0], description: "", amount: "", type: "debit" }]);
        qc.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
      },
      onError: (err: any) => toast({ title: t("Import failed", "فشل الاستيراد"), description: err?.message ?? t("Check your data.", "تحقق من بياناتك."), variant: "destructive" }),
    },
  });

  /* ── file parsing ───────────────────────────────────────────────────── */
  const processFile = useCallback((file: File) => {
    setFileName(file.name);
    const ext = file.name.split(".").pop()?.toLowerCase();

    if (ext === "csv" || ext === "txt") {
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target?.result as string;
        const result = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true, transformHeader: h => h.trim() });
        setPreview(parseRawRows(result.data));
      };
      reader.readAsText(file);
    } else if (ext === "xlsx" || ext === "xls") {
      const reader = new FileReader();
      reader.onload = (e) => {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const raw = XLSX.utils.sheet_to_json<Record<string, string>>(ws, { defval: "" });
        setPreview(parseRawRows(raw));
      };
      reader.readAsArrayBuffer(file);
    } else {
      toast({ title: t("Unsupported file type", "نوع ملف غير مدعوم"), description: t("Upload a .csv, .xls, or .xlsx file.", "قم بتحميل ملف .csv أو .xls أو .xlsx."), variant: "destructive" });
    }
  }, [toast, t]);

  /* ── drag events ────────────────────────────────────────────────────── */
  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); setDragging(true); };
  const onDragLeave = () => setDragging(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  };
  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    e.target.value = "";
  };

  /* ── submit helpers ─────────────────────────────────────────────────── */
  const submitRows = (rows: TxRow[]) => {
    const valid = rows.filter(r => !r._error);
    if (!valid.length) { toast({ title: t("No valid rows to import", "لا توجد صفوف صالحة للاستيراد"), variant: "destructive" }); return; }
    uploadMut.mutate({
      data: {
        rows: valid.map(({ _error, ...r }) => r),
        autoCategrize: autoCategorize,
        bankAccountId: bankAccountId ? Number(bankAccountId) : null,
      },
    });
  };

  const submitPaste = () => {
    if (!csvData.trim()) return;
    const result = Papa.parse<Record<string, string>>(csvData.trim(), { header: true, skipEmptyLines: true, transformHeader: h => h.trim() });
    // fallback: no header → treat as positional
    const rows = result.meta.fields?.includes("date")
      ? parseRawRows(result.data)
      : csvData.split("\n").filter(l => l.trim()).map(line => {
          const [date, description, amountStr, typeStr, currency] = line.split(",").map(s => s.trim());
          const amount = parseFloat(amountStr);
          const type: "debit" | "credit" = typeStr?.toLowerCase() === "credit" ? "credit" : "debit";
          return { date, description, amount: isNaN(amount) ? 0 : amount, type, currency: currency || "SAR" };
        });
    submitRows(rows as TxRow[]);
  };

  const submitManual = () => {
    const rows: TxRow[] = manualRows
      .filter(r => r.date && r.description && r.amount)
      .map(r => ({ date: r.date, description: r.description, amount: parseFloat(r.amount), type: r.type, currency: "SAR" }));
    submitRows(rows);
  };

  const validCount = preview.filter(r => !r._error).length;
  const errorCount = preview.filter(r => r._error).length;

  /* ── render ─────────────────────────────────────────────────────────── */
  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <UploadCloud className="w-6 h-6 text-primary" /> {t("Data Import", "استيراد البيانات")}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">{t("Upload CSV or Excel, paste data, or enter rows manually.", "ارفع ملف CSV أو Excel، أو الصق البيانات، أو أدخل الصفوف يدوياً.")}</p>
        </div>
        {/* template downloads */}
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="gap-2 text-xs" onClick={downloadCsvTemplate}>
            <Download className="w-3.5 h-3.5" /> {t("CSV Template", "قالب CSV")}
          </Button>
          <Button variant="outline" size="sm" className="gap-2 text-xs" onClick={downloadXlsxTemplate}>
            <Download className="w-3.5 h-3.5" /><FileSpreadsheet className="w-3.5 h-3.5" /> {t("Excel Template", "قالب Excel")}
          </Button>
        </div>
      </div>

      {/* import settings */}
      <div className="flex items-center justify-between p-4 rounded-lg bg-card border gap-6">
        <div>
          <Label className="font-medium">{t("Auto-categorise on import", "تصنيف تلقائي عند الاستيراد")}</Label>
          <p className="text-xs text-muted-foreground mt-0.5">{t("Runs the categorisation engine immediately after upload.", "يُشغّل محرك التصنيف فور الرفع.")}</p>
        </div>
        <div className="flex items-center gap-6">
          <div className="w-56">
            <Label className="text-xs text-muted-foreground">{t("Bank account (which account is this statement for?)", "الحساب البنكي (لأي حساب هذا الكشف؟)")}</Label>
            <Select value={bankAccountId} onValueChange={setBankAccountId}>
              <SelectTrigger className="h-9 mt-1">
                <SelectValue placeholder={t("Not specified", "غير محدد")} />
              </SelectTrigger>
              <SelectContent>
                {(bankAccounts ?? []).map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {a.name} — {a.bankName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Switch checked={autoCategorize} onCheckedChange={setAutoCategorize} />
        </div>
      </div>

      {/* tab bar */}
      <Card>
        <CardHeader className="border-b bg-secondary/20 pb-0 pt-4 px-6">
          <div className="flex gap-6">
            {(["file", "paste", "manual"] as Tab[]).map(tabKey => (
              <button key={tabKey} onClick={() => setTab(tabKey)}
                className={`pb-3 px-1 font-medium text-sm border-b-2 transition-colors capitalize ${
                  tab === tabKey ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
                }`}>
                {tabKey === "file" ? t("File Upload", "رفع ملف") : tabKey === "paste" ? t("Paste CSV", "لصق CSV") : t("Manual Entry", "إدخال يدوي")}
              </button>
            ))}
          </div>
        </CardHeader>

        <CardContent className="pt-6">

          {/* ── FILE UPLOAD TAB ────────────────────────────────────────── */}
          {tab === "file" && (
            <div className="space-y-5">
              {/* drop zone */}
              {!preview.length && (
                <div
                  onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className={`relative flex flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed cursor-pointer transition-all py-16 px-8
                    ${dragging
                      ? "border-primary bg-primary/5 scale-[1.01]"
                      : "border-border hover:border-primary/50 hover:bg-secondary/30"}`}
                >
                  <input ref={fileInputRef} type="file" accept=".csv,.xls,.xlsx,.txt" className="hidden" onChange={onFileChange} />
                  <div className={`p-4 rounded-full transition-colors ${dragging ? "bg-primary/20" : "bg-secondary"}`}>
                    <UploadCloud className={`w-10 h-10 transition-colors ${dragging ? "text-primary" : "text-muted-foreground"}`} />
                  </div>
                  <div className="text-center">
                    <p className="font-semibold text-foreground">
                      {dragging ? t("Drop to import", "أسقط للاستيراد") : t("Drag & drop your file here", "اسحب وأسقط ملفك هنا")}
                    </p>
                    <p className="text-sm text-muted-foreground mt-1">{t("or click to browse — CSV, XLS, XLSX supported", "أو انقر للتصفح — يدعم CSV وXLS وXLSX")}</p>
                  </div>
                  <div className="flex gap-2">
                    {[".csv", ".xlsx", ".xls"].map(ext => (
                      <span key={ext} className="text-xs font-mono px-2 py-0.5 rounded bg-secondary text-muted-foreground border border-border">{ext}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* preview table */}
              {preview.length > 0 && (
                <div className="space-y-4">
                  {/* file info bar */}
                  <div className="flex items-center justify-between p-3 rounded-lg bg-secondary/40 border border-border">
                    <div className="flex items-center gap-3">
                      <File className="w-4 h-4 text-primary" />
                      <span className="text-sm font-medium text-foreground">{fileName}</span>
                      <Badge variant="outline" className="text-xs text-emerald-400 border-emerald-400/30">{validCount} {t("valid", "صالح")}</Badge>
                      {errorCount > 0 && <Badge variant="outline" className="text-xs text-red-400 border-red-400/30">{errorCount} {t("errors", "أخطاء")}</Badge>}
                    </div>
                    <Button variant="ghost" size="sm" className="gap-1 text-xs text-muted-foreground" onClick={() => { setPreview([]); setFileName(null); }}>
                      <X className="w-3.5 h-3.5" /> {t("Clear", "مسح")}
                    </Button>
                  </div>

                  {/* rows */}
                  <div className="rounded-lg border border-border overflow-hidden">
                    <div className="overflow-x-auto max-h-80 overflow-y-auto">
                      <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-secondary border-b border-border">
                          <tr>
                            {[t("Status", "الحالة"), t("Date", "التاريخ"), t("Description", "الوصف"), t("Amount", "المبلغ"), t("Type", "النوع"), t("Currency", "العملة")].map(h => (
                              <th key={h} className="text-start px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/50">
                          {preview.map((row, i) => (
                            <tr key={i} className={`transition-colors ${row._error ? "bg-red-500/5" : "hover:bg-secondary/30"}`}>
                              <td className="px-3 py-2">
                                {row._error
                                  ? <span title={row._error}><XCircle className="w-4 h-4 text-red-400" /></span>
                                  : <CheckCircle2 className="w-4 h-4 text-emerald-400" />}
                              </td>
                              <td className="px-3 py-2 font-mono text-xs text-muted-foreground whitespace-nowrap">{row.date || "—"}</td>
                              <td className="px-3 py-2 max-w-xs truncate" title={row.description}>{row.description || <span className="text-muted-foreground italic">{t("empty", "فارغ")}</span>}</td>
                              <td className="px-3 py-2 font-mono text-end tabular-nums">{row.amount > 0 ? row.amount.toLocaleString("en-SA", { minimumFractionDigits: 2 }) : "—"}</td>
                              <td className="px-3 py-2">
                                <span className={`text-xs font-medium ${row.type === "credit" ? "text-emerald-400" : "text-red-400"}`}>
                                  {row.type}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-xs text-muted-foreground">{row.currency}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {errorCount > 0 && (
                    <p className="text-xs text-muted-foreground">
                      <span className="text-red-400 font-medium">{errorCount} {t("rows", "صفوف")}</span> {t("have errors and will be skipped. Fix your file and re-upload to import them.", "تحتوي على أخطاء وسيتم تخطيها. صحّح ملفك وأعد رفعه لاستيرادها.")}
                    </p>
                  )}

                  <div className="flex items-center justify-between pt-1">
                    <Button variant="outline" size="sm" className="gap-2" onClick={() => fileInputRef.current?.click()}>
                      <UploadCloud className="w-4 h-4" /> {t("Replace file", "استبدال الملف")}
                      <input ref={fileInputRef} type="file" accept=".csv,.xls,.xlsx,.txt" className="hidden" onChange={onFileChange} />
                    </Button>
                    <Button onClick={() => submitRows(preview)} disabled={uploadMut.isPending || validCount === 0} className="gap-2">
                      {uploadMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <UploadCloud className="w-4 h-4" />}
                      {t("Import", "استيراد")} {validCount} {validCount !== 1 ? t("rows", "صفوف") : t("row", "صف")}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── PASTE CSV TAB ───────────────────────────────────────────── */}
          {tab === "paste" && (
            <div className="space-y-4">
              <div className="bg-secondary/40 p-4 rounded-lg border border-border text-sm font-mono text-muted-foreground flex gap-3 items-start">
                <FileText className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                <div>
                  <p className="text-foreground mb-2 font-sans font-semibold text-sm">{t("Accepted formats", "الصيغ المقبولة")}</p>
                  <p className="text-xs">{t("With header:", "مع رأس:")}&nbsp;&nbsp; <span className="text-foreground">date, description, amount, type, currency</span></p>
                  <p className="text-xs mt-1">{t("Without header:", "بدون رأس:")} <span className="text-foreground">2026-01-01, Office Supplies, 1500.50, debit, SAR</span></p>
                </div>
              </div>
              <Textarea
                placeholder={"date,description,amount,type,currency\n2026-01-01,Office Supplies,1500.50,debit,SAR\n2026-01-05,Client Payment,45000.00,credit,SAR"}
                className="min-h-64 font-mono text-sm"
                value={csvData}
                onChange={e => setCsvData(e.target.value)}
              />
              <div className="flex justify-end">
                <Button onClick={submitPaste} disabled={!csvData.trim() || uploadMut.isPending} className="gap-2">
                  {uploadMut.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                  {t("Process import", "معالجة الاستيراد")}
                </Button>
              </div>
            </div>
          )}

          {/* ── MANUAL ENTRY TAB ────────────────────────────────────────── */}
          {tab === "manual" && (
            <div className="space-y-4">
              <div className="space-y-2">
                {manualRows.map((row, idx) => (
                  <div key={idx} className="flex gap-2 items-center bg-secondary/20 p-3 rounded-lg border border-border group">
                    <div className="flex-1 grid grid-cols-12 gap-2 items-center">
                      <div className="col-span-2">
                        <Input type="date" value={row.date} className="h-8 text-sm"
                          onChange={e => { const r = [...manualRows]; r[idx].date = e.target.value; setManualRows(r); }} />
                      </div>
                      <div className="col-span-5">
                        <Input placeholder={t("Description", "الوصف")} value={row.description} className="h-8 text-sm"
                          onChange={e => { const r = [...manualRows]; r[idx].description = e.target.value; setManualRows(r); }} />
                      </div>
                      <div className="col-span-3">
                        <Input type="number" step="0.01" placeholder={t("Amount", "المبلغ")} value={row.amount} className="h-8 text-sm font-mono"
                          onChange={e => { const r = [...manualRows]; r[idx].amount = e.target.value; setManualRows(r); }} />
                      </div>
                      <div className="col-span-2">
                        <Select value={row.type} onValueChange={(v: "debit" | "credit") => { const r = [...manualRows]; r[idx].type = v; setManualRows(r); }}>
                          <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="debit">{t("Debit", "مدين")}</SelectItem>
                            <SelectItem value="credit">{t("Credit", "دائن")}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    {manualRows.length > 1 && (
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                        onClick={() => setManualRows(manualRows.filter((_, i) => i !== idx))}>
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between pt-2">
                <Button variant="outline" size="sm" className="gap-2"
                  onClick={() => setManualRows([...manualRows, { date: new Date().toISOString().split("T")[0], description: "", amount: "", type: "debit" }])}>
                  <Plus className="w-4 h-4" /> {t("Add row", "إضافة صف")}
                </Button>
                <Button onClick={submitManual} disabled={uploadMut.isPending || manualRows.every(r => !r.description)} className="gap-2">
                  {uploadMut.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                  {t("Submit", "إرسال")} {manualRows.filter(r => r.description && r.amount).length || ""} {t("entries", "إدخالات")}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* format reference card */}
      <Card className="border-border bg-card/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm text-muted-foreground font-medium">{t("Column Reference", "مرجع الأعمدة")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {[
              { col: "date", format: t("YYYY-MM-DD", "YYYY-MM-DD"), req: true },
              { col: "description", format: t("Free text", "نص حر"), req: true },
              { col: "amount", format: t("Positive number", "رقم موجب"), req: true },
              { col: "type", format: t("debit or credit", "مدين أو دائن"), req: true },
              { col: "currency", format: t("SAR (default)", "ر.س (افتراضي)"), req: false },
            ].map(({ col, format, req }) => (
              <div key={col} className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-mono font-semibold text-foreground">{col}</span>
                  {req && <span className="text-red-400 text-xs">*</span>}
                </div>
                <p className="text-xs text-muted-foreground">{format}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
