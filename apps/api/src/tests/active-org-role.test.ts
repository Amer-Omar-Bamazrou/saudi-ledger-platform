/**
 * M18.4.1 — "which organization am I acting in, and what am I here?"
 *
 * `/auth/me` now returns `organizationRole`: the caller's role in the ACTIVE
 * organization. It exists because `/period-locks` (M18.4) is the first hub
 * block with admin-only actions and the frontend had no way to know the
 * governing role — `users.role` is vestigial (CLAUDE.md §4), and deriving the
 * membership role from `/orgs` meant every page re-implementing the match.
 *
 * 🔴 While adding it, the selection rule turned out to be written TWICE and the
 * two copies DISAGREED:
 *
 *     lib/tenant.ts    memberships.find(m => m.organizationId === requested)
 *                      ?? memberships[0]
 *     routes/orgs.ts   req.session.activeOrgId ?? organizations[0]?.id
 *
 * They agree while the session's chosen org is still a live membership, and
 * diverge the moment it is not — after a membership is revoked, `resolveTenant`
 * puts the request in the user's FIRST real org while `/orgs` echoes the STALE
 * id back. The switcher and every role check would then describe a different
 * organization from the one being acted in.
 *
 * `lib/activeOrg.ts` is now the single implementation. These tests pin the rule
 * itself — especially the stale case, which is the one nobody had exercised.
 */
import { describe, expect, it } from "vitest";
import { selectActiveMembership } from "../lib/activeOrg";

const A = { organizationId: "org-a", role: "viewer" };
const B = { organizationId: "org-b", role: "admin" };

describe("M18.4.1 — the active-organization selector", () => {
  it("honours the session's choice when it is still a live membership", () => {
    expect(selectActiveMembership([A, B], "org-b")).toBe(B);
  });

  it("🔴 falls back to the FIRST membership when the session's choice is stale", () => {
    // The divergence. `/orgs` used to return "org-gone" here while
    // resolveTenant put the request in org-a — two answers to one question.
    expect(selectActiveMembership([A, B], "org-gone")).toBe(A);
  });

  it("falls back to the first membership when the session names nothing", () => {
    expect(selectActiveMembership([A, B], null)).toBe(A);
    expect(selectActiveMembership([A, B], undefined)).toBe(A);
  });

  it("returns null when the user belongs to no organization — never throws", () => {
    // Callers differ on what this means: resolveTenant 403s, /auth/me reports a
    // null role. A total function lets each decide instead of guessing.
    expect(selectActiveMembership([], "org-a")).toBeNull();
    expect(selectActiveMembership([], null)).toBeNull();
  });

  it("🔴 the role travels with the selection, so callers cannot pair the wrong two", () => {
    // The bug this shape prevents: picking the org id from one place and the
    // role from another. The membership carries both or neither.
    const picked = selectActiveMembership([A, B], "org-b");
    expect(picked).toEqual({ organizationId: "org-b", role: "admin" });
  });
});
