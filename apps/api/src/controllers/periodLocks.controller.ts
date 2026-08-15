import type { Request, Response } from "express";
import { LockPeriodBody } from "@workspace/api-zod";
import { BadRequestError } from "../lib/errors";
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

  async remove(req: Request, res: Response) {
    await periodLocksService.unlock(String(req.params.period));
    res.status(204).send();
  },
};
