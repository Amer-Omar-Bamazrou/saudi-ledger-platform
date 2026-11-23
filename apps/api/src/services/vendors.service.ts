/** Vendors service — AP summary + supplier matching. Behavior preserved from pre-M6. */
import { BadRequestError, NotFoundError } from "../lib/errors";
import { pick } from "../lib/writeGuards";
import { withValidIban } from "../lib/ibanGuard";
import { WHT_PAYMENT_TYPES } from "@workspace/db";

/** H1 allowlist — user-settable vendor fields (system columns excluded). */
const VENDOR_FIELDS = [
  "name", "nameAr", "taxNumber", "crNumber", "phone", "email", "address",
  "city", "country", "currency", "iban", "paymentTermsDays", "notes", "isActive",
  // B8: residency is a FACT about the supplier, recorded by the person who
  // knows it. Phase 16: a payment to a non-resident withholds on it (accounting/wht.ts).
  "residency",
  // Phase 16: the supplier's DECLARED default WHT nature, and its registration number abroad (Art. 68(B)(3)).
  "whtDefaultPaymentType", "foreignTaxId",
] as const;
import { auditService } from "./audit.service";
import { bankDetailChangesService } from "./bankDetailChanges.service";
import { vatEvidenceService } from "./purchaseEvidence/vatEvidence.service";
import { vendorsRepository, type VendorListFilter } from "../repositories/vendors.repository";
import { DEFAULT_PAGE } from "../lib/httpParams";
import type { vendorsTable } from "@workspace/db";

type Vendor = typeof vendorsTable.$inferSelect;
type VendorInsert = typeof vendorsTable.$inferInsert;

/** "" from a form is NULL at the write boundary, never an empty string that reads as a value (contract batch 2). */
function normalize(values: Partial<VendorInsert>): Partial<VendorInsert> {
  const out: Record<string, unknown> = { ...values };
  for (const key of VENDOR_FIELDS) {
    // "" → NULL, nameAr now included — the sentinel default died (2026-09-14).
    if (out[key] === "") out[key] = null;
  }
  // Phase 16: a declared WHT nature is one of IR Art. 63(1)'s — refused in words, not by the database CHECK.
  const t = out.whtDefaultPaymentType;
  if (t != null && !(WHT_PAYMENT_TYPES as readonly string[]).includes(String(t))) {
    throw new BadRequestError(`whtDefaultPaymentType must be one of ${WHT_PAYMENT_TYPES.join(", ")}.`);
  }
  return out as Partial<VendorInsert>;
}

export interface VendorMatchInput {
  vatNumber?: string;
  vendorName?: string;
}
export interface VendorMatchResult {
  matchType: "exact" | "fuzzy" | "none";
  vendor: Vendor | null;
  suggestions: Vendor[];
}

/** 19B S3: one supplier's IBAN state (a change waiting; the last fallback's line). */
async function partyIbanView(id: number) {
  return (await bankDetailChangesService.partyIbanViews("vendor_iban", [id])).get(id)!;
}

export const vendorsService = {
  /**
   * 🔴 The list carries each vendor's AP, because the page shows it — and did
   * not, so "Total AP" and "Total Billed" read 0.00 for every tenant. Two
   * queries, not N+1: the balances come back grouped and are matched in memory.
   */
  /** 19B S2b (v4 D9 (a)): a picker's page — id, name, Arabic name and VAT number, and the total that matches. */
  async picker(filter: VendorListFilter) {
    const [items, total] = await Promise.all([vendorsRepository.picker(filter), vendorsRepository.listCount(filter)]);
    return { items, page: { limit: filter.limit ?? DEFAULT_PAGE, offset: filter.offset ?? 0, total } };
  },

  async list(filter: VendorListFilter) {
    const [rows, balances, total, totals] = await Promise.all([
      vendorsRepository.list(filter),
      vendorsRepository.vendorBalances(),
      vendorsRepository.listCount(filter),
      vendorsRepository.listTotals(filter),
    ]);
    const byVendor = new Map(balances.map((b) => [b.vendorId, b]));
    // 19B S3: each supplier's IBAN state (a change waiting; the fallback's line) — one read for the page.
    const views = await bankDetailChangesService.partyIbanViews("vendor_iban", rows.map((v) => v.id));
    const items = rows.map((v) => {
      const bal = byVendor.get(v.id);
      const totalBilled = Number(bal?.totalBilled ?? 0);
      const totalPaid = Number(bal?.totalPaid ?? 0);
      return { ...v, ...views.get(v.id)!, totalBilled, totalPaid, balance: totalBilled - totalPaid };
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
      ...(await partyIbanView(id)),
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

  /**
   * 🔴 19B S3 (v4 §6.3, D2): the supplier is created WITHOUT its IBAN; an IBAN given with it is then HELD for an
   * accountant or admin who is not the requester (or applied at once, the fallback, when the requester is the only one
   * who could ever approve it). The database refuses a supplier inserted with an IBAN (0170).
   */
  async create(data: unknown) {
    // H-8 (DR-23): a supplier's IBAN is checked the one way and stored normalised
    const { iban, ...values } = withValidIban(normalize(pick<VendorInsert>(data, VENDOR_FIELDS)));
    let [row] = await vendorsRepository.insert(values as VendorInsert);
    await auditService.created("vendor", row.id, row);
    const { held, applyNow } = await bankDetailChangesService.holdPartyIban("vendor_iban", row.id, null, iban ?? null, { atCreation: true });
    if (applyNow) row = await vendorsService.applyApprovedIban(row.id, iban ?? null);
    // Explicit created:true so callers can distinguish "created" from "existed".
    return { ...row, ...(await partyIbanView(row.id)), created: true as const, pendingBankDetailChanges: await bankDetailChangesService.out(held) };
  },

  async update(id: number, data: unknown) {
    const [before] = await vendorsRepository.findById(id);
    if (!before) throw new NotFoundError("Not found");
    // 🔴 19B S3 (v4 §6.3; was DR-23's two-admin rule): a change of the IBAN is HELD for an accountant or admin who is not
    // the requester — or applied at once, the fallback — and the rest of the request is written.
    const all = withValidIban(normalize(pick<VendorInsert>(data, VENDOR_FIELDS)));
    const { iban, ...values } = all;
    const { held, applyNow } = "iban" in all ? await bankDetailChangesService.holdPartyIban("vendor_iban", id, before.iban ?? null, iban ?? null) : { held: [], applyNow: false };
    let row: Vendor = before;
    if (Object.keys(values).length > 0) {
      [row] = await vendorsRepository.update(id, values);
      await auditService.updated("vendor", id, before, row);
    }
    if (applyNow) row = await vendorsService.applyApprovedIban(id, iban ?? null);
    // Phase 13A: the supplier's VAT number is evidence — their unposted bills are re-decided.
    if ((before.taxNumber ?? null) !== (row?.taxNumber ?? null)) await vatEvidenceService.refreshForVendor(id);
    return { ...row, ...(await partyIbanView(id)), pendingBankDetailChanges: await bankDetailChangesService.out(held) };
  },

  /**
   * 🔴 Phase 18 R-6 (DR-23) → 19B S3: the IBAN an approver APPROVED (written by the decision,
   * `bankDetailChangeDecisions.service`, in the approval's own transaction), or the fallback's (the requester's own,
   * in theirs) — with its audit record, the record H-9's change-then-pay finding reads. The database lets the write
   * through only beside that request (0170).
   */
  async applyApprovedIban(id: number, iban: string | null): Promise<Vendor> {
    const [before] = await vendorsRepository.findById(id);
    if (!before) throw new NotFoundError("Not found");
    const [row] = await vendorsRepository.update(id, { iban });
    await auditService.updated("vendor", id, before, row);
    return row;
  },

  async remove(id: number) {
    const [before] = await vendorsRepository.findById(id);
    await vendorsRepository.remove(id);
    if (before) await auditService.deleted("vendor", id, before);
  },
};
