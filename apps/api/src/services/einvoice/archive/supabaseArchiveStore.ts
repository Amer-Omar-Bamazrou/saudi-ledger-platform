/**
 * Supabase Storage archive backend (M12.8).
 *
 * The first cloud implementation of {@link ArchiveStore} — NOT a commitment to
 * Supabase or to any region. It exists so the archive works today against the
 * stack the platform already runs; the hosting decision is deliberately still
 * open (see `archiveStore.ts`).
 *
 * Reuses the M11.4 REST plumbing (`bucketConfig` / `authHeader` / `objectUrl`)
 * against a SECOND bucket rather than copying it.
 */
import { createHash } from "node:crypto";
import { authHeader, bucketConfig, encodeObjectPath, objectUrl } from "../../../lib/storage";
import {
  ArchiveConflictError,
  ArchiveUnavailableError,
  type ArchiveLink,
  type ArchivePutResult,
  type ArchiveStore,
} from "./archiveStore";

export class SupabaseArchiveStore implements ArchiveStore {
  readonly provider = "supabase-storage";

  constructor(private readonly bucket: string) {}

  private cfg() {
    return bucketConfig(this.bucket);
  }

  /** Idempotently ensure the archive bucket exists and is PRIVATE. */
  async ensureBucket(): Promise<void> {
    const c = this.cfg();
    const res = await fetch(`${c.baseUrl}/storage/v1/bucket`, {
      method: "POST",
      headers: { ...authHeader(c), "content-type": "application/json" },
      body: JSON.stringify({ id: c.bucket, name: c.bucket, public: false }),
    });
    if (!res.ok && res.status !== 409 && res.status !== 400) {
      throw new ArchiveUnavailableError(`bucket provisioning failed (${res.status})`);
    }
  }

  async put(objectPath: string, bytes: Buffer, contentType: string): Promise<ArchivePutResult> {
    const c = this.cfg();
    await this.ensureBucket();

    const res = await fetch(objectUrl(c, objectPath), {
      method: "POST",
      headers: { ...authHeader(c), "content-type": contentType, "x-upsert": "false" },
      body: new Uint8Array(bytes),
    });

    // 🔴 `x-upsert: false` is what makes the archive append-only at this layer.
    // Storage answers 409 for an existing object; surfacing that as a conflict
    // rather than swallowing it means a double-archive is loud, and a
    // legally-retained artifact can never be silently replaced.
    if (res.status === 409) throw new ArchiveConflictError(objectPath);
    if (!res.ok) throw new ArchiveUnavailableError(`upload failed (${res.status})`);

    return {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteSize: bytes.byteLength,
    };
  }

  async get(objectPath: string): Promise<{ bytes: Buffer; contentType: string }> {
    const c = this.cfg();
    const res = await fetch(objectUrl(c, objectPath), { headers: authHeader(c) });
    if (!res.ok) throw new ArchiveUnavailableError(`download failed (${res.status})`);
    return {
      bytes: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") ?? "application/xml",
    };
  }

  async exists(objectPath: string): Promise<boolean> {
    const c = this.cfg();
    const res = await fetch(objectUrl(c, objectPath), { method: "HEAD", headers: authHeader(c) });
    return res.ok;
  }

  /**
   * A Supabase signed URL — ZATCA §5.5's "direct link that can be made
   * available to the Authority", time-limited so the archive is never publicly
   * readable.
   */
  async directLink(objectPath: string, ttlSeconds: number): Promise<ArchiveLink> {
    const c = this.cfg();
    const res = await fetch(
      `${c.baseUrl}/storage/v1/object/sign/${c.bucket}/${encodeObjectPath(objectPath)}`,
      {
        method: "POST",
        headers: { ...authHeader(c), "content-type": "application/json" },
        body: JSON.stringify({ expiresIn: ttlSeconds }),
      },
    );
    if (!res.ok) throw new ArchiveUnavailableError(`signing a link failed (${res.status})`);

    const body = (await res.json()) as { signedURL?: string; signedUrl?: string };
    const signed = body.signedURL ?? body.signedUrl;
    if (!signed) throw new ArchiveUnavailableError("storage returned no signed URL");

    return {
      url: `${c.baseUrl}/storage/v1${signed.startsWith("/") ? "" : "/"}${signed}`,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    };
  }
}
