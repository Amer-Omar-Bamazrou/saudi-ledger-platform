/**
 * Shared HTTP helpers for verification-document endpoints (M11.4).
 *
 * `uploadSingle` runs a multer single-file parse and converts multer's own
 * errors (notably the size limit) into a clean 400 instead of a 500.
 *
 * `sendDocument` streams bytes back as a forced DOWNLOAD — never inline. A
 * user-uploaded document must not be rendered in the browser (an attacker-crafted
 * SVG/HTML/PDF could otherwise run script in our origin), so we set
 * `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`.
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { Multer } from "multer";

export function uploadSingle(upload: Multer, field: string): RequestHandler {
  const mw = upload.single(field);
  return (req: Request, res: Response, next: NextFunction) => {
    mw(req, res, (err: unknown) => {
      if (err) {
        const code = (err as { code?: string }).code;
        const message =
          code === "LIMIT_FILE_SIZE" ? "File exceeds the 10 MB limit." : "File upload failed.";
        res.status(400).json({ error: message });
        return;
      }
      next();
    });
  };
}

export function sendDocument(
  res: Response,
  doc: { bytes: Buffer; fileName: string; mimeType: string },
): void {
  // fileName is already sanitized to [A-Za-z0-9._-]; strip anything stray as belt.
  const safeName = doc.fileName.replace(/["\r\n]/g, "");
  res.setHeader("Content-Type", doc.mimeType);
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(doc.bytes);
}
