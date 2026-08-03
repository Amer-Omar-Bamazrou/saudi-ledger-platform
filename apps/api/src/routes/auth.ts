/**
 * Auth routes: POST /auth/register, POST /auth/login, POST /auth/logout, GET /auth/me
 */
import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../lib/auth";
import { securityAuditService } from "../services/securityAudit.service";
import { signupService } from "../services/signup.service";

const router = Router();
const SALT_ROUNDS = 12;

/**
 * Brute-force protection for credential endpoints. In-memory store (fine for a
 * single instance; move to a Redis store when the API scales horizontally).
 * Keys on client IP; 10 attempts per 15 minutes.
 */
const authRateLimiter = rateLimit({
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
const signupRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many signup attempts. Please try again later." },
});

// Fixed decoy hash used to keep login timing constant when the email is unknown
// or the account is inactive. Comparing the supplied password against this hash
// costs roughly the same as comparing against a real user's hash, so an attacker
// can't distinguish "no such user" from "wrong password" by response time.
// The plaintext is irrelevant — it only ever needs to NOT match a real password.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync("timing-attack-decoy", SALT_ROUNDS);

function safeUser(u: typeof usersTable.$inferSelect) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, isActive: u.isActive, createdAt: u.createdAt.toISOString() };
}

/**
 * POST /auth/register — admin only.
 *
 * There is intentionally NO unauthenticated bootstrap path: the previous
 * "first user registers freely" branch was a race-to-admin (two concurrent
 * unauthenticated requests could both observe "no users exist" and both insert
 * as admin, and any attacker reaching the API before the real operator could
 * self-register as admin). The initial admin is now provisioned out-of-band via
 * the seed script (`pnpm --filter @workspace/db run seed`, gated on the
 * SEED_ADMIN_* env vars). All HTTP registration requires an existing admin.
 */
router.post("/register", authRateLimiter, requireAuth, requireAdmin, async (req, res) => {
  try {
    const { email, name, password, role = "viewer" } = req.body;
    if (!email || !name || !password) {
      res.status(400).json({ error: "email, name, and password are required." }); return;
    }
    if (!["admin", "accountant", "bookkeeper", "viewer"].includes(role)) {
      res.status(400).json({ error: "Invalid role. Must be admin, accountant, bookkeeper, or viewer." }); return;
    }

    // Check duplicate email
    const [dup] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (dup) { res.status(409).json({ error: "Email already registered." }); return; }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const [user] = await db.insert(usersTable).values({ email, name, passwordHash, role, isActive: true }).returning();
    await securityAuditService.record({
      action: "user.created",
      actorUserId: req.session.userId ?? null,
      actorEmail: req.session.userEmail ?? null,
      targetUserId: user.id,
      metadata: { email: user.email, role: user.role },
      ipAddress: req.ip ?? null,
    });
    res.status(201).json(safeUser(user));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
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
router.post("/signup", signupRateLimiter, async (req, res) => {
  const created = await signupService.signup(req.body ?? {}, { ipAddress: req.ip ?? null });

  // Rotate the session id on the anonymous → authenticated transition, then sign
  // the new admin in (same posture as /auth/login).
  req.session.regenerate((regenErr) => {
    if (regenErr) { req.log.error({ err: regenErr }); res.status(500).json({ error: "Session error." }); return; }
    req.session.userId = created.userId;
    req.session.userRole = "admin";
    req.session.userName = created.name;
    req.session.userEmail = created.email;
    req.session.activeOrgId = created.organizationId;
    req.session.save((err) => {
      if (err) { req.log.error({ err }); res.status(500).json({ error: "Session save failed." }); return; }
      res.status(201).json({
        user: { id: created.userId, email: created.email, name: created.name, role: "admin", isActive: true },
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

/** GET /auth/me */
router.get("/me", requireAuth, async (req, res) => {
  try {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!)).limit(1);
    if (!user) { res.status(404).json({ error: "User not found." }); return; }
    res.json(safeUser(user));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

/** GET /auth/users — admin only */
router.get("/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = await db.select().from(usersTable).orderBy(usersTable.createdAt);
    res.json(users.map(safeUser));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

/** PATCH /auth/users/:id — admin can change role/status/name */
router.patch("/users/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { role, isActive, name } = req.body;
    const updates: Partial<typeof usersTable.$inferInsert> = {};
    if (role) updates.role = role;
    if (isActive !== undefined) updates.isActive = isActive;
    if (name) updates.name = name;

    const [before] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
    if (!before) { res.status(404).json({ error: "User not found." }); return; }

    const [user] = await db.update(usersTable).set(updates).where(eq(usersTable.id, id)).returning();

    // Global-identity security events (name changes are not security-relevant).
    const actor = { actorUserId: req.session.userId ?? null, actorEmail: req.session.userEmail ?? null, ipAddress: req.ip ?? null };
    if (updates.role !== undefined && user.role !== before.role) {
      await securityAuditService.record({
        action: "user.role_changed", ...actor, targetUserId: id,
        metadata: { before: before.role, after: user.role },
      });
    }
    if (updates.isActive !== undefined && user.isActive !== before.isActive) {
      await securityAuditService.record({
        action: user.isActive ? "user.reactivated" : "user.deactivated", ...actor, targetUserId: id,
      });
    }
    res.json(safeUser(user));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
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

/** POST /auth/users/:id/reset-password — admin resets another user's password */
router.post("/users/:id/reset-password", requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
      res.status(400).json({ error: "newPassword must be at least 8 characters." }); return;
    }
    const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    const [user] = await db.update(usersTable).set({ passwordHash }).where(eq(usersTable.id, id)).returning();
    if (!user) { res.status(404).json({ error: "User not found." }); return; }
    await securityAuditService.record({
      action: "user.password_reset",
      actorUserId: req.session.userId ?? null, actorEmail: req.session.userEmail ?? null,
      targetUserId: id, ipAddress: req.ip ?? null,
    });
    res.json({ message: `Password reset for ${user.name}.` });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

export default router;
