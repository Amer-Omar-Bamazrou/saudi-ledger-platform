/**
 * F1 — the account-confinement rule, written once and used by every caller.
 *
 * A `users` row is a PLATFORM-WIDE identity: one password, one active flag, and
 * every organization membership that account holds. So an act on the ACCOUNT —
 * reset its password, deactivate it — reaches every organization the account
 * can enter, not only the one the actor administers. The act is org-scoped in
 * intent and platform-scoped in effect.
 *
 * 🔴 WHY THE M11.5.1 PREDICATE WAS NOT ENOUGH.
 * That hotfix scoped `/auth/users*` to "users who share an organization with
 * the actor" (`isMemberOfAny`), which reads as a tenant boundary and is not
 * one — because SHARING AN ORGANIZATION IS SOMETHING THE ACTOR CAN CAUSE.
 * `POST /orgs/:orgId/members {userId, role}` creates a membership for any
 * userId that EXISTS, with no consent from the account's owner, no invitation
 * and no email. `users.id` is a `serial`, so the ids are counted, not guessed.
 * The full chain, from a legitimate admin of any approved org:
 *
 *   1. POST /api/orgs/<mine>/members {userId: N, role: "viewer"}   → N is now "mine"
 *   2. POST /api/auth/users/N/reset-password {newPassword}         → in scope, so allowed
 *   3. log in as N                                                 → every org N belongs to
 *
 * The guard trusted a fact its own caller could manufacture. That is CLAUDE.md
 * §4's self-grantable-privilege rule one layer down: the privilege was not a
 * role, it was MEMBERSHIP, and the guard that trusted it was the M11.5.1 fix
 * itself.
 *
 * THE RULE THAT HOLDS INSTEAD — confinement, not overlap:
 * an actor may act on an account only when the account's ENTIRE membership
 * footprint lies inside the organizations that actor administers. An account
 * that can enter an organization the actor does not administer is not that
 * actor's to administer at all. Overlap is caused by one INSERT; confinement
 * cannot be, because the actor cannot delete the target's other memberships.
 *
 * 🔴 ALL memberships count, whatever their status. An `inactive` row is a
 * re-activation away from being access, and re-activation is org B's decision
 * to make about an account whose password org A would by then know. The cost
 * of the strict reading is named in the PR: a user who has EVER belonged to
 * another organization can no longer have their password reset by their own
 * admin — and the platform has no self-service recovery flow at all
 * (`/auth/change-password` requires the current password), so that user is
 * locked out. That gap is real, pre-existing, and recorded rather than papered
 * over here; the answer is an operator-level or self-service reset, not a
 * weaker boundary on this one.
 */
import { ConflictError, NotFoundError } from "./errors";
import { membersRepository } from "../repositories/members.repository";

/**
 * How a refusal is worded — the two callers have different disclosure duties,
 * and both live here so they are reviewed side by side rather than drifting.
 *
 * `conceal` — the actor NAMED a user id they may know nothing about (the
 *   membership-assignment path). A distinct refusal would confirm "this id
 *   exists and belongs to someone else", restoring the cross-tenant
 *   enumeration M11.5.1 removed. Identical to the not-found answer, by design.
 *
 * `explain` — the actor is already entitled to know the account exists (it is
 *   a colleague in an org they administer, listed by that org's own member
 *   surface). Concealing here would be a lie AND would hide the one thing they
 *   need to know: which act to use instead.
 */
export type ConfinementDisclosure = "conceal" | "explain";

/**
 * Refuse unless `targetUserId`'s every membership lies within `actorOrgIds`.
 *
 * `actorOrgIds` is the set of organizations the ACTOR administers, resolved by
 * the caller — the two surfaces qualify that set differently (the user-admin
 * surface requires the org to be verification-approved; membership management
 * does not), and that difference is deliberate, so it is not decided here.
 */
export async function assertAccountConfinedTo(
  targetUserId: number,
  actorOrgIds: string[],
  disclosure: ConfinementDisclosure,
): Promise<void> {
  const foreign = await membersRepository.foreignMembershipOrgIds(targetUserId, actorOrgIds);
  if (foreign.length === 0) return;

  if (disclosure === "conceal") {
    throw new NotFoundError("User not found.");
  }
  // Names no organization: that this account reaches elsewhere is what the
  // actor must know; WHERE it reaches is another tenant's business.
  throw new ConflictError(
    "This account also belongs to organizations you do not administer, so it cannot be " +
      "administered from here — its password and active status are platform-wide. " +
      "To end this person's access to your organization, remove their membership instead.",
  );
}
