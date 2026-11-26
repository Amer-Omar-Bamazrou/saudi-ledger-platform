/**
 * 🔴 19B S4 (v4 §4, §14) — THE REPORT DATASETS: vetted code, reviewed and tested, never rows a user writes.
 *
 * Each dataset names its NATIVE resources (the grants that guard the same data's own screens — a dataset never widens a
 * role beyond them), its columns, and the contract node its rows are. 🔴 A column's CLASS is not declared here: it is the
 * class table's, for that node and field (`columnClass`), so there is one definition of what a column is
 * (tests/s4-report-decide.test.ts fails when a column is not a field of its node, or a field is not a column).
 * A conditional class (the bank's text only on a line built from a bank line) is the class table's too (`rowConditions`):
 * the dataset only names it for the reader (`conditionLabel`).
 */
import type { ProtectedFieldClass } from "@workspace/db";
import { fieldSpec, type RowCondition } from "../fieldClasses/classTable";

export type ColumnKind = "text" | "money" | "date" | "int";
export type DatasetRow = Record<string, unknown>;

export interface DatasetColumn {
  key: string;
  label: string;
  labelAr: string;
  kind: ColumnKind;
  filterable: boolean;
  sortable: boolean;
  /** 19.12 — the dataset offers this column as a grouping. */
  groupable?: boolean;
  /** A date groups by its calendar month (YYYY-MM), never by the day. */
  groupAs?: "month";
  /** Another (standard) column of the same row that names the group for a reader — an account's name beside its id. */
  groupLabel?: string;
  /** When the column's protected class applies to SOME rows only (the class table's rowConditions): which, in words. */
  conditionLabel?: { label: string; labelAr: string };
}

export interface DatasetDef {
  name: string;
  title: string;
  titleAr: string;
  /** The contract node a row is — the class table classifies its fields. */
  node: string;
  native: readonly string[];
  columns: readonly DatasetColumn[];
  /** Query parameter → the column it filters on (a filter is a USE of that column). */
  filters: Readonly<Record<string, string>>;
  /**
   * 19.12 — the money columns a grouped report totals. Only columns whose sum MEANS something: a signed amount, never an
   * amount stored positive whatever its document's direction.
   */
  totals: readonly string[];
  /** Whether a total over ALL the rows means anything. False for journal lines: across whole entries debits equal credits. */
  grandTotal: boolean;
}

const text = (key: string, label: string, labelAr: string, opts: Partial<DatasetColumn> = {}): DatasetColumn =>
  ({ key, label, labelAr, kind: "text", filterable: false, sortable: false, ...opts });

/** Journal lines in the books (posted and reversed entries), in the request's company. A viewer dataset (D3). */
export const JOURNAL_LINES: DatasetDef = {
  name: "journal_lines",
  title: "Journal lines",
  titleAr: "سطور القيود",
  node: "JournalLinesDatasetRow",
  native: ["journal_entries"],
  columns: [
    text("lineId", "Line", "السطر", { kind: "int" }),
    text("date", "Date", "التاريخ", { kind: "date", filterable: true, sortable: true }),
    text("entryNumber", "Entry", "رقم القيد", { sortable: true }),
    text("status", "Status", "الحالة"),
    text("sourceType", "Source", "المصدر", { filterable: true }),
    // review follow-up (2026-11-24): where the line text came from — the bank's own text on a bank line or unknown origin
    text("textOrigin", "Text origin", "مصدر النص"),
    text("reference", "Reference", "المرجع"),
    // 19.12: by account, an account's debits and credits are the trial balance's period columns
    text("accountId", "Account id", "معرّف الحساب", { kind: "int", filterable: true, groupable: true, groupLabel: "accountName" }),
    text("accountCode", "Account code", "رمز الحساب", { sortable: true }),
    text("accountName", "Account", "الحساب"),
    text("accountNameAr", "Account (Arabic)", "الحساب بالعربية"),
    text("description", "Line text", "نص السطر", {
      conditionLabel: { label: "lines built from a bank line, or of unknown origin", labelAr: "السطور المبنية على سطر كشف بنكي، أو مجهولة المصدر" },
    }),
    text("debit", "Debit", "مدين", { kind: "money", sortable: true }),
    text("credit", "Credit", "دائن", { kind: "money", sortable: true }),
  ],
  filters: { date_from: "date", date_to: "date", account_id: "accountId", source_type: "sourceType" },
  totals: ["debit", "credit"],
  // 🔴 no cross-entry money total: an entry's debits equal its credits, so a total over the rows is twice the turnover
  grandTotal: false,
};

const money = (key: string, label: string, labelAr: string): DatasetColumn => text(key, label, labelAr, { kind: "money" });
const DOC_FILTERS = { date_from: "date", date_to: "date" } as const;

/**
 * 🔴 19B S5 (scope proposal §7.1 item 2) — SALES DOCUMENTS in the books: invoices, credit notes and debit notes (issued,
 * never a draft; never a reversed or superseded item — the reports' one predicate). Amounts are stored POSITIVE; the
 * direction is `sign` (`documentSign()`: a credit note reverses, a debit note does not), applied in the signed
 * columns and nowhere else. A viewer dataset (D3).
 */
export const SALES_DOCUMENTS: DatasetDef = {
  name: "sales_documents",
  title: "Sales documents",
  titleAr: "مستندات المبيعات",
  node: "SalesDocumentsDatasetRow",
  native: ["invoices"],
  columns: [
    text("documentId", "Document id", "معرّف المستند", { kind: "int" }),
    text("documentNumber", "Number", "الرقم", { sortable: true }),
    text("documentType", "Type", "النوع", { groupable: true }),
    text("date", "Date", "التاريخ", { kind: "date", filterable: true, sortable: true, groupable: true, groupAs: "month" }),
    text("dueDate", "Due date", "تاريخ الاستحقاق", { kind: "date" }),
    text("status", "Status", "الحالة", { groupable: true }),
    text("customerId", "Customer id", "معرّف العميل", { kind: "int" }),
    text("customerName", "Customer", "العميل", { groupable: true }),
    text("currency", "Currency", "العملة"),
    money("subtotal", "Subtotal", "المجموع قبل الضريبة"),
    money("vatAmount", "VAT", "الضريبة"),
    money("total", "Total", "الإجمالي"),
    text("sign", "Sign", "الإشارة", { kind: "int" }),
    money("signedSubtotal", "Signed subtotal", "المجموع قبل الضريبة بالإشارة"),
    money("signedVat", "Signed VAT", "الضريبة بالإشارة"),
    money("signedTotal", "Signed total", "الإجمالي بالإشارة"),
    money("paidAmount", "Paid", "المدفوع"),
    text("isOpening", "Opening item", "بند افتتاحي"),
  ],
  filters: DOC_FILTERS,
  totals: ["signedSubtotal", "signedVat", "signedTotal"],
  grandTotal: true,
};

/**
 * 🔴 19B S5 (§7.1 item 3) — PURCHASE DOCUMENTS in the books: bills and supplier notes. `outstanding` is what the
 * document still OWES by `repositories/billPosition` — the one definition, never total − paid_amount; a supplier
 * credit note owes nothing. A viewer dataset (D3).
 */
export const PURCHASE_DOCUMENTS: DatasetDef = {
  name: "purchase_documents",
  title: "Purchase documents",
  titleAr: "مستندات المشتريات",
  node: "PurchaseDocumentsDatasetRow",
  native: ["bills"],
  columns: [
    text("documentId", "Document id", "معرّف المستند", { kind: "int" }),
    text("documentNumber", "Number", "الرقم", { sortable: true }),
    text("supplierReference", "Supplier's number", "رقم مستند المورد"),
    text("documentType", "Type", "النوع", { groupable: true }),
    text("date", "Date", "التاريخ", { kind: "date", filterable: true, sortable: true, groupable: true, groupAs: "month" }),
    text("dueDate", "Due date", "تاريخ الاستحقاق", { kind: "date" }),
    text("status", "Status", "الحالة", { groupable: true }),
    text("vendorId", "Supplier id", "معرّف المورد", { kind: "int" }),
    text("vendorName", "Supplier", "المورد", { groupable: true }),
    text("currency", "Currency", "العملة"),
    money("subtotal", "Subtotal", "المجموع قبل الضريبة"),
    money("vatAmount", "VAT", "الضريبة"),
    money("total", "Total", "الإجمالي"),
    text("sign", "Sign", "الإشارة", { kind: "int" }),
    money("signedSubtotal", "Signed subtotal", "المجموع قبل الضريبة بالإشارة"),
    money("signedVat", "Signed VAT", "الضريبة بالإشارة"),
    money("signedTotal", "Signed total", "الإجمالي بالإشارة"),
    money("outstanding", "Outstanding", "المستحق"),
    text("inputVat", "Input VAT", "ضريبة المدخلات"),
    text("isOpening", "Opening item", "بند افتتاحي"),
  ],
  filters: DOC_FILTERS,
  totals: ["signedSubtotal", "signedVat", "signedTotal", "outstanding"],
  grandTotal: true,
};

/**
 * 🔴 19B S5 (§7.1 item 4) — CASH MOVEMENTS: the bank's lines in this company — payments, receipts, transfers — whatever
 * their review state. `countsInAggregates` is the reports' own gate (`taxVisible`: accepted AND operating): a transfer
 * or a settlement is listed, and is OUT of every income, expense, VAT, Zakat and budget figure. The line's text is the
 * bank's (bank_narrative, on every row). Not a viewer dataset.
 */
export const CASH_MOVEMENTS: DatasetDef = {
  name: "cash_movements",
  title: "Cash movements",
  titleAr: "الحركات النقدية",
  node: "CashMovementsDatasetRow",
  native: ["transactions"],
  columns: [
    text("transactionId", "Movement id", "معرّف الحركة", { kind: "int" }),
    text("date", "Date", "التاريخ", { kind: "date", filterable: true, sortable: true, groupable: true, groupAs: "month" }),
    text("description", "Bank text", "نص كشف البنك"),
    text("type", "Direction", "الاتجاه", { groupable: true }),
    text("kind", "Kind", "النوع", { groupable: true }),
    money("amount", "Amount", "المبلغ"),
    money("signedAmount", "Signed amount", "المبلغ بالإشارة"),
    money("vatAmount", "VAT", "الضريبة"),
    text("reviewStatus", "Review", "المراجعة", { groupable: true }),
    text("bankAccountId", "Bank account id", "معرّف الحساب البنكي", { kind: "int", groupable: true }),
    text("categoryId", "Account id", "معرّف الحساب", { kind: "int" }),
    text("categoryName", "Account", "الحساب", { groupable: true }),
    text("countsInAggregates", "Counts in income, expense and VAT figures", "يدخل في أرقام الإيراد والمصروف والضريبة"),
  ],
  filters: DOC_FILTERS,
  totals: ["signedAmount"],
  grandTotal: true,
};

/**
 * 🔴 19B S5 (§7.1 item 5) — VAT LINES: documents FILE. Each row is one ADDEND of the VAT return for the window — an
 * invoice or bill line (S/Z/E/O), a header-only document, an advance adjustment, a bad-debt relief — with the box it
 * joins, recorded by the return itself in the branch that adds it (`reportsService.vatReturnWithLines`). No new
 * classification: the dataset cannot disagree with the return. Input VAT appears only where it is CLAIMED (13A), dated
 * the day of the claim. The window is required — it is the return's. Not a viewer dataset.
 */
export const VAT_LINES: DatasetDef = {
  name: "vat_lines",
  title: "VAT lines",
  titleAr: "سطور ضريبة القيمة المضافة",
  node: "VatLinesDatasetRow",
  native: ["invoices", "bills"],
  columns: [
    text("lineNo", "Line", "السطر", { kind: "int" }),
    text("side", "Side", "الجانب", { groupable: true }),
    text("source", "Source", "المصدر"),
    text("documentId", "Document id", "معرّف المستند", { kind: "int" }),
    text("documentNumber", "Number", "الرقم"),
    text("documentType", "Type", "النوع"),
    text("date", "Date", "التاريخ", { kind: "date", filterable: true, sortable: true, groupable: true, groupAs: "month" }),
    text("taxCategory", "Tax category", "الفئة الضريبية", { groupable: true }),
    money("taxable", "Taxable amount", "المبلغ الخاضع"),
    money("vat", "VAT", "الضريبة"),
    text("taxableBox", "Box (amount)", "الخانة (المبلغ)", { kind: "int", groupable: true }),
    text("vatBox", "Box (VAT)", "الخانة (الضريبة)", { kind: "int", groupable: true }),
  ],
  filters: DOC_FILTERS,
  totals: ["taxable", "vat"],
  // sales and purchases sit side by side: a total over both sides is neither the VAT due nor a turnover
  grandTotal: false,
};

/** The datasets whose window is REQUIRED (it is part of what the figure means). */
export const WINDOW_REQUIRED: ReadonlySet<string> = new Set(["vat_lines"]);

export const DATASETS: Readonly<Record<string, DatasetDef>> = {
  journal_lines: JOURNAL_LINES,
  sales_documents: SALES_DOCUMENTS,
  purchase_documents: PURCHASE_DOCUMENTS,
  cash_movements: CASH_MOVEMENTS,
  vat_lines: VAT_LINES,
};

/** A column's class and the resource whose field grants decide it — from the class table, the one definition. */
export function columnClass(ds: DatasetDef, key: string): { cls: "standard" | ProtectedFieldClass; resource: string | null; rowCondition?: RowCondition } {
  const spec = fieldSpec(ds.node, key);
  if (!spec) throw new Error(`dataset ${ds.name}: column '${key}' is not a field of ${ds.node} in the class table`);
  if (spec.cls === "by_entity") throw new Error(`dataset ${ds.name}: column '${key}' is by_entity — a dataset column has one class`);
  return { cls: spec.cls, resource: spec.cls === "standard" ? null : spec.resource, ...(spec.rowCondition ? { rowCondition: spec.rowCondition } : {}) };
}
