/**
 * Public invitation routes (M11.7) — preview and accept an invite link.
 *
 * PUBLIC and token-authenticated: mounted in the public section (before
 * `requireAuth` and `resolveTenant`) because the invitee may have no account and
 * belongs to no tenant yet. The session is still readable when present, which is
 * how the "already signed in" path binds the acceptor's identity to the invited
 * email.
 *
 * All authorization lives in `invitationsService` (token validity, expiry,
 * org-still-approved, identity match, atomic single redemption). Rate-limited
 * because this is an unauthenticated endpoint that can create a user.
 */
import { Router } from "express";
import { preSessionLimiter } from "../lib/rateLimit";
import { invitationsService } from "../services/invitations.service";

const router = Router();

/**
 * 🔴 On the SHARED store since 2026-10-05. It was built without a `store:`
 * and so counted in process memory — C1 moved three limiters and missed this
 * one, so N instances allowed N×20. The token is 256 random bits; this is
 * defence in depth against guessing, and a bound on unauthenticated user
 * creation.
 */
const acceptRateLimiter = preSessionLimiter({ name: "invite", dimension: "ip", windowMs: 15 * 60 * 1000, limit: 20 });

/** GET /api/invitations/:token — preview (org name, invited email, role). */
router.get("/:token", acceptRateLimiter, async (req, res) => {
  res.json(await invitationsService.preview(req.params.token));
});

/**
 * POST /api/invitations/:token/accept — join the organization.
 * Signed in → the session email must match. No account → { name, password }
 * creates the user atomically with the membership, then signs them in.
 */
router.post("/:token/accept", acceptRateLimiter, async (req, res) => {
  const accepted = await invitationsService.accept(
    req.params.token,
    req.body ?? {},
    req.session.userId ?? null,
    { actorEmail: req.session.userEmail ?? null, ipAddress: req.ip ?? null },
  );

  const respond = () =>
    res.status(200).json({
      user: { id: accepted.userId, email: accepted.email, name: accepted.name },
      organizationId: accepted.organizationId,
      role: accepted.role,
    });

  // Already signed in as the invited user — just switch them to the new org.
  if (req.session.userId === accepted.userId) {
    req.session.activeOrgId = accepted.organizationId;
    req.session.save(() => respond());
    return;
  }

  // New account — establish the session (rotating the id, as login does).
  req.session.regenerate((regenErr) => {
    if (regenErr) { req.log.error({ err: regenErr }); res.status(500).json({ error: "Session error." }); return; }
    req.session.userId = accepted.userId;
    // Global role stays NON-privileged; authority is the membership (M11.5.1).
    req.session.userRole = "viewer";
    req.session.userName = accepted.name;
    req.session.userEmail = accepted.email;
    req.session.activeOrgId = accepted.organizationId;
    req.session.save((err) => {
      if (err) { req.log.error({ err }); res.status(500).json({ error: "Session save failed." }); return; }
      respond();
    });
  });
});

export default router;
