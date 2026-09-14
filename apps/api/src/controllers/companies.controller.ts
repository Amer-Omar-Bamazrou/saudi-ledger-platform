import type { Request, Response } from "express";
import { UpdateCurrentCompanyBody } from "@workspace/api-zod";
import { BadRequestError } from "../lib/errors";
import { companiesService } from "../services/companies.service";

export const companiesController = {
  async getCurrent(_req: Request, res: Response) {
    res.json(await companiesService.getCurrent());
  },

  async fiscalYears(_req: Request, res: Response) {
    res.json(await companiesService.fiscalYears());
  },

  async updateCurrent(req: Request, res: Response) {
    const body = UpdateCurrentCompanyBody.safeParse(req.body);
    if (!body.success) throw new BadRequestError(body.error.message);
    res.json(await companiesService.updateCurrent(body.data));
  },

  // ── L1 level-1 branding: the logo ──────────────────────────────────────────

  async uploadLogo(req: Request, res: Response) {
    res.json(await companiesService.uploadLogo(req.tenant!.organizationId, req.file));
  },

  async getLogo(_req: Request, res: Response) {
    const { bytes, contentType } = await companiesService.getLogo();
    // Served INLINE so <img> previews work — but never sniffed, and sandboxed:
    // an SVG navigated to directly runs no script in our origin (the
    // documentHttp attachment rule's inline counterpart, for the one file
    // class that must render).
    res.setHeader("Content-Type", contentType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'");
    res.setHeader("Cache-Control", "private, no-cache");
    res.send(bytes);
  },

  async removeLogo(_req: Request, res: Response) {
    res.json(await companiesService.removeLogo());
  },
};
