/**
 * requirePlatformOperator (M11.3) — the guard for the cross-tenant verification
 * review surface (`/operator`).
 *
 * Mounted AFTER `requireAuth` and BEFORE `resolveTenant` (identity layer, base
 * connection). It authorizes purely off the `platform_operators` table — never
 * off org membership or the global `users.role`. Fail-closed: a non-operator gets
 * 403. This is the ONLY thing operator status unlocks; it grants no access to any
 * tenant's business data (operators hold no membership, so `resolveTenant` blocks
 * every business route independently).
 */
import type { Request, Response, NextFunction } from "express";
import { operatorsRepository } from "../repositories/operators.repository";

export async function requirePlatformOperator(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = req.session.userId;
    if (!userId) {
      res.status(401).json({ error: "Authentication required. Please log in." });
      return;
    }
    if (!(await operatorsRepository.isOperator(userId))) {
      res.status(403).json({ error: "Platform operator access required." });
      return;
    }
    next();
  } catch (err) {
    req.log.error({ err }, "requirePlatformOperator failed");
    res.status(500).json({ error: "Authorization check failed." });
  }
}
