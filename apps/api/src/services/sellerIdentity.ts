/**
 * Seller identity for e-invoicing (M11.6) — the SINGLE source of truth.
 *
 * ── The bug this replaces ────────────────────────────────────────────────────
 * `invoices.service.ts` and `invoices.approvable.ts` each declared their OWN
 * copy of:
 *     const DEFAULT_SELLER_VAT  = "300000000000003";   // ZATCA SANDBOX placeholder
 *     const DEFAULT_SELLER_NAME = "KSA Ledger Company";
 * and fell back to them whenever the invoice carried no seller. The tenant's real
 * `companies.vatNumber` was never consulted, so **every invoice the platform ever
 * issued carried a fake VAT number** in its ZATCA QR (tag 2) and in the invoice
 * hash — a documented production blocker. Two duplicated copies also meant the
 * values could silently drift apart.
 *
 * ── The rule now (G31, 2026-10-07 — owner amendment E) ─────────────────────
 * Seller identity comes from THE INVOICE'S OWN COMPANY, read AT ISSUE, and is
 * fixed on the document from then on. It is NEVER accepted from a request:
 * the per-invoice "override" that used to win here let any WRITE role stamp a
 * VAT number the company does not hold onto a tax invoice, while an onboarded
 * company's signed XML carried the real one — the artifacts disagreed. The
 * same precedence made an honest draft STALE: a draft stamped before the
 * company corrected its VAT kept the old number through approval. A tenant
 * that invoices as another registered entity does so as another COMPANY (its
 * own VAT, its own EGS unit and certificate), never as an override.
 *
 * Drafts carry no seller identity at all: a draft is not a legal document,
 * and a copy taken at create time could only ever be a stale second source.
 * There is NO placeholder fallback: if no VAT registration number can be
 * resolved, issuance FAILS CLOSED with an actionable error rather than
 * minting a legally-invalid invoice. The database holds the same rule
 * (migration 0121): an issuing write must carry the company's own name and
 * VAT, and an issued document's seller identity cannot change.
 *
 * M12.1a sharpened "the active company" to "the invoice's company". M11.6 read
 * the org's FIRST-CREATED company regardless of which company the invoice
 * belonged to — identical for a single-company org, but the wrong legal entity
 * (and, under ZATCA Phase 2, the wrong signing certificate) as soon as an org
 * has two.
 */
import { BusinessRuleError } from "../lib/errors";
import { companiesRepository } from "../repositories/companies.repository";

export interface SellerIdentity {
  sellerName: string;
  sellerVatNumber: string;
}

/**
 * Resolve the seller for ISSUANCE (approval) — where the ZATCA QR and the hash
 * chain are minted. Fails closed if the company has no VAT registration number
 * or legal name.
 *
 * ── M12.1a bug fix ──────────────────────────────────────────────────────────
 * This used to call `companiesRepository.findActive()` — the organization's
 * FIRST-CREATED company — ignoring the `companyId` the invoice already carries.
 * For a single-company org the two coincide, so it was invisible. For a
 * multi-company org it stamps the WRONG company's legal identity onto the
 * invoice, and under ZATCA Phase 2 it would sign with the wrong company's
 * certificate — a compliance failure, not just a display bug.
 *
 * The company is an explicit, required argument: the caller passes the
 * invoice's own `companyId`, so the seller can never drift from the document.
 * There is deliberately no second argument (G31): nothing stamped on the
 * draft, and nothing a client sent, can stand in for the company record.
 *
 * @param companyId the invoice's `companyId` — NOT "the active company".
 */
export async function requireIssuanceSeller(companyId: string): Promise<SellerIdentity> {
  const company = await companiesRepository.findById(companyId);

  const sellerVatNumber = company?.vatNumber ?? null;
  const sellerName = company?.name ?? null;

  if (!sellerVatNumber) {
    throw new BusinessRuleError(400, {
      error:
        "Your company's VAT registration number is required to issue an invoice. " +
        "Set it in Company Settings before approving invoices.",
      code: "company_vat_missing",
    });
  }
  if (!sellerName) {
    throw new BusinessRuleError(400, {
      error: "Your company's legal name is required to issue an invoice. Set it in Company Settings.",
      code: "company_name_missing",
    });
  }

  return { sellerName, sellerVatNumber };
}
