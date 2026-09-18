import type { Request, Response } from "express";
import { CreateMigrationBatchBody, ImportMigrationChartBody, DecideMigrationChartRowBody } from "@workspace/api-zod";
import { migrationService } from "../services/migration.service";
import { requireIdParam } from "../lib/httpParams";
import { BadRequestError } from "../lib/errors";

/** Bodies are validated against the GENERATED schemas — the spec's constraint is the server's. */
function parseOr400<T>(result: { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } }): T {
  if (result.success) return result.data;
  throw new BadRequestError(result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
}

function rowIdParam(req: Request): number {
  const n = Number(req.params.rowId);
  if (!Number.isInteger(n) || n <= 0) throw new BadRequestError("rowId must be a positive integer");
  return n;
}

export const migrationController = {
  async list(_req: Request, res: Response) {
    res.json(await migrationService.listBatches());
  },
  async create(req: Request, res: Response) {
    const body = parseOr400(CreateMigrationBatchBody.safeParse(req.body));
    res.status(201).json(await migrationService.createBatch(body, req.session?.userId ?? null));
  },
  async get(req: Request, res: Response) {
    res.json(await migrationService.getBatch(requireIdParam(req)));
  },
  async discard(req: Request, res: Response) {
    res.json(await migrationService.discardBatch(requireIdParam(req), req.session?.userId ?? null));
  },
  async getChart(req: Request, res: Response) {
    res.json(await migrationService.getChart(requireIdParam(req)));
  },
  async importChart(req: Request, res: Response) {
    const body = parseOr400(ImportMigrationChartBody.safeParse(req.body));
    res.json(await migrationService.importChart(requireIdParam(req), body, req.session?.userId ?? null));
  },
  async decideChartRow(req: Request, res: Response) {
    const body = parseOr400(DecideMigrationChartRowBody.safeParse(req.body));
    res.json(await migrationService.decideChartRow(requireIdParam(req), rowIdParam(req), body, req.session?.userId ?? null));
  },
};
