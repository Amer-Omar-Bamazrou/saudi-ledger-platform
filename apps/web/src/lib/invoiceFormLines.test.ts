import { describe, expect, it } from "vitest";
import { emptyInvoiceLine, invoiceLineFromItem, invoiceLinesBody, withCategory } from "@workspace/shared";

/** The invoice form's lines → the request's items (the create, the edit and the live ZATCA pass all send this). */
describe("invoiceLinesBody — what the invoice form sends for its lines", () => {
  const priced = (extra = {}) => ({ ...emptyInvoiceLine(), description: "Line", quantity: "2", unitPrice: "500", ...extra });

  it("a standard-rated line: its rate, category S, and no reason", () => {
    expect(invoiceLinesBody([priced()])).toEqual([{ description: "Line", quantity: 2, unitPrice: 500, vatRate: 15, taxCategoryCode: "S" }]);
  });

  it("a zero-rated line: 0%, category Z and the chosen code (the server stores ZATCA's text)", () => {
    const line = { ...withCategory(priced(), "Z"), taxExemptionReasonCode: "VATEX-SA-EDU" };
    expect(invoiceLinesBody([line])).toEqual([{ description: "Line", quantity: 2, unitPrice: 500, vatRate: 0, taxCategoryCode: "Z", taxExemptionReasonCode: "VATEX-SA-EDU" }]);
  });

  it("a zero-rated line with no reason chosen sends none (the server refuses it at approval)", () => {
    expect(invoiceLinesBody([withCategory(priced(), "Z")])[0]).not.toHaveProperty("taxExemptionReasonCode");
  });

  it("an out-of-scope line: VATEX-SA-OOS and the taxpayer's own text", () => {
    const line = { ...withCategory(priced(), "O"), taxExemptionReasonText: "  Reimbursed government fee  " };
    expect(invoiceLinesBody([line])[0]).toMatchObject({ vatRate: 0, taxCategoryCode: "O", taxExemptionReasonCode: "VATEX-SA-OOS", taxExemptionReasonText: "Reimbursed government fee" });
  });

  it("a reason of another category is sent as chosen (the server refuses it by name); changing the category clears it", () => {
    // an exempt code typed onto a zero-rated line (as an edit could leave it)
    expect(invoiceLinesBody([{ ...withCategory(priced(), "Z"), taxExemptionReasonCode: "VATEX-SA-29" }])[0]).toMatchObject({ taxExemptionReasonCode: "VATEX-SA-29" });
    // …the server refuses that mismatch by name; changing the category clears a reason of the old one
    expect(withCategory({ ...withCategory(priced(), "Z"), taxExemptionReasonCode: "VATEX-SA-32" }, "E").taxExemptionReasonCode).toBe("");
  });

  it("back to standard: the rate returns to the default and the reason is cleared", () => {
    const back = withCategory({ ...withCategory(priced(), "Z"), taxExemptionReasonCode: "VATEX-SA-32" }, "S");
    expect(back).toMatchObject({ vatRate: "15", taxCategoryCode: "S", taxExemptionReasonCode: "" });
  });

  it("a stored line loads with its category and reason; a stored 0% line with no category asks for one", () => {
    expect(invoiceLineFromItem({ description: "x", quantity: 1, unitPrice: 9, vatRate: 0, taxCategoryCode: "Z", taxExemptionReasonCode: "VATEX-SA-33", taxExemptionReasonText: "Export of services" }))
      .toMatchObject({ taxCategoryCode: "Z", taxExemptionReasonCode: "VATEX-SA-33", taxExemptionReasonText: "" });
    expect(invoiceLineFromItem({ description: "x", quantity: 1, unitPrice: 9, vatRate: 0, taxCategoryCode: null }).taxCategoryCode).toBe("");
  });

  it("an unpriced or undescribed line is not sent", () => {
    expect(invoiceLinesBody([priced({ description: " " }), priced({ unitPrice: "0" })])).toEqual([]);
  });
});
