/**
 * Zakat scope — who the module is for (M17.1, owner decision Q2).
 *
 * Zakat v1 covers entities that are **100% Saudi/GCC-owned**. Foreign and
 * mixed-ownership companies are assessed differently: the real treatment
 * apportions between Zakat (the Saudi/GCC share) and income tax (the foreign
 * share). v1 DECLINES rather than approximating, and says so plainly.
 *
 * ── Why the rule lives here and not in the page that shows it ──────────────
 * Today the only consumer is the Zakat surface in `apps/web`. M17.4 adds a
 * worksheet endpoint that MUST refuse the same companies server-side — because
 * a UI-only gate is a suggestion, and the thing being gated will be a tax
 * figure. Defining the rule once now means M17.4 wires to it rather than
 * writing a second copy that can disagree. (One writer per effect, applied to a
 * predicate.)
 *
 * 🔴 Phase 16 (2026-10-04) built the computation, and the obligation below is
 * MET: `services/tax/taxComputations.service.ts` (`zakatInputs`) calls
 * `zakatScopeFor` and turns anything not `eligible` into a named blocker
 * (`zakat_ownership_not_declared` / `zakat_not_eligible`), so no Zakat figure is
 * computed or approved for it (422 `tax_computation_blocked`) — over the API as
 * well as on the page.
 */

export const OWNERSHIP_TYPES = ["SAUDI_GCC", "FOREIGN", "MIXED"] as const;
export type OwnershipType = (typeof OWNERSHIP_TYPES)[number];

export function isOwnershipType(value: unknown): value is OwnershipType {
  return typeof value === "string" && (OWNERSHIP_TYPES as readonly string[]).includes(value);
}

/**
 * Why a company may or may not use the Zakat module.
 *
 * Three states, not two. "Not declared" is deliberately NOT folded into
 * "ineligible": a company that has told us nothing must be ASKED, not refused
 * and not assumed to qualify. Collapsing it either way is the decision this
 * milestone exists to avoid making on the tenant's behalf.
 */
export type ZakatScope =
  | { status: "eligible"; ownershipType: "SAUDI_GCC" }
  | { status: "not_declared" }
  | { status: "out_of_scope"; ownershipType: "FOREIGN" | "MIXED" };

export function zakatScopeFor(ownershipType: string | null | undefined): ZakatScope {
  if (ownershipType == null || ownershipType === "") return { status: "not_declared" };
  if (ownershipType === "SAUDI_GCC") return { status: "eligible", ownershipType };
  if (ownershipType === "FOREIGN" || ownershipType === "MIXED") {
    return { status: "out_of_scope", ownershipType };
  }
  // An unrecognised value is not eligibility. The DB CHECK should make this
  // unreachable; treating it as "not declared" fails toward asking rather than
  // toward granting.
  return { status: "not_declared" };
}

/*
 * 🔴 THE M17.4 OBLIGATION — MET in Phase 16: the Zakat computation calls
 * `zakatScopeFor` and refuses anything that is not `eligible`, naming the
 * reason (a blocker, then 422 on approval) rather than a silent empty
 * worksheet; a tenant out of scope cannot produce a Zakat figure through the
 * API either (phase16-zakat-income-tax.test.ts, "scope"). Decision record:
 * docs/product/phase-16-17-tax-treasury-decision-pack.md §3.4.
 */
