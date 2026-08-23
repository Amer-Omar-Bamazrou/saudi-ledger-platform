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
import { uploadSingle } from "./documentHttp";
import { parseJsonField } from "../lib/httpParams";
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

/**
 * POST /api/capture — stage a photographed document.
 *
 * `uploadSingle` (not a bare `upload.single`) so an oversized photo is a 400
 * naming the 10 MB limit, not a raw multer 500 — the mapping the document
 * routes have had since M11.4 (audit 2026-08-20, MED: "green fixed the case,
 * not the class").
 */
router.post("/", uploadSingle(upload, "document"), async (req, res) => {
  const file = req.file;
  if (!file) throw new BadRequestError("No document was uploaded.");

  const source = String(req.body?.source ?? "ocr");
  if (!["qr", "ocr", "manual"].includes(source)) {
    throw new BadRequestError("source must be one of: qr, ocr, manual");
  }

  // 🔴 Malformed JSON REFUSES rather than silently staging without the user's
  // OCR (audit 2026-08-20, MED) — see parseJsonField in lib/httpParams.

  res.status(201).json(
    await captureService.capture(
      {
        bytes: file.buffer,
        fileName: file.originalname,
        source: source as "qr" | "ocr" | "manual",
        qrPayload: typeof req.body?.qrPayload === "string" ? req.body.qrPayload : undefined,
        extraction: parseJsonField(req.body?.extraction, "extraction"),
        // The parse guarantees JSON, not this shape — the service tolerates
        // arbitrary keys/values here exactly as it did with the old parse.
        fieldSources: parseJsonField(req.body?.fieldSources, "fieldSources") as
          | Record<string, string>
          | undefined,
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

/**
 * POST /api/capture/:id/discard — discard a capture and delete its image NOW.
 *
 * Returns `imageDeleted` rather than a bare 204: if the backend could not
 * remove the bytes, the caller is told instead of being handed a success that
 * describes something that did not happen (B3).
 */
router.post("/:id/discard", async (req, res) => {
  res.json(await captureService.discard(req.params.id));
});

export default router;
