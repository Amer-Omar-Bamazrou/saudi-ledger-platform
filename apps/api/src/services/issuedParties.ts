/**
 * 🔴 T1c (Phase 18, G32; final-run memo 2026-10-27 §2 B): the parties an issued
 * document PRINTS, captured at issue from the records themselves, so a reprint
 * never reads the live company or customer.
 *
 * G31/G30 (0121) already fix the seller's name, VAT number and bank details at
 * issue. This captures the rest of what the document states about its parties:
 * the seller's Arabic name, CR, address and logo, and the whole buyer block.
 *
 * 🔴 ONE SHAPE, TWO WRITERS OF IT, ONE CHECK. The database compares the capture
 * with `invoice_seller_capture()` / `invoice_buyer_capture()` (migration 0133)
 * at the issuing write, key by key, so the keys and their sources here must be
 * exactly those. A key added here and not there is refused at issue — loudly,
 * never silently.
 */
import { companiesRepository } from "../repositories/companies.repository";
import { customersRepository } from "../repositories/customers.repository";

export interface IssuedSeller {
  nameAr: string | null;
  crNumber: string | null;
  buildingNumber: string | null;
  street: string | null;
  district: string | null;
  city: string | null;
  postalCode: string | null;
  logoPath: string | null;
}

export interface IssuedBuyer {
  name: string;
  nameAr: string | null;
  vatNumber: string | null;
  crNumber: string | null;
  buildingNumber: string | null;
  street: string | null;
  district: string | null;
  city: string | null;
  postalCode: string | null;
}

/** Read inside the issuing transaction, beside G31's seller stamp and G30's bank capture. */
export async function captureIssuedParties(companyId: string, customerId: number | null): Promise<{ seller: IssuedSeller; buyer: IssuedBuyer | null }> {
  const company = await companiesRepository.findById(companyId);
  if (!company) throw new Error(`captureIssuedParties: company ${companyId} is not readable in this transaction`);
  const seller: IssuedSeller = {
    nameAr: company.nameAr ?? null,
    crNumber: company.crNumber ?? null,
    buildingNumber: company.buildingNumber ?? null,
    street: company.street ?? null,
    district: company.district ?? null,
    city: company.city ?? null,
    postalCode: company.postalCode ?? null,
    logoPath: company.logoPath ?? null,
  };
  if (customerId == null) return { seller, buyer: null };
  const [customer] = await customersRepository.findById(customerId);
  if (!customer) throw new Error(`captureIssuedParties: customer ${customerId} is not readable in this transaction`);
  return {
    seller,
    buyer: {
      name: customer.name,
      nameAr: customer.nameAr ?? null,
      vatNumber: customer.taxNumber ?? null,
      crNumber: customer.crNumber ?? null,
      buildingNumber: customer.buildingNumber ?? null,
      street: customer.street ?? null,
      district: customer.district ?? null,
      city: customer.city ?? null,
      postalCode: customer.postalCode ?? null,
    },
  };
}
