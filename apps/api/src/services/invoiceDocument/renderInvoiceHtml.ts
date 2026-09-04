/**
 * L1 — the invoice document template. ONE template, parameterised by `lang`.
 *
 * Single writer for the layout decisions:
 * `docs/product/design-invoice-document.md` — the reference layout is the real
 * accountant's invoice (§3): header as a label/value table, product code above
 * description in the items table, payment settlement inside the totals block,
 * the QR at the BOTTOM, Hijri alongside Gregorian.
 *
 * The rules enforced here, each from the design:
 *  - 🔴 THE SENTINEL NEVER PRINTS (§1 rule 5, revised 2026-09-03): a line
 *    whose `descriptionAr` is absent or still `"(not yet translated)"` renders
 *    its ENGLISH description on the Arabic document — stored script as
 *    fallback. The refusal is withdrawn; the never-print half stands and is
 *    what the unit tests pin.
 *  - 🔴 AN EMPTY BLOCK PRINTS ITS EMPTINESS (§2): every optional block
 *    defaults OFF and turns itself on only when it has content — terms render
 *    only if written, bank details only if a default account exists, the logo
 *    slot only if a logo exists (no text-mark fallback: a stand-in that looks
 *    designed is worse on a legal document than an empty space).
 *  - The ENGLISH rendering is a TRANSLATION, and says so on its face (§1
 *    rule 4): an English-only rendering is not a compliant tax invoice under
 *    the settled Article 53 reading, and the banner is keyed on `lang`, not on
 *    copy.
 *  - Western Arabic numerals in BOTH renderings — the reference invoice uses
 *    them, and the printed figures must read identically against the QR
 *    payload. Currency is textual (ر.س / SAR): the new Riyal sign's glyph
 *    coverage in headless-Chromium font stacks is not something a legal
 *    artifact should gamble on.
 *  - Layout mirrors via `dir` + logical CSS properties; no per-language
 *    stylesheet fork.
 */
import { L, documentTitle, type DocLang } from "./labels";

export const TRANSLATION_SENTINEL = "(not yet translated)";

export interface DocParty {
  name: string;
  nameAr: string | null;
  vatNumber: string | null;
  crNumber: string | null;
  address: string | null;
}

export interface DocLine {
  productCode: string | null;
  description: string;
  descriptionAr: string | null;
  quantity: string;
  unitPrice: string;
  vatRate: string;
  vatAmount: string;
  total: string;
}

export interface DocBankDetails {
  bankName: string;
  iban: string;
  accountName: string;
}

export interface InvoiceDocModel {
  lang: DocLang;
  documentType: string; // invoice | credit_note | debit_note
  invoiceNumber: string;
  originalInvoiceNumber: string | null; // notes: the document they correct
  dateGregorian: string; // YYYY-MM-DD
  dateHijri: string; // e.g. 1447-01-15
  dueDate: string | null;
  seller: DocParty;
  buyer: DocParty | null; // null = simplified/B2C
  lines: DocLine[];
  subtotal: string;
  vatAmount: string;
  total: string;
  paidAmount: string; // payment settlement inside the totals block (§3)
  qrDataUrl: string | null; // rendered TLV QR — bottom of the page
  logoDataUrl: string | null;
  termsAndConditions: string | null;
  bankDetails: DocBankDetails | null;
  noteReason: string | null;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const fmt = (n: string): string => {
  const v = Number(n);
  return Number.isFinite(v)
    ? v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : esc(n);
};

/** The sentinel-never-prints rule, §1 rule 5 (revised). */
export function arabicLineDescription(line: Pick<DocLine, "description" | "descriptionAr">): string {
  const ar = (line.descriptionAr ?? "").trim();
  if (!ar || ar === TRANSLATION_SENTINEL) return line.description;
  return ar;
}

export function renderInvoiceHtml(m: InvoiceDocModel): string {
  const t = L(m.lang);
  const dir = m.lang === "ar" ? "rtl" : "ltr";
  const currency = t("SAR", "ر.س");
  const buyerHasVat = !!m.buyer?.vatNumber;
  const title = documentTitle(m.lang, m.documentType, buyerHasVat);

  const partyName = (p: DocParty): string =>
    m.lang === "ar" ? (p.nameAr?.trim() && p.nameAr.trim() !== TRANSLATION_SENTINEL ? p.nameAr : p.name) : p.name;

  const kv = (label: string, value: string | null | undefined): string =>
    value ? `<tr><td class="k">${esc(label)}</td><td class="v">${esc(value)}</td></tr>` : "";

  const lineDesc = (l: DocLine): string => (m.lang === "ar" ? arabicLineDescription(l) : l.description);

  return `<!doctype html>
<html lang="${m.lang}" dir="${dir}">
<head><meta charset="utf-8">
<title>${esc(title)} ${esc(m.invoiceNumber)}</title>
<style>
  @page { size: A4; margin: 12mm; }
  body { font-family: "Segoe UI", "Noto Naskh Arabic", "Noto Sans Arabic", "Traditional Arabic", Tahoma, sans-serif;
         color: #111; font-size: 12px; margin: 0; }
  h1 { font-size: 19px; margin: 0 0 2px; }
  .doc-no { font-size: 13px; color: #333; margin-bottom: 10px; }
  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
  header img.logo { max-height: 64px; max-width: 180px; }
  table { border-collapse: collapse; width: 100%; }
  .kv { font-size: 11.5px; margin-block: 4px 10px; }
  .kv td { padding: 2px 6px; vertical-align: top; }
  .kv td.k { color: #555; white-space: nowrap; width: 1%; }
  .parties { display: flex; gap: 10px; margin-block-end: 10px; }
  .party { flex: 1; border: 1px solid #ccc; border-radius: 3px; padding: 6px 8px; }
  .party h2 { font-size: 12px; margin: 0 0 4px; color: #444; }
  .items th, .items td { border: 1px solid #bbb; padding: 5px 7px; text-align: start; }
  .items th { background: #eef2f7; font-weight: 600; }
  .items td.num, .items th.num { text-align: end; font-variant-numeric: tabular-nums; }
  .items .code { display: block; font-size: 10px; color: #666; }
  .totals { width: 46%; margin-inline-start: auto; margin-block-start: 10px; font-size: 12px; }
  .totals td { padding: 3px 7px; }
  .totals td.num { text-align: end; font-variant-numeric: tabular-nums; }
  .totals tr.grand td { border-top: 1.5px solid #333; font-weight: 700; font-size: 13px; }
  .block { margin-block-start: 12px; border-top: 1px solid #ddd; padding-top: 6px; font-size: 11px; }
  .block h3 { font-size: 11.5px; margin: 0 0 3px; color: #444; }
  .qr { text-align: center; margin-block-start: 18px; }
  .qr img { width: 140px; height: 140px; }
  .translation-banner { border: 1.5px solid #8a6d1a; background: #fdf6e3; color: #5b4a12;
    padding: 6px 10px; margin-block-end: 10px; font-size: 11.5px; border-radius: 3px; }
</style></head>
<body>
${
  m.lang === "en"
    ? `<div class="translation-banner">ترجمة — الوثيقة العربية هي الفاتورة الضريبية · Translation of ${esc(title)} ${esc(m.invoiceNumber)} — the Arabic document is the tax invoice.</div>`
    : ""
}
<header>
  <div>
    <h1>${esc(title)}</h1>
    <div class="doc-no">${esc(m.invoiceNumber)}</div>
  </div>
  ${m.logoDataUrl ? `<img class="logo" src="${m.logoDataUrl}" alt="">` : ""}
</header>

<table class="kv">
  ${kv(t("Issue date (Gregorian)", "تاريخ الإصدار (ميلادي)"), m.dateGregorian)}
  ${kv(t("Issue date (Hijri)", "تاريخ الإصدار (هجري)"), m.dateHijri)}
  ${kv(t("Due date", "تاريخ الاستحقاق"), m.dueDate)}
  ${kv(t("Corrects", "تصحيح للفاتورة"), m.originalInvoiceNumber)}
  ${kv(t("Reason", "سبب الإشعار"), m.noteReason)}
</table>

<div class="parties">
  <div class="party">
    <h2>${esc(t("Seller", "البائع"))}</h2>
    <table class="kv">
      ${kv(t("Name", "الاسم"), partyName(m.seller))}
      ${kv(t("VAT number", "الرقم الضريبي"), m.seller.vatNumber)}
      ${kv(t("CR number", "السجل التجاري"), m.seller.crNumber)}
      ${kv(t("Address", "العنوان"), m.seller.address)}
    </table>
  </div>
  ${
    m.buyer
      ? `<div class="party">
    <h2>${esc(t("Buyer", "المشتري"))}</h2>
    <table class="kv">
      ${kv(t("Name", "الاسم"), partyName(m.buyer))}
      ${kv(t("VAT number", "الرقم الضريبي"), m.buyer.vatNumber)}
      ${kv(t("Address", "العنوان"), m.buyer.address)}
    </table>
  </div>`
      : ""
  }
</div>

<table class="items">
  <thead><tr>
    <th>#</th>
    <th>${esc(t("Item", "الصنف"))}</th>
    <th class="num">${esc(t("Qty", "الكمية"))}</th>
    <th class="num">${esc(t("Unit price", "سعر الوحدة"))}</th>
    <th class="num">${esc(t("VAT %", "نسبة الضريبة"))}</th>
    <th class="num">${esc(t("VAT amount", "مبلغ الضريبة"))}</th>
    <th class="num">${esc(t("Total (incl. VAT)", "الإجمالي شامل الضريبة"))}</th>
  </tr></thead>
  <tbody>
    ${m.lines
      .map(
        (l, i) => `<tr>
      <td class="num">${i + 1}</td>
      <td>${l.productCode ? `<span class="code">${esc(l.productCode)}</span>` : ""}${esc(lineDesc(l))}</td>
      <td class="num">${fmt(l.quantity)}</td>
      <td class="num">${fmt(l.unitPrice)}</td>
      <td class="num">${esc(l.vatRate)}%</td>
      <td class="num">${fmt(l.vatAmount)}</td>
      <td class="num">${fmt(l.total)}</td>
    </tr>`,
      )
      .join("\n")}
  </tbody>
</table>

<table class="totals">
  <tr><td>${esc(t("Subtotal (excl. VAT)", "الإجمالي قبل الضريبة"))}</td><td class="num">${fmt(m.subtotal)} ${esc(currency)}</td></tr>
  <tr><td>${esc(t("VAT 15%", "ضريبة القيمة المضافة ١٥٪"))}</td><td class="num">${fmt(m.vatAmount)} ${esc(currency)}</td></tr>
  <tr class="grand"><td>${esc(t("Total (incl. VAT)", "الإجمالي شامل الضريبة"))}</td><td class="num">${fmt(m.total)} ${esc(currency)}</td></tr>
  ${
    Number(m.paidAmount) > 0
      ? `<tr><td>${esc(t("Paid", "المدفوع"))}</td><td class="num">${fmt(m.paidAmount)} ${esc(currency)}</td></tr>
  <tr><td>${esc(t("Balance due", "المتبقي"))}</td><td class="num">${fmt(String(Number(m.total) - Number(m.paidAmount)))} ${esc(currency)}</td></tr>`
      : ""
  }
</table>

${
  m.bankDetails
    ? `<div class="block"><h3>${esc(t("Bank details", "البيانات البنكية"))}</h3>
  <table class="kv">
    ${kv(t("Bank", "البنك"), m.bankDetails.bankName)}
    ${kv(t("IBAN", "الآيبان"), m.bankDetails.iban)}
    ${kv(t("Account name", "اسم الحساب"), m.bankDetails.accountName)}
  </table></div>`
    : ""
}

${
  m.termsAndConditions?.trim()
    ? `<div class="block"><h3>${esc(t("Terms & conditions", "الشروط والأحكام"))}</h3><div>${esc(m.termsAndConditions)}</div></div>`
    : ""
}

${m.qrDataUrl ? `<div class="qr"><img src="${m.qrDataUrl}" alt="QR"></div>` : ""}
</body></html>`;
}
