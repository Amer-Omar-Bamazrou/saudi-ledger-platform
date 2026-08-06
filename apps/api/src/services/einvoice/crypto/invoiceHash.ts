/**
 * The ZATCA invoice hash and PIH chain (M12.3).
 *
 * ── This REPLACES the homegrown chain, it does not extend it ────────────────
 * `services/accounting/zatca.ts` computes a hex SHA-256 over a pipe-joined
 * field list with a `"GENESIS"` literal. That was our own tamper-evidence
 * mechanism and has nothing to do with ZATCA:
 *
 *   Legacy  sha256_HEX("num|date|vat|total|vatAmount|prevHash")
 *   ZATCA   BASE64( SHA-256( C14N( XML minus the three excluded elements ) ) )
 *
 * Verified byte-identical against `fatoora -generateHash`; the equality test is
 * permanent and blocking, so a change on either side surfaces in CI.
 */
import { createHash } from "crypto";
import { canonicalizeForZatca } from "./canonicalize";

/**
 * ZATCA's genesis Previous Invoice Hash — the PIH of the first document in a
 * company's chain. Shipped in the SDK at `Data/PIH/pih.txt`.
 *
 * NOTE THE DOUBLE ENCODING: this is Base64 of the **hex string** of
 * SHA-256("0"), not Base64 of the raw digest bytes. The two differ, and
 * reaching for the obvious one is the classic mistake.
 */
export const GENESIS_PIH =
  "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==";

/**
 * The invoice hash: base64( SHA-256( canonicalised XML ) ).
 *
 * Returns both encodings because they are used differently and are NOT
 * interchangeable:
 *   - `base64` goes into `ds:DigestValue` and the PIH of the next invoice
 *   - `bytes` (the raw 32-byte digest) goes into QR **tag 6**
 */
export function computeInvoiceHash(xml: string): { base64: string; bytes: Buffer } {
  const canonical = canonicalizeForZatca(xml);
  const bytes = createHash("sha256").update(canonical, "utf8").digest();
  return { base64: bytes.toString("base64"), bytes };
}

/** Digest an arbitrary buffer/string as base64 SHA-256 (cert digests, etc). */
export function sha256Base64(input: Buffer | string): string {
  return createHash("sha256")
    .update(input as any)
    .digest("base64");
}
