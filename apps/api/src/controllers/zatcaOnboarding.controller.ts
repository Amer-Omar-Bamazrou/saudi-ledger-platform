import type { Request, Response } from "express";
import { OnboardZatcaBody } from "@workspace/api-zod";
import { BadRequestError, NotFoundError } from "../lib/errors";
import { companiesRepository } from "../repositories/companies.repository";
import { zatcaOnboardingService } from "../services/einvoice/onboarding/zatcaOnboarding.service";
import { resolveProvider } from "../services/einvoice/zatca/zatcaDirectProvider";

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

  /**
   * Onboard, and re-onboard, through the {@link EInvoiceProvider} seam (S1).
   *
   * 🔴 This used to call `zatcaOnboardingService` directly, bypassing the seam
   * that exists so a certified vendor can be swapped in per company. Onboarding
   * is precisely what a vendor sells, so bypassing it here made the hedge
   * hollow. `resolveProvider()` is per-company by design.
   */
  async onboard(req: Request, res: Response) {
    const body = OnboardZatcaBody.safeParse(req.body);
    if (!body.success) throw new BadRequestError(body.error.message);

    const result = await resolveProvider().onboard({
      companyId: await currentCompanyId(),
      otp: body.data.otp,
    });

    // 200 either way: a compliance rejection is a RESULT the tenant must see in
    // full (which document, which ZATCA rule), not an opaque error. `activated`
    // carries the outcome, `documentChecks` the detail.
    res.json({
      activated: result.activated,
      certificateExpiresAt: result.certificateExpiresAt,
      complianceDocuments: result.documentChecks ?? [],
    });
  },

  /**
   * Renew before expiry — the SAME flow as onboarding, and it needs the tenant's
   * OTP for the same reason.
   *
   * ZATCA has no "extend" operation: a new certificate comes from a fresh CSR
   * authorised by a new OTP the taxpayer generates in their own Fatoora portal.
   * The vault's `activate` supersedes the previous credential inside one
   * transaction, so there is never a moment with two active credentials or none,
   * and the old row is retained (invoices signed under it must stay verifiable
   * for 6–11 years).
   */
  async renew(req: Request, res: Response) {
    const body = OnboardZatcaBody.safeParse(req.body);
    if (!body.success) throw new BadRequestError(body.error.message);

    const result = await resolveProvider().renewCertificate({
      companyId: await currentCompanyId(),
      otp: body.data.otp,
    });

    res.json({
      activated: result.activated,
      certificateExpiresAt: result.certificateExpiresAt,
      complianceDocuments: result.documentChecks ?? [],
    });
  },
};
