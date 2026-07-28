/** Vendors service — AP summary + supplier matching. Behavior preserved from pre-M6. */
import { NotFoundError } from "../lib/errors";
import { auditService } from "./audit.service";
import { vendorsRepository, type VendorListFilter } from "../repositories/vendors.repository";
import type { vendorsTable } from "@workspace/db";

type Vendor = typeof vendorsTable.$inferSelect;

export interface VendorMatchInput {
  vatNumber?: string;
  vendorName?: string;
}
export interface VendorMatchResult {
  matchType: "exact" | "fuzzy" | "none";
  vendor: Vendor | null;
  suggestions: Vendor[];
}

export const vendorsService = {
  list(filter: VendorListFilter) {
    return vendorsRepository.list(filter);
  },

  async getById(id: number) {
    const [vendor] = await vendorsRepository.findById(id);
    if (!vendor) throw new NotFoundError("Vendor not found");
    const bills = await vendorsRepository.billsByVendor(id);
    const totalBilled = bills.reduce((s, b) => s + Number(b.total), 0);
    const totalPaid = bills.reduce((s, b) => s + Number(b.paidAmount ?? 0), 0);
    return { ...vendor, totalBilled, totalPaid, balance: totalBilled - totalPaid, billCount: bills.length };
  },

  async match({ vatNumber, vendorName }: VendorMatchInput): Promise<VendorMatchResult> {
    // 1. Exact VAT registration number match (most reliable).
    if (vatNumber && vatNumber.trim()) {
      const [exact] = await vendorsRepository.findByTaxNumber(vatNumber.trim());
      if (exact) return { matchType: "exact", vendor: exact, suggestions: [] };
    }

    // 2. Fuzzy name match — first 2 tokens (>= 3 chars), broaden until a hit.
    if (vendorName && vendorName.trim()) {
      const tokens = vendorName.trim().split(/\s+/).filter(Boolean);
      let suggestions: Vendor[] = [];
      for (const token of tokens.slice(0, 2)) {
        if (token.length < 3) continue;
        suggestions = await vendorsRepository.searchByNameToken(token);
        if (suggestions.length) break;
      }
      if (suggestions.length >= 1) return { matchType: "fuzzy", vendor: null, suggestions };
    }

    return { matchType: "none", vendor: null, suggestions: [] };
  },

  async create(data: typeof vendorsTable.$inferInsert) {
    const [row] = await vendorsRepository.insert(data);
    await auditService.created("vendor", row.id, row);
    // Explicit created:true so callers can distinguish "created" from "existed".
    return { ...row, created: true as const };
  },

  async update(id: number, data: Partial<typeof vendorsTable.$inferInsert>) {
    const [before] = await vendorsRepository.findById(id);
    if (!before) throw new NotFoundError("Not found");
    const [row] = await vendorsRepository.update(id, data);
    await auditService.updated("vendor", id, before, row);
    return row;
  },

  async remove(id: number) {
    const [before] = await vendorsRepository.findById(id);
    await vendorsRepository.remove(id);
    if (before) await auditService.deleted("vendor", id, before);
  },
};
