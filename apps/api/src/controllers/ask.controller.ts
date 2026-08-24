/** Grounded answers (AI-6a) — HTTP orchestration only. */
import type { Request, Response } from "express";
import { askService } from "../services/ask.service";

export const askController = {
  async status(_req: Request, res: Response) {
    res.json({ available: askService.available() });
  },

  async list(_req: Request, res: Response) {
    res.json({ answers: await askService.list() });
  },

  async ask(req: Request, res: Response) {
    res.json(await askService.ask(String(req.body?.question ?? ""), req.session?.userId ?? null));
  },
};
