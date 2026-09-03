/**
 * L1 — the label pairs for the invoice document, one template for two
 * renderings (`design-invoice-document.md` §4: one template parameterised by
 * `lang`, ~1.15×, not two documents' worth of work).
 *
 * 🔴 The pair sits NEXT TO the value it labels, everywhere it is used — the
 * property that makes ERPNext's ar.po catalog bug (both "Amount" and
 * "Quantity" translated to «كمية», so every Arabic invoice labels its money
 * column "quantity") structurally inexpressible here. Do not centralise these
 * into a keyed catalog; the adjacency IS the defence.
 */
export type DocLang = "ar" | "en";

/** Pick the label for the rendering language. Arabic labels are the tax
 *  invoice's labels (Article 53 — see the design §1); English labels exist
 *  only on the translation rendering. */
export const L = (lang: DocLang) => (en: string, ar: string) => (lang === "ar" ? ar : en);

/** The document title is a COMPLIANCE statement, not a heading style:
 *  standard vs simplified is decided by whether the buyer is identified for
 *  VAT, and the generated sample's failure to state which it was is one of
 *  the three defects the design refuses to inherit. */
export function documentTitle(lang: DocLang, documentType: string, buyerHasVat: boolean): string {
  const t = L(lang);
  if (documentType === "credit_note") return t("Credit Note", "إشعار دائن");
  if (documentType === "debit_note") return t("Debit Note", "إشعار مدين");
  return buyerHasVat ? t("Tax Invoice", "فاتورة ضريبية") : t("Simplified Tax Invoice", "فاتورة ضريبية مبسطة");
}
