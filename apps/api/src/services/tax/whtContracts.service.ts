/**
 * 🔴 Phase 18 G4c-1 — WHT owner decision 15 (2026-10-27; register §11.44):
 * WHO BEARS THE TAX is a per-contract setting the user CONFIRMS.
 *
 *  - `tax_inclusive`: no gross-up — the tax is withheld from the amount paid.
 *  - `net_of_tax`: the payer bears the WHT — the supplier receives the full
 *    amount, the base is grossed up (net ÷ (1 − rate)) and the tax on it is the
 *    company's expense (`decideWithholding`, the one place a payment is judged).
 *
 * A non-resident supplier's contract only: no withholding applies between
 * residents (Income Tax Law Art. 68), so a setting there would mean nothing.
 * Append-only: a changed setting is a new contract, so the record a payment
 * was made under never moves.
 */
import { WHT_TAX_BEARINGS, type WhtTaxBearing } from "@workspace/db";
import { BadRequestError, BusinessRuleError } from "../../lib/errors";
import { vendorsRepository } from "../../repositories/vendors.repository";
import { whtContractsRepository } from "../../repositories/whtContracts.repository";
import { auditService } from "../audit.service";

const MAX_ID = 2_147_483_647;
const refuse = (status: number, code: string, error: string, field?: string): never => {
  throw new BusinessRuleError(status, { code, error, ...(field ? { field } : {}) });
};
const iso = (d: Date | string | null) => (d == null ? null : new Date(d).toISOString());

const out = (c: Awaited<ReturnType<typeof whtContractsRepository.list>>[number]) => ({
  id: c.id, vendorId: c.vendorId, reference: c.reference, taxBearing: c.taxBearing as WhtTaxBearing, note: c.note ?? null,
  confirmedBy: c.confirmedBy ?? null, confirmedAt: iso(c.confirmedAt)!,
});

export const whtContractsService = {
  async list(vendorId?: unknown) {
    const v = vendorId == null || vendorId === "" ? undefined : Number(vendorId);
    if (v != null && (!Number.isSafeInteger(v) || v <= 0 || v > MAX_ID)) throw new BadRequestError("vendorId must be a positive integer.");
    return (await whtContractsRepository.list({ vendorId: v })).map(out);
  },

  async create(body: Record<string, unknown>, userId: number | null) {
    const vendorId = Number(body.vendorId);
    if (!Number.isSafeInteger(vendorId) || vendorId <= 0 || vendorId > MAX_ID) throw new BadRequestError("vendorId must be a positive integer.");
    const reference = typeof body.reference === "string" ? body.reference.trim() : "";
    if (!reference || reference.length > 200) throw new BadRequestError("reference names the contract (1 to 200 characters).");
    const taxBearing = String(body.taxBearing ?? "");
    if (!(WHT_TAX_BEARINGS as readonly string[]).includes(taxBearing)) {
      throw new BadRequestError(`taxBearing is one of: ${WHT_TAX_BEARINGS.join(", ")}.`);
    }
    const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 2000) : null;
    const [vendor] = await vendorsRepository.findById(vendorId);
    if (!vendor) refuse(422, "reference_not_found", "Name the supplier the contract is with.", "vendorId");
    if (vendor!.residency !== "non_resident") {
      refuse(422, "wht_contract_vendor_not_non_resident",
        "Who bears the withholding tax is recorded only for a NON-RESIDENT supplier's contract: no withholding applies between residents (Income Tax Law Art. 68). Declare the supplier non-resident first if that is wrong.",
        "vendorId");
    }
    // decision 15: "the user confirms the setting per contract" — never assumed, never defaulted
    if (body.confirmed !== true) {
      refuse(422, "wht_contract_confirmation_required",
        taxBearing === "net_of_tax"
          ? "Confirm that under this contract the company bears the withholding tax: the supplier receives the full amount, the tax is computed on the grossed-up amount (net ÷ (1 − rate)) and is the company's expense, not deductible for income tax."
          : "Confirm that under this contract the tax is withheld from the amount paid: the supplier receives the amount less the tax.",
        "confirmed");
    }
    const [row] = await whtContractsRepository.insert({ vendorId, reference, taxBearing, note, confirmedBy: userId });
    await auditService.created("wht_contract", row!.id, row);
    return out(row!);
  },
};
