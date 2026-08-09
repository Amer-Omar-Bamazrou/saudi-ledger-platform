import type { Request, Response } from "express";
import { OnboardZatcaBody } from "@workspace/api-zod";
import { BadRequestError, NotFoundError } from "../lib/errors";
import { companiesRepository } from "../repositories/companies.repository";
import { zatcaOnboardingService } from "../services/einvoice/onboarding/zatcaOnboarding.service";

/**
 * ZATCA onboarding (M12.4).
 *
 * The company is resolved from the REQUEST TENANT (`app.current_company_id`),
 * never from the body — ZATCA identity is per EGS unit, and letting a caller
 * name the company would be a cross-company escalation inside an org.
 */
async function currentCompanyId(): Promise<string> {
  const company = await companiesRepository.findCurrent();
  if (!company) throw new NotFoundError("No active company for this tenant");
  return company.id;
}

export const zatcaOnboardingController = {
  async status(_req: Request, res: Response) {
    res.json(await zatcaOnboardingService.status(await currentCompanyId()));
  },

  async onboard(req: Request, res: Response) {
    const body = OnboardZatcaBody.safeParse(req.body);
    if (!body.success) throw new BadRequestError(body.error.message);

    const result = await zatcaOnboardingService.onboard({
      companyId: await currentCompanyId(),
      otp: body.data.otp,
    });

    // 200 either way: a compliance rejection is a RESULT the tenant must see in
    // full (which document, which ZATCA rule), not an opaque error. `activated`
    // carries the outcome.
    res.json(result);
  },
};
