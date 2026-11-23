/**
 * 🔴 19B S2b (v4 §11, D9 (b) = B2) — WHICH PROTECTED CLASSES AN INVOICE DOCUMENT CARRIES, read from the document
 * itself: the buyer block the PDF is rendered from, and the ZATCA XML the PDF/A-3 attaches. A signed tax document is
 * not altered per reader, so a role without one of these classes is REFUSED the PDF by name; there is no cut-down PDF.
 *
 *  - `contact` — the buyer's address: printed (building number, street, district, city, postal code), or any part of
 *    the XML buyer's `PostalAddress` except the country, which is `standard` (D1).
 *  - `identity` — a buyer identification in the XML whose scheme is not a business identifier: NAT on a private
 *    education or healthcare invoice (#363). A scheme outside the business list is treated as identity (the safe
 *    error), and so is an attached XML that cannot be read: what it carries is unknown.
 *
 * Both are the CUSTOMER's classes (resource `customers`). The buyer's name and VAT number are `standard`; a simplified
 * invoice with no buyer, or a buyer with neither an address nor a personal ID, carries no protected class.
 */
import { DOMParser } from "@xmldom/xmldom";
import type { ProtectedFieldClass } from "@workspace/db";

/** ZATCA's buyer "other ID" schemes that identify a BUSINESS (BR-KSA-14): tax number, CR, and the licence numbers. */
export const BUSINESS_ID_SCHEMES: readonly string[] = ["TIN", "CRN", "MOM", "MLS", "700", "SAG"];

export const DOCUMENT_CLASS_RESOURCE = "customers";

type El = { localName: string | null; childNodes: ArrayLike<{ nodeType: number }>; textContent: string | null; getAttribute(n: string): string | null; parentNode: unknown };

const children = (el: El): El[] => Array.from(el.childNodes as ArrayLike<El & { nodeType: number }>).filter((n) => n.nodeType === 1);
const child = (el: El, name: string): El | undefined => children(el).find((c) => c.localName === name);

/** What the attached XML's buyer carries. `null` when the XML cannot be read (the caller treats it as carrying both). */
export function xmlBuyerClasses(xml: string): ProtectedFieldClass[] | null {
  let doc;
  let failed = false;
  try {
    doc = new DOMParser({ onError: () => { failed = true; } }).parseFromString(xml, "text/xml");
  } catch {
    return null;
  }
  if (failed || !doc?.documentElement) return null;
  const parties = Array.from(doc.getElementsByTagNameNS("*", "AccountingCustomerParty") as unknown as ArrayLike<El>);
  if (parties.length !== 1) return null; // UBL requires exactly one; anything else is a document this reading cannot vouch for
  const party = child(parties[0]!, "Party");
  const out = new Set<ProtectedFieldClass>();
  if (!party) return [];
  for (const pid of children(party).filter((c) => c.localName === "PartyIdentification")) {
    const id = child(pid, "ID");
    if (id && (id.textContent ?? "").trim() !== "" && !BUSINESS_ID_SCHEMES.includes((id.getAttribute("schemeID") ?? "").trim())) out.add("identity");
  }
  const address = child(party, "PostalAddress");
  if (address) {
    const leaves = (el: El): El[] => (children(el).length === 0 ? [el] : children(el).flatMap(leaves));
    for (const part of children(address)) {
      if (part.localName === "Country") continue; // the country is standard (D1)
      if (leaves(part).some((l) => (l.textContent ?? "").trim() !== "")) out.add("contact");
    }
  }
  return [...out];
}

/** The two classes an invoice document can carry: the buyer's address, and a personal ID in the attached XML. */
export type DocumentClass = "contact" | "identity";

/** The protected classes a rendered invoice document carries: its printed buyer block plus its attached XML. */
export function invoiceDocumentClasses(model: { buyer: { address: string | null } | null }, attachedXml?: string | null): DocumentClass[] {
  const out = new Set<ProtectedFieldClass>();
  if (model.buyer?.address && model.buyer.address.trim() !== "") out.add("contact");
  if (attachedXml != null) {
    const fromXml = xmlBuyerClasses(attachedXml);
    for (const c of fromXml ?? (["contact", "identity"] as const)) out.add(c);
  }
  return (["contact", "identity"] as const).filter((c) => out.has(c));
}
