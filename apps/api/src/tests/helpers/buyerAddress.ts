/**
 * A complete Saudi national address for a fixture's BUSINESS buyer (2026-11-24). A standard tax invoice to a
 * VAT-registered Saudi buyer is refused at approval without street, building number, a 5-digit postal code, city and
 * district (services/einvoice/buyerAddress.ts — BR-KSA-63, BR-KSA-67). A fixture that issues to such a buyer gives it
 * this address; it changes nothing the fixture asserts.
 */
export const SA_BUYER_ADDRESS = { buildingNumber: "4321", street: "Olaya Street", district: "Al Olaya", city: "Riyadh", postalCode: "12211", additionalNumber: "6789" } as const;
