/**
 * Batch 1C — the migration workspace's PURE helpers (no React, no DOM), so
 * the web unit runner can pin them.
 *
 * Three things live here:
 *
 *   1. THE FIELD SPECS of the four staged sets (chart rows, parties, open
 *      items, advances). One spec per set drives the import parser, the row
 *      editor's form and the CSV template — so a column cannot exist in one
 *      of them and not the others.
 *   2. THE PARSER: CSV (papaparse, header row) or JSON (an array of rows, or
 *      `{ rows: [...] }`) → typed rows for the PUT endpoints, with per-row
 *      errors named by line. Coercion only — every accounting rule stays on
 *      the server, which re-derives each row's `problems` on read.
 *   3. THE READ-SIDE LABELS AND MAPS: the Art. 40(9) relief flag as
 *      Yes / No / Unknown, which staging section a server check points at,
 *      the ageing bucket, and the system-account targets a chart row may map
 *      to — a list that can never contain OPENING_BALANCE_EQUITY (there is no
 *      such account since accountant A5) or CASH (a header).
 */
import Papa from "papaparse";
import type {
  Category,
  MigrationAdvanceInput,
  MigrationChartRowInput,
  MigrationControlCheck,
  MigrationOpenItemInput,
  MigrationPartyInput,
} from "@workspace/api-client-react";

export type Lang = "en" | "ar";

// ── 1. field specs ──────────────────────────────────────────────────────────

export type FieldKind = "text" | "number" | "date" | "boolean" | "select" | "time";

export interface FieldSpec {
  /** The API field name (camelCase). `historicalVat.amount` addresses a nested key. */
  name: string;
  label: string;
  labelAr: string;
  kind: FieldKind;
  required?: boolean;
  options?: readonly { value: string; label: string; labelAr: string }[];
  /** Shown under the input. */
  hint?: string;
  hintAr?: string;
}

const yesNoUnknown = [
  { value: "", label: "Unknown / not provided", labelAr: "غير معروف / غير مُقدَّم" },
  { value: "true", label: "Yes — relief was claimed", labelAr: "نعم — تمت المطالبة بالإعفاء" },
  { value: "false", label: "No — not claimed", labelAr: "لا — لم تتم المطالبة" },
] as const;

export const CHART_FIELDS: readonly FieldSpec[] = [
  { name: "sourceCode", label: "Source account code", labelAr: "رمز الحساب في النظام السابق", kind: "text", required: true },
  { name: "sourceName", label: "Source account name", labelAr: "اسم الحساب في النظام السابق", kind: "text", required: true },
  { name: "sourceNameAr", label: "Arabic name", labelAr: "الاسم بالعربية", kind: "text" },
  { name: "sourceParentCode", label: "Parent code", labelAr: "رمز الحساب الأب", kind: "text" },
  {
    name: "sourceType", label: "Account type (as the file states it)", labelAr: "نوع الحساب (كما يذكره الملف)", kind: "select", required: true,
    options: [
      { value: "asset", label: "Asset", labelAr: "أصل" }, { value: "liability", label: "Liability", labelAr: "التزام" }, { value: "equity", label: "Equity", labelAr: "حقوق ملكية" },
      { value: "income", label: "Income", labelAr: "إيراد" }, { value: "expense", label: "Expense", labelAr: "مصروف" },
    ],
  },
  { name: "sourceIsGroup", label: "Group (header) row", labelAr: "صف تجميعي (رئيسي)", kind: "boolean" },
  { name: "openingDebit", label: "Closing debit balance (SAR)", labelAr: "الرصيد المدين الختامي (ر.س)", kind: "number" },
  { name: "openingCredit", label: "Closing credit balance (SAR)", labelAr: "الرصيد الدائن الختامي (ر.س)", kind: "number" },
  {
    name: "sourceRole", label: "Role hint (old system's account role)", labelAr: "تلميح الدور (دور الحساب في النظام السابق)", kind: "select",
    hint: "Drives the deterministic suggestion; the operator still decides.", hintAr: "يحدد الاقتراح التلقائي؛ ويبقى القرار للمشغّل.",
    options: [
      { value: "", label: "None", labelAr: "لا شيء" },
      { value: "receivable", label: "Receivables control", labelAr: "حساب مراقبة الذمم المدينة" }, { value: "payable", label: "Payables control", labelAr: "حساب مراقبة الذمم الدائنة" },
      { value: "bank", label: "Bank", labelAr: "بنك" }, { value: "cash", label: "Cash", labelAr: "نقد" },
      { value: "vat_output", label: "Output VAT", labelAr: "ضريبة المخرجات" }, { value: "vat_input", label: "Input VAT", labelAr: "ضريبة المدخلات" },
      { value: "retained_earnings", label: "Retained earnings", labelAr: "الأرباح المبقاة" }, { value: "customer_deposits", label: "Customer deposits", labelAr: "دفعات العملاء المقدمة" },
    ],
  },
  { name: "evidenceNote", label: "Evidence note (bank rows: the statement)", labelAr: "ملاحظة الإثبات (للبنوك: كشف الحساب)", kind: "text" },
];

export const PARTY_FIELDS: readonly FieldSpec[] = [
  { name: "partyType", label: "Party type", labelAr: "نوع الطرف", kind: "select", required: true, options: [{ value: "customer", label: "Customer", labelAr: "عميل" }, { value: "vendor", label: "Supplier", labelAr: "مورّد" }] },
  { name: "sourceId", label: "Source id (the old system's id)", labelAr: "المعرّف في النظام السابق", kind: "text", required: true },
  { name: "name", label: "Name", labelAr: "الاسم", kind: "text", required: true },
  { name: "nameAr", label: "Arabic name", labelAr: "الاسم بالعربية", kind: "text" },
  { name: "taxNumber", label: "VAT number", labelAr: "الرقم الضريبي", kind: "text" },
  { name: "crNumber", label: "CR number", labelAr: "رقم السجل التجاري", kind: "text" },
  { name: "phone", label: "Phone", labelAr: "الهاتف", kind: "text" },
  { name: "email", label: "Email", labelAr: "البريد الإلكتروني", kind: "text" },
  { name: "address", label: "Address", labelAr: "العنوان", kind: "text" },
  { name: "city", label: "City", labelAr: "المدينة", kind: "text" },
];

export const OPEN_ITEM_FIELDS: readonly FieldSpec[] = [
  { name: "itemType", label: "Item type", labelAr: "نوع البند", kind: "select", required: true, options: [{ value: "ar", label: "Receivable (customer owes us)", labelAr: "ذمة مدينة (يدين لنا العميل)" }, { value: "ap", label: "Payable (we owe a supplier)", labelAr: "ذمة دائنة (ندين للمورّد)" }] },
  { name: "sourceId", label: "Source id", labelAr: "المعرّف في النظام السابق", kind: "text", required: true },
  { name: "partySourceId", label: "Party source id", labelAr: "معرّف الطرف في النظام السابق", kind: "text", required: true },
  { name: "documentNumber", label: "Source document number", labelAr: "رقم المستند في النظام السابق", kind: "text", required: true, hint: "Kept verbatim as provenance; never re-numbered.", hintAr: "يُحفظ حرفيًا كإثبات للمصدر؛ ولا يُعاد ترقيمه." },
  { name: "issueDate", label: "Issue date", labelAr: "تاريخ الإصدار", kind: "date", required: true },
  { name: "dueDate", label: "Due date", labelAr: "تاريخ الاستحقاق", kind: "date", required: true },
  { name: "originalAmount", label: "Original amount (SAR)", labelAr: "المبلغ الأصلي (ر.س)", kind: "number", required: true },
  { name: "outstandingAmount", label: "Outstanding at cut-off (SAR)", labelAr: "المتبقي عند القطع (ر.س)", kind: "number", required: true },
  { name: "compositionUnknown", label: "Composition unknown (a party balance only)", labelAr: "التكوين غير معروف (رصيد الطرف فقط)", kind: "boolean" },
  { name: "description", label: "Description", labelAr: "الوصف", kind: "text" },
  { name: "historicalVat.category", label: "Historical VAT category (S / Z / E / O)", labelAr: "فئة الضريبة التاريخية (S / Z / E / O)", kind: "text" },
  { name: "historicalVat.rate", label: "Historical VAT rate %", labelAr: "نسبة الضريبة التاريخية %", kind: "number" },
  { name: "historicalVat.taxableAmount", label: "Historical taxable amount", labelAr: "المبلغ الخاضع للضريبة تاريخيًا", kind: "number" },
  { name: "historicalVat.amount", label: "Historical VAT amount", labelAr: "مبلغ الضريبة التاريخي", kind: "number" },
  { name: "historicalVat.reportedPeriod", label: "Reported in return period", labelAr: "الفترة الضريبية المبلَّغ فيها", kind: "text" },
  {
    name: "historicalVat.badDebtReliefClaimed", label: "Bad-debt relief claimed (Art. 40(7))", labelAr: "المطالبة بإعفاء الديون المعدومة (المادة 40(7))", kind: "select", options: yesNoUnknown,
    hint: "A structured fact on the opening receivable: when money later arrives, the Art. 40(9) recovery document is declared from it. It never restricts a payment.", hintAr: "حقيقة مهيكلة على الذمة الافتتاحية: عند وصول المال لاحقًا يُعلن مستند الاسترداد (المادة 40(9)) منها. ولا تقيّد أبدًا أي دفعة.",
  },
  { name: "historicalVat.badDebtReliefClaimedOn", label: "Relief claimed on (YYYY-MM-DD)", labelAr: "تاريخ المطالبة بالإعفاء", kind: "date", hint: "Only with relief claimed = yes.", hintAr: "فقط مع المطالبة بالإعفاء = نعم." },
  { name: "historicalVat.badDebtReliefVatAmount", label: "Relief VAT amount", labelAr: "مبلغ ضريبة الإعفاء", kind: "number", hint: "The Output Tax the previous system relieved, when known.", hintAr: "ضريبة المخرجات التي أعفاها النظام السابق، إن عُرفت." },
  {
    name: "einvoicingStatus", label: "E-invoicing status (AR only)", labelAr: "حالة الفوترة الإلكترونية (الذمم المدينة فقط)", kind: "select",
    options: [{ value: "", label: "Not stated", labelAr: "غير مذكورة" }, { value: "cleared", label: "Cleared (standard)", labelAr: "معتمدة (قياسية)" }, { value: "reported", label: "Reported (simplified)", labelAr: "مبلَّغ عنها (مبسَّطة)" }, { value: "pre_einvoicing", label: "Issued before e-invoicing", labelAr: "صدرت قبل الفوترة الإلكترونية" }],
    hint: "What the previous solution did with this tax invoice. Not stated is not a guess: a credit note against the item is refused until it is stated. Never invented.", hintAr: "ما فعله الحل السابق بهذه الفاتورة الضريبية. «غير مذكورة» ليست تخمينًا: يُرفض أي إشعار دائن على البند حتى تُذكر. ولا تُختلق أبدًا.",
  },
  { name: "sourceUuid", label: "Previous solution's UUID (AR only)", labelAr: "معرّف UUID في الحل السابق (الذمم المدينة فقط)", kind: "text", hint: "Verbatim; required for cleared / reported.", hintAr: "حرفيًا؛ مطلوب للمعتمدة / المبلَّغ عنها." },
];

export const ADVANCE_FIELDS: readonly FieldSpec[] = [
  { name: "sourceId", label: "Source id", labelAr: "المعرّف في النظام السابق", kind: "text", required: true },
  { name: "partySourceId", label: "Customer source id", labelAr: "معرّف العميل في النظام السابق", kind: "text", required: true },
  { name: "bankSourceCode", label: "Bank (old chart code)", labelAr: "البنك (رمز الحساب في الدليل السابق)", kind: "text", required: true },
  { name: "amount", label: "Amount (SAR)", labelAr: "المبلغ (ر.س)", kind: "number", required: true },
  { name: "receivedAt", label: "Received on", labelAr: "تاريخ الاستلام", kind: "date", required: true },
  { name: "reference", label: "Reference", labelAr: "المرجع", kind: "text" },
  { name: "vatPosition", label: "VAT position", labelAr: "الموقف الضريبي", kind: "select", required: true, options: [{ value: "invoiced", label: "Advance invoice was issued", labelAr: "صدرت فاتورة الدفعة المقدمة" }, { value: "unknown", label: "Unknown (recorded at cash; fails closed downstream)", labelAr: "غير معروف (يُسجَّل نقدًا؛ يُرفض لاحقًا)" }] },
  { name: "advanceInvoiceNumber", label: "Advance invoice number", labelAr: "رقم فاتورة الدفعة المقدمة", kind: "text" },
  { name: "advanceInvoiceDate", label: "Advance invoice date", labelAr: "تاريخ فاتورة الدفعة المقدمة", kind: "date" },
  { name: "advanceInvoiceTime", label: "Advance invoice time (HH:MM:SS)", labelAr: "وقت فاتورة الدفعة المقدمة", kind: "time" },
  { name: "vatCategory", label: "VAT category", labelAr: "فئة الضريبة", kind: "text" },
  { name: "vatRate", label: "VAT rate %", labelAr: "نسبة الضريبة %", kind: "number" },
  { name: "vatAmount", label: "VAT amount", labelAr: "مبلغ الضريبة", kind: "number" },
];

export type StagedKind = "chart" | "parties" | "openItems" | "advances";
export const FIELDS_OF: Record<StagedKind, readonly FieldSpec[]> = { chart: CHART_FIELDS, parties: PARTY_FIELDS, openItems: OPEN_ITEM_FIELDS, advances: ADVANCE_FIELDS };

/** A CSV template with the API's own column names, one commented example row. */
export function csvTemplate(kind: StagedKind): string {
  const fields = FIELDS_OF[kind];
  const example: Record<StagedKind, string[]> = {
    chart: ["1100", "Riyad Bank", "بنك الرياض", "", "asset", "false", "50000", "0", "bank", "Riyad statement 30 Jun 2026, closing 50,000.00"],
    parties: ["customer", "C1", "Alpha Trading Est.", "مؤسسة ألفا التجارية", "300000000000003", "", "", "", "", "Riyadh"],
    openItems: ["ar", "SI-1001", "C1", "INV-1001", "2026-05-10", "2026-06-09", "10000", "10000", "false", "", "S", "15", "8695.65", "1304.35", "2026-Q2", ""],
    advances: ["ADV-1", "C3", "1100", "3000", "2026-06-01", "", "invoiced", "ADV-INV-9", "2026-06-01", "10:00:00", "S", "15", "391.30"],
  };
  return [fields.map((f) => f.name).join(","), example[kind].join(",")].join("\n");
}

// ── 2. the parser ───────────────────────────────────────────────────────────

export interface ParseResult<T> {
  rows: T[];
  /** Human-readable, one per defective row: "row 3: originalAmount must be a number". */
  errors: string[];
  format: "csv" | "json" | "empty";
}

const snakeToCamel = (s: string) => s.trim().replace(/[_\s-]+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());
/** Header cell → API field, tolerant of case, snake_case and spaces; nested keys keep their dot. */
function normaliseKey(raw: string, fields: readonly FieldSpec[]): string | null {
  const want = raw.trim();
  if (!want) return null;
  const byExact = fields.find((f) => f.name === want);
  if (byExact) return byExact.name;
  const camel = want.split(".").map(snakeToCamel).join(".");
  const byCamel = fields.find((f) => f.name.toLowerCase() === camel.toLowerCase());
  if (byCamel) return byCamel.name;
  // "historical_vat_amount" → historicalVat.amount
  const flat = camel.toLowerCase().replace(/\./g, "");
  const byFlat = fields.find((f) => f.name.toLowerCase().replace(/\./g, "") === flat);
  return byFlat ? byFlat.name : null;
}

function setNested(obj: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]];
    if (next == null || typeof next !== "object") cur[parts[i]] = {};
    cur = cur[parts[i]] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}
function getNested(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o != null && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

const isBlank = (v: unknown) => v == null || (typeof v === "string" && v.trim() === "");

/** Coerce one raw value by its field kind. Returns `{ error }` when it cannot be read; blank → undefined (absent). */
function coerce(spec: FieldSpec, raw: unknown): { value?: unknown; error?: string } {
  if (isBlank(raw)) return { value: undefined };
  const s = typeof raw === "string" ? raw.trim() : raw;
  switch (spec.kind) {
    case "number": {
      const n = typeof s === "number" ? s : Number(String(s).replace(/,/g, ""));
      return Number.isFinite(n) ? { value: n } : { error: `${spec.name} must be a number` };
    }
    case "boolean": {
      if (typeof s === "boolean") return { value: s };
      const l = String(s).toLowerCase();
      if (["true", "yes", "y", "1"].includes(l)) return { value: true };
      if (["false", "no", "n", "0"].includes(l)) return { value: false };
      return { error: `${spec.name} must be true or false` };
    }
    case "date": {
      const d = String(s);
      return /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) ? { value: d } : { error: `${spec.name} must be YYYY-MM-DD` };
    }
    case "select": {
      // The relief flag is the one three-valued select: "" (unknown) is a real answer, never an error.
      if (spec.name === "historicalVat.badDebtReliefClaimed") {
        if (typeof s === "boolean") return { value: s };
        const l = String(s).toLowerCase();
        if (["true", "yes", "y", "1"].includes(l)) return { value: true };
        if (["false", "no", "n", "0"].includes(l)) return { value: false };
        if (["null", "unknown", ""].includes(l)) return { value: null };
        return { error: `${spec.name} must be yes, no or blank (unknown)` };
      }
      const v = String(s);
      return spec.options?.some((o) => o.value === v) ? { value: v } : { error: `${spec.name} must be one of ${spec.options?.map((o) => o.value).filter(Boolean).join(", ")}` };
    }
    default:
      return { value: String(s) };
  }
}

/** Typed rows from a parsed object row. Exported so the row editor uses the SAME coercion as the file import. */
export function coerceRow(kind: StagedKind, raw: Record<string, unknown>, where: string): { row?: Record<string, unknown>; errors: string[] } {
  const fields = FIELDS_OF[kind];
  const out: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const spec of fields) {
    const { value, error } = coerce(spec, getNested(raw, spec.name));
    if (error) { errors.push(`${where}: ${error}`); continue; }
    if (value === undefined) {
      if (spec.required) errors.push(`${where}: ${spec.name} is required`);
      continue;
    }
    setNested(out, spec.name, value);
  }
  // An empty historicalVat object means "no historical VAT facts" — send null, never {}.
  if (kind === "openItems") {
    const hv = out.historicalVat as Record<string, unknown> | undefined;
    if (!hv || Object.keys(hv).length === 0) out.historicalVat = null;
  }
  return errors.length > 0 ? { errors } : { row: out, errors };
}

/**
 * Parse pasted or uploaded text. JSON when the first non-blank character is
 * `[` or `{`; CSV otherwise. Unknown columns are reported once (not silently
 * dropped — a misspelt column that vanished would look like "the file had no
 * outstanding amounts").
 */
export function parseStagedText<T = Record<string, unknown>>(kind: StagedKind, text: string): ParseResult<T> {
  const trimmed = text.replace(/^﻿/, "").trim();
  if (!trimmed) return { rows: [], errors: [], format: "empty" };
  const fields = FIELDS_OF[kind];
  let rawRows: Record<string, unknown>[] = [];
  const errors: string[] = [];
  let format: "csv" | "json";
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    format = "json";
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const arr = Array.isArray(parsed) ? parsed : (parsed as { rows?: unknown }).rows;
      if (!Array.isArray(arr)) return { rows: [], errors: ["JSON must be an array of rows, or an object with a rows array"], format };
      rawRows = arr as Record<string, unknown>[];
    } catch (e) {
      return { rows: [], errors: [`Not valid JSON: ${(e as Error).message}`], format };
    }
  } else {
    format = "csv";
    const res = Papa.parse<Record<string, string>>(trimmed, { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim() });
    const headers = res.meta.fields ?? [];
    const unknown = headers.filter((h) => normaliseKey(h, fields) == null);
    if (unknown.length > 0) errors.push(`Unknown column(s) ignored: ${unknown.join(", ")}`);
    rawRows = res.data.map((r) => {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) {
        const key = normaliseKey(k, fields);
        if (key) setNested(o, key, v);
      }
      return o;
    });
  }
  const rows: T[] = [];
  rawRows.forEach((raw, i) => {
    const { row, errors: rowErrors } = coerceRow(kind, raw, `row ${i + 1}`);
    if (row) rows.push(row as T);
    errors.push(...rowErrors);
  });
  return { rows, errors, format };
}

export type ChartRows = MigrationChartRowInput[];
export type PartyRows = MigrationPartyInput[];
export type OpenItemRows = MigrationOpenItemInput[];
export type AdvanceRows = MigrationAdvanceInput[];

// ── 3. read-side labels and maps ────────────────────────────────────────────

/** Art. 40(9): a three-valued fact, shown as three words. Never a boolean coerced to "No". */
export function reliefLabel(v: boolean | null | undefined, lang: Lang): string {
  if (v === true) return lang === "ar" ? "نعم" : "Yes";
  if (v === false) return lang === "ar" ? "لا" : "No";
  return lang === "ar" ? "غير معروف" : "Unknown";
}

export type WorkspaceSection =
  | "overview" | "chart" | "parties" | "ar" | "ap" | "advances" | "banks" | "vat" | "trial-balance" | "reconciliation" | "validation" | "commit";

export const SECTIONS: readonly WorkspaceSection[] = ["overview", "chart", "parties", "ar", "ap", "advances", "banks", "vat", "trial-balance", "reconciliation", "validation", "commit"];

/** Which staging section a server control points at — the "go to the affected record" edge. */
export const CHECK_SECTION: Record<string, WorkspaceSection> = {
  CHART_MAPPED: "chart",
  CHART_BALANCED: "trial-balance",
  AR_CONTROL: "ar",
  AP_CONTROL: "ap",
  DEPOSITS_CONTROL: "advances",
  BANKS: "banks",
  VAT_POSITION: "vat",
  PARTIES: "parties",
  OPEN_ITEMS: "ar",
  ADVANCES: "advances",
  LEDGER_EMPTY: "overview",
  OPENING_DATE: "overview",
  FISCAL_YEAR: "overview",
};

export function sectionForCheck(id: string): WorkspaceSection {
  return CHECK_SECTION[id] ?? "validation";
}

export type CheckVerdict = "pass" | "warn" | "blocked" | "skipped";
export function verdictOf(c: Pick<MigrationControlCheck, "status">): CheckVerdict {
  return c.status === "fail" ? "blocked" : c.status === "warn" ? "warn" : c.status === "skip" ? "skipped" : "pass";
}

export function verdictLabel(v: CheckVerdict, lang: Lang): string {
  const L: Record<CheckVerdict, [string, string]> = { pass: ["PASS", "ناجح"], warn: ["WARNING", "تحذير"], blocked: ["BLOCKED", "محظور"], skipped: ["NOT APPLICABLE", "لا ينطبق"] };
  return L[v][lang === "ar" ? 1 : 0];
}

/** Counts a validation report the way the overview states them. */
export function summariseChecks(checks: readonly Pick<MigrationControlCheck, "status">[]): { blocking: number; warnings: number; passed: number; skipped: number } {
  return {
    blocking: checks.filter((c) => c.status === "fail").length,
    warnings: checks.filter((c) => c.status === "warn").length,
    passed: checks.filter((c) => c.status === "pass").length,
    skipped: checks.filter((c) => c.status === "skip").length,
  };
}

/** Days past due at the opening date, bucketed the way AR ageing buckets them. */
export function ageingBucket(dueDate: string, asOf: string): { days: number; bucket: "current" | "1-30" | "31-60" | "61-90" | "90+" } {
  const days = Math.floor((Date.parse(asOf) - Date.parse(dueDate)) / 86_400_000);
  const bucket = days <= 0 ? "current" : days <= 30 ? "1-30" : days <= 60 ? "31-60" : days <= 90 ? "61-90" : "90+";
  return { days: Math.max(0, days), bucket };
}

/** System codes a chart row may map to — read from the org's own chart. CASH is a header; OBE does not exist and is refused by name even if a stray row carried the code. */
export const NEVER_A_TARGET = new Set(["CASH", "OPENING_BALANCE_EQUITY"]);
export function systemTargets(categories: readonly Pick<Category, "id" | "systemCode" | "name" | "nameAr" | "type">[], sourceType?: string) {
  return categories
    .filter((c) => c.systemCode && !NEVER_A_TARGET.has(c.systemCode) && (!sourceType || c.type === sourceType))
    .map((c) => ({ code: c.systemCode as string, name: c.name, nameAr: c.nameAr, type: c.type }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

/** Postable non-system accounts of the row's type — the merge_into targets. */
export function mergeTargets(categories: readonly Pick<Category, "id" | "systemCode" | "name" | "nameAr" | "type" | "isPosting">[], sourceType: string) {
  return categories.filter((c) => !c.systemCode && c.isPosting !== false && c.type === sourceType);
}
/** Header accounts of the row's type — the optional parent of a created account. */
export function headerTargets(categories: readonly Pick<Category, "id" | "systemCode" | "name" | "nameAr" | "type" | "isPosting">[], sourceType: string) {
  return categories.filter((c) => c.isPosting === false && c.type === sourceType);
}

/** Group opening-position lines the way the trial balance reads them. */
export function groupByType<T extends { type: string; debit: number; credit: number }>(lines: readonly T[]) {
  const order = ["asset", "liability", "equity", "income", "expense"] as const;
  return order.map((type) => {
    const rows = lines.filter((l) => l.type === type);
    return { type, rows, debit: round2(rows.reduce((s, l) => s + l.debit, 0)), credit: round2(rows.reduce((s, l) => s + l.credit, 0)) };
  });
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
