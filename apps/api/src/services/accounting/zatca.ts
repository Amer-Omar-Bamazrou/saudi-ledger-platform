/**
 * ZATCA e-invoicing utilities (Phase 1 compliant, Phase 2 hash chaining).
 *
 * Phase 1 QR code: TLV-encoded base64 with Tags 1-5 per ZATCA Fatoora spec.
 * Phase 2 hash chain: each invoice carries SHA-256 of its canonical fields
 *   plus the previous invoice's hash — preventing retroactive tampering.
 *
 * NOT included (requires ZATCA-issued CSCA certificate):
 *   - ECDSA digital signature (Tags 6-9)
 *   - Clearance/reporting API calls
 */
import { createHash } from "crypto";

// ── TLV helpers ──────────────────────────────────────────────────────────────

function tlvField(tag: number, value: string): Buffer {
  const valueBytes = Buffer.from(value, "utf-8");
  const header = Buffer.from([tag, valueBytes.length]);
  return Buffer.concat([header, valueBytes]);
}

/** Generate a Phase-1-compliant ZATCA QR code (base64 TLV). */
export function generateZatcaQr(params: {
  sellerName: string;
  vatNumber: string;
  invoiceDateTime: string; // ISO 8601
  totalWithVat: string;
  vatAmount: string;
}): string {
  const buf = Buffer.concat([
    tlvField(1, params.sellerName),
    tlvField(2, params.vatNumber),
    tlvField(3, params.invoiceDateTime),
    tlvField(4, params.totalWithVat),
    tlvField(5, params.vatAmount),
  ]);
  return buf.toString("base64");
}

// ── Invoice hash chaining ─────────────────────────────────────────────────────

/**
 * Compute a deterministic SHA-256 hash of an invoice's immutable fields.
 * previousHash is the hash of the immediately preceding invoice (or "GENESIS" for the first).
 */
export function computeInvoiceHash(params: {
  invoiceNumber: string;
  date: string;
  sellerVatNumber: string;
  total: string;
  vatAmount: string;
  previousHash: string;
}): string {
  const canonical = [
    params.invoiceNumber,
    params.date,
    params.sellerVatNumber,
    params.total,
    params.vatAmount,
    params.previousHash,
  ].join("|");
  return createHash("sha256").update(canonical, "utf-8").digest("hex");
}

/**
 * Genesis link for the legacy (Phase 1) chain.
 *
 * NOTE: this is OUR literal, not ZATCA's. ZATCA's genesis PIH is
 * `NWZlY2ViNjZ…` — base64 of the hex string of SHA-256("0"), shipped in the SDK
 * at `Data/PIH/pih.txt`. M12.3 replaces this whole module's chain with the real
 * one; do not conflate them.
 */
export const LEGACY_GENESIS_HASH = "GENESIS";

// `getPreviousInvoiceHash(db, invoicesTable)` used to live here. It is now
// `invoicesRepository.previousInvoiceHash(companyId)` — moved so it is scoped to
// ONE COMPANY (a multi-company org previously interleaved chains) and so the
// query lives in the repository layer where Drizzle access belongs. See the
// M12.1a note on that method.
