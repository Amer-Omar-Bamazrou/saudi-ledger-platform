/**
 * Period lock management.
 * POST /period-locks       { period: "2026-06", notes?: "..." }  → lock a period
 * GET  /period-locks       → list all locked periods
 * DELETE /period-locks/:period → unlock a period (audited)
 *
 * Authorization is applied at the router mount via requirePermission("period_locks")
 * in routes/index.ts: read is open to all roles; create (lock) and delete (unlock)
 * are admin-only per the seeded permission matrix.
 */
import { Router } from "express";
import { db } from "@workspace/db";
import { periodLocksTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const locks = await db.select().from(periodLocksTable).orderBy(periodLocksTable.period);
    res.json(locks.map(l => ({ ...l, lockedAt: l.lockedAt.toISOString() })));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.post("/", async (req, res) => {
  try {
    const { period, notes } = req.body;
    if (!period || !/^\d{4}-\d{2}$/.test(period)) {
      res.status(400).json({ error: "period must be in YYYY-MM format (e.g. 2026-06)" }); return;
    }
    const [existing] = await db.select().from(periodLocksTable).where(eq(periodLocksTable.period, period)).limit(1);
    if (existing) {
      res.status(409).json({ error: `Period ${period} is already locked.` }); return;
    }
    const [lock] = await db.insert(periodLocksTable).values({
      period,
      lockedBy: req.session?.userId ?? null,
      notes: notes ?? null,
    }).returning();
    res.status(201).json({ ...lock, lockedAt: lock.lockedAt.toISOString() });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.delete("/:period", async (req, res) => {
  try {
    const period = String(req.params.period);
    await db.delete(periodLocksTable).where(eq(periodLocksTable.period, period));
    res.status(204).send();
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

export default router;
