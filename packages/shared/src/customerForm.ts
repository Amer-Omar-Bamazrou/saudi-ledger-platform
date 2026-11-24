/**
 * 🔴 THE CUSTOMER FORM'S OWN REQUEST — one definition, used by the form (apps/web CustomerForm) and by the tests that
 * must send exactly what the form sends (the live ZATCA pass, customer-form-standard-invoice-live.test.ts). The
 * invoice form's lines follow the same pattern (invoiceFormLines.ts).
 *
 * The form holds strings. On CREATE it sends every offered field with a value (`creditLimit` "" → null: no limit). On
 * EDIT it sends ONLY what changed — a field the role may write but not read (the national ID for a bookkeeper) only
 * when typed — so a withheld value is never sent back as blank.
 */
export const CUSTOMER_FORM_FIELDS = [
  "name", "nameAr", "taxNumber", "crNumber", "nationalId", "phone", "email",
  "buildingNumber", "street", "district", "city", "postalCode", "additionalNumber", "country", "address",
  "paymentTermsDays", "creditLimit", "notes",
] as const;
export type CustomerFormField = (typeof CUSTOMER_FORM_FIELDS)[number];
export type CustomerFormValues = Record<CustomerFormField, string>;

export const blankCustomerForm = (): CustomerFormValues => ({
  name: "", nameAr: "", taxNumber: "", crNumber: "", nationalId: "", phone: "", email: "", buildingNumber: "", street: "", district: "",
  city: "", postalCode: "", additionalNumber: "", country: "SA", address: "", paymentTermsDays: "30", creditLimit: "", notes: "",
});

/**
 * The request body. `can(f)`: the role may write the field. `blind(f)`: it may write but not read it (edit only).
 */
export function customerFormBody(
  mode: "create" | "edit",
  form: CustomerFormValues,
  initial: CustomerFormValues,
  can: (f: CustomerFormField) => boolean = () => true,
  blind: (f: CustomerFormField) => boolean = () => false,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of CUSTOMER_FORM_FIELDS) {
    if (!can(f)) continue;
    const v = form[f].trim();
    const value = f === "creditLimit" ? (v === "" ? null : Number(v)) : v === "" ? null : f === "country" ? v.toUpperCase() : v;
    if (mode === "create") { if (v !== "" || f === "creditLimit") out[f] = value; continue; }
    if (blind(f)) { if (v !== "") out[f] = value; continue; }
    if (v !== initial[f].trim()) out[f] = value;
  }
  if (mode === "create" && out.paymentTermsDays == null) out.paymentTermsDays = "30";
  return out;
}

/**
 * What a STANDARD tax invoice to this buyer will be missing — the server's rule (apps/api services/einvoice/
 * buyerAddress.ts: BR-KSA-63, BR-KSA-67, BR-KSA-10), for the form's hint. The server refuses the approval; this only
 * says so before.
 */
export function standardInvoiceAddressGaps(f: Pick<CustomerFormValues, "taxNumber" | "country" | "street" | "buildingNumber" | "postalCode" | "city" | "district" | "additionalNumber">): CustomerFormField[] {
  if (f.taxNumber.trim() === "") return [];
  const saudi = (f.country.trim().toUpperCase() || "SA") === "SA";
  if (!saudi) return (["street", "city"] as const).filter((k) => f[k].trim() === "");
  const gaps: CustomerFormField[] = [];
  if (f.street.trim() === "") gaps.push("street");
  if (f.buildingNumber.trim() === "") gaps.push("buildingNumber");
  if (!/^\d{5}$/.test(f.postalCode.trim())) gaps.push("postalCode");
  if (f.city.trim() === "") gaps.push("city");
  if (f.district.trim() === "") gaps.push("district");
  if (f.additionalNumber.trim() !== "" && !/^\d{4}$/.test(f.additionalNumber.trim())) gaps.push("additionalNumber");
  return gaps;
}
