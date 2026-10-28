import type { Request, Response } from "express";
import { whtClaimsService } from "../services/tax/whtClaims.service";
import { requireIdParam } from "../lib/httpParams";

/** 🔴 Phase 18 G4b (WHT decisions 17, 18): the refund-claim and instalment-request records — append-only. */
export const whtClaimsController = {
  async refundClaims(_req: Request, res: Response) {
    res.json(await whtClaimsService.refundClaims());
  },
  async createRefundClaim(req: Request, res: Response) {
    res.status(201).json(await whtClaimsService.createRefundClaim((req.body ?? {}) as Record<string, unknown>, req.session?.userId ?? null));
  },
  async addRefundClaimEvent(req: Request, res: Response) {
    res.status(201).json(await whtClaimsService.addRefundClaimEvent(requireIdParam(req), (req.body ?? {}) as Record<string, unknown>, req.session?.userId ?? null));
  },
  async instalmentRequests(_req: Request, res: Response) {
    res.json(await whtClaimsService.instalmentRequests());
  },
  async createInstalmentRequest(req: Request, res: Response) {
    res.status(201).json(await whtClaimsService.createInstalmentRequest((req.body ?? {}) as Record<string, unknown>, req.session?.userId ?? null));
  },
  async addInstalmentRequestEvent(req: Request, res: Response) {
    res.status(201).json(await whtClaimsService.addInstalmentRequestEvent(requireIdParam(req), (req.body ?? {}) as Record<string, unknown>, req.session?.userId ?? null));
  },
};
