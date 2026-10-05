import type { Request, Response } from "express";
import {
  CreatePaymentPlanBody, UpdatePaymentPlanBody, PayPaymentPlanBody, CancelPaymentPlanBody,
  CreateForecastAssumptionBody, UpdateForecastAssumptionBody, UpdateTreasurySettingsBody,
} from "@workspace/api-zod";
import { treasuryService } from "../services/treasury/treasury.service";
import { paymentPlansService } from "../services/treasury/paymentPlans.service";
import { BadRequestError } from "../lib/errors";

function parseOr400<T>(result: { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } }): T {
  if (result.success) return result.data;
  throw new BadRequestError(result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
}
function intParam(raw: unknown, name: string): number {
  const s = String(raw ?? "");
  if (!/^\d+$/.test(s) || Number(s) > 2_147_483_647 || Number(s) === 0) throw new BadRequestError(`${name} must be a positive whole number.`);
  return Number(s);
}
const userOf = (req: Request) => req.session?.userId ?? null;
const q = (req: Request) => req.query as Record<string, string | undefined>;

export const treasuryController = {
  async dashboard(req: Request, res: Response) { res.json(await treasuryService.dashboard(q(req).weeks)); },
  async position(req: Request, res: Response) { res.json(await treasuryService.position(q(req).as_of)); },
  async forecast(req: Request, res: Response) { res.json(await treasuryService.forecast(q(req).weeks)); },

  async plans(req: Request, res: Response) { res.json(await paymentPlansService.list({ status: q(req).status, billId: q(req).billId })); },
  async createPlan(req: Request, res: Response) {
    res.status(201).json(await paymentPlansService.create(parseOr400(CreatePaymentPlanBody.safeParse(req.body)) as Record<string, unknown>, userOf(req)));
  },
  async updatePlan(req: Request, res: Response) {
    res.json(await paymentPlansService.update(intParam(req.params.id, "id"), parseOr400(UpdatePaymentPlanBody.safeParse(req.body)) as Record<string, unknown>));
  },
  async removePlan(req: Request, res: Response) {
    await paymentPlansService.remove(intParam(req.params.id, "id"));
    res.status(204).send();
  },
  async approvePlan(req: Request, res: Response) { res.json(await paymentPlansService.approve(intParam(req.params.id, "id"), userOf(req))); },
  async payPlan(req: Request, res: Response) {
    res.json(await paymentPlansService.pay(intParam(req.params.id, "id"), parseOr400(PayPaymentPlanBody.safeParse(req.body ?? {})) as Record<string, unknown>, userOf(req)));
  },
  async cancelPlan(req: Request, res: Response) {
    res.json(await paymentPlansService.cancel(intParam(req.params.id, "id"), parseOr400(CancelPaymentPlanBody.safeParse(req.body)), userOf(req)));
  },

  async assumptions(_req: Request, res: Response) { res.json(await treasuryService.entries()); },
  async createAssumption(req: Request, res: Response) {
    res.status(201).json(await treasuryService.createEntry(parseOr400(CreateForecastAssumptionBody.safeParse(req.body)) as Record<string, unknown>, userOf(req)));
  },
  async updateAssumption(req: Request, res: Response) {
    res.json(await treasuryService.updateEntry(intParam(req.params.id, "id"), parseOr400(UpdateForecastAssumptionBody.safeParse(req.body)) as Record<string, unknown>, userOf(req)));
  },
  async removeAssumption(req: Request, res: Response) {
    await treasuryService.removeEntry(intParam(req.params.id, "id"));
    res.status(204).send();
  },

  async settings(_req: Request, res: Response) { res.json(await treasuryService.settings()); },
  async updateSettings(req: Request, res: Response) {
    res.json(await treasuryService.updateSettings(parseOr400(UpdateTreasurySettingsBody.safeParse(req.body)), userOf(req)));
  },
};
