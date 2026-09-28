/**
 * Phase 13C — the Expenses view: bills recorded as paid when recorded.
 *
 * READ-ONLY by design. An expense is CREATED through POST /bills (with
 * `recordedAsExpense`) and posted and paid through POST /bills/:id/approve —
 * the bill paths — so there is no second write path to the same ledger
 * effect. Mounted behind requirePermission("bills"): who may see purchases has
 * one answer, not two.
 */
import { Router } from "express";
import { expensesService } from "../services/expenses.service";

const router = Router();

/** 1..200, default 50 — a page the caller cannot turn into "everything". */
function clampPage(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(200, Math.floor(n));
}

router.get("/", async (req, res) => {
  const { status, q, limit, offset } = req.query as Record<string, string | undefined>;
  res.json(await expensesService.list({
    status: status === "unposted" || status === "posted" ? status : undefined,
    q: q || undefined,
    limit: clampPage(limit),
    offset: Math.max(0, Number(offset) || 0),
  }));
});

export default router;
