import type { Request, Response } from "express";
import { OverrideMatchBody, UnmatchBody } from "@workspace/api-zod";
import { statementMatchingService } from "../services/statementMatching.service";
import { requireIdParam } from "../lib/httpParams";
import { BadRequestError } from "../lib/errors";

function parseOr400<T>(result: { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } }): T {
  if (result.success) return result.data;
  throw new BadRequestError(result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
}

function filterOf(req: Request) {
  const { bank_account_id, date_from, date_to, limit } = req.query as Record<string, string>;
  const bankAccountId = bank_account_id ? Number(bank_account_id) : undefined;
  if (bank_account_id && (!Number.isInteger(bankAccountId) || bankAccountId! <= 0)) throw new BadRequestError("bank_account_id must be a positive integer");
  const n = Number(limit);
  return { bankAccountId, from: date_from || undefined, to: date_to || undefined, limit: Number.isFinite(n) && n > 0 ? Math.min(500, Math.floor(n)) : undefined };
}

export const matchingController = {
  async classify(req: Request, res: Response) {
    res.json(await statementMatchingService.classify(filterOf(req)));
  },
  async apply(req: Request, res: Response) {
    res.json(await statementMatchingService.apply(filterOf(req), req.session?.userId ?? null));
  },
  async override(req: Request, res: Response) {
    const body = parseOr400(OverrideMatchBody.safeParse(req.body));
    res.status(201).json(await statementMatchingService.override(body, req.session?.userId ?? null));
  },
  async get(req: Request, res: Response) {
    res.json(await statementMatchingService.get(requireIdParam(req)));
  },
  async unmatch(req: Request, res: Response) {
    const body = parseOr400(UnmatchBody.safeParse(req.body));
    res.json(await statementMatchingService.unmatch(requireIdParam(req), body, req.session?.userId ?? null));
  },
};
