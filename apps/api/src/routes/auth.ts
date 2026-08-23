/**
 * Auth routes: POST /auth/register, POST /auth/login, POST /auth/logout, GET /auth/me
 */
import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { PostgresRateLimitStore } from "../lib/rateLimitStore";
import { db } from "@workspace/db";
import { usersTable, organizationMembershipsTable } from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";
import { requireAuth } from "../lib/auth";
import { refuseSignupInDemo } from "../lib/demoMode";
import { selectActiveMembership } from "../lib/activeOrg";
import { securityAuditService } from "../services/securityAudit.service";
import { signupService } from "../services/signup.service";
import { userAdminService, safeUser } from "../services/userAdmin.service";
import { requireIdParam } from "../lib/httpParams";

const router = Router();
const SALT_ROUNDS = 12;

/** Actor context for the security-audit trail, from the authenticated session. */
function actorCtx(req: { session: { userEmail?: string }; ip?: string }) {
  return { actorEmail: req.session.userEmail ?? null, ipAddress: req.ip ?? null };
}

/**
 * Brute-force protection for credential endpoints. Keys on client IP; 10
 * attempts per 15 minutes.
 *
 * 🔴 C1 (2026-08-20): the store is now SHARED (Postgres), not per-process.
 * With MemoryStore, two instances behind a load balancer enforced 20 attempts
 * while both believed they were enforcing 10.
 */
const authLimiterStore = new PostgresRateLimitStore("auth");
const authRateLimiter = rateLimit({
  store: authLimiterStore,
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again in a few minutes." },
});

/**
 * Public self-service signup is the ONLY unauthenticated write in the platform,
 * so it gets its own STRICTER limiter than the credential endpoints: creating
 * organizations is expensive and abusable. IP-keyed, 5 per hour.
 */
const signupLimiterStore = new PostgresRateLimitStore("signup");
const signupRateLimiter = rateLimit({
  store: signupLimiterStore,
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many signup attempts. Please try again later." },
});

/**
 * User-administration endpoints (list/create/update/reset-password). These were
 * previously UNTHROTTLED, which is what made the M11.5.1 CRITICAL finding a
 * practical mass-takeover primitive (`users.id` is a serial integer, so an
 * attacker could walk every id). Rate-limited independently of login/signup.
 */
const userAdminLimiterStore = new PostgresRateLimitStore("user-admin");
const userAdminRateLimiter = rateLimit({
  store: userAdminLimiterStore,
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again in a few minutes." },
});

/**
 * TEST-ONLY: clear the in-memory rate-limit buckets.
 *
 * The limiters are process-global and IP-keyed, and every test request arrives
 * from the same loopback address — so suites running in parallel SHARE one
 * budget. Signup's is deliberately strict (5/hour), so a handful of legitimate
 * signups across different suites can exhaust it and produce 429s that have
 * nothing to do with the behaviour under test.
 *
 * Raising `max` in the test environment is the wrong fix: `signup.test.ts`
 * asserts that a flood IS rejected, and its loop of 8 attempts requires
 * `max < 8` to observe one. Disabling the limit would silently delete the
 * abuse protection that test exists to prove.
 *
 * So suites that sign up call this in `beforeAll` to start from a clean bucket.
 * Production behaviour is completely unchanged — this only resets stores.
 *
 * 🔴 ASYNC since C1 moved the stores to Postgres: callers MUST await it, or
 * the reset races the first request and the suite sees a stale bucket.
 */
export async function __resetRateLimitsForTests(): Promise<void> {
  await Promise.all([
    authLimiterStore.resetAll(),
    signupLimiterStore.resetAll(),
    userAdminLimiterStore.resetAll(),
  ]);
}

// Fixed decoy hash used to keep login timing constant when the email is unknown
// or the account is inactive. Comparing the supplied password against this hash
// costs roughly the same as comparing against a real user's hash, so an attacker
// can't distinguish "no such user" from "wrong password" by response time.
// The plaintext is irrelevant — it only ever needs to NOT match a real password.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync("timing-attack-decoy", SALT_ROUNDS);

// `safeUser` now lives in userAdmin.service (shared with the org-scoped
// user-administration surface) and is re-used here for /me and /login.

/**
 * POST /auth/register — create a user account (ORG-SCOPED, M11.5.1).
 *
 * There is intentionally NO unauthenticated bootstrap path (the old
 * "first user registers freely" branch was a race-to-admin). The initial admin is
 * provisioned out-of-band by the seed script.
 *
 * SECURITY (M11.5.1): authorization is no longer the ambient GLOBAL session role
 * — the caller must ACTIVELY ADMINISTER an organization (verified against
 * organization_memberships in userAdminService). See that service's header for
 * the full rationale.
 */
router.post("/register", userAdminRateLimiter, requireAuth, async (req, res) => {
  res.status(201).json(await userAdminService.create(req.session.userId!, req.body ?? {}, actorCtx(req)));
});

/**
 * POST /auth/signup — PUBLIC self-service organization registration (M11.5).
 *
 * Creates organization + company + admin user + admin membership in ONE atomic
 * transaction, with the organization in `pending_review`: the account can log in
 * and see its verification status, but the M11.2 gate blocks every business route
 * until a platform operator approves it. We log the user in on success so they
 * land directly on the status page.
 *
 * This is distinct from /auth/register, which stays admin-only and is how an
 * APPROVED org provisions its own team.
 *
 * AppErrors thrown by the service (400 invalid, 409 duplicate email) are mapped
 * by the app-level errorHandler (Express 5 forwards async rejections).
 */
router.post("/signup", refuseSignupInDemo, signupRateLimiter, async (req, res) => {
  const created = await signupService.signup(req.body ?? {}, { ipAddress: req.ip ?? null });

  // Rotate the session id on the anonymous → authenticated transition, then sign
  // the new admin in (same posture as /auth/login).
  req.session.regenerate((regenErr) => {
    if (regenErr) { req.log.error({ err: regenErr }); res.status(500).json({ error: "Session error." }); return; }
    req.session.userId = created.userId;
    // SECURITY (M11.5.1): the session carries the GLOBAL role only. It must NOT
    // be "admin" — a public endpoint may never self-grant a platform-wide
    // privilege. The signup user is an admin OF THEIR OWN ORG via their
    // organization_memberships row, which is what `resolveTenant` reads and what
    // governs every business route.
    req.session.userRole = created.role;
    req.session.userName = created.name;
    req.session.userEmail = created.email;
    req.session.activeOrgId = created.organizationId;
    req.session.save((err) => {
      if (err) { req.log.error({ err }); res.status(500).json({ error: "Session save failed." }); return; }
      res.status(201).json({
        // Report the REAL global role (non-privileged). Do not echo "admin" here:
        // the client stores this as `user.role`, and any UI that gated on it would
        // be misled about a privilege the server does not actually grant. The
        // user's admin authority is their organization membership.
        user: { id: created.userId, email: created.email, name: created.name, role: created.role, isActive: true },
        organizationId: created.organizationId,
        verificationStatus: "pending_review",
      });
    });
  });
});

/** POST /auth/login */
router.post("/login", authRateLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      res.status(400).json({ error: "email and password are required." }); return;
    }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);

    // Always run a bcrypt comparison — against the real hash when the user
    // exists, otherwise against a fixed decoy — so the response time is the same
    // whether or not the email is registered. This closes the timing side channel
    // that would otherwise let an attacker enumerate valid accounts.
    const valid = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !user.isActive || !valid) {
      res.status(401).json({ error: "Invalid credentials." }); return;
    }

    // Stamp last login
    await db.update(usersTable).set({ lastLoginAt: new Date() }).where(eq(usersTable.id, user.id));

    // Rotate the session ID on the anonymous → authenticated transition to
    // defend against session fixation: any pre-login session identifier an
    // attacker may have planted is discarded and a fresh one is issued.
    req.session.regenerate((regenErr) => {
      if (regenErr) { req.log.error({ err: regenErr }); res.status(500).json({ error: "Session error." }); return; }

      req.session.userId = user.id;
      req.session.userRole = user.role as any;
      req.session.userName = user.name;
      req.session.userEmail = user.email;

      // Save the session to PostgreSQL BEFORE sending the response.
      // Without this, express-session flushes asynchronously after res.end(),
      // and the very next request from the browser arrives before the row exists
      // in user_sessions → requireAuth sees no session → immediate 401.
      req.session.save((err) => {
        if (err) { req.log.error({ err }); res.status(500).json({ error: "Session save failed." }); return; }
        res.json({ user: safeUser(user), message: "Logged in successfully." });
      });
    });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

/** POST /auth/logout */
router.post("/logout", requireAuth, (req, res) => {
  req.session.destroy((err) => {
    if (err) { res.status(500).json({ error: "Could not destroy session." }); return; }
    res.clearCookie("ksa_ledger_sid");
    res.json({ message: "Logged out." });
  });
});

/**
 * GET /auth/me
 *
 * 🔴 Returns `organizationRole` — the caller's role in the ACTIVE organization
 * (M18.4.1). This is the field a UI may render off; `role` beside it is the
 * global `users.role`, which is VESTIGIAL (CLAUDE.md §4) and must never gate
 * anything. A self-signup org owner is a global "viewer" and an admin of their
 * own org, so a screen gated on `role` locks out the very person who created
 * the tenant — the M11.5.1 lesson, from the rendering side.
 *
 * Why it was added: `/period-locks` (M18.4) is the first hub block whose
 * actions are admin-only, and the frontend had no way to know the governing
 * role — `/auth/me` did not return it, and deriving it from `/orgs` meant every
 * page re-implementing the match (two already had).
 *
 * ⚠️ FOR RENDERING, NOT ENFORCEMENT. The server remains the authority on every
 * route (`requirePermission`, admin-of-THIS-org, `requirePlatformOperator`).
 * This value only decides whether a control is shown, never whether it works.
 * `null` when the user belongs to no organization.
 */
router.get("/me", requireAuth, async (req, res) => {
  try {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!)).limit(1);
    if (!user) { res.status(404).json({ error: "User not found." }); return; }

    // Identity layer: `organization_memberships` is outside RLS and only
    // pre-tenant code may read it. This route is pre-tenant.
    const memberships = await db
      .select({
        organizationId: organizationMembershipsTable.organizationId,
        role: organizationMembershipsTable.role,
      })
      .from(organizationMembershipsTable)
      .where(
        and(
          eq(organizationMembershipsTable.userId, user.id),
          eq(organizationMembershipsTable.status, "active"),
        ),
      )
      .orderBy(asc(organizationMembershipsTable.createdAt));

    const active = selectActiveMembership(memberships, req.session.activeOrgId);
    res.json({
      ...safeUser(user),
      organizationId: active?.organizationId ?? null,
      organizationRole: active?.role ?? null,
    });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

/**
 * GET /auth/users — users in the caller's OWN organization(s) (M11.5.1).
 *
 * SECURITY: this previously returned EVERY user on the platform with no
 * organization filter, guarded only by the ambient global session role — a
 * cross-tenant identity dump. It is now scoped to organizations the caller
 * actively administers.
 */
router.get("/users", userAdminRateLimiter, requireAuth, async (req, res) => {
  res.json(await userAdminService.list(req.session.userId!));
});

/** PATCH /auth/users/:id — change role/status/name (org-scoped, role validated). */
router.patch("/users/:id", userAdminRateLimiter, requireAuth, async (req, res) => {
  res.json(
    await userAdminService.update(req.session.userId!, requireIdParam(req), req.body ?? {}, actorCtx(req)),
  );
});

/** POST /auth/change-password — logged-in user changes their own password */
router.post("/change-password", authRateLimiter, requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      res.status(400).json({ error: "currentPassword and newPassword are required." }); return;
    }
    if (newPassword.length < 8) {
      res.status(400).json({ error: "New password must be at least 8 characters." }); return;
    }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!)).limit(1);
    if (!user) { res.status(404).json({ error: "User not found." }); return; }
    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) { res.status(401).json({ error: "Current password is incorrect." }); return; }
    const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await db.update(usersTable).set({ passwordHash }).where(eq(usersTable.id, user.id));
    await securityAuditService.record({
      action: "user.password_changed",
      actorUserId: user.id, actorEmail: user.email, targetUserId: user.id,
      ipAddress: req.ip ?? null,
    });
    res.json({ message: "Password changed successfully." });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

/**
 * POST /auth/users/:id/reset-password — reset a user's password (ORG-SCOPED).
 *
 * SECURITY (M11.5.1): this accepted ANY user id with only the ambient global
 * session role — the account-takeover primitive at the centre of the CRITICAL
 * finding. The target must now be a member of an organization the caller
 * actively administers.
 */
router.post("/users/:id/reset-password", userAdminRateLimiter, requireAuth, async (req, res) => {
  res.json(
    await userAdminService.resetPassword(
      req.session.userId!, requireIdParam(req), req.body?.newPassword, actorCtx(req),
    ),
  );
});

export default router;
