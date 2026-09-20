/**
 * Batch 1C — Issue 1: the allocation-target filter is the SHARED predicate
 * ("a receivable in the books"), not "has an invoice hash". An opening
 * receivable migrated at cut-off never has a hash, an ICV or a QR — and it
 * is exactly the thing a receipt must be allocatable to.
 */
import { describe, expect, it } from "vitest";
import { isOpenInvoice, outstandingOf } from "./openInvoice";

const base = { documentType: "invoice", status: "sent", invoiceHash: null as string | null, isOpening: false, reversedAt: null as string | null, total: "1000.00", paidAmount: "0.00", creditedAmount: "0.00" };

describe("isOpenInvoice — an allocation target is a receivable in the books", () => {
  it("🔴 an OPENING receivable (no hash, no ICV, no QR) with a balance IS a target", () => {
    expect(isOpenInvoice({ ...base, isOpening: true, invoiceHash: null })).toBe(true);
  });
  it("an issued invoice with a balance is a target; a fully paid or fully credited one is not", () => {
    expect(isOpenInvoice({ ...base, invoiceHash: "abc" })).toBe(true);
    expect(isOpenInvoice({ ...base, invoiceHash: "abc", status: "paid", paidAmount: "1000.00" })).toBe(false);
    expect(isOpenInvoice({ ...base, invoiceHash: "abc", creditedAmount: "1000.00" })).toBe(false);
    expect(isOpenInvoice({ ...base, isOpening: true, paidAmount: "600.00" })).toBe(true); // partly collected opening item
  });
  it("a draft, a submitted draft, a note and a REVERSED opening item are never targets", () => {
    expect(isOpenInvoice({ ...base, status: "draft" })).toBe(false);
    expect(isOpenInvoice({ ...base, status: "submitted" })).toBe(false);
    expect(isOpenInvoice({ ...base, invoiceHash: "abc", documentType: "credit_note" })).toBe(false);
    expect(isOpenInvoice({ ...base, isOpening: true, reversedAt: "2026-09-20T10:00:00Z" })).toBe(false);
  });
  it("outstanding is total − paid − credited, rounded to the halala", () => {
    expect(outstandingOf({ total: "1000.00", paidAmount: "333.33", creditedAmount: "0.005" })).toBe(666.67);
  });
});
