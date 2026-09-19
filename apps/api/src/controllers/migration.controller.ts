import type { Request, Response } from "express";
import {
  CreateMigrationBatchBody, UpdateMigrationBatchBody, ImportMigrationChartBody, DecideMigrationChartRowBody,
  ImportMigrationPartiesBody, DecideMigrationPartyBody, ImportMigrationOpenItemsBody, ImportMigrationAdvancesBody,
} from "@workspace/api-zod";
import { migrationService } from "../services/migration.service";
import { migrationStagingService } from "../services/migrationStaging.service";
import { migrationValidationService } from "../services/migrationValidation.service";
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

  // ── Phase 2 ──
  async update(req: Request, res: Response) {
    const body = parseOr400(UpdateMigrationBatchBody.safeParse(req.body));
    res.json(await migrationService.updateBatch(requireIdParam(req), body, req.session?.userId ?? null));
  },
  async getParties(req: Request, res: Response) {
    res.json(await migrationStagingService.getParties(requireIdParam(req)));
  },
  async importParties(req: Request, res: Response) {
    const body = parseOr400(ImportMigrationPartiesBody.safeParse(req.body));
    res.json(await migrationStagingService.importParties(requireIdParam(req), body, req.session?.userId ?? null));
  },
  async decideParty(req: Request, res: Response) {
    const body = parseOr400(DecideMigrationPartyBody.safeParse(req.body));
    res.json(await migrationStagingService.decideParty(requireIdParam(req), rowIdParam(req), body, req.session?.userId ?? null));
  },
  async getOpenItems(req: Request, res: Response) {
    res.json(await migrationStagingService.getOpenItems(requireIdParam(req)));
  },
  async importOpenItems(req: Request, res: Response) {
    const body = parseOr400(ImportMigrationOpenItemsBody.safeParse(req.body));
    res.json(await migrationStagingService.importOpenItems(requireIdParam(req), body, req.session?.userId ?? null));
  },
  async getAdvances(req: Request, res: Response) {
    res.json(await migrationStagingService.getAdvances(requireIdParam(req)));
  },
  async importAdvances(req: Request, res: Response) {
    const body = parseOr400(ImportMigrationAdvancesBody.safeParse(req.body));
    res.json(await migrationStagingService.importAdvances(requireIdParam(req), body, req.session?.userId ?? null));
  },
  async openingPosition(req: Request, res: Response) {
    res.json(await migrationValidationService.getOpeningPosition(requireIdParam(req)));
  },
  async validate(req: Request, res: Response) {
    res.json(await migrationValidationService.validate(requireIdParam(req), req.session?.userId ?? null));
  },
};
