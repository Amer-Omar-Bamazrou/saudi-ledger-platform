/**
 * The e-invoice archive backend — a SWAPPABLE seam (M12.8).
 *
 * ── Why this is an interface and not just "use Supabase Storage" ────────────
 * The hosting region for archived invoices is an OPEN DEPLOYMENT DECISION, and
 * it is open for a more interesting reason than it looks.
 *
 * We recorded for months that ZATCA requires archives on servers inside Saudi
 * Arabia. **It does not.** §5.5 of the E-Invoicing Detailed Guideline explicitly
 * permits storing invoices "in a server on-premises in the KSA **or in the
 * cloud**". The claim came from a secondary source and was never checked against
 * the primary one. What §5.5 *does* mandate is different in kind: if the data is
 * in the cloud "it must be accessible through a direct link that can be made
 * available to the Authority" — an ACCESSIBILITY obligation, which is why
 * {@link ArchiveStore.directLink} is part of this interface rather than an
 * afterthought.
 *
 * Residency pressure may still exist from the National Cybersecurity Authority
 * or sector regulation — §5.5 defers to them by name — but that is a legal
 * question we have not verified and must not act on as though we had. So the
 * engineering position is unchanged and the reason is better: an unverified
 * claim is not a basis for committing hosting, **and neither is the absence of
 * one**. The interface is what lets the legal answer arrive late without a
 * rewrite. Do not collapse it because "we can just use Supabase".
 *
 * ── 🔴 THERE IS NO `delete` METHOD, AND THAT IS THE DESIGN ──────────────────
 * ZATCA §5.5: "Once invoices are generated, they should not be deleted or
 * altered by any user", and the solution must protect them "from any alteration
 * or undetected deletion". Immutability is a property of the archive, not a
 * retention duration. Following the discipline already proven on `audit_logs`
 * and `security_audit_logs` — where append-only is enforced by REVOKE in the
 * database rather than by convention — the interface simply cannot express
 * deletion. Adding a `delete` here would silently make every implementation
 * capable of destroying legally-required records.
 */

export interface ArchivePutResult {
  /** SHA-256 of the stored bytes, hex. Lets a later read prove nothing changed. */
  sha256: string;
  byteSize: number;
}

export interface ArchiveLink {
  url: string;
  expiresAt: Date;
}

export interface ArchiveStore {
  /** Identifies the backend in stored metadata, so a migration knows where a row's bytes live. */
  readonly provider: string;

  /**
   * Store an object. MUST fail rather than overwrite: re-archiving a document
   * is a bug, and silently replacing a legally-retained artifact is the failure
   * this whole module exists to prevent.
   */
  put(objectPath: string, bytes: Buffer, contentType: string): Promise<ArchivePutResult>;

  get(objectPath: string): Promise<{ bytes: Buffer; contentType: string }>;

  exists(objectPath: string): Promise<boolean>;

  /**
   * A direct, time-limited link to the object — ZATCA §5.5's mandatory audit
   * access path.
   *
   * Time-limited because the obligation is that a link "can be made available"
   * to the Authority, not that the archive is publicly readable. A backend with
   * no native signed-URL support returns an API-brokered URL instead; either
   * satisfies the requirement, which is why this is on the interface and not on
   * one implementation.
   */
  directLink(objectPath: string, ttlSeconds: number): Promise<ArchiveLink>;
}

/** Thrown when a put would overwrite an existing object. */
export class ArchiveConflictError extends Error {
  readonly statusCode = 409;
  constructor(objectPath: string) {
    super(`An archived object already exists at ${objectPath}; the archive is append-only.`);
    this.name = "ArchiveConflictError";
  }
}

export class ArchiveUnavailableError extends Error {
  readonly statusCode = 503;
  constructor(detail: string) {
    super(`The e-invoice archive is unavailable: ${detail}`);
    this.name = "ArchiveUnavailableError";
  }
}
