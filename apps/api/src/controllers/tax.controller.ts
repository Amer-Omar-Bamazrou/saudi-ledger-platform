import type { Request, Response } from "express";
import {
  RemitWhtBody, ReverseWhtRemittanceBody, CreateWhtReliefBody, RevokeWhtReliefBody, SetZakatClassificationBody,
  CreateTaxComputationBody, UpdateTaxComputationBody, AddTaxAdjustmentBody, UpdateTaxAdjustmentBody, SetTaxLossesBody,
  SendBackTaxComputationVersionBody,
} from "@workspace/api-zod";
import { whtService } from "../services/tax/wht.service";
import { taxComputationsService } from "../services/tax/taxComputations.service";
import { zakatClassificationService } from "../services/tax/zakatClassification.service";
import { taxObligationsService } from "../services/tax/taxObligations.service";
import { BadRequestError } from "../lib/errors";

/** The declared body constraint is the enforced one (contract batch 5). */
function parseOr400<T>(result: { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } }): T {
  if (result.success) return result.data;
  throw new BadRequestError(result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
}
/** A positive integer path or query value, or a 400 that names it — never NaN, never an id above int4. */
function intParam(raw: unknown, name: string): number {
  const s = String(raw ?? "");
  if (!/^\d+$/.test(s) || Number(s) > 2_147_483_647 || Number(s) === 0) throw new BadRequestError(`${name} must be a positive whole number.`);
  return Number(s);
}
const optionalInt = (raw: unknown, name: string): number | undefined => (raw == null || raw === "" ? undefined : intParam(raw, name));
const userOf = (req: Request) => req.session?.userId ?? null;
const q = (req: Request) => req.query as Record<string, string | undefined>;

export const taxController = {
  async obligations(_req: Request, res: Response) { res.json(await taxObligationsService.list()); },

  // ── WHT ────────────────────────────────────────────────────────────────
  async rates(_req: Request, res: Response) { res.json(await whtService.rates()); },
  async preview(req: Request, res: Response) { res.json(await whtService.preview(q(req))); },
  async overview(_req: Request, res: Response) { res.json(await whtService.overview()); },
  async monthlyReturn(req: Request, res: Response) { res.json(await whtService.monthlyReturn(String(req.params.period))); },
  async annual(req: Request, res: Response) { res.json(await whtService.annual(q(req).fiscal_year)); },
  async beneficiary(req: Request, res: Response) { res.json(await whtService.beneficiaryStatement(intParam(req.params.vendorId, "vendorId"), q(req).period)); },
  async exceptions(req: Request, res: Response) { res.json(await whtService.exceptions(q(req).kind)); },
  async remit(req: Request, res: Response) {
    res.json(await whtService.remit(String(req.params.period), parseOr400(RemitWhtBody.safeParse(req.body)) as Record<string, unknown>, userOf(req)));
  },
  async reverseRemittance(req: Request, res: Response) {
    res.json(await whtService.reverseRemittance(intParam(req.params.id, "id"), parseOr400(ReverseWhtRemittanceBody.safeParse(req.body)), userOf(req)));
  },
  async reliefs(req: Request, res: Response) { res.json(await whtService.reliefs(q(req).vendorId)); },
  async createRelief(req: Request, res: Response) {
    res.status(201).json(await whtService.createRelief(parseOr400(CreateWhtReliefBody.safeParse(req.body)) as Record<string, unknown>, userOf(req)));
  },
  async approveRelief(req: Request, res: Response) { res.json(await whtService.approveRelief(intParam(req.params.id, "id"), userOf(req))); },
  async revokeRelief(req: Request, res: Response) {
    res.json(await whtService.revokeRelief(intParam(req.params.id, "id"), parseOr400(RevokeWhtReliefBody.safeParse(req.body)), userOf(req)));
  },
  async removeRelief(req: Request, res: Response) {
    await whtService.removeRelief(intParam(req.params.id, "id"));
    res.status(204).send();
  },

  // ── Zakat classification ───────────────────────────────────────────────
  async classifications(_req: Request, res: Response) { res.json(await zakatClassificationService.list()); },
  async setClassification(req: Request, res: Response) {
    res.json(await zakatClassificationService.set(intParam(req.params.accountId, "accountId"), parseOr400(SetZakatClassificationBody.safeParse(req.body)), userOf(req)));
  },
  async clearClassification(req: Request, res: Response) {
    await zakatClassificationService.clear(intParam(req.params.accountId, "accountId"));
    res.status(204).send();
  },

  // ── computations ───────────────────────────────────────────────────────
  async list(req: Request, res: Response) { res.json(await taxComputationsService.list(q(req).kind)); },
  async create(req: Request, res: Response) {
    res.status(201).json(await taxComputationsService.create(parseOr400(CreateTaxComputationBody.safeParse(req.body)), userOf(req)));
  },
  async get(req: Request, res: Response) {
    res.json(await taxComputationsService.detail(intParam(req.params.id, "id"), optionalInt(q(req).version_id, "version_id")));
  },
  async update(req: Request, res: Response) {
    res.json(await taxComputationsService.update(intParam(req.params.id, "id"), parseOr400(UpdateTaxComputationBody.safeParse(req.body))));
  },
  async remove(req: Request, res: Response) {
    await taxComputationsService.remove(intParam(req.params.id, "id"));
    res.status(204).send();
  },
  async revise(req: Request, res: Response) { res.json(await taxComputationsService.revise(intParam(req.params.id, "id"), userOf(req))); },
  async addAdjustment(req: Request, res: Response) {
    res.json(await taxComputationsService.addAdjustment(intParam(req.params.id, "id"), intParam(req.params.versionId, "versionId"), parseOr400(AddTaxAdjustmentBody.safeParse(req.body)) as Record<string, unknown>, userOf(req)));
  },
  async updateAdjustment(req: Request, res: Response) {
    res.json(await taxComputationsService.updateAdjustment(intParam(req.params.id, "id"), intParam(req.params.versionId, "versionId"), intParam(req.params.adjustmentId, "adjustmentId"), parseOr400(UpdateTaxAdjustmentBody.safeParse(req.body)) as Record<string, unknown>));
  },
  async removeAdjustment(req: Request, res: Response) {
    res.json(await taxComputationsService.removeAdjustment(intParam(req.params.id, "id"), intParam(req.params.versionId, "versionId"), intParam(req.params.adjustmentId, "adjustmentId")));
  },
  async setLosses(req: Request, res: Response) {
    res.json(await taxComputationsService.setLosses(intParam(req.params.id, "id"), intParam(req.params.versionId, "versionId"), parseOr400(SetTaxLossesBody.safeParse(req.body))));
  },
  async submit(req: Request, res: Response) {
    res.json(await taxComputationsService.submit(intParam(req.params.id, "id"), intParam(req.params.versionId, "versionId"), userOf(req)));
  },
  async approve(req: Request, res: Response) {
    res.json(await taxComputationsService.approve(intParam(req.params.id, "id"), intParam(req.params.versionId, "versionId"), userOf(req)));
  },
  async sendBack(req: Request, res: Response) {
    const body = parseOr400(SendBackTaxComputationVersionBody.safeParse(req.body ?? {}));
    res.json(await taxComputationsService.sendBack(intParam(req.params.id, "id"), intParam(req.params.versionId, "versionId"), body.note ?? undefined, userOf(req)));
  },
  async reject(req: Request, res: Response) {
    await taxComputationsService.reject(intParam(req.params.id, "id"), intParam(req.params.versionId, "versionId"), userOf(req));
    res.status(204).send();
  },
};
