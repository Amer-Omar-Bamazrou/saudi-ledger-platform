import type { Request, Response } from "express";
import { ClassifyJournalEntryBody } from "@workspace/api-zod";
import { journalSourceReviewService } from "../services/journalSourceReview.service";
import { requireIdParam } from "../lib/httpParams";
import { BadRequestError } from "../lib/errors";

/** 🔴 A15 review (migration 0164): the unclassified-entries review — read by an admin or an accountant, classified by an admin. */
export const journalSourceReviewController = {
  async list(req: Request, res: Response) {
    const { limit, offset } = req.query as Record<string, string>;
    const n = Number(limit);
    res.json(
      await journalSourceReviewService.list(req.tenant?.role, {
        limit: Number.isFinite(n) && n > 0 ? Math.min(200, Math.floor(n)) : 50,
        offset: Math.max(0, Math.floor(Number(offset) || 0)),
      }),
    );
  },
  async classify(req: Request, res: Response) {
    const parsed = ClassifyJournalEntryBody.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError(parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
    }
    res.json(await journalSourceReviewService.classify(req.tenant?.role, requireIdParam(req), parsed.data));
  },
};
