/**
 * The customer form's own request (`customerFormBody`, @workspace/shared — what the form sends, and what the live ZATCA
 * pass sends): on CREATE every offered field with a value, the national address included; on EDIT only what changed,
 * and a field the role may write but not read (the national ID for a bookkeeper) ONLY when typed — a withheld value is
 * never sent back as blank. And the form's hint names the same gaps the server refuses (buyerAddress.ts).
 */
import { describe, expect, it } from "vitest";
import { blankCustomerForm, customerFormBody, standardInvoiceAddressGaps } from "@workspace/shared";
import { missingBuyerAddressFields } from "../services/einvoice/buyerAddress";

const ADDRESS = { buildingNumber: "4321", street: "Olaya Street", district: "Al Olaya", city: "Riyadh", postalCode: "12211", additionalNumber: "6789" };

describe("the customer form's request", () => {
  it("create: every typed field, the national address included; country upper-cased; an empty credit limit is null, not 0", () => {
    const body = customerFormBody("create", { ...blankCustomerForm(), name: "Al-Waha", taxNumber: "300000000000003", ...ADDRESS, country: "sa" }, blankCustomerForm());
    expect(body).toEqual({ name: "Al-Waha", taxNumber: "300000000000003", ...ADDRESS, country: "SA", paymentTermsDays: "30", creditLimit: null });
  });

  it("edit: only what changed; a cleared field is null", () => {
    const initial = { ...blankCustomerForm(), name: "Al-Waha", ...ADDRESS };
    expect(customerFormBody("edit", { ...initial, street: "King Fahd Road", district: "" }, initial)).toEqual({ street: "King Fahd Road", district: null });
    expect(customerFormBody("edit", initial, initial)).toEqual({});
  });

  it("🔴 edit, blind field (written, never read back): sent only when typed — an empty one is never sent as a blank", () => {
    const initial = { ...blankCustomerForm(), name: "Al-Waha" };
    const blind = (f: string) => f === "nationalId";
    expect(customerFormBody("edit", initial, initial, () => true, blind)).toEqual({});
    expect(customerFormBody("edit", { ...initial, nationalId: "1084215588" }, initial, () => true, blind)).toEqual({ nationalId: "1084215588" });
  });

  it("a field the role may not write is never sent", () => {
    const body = customerFormBody("create", { ...blankCustomerForm(), name: "X", nationalId: "1084215588" }, blankCustomerForm(), (f) => f !== "nationalId");
    expect("nationalId" in body).toBe(false);
  });

  it("the form's hint names exactly the gaps the server refuses", () => {
    for (const f of [
      { ...blankCustomerForm(), taxNumber: "300000000000003" },
      { ...blankCustomerForm(), taxNumber: "300000000000003", ...ADDRESS, postalCode: "1221" },
      { ...blankCustomerForm(), taxNumber: "300000000000003", ...ADDRESS, additionalNumber: "12" },
      { ...blankCustomerForm(), taxNumber: "GB1", country: "GB", city: "London" },
      { ...blankCustomerForm(), taxNumber: "" },
      { ...blankCustomerForm(), taxNumber: "300000000000003", ...ADDRESS },
    ]) {
      expect(standardInvoiceAddressGaps(f)).toEqual(missingBuyerAddressFields({ ...f, country: f.country }));
    }
  });
});
