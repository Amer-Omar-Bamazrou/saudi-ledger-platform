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
 * 🔴 What this module does NOT do: it does not gate anything server-side today,
 * because there is nothing server-side to gate — the Zakat computation does not
 * exist yet (M17.4 is held on advisor Block C). Adding a guard around an
 * endpoint that does not exist would be theatre. The obligation is recorded in
 * the design doc and in `M17_4_MUST_GATE` below so it cannot be quietly missed.
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
 * 🔴 M17.4 OBLIGATION — when the Zakat worksheet endpoint is built, it must
 * call `zakatScopeFor` and refuse anything that is not `eligible`, with a
 * 409/422 naming the reason rather than a silent empty worksheet. A tenant who
 * is out of scope must not be able to produce a Zakat figure by calling the API
 * directly, however clearly the UI says otherwise.
 *
 * Left as a comment, not an exported constant: a string nothing imports is a
 * shape with no consumer, which is the failure mode M17.0 was spent removing.
 * The obligation is also recorded in docs/product/design-zakat-module.md §3.
 */
