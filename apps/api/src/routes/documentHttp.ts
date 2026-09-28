/**
 * Shared HTTP helpers for verification-document endpoints (M11.4).
 *
 * `uploadSingle` runs a multer single-file parse and converts multer's own
 * errors (notably the size limit) into a clean 400 instead of a 500.
 *
 * 🔴 It is also the ONE place a multipart parse may happen after
 * `resolveTenant`, because it re-enters the request's async context (DEF-1,
 * 2026-09-28). multer finishes from a stream event: a body already buffered
 * finishes inside the request's context, but a body whose later chunks arrive
 * from the socket (any real photo or PDF) finishes in the SOCKET's context —
 * so every handler after it ran with no tenant transaction and no audit
 * context, and the fail-closed `db` refused (500 "db.insert() was called
 * outside a tenant transaction"). The continuation is bound to the context the
 * middleware was ENTERED in: the request's own, never a wider one. Guard:
 * `tests/upload-tenant-context.test.ts`.
 *
 * `sendDocument` streams bytes back as a forced DOWNLOAD — never inline. A
 * user-uploaded document must not be rendered in the browser (an attacker-crafted
 * SVG/HTML/PDF could otherwise run script in our origin), so we set
 * `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`.
 */
import { AsyncResource } from "node:async_hooks";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { Multer } from "multer";

export function uploadSingle(upload: Multer, field: string): RequestHandler {
  const mw = upload.single(field);
  return (req: Request, res: Response, next: NextFunction) => {
    // Bound HERE, while the request's tenant + audit context is current.
    const done = AsyncResource.bind((err: unknown) => {
      if (err) {
        const code = (err as { code?: string }).code;
        const message =
          code === "LIMIT_FILE_SIZE" ? "File exceeds the 10 MB limit." : "File upload failed.";
        res.status(400).json({ error: message });
        return;
      }
      next();
    });
    mw(req, res, done);
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
