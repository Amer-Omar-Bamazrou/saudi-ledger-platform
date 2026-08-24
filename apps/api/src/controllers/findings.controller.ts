/**
 * Findings controller (AI-3a) — HTTP orchestration only. Authorization is the
 * `findings` resource: read = all roles, run (create) = write roles,
 * acknowledge = approver authority (the APPROVE_ROUTE mapping in rbac.ts —
 * dismissing a warning about money is a review decision).
 */
import type { Request, Response } from "express";
import { BadRequestError } from "../lib/errors";
import { requireIdParam } from "../lib/httpParams";
import { findingsService } from "../services/findings.service";

const STATUSES = ["open", "acknowledged", "resolved"];

export const findingsController = {
  async list(req: Request, res: Response) {
    const { status, kind } = req.query as Record<string, string>;
    if (status && !STATUSES.includes(status)) {
      throw new BadRequestError(`status must be one of: ${STATUSES.join(", ")}`);
    }
    // Viewing IS the event being recorded (AI-5): an approver-level role
    // listing findings stamps unviewed scheduled runs. Deliberate side effect
    // on a GET — the thing recorded is exactly that this GET happened.
    await findingsService.markViewed(req.tenant!.role, req.session?.userId ?? null);
    res.json(
      await findingsService.list(
        { status: status || undefined, kind: kind || undefined },
        req.tenant!.organizationId,
      ),
    );
  },

  async status(req: Request, res: Response) {
    res.json(await findingsService.status());
  },

  async setSchedule(req: Request, res: Response) {
    res.json(await findingsService.setCadence(String(req.body?.cadence ?? ""), req.session?.userId ?? null));
  },

  async run(_req: Request, res: Response) {
    res.json(await findingsService.run());
  },

  async acknowledge(req: Request, res: Response) {
    res.json(
      await findingsService.acknowledge(requireIdParam(req), req.session?.userId ?? null, req.tenant!.organizationId),
    );
  },
};
