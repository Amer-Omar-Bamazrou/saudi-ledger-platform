/**
 * "Which organization is this request acting in?" — ONE implementation.
 *
 * ── Why this file exists (M18.4.1) ─────────────────────────────────────────
 * The rule was written twice, and the two copies disagreed:
 *
 *   `lib/tenant.ts`    memberships.find(m => m.organizationId === requested)
 *                      ?? memberships[0]
 *   `routes/orgs.ts`   req.session.activeOrgId ?? organizations[0]?.id
 *
 * They agree whenever the session's `activeOrgId` is still a live membership.
 * They DIVERGE when it is not — after a membership is revoked, or an org is
 * deleted, or a session outlives its access. `tenant.ts` falls back to the
 * user's first real membership; `/orgs` echoes the stale id back to the client.
 * The user would then be operating in org A (what `resolveTenant` actually set)
 * while the switcher, the user-admin page and any role check showed org B.
 *
 * Nobody had noticed, because the divergence needs a revoked membership to
 * appear. It was found while adding a THIRD consumer (`/auth/me` returning the
 * caller's role in the active org), which is the point at which "two copies"
 * became "a rule with no owner".
 *
 * 🔴 This is the identity layer. `organization_memberships` is OUTSIDE RLS
 * (CLAUDE.md §4) and only pre-tenant code may read it — which is exactly what
 * every caller of this module is.
 */

/** The shape every caller shares; each may select extra columns of its own. */
export interface MembershipLike {
  organizationId: string;
  role: string;
}

/**
 * Pick the membership a request should act in.
 *
 * The session's choice wins ONLY if it is still a live membership; otherwise
 * the first (primary) membership does. Returns `null` when the user belongs to
 * no organization — callers decide whether that is a 403 or an empty response,
 * because it means different things to `resolveTenant` and to `/auth/me`.
 *
 * Pure and total: no I/O, no throwing. Every caller then agrees by construction
 * rather than by remembering.
 */
export function selectActiveMembership<T extends MembershipLike>(
  memberships: readonly T[],
  requestedOrgId: string | null | undefined,
): T | null {
  if (memberships.length === 0) return null;
  return memberships.find((m) => m.organizationId === requestedOrgId) ?? memberships[0]!;
}
