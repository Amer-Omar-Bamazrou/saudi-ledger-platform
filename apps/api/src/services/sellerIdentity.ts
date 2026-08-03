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
 * ── The rule now ─────────────────────────────────────────────────────────────
 * Seller identity comes from the ACTIVE COMPANY, with an explicit per-invoice
 * override still honored (some tenants invoice under a specific registered
 * entity). There is NO placeholder fallback: if no VAT registration number can be
 * resolved, issuance FAILS CLOSED with an actionable error rather than minting a
 * legally-invalid invoice. That is what makes the blocker impossible to
 * reintroduce — there is no longer any value to fall back TO.
 *
 * Draft creation is deliberately lenient (a draft has no QR/hash and is not a
 * legal document); only ISSUANCE requires a VAT number.
 */
import { BusinessRuleError } from "../lib/errors";
import { companiesRepository } from "../repositories/companies.repository";

export interface SellerIdentity {
  sellerName: string;
  sellerVatNumber: string;
}

export interface SellerOverride {
  sellerName?: string | null;
  sellerVatNumber?: string | null;
}

/**
 * Resolve the seller as stamped on a DRAFT at create time. Returns whatever is
 * known (override → company); may be null when the company is not yet
 * configured, because a draft is not yet a legal document.
 */
export async function resolveDraftSeller(
  override: SellerOverride = {},
): Promise<{ sellerName: string | null; sellerVatNumber: string | null }> {
  const company = await companiesRepository.findActive();
  return {
    sellerName: override.sellerName ?? company?.name ?? null,
    sellerVatNumber: override.sellerVatNumber ?? company?.vatNumber ?? null,
  };
}

/**
 * Resolve the seller for ISSUANCE (approval) — where the ZATCA QR and the hash
 * chain are minted. Fails closed if the tenant has no VAT registration number.
 *
 * @param override seller fields already stamped on the invoice, if any.
 */
export async function requireIssuanceSeller(override: SellerOverride = {}): Promise<SellerIdentity> {
  const company = await companiesRepository.findActive();

  const sellerVatNumber = override.sellerVatNumber ?? company?.vatNumber ?? null;
  const sellerName = override.sellerName ?? company?.name ?? null;

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
