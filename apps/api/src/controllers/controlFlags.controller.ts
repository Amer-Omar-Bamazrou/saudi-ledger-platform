/**
 * Control flags controller (Phase 18 R-11a, DR-14) — HTTP orchestration only. Authorization is the `control_flags`
 * resource at the mount: read by the approvers (admin, accountant). Nothing is written through a route: the act a
 * flag describes writes it.
 */
import type { Request, Response } from "express";
import { pageParams } from "../lib/httpParams";
import { controlFlagsService } from "../services/controlFlags.service";

export const controlFlagsController = {
  /** GET /control-flags — a page of the active company's flags, newest first, with the total. */
  async list(req: Request, res: Response) {
    res.json(await controlFlagsService.list(pageParams(req.query as Record<string, unknown>)));
  },
};
