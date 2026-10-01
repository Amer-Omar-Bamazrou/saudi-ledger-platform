import type { Request, Response } from "express";
import {
  CreateBudgetBody,
  UpdateBudgetBody,
  ReplaceBudgetLinesBody,
  SendBackBudgetVersionBody,
} from "@workspace/api-zod";
import { budgetsService } from "../services/budgets.service";
import { requireIdParam } from "../lib/httpParams";
import { BadRequestError } from "../lib/errors";

/** Contract batch 5: the declared body constraint is the enforced one. */
function parseOr400<T>(result: { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } }): T {
  if (result.success) return result.data;
  throw new BadRequestError(result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
}

/** A positive integer path or query value, or a 400 that names it — never NaN passed on. */
function intParam(raw: unknown, name: string): number {
  const s = String(raw ?? "");
  // a Postgres integer: anything larger is not an id this API ever issued
  if (!/^\d+$/.test(s) || Number(s) > 2_147_483_647) throw new BadRequestError(`${name} must be a positive whole number.`);
  return Number(s);
}
const optionalInt = (raw: unknown, name: string): number | undefined => (raw == null || raw === "" ? undefined : intParam(raw, name));
const versionIdOf = (req: Request) => intParam(req.params.versionId, "versionId");
const userOf = (req: Request) => req.session?.userId ?? null;

export const budgetsController = {
  async list(req: Request, res: Response) {
    const { as_of, scenario } = req.query as Record<string, string | undefined>;
    res.json(await budgetsService.list({ as_of, scenario }));
  },
  async accounts(_req: Request, res: Response) {
    res.json(await budgetsService.accounts());
  },
  async create(req: Request, res: Response) {
    res.status(201).json(await budgetsService.create(parseOr400(CreateBudgetBody.safeParse(req.body)), userOf(req)));
  },
  async get(req: Request, res: Response) {
    res.json(await budgetsService.detail(requireIdParam(req), optionalInt(req.query.version_id, "version_id")));
  },
  async update(req: Request, res: Response) {
    res.json(await budgetsService.update(requireIdParam(req), parseOr400(UpdateBudgetBody.safeParse(req.body))));
  },
  async remove(req: Request, res: Response) {
    await budgetsService.remove(requireIdParam(req));
    res.status(204).send();
  },
  async revise(req: Request, res: Response) {
    res.status(201).json(await budgetsService.revise(requireIdParam(req), userOf(req)));
  },
  async replaceLines(req: Request, res: Response) {
    res.json(await budgetsService.replaceLines(requireIdParam(req), versionIdOf(req), parseOr400(ReplaceBudgetLinesBody.safeParse(req.body))));
  },
  async submit(req: Request, res: Response) {
    res.json(await budgetsService.submit(requireIdParam(req), versionIdOf(req), userOf(req)));
  },
  async approve(req: Request, res: Response) {
    res.json(await budgetsService.approve(requireIdParam(req), versionIdOf(req), userOf(req)));
  },
  async sendBack(req: Request, res: Response) {
    const body = parseOr400(SendBackBudgetVersionBody.safeParse(req.body ?? {}));
    res.json(await budgetsService.sendBack(requireIdParam(req), versionIdOf(req), body.note, userOf(req)));
  },
  async reject(req: Request, res: Response) {
    await budgetsService.reject(requireIdParam(req), versionIdOf(req), userOf(req));
    res.status(204).send();
  },
  async vsActual(req: Request, res: Response) {
    res.json(await budgetsService.vsActual(requireIdParam(req), {
      version_id: optionalInt(req.query.version_id, "version_id"),
      through_period: optionalInt(req.query.through_period, "through_period"),
    }));
  },
};
