import type { Request, Response } from "express";
import { CreateJournalEntryBody } from "@workspace/api-zod";
import { journalEntriesService } from "../services/journalEntries.service";
import { requireIdParam } from "../lib/httpParams";
import { BadRequestError } from "../lib/errors";

/** Contract batch 4: the declared body constraint is the enforced one. */
function parseOr400<T>(result: { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } }): T {
  if (result.success) return result.data;
  throw new BadRequestError(result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
}

export const journalEntriesController = {
  async list(req: Request, res: Response) {
    const { status, limit, offset } = req.query as Record<string, string>;
    const n = Number(limit);
    res.json(
      await journalEntriesService.list({
        status: status || undefined,
        limit: Number.isFinite(n) && n > 0 ? Math.min(200, Math.floor(n)) : 50,
        offset: Math.max(0, Number(offset) || 0),
      }),
    );
  },
  async get(req: Request, res: Response) {
    res.json(await journalEntriesService.getById(requireIdParam(req)));
  },
  async create(req: Request, res: Response) {
    const out = await journalEntriesService.create(parseOr400(CreateJournalEntryBody.safeParse(req.body)), req.session?.userId ?? null);
    res.status(201).json(out);
  },
  async approve(req: Request, res: Response) {
    res.json(await journalEntriesService.approve(requireIdParam(req), req.session?.userId ?? null));
  },
  async post(req: Request, res: Response) {
    res.json(await journalEntriesService.post(requireIdParam(req), req.session?.userId ?? null));
  },
  async reject(req: Request, res: Response) {
    await journalEntriesService.reject(requireIdParam(req), req.session?.userId ?? null);
    res.status(204).send();
  },
  async reverse(req: Request, res: Response) {
    res.json(await journalEntriesService.reverse(requireIdParam(req)));
  },
  async remove(req: Request, res: Response) {
    await journalEntriesService.deleteDraft(requireIdParam(req));
    res.status(204).send();
  },
};
