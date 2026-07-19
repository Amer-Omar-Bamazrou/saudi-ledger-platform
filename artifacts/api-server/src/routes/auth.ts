/**
 * Auth routes: POST /auth/register, POST /auth/login, POST /auth/logout, GET /auth/me
 */
import { Router } from "express";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../lib/auth";

const router = Router();
const SALT_ROUNDS = 12;

function safeUser(u: typeof usersTable.$inferSelect) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, isActive: u.isActive, createdAt: u.createdAt.toISOString() };
}

/**
 * POST /auth/register
 * - First user ever can register freely (bootstraps the system).
 * - Subsequent registrations require an admin session.
 */
router.post("/register", async (req, res) => {
  try {
    const { email, name, password, role = "viewer" } = req.body;
    if (!email || !name || !password) {
      res.status(400).json({ error: "email, name, and password are required." }); return;
    }
    if (!["admin", "accountant", "viewer"].includes(role)) {
      res.status(400).json({ error: "Invalid role. Must be admin, accountant, or viewer." }); return;
    }

    // Check if any users exist
    const [existing] = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
    if (existing) {
      // Not the first user — require admin session
      if (!req.session?.userId || req.session.userRole !== "admin") {
        res.status(403).json({ error: "Only an admin can register new users." }); return;
      }
    }

    // Check duplicate email
    const [dup] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (dup) { res.status(409).json({ error: "Email already registered." }); return; }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const [user] = await db.insert(usersTable).values({ email, name, passwordHash, role, isActive: true }).returning();
    res.status(201).json(safeUser(user));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

/** POST /auth/login */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      res.status(400).json({ error: "email and password are required." }); return;
    }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (!user || !user.isActive) {
      res.status(401).json({ error: "Invalid credentials." }); return;
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      res.status(401).json({ error: "Invalid credentials." }); return;
    }

    // Stamp last login
    await db.update(usersTable).set({ lastLoginAt: new Date() }).where(eq(usersTable.id, user.id));

    req.session.userId = user.id;
    req.session.userRole = user.role as any;
    req.session.userName = user.name;
    req.session.userEmail = user.email;

    res.json({ user: safeUser(user), message: "Logged in successfully." });
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
    const [user] = await db.update(usersTable).set(updates).where(eq(usersTable.id, id)).returning();
    if (!user) { res.status(404).json({ error: "User not found." }); return; }
    res.json(safeUser(user));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

/** POST /auth/change-password — logged-in user changes their own password */
router.post("/change-password", requireAuth, async (req, res) => {
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
    res.json({ message: `Password reset for ${user.name}.` });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

export default router;
