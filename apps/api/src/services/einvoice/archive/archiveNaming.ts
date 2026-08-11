/**
 * ZATCA's archive file-naming convention (M12.8).
 *
 * ── The rule, quoted from the primary source ────────────────────────────────
 * §5.5 of the E-Invoicing Detailed Guideline (pinned in `docs/zatca/specs/`):
 *
 *   "Each stored invoice must follow a naming convention for naming of the
 *    file: VAT Registration (tax registration number) + Timestamp (date and
 *    time at the point of invoice generation) + Invoice Reference Number"
 *
 * ── 🔴 THE TIMESTAMP IS GENERATION, NOT CLEARANCE ──────────────────────────
 * The specification says "at the point of invoice GENERATION". It is easy — and
 * invisible once done — to reach for the clearance/reporting timestamp instead,
 * because that is when the archived (cleared) XML comes into existence. They are
 * genuinely different instants: clearance happens after issuance, and a
 * simplified invoice may be reported up to 24 hours later. So the name is built
 * from `invoices.issued_at`, the real issuance instant M12.1a added for exactly
 * this class of question, and never from `completed_at` or `now()`.
 *
 * A wrong timestamp here is not cosmetic: the filename is how an auditor locates
 * a document, so an archive named on clearance time is an archive that does not
 * match the invoices it holds.
 */

/** `2026-08-11T21:34:05.123Z` → `20260811T213405` (UTC, second precision). */
export function archiveTimestamp(generatedAt: Date): string {
  const iso = generatedAt.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
}

/**
 * Strip anything that would be unsafe in a filename or object key.
 *
 * Invoice numbers are tenant-supplied free text, so they can contain slashes
 * (`INV/2026/001` is a common Saudi format), spaces, or Arabic characters. A
 * raw slash would silently create a directory level and break the convention;
 * worse, `..` would escape the archive root.
 */
export function sanitizeReference(reference: string): string {
  const cleaned = reference
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100);
  return cleaned || "UNKNOWN";
}

export interface ArchiveNameInput {
  /** The SELLER's VAT registration number — the taxpayer who issued the document. */
  sellerVatNumber: string;
  /** 🔴 `invoices.issued_at` — the GENERATION instant. Never the clearance time. */
  generatedAt: Date;
  /** `invoices.invoice_number`. */
  invoiceReference: string;
}

/** `310123456789013_20260811T213405_INV-001.xml` */
export function archiveFileName(input: ArchiveNameInput): string {
  const vat = sanitizeReference(input.sellerVatNumber);
  return `${vat}_${archiveTimestamp(input.generatedAt)}_${sanitizeReference(input.invoiceReference)}.xml`;
}

/**
 * Full object path within the archive backend.
 *
 * Prefixed by organization and company so a tenant's documents are contiguous
 * and one company's EGS unit never interleaves with another's — the same
 * per-company boundary the hash chain and ICV observe. The year segment keeps
 * directory listings usable across a retention window that runs to 11 years.
 */
export function archiveObjectPath(
  organizationId: string,
  companyId: string,
  input: ArchiveNameInput,
): string {
  const year = input.generatedAt.toISOString().slice(0, 4);
  return `${organizationId}/${companyId}/${year}/${archiveFileName(input)}`;
}
