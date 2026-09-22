import type { Request, Response } from "express";
import { assetsService } from "../services/assets.service";
import { assetCapitalisationService } from "../services/assets/capitalisation.service";
import { assetDisposalService } from "../services/assets/disposal.service";
import { incomeTaxPoolService } from "../services/assets/incomeTaxPool.service";
import { vatCapitalAssetService } from "../services/assets/vatCapitalAsset.service";
import { pageParams, requireIdParam } from "../lib/httpParams";

const userOf = (req: Request) => req.session?.userId ?? null;

export const assetsController = {
  // ── categories ──
  async listCategories(req: Request, res: Response) {
    res.json(await assetsService.listCategories(req.query.includeInactive === "true"));
  },
  async createCategory(req: Request, res: Response) {
    res.status(201).json(await assetsService.createCategory(req.body ?? {}, userOf(req)));
  },
  async updateCategory(req: Request, res: Response) {
    res.json(await assetsService.updateCategory(requireIdParam(req), req.body ?? {}, userOf(req)));
  },
  // ── assets ──
  async list(req: Request, res: Response) {
    const q = req.query as Record<string, string | undefined>;
    const categoryId = q.category_id ? Number(q.category_id) : undefined;
    res.json(await assetsService.list(pageParams(req.query as Record<string, unknown>), { status: q.status || undefined, categoryId: Number.isInteger(categoryId) ? categoryId : undefined }));
  },
  async get(req: Request, res: Response) {
    res.json(await assetsService.getById(requireIdParam(req)));
  },
  async create(req: Request, res: Response) {
    res.status(201).json(await assetsService.create(req.body ?? {}, userOf(req)));
  },
  async update(req: Request, res: Response) {
    res.json(await assetsService.update(requireIdParam(req), req.body ?? {}, userOf(req)));
  },
  async cancel(req: Request, res: Response) {
    res.json(await assetsService.cancel(requireIdParam(req), req.body ?? {}, userOf(req)));
  },
  // ── FA-B ──
  async depreciate(req: Request, res: Response) {
    res.json(await assetCapitalisationService.depreciate(requireIdParam(req), req.body ?? {}, userOf(req)));
  },
  async runPeriod(req: Request, res: Response) {
    res.json(await assetCapitalisationService.runPeriod(req.body ?? {}, userOf(req)));
  },
  async changeEstimate(req: Request, res: Response) {
    res.json(await assetCapitalisationService.changeEstimate(requireIdParam(req), req.body ?? {}, userOf(req)));
  },
  // ── FA-C ──
  async dispose(req: Request, res: Response) {
    res.json(await assetDisposalService.dispose(requireIdParam(req), req.body ?? {}, userOf(req)));
  },
  // ── FA-E: the Income Tax Law Art. 17 pool ──
  async incomeTaxPool(req: Request, res: Response) {
    const toYear = req.query.to_year ? Number(req.query.to_year) : undefined;
    res.json(await incomeTaxPoolService.report({ toYear: Number.isInteger(toYear) ? toYear : undefined }));
  },
  async listPoolDeclarations(_req: Request, res: Response) {
    res.json({ items: await incomeTaxPoolService.declarations() });
  },
  async declarePool(req: Request, res: Response) {
    res.json(await incomeTaxPoolService.declare(req.body ?? {}, userOf(req)));
  },
  async deletePoolDeclaration(req: Request, res: Response) {
    res.json(await incomeTaxPoolService.remove(requireIdParam(req)));
  },
  // ── FA-F: the VAT IR Art. 52 capital-asset adjustment ──
  async vatAdjustments(req: Request, res: Response) {
    const assetId = req.query.asset_id ? Number(req.query.asset_id) : undefined;
    res.json(await vatCapitalAssetService.report({ assetId: Number.isInteger(assetId) ? assetId : undefined }));
  },
  async listVatUseRecords(req: Request, res: Response) {
    const assetId = req.query.asset_id ? Number(req.query.asset_id) : undefined;
    res.json({ items: await vatCapitalAssetService.useRecords(Number.isInteger(assetId) ? assetId : undefined) });
  },
  async declareVatUse(req: Request, res: Response) {
    res.json(await vatCapitalAssetService.declareUse(req.body ?? {}, userOf(req)));
  },
  async deleteVatUseRecord(req: Request, res: Response) {
    res.json(await vatCapitalAssetService.removeUse(requireIdParam(req)));
  },
};
