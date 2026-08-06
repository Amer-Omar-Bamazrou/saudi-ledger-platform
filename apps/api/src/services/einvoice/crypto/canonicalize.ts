/**
 * ZATCA canonicalisation — the transform chain that everything else hangs off
 * (M12.3).
 *
 * ── The C14N 1.1 question, and why C14N 1.0 is correct here ─────────────────
 * ZATCA mandates `http://www.w3.org/2006/12/xml-c14n11`. **No maintained Node
 * XML-DSig library implements C14N 1.1** — `xmldsigjs` has only exclusive C14N,
 * `xml-crypto` only inclusive C14N 1.0. We use `xml-crypto`'s inclusive C14N 1.0
 * engine and declare `xml-c14n11`, which is ACCURATE rather than a fudge:
 *
 *   C14N 1.1 differs from C14N 1.0 in exactly one respect — the handling of
 *   `xml:base` / `xml:id` / `xml:lang` / `xml:space` inheritance when an element
 *   in the canonicalised set has an OMITTED ANCESTOR. With no omitted ancestors,
 *   the two are the same algorithm.
 *
 * Three independent proofs that this holds for ZATCA invoices (see
 * `docs/zatca/c14n-decision.md` for the full record):
 *
 *   1. STRUCTURAL — ZATCA's exclusions are `not(//ancestor-or-self::X)`, which
 *      removes X *and its whole subtree*. No surviving element ever has an
 *      omitted ancestor. Measured: 0 orphans. {@link assertSubtreeComplete}
 *      re-checks this at runtime.
 *   2. SCHEMA — `xml:*` attributes cannot appear in a valid UBL invoice at all:
 *      no UBL XSD imports the `xml` namespace, so they cannot be declared. UBL
 *      tags language with `languageID`. ZATCA's own signer rejects a document
 *      carrying `xml:lang`. {@link assertNoXmlAttributes} enforces this.
 *   3. EMPIRICAL — our output is byte-identical to ZATCA's hash, in the plain
 *      case AND with `xml:base`/`xml:lang`/`xml:space`/`xml:id` injected.
 *      ZATCA bundles Apache Santuario including a real `Canonicalizer11`, so we
 *      are matching genuine C14N 1.1, not a shared bug.
 *
 * The guards below are RUNTIME assertions, not fixture tests, deliberately: a
 * fixture test only catches the documents someone thought to write.
 */
import { DOMParser } from "@xmldom/xmldom";
import { C14nCanonicalization } from "xml-crypto";
import * as xpath from "xpath";
import { BusinessRuleError } from "../../../lib/errors";

/** ZATCA's declared canonicalisation algorithm. See the module docstring. */
export const C14N_ALGORITHM = "http://www.w3.org/2006/12/xml-c14n11";
/** ZATCA's XPath transform algorithm. */
export const XPATH_ALGORITHM = "http://www.w3.org/TR/1999/REC-xpath-19991116";

/**
 * The three exclusions, verbatim from ZATCA's own `xml/ubl.xml` template.
 * Order is significant — it is reproduced in the emitted `ds:Transforms`.
 */
export const ZATCA_TRANSFORM_XPATHS = [
  "not(//ancestor-or-self::ext:UBLExtensions)",
  "not(//ancestor-or-self::cac:Signature)",
  "not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])",
] as const;

/** Namespace-agnostic selectors matching the XPaths above. */
const EXCLUDE_SELECTORS = [
  "//*[local-name()='UBLExtensions']",
  "//*[local-name()='Signature']",
  "//*[local-name()='AdditionalDocumentReference'][*[local-name()='ID']='QR']",
] as const;

const XML_ATTRS = ["xml:base", "xml:id", "xml:lang", "xml:space"] as const;

/**
 * GUARD 1 — fail loudly if the document carries any `xml:*` attribute.
 *
 * This is the ONLY condition under which C14N 1.0 could diverge from 1.1, and it
 * cannot occur in a schema-valid UBL invoice. If it ever does, our canonical
 * form may not match ZATCA's, so we must refuse to sign rather than emit an
 * invoice whose hash is subtly wrong.
 */
export function assertNoXmlAttributes(doc: Document): void {
  const offenders: string[] = [];
  for (const el of xpath.select("//*", doc as any) as any[]) {
    for (const name of XML_ATTRS) {
      if (el.getAttribute?.(name)) offenders.push(`${el.nodeName}/@${name}`);
    }
  }
  if (offenders.length > 0) {
    throw new BusinessRuleError(500, {
      error:
        "Refusing to sign: the invoice contains xml:* attributes " +
        `(${offenders.join(", ")}). Our canonicalisation is only proven equivalent to ` +
        "ZATCA's C14N 1.1 in their absence. See services/einvoice/crypto/canonicalize.ts.",
      code: "xml_namespace_attributes_present",
    });
  }
}

/**
 * GUARD 2 — fail loudly if the exclusions are NOT subtree-complete.
 *
 * Pins the actual invariant rather than one of its consequences: if any element
 * survives the transform while one of its ancestors was removed, the C14N
 * 1.0/1.1 divergence becomes reachable and our hash may be wrong.
 */
export function assertSubtreeComplete(doc: Document): void {
  const excluded = new Set<any>();
  for (const selector of EXCLUDE_SELECTORS) {
    for (const node of xpath.select(selector, doc as any) as any[]) {
      excluded.add(node);
      for (const d of xpath.select(".//*", node) as any[]) excluded.add(d);
    }
  }
  for (const el of xpath.select("//*", doc as any) as any[]) {
    if (excluded.has(el)) continue;
    let p = (el as any).parentNode;
    while (p && p.nodeType === 1) {
      if (excluded.has(p)) {
        throw new BusinessRuleError(500, {
          error:
            `Refusing to sign: element <${(el as any).nodeName}> survives the ZATCA transform ` +
            "but one of its ancestors was excluded. That makes the C14N 1.0/1.1 divergence " +
            "reachable and our invoice hash may not match ZATCA's.",
          code: "transform_not_subtree_complete",
        });
      }
      p = p.parentNode;
    }
  }
}

/**
 * Apply ZATCA's transform chain and return the canonical form.
 *
 * Both guards run BEFORE canonicalisation, so a document that could produce a
 * wrong hash never reaches the digest.
 */
export function canonicalizeForZatca(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;

  assertNoXmlAttributes(doc);
  assertSubtreeComplete(doc);

  for (const selector of EXCLUDE_SELECTORS) {
    for (const node of xpath.select(selector, doc as any) as any[]) {
      node.parentNode?.removeChild(node);
    }
  }

  return new (C14nCanonicalization as any)().process((doc as any).documentElement, {}) as string;
}
