/**
 * Resolution and VAT arithmetic shared by every categorization consumer (M15).
 *
 * Two bugs lived here in duplicate, one per consumer — which is itself the
 * lesson. `transactions.service.upload` and `categorize.service` each carried
 * their own copy of "assign the category id" and "compute the VAT", and each
 * copy was wrong the same way:
 *
 *   1. The id came from the engine's private 1–30 list while the real table
 *      uses serial ids — the FK rejected every row (two id spaces, no forcing
 *      function).
 *   2. VAT was computed as `amount × rate / 100` — treating a BANK STATEMENT
 *      amount as if it were net. It is GROSS: it is what left the account.
 *
 * One implementation now, used by both.
 */
import { categoriesRepository } from "../../repositories/categories.repository";

/**
 * 🔴 Extract VAT from a GROSS amount. Never apply the rate to it.
 *
 * A statement line of SAR 431.25 at 15% contains SAR 56.25 of VAT
 * (431.25 × 15/115), not SAR 64.69 (431.25 × 15/100). The old arithmetic
 * overstated every input-VAT figure by exactly 15% — and `summary.getVat` reads
 * `transactions.vat_amount` straight into the VAT position, so this was a
 * filing error against ZATCA, not a display bug.
 */
export function vatFromGross(grossAmount: number, ratePercent: number): number {
  if (ratePercent <= 0) return 0;
  return Math.round(((grossAmount * ratePercent) / (100 + ratePercent)) * 100) / 100;
}

export interface ResolvedCategory {
  id: number;
  /**
   * M16.2 — the category's default VAT treatment ('S'|'Z'|'E'|'O') or null
   * where no honest default exists. Stamped onto the transaction at
   * categorization; VAT is extracted ONLY for 'S'.
   */
  defaultTaxTreatment: string | null;
}

/**
 * Resolve the engine's system codes to the TENANT'S OWN category ids (plus the
 * category's default tax treatment — M16.2).
 *
 * Runs inside the request's tenant transaction, so RLS confines the lookup to
 * the active organization. Codes that do not resolve — a tenant deleted a
 * default category, which they may — yield `undefined`, and the caller leaves
 * the transaction uncategorized rather than failing. Resolution failure is
 * "unknown", never an error.
 */
export async function resolveSystemCodes(codes: string[]): Promise<Map<string, ResolvedCategory>> {
  const unique = [...new Set(codes)].filter(Boolean);
  const map = new Map<string, ResolvedCategory>();
  for (const code of unique) {
    const cat = await categoriesRepository.findBySystemCode(code);
    if (cat) map.set(code, { id: cat.id, defaultTaxTreatment: cat.defaultTaxTreatment ?? null });
  }
  return map;
}

/**
 * 🔴 Below this, a match is a HINT, not an assignment.
 *
 * `confidence_score` was written by every categorization and read by NOTHING —
 * a 0.30 guess and a 0.98 match were indistinguishable in every report. Now it
 * is consumed at the one point that matters: a low-confidence match does NOT
 * assign a category. The transaction stays uncategorized and appears on the
 * Categorize page for a human, with the suggestion available but not applied.
 */
export const AUTO_ASSIGN_CONFIDENCE = 0.7;
