import type { Request, Response } from "express";
import { LockPeriodBody } from "@workspace/api-zod";
import { BadRequestError, BusinessRuleError } from "../lib/errors";
import { periodLocksService } from "../services/periodLocks.service";

export const periodLocksController = {
  async list(_req: Request, res: Response) {
    res.json(await periodLocksService.list());
  },

  /**
   * M18.4 — validated against the generated schema rather than reading
   * `req.body` raw. The route predates the OpenAPI-first discipline (§4): it
   * had no spec entry at all, so nothing typed the client, nothing validated
   * the input, and the only reason a malformed period did not reach the
   * database was that the service happened to re-check the format itself.
   * The service check stays — it is the write-boundary guard — but the request
   * is now rejected at the edge with a readable error.
   */
  async create(req: Request, res: Response) {
    const body = LockPeriodBody.safeParse(req.body);
    if (!body.success) throw new BadRequestError(body.error.message);
    const lock = await periodLocksService.lock({
      period: body.data.period,
      notes: body.data.notes ?? null,
      userId: req.session?.userId ?? null,
    });
    res.status(201).json(lock);
  },

  /** 🔴 T1e (PER-2): the old reopen door names the new one — a reopen needs a reason and keeps the row. */
  async remove(_req: Request, _res: Response) {
    throw new BusinessRuleError(422, {
      code: "reopen_requires_reason",
      error: "A closed month is reopened with a reason (POST /period-locks/{period}/reopen), and its lock and history are kept. Nothing was reopened.",
    });
  },

  async reopen(req: Request, res: Response) {
    const lock = await periodLocksService.reopen(String(req.params.period), (req.body ?? {}) as { reason?: unknown }, req.session?.userId ?? null);
    res.json({ reopened: lock != null, lock });
  },

  async history(req: Request, res: Response) {
    res.json(await periodLocksService.history(String(req.params.period)));
  },
};
