/**
 * Enqueue a signed e-invoice for transmission to ZATCA (M12.8).
 *
 * ── THE MISSING LINK ────────────────────────────────────────────────────────
 * Until M12.8 nothing in production ever inserted an `einvoice_documents` row.
 * M12.6 built the transport and proved it offline; M12.4 proved the crypto
 * against ZATCA's live API. Neither was reachable from an invoice a user
 * actually issued, because this function did not exist. `listOverdue()` had no
 * callers, the worker was never instantiated, and `ZATCA_WORKER_ENABLED` was
 * referenced in two comments but never declared. This is the third time in M12
 * that a correct component turned out not to be connected — see CLAUDE.md.
 *
 * ── WHY SIGNING HAPPENS HERE, IN THE REQUEST ────────────────────────────────
 * The worker's contract is explicit: it "NEVER mints a uuid, icv, hash or
 * signature — it only reads what approval already committed", which is what
 * makes a retry byte-identical and therefore safe. So the document must be
 * built, signed and hashed at ISSUANCE, and committed in the same transaction
 * as the ledger effect.
 *
 * That is not merely convention. ZATCA's chain is `PIH(n) = hash(n-1)`, so the
 * chain head must be read and the next hash written in ONE critical section —
 * the per-company advisory lock the caller already holds for the ICV. Deferring
 * signing to the worker would move that read outside the lock and reintroduce
 * the fork this milestone just fixed.
 *
 * The outbound HTTP call is the only thing that cannot live in the request
 * transaction, and that is precisely what the worker keeps.
 */
import { loadEnv } from "@workspace/config";
import { logger } from "../../../lib/logger";
import { invoicesRepository } from "../../../repositories/invoices.repository";
import { einvoiceDocumentsRepository } from "../../../repositories/einvoiceDocuments.repository";
import { signingService } from "../signing/signing.service";
import { loadEInvoiceInput } from "../einvoiceInput.loader";
import { resolveProvider } from "../zatca/zatcaDirectProvider";

export interface EnqueueTarget {
  id: number;
  organizationId: string;
  companyId: string;
}

export interface EnqueueResult {
  /** `null` when the company is not onboarded — not an error, see below. */
  documentId: string | null;
  /** The Phase-2 (9-tag) QR, when one was minted. */
  qrCode: string | null;
}

/**
 * Build, sign and queue the ZATCA document for a just-issued invoice or note.
 *
 * 🔴 CALL ONLY WHILE HOLDING `invoicesRepository.lockCompanySequence(companyId)`,
 * and only after the invoice row has its `icv` / `zatca_uuid` committed to the
 * transaction — this reads the chain head and writes the next link.
 *
 * ── The two failure policies, and why they differ ───────────────────────────
 * **Not onboarded ⇒ skip, silently.** A company with no active credential is
 * not a ZATCA Phase-2 taxpayer as far as this platform is concerned. It must
 * still be able to invoice: the ledger, the GL and Phase-1 QR are unaffected.
 * Returning `null` here is the ONLY reason issuance still works for every
 * existing tenant and every existing test.
 *
 * **Onboarded but the document cannot be built or signed ⇒ THROW.** This rolls
 * the whole approval back, so no invoice is issued. That is deliberate and it
 * is the more conservative choice: for an onboarded taxpayer, an invoice ZATCA
 * never learns about is a compliance breach, and — worse — it would consume an
 * ICV and a chain position that can never be filled, leaving a permanent gap in
 * a legally-required sequence. Refusing to issue is recoverable; a gap is not.
 *
 * The practical cost is that a KMS outage, or invoice data too incomplete to
 * assemble (a NULL tax category, a missing buyer address on a B2B sale), blocks
 * issuance for onboarded companies rather than degrading quietly. That is the
 * same fail-closed posture as `requireIssuanceSeller` in M11.6.
 */
export async function enqueueEInvoice(invoice: EnqueueTarget): Promise<EnqueueResult> {
  const env = loadEnv();
  const environment = env.ZATCA_ENVIRONMENT;

  // Is this company a Phase-2 taxpayer? Metadata only — no key material.
  const credential = await signingService.findActiveMetadata(invoice.companyId, environment);
  if (!credential) {
    logger.debug(
      { companyId: invoice.companyId, invoiceId: invoice.id, environment },
      "e-invoice: company has no active ZATCA credential; not enqueueing",
    );
    return { documentId: null, qrCode: null };
  }

  // The chain head, read INSIDE the caller's lock. `null` ⇒ first document,
  // and the assembler substitutes ZATCA's defined genesis constant.
  const previousInvoiceHash = await invoicesRepository.zatcaPreviousInvoiceHash(
    invoice.companyId,
    invoice.id,
  );

  const input = await loadEInvoiceInput(invoice.id, previousInvoiceHash);

  // Standard (B2B) is CLEARED before issuance; simplified (B2C) is REPORTED
  // within 24 hours. The subtype is derived from whether the buyer is
  // VAT-registered, so the flow follows the document rather than a setting.
  const flow = input.subtype === "standard" ? "clearance" : "reporting";

  const provider = resolveProvider();

  // The key is decrypted only inside this callback and zeroed on exit; the
  // signed artifacts are all that escape. No network call happens in here.
  const built = await signingService.withSigningCredentials(
    invoice.companyId,
    environment,
    (credentials) => provider.buildDocument(input, credentials),
  );

  if (!built.invoiceHash || !built.qrCode) {
    // buildDocument returns an unsigned preview when given no credentials. We
    // gave credentials, so this is unreachable — but the worker rejects a
    // document with no hash as "never signed", and a queued row that can only
    // fail is worse than a refused issuance.
    throw new Error("e-invoice document was assembled without a hash or QR");
  }

  const doc = await einvoiceDocumentsRepository.insert({
    organizationId: invoice.organizationId,
    companyId: invoice.companyId,
    invoiceId: invoice.id,
    // Copied onto the document row so the worker (base pool, no business joins)
    // can send the uuid ZATCA must see match `cbc:UUID`.
    zatcaUuid: input.uuid,
    flow,
    invoiceHash: built.invoiceHash,
    previousInvoiceHash: built.previousInvoiceHash,
    qrCode: built.qrCode,
    signedXml: built.xml,
  });

  logger.info(
    { invoiceId: invoice.id, companyId: invoice.companyId, flow, icv: input.icv },
    "e-invoice: queued for ZATCA",
  );

  return { documentId: doc.id, qrCode: built.qrCode };
}
