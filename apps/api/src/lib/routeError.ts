/**
 * Central catch-block handler.
 * Errors thrown with a `statusCode` property (e.g. period locks, immutability guards)
 * propagate their status directly to the client instead of becoming a generic 500.
 */
import type { Request, Response } from "express";

export function handleRouteError(err: unknown, req: Request, res: Response): void {
  const code = (err as any)?.statusCode;
  if (typeof code === "number" && code >= 400 && code < 600) {
    res.status(code).json({ error: (err as Error).message });
    return;
  }
  req.log.error({ err });
  res.status(500).json({ error: "Internal server error" });
}
