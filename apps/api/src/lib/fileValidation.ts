/**
 * File validation for uploaded verification documents (M11.4).
 *
 * Defense in depth for user-supplied files: an allow-list of types, a size cap,
 * and — critically — a MAGIC-BYTE sniff so we trust the actual bytes, not the
 * client-declared mime or the extension (both trivially spoofed). Plus filename
 * sanitization so a crafted name can't traverse paths or inject control chars.
 *
 * (Antivirus scanning is intentionally out of scope for M11.4 — see CLAUDE.md;
 * mitigations here + private bucket + attachment-only download bound the risk.)
 */
import { BadRequestError } from "./errors";

/** 10 MB — generous for a scanned certificate, small enough to bound abuse. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/** The only content types we accept, mapped to their canonical extension. */
export const ALLOWED_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};

/** Sniff the true content type from leading bytes; null if unrecognized. */
export function sniffMimeType(buf: Buffer): string | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return "image/png";
  }
  return null;
}

/**
 * Validate a buffer's true type + size. Returns the sniffed (trusted) mime type.
 * Throws BadRequestError (400) on any violation.
 */
export function validateDocumentBytes(buf: Buffer): string {
  if (buf.length === 0) throw new BadRequestError("Uploaded file is empty.");
  if (buf.length > MAX_DOCUMENT_BYTES) {
    throw new BadRequestError(`File exceeds the ${Math.floor(MAX_DOCUMENT_BYTES / (1024 * 1024))} MB limit.`);
  }
  const sniffed = sniffMimeType(buf);
  if (!sniffed || !(sniffed in ALLOWED_MIME)) {
    throw new BadRequestError("Unsupported file type. Allowed: PDF, JPEG, PNG.");
  }
  return sniffed;
}

/**
 * Sanitize a client filename to a safe basename: strip any directory component,
 * collapse to a conservative charset, bound the length, and guarantee an
 * extension matching the (sniffed) content type.
 */
export function sanitizeFilename(rawName: string, sniffedMime: string): string {
  const base = String(rawName ?? "").replace(/^.*[\\/]/, ""); // drop path components
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]/g, "_") // conservative allow-list
    .replace(/_{2,}/g, "_")
    .replace(/^[._]+/, "") // no leading dot/underscore (hidden/relative)
    .slice(0, 120);
  const ext = ALLOWED_MIME[sniffedMime];
  const stem = cleaned.replace(/\.[^.]*$/, "") || "document";
  return `${stem}.${ext}`;
}
