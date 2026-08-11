/**
 * Document capture routes (A1).
 *
 * Tenant-scoped business routes, mounted after `resolveTenant` behind
 * `requirePermission("bills")` — a capture becomes a vendor bill, so it carries
 * the same authority. Reusing the bills resource rather than inventing one
 * keeps the permission matrix answerable: "who may enter a purchase" has one
 * answer, not two.
 */
import { Router } from "express";
import multer from "multer";
import { MAX_DOCUMENT_BYTES } from "../lib/fileValidation";
import { BadRequestError } from "../lib/errors";
import { captureService } from "../services/capture/capture.service";

const router = Router();

/**
 * A capture must belong to a company: the document is evidence for that
 * company's deduction, and `captured_documents.company_id` is NOT NULL.
 * Failing here beats defaulting to a company the user did not mean.
 */
function mustHaveCompany(companyId: string | null): string {
  if (!companyId) {
    throw new BadRequestError(
      "No active company for this tenant. Set one up in Company Settings before capturing documents.",
    );
  }
  return companyId;
}

// Memory storage + the same 10 MB cap M11.4 uses. Phone photographs are the
// expected input and are comfortably inside it.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_DOCUMENT_BYTES } });

/** POST /api/capture — stage a photographed document. */
router.post("/", upload.single("document"), async (req, res) => {
  const file = req.file;
  if (!file) throw new BadRequestError("No document was uploaded.");

  const source = String(req.body?.source ?? "ocr");
  if (!["qr", "ocr", "manual"].includes(source)) {
    throw new BadRequestError("source must be one of: qr, ocr, manual");
  }

  const parseJson = (v: unknown) => {
    if (typeof v !== "string" || !v.trim()) return undefined;
    try {
      return JSON.parse(v);
    } catch {
      return undefined;
    }
  };

  res.status(201).json(
    await captureService.capture(
      {
        bytes: file.buffer,
        fileName: file.originalname,
        source: source as "qr" | "ocr" | "manual",
        qrPayload: typeof req.body?.qrPayload === "string" ? req.body.qrPayload : undefined,
        extraction: parseJson(req.body?.extraction),
        fieldSources: parseJson(req.body?.fieldSources),
      },
      {
        organizationId: req.tenant!.organizationId,
        // The tenant's active company. Never "the org's first company" — the
        // M12.1a bug, twice — and never assumed to be the only one (Q2 = SME
        // first, firms later).
        companyId: mustHaveCompany(req.tenant!.companyId),
        userId: req.session.userId ?? null,
      },
    ),
  );
});

/** GET /api/capture/:id — resume a review. Replaces the sessionStorage handoff. */
router.get("/:id", async (req, res) => {
  res.json(await captureService.get(req.params.id));
});

/** GET /api/capture/:id/image — the photograph a bill was posted from. */
router.get("/:id/image", async (req, res) => {
  const doc = await captureService.image(req.params.id);
  res.setHeader("Content-Type", doc.contentType);
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Inline: the user is looking at their own receipt beside the fields read
  // from it. Unlike M11.4's verification documents this is not an untrusted
  // cross-tenant download — but the sniff guard stays regardless.
  res.setHeader("Content-Disposition", `inline; filename="${doc.fileName}"`);
  res.send(doc.bytes);
});

/** POST /api/capture/:id/discard — abandon a capture; the purge job removes it. */
router.post("/:id/discard", async (req, res) => {
  await captureService.discard(req.params.id);
  res.status(204).end();
});

export default router;
