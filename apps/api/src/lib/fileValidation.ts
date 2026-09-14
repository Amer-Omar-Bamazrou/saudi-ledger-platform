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

// ── Company logo (L1 level-1 branding) ──────────────────────────────────────

/** 2 MB — a logo, not a scan; big enough for any real mark, small enough to bound abuse. */
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/** Logo types per the owner decision (2026-09-02): PNG / JPG / SVG. */
export const LOGO_ALLOWED_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
};

/**
 * SVG has no magic bytes, so the sniff is structural: optional BOM,
 * whitespace, XML declaration and comments, then an `<svg` root. Active
 * content is refused outright — the logo renders in our own origin (settings
 * preview, PDF renderer), and an image needs none of it. A blocklist here is
 * DEFENSE IN DEPTH, not the boundary: the serving endpoint also sandboxes the
 * response (CSP) and never lets the browser sniff.
 */
function sniffSvg(buf: Buffer): boolean {
  const head = buf.subarray(0, 1024).toString("utf8").replace(/^﻿/, "");
  const stripped = head.replace(/^\s*(<\?xml[\s\S]*?\?>)?\s*(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)*/i, "");
  return /^<svg[\s>]/i.test(stripped);
}

const SVG_ACTIVE_CONTENT = /<script|<foreignObject|javascript:|\son\w+\s*=/i;

/**
 * Validate logo bytes: size cap, PNG/JPG by magic bytes, SVG structurally
 * with active content refused. Returns the trusted mime type; throws 400.
 */
export function validateLogoBytes(buf: Buffer): string {
  if (buf.length === 0) throw new BadRequestError("Uploaded file is empty.");
  if (buf.length > MAX_LOGO_BYTES) {
    throw new BadRequestError(`Logo exceeds the ${Math.floor(MAX_LOGO_BYTES / (1024 * 1024))} MB limit.`);
  }
  const sniffed = sniffMimeType(buf);
  if (sniffed === "image/png" || sniffed === "image/jpeg") return sniffed;
  if (sniffSvg(buf)) {
    if (SVG_ACTIVE_CONTENT.test(buf.toString("utf8"))) {
      throw new BadRequestError("SVG logos must not contain scripts or event handlers.");
    }
    return "image/svg+xml";
  }
  throw new BadRequestError("Unsupported logo type. Allowed: PNG, JPEG, SVG.");
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
