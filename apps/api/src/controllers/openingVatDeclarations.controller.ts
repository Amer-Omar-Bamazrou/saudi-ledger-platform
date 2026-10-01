import type { Request, Response } from "express";
import { DeclareOpeningVatBody } from "@workspace/api-zod";
import { BadRequestError } from "../lib/errors";
import { openingVatDeclarationsService } from "../services/openingVatDeclarations.service";

/** Bodies are validated against the GENERATED schema — the spec's constraint is the server's. */
function parseOr400<T>(result: { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } }): T {
  if (result.success) return result.data;
  throw new BadRequestError(result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
}

/** Phase 13B S1 — an opening payable's historical input-VAT position (admin / accountant: `opening_vat_declaration`). */
export const openingVatDeclarationsController = {
  async list(_req: Request, res: Response) {
    res.json(await openingVatDeclarationsService.list());
  },
  async declare(req: Request, res: Response) {
    const body = parseOr400(DeclareOpeningVatBody.safeParse(req.body));
    res.status(201).json(await openingVatDeclarationsService.declare(body, req.session?.userId ?? null));
  },
};
