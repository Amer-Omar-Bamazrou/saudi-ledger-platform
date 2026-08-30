/** Vendors service — AP summary + supplier matching. Behavior preserved from pre-M6. */
import { NotFoundError } from "../lib/errors";
import { pick } from "../lib/writeGuards";

/** H1 allowlist — user-settable vendor fields (system columns excluded). */
const VENDOR_FIELDS = [
  "name", "nameAr", "taxNumber", "crNumber", "phone", "email", "address",
  "city", "country", "currency", "iban", "paymentTermsDays", "notes", "isActive",
] as const;
import { auditService } from "./audit.service";
import { vendorsRepository, type VendorListFilter } from "../repositories/vendors.repository";
import { DEFAULT_PAGE } from "../lib/httpParams";
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
  /**
   * 🔴 The list carries each vendor's AP, because the page shows it — and did
   * not, so "Total AP" and "Total Billed" read 0.00 for every tenant. Two
   * queries, not N+1: the balances come back grouped and are matched in memory.
   */
  async list(filter: VendorListFilter) {
    const [rows, balances, total, totals] = await Promise.all([
      vendorsRepository.list(filter),
      vendorsRepository.vendorBalances(),
      vendorsRepository.listCount(filter),
      vendorsRepository.listTotals(filter),
    ]);
    const byVendor = new Map(balances.map((b) => [b.vendorId, b]));
    const items = rows.map((v) => {
      const bal = byVendor.get(v.id);
      const totalBilled = Number(bal?.totalBilled ?? 0);
      const totalPaid = Number(bal?.totalPaid ?? 0);
      return { ...v, totalBilled, totalPaid, balance: totalBilled - totalPaid };
    });
    return {
      items,
      page: { limit: filter.limit ?? DEFAULT_PAGE, offset: filter.offset ?? 0, total },
      totals,
    };
  },

  async getById(id: number) {
    const [vendor] = await vendorsRepository.findById(id);
    if (!vendor) throw new NotFoundError("Vendor not found");
    // Same aggregate the list reads, so the two cannot disagree about what we owe.
    const [bal] = await vendorsRepository.vendorBalances(id);
    const totalBilled = Number(bal?.totalBilled ?? 0);
    const totalPaid = Number(bal?.totalPaid ?? 0);
    return {
      ...vendor,
      totalBilled,
      totalPaid,
      balance: totalBilled - totalPaid,
      billCount: Number(bal?.billCount ?? 0),
    };
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
    const [row] = await vendorsRepository.insert(pick<typeof vendorsTable.$inferInsert>(data, VENDOR_FIELDS) as typeof vendorsTable.$inferInsert);
    await auditService.created("vendor", row.id, row);
    // Explicit created:true so callers can distinguish "created" from "existed".
    return { ...row, created: true as const };
  },

  async update(id: number, data: Partial<typeof vendorsTable.$inferInsert>) {
    const [before] = await vendorsRepository.findById(id);
    if (!before) throw new NotFoundError("Not found");
    const [row] = await vendorsRepository.update(id, pick<typeof vendorsTable.$inferInsert>(data, VENDOR_FIELDS));
    await auditService.updated("vendor", id, before, row);
    return row;
  },

  async remove(id: number) {
    const [before] = await vendorsRepository.findById(id);
    await vendorsRepository.remove(id);
    if (before) await auditService.deleted("vendor", id, before);
  },
};
